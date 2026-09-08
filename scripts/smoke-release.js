#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { configureMediaToolPath } = require('./env');
const { createHash, randomUUID } = require('node:crypto');

const { captureTool, runNodeTool, runTool } = require('./process');
const {
  createOrOpenProject,
  readProjectManifest,
  resolveProjectPath,
} = require('./project/workspace');

const ROOT = path.resolve(__dirname, '..');
const PROTECTED_FILES = ['src/data/captions.js', 'src/data/transcript.json'];
const MAX_DRIFT_SECONDS = 0.08;

function hashFile(file) {
  if (!fs.existsSync(file)) return null;
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function snapshotFiles(root, files) {
  return new Map(files.map((file) => [file, hashFile(path.join(root, file))]));
}

function assertProtectedFilesUnchanged(root, before) {
  for (const [file, expected] of before) {
    const actual = hashFile(path.join(root, file));
    if (actual !== expected) throw new Error(`protected file changed: ${file}`);
  }
}

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} is not finite`);
  return number;
}

function probeMedia(file, env = createSmokeEnvironment()) {
  const source = captureTool('ffprobe', [
    '-v', 'error',
    '-count_frames',
    '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,start_time,duration,nb_read_frames:format=duration',
    '-of', 'json',
    path.resolve(file),
  ], { cwd: ROOT, env, stage: `probe ${path.basename(file)}`, maxBuffer: 4 * 1024 * 1024 });
  let probe;
  try {
    probe = JSON.parse(source);
  } catch (error) {
    throw new Error(`ffprobe returned invalid JSON for ${file}: ${error.message}`);
  }
  const video = (probe.streams || []).find((stream) => stream.codec_type === 'video');
  const audio = (probe.streams || []).find((stream) => stream.codec_type === 'audio');
  if (!video || !audio) throw new Error(`${file} must contain video and audio streams`);
  const formatDuration = finite(probe.format && probe.format.duration, `${file} format duration`);
  const timing = (stream, label) => ({
    start: finite(stream.start_time ?? 0, `${file} ${label} start`),
    duration: finite(stream.duration ?? formatDuration, `${file} ${label} duration`),
  });
  const videoTiming = timing(video, 'video');
  const audioTiming = timing(audio, 'audio');
  const startDrift = Math.abs(videoTiming.start - audioTiming.start);
  const durationDrift = Math.abs(videoTiming.duration - audioTiming.duration);
  if (startDrift >= MAX_DRIFT_SECONDS || durationDrift >= MAX_DRIFT_SECONDS) {
    throw new Error(
      `${file} A/V drift is too large (start=${startDrift.toFixed(3)}s, duration=${durationDrift.toFixed(3)}s)`,
    );
  }
  return {
    width: video.width,
    height: video.height,
    fps: video.r_frame_rate?.split('/').map(Number).reduce((a, b) => a / b),
    videoCodec: video.codec_name,
    audioCodec: audio.codec_name,
    videoTracks: probe.streams.filter(stream => stream.codec_type === 'video').length,
    audioTracks: probe.streams.filter(stream => stream.codec_type === 'audio').length,
    duration: formatDuration,
    frames: finite(video.nb_read_frames, `${file} video frame count`),
    startDrift,
    durationDrift,
  };
}

function decodeMedia(file, env = createSmokeEnvironment()) {
  runTool('ffmpeg', [
    '-v', 'error',
    '-i', path.resolve(file),
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-f', 'null',
    '-',
  ], { cwd: ROOT, env, stage: `decode ${path.basename(file)}` });
}

function assertMedia(file, expectedFrames, expected = null, env = createSmokeEnvironment()) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`smoke final does not exist: ${file}`);
  }
  const probe = probeMedia(file, env);
  if (probe.frames !== expectedFrames) {
    throw new Error(`${file} has ${probe.frames} frames instead of ${expectedFrames}`);
  }
  if (expected) {
    if (probe.width !== expected.width || probe.height !== expected.height || probe.fps !== expected.fps) {
      throw new Error(`${file} has wrong geometry or FPS`);
    }
    if (probe.videoCodec !== expected.videoCodec || probe.audioCodec !== expected.audioCodec) throw new Error(`${file} has wrong codec`);
    if (probe.videoTracks !== 1 || probe.audioTracks !== expected.audioTracks) throw new Error(`${file} has unexpected video/audio track count`);
    if (Math.abs(probe.duration - expectedFrames / expected.fps) >= MAX_DRIFT_SECONDS) throw new Error(`${file} has wrong duration`);
  }
  decodeMedia(file, env);
  return probe;
}

function assertProjectFinal(projectDir) {
  const manifest = readProjectManifest(projectDir);
  if (!manifest.final || !manifest.latestRender || !Array.isArray(manifest.renders)) {
    throw new Error('project manifest lacks final, latestRender, or renders[]');
  }
  const selectedIndex = manifest.renders.findIndex((render) => render.dir === manifest.latestRender);
  const selected = manifest.renders[selectedIndex];
  if (!selected || selected.status !== 'complete') {
    throw new Error('latestRender does not select a complete renders[] entry');
  }
  const finalPath = resolveProjectPath(projectDir, manifest.final, {
    label: 'manifest.final',
    mustExist: true,
    type: 'file',
  });
  resolveProjectPath(projectDir, selected.dir, {
    label: `manifest.renders[${selectedIndex}].dir`,
    mustExist: true,
    type: 'directory',
  });
  const renderFinalPath = resolveProjectPath(projectDir, path.posix.join(selected.dir, 'final.mp4'), {
    label: `manifest.renders[${selectedIndex}].dir/final.mp4`,
    mustExist: true,
    type: 'file',
  });
  if (!fs.existsSync(finalPath) || !fs.existsSync(renderFinalPath)) {
    throw new Error('project final or selected render final is missing');
  }
  if (hashFile(finalPath) !== hashFile(renderFinalPath)) {
    throw new Error('project final SHA-256 differs from the selected render final');
  }
  return finalPath;
}

function preservePublicSource(root) {
  const publicSource = path.join(root, 'public', 'source.mp4');
  const backupDir = path.join(root, 'tmp', 'release-smoke-backups');
  const backup = path.join(backupDir, `source-${randomUUID()}.mp4`);
  const existed = fs.existsSync(publicSource);
  if (existed) {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(publicSource, backup, fs.constants.COPYFILE_EXCL);
  }
  return () => {
    if (existed) {
      fs.copyFileSync(backup, publicSource);
      fs.unlinkSync(backup);
    } else if (fs.existsSync(publicSource)) {
      fs.unlinkSync(publicSource);
    }
  };
}

function createSmokeEnvironment(env = process.env) {
  const allowed = new Set(['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT',
    'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'AUTOMONTAGE_FFMPEG_DIR']);
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key.toUpperCase())));
}

function assertMotionCliHelp(root = ROOT, env = createSmokeEnvironment()) {
  const help = captureTool(process.execPath, [path.join(root, 'scripts/cli.js'), '--help'], {
    cwd: root, env, stage: 'motion CLI help', maxBuffer: 1024 * 1024,
  });
  if (!/automontage motion/.test(help) || !/automontage demo --motion/.test(help)) {
    throw new Error('motion CLI help must expose motion and the offline demo');
  }
  const motionHelp = captureTool(process.execPath, [path.join(root, 'scripts/cli.js'), 'motion', '--help'], {
    cwd: root, env, stage: 'motion command help', maxBuffer: 1024 * 1024,
  });
  if (!motionHelp.includes('--accept-provider-cost') || !motionHelp.includes('--brief')) throw new Error('motion command help is incomplete');
}

function runMotionReleaseSmoke({ root = ROOT, workDir = path.join(root, 'out/release-smoke', `motion-${randomUUID()}`) } = {}) {
  const resolvedRoot = path.resolve(root);
  const working = path.resolve(workDir);
  const childEnv = createSmokeEnvironment();
  assertMotionCliHelp(resolvedRoot, childEnv);
  fs.mkdirSync(working, { recursive: true });
  const projectDir = path.join(working, 'project');
  const node = (file, args, stage) => runNodeTool(path.join(resolvedRoot, file), args, { cwd: working, env: childEnv, stage });
  const cli = (args, stage) => node('scripts/cli.js', args, stage);
  cli(['demo', '--motion', '--project-dir', projectDir], 'release motion demo');
  cli(['preview', '--project-dir', projectDir, '--brief', 'brief/v01-draft.motion.json', '--no-open'], 'release motion preview');
  node('scripts/qa-preview.js', ['--project-dir', projectDir], 'release motion preview QA');
  const draft = readProjectManifest(projectDir);
  if (draft.currentPreview?.kind !== 'full' || draft.briefs.some(brief => brief.status !== 'draft')
    || draft.renders.length || fs.existsSync(path.join(projectDir, draft.final))) throw new Error('motion demo bypassed draft preview gates');
  decodeMedia(path.join(projectDir, 'previews/current-preview.mp4'), childEnv);
  // Explicit approval of a generated synthetic fixture for automated release verification.
  // This smoke harness never accepts a user project or approves client material.
  node('scripts/project/approve-brief.js', [projectDir, 'brief/v01-draft.motion.json', '--confirm-preview-viewed'], 'release motion fixture approval');
  cli(['motion', '--project-dir', projectDir, '--brief', 'brief/v01-approved.motion.json', '--version-label', 'release-smoke'], 'release motion final');
  const motionFinal = assertProjectFinal(projectDir);
  const metadata = assertMedia(motionFinal, 810, { width: 1080, height: 1920, fps: 30, videoCodec: 'h264', audioCodec: 'aac', audioTracks: 1 }, childEnv);
  const brief = JSON.parse(fs.readFileSync(path.join(projectDir, 'brief/v01-approved.motion.json')));
  for (const scene of brief.scenes) runTool('ffmpeg', ['-v', 'error', '-ss', String(scene.end - 0.75),
    '-i', motionFinal, '-frames:v', '1', path.join(working, `${scene.scene}.png`)], { cwd: working, env: childEnv, stage: `motion ${scene.scene} frame` });
  fs.writeFileSync(path.join(working, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
  return { motionFinal, motionEvidence: working };
}

function runReleaseSmoke({ root = ROOT, id = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}` } = {}) {
  const resolvedRoot = path.resolve(root);
  const protectedBefore = snapshotFiles(resolvedRoot, PROTECTED_FILES);
  const restorePublicSource = preservePublicSource(resolvedRoot);
  const childEnv = createSmokeEnvironment();
  const lessonId = `release-lesson-neutral-${id}`;
  const lessonDir = path.join(resolvedRoot, 'out', 'release-smoke', id, 'lesson');
  const lessonFinal = path.join(lessonDir, `${lessonId}.mp4`);
  const source = path.join(resolvedRoot, 'examples', 'demo-source.mp4');
  const lessonBrief = path.join(resolvedRoot, 'examples', 'lesson-neutral-approved.json');
  const projectDir = path.join(resolvedRoot, 'projects', `release-dynamic-smoke-${id}`);
  let completed = false;
  try {
    runNodeTool(path.join(resolvedRoot, 'scripts', 'build.js'), [
      source,
      '--template', 'lesson',
      '--brief', lessonBrief,
      '--frames', '75',
      '--id', lessonId,
      '--outdir', lessonDir,
    ], { cwd: resolvedRoot, env: childEnv, stage: 'release lesson smoke' });
    assertMedia(lessonFinal, 75, null, childEnv);

    const workspace = createOrOpenProject({
      baseDir: path.join(resolvedRoot, 'projects'),
      name: 'Release Dynamic Smoke',
      projectDir,
      sourcePath: source,
    });
    const scenarioPath = path.join(workspace.dir, 'brief', 'release-smoke.scenario.json');
    fs.copyFileSync(
      path.join(resolvedRoot, 'examples', 'scenario-demo.json'),
      scenarioPath,
      fs.constants.COPYFILE_EXCL,
    );
    runNodeTool(path.join(resolvedRoot, 'scripts', 'build.js'), [
      workspace.sourcePath,
      '--scenario', path.relative(workspace.dir, scenarioPath),
      '--project-dir', workspace.dir,
      '--version-label', 'smoke',
      '--frames', '75',
      '--no-transcribe',
    ], { cwd: resolvedRoot, env: childEnv, stage: 'release dynamic smoke' });
    const projectFinal = assertProjectFinal(workspace.dir);
    assertMedia(projectFinal, 75, null, childEnv);
    const motion = runMotionReleaseSmoke({ root: resolvedRoot, workDir: path.join(resolvedRoot, 'out/release-smoke', id, 'motion') });
    completed = true;
    return { lessonFinal, projectFinal, ...motion };
  } finally {
    try {
      restorePublicSource();
    } finally {
      assertProtectedFilesUnchanged(resolvedRoot, protectedBefore);
    }
    if (!completed) console.error(`release smoke artifacts kept for diagnosis: ${lessonDir}, ${projectDir}`);
  }
}

function main() {
  configureMediaToolPath();
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--motion-only') || args.length > 1) throw new Error('usage: smoke-release.js [--motion-only]');
  const result = args.length ? runMotionReleaseSmoke() : runReleaseSmoke();
  if (result.lessonFinal) console.log(`lesson final: ${result.lessonFinal}`);
  if (result.projectFinal) console.log(`dynamic project final: ${result.projectFinal}`);
  console.log(`motion final: ${result.motionFinal}`);
  console.log(`motion evidence: ${result.motionEvidence}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`release smoke failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  createSmokeEnvironment,
  assertMotionCliHelp,
  runMotionReleaseSmoke,
  assertMedia,
  assertProjectFinal,
  assertProtectedFilesUnchanged,
  probeMedia,
  runReleaseSmoke,
  snapshotFiles,
};
