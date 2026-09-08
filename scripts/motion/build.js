#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { ROOT, configureMediaToolPath, resolveRemotionCommand } = require('../env');
const { remotionRenderCommand } = require('../build-commands');
const { REMOTION_AUDIO_ADVANCE_MS } = require('../finish-audio');
const { runTool, runNodeTool } = require('../process');
const { probeVideo } = require('../media-probe');
const { withRenderMediaBundle } = require('../render-media-bundle');
const { createMotionProject, transcribeMotionNarration, validateCanonicalTranscript, probeAudioPath } = require('./source');
const { prepareMotionRender } = require('./workflow');
const { validateStoredBrief } = require('../project/brief-contract');
const { readProjectManifest, resolveProjectPath, publishBriefRevision, nextRenderPaths, runRenderLifecycle } = require('../project/workspace');
const { verifyApprovalPreview } = require('../project/preview-workspace');

function parseMotionOptions(argv) {
  const options = {};
  const flags = new Map([['--project', 'project'], ['--project-dir', 'projectDir'], ['--brief', 'briefPath'],
    ['--version-label', 'versionLabel'], ['--model', 'model']]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('-') && index === 0) { options.narrationPath = arg; continue; }
    const key = flags.get(arg);
    if (!key || seen.has(arg)) throw new Error(`unknown or duplicate motion option: ${arg}`);
    seen.add(arg);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    options[key] = value;
  }
  if (options.briefPath) {
    if (!options.projectDir || options.narrationPath || options.project || options.model) {
      throw new Error('motion final requires --project-dir and --brief, using the manifest narration');
    }
  } else if ((!options.narrationPath || !options.project) && !options.projectDir) {
    throw new Error('motion requires <audio> --project <name> or --project-dir');
  }
  if (options.versionLabel && !options.briefPath) throw new Error('--version-label requires an approved brief');
  return options;
}

// Keep approved JSON pinned while ffmpeg/Remotion work; fail if names or bytes change.
function openBriefSnapshot(projectDir, relative) {
  const filename = resolveProjectPath(projectDir, relative, { mustExist: true, type: 'file' });
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const identity = fs.fstatSync(fd, { bigint: true });
  const bytes = fs.readFileSync(fd);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const close = () => fs.closeSync(fd);
  const assertCurrent = () => {
    resolveProjectPath(projectDir, relative, { mustExist: true, type: 'file' });
    for (const current of [fs.lstatSync(filename, { bigint: true }), fs.fstatSync(fd, { bigint: true })]) {
      if (!current.isFile() || current.isSymbolicLink()
        || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].some(key => current[key] !== identity[key])) {
        throw new Error('motion approval brief identity changed');
      }
    }
    const hash = createHash('sha256'); const buffer = Buffer.alloc(65536); let offset = 0; let size;
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, offset)) > 0) { hash.update(buffer.subarray(0, size)); offset += size; }
    if (hash.digest('hex') !== digest) throw new Error('motion approval brief bytes changed');
  };
  try { assertCurrent(); return { bytes, assertCurrent, close }; } catch (error) { close(); throw error; }
}

function verifyMotionApproval(workspace, entry, approved) {
  const draftEntry = workspace.manifest.briefs.find(item => item.kind === 'motion-reel'
    && item.revision === entry.revision && item.status === 'draft');
  if (!draftEntry || !approved.approval) throw new Error('motion approval receipt or registered draft is missing');
  const draft = openBriefSnapshot(workspace.dir, draftEntry.jsonPath);
  let preview;
  try {
    const brief = JSON.parse(draft.bytes);
    const { approval, ...content } = approved;
    if (!isDeepStrictEqual(content, { ...brief, status: 'approved' })) throw new Error('motion approval content changed');
    if (createHash('sha256').update(draft.bytes).digest('hex') !== approval.draftSha256
      || workspace.manifest.currentPreview?.sourceSha256 !== approval.sourceSha256) throw new Error('motion approval hashes changed');
    preview = verifyApprovalPreview({ ...workspace, manifest: { ...workspace.manifest, currentBrief: draftEntry.jsonPath } }, brief, draft.bytes, {
      confirmPreviewViewed: true, expectedPreviewSha256: approval.previewSha256,
    });
    return { assertCurrent() { draft.assertCurrent(); preview.assertCurrent(); }, close() { draft.close(); preview.close(); } };
  } catch (error) { draft.close(); preview?.close(); throw error; }
}

function runMotion(options, dependencies = {}) {
  const root = dependencies.root || ROOT;
  const runToolImpl = dependencies.runToolImpl || runTool;
  const runNodeToolImpl = dependencies.runNodeToolImpl || runNodeTool;
  const probeOptions = dependencies.probeOpenedAudioImpl ? { probeOpenedAudioImpl: dependencies.probeOpenedAudioImpl } : {};
  if (!options.briefPath) {
    const { workspace, probe } = createMotionProject({ baseDir: process.cwd(), name: options.project,
      projectDir: options.projectDir, narrationPath: options.narrationPath, ...probeOptions });
    if (workspace.manifest.currentBrief) throw new Error('project already has a brief; continue with preview or an approved --brief');
    const wordsPath = resolveProjectPath(workspace.dir, workspace.manifest.transcript.words, { mustExist: false, type: 'file' });
    const transcript = fs.existsSync(wordsPath)
      ? validateCanonicalTranscript(JSON.parse(fs.readFileSync(wordsPath, 'utf8')))
      : (dependencies.transcribeMotionNarrationImpl || transcribeMotionNarration)({ root, workspace, model: options.model }).transcript;
    const text = transcript.map(segment => segment.text.trim()).filter(Boolean).join(' ').slice(0, 120);
    if (!text) throw new Error('narration transcript is empty; a motion draft requires speech text');
    const durationInFrames = Math.max(1, Math.ceil(probe.durationSec * 30));
    const brief = { version: 1, kind: 'motion-reel', status: 'draft', source: workspace.manifest.source.localPath,
      theme: 'motion-neutral', title: workspace.manifest.name.slice(0, 120),
      output: { aspect: 'vertical', width: 1080, height: 1920, fps: 30, durationInFrames },
      scenes: [{ scene: 'kinetic-title', start: 0, end: durationInFrames / 30, text }],
    };
    const published = publishBriefRevision(workspace, { kind: 'motion-reel', brief });
    return { action: 'draft', projectDir: workspace.dir, ...published };
  }
  if (!options.projectDir || options.narrationPath) throw new Error('motion final uses the manifest narration and requires --project-dir');
  const projectDir = path.resolve(options.projectDir);
  const manifest = readProjectManifest(projectDir);
  const requested = path.isAbsolute(options.briefPath)
    ? path.relative(projectDir, options.briefPath).split(path.sep).join('/') : options.briefPath;
  if (requested !== manifest.currentBrief) throw new Error('motion final requires the current registered approved brief');
  const entry = manifest.briefs.find(item => item.jsonPath === requested);
  if (!entry || entry.kind !== 'motion-reel' || entry.status !== 'approved') throw new Error('motion final requires a registered approved motion brief');
  const snapshot = openBriefSnapshot(projectDir, requested);
  let approval;
  try {
    if (createHash('sha256').update(snapshot.bytes).digest('hex') !== entry.sha256) {
      throw new Error('motion approved copy hash changed or immutable approval is missing');
    }
    const brief = JSON.parse(snapshot.bytes);
    validateStoredBrief({ manifest, briefPath: requested, brief });
    const sourcePath = resolveProjectPath(projectDir, manifest.source.localPath, { mustExist: true, type: 'file' });
    const workspace = { dir: projectDir, manifest, sourcePath };
    approval = verifyMotionApproval(workspace, entry, brief);
    const audio = probeAudioPath(sourcePath, probeOptions);
    if (Math.abs(brief.output.durationInFrames / brief.output.fps - audio.durationSec) > 1 / brief.output.fps + 0.001) {
      throw new Error('motion narration duration does not match the approved brief');
    }
    const prepared = prepareMotionRender({ workspace, brief });
    const render = nextRenderPaths(workspace, options.versionLabel || 'motion');
    render.briefPath = path.join(projectDir, requested);
    const finalPath = runRenderLifecycle(workspace, render, () => {
      const bundle = dependencies.withRenderMediaBundleImpl || withRenderMediaBundle;
      bundle({ root, workspace, props: prepared.props, approvedBrief: brief,
        sourcePath, sourceAlias: prepared.sourceAlias, namespace: `${manifest.slug}-motion`,
      }, lease => {
        snapshot.assertCurrent(); approval.assertCurrent();
        fs.writeFileSync(render.propsPath, `${JSON.stringify(lease.props, null, 2)}\n`, { flag: 'wx' });
        const command = remotionRenderCommand((dependencies.resolveRemotionCommandImpl || resolveRemotionCommand)(root), {
          entry: 'src/index.js', composition: prepared.composition, output: render.rawPath, props: render.propsPath,
          publicDir: lease.publicDirectory, concurrency: '50%',
        });
        runToolImpl(command.command, command.args, { cwd: root, stage: 'motion Remotion' });
        const finishedPath = prepared.music ? path.join(render.dir, 'finished.mp4') : render.finalPath;
        runNodeToolImpl(path.join(root, 'scripts/finish.js'), [render.rawPath, finishedPath, '--hdrfix', 'auto', '--audio-advance-ms', String(REMOTION_AUDIO_ADVANCE_MS)], { cwd: root, stage: 'motion finish' });
        if (prepared.music) runNodeToolImpl(path.join(root, 'scripts/mix-music.js'), [finishedPath, lease.musicPath, render.finalPath, ...prepared.music.mixArgs], { cwd: root, stage: 'motion music mix' });
      });
      runToolImpl('ffmpeg', ['-v', 'error', '-i', render.finalPath, '-f', 'null', '-'], { cwd: root, stage: 'motion QA decode' });
      const probe = (dependencies.probeVideoImpl || probeVideo)(render.finalPath, { stage: 'motion QA probe' });
      if (probe.width !== brief.output.width || probe.height !== brief.output.height || Math.abs(probe.fps - brief.output.fps) > 1e-6
        || Math.abs(probe.duration - brief.output.durationInFrames / brief.output.fps) > Math.max(0.08, 1 / brief.output.fps)) {
        throw new Error('motion QA metadata does not match the approved output');
      }
      snapshot.assertCurrent(); approval.assertCurrent();
      return render.finalPath;
    });
    return { action: 'render', projectDir, finalPath, renderDir: render.dir };
  } finally { snapshot.close(); approval?.close(); }
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    console.log('automontage motion <audio> --project <name> [--model <Whisper model>]\nautomontage motion --project-dir <dir> --brief <approved.json> [--version-label <label>]\nLocal narration → transcript/scaffold → preview → explicit approval → final.');
    return;
  }
  try {
    configureMediaToolPath();
    const result = runMotion(parseMotionOptions(argv));
    console.log(result.action === 'draft' ? `Motion draft scaffold: ${result.jsonPath}\nReview the transcript and author the scene plan before preview.` : `Motion final: ${result.finalPath}`);
  } catch (error) { console.error(`Motion cancelled: ${error.message}`); process.exitCode = 1; }
}
if (require.main === module) main();
module.exports = { parseMotionOptions, runMotion, main };
