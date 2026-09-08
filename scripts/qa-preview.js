#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const { configureMediaToolPath } = require('./env');
const { probeVideo } = require('./media-probe');
const { captureToolResult, runTool } = require('./process');
const { readProjectManifest, resolveProjectPath } = require('./project/workspace');

function hashFile(filename, fileSystem = fs) {
  const descriptor = fileSystem.openSync(filename, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let read;
    do {
      read = fileSystem.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read > 0) hash.update(buffer.subarray(0, read));
    } while (read > 0);
  } finally {
    fileSystem.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function parseMeanVolume(stderr, role) {
  const matches = [...String(stderr || '').matchAll(/mean_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/giu)];
  const value = Number(matches.at(-1)?.[1]);
  if (!Number.isFinite(value)) throw new Error(`preview QA could not measure ${role}`);
  return value;
}

function musicFilter(brief, duration, rangeStart) {
  const music = brief.music;
  const ducking = {
    thresholdDb: -28,
    ratio: 8,
    attackMs: 5,
    releaseMs: 300,
    ...(music.ducking || {}),
  };
  const rate = music.playbackRate ?? 1;
  const start = (music.startSec ?? 0) + rangeStart * rate;
  const filters = [];
  if (start > 0) filters.push(`atrim=start=${start}`, 'asetpts=PTS-STARTPTS');
  if (rate !== 1) filters.push(`atempo=${rate}`);
  filters.push(`volume=${music.gainDb}dB`);
  if ((music.fadeInSec ?? 0) > 0) filters.push(`afade=t=in:st=0:d=${music.fadeInSec}`);
  if ((music.fadeOutSec ?? 0) > 0) {
    filters.push(`afade=t=out:st=${Math.max(0, duration - music.fadeOutSec)}:d=${music.fadeOutSec}`);
  }
  const format = 'aformat=sample_rates=44100:channel_layouts=stereo';
  filters.push(format);
  return [
    `[1:a]${filters.join(',')}[m]`,
    `[0:a]${format}[sc]`,
    `[m][sc]sidechaincompress=threshold=${(10 ** (ducking.thresholdDb / 20)).toFixed(4)}:ratio=${ducking.ratio}:attack=${ducking.attackMs}:release=${ducking.releaseMs}:level_sc=1[duck]`,
    '[duck]volumedetect[measured]',
  ].join(';');
}

function measureAudio({ role, sourcePath, musicPath, brief, range }, {
  captureToolResultImpl = captureToolResult,
} = {}) {
  const duration = range.toSec - range.fromSec;
  let args;
  if (role === 'voice') {
    args = [
      '-hide_banner', '-nostats', '-ss', String(range.fromSec), '-t', String(duration),
      '-i', sourcePath, '-vn', '-af', 'volumedetect', '-f', 'null', '-',
    ];
  } else if (role === 'music-under-speech' && brief.music && musicPath) {
    args = [
      '-hide_banner', '-nostats', '-ss', String(range.fromSec), '-t', String(duration),
      '-i', sourcePath, '-stream_loop', '-1', '-i', musicPath,
      '-filter_complex', musicFilter(brief, duration, range.fromSec),
      '-map', '[measured]', '-t', String(duration), '-f', 'null', '-',
    ];
  } else {
    throw new Error(`preview QA audio role is invalid: ${role}`);
  }
  const result = captureToolResultImpl('ffmpeg', args, {
    stage: `preview QA ${role}`,
    maxBuffer: 1024 * 1024,
  });
  return parseMeanVolume(result.stderr, role);
}

function finalState(manifest) {
  return JSON.stringify({
    renders: manifest.renders,
    latestRender: manifest.latestRender,
    final: manifest.final,
  });
}

function runPreviewQa({ projectDir }, dependencies = {}) {
  if (!projectDir) throw new Error('preview QA requires --project-dir');
  const fileSystem = dependencies.fileSystem || fs;
  const readProjectManifestImpl = dependencies.readProjectManifestImpl || readProjectManifest;
  const runToolImpl = dependencies.runToolImpl || runTool;
  const probeVideoImpl = dependencies.probeVideoImpl || probeVideo;
  const measureAudioImpl = dependencies.measureAudioImpl || measureAudio;
  const resolvedProjectDir = path.resolve(projectDir);
  const manifest = readProjectManifestImpl(resolvedProjectDir);
  const beforeFinal = finalState(manifest);
  const metadata = manifest.currentPreview;
  if (!metadata || !['full', 'excerpt'].includes(metadata.kind)) {
    throw new Error('current preview is missing or has no explicit full/excerpt range');
  }
  if (!(metadata.toSec > metadata.fromSec)
    || (metadata.kind === 'full' && metadata.fromSec !== 0)) {
    throw new Error('current preview range is invalid');
  }
  const previewPath = resolveProjectPath(resolvedProjectDir, 'previews/current-preview.mp4', {
    label: 'current preview', fileSystem, mustExist: true, type: 'file',
  });
  const previewStat = fileSystem.lstatSync(previewPath);
  if (previewStat.isSymbolicLink() || !previewStat.isFile()) {
    throw new Error('current preview must be a regular file');
  }
  if (hashFile(previewPath, fileSystem) !== metadata.sha256) {
    throw new Error('current preview hash does not match project metadata');
  }
  runToolImpl('ffmpeg', ['-v', 'error', '-i', previewPath, '-f', 'null', '-'], {
    stage: 'preview QA full decode',
  });
  const probe = probeVideoImpl(previewPath, { stage: 'preview QA probe' });
  const expectedDuration = metadata.toSec - metadata.fromSec;
  if (probe.width !== metadata.width || probe.height !== metadata.height
    || Math.abs(probe.fps - metadata.fps) > 1e-6
    || Math.abs(probe.duration - expectedDuration) > Math.max(0.08, 1 / metadata.fps)) {
    throw new Error('preview metadata does not match decoded geometry, FPS, or duration');
  }
  runToolImpl('ffmpeg', [
    '-v', 'error', '-ss', '0', '-i', previewPath, '-frames:v', '1', '-f', 'null', '-',
  ], { stage: 'preview QA first frame' });
  const lastFrameSec = Math.max(0, probe.duration - (1 / probe.fps));
  const lastFrameText = lastFrameSec.toFixed(6).replace(/0+$/u, '').replace(/\.$/u, '');
  runToolImpl('ffmpeg', [
    '-v', 'error', '-ss', lastFrameText, '-i', previewPath,
    '-frames:v', '1', '-f', 'null', '-',
  ], { stage: 'preview QA last frame' });

  const briefPath = resolveProjectPath(resolvedProjectDir, metadata.briefPath, {
    label: 'preview brief', fileSystem, mustExist: true, type: 'file',
  });
  const brief = JSON.parse(fileSystem.readFileSync(briefPath, 'utf8'));
  const sourcePath = resolveProjectPath(resolvedProjectDir, manifest.source.localPath, {
    label: 'active source', fileSystem, mustExist: true, type: 'file',
  });
  const briefKind = require('./project/brief-contract').validateStoredBrief({ manifest, briefPath: metadata.briefPath, brief });
  const motion = briefKind === 'motion-reel';
  if (motion) {
    if (metadata.briefPath !== manifest.currentBrief) {
      const currentPath = resolveProjectPath(resolvedProjectDir, manifest.currentBrief, { fileSystem, mustExist: true, type: 'file' });
      const current = JSON.parse(fileSystem.readFileSync(currentPath, 'utf8'));
      const entry = manifest.briefs.find(item => item.jsonPath === manifest.currentBrief);
      if (current.status !== 'approved' || entry?.sha256 !== hashFile(currentPath, fileSystem)
        || current.approval?.draftSha256 !== metadata.briefSha256
        || current.approval?.previewSha256 !== metadata.sha256) throw new Error('motion preview is stale for the current brief');
    }
    if (hashFile(briefPath, fileSystem) !== metadata.briefSha256) throw new Error('motion preview brief is stale');
    if (hashFile(sourcePath, fileSystem) !== metadata.sourceSha256) throw new Error('motion preview narration source is stale');
  }
  let audio = motion && !brief.music ? { voiceDb: measureAudioImpl({ role: 'voice', sourcePath, brief, range: metadata }) } : null;
  if (brief.music) {
    const musicPath = motion
      ? resolveProjectPath(resolvedProjectDir, brief.music.file, { fileSystem, mustExist: true, type: 'file' })
      : path.resolve(brief.music.file);
    if (motion && hashFile(musicPath, fileSystem) !== brief.music.sha256) throw new Error('motion music is stale');
    audio = {
      voiceDb: measureAudioImpl({
        role: 'voice', sourcePath, musicPath, brief, range: metadata,
      }),
      musicUnderSpeechDb: measureAudioImpl({
        role: 'music-under-speech', sourcePath, musicPath, brief, range: metadata,
      }),
    };
  }
  const afterManifest = readProjectManifestImpl(resolvedProjectDir);
  const finalStateUnchanged = finalState(afterManifest) === beforeFinal;
  if (!finalStateUnchanged) throw new Error('preview QA observed a final render metadata change');
  return {
    kind: metadata.kind,
    range: { fromSec: metadata.fromSec, toSec: metadata.toSec },
    video: { width: probe.width, height: probe.height, fps: probe.fps, duration: probe.duration },
    audio,
    finalStateUnchanged,
  };
}

function parseQaOptions(argv) {
  if (argv.length !== 2 || argv[0] !== '--project-dir' || !argv[1]) {
    throw new Error('qa:preview requires --project-dir <project>');
  }
  return { projectDir: argv[1] };
}

function main(argv = process.argv.slice(2)) {
  try {
    configureMediaToolPath();
    const result = runPreviewQa(parseQaOptions(argv));
    const label = result.kind === 'full'
      ? 'ПОЛНЫЙ РОЛИК'
      : `ФРАГМЕНТ ${result.range.fromSec.toFixed(2)}–${result.range.toSec.toFixed(2)} сек`;
    console.log(`✅ preview QA: ${label}`);
    console.log(`   ${result.video.width}x${result.video.height}, ${result.video.fps} FPS, ${result.video.duration.toFixed(2)} sec`);
    if (result.audio) {
      console.log(`   voice ${result.audio.voiceDb.toFixed(1)} dB${result.audio.musicUnderSpeechDb === undefined ? '' : `; ducked music ${result.audio.musicUnderSpeechDb.toFixed(1)} dB`}`);
    }
  } catch (error) {
    console.error(`❌ preview QA: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { measureAudio, parseQaOptions, runPreviewQa };
