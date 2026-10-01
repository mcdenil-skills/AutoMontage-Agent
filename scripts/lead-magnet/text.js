// Сравнение цитаты с речью: регистр, «ё/е», пунктуация и пробелы не важны,
// порядок и состав слов – важны.
function normalizeText(value) {
  return String(value)
    .normalize('NFC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function tokenize(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.split(' ') : [];
}

function invalidTranscript() {
  return new Error('transcript: неверный формат words.json');
}

// words.json: [{ start, end, text, words: [{ w, s, e }] }]. Whisper дробит «5.5» на « 5» и «.5»,
// поэтому одно слово Whisper даёт 0..n токенов с таймкодом этого слова.
function flattenWords(segments) {
  if (!Array.isArray(segments)) throw invalidTranscript();
  const tokens = [];
  for (const segment of segments) {
    if (!segment || !Array.isArray(segment.words)) throw invalidTranscript();
    for (const word of segment.words) {
      if (!word || typeof word.w !== 'string' || !Number.isFinite(word.s) || !Number.isFinite(word.e)) {
        throw invalidTranscript();
      }
      for (const token of tokenize(word.w)) tokens.push({ token, s: word.s, e: word.e });
    }
  }
  return tokens;
}

function findQuoteInSegments(segments, quote) {
  const needle = tokenize(quote);
  if (needle.length < 3) throw new Error('цитата обещания слишком короткая: нужно не меньше трёх слов');
  const tokens = flattenWords(segments);
  const matches = [];
  for (let start = 0; start + needle.length <= tokens.length; start += 1) {
    let same = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (tokens[start + offset].token !== needle[offset]) { same = false; break; }
    }
    if (same) matches.push({ startSec: tokens[start].s, endSec: tokens[start + needle.length - 1].e });
  }
  return matches;
}

module.exports = { findQuoteInSegments, normalizeText, tokenize };
