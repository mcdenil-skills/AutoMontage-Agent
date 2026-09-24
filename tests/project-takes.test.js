const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { addTakes } = require('../scripts/project/takes');
const {
  createOrOpenProject,
  readProjectManifest,
} = require('../scripts/project/workspace');

function media(overrides = {}) {
  return {
    mediaKind: 'video',
    width: 1920,
    height: 1080,
    rotation: 0,
    hasAudio: true,
    audioSampleRate: 48000,
    audioChannels: 2,
    videoDurationSec: 10,
    audioDurationSec: 10,
    ...overrides,
  };
}

function makeProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-takes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, 'take1.mp4');
  const second = path.join(root, 'take2.MOV');
  fs.writeFileSync(original, 'TAKE-ONE');
  fs.writeFileSync(second, 'TAKE-TWO');
  const workspace = createOrOpenProject({
    projectDir: path.join(root, 'project'),
    name: 'Takes',
    sourcePath: original,
    now: new Date('2026-09-25T10:00:00.000Z'),
  });
  return { root, original, second, dir: workspace.dir };
}

function fakes(overrides = {}) {
  const transcribed = [];
  return {
    transcribed,
    deps: {
      probeVideoImpl: () => ({ width: 1920, height: 1080, fps: 25, duration: 10 }),
      probeMediaPathImpl: () => media(),
      transcribeImpl({ videoPath }) {
        transcribed.push(path.basename(videoPath));
        return [{ start: 0, end: 1, text: 'слово', words: [{ w: 'слово', s: 0.2, e: 0.6 }] }];
      },
      now: () => new Date('2026-09-25T11:00:00.000Z'),
      temporaryId: () => 'takes-test',
      ...overrides,
    },
  };
}

test('takes add registers the original as take-01 and copies new takes without touching the source', (t) => {
  const fixture = makeProject(t);
  const { deps, transcribed } = fakes();
  const result = addTakes({ projectDir: fixture.dir, files: [fixture.second] }, deps);
  const manifest = readProjectManifest(fixture.dir);

  assert.deepEqual(manifest.takes, [
    {
      id: 'take-01',
      originalPath: fixture.original,
      localPath: 'input/source.mp4',
      transcriptPath: 'transcript/takes/take-01.json',
    },
    {
      id: 'take-02',
      originalPath: fixture.second,
      localPath: 'input/takes/take-02.mov',
      transcriptPath: 'transcript/takes/take-02.json',
    },
  ]);
  assert.deepEqual(result.takes.map((take) => take.id), ['take-01', 'take-02']);
  assert.deepEqual(transcribed, ['source.mp4', 'take-02.mov']);
  assert.equal(fs.readFileSync(path.join(fixture.dir, 'input', 'takes', 'take-02.mov'), 'utf8'), 'TAKE-TWO');
  assert.equal(fs.readFileSync(fixture.second, 'utf8'), 'TAKE-TWO');
  assert.equal(manifest.source.localPath, 'input/source.mp4');
  assert.equal(manifest.source.revision, 1);
  assert.equal(JSON.parse(fs.readFileSync(
    path.join(fixture.dir, 'transcript', 'takes', 'take-02.json'), 'utf8',
  ))[0].words[0].w, 'слово');
});

test('a second takes add appends without re-transcribing registered takes', (t) => {
  const fixture = makeProject(t);
  addTakes({ projectDir: fixture.dir, files: [fixture.second] }, fakes().deps);
  const third = path.join(fixture.root, 'take3.mp4');
  fs.writeFileSync(third, 'TAKE-THREE');
  const { deps, transcribed } = fakes();
  addTakes({ projectDir: fixture.dir, files: [third] }, deps);
  assert.deepEqual(readProjectManifest(fixture.dir).takes.map((take) => take.id), ['take-01', 'take-02', 'take-03']);
  assert.deepEqual(transcribed, ['take-03.mp4']);
});

test('incompatible takes are rejected before anything is copied', (t) => {
  const fixture = makeProject(t);
  for (const [label, overrides, pattern] of [
    ['fps', { probeVideoImpl: (file) => ({ width: 1920, height: 1080, fps: file.endsWith('take2.MOV') ? 30 : 25, duration: 10 }) }, /FPS/],
    ['size', { probeMediaPathImpl: (file) => (file.endsWith('take2.MOV') ? media({ width: 1280, height: 720 }) : media()) }, /frame size/],
    ['audio', { probeMediaPathImpl: (file) => (file.endsWith('take2.MOV') ? media({ hasAudio: false, audioSampleRate: null, audioChannels: null, audioDurationSec: null }) : media()) }, /no usable audio/],
  ]) {
    assert.throws(() => addTakes({ projectDir: fixture.dir, files: [fixture.second] }, fakes(overrides).deps), pattern, label);
    assert.equal(readProjectManifest(fixture.dir).takes, undefined, label);
    assert.equal(fs.existsSync(path.join(fixture.dir, 'input', 'takes', 'take-02.mov')), false, label);
  }
});

test('a rotated take with the same displayed size is compatible', (t) => {
  const fixture = makeProject(t);
  const { deps } = fakes({
    probeMediaPathImpl: (file) => (file.endsWith('take2.MOV')
      ? media({ width: 1080, height: 1920, rotation: 90 })
      : media()),
  });
  addTakes({ projectDir: fixture.dir, files: [fixture.second] }, deps);
  assert.equal(readProjectManifest(fixture.dir).takes.length, 2);
});

test('failed transcription removes copied files and leaves the manifest unchanged', (t) => {
  const fixture = makeProject(t);
  const { deps } = fakes({
    transcribeImpl({ videoPath }) {
      if (videoPath.endsWith('take-02.mov')) throw new Error('whisper failed');
      return [{ start: 0, end: 1, text: 'слово', words: [{ w: 'слово', s: 0.2, e: 0.6 }] }];
    },
  });
  assert.throws(() => addTakes({ projectDir: fixture.dir, files: [fixture.second] }, deps), /whisper failed/);
  assert.equal(readProjectManifest(fixture.dir).takes, undefined);
  assert.equal(fs.existsSync(path.join(fixture.dir, 'input', 'takes', 'take-02.mov')), false);
  assert.equal(fs.existsSync(path.join(fixture.dir, 'transcript', 'takes', 'take-01.json')), false);
});

test('takes are refused for motion-reel projects and missing files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-takes-motion-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const narration = path.join(root, 'narration.wav');
  fs.writeFileSync(narration, 'NARRATION');
  const motion = createOrOpenProject({
    projectDir: path.join(root, 'motion'),
    name: 'Motion takes',
    sourcePath: narration,
    projectKind: 'motion-reel',
  });
  assert.throws(() => addTakes({ projectDir: motion.dir, files: [narration] }, fakes().deps), /only for video projects/);

  const fixture = makeProject(t);
  assert.throws(
    () => addTakes({ projectDir: fixture.dir, files: [path.join(fixture.root, 'missing.mp4')] }, fakes().deps),
    /take file not found/,
  );
});
