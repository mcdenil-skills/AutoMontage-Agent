'use strict';

// Work on provider character entries, not JS UTF-16 offsets (Cyrillic/emoji/marks).
function charactersToWords(alignment) {
  const invalid = () => new Error('ElevenLabs alignment is invalid');
  const { characters, character_start_times_seconds: starts,
    character_end_times_seconds: ends } = alignment || {};
  if (!Array.isArray(characters) || !Array.isArray(starts) || !Array.isArray(ends)
    || characters.length !== starts.length || characters.length !== ends.length) throw invalid();
  const words = [];
  let word = null; let previousEnd = 0;
  const flush = () => {
    if (!word) return;
    if (word.e <= word.s) throw invalid();
    words.push(word); word = null;
  };
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]; const start = starts[index]; const end = ends[index];
    if (typeof character !== 'string' || !character || /\S\s|\s\S/u.test(character)
      || !Number.isFinite(start) || !Number.isFinite(end) || start < previousEnd || end < start) throw invalid();
    previousEnd = end;
    if (/^\s+$/u.test(character)) { flush(); continue; }
    if (!word) word = { w: '', s: start, e: end };
    word.w += character;
    word.e = end;
  }
  flush();
  return words;
}
module.exports = { charactersToWords };
