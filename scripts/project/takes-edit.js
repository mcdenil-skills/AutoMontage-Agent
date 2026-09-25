const Ajv = require('ajv');

const takesEditSchema = require('../../schema/takes-edit.schema.json');
const { frameRateFromFps, frameToSeconds, secondsToFrame } = require('../review/media-time');
const { remapTranscriptWords, roundedTime } = require('./source-revision');

const validateSchema = new Ajv({ allErrors: true }).compile(takesEditSchema);
// Запас после последнего слова, который агент добавляет по брифу; хвост обрезается по концу дубля.
const MAX_END_OVERRUN_SEC = 0.25;

function formatSchemaError(error) {
  const suffix = error.keyword === 'required' ? `.${error.params.missingProperty}` : '';
  return `takes edit${error.instancePath || ''}${suffix}: ${error.message}`;
}

function isTakesEdit(edit) {
  return Boolean(edit && typeof edit === 'object' && edit.kind === 'takes');
}

function assertTakesEditShape(edit, { sourceRevision } = {}) {
  if (!validateSchema(edit)) {
    throw new Error((validateSchema.errors || []).map(formatSchemaError).join('\n'));
  }
  if (!Number.isSafeInteger(sourceRevision) || edit.sourceRevision !== sourceRevision) {
    throw new Error('takes edit revision does not match the active source revision');
  }
  return structuredClone(edit);
}

function validateTakeRanges(ranges, takes) {
  ranges.forEach((range, index) => {
    const take = takes.get(range.take);
    if (!take) throw new Error(`ranges[${index}] references unknown take ${range.take}`);
    if (range.end <= range.start) throw new Error(`ranges[${index}] must have end > start`);
    if (range.start >= take.duration || range.end > take.duration + MAX_END_OVERRUN_SEC) {
      throw new Error(`ranges[${index}] is outside ${range.take} usable duration ${take.duration}`);
    }
  });
}

// secondsToFrame(seconds, rate, mode) применяет floor/ceil к сырому произведению seconds*rate,
// а плавающая точка иногда даёт 0.28*25 = 7.000000000000001 вместо 7 - ceil тогда лишний раз
// толкает границу на кадр вперёд. Если секунды и так лежат ровно на кадре, берём этот кадр,
// а floor/ceil применяем только к настоящим нецелым значениям.
function snapFrame(seconds, rate, mode) {
  const nearest = secondsToFrame(seconds, rate, 'round');
  if (Math.abs(frameToSeconds(nearest, rate) - seconds) <= 1e-9) return nearest;
  return secondsToFrame(seconds, rate, mode);
}

// Кусок из нецелого числа кадров удлиняет видео до следующего кадра, а звук остаётся точным.
// Поэтому начало округляется вниз, конец вверх, и оба ограничены последним целым кадром дубля.
function snapTakeRanges(ranges, { fps, takes }) {
  const rate = frameRateFromFps(fps);
  const snapped = ranges.map((range, index) => {
    const take = takes.get(range.take);
    const lastFrame = snapFrame(take.duration, rate, 'floor');
    const startFrame = snapFrame(range.start, rate, 'floor');
    const endFrame = Math.min(snapFrame(range.end, rate, 'ceil'), lastFrame);
    if (endFrame <= startFrame) {
      throw new Error(`ranges[${index}] is shorter than one frame after snapping`);
    }
    return {
      ...range,
      startFrame,
      endFrame,
      start: frameToSeconds(startFrame, rate),
      end: frameToSeconds(endFrame, rate),
    };
  });
  const byTake = new Map();
  snapped.forEach((range, index) => {
    const previous = byTake.get(range.take) || [];
    const raw = ranges[index];
    for (const other of previous) {
      const otherRaw = ranges[other.index];
      const rawOverlap = raw.start < otherRaw.end && otherRaw.start < raw.end;
      if (rawOverlap) {
        throw new Error(`ranges[${index}] overlaps ranges[${other.index}] in ${range.take}`);
      }
      // Начало округляется вниз, конец вверх, поэтому соседние куски одного дубля могут
      // делить кадр; кадр остаётся первому куску.
      if (range.startFrame < other.range.endFrame && other.range.startFrame < range.endFrame) {
        if (raw.start >= otherRaw.end) {
          range.startFrame = other.range.endFrame;
        } else {
          range.endFrame = other.range.startFrame;
        }
        if (range.endFrame <= range.startFrame) {
          throw new Error(`ranges[${index}] is shorter than one frame after snapping`);
        }
        range.start = frameToSeconds(range.startFrame, rate);
        range.end = frameToSeconds(range.endFrame, rate);
      }
    }
    previous.push({ range, index });
    byTake.set(range.take, previous);
  });
  return snapped;
}

// Начало снапается вниз и конец вверх, поэтому в кусок может попасть лишь доля кадра соседнего
// (часто отбракованного) слова; такую крошку не тащим в субтитры отдельным словом.
function dropClippedSlivers(words, range, fps) {
  if (!Array.isArray(words)) return words;
  const minFrameSec = 1 / fps;
  return words.filter((word) => {
    const clipped = word.s < range.start || word.e > range.end;
    if (!clipped) return true;
    const inside = Math.min(word.e, range.end) - Math.max(word.s, range.start);
    return inside >= minFrameSec;
  });
}

function remapTakeRangesTranscript(ranges, wordsByTake, fps) {
  const words = [];
  let offset = 0;
  for (const range of ranges) {
    const takeWords = dropClippedSlivers(wordsByTake.get(range.take), range, fps);
    const local = remapTranscriptWords(takeWords, [range], fps);
    for (const word of local) {
      const s = roundedTime(word.s + offset, fps);
      const e = roundedTime(word.e + offset, fps);
      // Слово, которое лишь на доли миллисекунды заходит за границу снапнутого куска,
      // после округления получает e <= s: такое слово ломает потребителей transcript'а
      // (collectWords в tighten/cut-pauses/source master), поэтому его отбрасываем.
      if (e <= s) continue;
      words.push({ ...word, s, e });
    }
    offset += range.end - range.start;
  }
  return words;
}

function takesTrimPlan(ranges, takes) {
  const inputs = [];
  // На дубль запоминаем текущий индекс входа и конец последнего куска, размещённого на нём.
  const activeInputByTake = new Map();
  const segments = ranges.map((range) => {
    const active = activeInputByTake.get(range.take);
    // Декодер одного -i общий для всех кусков этого входа. Если кусок начинается раньше конца
    // предыдущего куска того же дубля на этом входе, FFmpeg должен сначала декодировать более
    // позднее окно и держать в памяти уже декодированные кадры раннего окна до конкатенации -
    // это и даёт рост RSS в разы. Поэтому такой кусок открывает дублю новый вход, а не переиспользует старый.
    const reuse = active && range.start >= active.lastEnd;
    const inputIndex = reuse ? active.input : inputs.length;
    if (!reuse) inputs.push(takes.get(range.take).filePath);
    activeInputByTake.set(range.take, { input: inputIndex, lastEnd: range.end });
    return { input: inputIndex, start: range.start, end: range.end };
  });
  return { inputs, segments };
}

module.exports = {
  assertTakesEditShape,
  isTakesEdit,
  remapTakeRangesTranscript,
  snapTakeRanges,
  takesTrimPlan,
  validateTakeRanges,
};
