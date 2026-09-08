const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { probeOpenedAudio } = require('../scripts/media-probe');
const {
  copyProjectFileNoReplace,
  createOrOpenProject,
} = require('../scripts/project/workspace');
const {
  createMotionProject,
  transcribeMotionNarration,
} = require('../scripts/motion/source');
const {
  prepareMotionRender,
  withMotionSourceLease,
} = require('../scripts/motion/workflow');

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-motion-source-'));
  fs.mkdirSync(path.join(root, 'public'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runFfmpeg(args) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], {
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr);
}

function generateAudioFixtures(root) {
  const wav = path.join(root, 'voice.wav');
  const mp3 = path.join(root, 'voice.mp3');
  const source = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.25', '-ac', '1', '-ar', '44100'];
  runFfmpeg([...source, '-c:a', 'pcm_s16le', wav]);
  runFfmpeg([...source, '-c:a', 'libmp3lame', mp3]);
  return { wav, mp3 };
}

function probeFile(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    return probeOpenedAudio({ fileDescriptor: descriptor });
  } finally {
    fs.closeSync(descriptor);
  }
}

function approvedBrief(source = 'input/narration.mp3') {
  return {
    version: 1,
    kind: 'motion-reel',
    status: 'approved',
    source,
    theme: 'motion-neutral',
    title: 'Audio motion',
    output: {
      aspect: 'vertical', width: 1080, height: 1920, fps: 30, durationInFrames: 30,
    },
    scenes: [{ scene: 'kinetic-title', start: 0, end: 1, text: 'Звук ведёт монтаж' }],
  };
}

test('real WAV and MP3 fixtures expose narration duration, codec, sample rate and channels', (t) => {
  const root = makeFixture(t);
  const fixtures = generateAudioFixtures(root);

  const wav = probeFile(fixtures.wav);
  const mp3 = probeFile(fixtures.mp3);

  assert.deepEqual(
    { mediaKind: wav.mediaKind, sampleRate: wav.sampleRate, channels: wav.channels, codec: wav.codec },
    { mediaKind: 'audio', sampleRate: 44100, channels: 1, codec: 'pcm_s16le' },
  );
  assert.deepEqual(
    { mediaKind: mp3.mediaKind, sampleRate: mp3.sampleRate, channels: mp3.channels, codec: mp3.codec },
    { mediaKind: 'audio', sampleRate: 44100, channels: 1, codec: 'mp3' },
  );
  assert.ok(wav.durationSec >= 0.24 && wav.durationSec <= 0.26, wav.durationSec);
  assert.ok(mp3.durationSec >= 0.24 && mp3.durationSec <= 0.30, mp3.durationSec);
});

test('motion project stores narration atomically inside input and records audio discriminators', (t) => {
  const root = makeFixture(t);
  const { mp3 } = generateAudioFixtures(root);

  const result = createMotionProject({
    projectDir: path.join(root, 'project'),
    name: 'Narration project',
    narrationPath: mp3,
    now: new Date('2026-09-08T10:00:00Z'),
  });

  assert.equal(result.workspace.manifest.projectKind, 'motion-reel');
  assert.equal(result.workspace.manifest.source.mediaKind, 'audio');
  assert.equal(result.workspace.manifest.source.localPath, 'input/narration.mp3');
  assert.equal(fs.readFileSync(result.workspace.sourcePath).equals(fs.readFileSync(mp3)), true);
  assert.equal(result.probe.codec, 'mp3');
});

test('project copy rejects traversal and source or destination symlinks without outside writes', (t) => {
  const root = makeFixture(t);
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(path.join(projectDir, 'input'), { recursive: true });
  const source = path.join(root, 'source.wav');
  const sourceLink = path.join(root, 'source-link.wav');
  const outside = path.join(root, 'outside.wav');
  fs.writeFileSync(source, 'audio bytes');
  fs.writeFileSync(outside, 'outside survives');
  fs.symlinkSync(source, sourceLink, 'file');

  assert.throws(() => copyProjectFileNoReplace({
    projectDir, sourcePath: source, storedPath: '../outside.wav',
  }), /inside|canonical|escape/i);
  assert.throws(() => copyProjectFileNoReplace({
    projectDir, sourcePath: sourceLink, storedPath: 'input/from-link.wav',
  }), /symbolic|symlink|no.?follow/i);

  fs.rmdirSync(path.join(projectDir, 'input'));
  fs.symlinkSync(root, path.join(projectDir, 'input'), 'dir');
  assert.throws(() => copyProjectFileNoReplace({
    projectDir, sourcePath: source, storedPath: 'input/escaped.wav',
  }), /symbolic link/i);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside survives');
  assert.equal(fs.existsSync(path.join(root, 'escaped.wav')), false);
});

test('an old video project keeps its source contract and cannot be reopened as motion audio', (t) => {
  const root = makeFixture(t);
  const video = path.join(root, 'camera.mp4');
  fs.writeFileSync(video, 'legacy video bytes');
  const workspace = createOrOpenProject({
    projectDir: path.join(root, 'video-project'),
    name: 'Old video',
    sourcePath: video,
    now: new Date('2026-09-08T10:00:00Z'),
  });

  assert.equal(workspace.manifest.projectKind, 'video');
  assert.equal(workspace.manifest.source.mediaKind, 'video');
  assert.equal(workspace.manifest.source.localPath, 'input/source.mp4');
  assert.throws(
    () => createMotionProject({ projectDir: workspace.dir }),
    /motion-reel.*audio/i,
  );
});

test('supplied narration writes canonical faster-whisper words inside the project', (t) => {
  const root = makeFixture(t);
  const { wav } = generateAudioFixtures(root);
  const { workspace } = createMotionProject({
    projectDir: path.join(root, 'project'),
    name: 'Whisper timing',
    narrationPath: wav,
    now: new Date('2026-09-08T10:00:00Z'),
  });
  const canonical = [{
    start: 0,
    end: 0.24,
    text: 'Первое слово',
    words: [{ w: 'Первое', s: 0, e: 0.1 }, { w: 'слово', s: 0.12, e: 0.24 }],
  }];

  const result = transcribeMotionNarration({
    root,
    workspace,
    pythonCommand: 'python3',
    runToolImpl(command, args) {
      assert.equal(command, 'python3');
      assert.equal(path.basename(args[0]), 'transcribe.py');
      fs.writeFileSync(args[2], `${JSON.stringify(canonical)}\n`);
      return { status: 0, signal: null, stdout: '', stderr: '' };
    },
  });

  assert.deepEqual(JSON.parse(fs.readFileSync(result.wordsPath, 'utf8')), canonical);
  assert.equal(result.wordsPath, path.join(workspace.dir, 'transcript', 'words.json'));
});

test('motion render binds only narration to an isolated temporary public lease', (t) => {
  const root = makeFixture(t);
  const { mp3 } = generateAudioFixtures(root);
  const { workspace } = createMotionProject({
    projectDir: path.join(root, 'project'),
    name: 'Render lease',
    narrationPath: mp3,
    now: new Date('2026-09-08T10:00:00Z'),
  });
  const prepared = prepareMotionRender({ workspace, brief: approvedBrief() });
  let leasedPath;

  const value = withMotionSourceLease({
    root,
    prepared,
    temporaryId: '12345678-1234-4234-8234-123456789abc',
  }, (leased) => {
    leasedPath = path.join(leased.publicDirectory, ...leased.props.audioSrc.split('/'));
    assert.equal(fs.readFileSync(leasedPath).equals(fs.readFileSync(mp3)), true);
    assert.equal(leased.composition, 'MotionReel');
    assert.equal(Object.hasOwn(leased.props, 'faceSrc'), false);
    assert.equal(leased.props.audioSrc.startsWith('.automontage/'), true);
    return 'rendered';
  });

  assert.equal(value, 'rendered');
  assert.equal(fs.existsSync(leasedPath), false);
  assert.equal(Object.hasOwn(prepared.props, 'faceSrc'), false);
});

test('motion render rejects a brief that points outside the project or at another source', (t) => {
  const root = makeFixture(t);
  const { mp3 } = generateAudioFixtures(root);
  const { workspace } = createMotionProject({
    projectDir: path.join(root, 'project'),
    name: 'Brief source gate',
    narrationPath: mp3,
    now: new Date('2026-09-08T10:00:00Z'),
  });
  fs.writeFileSync(path.join(workspace.dir, 'input', 'other.mp3'), 'other');

  assert.throws(
    () => prepareMotionRender({ workspace, brief: approvedBrief('../outside.mp3') }),
    /source|canonical|inside/i,
  );
  assert.throws(
    () => prepareMotionRender({ workspace, brief: approvedBrief('input/other.mp3') }),
    /another narration|другой/i,
  );
});
