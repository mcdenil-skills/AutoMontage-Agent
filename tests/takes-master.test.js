const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildMaster, takesSummaryLines } = require('../scripts/project/build-master');
const { addTakes } = require('../scripts/project/takes');
const {
  createOrOpenProject,
  readProjectManifest,
} = require('../scripts/project/workspace');

function media(overrides = {}) {
  return {
    mediaKind: 'video', width: 1920, height: 1080, rotation: 0, hasAudio: true,
    audioSampleRate: 48000, audioChannels: 2, videoDurationSec: 10, audioDurationSec: 10,
    ...overrides,
  };
}

function setupTakes(t, { register = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-takes-master-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'take1.mp4');
  const second = path.join(root, 'take2.mov');
  fs.writeFileSync(first, 'TAKE-ONE');
  fs.writeFileSync(second, 'TAKE-TWO');
  const workspace = createOrOpenProject({
    projectDir: path.join(root, 'project'),
    name: 'Takes master',
    sourcePath: first,
    now: new Date('2026-09-25T10:00:00.000Z'),
  });
  if (register) {
    const words = {
      'source.mp4': [{ w: 'пока', s: 4.5, e: 5 }, { w: 'хвост', s: 5.9, e: 6.3 }],
      'take-02.mov': [{ w: 'привет', s: 1.1, e: 1.5 }, { w: 'лишнее', s: 3, e: 3.4 }],
    };
    addTakes({ projectDir: workspace.dir, files: [second] }, {
      probeVideoImpl: () => ({ width: 1920, height: 1080, fps: 25, duration: 10 }),
      probeMediaPathImpl: () => media(),
      transcribeImpl: ({ videoPath }) => [{
        start: 0, end: 10, text: 'x', words: words[path.basename(videoPath)],
      }],
      now: () => new Date('2026-09-25T10:30:00.000Z'),
      temporaryId: () => 'takes-setup',
    });
  }
  return { root, dir: workspace.dir };
}

function writeEdit(dir, overrides = {}) {
  const edit = {
    version: 1,
    kind: 'takes',
    sourceRevision: 1,
    ranges: [
      { take: 'take-02', start: 1.02, end: 2.51, beat: 'HOOK', reason: 'самый уверенный хук' },
      { take: 'take-01', start: 4, end: 6, beat: 'CTA', reason: 'единственный полный призыв' },
    ],
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, 'edit', 'v02-takes.json'), `${JSON.stringify(edit, null, 2)}\n`);
  return 'edit/v02-takes.json';
}

function masterDependencies(calls, overrides = {}) {
  return {
    runSegmentsTrimImpl(options) {
      calls.push(['trim', options]);
      fs.writeFileSync(options.output, 'TAKES-MASTER');
    },
    runToolImpl(command, args, options) { calls.push([options.stage]); },
    probeVideoImpl(filename) {
      return path.basename(filename).startsWith('.source-v')
        ? { width: 1920, height: 1080, fps: 25, duration: 3.52 }
        : { width: 1920, height: 1080, fps: 25, duration: 10 };
    },
    probeMediaPathImpl: () => media(),
    readTakeLevelsImpl: () => null,
    now: () => new Date('2026-09-25T11:00:00.000Z'),
    temporaryId: () => 'takes-master',
    ...overrides,
  };
}

test('takes master assembles ranges from several takes into a new immutable source revision', (t) => {
  const fixture = setupTakes(t);
  const editPath = writeEdit(fixture.dir);
  const calls = [];
  const result = buildMaster({ projectDir: fixture.dir, editPath }, masterDependencies(calls));

  const [, trim] = calls[0];
  assert.deepEqual(trim.inputs, [
    path.join(fixture.dir, 'input', 'takes', 'take-02.mov'),
    path.join(fixture.dir, 'input', 'source.mp4'),
  ]);
  assert.deepEqual(trim.segments, [
    { input: 0, start: 1, end: 2.52 },
    { input: 1, start: 4, end: 6 },
  ]);
  assert.equal(trim.fps, '25/1');
  assert.deepEqual(trim.audioFormat, { sampleRate: 48000, channelLayout: 'stereo' });
  assert.equal(trim.audioFadeSec, 0.04);
  assert.equal(calls.some(([stage]) => stage === 'master decode'), true);

  const manifest = readProjectManifest(fixture.dir);
  assert.equal(manifest.source.originalLocalPath, 'input/source.mp4');
  assert.equal(manifest.source.localPath, 'input/source-v02.mp4');
  assert.equal(manifest.source.revision, 2);
  assert.deepEqual(manifest.source.history, [{
    revision: 2,
    localPath: 'input/source-v02.mp4',
    editPath: 'edit/v02-takes.json',
    transcriptPath: 'transcript/words-v02.json',
  }]);
  assert.equal(manifest.transcript.words, 'transcript/words-v02.json');
  assert.equal(manifest.takes.length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(
    path.join(fixture.dir, 'transcript', 'words-v02.json'), 'utf8',
  ))[0].words, [
    { w: 'привет', s: 0.1, e: 0.5 },
    { w: 'пока', s: 2.02, e: 2.52 },
    { w: 'хвост', s: 3.42, e: 3.52 },
  ]);
  assert.equal(result.kind, 'takes');
  assert.equal(result.duration, 3.52);
  assert.deepEqual(result.takes, ['take-02', 'take-01']);
  assert.deepEqual(result.ranges, [
    { take: 'take-02', start: 1, end: 2.52, beat: 'HOOK' },
    { take: 'take-01', start: 4, end: 6, beat: 'CTA' },
  ]);
});

test('a take range starts where both its streams have begun, not at zero', (t) => {
  const fixture = setupTakes(t);
  const editPath = writeEdit(fixture.dir, {
    ranges: [
      { take: 'take-02', start: 0, end: 2.51, beat: 'HOOK', reason: 'самый уверенный хук' },
      { take: 'take-01', start: 4, end: 6, beat: 'CTA', reason: 'единственный полный призыв' },
    ],
  });
  const calls = [];
  buildMaster({ projectDir: fixture.dir, editPath }, masterDependencies(calls, {
    probeMediaPathImpl: (file) => (file.includes('take-02') ? media({ startOffsetSec: 0.04 }) : media()),
    // take-02 [0.04, 2.52] is 2.48 long, plus take-01 [4, 6] is 2: total duration 4.48.
    probeVideoImpl(filename) {
      return path.basename(filename).startsWith('.source-v')
        ? { width: 1920, height: 1080, fps: 25, duration: 4.48 }
        : { width: 1920, height: 1080, fps: 25, duration: 10 };
    },
  }));
  const [, trim] = calls[0];
  assert.equal(trim.segments[0].start, 0.04);
});

test('audio format picks the richest sample rate and channel layout regardless of range order', (t) => {
  const fixture = setupTakes(t);
  const editPath = writeEdit(fixture.dir);
  const calls = [];
  // take-02 (44100/mono) is used FIRST in the edit's ranges; take-01 (48000/stereo, the default
  // fixture) is used second. The order must not downgrade the assembled audio quality.
  buildMaster({ projectDir: fixture.dir, editPath }, masterDependencies(calls, {
    probeMediaPathImpl: (file) => (file.includes('take-02')
      ? media({ audioSampleRate: 44100, audioChannels: 1 })
      : media()),
  }));
  const [, trim] = calls[0];
  assert.deepEqual(trim.audioFormat, { sampleRate: 48000, channelLayout: 'stereo' });
});

test('a corrupt take transcript names the take in the error and leaves the manifest unchanged', (t) => {
  const fixture = setupTakes(t);
  const editPath = writeEdit(fixture.dir);
  const before = fs.readFileSync(path.join(fixture.dir, 'project.json'));
  fs.writeFileSync(path.join(fixture.dir, 'transcript', 'takes', 'take-02.json'), '{');
  let thrown = null;
  try {
    buildMaster({ projectDir: fixture.dir, editPath }, masterDependencies([]));
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, 'buildMaster should throw');
  assert.match(thrown.message, /^take-02 transcript: /);
  assert.deepEqual(fs.readFileSync(path.join(fixture.dir, 'project.json')), before);
});

test('takes master rejects stale, unknown, unregistered and incompatible selections', (t) => {
  const fixture = setupTakes(t);
  const before = fs.readFileSync(path.join(fixture.dir, 'project.json'));
  for (const [label, edit, overrides, pattern] of [
    ['stale', { sourceRevision: 2 }, {}, /revision/],
    ['unknown', { ranges: [{ take: 'take-07', start: 0, end: 1, beat: 'HOOK', reason: 'x' }] }, {}, /unknown take take-07/],
    ['size', {}, {
      probeMediaPathImpl: (file) => (file.includes('take-02') ? media({ width: 1280, height: 720 }) : media()),
    }, /frame size/],
  ]) {
    const editPath = writeEdit(fixture.dir, edit);
    assert.throws(() => buildMaster({ projectDir: fixture.dir, editPath }, masterDependencies([], overrides)), pattern, label);
    assert.deepEqual(fs.readFileSync(path.join(fixture.dir, 'project.json')), before, label);
  }

  const empty = setupTakes(t, { register: false });
  const editPath = writeEdit(empty.dir, {
    ranges: [{ take: 'take-01', start: 0, end: 1, beat: 'HOOK', reason: 'x' }],
  });
  assert.throws(() => buildMaster({ projectDir: empty.dir, editPath }, masterDependencies([])), /takes add/);
});

test('failed takes encode leaves the active source and manifest unchanged', (t) => {
  const fixture = setupTakes(t);
  const editPath = writeEdit(fixture.dir);
  const before = fs.readFileSync(path.join(fixture.dir, 'project.json'));
  assert.throws(() => buildMaster({ projectDir: fixture.dir, editPath }, masterDependencies([], {
    runSegmentsTrimImpl() { throw new Error('encode failed'); },
  })), /encode failed/);
  assert.deepEqual(fs.readFileSync(path.join(fixture.dir, 'project.json')), before);
  assert.equal(fs.existsSync(path.join(fixture.dir, 'input', 'source-v02.mp4')), false);
  assert.equal(fs.existsSync(path.join(fixture.dir, 'transcript', 'words-v02.json')), false);
});

function levelsWithPauses(pauses, duration = 10) {
  const levels = [];
  for (let index = 0; index < duration * 100; index += 1) {
    const time = index / 100;
    levels.push(pauses.some(([from, to]) => time >= from && time < to) ? -90 : -20);
  }
  return { frameSec: 0.01, levels };
}

test('takes master moves cuts into pauses, drops silent edge words and reports joints', (t) => {
  const fixture = setupTakes(t);
  const editPath = writeEdit(fixture.dir);
  const calls = [];
  const result = buildMaster({ projectDir: fixture.dir, editPath }, masterDependencies(calls, {
    readTakeLevelsImpl: (file) => (file.includes('take-02')
      ? levelsWithPauses([[2.3, 2.45]])
      : levelsWithPauses([[3.8, 4.1], [5.8, 6.4]])),
    probeVideoImpl(filename) {
      return path.basename(filename).startsWith('.source-v')
        ? { width: 1920, height: 1080, fps: 25, duration: 3.36 }
        : { width: 1920, height: 1080, fps: 25, duration: 10 };
    },
  }));
  const [, trim] = calls[0];
  assert.deepEqual(trim.segments, [
    { input: 0, start: 1, end: 2.36 },
    { input: 1, start: 4, end: 6 },
  ]);
  assert.deepEqual(result.pauseAdjustments, [
    { index: 0, edge: 'start', from: 1.02, to: 1.02, reason: 'no-pause' },
    { index: 0, edge: 'end', from: 2.51, to: 2.36, reason: 'pause' },
  ]);
  assert.deepEqual(result.joints, [1.36]);
  assert.equal(result.duration, 3.36);
  assert.deepEqual(JSON.parse(fs.readFileSync(
    path.join(fixture.dir, 'transcript', 'words-v02.json'), 'utf8',
  ))[0].words, [
    { w: 'привет', s: 0.1, e: 0.5 },
    { w: 'пока', s: 1.86, e: 2.36 },
  ]);
});

test('master summary lists final ranges, joints and every pause decision', () => {
  assert.deepEqual(takesSummaryLines({
    takes: ['take-02', 'take-01'],
    ranges: [
      { take: 'take-02', start: 1, end: 2.52, beat: 'HOOK' },
      { take: 'take-01', start: 4, end: 6, beat: 'CTA' },
    ],
    joints: [1.52],
    pauseAdjustments: [
      { index: 0, edge: 'end', from: 2.51, to: 2.52, reason: 'pause' },
      { index: 1, edge: 'start', from: 4, to: 4, reason: 'no-pause' },
      { index: 1, edge: 'end', from: 6, to: 6, reason: 'kept' },
    ],
  }), [
    '   takes: take-02, take-01',
    '   ranges: 2',
    '     1. take-02 1.00-2.52 HOOK',
    '     2. take-01 4.00-6.00 CTA',
    '   joints: 1.52',
    '   pause: ranges[0].end 2.51 -> 2.52',
    '   no pause near: ranges[1].start 4.00',
    '   kept: ranges[1].end 6.00 (moving would collapse or overlap)',
  ]);
});
