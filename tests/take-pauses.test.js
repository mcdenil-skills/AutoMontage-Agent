const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeLevels,
  findPauseCut,
  isSilentSpan,
  levelsFromPcm,
  pauseThresholdDb,
  snapRangesToPauses,
} = require('../scripts/project/take-pauses');

// Окна по 10 мс: речь -20 dB на 0-1.0 и 1.3-2.5 с, тишина -90 dB на 1.0-1.3 и 2.5-3.0 с.
function speechLevels() {
  const levels = [];
  for (let index = 0; index < 300; index += 1) {
    const time = index / 100;
    levels.push(time < 1 || (time >= 1.3 && time < 2.5) ? -20 : -90);
  }
  return { frameSec: 0.01, levels };
}

function twoTakes() {
  return new Map([
    ['take-01', { id: 'take-01', duration: 3, usableStart: 0 }],
    ['take-02', { id: 'take-02', duration: 3, usableStart: 0 }],
  ]);
}

test('pcm levels are 10 ms RMS frames in dBFS with a floor for digital silence', () => {
  const buffer = Buffer.alloc(320 * 2);
  for (let index = 160; index < 320; index += 1) buffer.writeInt16LE(16384, index * 2);
  const { frameSec, levels } = levelsFromPcm(buffer, { sampleRate: 16000 });
  assert.equal(frameSec, 0.01);
  assert.equal(levels.length, 2);
  assert.equal(levels[0], -120);
  assert.ok(Math.abs(levels[1] - 20 * Math.log10(0.5)) < 1e-9);
});

test('pause threshold adapts to the take noise floor and never exceeds -30 dBFS', () => {
  assert.equal(pauseThresholdDb(speechLevels().levels), -55);
  const phone = speechLevels().levels.map((level) => (level === -90 ? -50 : level));
  assert.equal(pauseThresholdDb(phone), -35);
  assert.equal(pauseThresholdDb(new Array(100).fill(-20)), -30);
});

test('a cut inside speech moves to the nearest pause on the video frame grid', () => {
  const analysis = analyzeLevels(speechLevels());
  assert.equal(findPauseCut(analysis, 1.36, 'end', { fps: 25 }), 1.12);
  assert.equal(findPauseCut(analysis, 1.36, 'start', { fps: 25 }), 1.2);
  assert.equal(findPauseCut(analysis, 2.4, 'end', { fps: 25 }), 2.6);
  assert.equal(findPauseCut(analysis, 1.13, 'end', { fps: 25 }), 1.12);
  assert.equal(findPauseCut(analysis, 0.5, 'end', { fps: 25 }), null);
  assert.equal(findPauseCut(analysis, 1.36, 'end', { fps: 30000 / 1001 }), 33 * 1001 / 30000);
});

test('a span is silent only when every level frame it touches is below the threshold', () => {
  const analysis = analyzeLevels(speechLevels());
  assert.equal(isSilentSpan(analysis, 1.05, 1.06), true);
  assert.equal(isSilentSpan(analysis, 2.6, 2.6), true);
  assert.equal(isSilentSpan(analysis, 0.95, 1.05), false);
  assert.equal(isSilentSpan(analysis, 0.2, 0.6), false);
});

test('ranges move into pauses and report every moved or unmovable edge', () => {
  const analysis = analyzeLevels(speechLevels());
  const result = snapRangesToPauses([
    { take: 'take-01', start: 0, end: 1.36, beat: 'A', reason: 'x' },
    { take: 'take-01', start: 1.36, end: 2.4, beat: 'B', reason: 'y' },
    { take: 'take-02', start: 0.4, end: 0.6, beat: 'C', reason: 'z' },
  ], {
    takes: twoTakes(),
    analyses: new Map([['take-01', analysis], ['take-02', analysis]]),
    fps: 25,
  });
  assert.deepEqual(result.ranges.map(({ start, end }) => [start, end]), [[0, 1.12], [1.2, 2.6], [0.4, 0.6]]);
  assert.equal(result.ranges[0].beat, 'A');
  assert.deepEqual(result.adjustments, [
    { index: 0, edge: 'end', from: 1.36, to: 1.12, reason: 'pause' },
    { index: 1, edge: 'start', from: 1.36, to: 1.2, reason: 'pause' },
    { index: 1, edge: 'end', from: 2.4, to: 2.6, reason: 'pause' },
    { index: 2, edge: 'start', from: 0.4, to: 0.4, reason: 'no-pause' },
    { index: 2, edge: 'end', from: 0.6, to: 0.6, reason: 'no-pause' },
  ]);
});

test('a range that would collapse or overlap keeps its original edges', () => {
  const analysis = analyzeLevels(speechLevels());
  const analyses = new Map([['take-01', analysis]]);
  const collapsed = snapRangesToPauses(
    [{ take: 'take-01', start: 1.32, end: 1.38, beat: 'B', reason: 'y' }],
    { takes: twoTakes(), analyses, fps: 25 },
  );
  assert.deepEqual(collapsed.ranges.map(({ start, end }) => [start, end]), [[1.32, 1.38]]);
  assert.deepEqual(collapsed.adjustments.map(({ edge, reason }) => [edge, reason]), [['start', 'kept'], ['end', 'kept']]);
  const overlapped = snapRangesToPauses([
    { take: 'take-01', start: 0, end: 2.4, beat: 'A', reason: 'x' },
    { take: 'take-01', start: 2.55, end: 2.9, beat: 'B', reason: 'y' },
  ], { takes: twoTakes(), analyses, fps: 25 });
  assert.deepEqual(overlapped.ranges.map(({ start, end }) => [start, end]), [[0, 2.4], [2.55, 2.9]]);
  assert.deepEqual(
    overlapped.adjustments.map(({ index, edge, reason }) => [index, edge, reason]),
    [[0, 'start', 'kept'], [0, 'end', 'kept'], [1, 'start', 'kept'], [1, 'end', 'kept']],
  );
});

test('edges at the file boundaries are not reported and takes without levels are untouched', () => {
  const tone = analyzeLevels({ frameSec: 0.01, levels: new Array(300).fill(-20) });
  const edges = snapRangesToPauses(
    [{ take: 'take-01', start: 0, end: 3, beat: 'A', reason: 'x' }],
    { takes: twoTakes(), analyses: new Map([['take-01', tone]]), fps: 25 },
  );
  assert.deepEqual(edges.ranges.map(({ start, end }) => [start, end]), [[0, 3]]);
  assert.deepEqual(edges.adjustments, []);
  const untouched = snapRangesToPauses(
    [{ take: 'take-02', start: 0.4, end: 0.6, beat: 'A', reason: 'x' }],
    { takes: twoTakes(), analyses: new Map(), fps: 25 },
  );
  assert.deepEqual(untouched.ranges.map(({ start, end }) => [start, end]), [[0.4, 0.6]]);
  assert.deepEqual(untouched.adjustments, []);
});
