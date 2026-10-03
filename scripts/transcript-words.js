const fs = require('node:fs');

// transcribe.py округляет время слов до 0.01 с, и faster-whisper отдаёт слова нулевой длины.
// Слово не теряем: даём ему 0.01 с. Растянутое слово может на 10 мс наехать на следующее –
// это безвредно для потребителей (текст и субтитры не завязаны на точный стык слов).
function normalizeWordTimings(segments) {
  if (!Array.isArray(segments)) return segments;
  return segments.map((segment) => {
    if (!segment || typeof segment !== 'object') return segment;
    if (!Array.isArray(segment.words)) return { ...segment };
    return {
      ...segment,
      words: segment.words.map((word) => {
        if (!word || typeof word !== 'object') return word;
        const start = word.s;
        const end = word.e;
        if (Number.isFinite(start) && start >= 0 && end === start) {
          return { ...word, e: Math.round((start + 0.01) * 100) / 100 };
        }
        return { ...word };
      }),
    };
  });
}

// Только для только что созданного транскрипта. Исторические файлы master не меняет.
function normalizeTranscriptFile(filePath, { fileSystem = fs } = {}) {
  const segments = normalizeWordTimings(JSON.parse(fileSystem.readFileSync(filePath, 'utf8')));
  fileSystem.writeFileSync(filePath, `${JSON.stringify(segments, null, 2)}\n`);
  return segments;
}

module.exports = { normalizeWordTimings, normalizeTranscriptFile };
