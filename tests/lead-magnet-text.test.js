const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeCodeWord } = require('../scripts/lead-magnet/constants');
const { findQuoteInSegments, normalizeText, tokenize } = require('../scripts/lead-magnet/text');

const SEGMENTS = [
  { start: 0, end: 2, text: 'Opus 5.5 умеет всё.', words: [
    { w: ' Opus', s: 0.2, e: 0.6 }, { w: ' 5', s: 0.6, e: 0.8 }, { w: '.5', s: 0.8, e: 1.0 },
    { w: ' умеет', s: 1.0, e: 1.4 }, { w: ' всё.', s: 1.4, e: 1.9 },
  ] },
  { start: 60, end: 64, text: 'Напишите ГАЙД, и я пришлю всё.', words: [
    { w: ' Напишите', s: 60.1, e: 60.6 }, { w: ' ГАЙД,', s: 60.6, e: 61.0 }, { w: ' и', s: 61.0, e: 61.1 },
    { w: ' я', s: 61.1, e: 61.2 }, { w: ' пришлю', s: 61.2, e: 61.7 }, { w: ' всё.', s: 61.7, e: 62.2 },
  ] },
];

test('normalizeText ignores case, ё and punctuation', () => {
  assert.equal(normalizeText('  Всё — ГАЙД!  '), 'все гайд');
  assert.deepEqual(tokenize('Opus 5.5'), ['opus', '5', '5']);
});

test('quote is found with the global timecode of its first and last word', () => {
  assert.deepEqual(findQuoteInSegments(SEGMENTS, 'напишите «гайд» — и я пришлю ВСЕ'), [{ startSec: 60.1, endSec: 62.2 }]);
  assert.deepEqual(findQuoteInSegments(SEGMENTS, 'Opus 5.5 умеет'), [{ startSec: 0.2, endSec: 1.4 }]);
});

test('missing quote returns no matches, too short quote is rejected', () => {
  assert.deepEqual(findQuoteInSegments(SEGMENTS, 'напишите слово промпт'), []);
  assert.throws(() => findQuoteInSegments(SEGMENTS, 'гайд'), /не меньше трёх слов/);
});

test('broken words.json is rejected', () => {
  assert.throws(() => findQuoteInSegments([{ words: [{ w: 'x' }] }], 'a b c'), /words\.json/);
  assert.throws(() => findQuoteInSegments({}, 'a b c'), /words\.json/);
});

test('code word is normalized and validated', () => {
  assert.equal(normalizeCodeWord('  гайд '), 'ГАЙД');
  assert.equal(normalizeCodeWord('ai  агент'), 'AI АГЕНТ');
  assert.throws(() => normalizeCodeWord('<script>'), /кодовое слово/);
  assert.throws(() => normalizeCodeWord(''), /кодовое слово/);
});
