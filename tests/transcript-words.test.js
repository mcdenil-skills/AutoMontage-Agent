const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeWordTimings, normalizeTranscriptFile } = require('../scripts/transcript-words');
const { collectWords } = require('../scripts/tighten');

test('zero-length Whisper words survive normalization without mutating the input', () => {
  const input = [{ text: ' а б', start: 29, words: [
    { w: ' а', s: 29.26, e: 29.26, confidence: 0.9 },
    { w: ' б', s: 30, e: 30 }, { w: 'в', s: 31, e: 31.4 },
  ] }];
  const before = structuredClone(input);
  const normalized = normalizeWordTimings(input);
  assert.deepEqual(collectWords(normalized), [
    { w: 'а', s: 29.26, e: 29.27 }, { w: 'б', s: 30, e: 30.01 }, { w: 'в', s: 31, e: 31.4 },
  ]);
  assert.equal(normalized[0].words[0].confidence, 0.9);
  assert.equal(normalized[0].text, ' а б');
  assert.deepEqual(input, before);
  assert.deepEqual(normalizeWordTimings([]), []);
});

test('normalization leaves damaged timings for the strict word validator', () => {
  for (const word of [{ w: 'x', s: 2, e: 1 }, { w: 'x', s: -1, e: -1 },
    { w: 'x', s: 'bad', e: 1 }, { w: 'x', s: Infinity, e: Infinity },
    ...[null, '', false, true, [], [1], '1'].map((value) => ({ w: 'x', s: value, e: value }))]) {
    assert.throws(() => collectWords(normalizeWordTimings([{ words: [word] }])), /таймкод/);
  }
  assert.throws(() => collectWords(normalizeWordTimings(null)), /массив|array/i);
});

test('fresh transcript file is normalized with all segment fields retained', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-normalize-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'words.json');
  fs.writeFileSync(file, JSON.stringify([{ text: 'слово', words: [{ w: 'слово', s: 0.5, e: 0.5 }] }]));
  normalizeTranscriptFile(file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [
    { text: 'слово', words: [{ w: 'слово', s: 0.5, e: 0.51 }] },
  ]);
});
