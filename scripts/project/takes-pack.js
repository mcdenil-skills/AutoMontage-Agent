const fs = require('node:fs');
const path = require('node:path');

const { finiteNumber } = require('../build-options');
const { collectWords } = require('../tighten');
const { readProjectManifest, resolveProjectPath } = require('./workspace');

const SILENCE_EPSILON = 1e-9;
// Whisper прячет паузы внутрь слов, поэтому фразы режутся ещё и по концу предложения.
const SENTENCE_END = /[.!?…]["»)]*$/;

function packTime(seconds) {
  return seconds.toFixed(2).padStart(6, '0');
}

function groupIntoPhrases(words, silence = 0.5) {
  const ordered = [...words].sort((left, right) => left.s - right.s || left.e - right.e);
  const phrases = [];
  let current = null;
  for (const word of ordered) {
    if (current && (current.sentenceEnded || word.s - current.end >= silence - SILENCE_EPSILON)) {
      phrases.push(current);
      current = null;
    }
    if (!current) current = { start: word.s, end: word.e, parts: [] };
    current.parts.push(word.w);
    current.end = Math.max(current.end, word.e);
    current.sentenceEnded = SENTENCE_END.test(word.w);
  }
  if (current) phrases.push(current);
  return phrases.map(({ start, end, parts }) => ({
    start,
    end,
    text: parts.join(' ')
      .replace(/\s+([,.!?;:])/g, '$1')
      .replace(/(?<=[\p{L}\d])\s+-(?=[\p{L}\d])/gu, '-'),
  }));
}

function formatTakesMarkdown(entries, silence = 0.5) {
  const lines = [
    '# Дубли проекта',
    '',
    `Фразы разделены концом предложения или паузой от ${silence} с. Время указано в секундах от начала файла дубля.`,
    'Master сам сдвигает границы кусков в ближайшую паузу в звуке (ищет её не дальше 0.25 с от границы).',
    'Диапазоны для edit/vNN-takes.json записывай как take + start/end из этих строк.',
    '',
  ];
  for (const { id, phrases } of entries) {
    const speech = phrases.length ? phrases.at(-1).end - phrases[0].start : 0;
    lines.push(`## ${id}  (речь ${speech.toFixed(1)} с, фраз: ${phrases.length})`);
    for (const phrase of phrases) {
      lines.push(`  [${packTime(phrase.start)}-${packTime(phrase.end)}] ${phrase.text}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function packTakes({ projectDir, silence = 0.5 }, { fileSystem = fs } = {}) {
  if (!projectDir) throw new Error('takes pack requires --project-dir');
  const threshold = finiteNumber(silence, 'silence', { min: 0.1, max: 5 });
  const dir = path.resolve(projectDir);
  const manifest = readProjectManifest(dir);
  const takes = manifest.takes || [];
  if (!takes.length) throw new Error('project has no registered takes; run automontage takes add first');
  const entries = takes.map((take) => {
    const transcriptPath = resolveProjectPath(dir, take.transcriptPath, {
      label: `${take.id} transcript path`, fileSystem, mustExist: true, type: 'file',
    });
    let words;
    try {
      words = collectWords(JSON.parse(fileSystem.readFileSync(transcriptPath, 'utf8')));
    } catch (error) {
      // Без имени дубля непонятно, какой из нескольких кусков сломал расшифровку.
      error.message = `${take.id}: ${error.message}`;
      throw error;
    }
    return { id: take.id, phrases: groupIntoPhrases(words, threshold) };
  });
  return formatTakesMarkdown(entries, threshold);
}

module.exports = {
  formatTakesMarkdown,
  groupIntoPhrases,
  packTakes,
};
