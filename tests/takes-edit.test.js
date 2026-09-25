const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertTakesEditShape,
  isTakesEdit,
  remapTakeRangesTranscript,
  snapTakeRanges,
  takesTrimPlan,
  validateTakeRanges,
} = require('../scripts/project/takes-edit');

function takesEdit(overrides = {}) {
  return {
    version: 1,
    kind: 'takes',
    sourceRevision: 1,
    ranges: [
      { take: 'take-02', start: 1.02, end: 2.51, beat: 'HOOK', reason: 'чистая подача' },
      { take: 'take-01', start: 4, end: 6, beat: 'CTA', reason: 'единственный полный призыв' },
    ],
    ...overrides,
  };
}

const takes = new Map([
  ['take-01', { id: 'take-01', filePath: 'take-01.mp4', duration: 8 }],
  ['take-02', { id: 'take-02', filePath: 'take-02.mov', duration: 5 }],
]);

test('takes edit shape requires kind, reasons, id format and the active revision', () => {
  assert.equal(isTakesEdit(takesEdit()), true);
  assert.equal(isTakesEdit({ version: 1, keep: [] }), false);
  assert.equal(assertTakesEditShape(takesEdit(), { sourceRevision: 1 }).ranges.length, 2);
  const missingReason = takesEdit();
  delete missingReason.ranges[0].reason;
  for (const [label, edit, pattern] of [
    ['kind', takesEdit({ kind: 'source' }), /kind/],
    ['reason', missingReason, /reason/],
    ['id', takesEdit({ ranges: [{ take: 'take-1', start: 0, end: 1, beat: 'HOOK', reason: 'x' }] }), /pattern/],
    ['extra', takesEdit({ fps: 25 }), /additional properties/],
    ['revision', takesEdit({ sourceRevision: 2 }), /revision/],
  ]) {
    assert.throws(() => assertTakesEditShape(edit, { sourceRevision: 1 }), pattern, label);
  }
});

test('take ranges must reference registered takes and stay inside the usable duration', () => {
  assert.doesNotThrow(() => validateTakeRanges(takesEdit().ranges, takes));
  assert.doesNotThrow(() => validateTakeRanges([{ take: 'take-02', start: 4.5, end: 5.2 }], takes));
  assert.throws(() => validateTakeRanges([{ take: 'take-07', start: 0, end: 1 }], takes), /unknown take take-07/);
  assert.throws(() => validateTakeRanges([{ take: 'take-02', start: 2, end: 2 }], takes), /end > start/);
  assert.throws(() => validateTakeRanges([{ take: 'take-02', start: 4, end: 5.3 }], takes), /usable duration/);
  assert.throws(() => validateTakeRanges([{ take: 'take-02', start: 5, end: 5.1 }], takes), /usable duration/);
});

test('ranges snap outward to whole frames and clamp to the take end', () => {
  const snapped = snapTakeRanges([
    ...takesEdit().ranges,
    { take: 'take-02', start: 4.5, end: 5.2, beat: 'TAIL', reason: 'хвост' },
  ], { fps: 25, takes });
  assert.deepEqual(
    snapped.map(({ take, start, end, startFrame, endFrame }) => [take, start, end, startFrame, endFrame]),
    [
      ['take-02', 1, 2.52, 25, 63],
      ['take-01', 4, 6, 100, 150],
      ['take-02', 4.48, 5, 112, 125],
    ],
  );
  assert.equal(snapped[0].reason, 'чистая подача');
});

test('NTSC ranges snap to exact 30000/1001 frame boundaries', () => {
  const [range] = snapTakeRanges(
    [{ take: 'take-01', start: 1, end: 2, beat: 'HOOK', reason: 'x' }],
    { fps: 30000 / 1001, takes },
  );
  assert.deepEqual([range.startFrame, range.endFrame], [29, 60]);
  assert.equal(range.start, 29 * 1001 / 30000);
  assert.equal(range.end, 60 * 1001 / 30000);
});

test('snapped ranges from one take must not overlap and must keep at least one frame', () => {
  assert.throws(() => snapTakeRanges([
    { take: 'take-02', start: 1, end: 2, beat: 'A', reason: 'x' },
    { take: 'take-02', start: 1.99, end: 3, beat: 'B', reason: 'y' },
  ], { fps: 25, takes }), /overlaps ranges\[0\]/);
  const shortTakes = new Map([['take-01', { id: 'take-01', filePath: 'a.mp4', duration: 1.01 }]]);
  assert.throws(() => snapTakeRanges(
    [{ take: 'take-01', start: 1, end: 1.01, beat: 'A', reason: 'x' }],
    { fps: 25, takes: shortTakes },
  ), /one frame/);
  assert.doesNotThrow(() => snapTakeRanges([
    { take: 'take-02', start: 1, end: 2, beat: 'A', reason: 'x' },
    { take: 'take-01', start: 1, end: 2, beat: 'B', reason: 'y' },
  ], { fps: 25, takes }));
});

test('words from each take move onto the assembled timeline', () => {
  const ranges = snapTakeRanges(takesEdit().ranges, { fps: 25, takes });
  const words = remapTakeRangesTranscript(ranges, new Map([
    ['take-02', [{ w: 'привет', s: 1.1, e: 1.5 }, { w: 'лишнее', s: 3, e: 3.4 }]],
    ['take-01', [{ w: 'пока', s: 4.5, e: 5 }, { w: 'хвост', s: 5.9, e: 6.3 }]],
  ]), 25);
  assert.deepEqual(words, [
    { w: 'привет', s: 0.1, e: 0.5 },
    { w: 'пока', s: 2.02, e: 2.52 },
    { w: 'хвост', s: 3.42, e: 3.52 },
  ]);
});

test('trim plan lists each take once in order of first use', () => {
  const ranges = snapTakeRanges([
    ...takesEdit().ranges,
    { take: 'take-02', start: 3, end: 4, beat: 'PROOF', reason: 'z' },
  ], { fps: 25, takes });
  assert.deepEqual(takesTrimPlan(ranges, takes), {
    inputs: ['take-02.mov', 'take-01.mp4'],
    segments: [
      { input: 0, start: 1, end: 2.52 },
      { input: 1, start: 4, end: 6 },
      { input: 0, start: 3, end: 4 },
    ],
  });
});
