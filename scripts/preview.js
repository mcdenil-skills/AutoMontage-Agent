#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { remotionRenderCommand } = require('./build-commands');
const {
  ROOT,
  configureMediaToolPath,
  resolveRemotionCommand,
} = require('./env');
const { REMOTION_AUDIO_ADVANCE_MS } = require('./finish-audio');
const { loadExtTheme } = require('./load-ext-theme');
const { validateStoredBrief } = require('./project/brief-contract');
const { prepareMotionPreview } = require('./motion/workflow');
const { prepareLessonPreview } = require('./lesson/preview');
const { probeVideo } = require('./media-probe');
const { runNodeTool, runTool } = require('./process');
const {
  planPreview,
  publishCurrentPreview,
} = require('./project/preview-workspace');
const {
  readProjectManifest,
  resolveProjectPath,
} = require('./project/workspace');
const { withPreviewMediaBundle } = require('./render-media-bundle');

function parsePreviewOptions(argv) {
  const options = {
    projectDir: null,
    briefPath: null,
    fromSec: undefined,
    toSec: undefined,
    open: true,
  };
  const valueOptions = new Map([
    ['--project-dir', 'projectDir'],
    ['--brief', 'briefPath'],
    ['--from-sec', 'fromSec'],
    ['--to-sec', 'toSec'],
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--no-open') {
      if (seen.has(argument)) throw new Error('duplicate preview option');
      seen.add(argument);
      options.open = false;
      continue;
    }
    const key = valueOptions.get(argument);
    if (!key || seen.has(argument)) throw new Error('unknown or duplicate preview option');
    seen.add(argument);
    const value = argv[index + 1];
    if (typeof value !== 'string' || !value || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`);
    }
    index += 1;
    options[key] = key === 'fromSec' || key === 'toSec' ? Number(value) : value;
  }
  if (!options.projectDir || !options.briefPath) {
    throw new Error('preview requires --project-dir and --brief');
  }
  options.projectDir = path.resolve(options.projectDir);
  if ((options.fromSec === undefined) !== (options.toSec === undefined)) {
    throw new Error('preview range requires both --from-sec and --to-sec');
  }
  return options;
}

function openMediaFile(filename, { spawnSyncImpl = spawnSync } = {}) {
  let command;
  let args;
  if (process.platform === 'darwin') {
    command = 'open';
    args = [filename];
  } else if (process.platform === 'win32') {
    command = 'rundll32.exe';
    args = ['url.dll,FileProtocolHandler', filename];
  } else {
    command = 'xdg-open';
    args = [filename];
  }
  const result = spawnSyncImpl(command, args, { shell: false, stdio: 'ignore' });
  if (result.error || result.status !== 0) {
    throw new Error('preview is ready but the system browser could not be opened');
  }
}

function resolveBriefPath(workspace, requested) {
  let stored = requested;
  if (path.isAbsolute(requested)) {
    const relative = path.relative(workspace.dir, requested);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) {
      throw new Error('preview brief must stay inside the project workspace');
    }
    stored = relative.split(path.sep).join('/');
  }
  const resolved = resolveProjectPath(workspace.dir, stored, {
    label: 'preview brief path', mustExist: true, type: 'file',
  });
  const relative = path.relative(workspace.dir, resolved).split(path.sep).join('/');
  if (workspace.manifest.currentBrief !== relative) {
    throw new Error('preview requires the current persisted draft brief');
  }
  return resolved;
}

function cleanupPreviewStages(paths, fileSystem) {
  for (const target of paths) {
    try {
      const stat = fileSystem.lstatSync(target);
      if (!stat.isSymbolicLink() && stat.isFile()) fileSystem.unlinkSync(target);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
}

function runPreview(options, dependencies = {}) {
  const fileSystem = dependencies.fileSystem || fs;
  const readProjectManifestImpl = dependencies.readProjectManifestImpl || readProjectManifest;
  const prepareLessonPreviewImpl = dependencies.prepareLessonPreviewImpl || prepareLessonPreview;
  const withPreviewMediaBundleImpl = dependencies.withPreviewMediaBundleImpl
    || withPreviewMediaBundle;
  const resolveRemotionCommandImpl = dependencies.resolveRemotionCommandImpl
    || resolveRemotionCommand;
  const runToolImpl = dependencies.runToolImpl || runTool;
  const runNodeToolImpl = dependencies.runNodeToolImpl || runNodeTool;
  const probeVideoImpl = dependencies.probeVideoImpl || probeVideo;
  const publishCurrentPreviewImpl = dependencies.publishCurrentPreviewImpl
    || publishCurrentPreview;
  const openMediaFileImpl = dependencies.openMediaFileImpl || openMediaFile;
  const now = dependencies.now || (() => new Date());
  const temporaryId = dependencies.temporaryId || randomUUID;

  const projectDir = path.resolve(options.projectDir);
  const manifest = readProjectManifestImpl(projectDir);
  const manifestHash = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  if (process.env.AUTOMONTAGE_PREVIEW_MANIFEST_HASH && process.env.AUTOMONTAGE_PREVIEW_MANIFEST_HASH !== manifestHash) throw new Error('preview base changed');
  const workspace = { dir: projectDir, manifest };
  const briefPath = resolveBriefPath(workspace, options.briefPath);
  const briefBytes = fileSystem.readFileSync(briefPath);
  const brief = JSON.parse(briefBytes.toString('utf8'));
  const briefSha256 = createHash('sha256').update(briefBytes).digest('hex');
  const sourceVideo = resolveProjectPath(projectDir, manifest.source.localPath, {
    label: 'manifest.source.localPath', fileSystem, mustExist: true, type: 'file',
  });
  if (process.env.AUTOMONTAGE_PREVIEW_BRIEF_HASH && process.env.AUTOMONTAGE_PREVIEW_BRIEF_HASH !== createHash('sha256').update(JSON.stringify(brief)).digest('hex')) throw new Error('preview base changed');
  const sourceSha256 = require('./project/preview-workspace').hashFile(fileSystem, sourceVideo);
  const kind = validateStoredBrief({ manifest, briefPath: manifest.currentBrief, brief });
  workspace.sourcePath = sourceVideo;
  if (kind === 'motion-reel') {
    const audio = require('./motion/source').probeAudioPath(sourceVideo, {
      ...(dependencies.probeOpenedAudioImpl ? { probeOpenedAudioImpl: dependencies.probeOpenedAudioImpl } : {}),
    });
    if (Math.abs(brief.output.durationInFrames / brief.output.fps - audio.durationSec) > 1 / brief.output.fps + 0.001) {
      throw new Error('motion narration duration does not match the draft output');
    }
  }
  const externalTheme = kind === 'motion-reel' ? null : loadExtTheme(brief.theme);
  const prepareOptions = { brief, theme: externalTheme || brief.theme, sourceVideo };
  if (options.fromSec !== undefined || options.toSec !== undefined) {
    prepareOptions.fromSec = options.fromSec;
    prepareOptions.toSec = options.toSec;
  }
  const prepared = kind === 'motion-reel'
    ? prepareMotionPreview({ workspace, ...prepareOptions })
    : prepareLessonPreviewImpl(prepareOptions);
  const planned = planPreview(workspace, {
    briefPath,
    briefSha256,
    sourceSha256,
    manifestHash,
    range: prepared.range,
    temporaryId,
    fileSystem,
  });
  const stages = [planned.propsPath, planned.rawPath, planned.finishedPath, planned.mixedPath];
  let stagedOutput = planned.finishedPath;
  try {
    withPreviewMediaBundleImpl({
      root: ROOT,
      workspace,
      props: prepared.props,
      previewBrief: prepared.previewMedia.brief,
      sourcePath: prepared.previewMedia.sourcePath,
      sourceAlias: prepared.previewMedia.sourceAlias,
      namespace: `${manifest.slug}-preview`,
      temporaryId: temporaryId(),
      fileSystem,
    }, (lease) => {
      fileSystem.writeFileSync(planned.propsPath, `${JSON.stringify(lease.props, null, 2)}\n`);
      const command = remotionRenderCommand(resolveRemotionCommandImpl(ROOT), {
        entry: 'src/index.js',
        composition: prepared.composition,
        output: planned.rawPath,
        props: planned.propsPath,
        publicDir: lease.publicDirectory,
        scale: 0.5,
        crf: 28,
        frameRange: prepared.range.kind === 'excerpt' ? prepared.range : null,
        concurrency: '50%',
        overwrite: true,
      });
      runToolImpl(command.command, command.args, { cwd: ROOT, stage: 'preview Remotion' });
      runNodeToolImpl(path.join(ROOT, 'scripts', 'finish.js'), [
        planned.rawPath,
        planned.finishedPath,
        '--hdrfix', 'auto',
        '--audio-advance-ms', String(REMOTION_AUDIO_ADVANCE_MS),
      ], { cwd: ROOT, stage: 'preview finish' });
      if (prepared.music) {
        runNodeToolImpl(path.join(ROOT, 'scripts', 'mix-music.js'), [
          planned.finishedPath,
          lease.musicPath || prepared.music.sourcePath,
          planned.mixedPath,
          ...prepared.music.mixArgs,
        ], { cwd: ROOT, stage: 'preview music mix' });
        stagedOutput = planned.mixedPath;
      }
    });

    runToolImpl('ffmpeg', [
      '-v', 'error', '-i', stagedOutput, '-f', 'null', '-',
    ], { cwd: ROOT, stage: 'preview decode' });
    const probe = probeVideoImpl(stagedOutput, { cwd: ROOT, stage: 'preview ffprobe' });
    const expectedWidth = Math.round(prepared.props.width * 0.5);
    const expectedHeight = Math.round(prepared.props.height * 0.5);
    const expectedDuration = prepared.range.toSec - prepared.range.fromSec;
    if (probe.width !== expectedWidth || probe.height !== expectedHeight
      || Math.abs(probe.fps - prepared.props.fps) > 1e-6
      || Math.abs(probe.duration - expectedDuration) > Math.max(0.08, 1 / prepared.props.fps)) {
      throw new Error('preview output metadata does not match the requested composition range');
    }
    const generatedAt = now().toISOString();
    const published = publishCurrentPreviewImpl(workspace, planned, stagedOutput, {
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      generatedAt,
    }, { fileSystem, temporaryId });
    if (options.open !== false) openMediaFileImpl(published.currentPath);
    return published;
  } finally {
    cleanupPreviewStages(stages, fileSystem);
  }
}

function main(argv = process.argv.slice(2)) {
  try {
    configureMediaToolPath();
    const result = runPreview(parsePreviewOptions(argv));
    const label = result.metadata.kind === 'full'
      ? 'ПОЛНЫЙ РОЛИК'
      : `ФРАГМЕНТ ${result.metadata.fromSec.toFixed(2)}–${result.metadata.toSec.toFixed(2)} сек`;
    console.log(`✅ СМОНТИРОВАННЫЙ ПРЕДПРОСМОТР: ${result.currentPath}`);
    console.log(`   ${label}`);
  } catch (error) {
    console.error(`❌ preview отменён: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  main,
  openMediaFile,
  parsePreviewOptions,
  runPreview,
};
