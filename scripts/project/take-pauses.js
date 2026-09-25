const { frameRateFromFps, frameToSeconds } = require('../review/media-time');

// Окно 10 мс видит паузу между словами и не размазывает её соседними словами.
const LEVEL_FRAME_SEC = 0.01;
const SILENCE_FLOOR_DB = -120;
// Паузу ищем не дальше этого расстояния от границы, выбранной агентом.
const PAUSE_SEARCH_SEC = 0.25;
// Сколько тишины оставить у края куска, когда граница уходит в паузу рядом.
const PAUSE_LEAD_SEC = 0.1;
// Провал короче 50 мс чаще смычка согласного внутри слова, чем пауза между словами.
const MIN_PAUSE_SEC = 0.05;
// Разрез не ставим ближе к речи: иначе 40-мс затухание звука на краю куска ляжет на слово.
const MIN_MARGIN_SEC = 0.04;
// Пауза на неожиданной стороне границы выигрывает, только если она ближе на столько.
const SIDE_BIAS_SEC = 0.1;

function levelsFromPcm(buffer, { sampleRate = 16000, frameSec = LEVEL_FRAME_SEC } = {}) {
  const samplesPerFrame = Math.max(1, Math.round(sampleRate * frameSec));
  const frameCount = Math.floor(Math.floor(buffer.length / 2) / samplesPerFrame);
  const levels = new Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    const first = frame * samplesPerFrame;
    for (let index = 0; index < samplesPerFrame; index += 1) {
      const sample = buffer.readInt16LE((first + index) * 2) / 32768;
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / samplesPerFrame);
    levels[frame] = rms > 0 ? Math.max(SILENCE_FLOOR_DB, 20 * Math.log10(rms)) : SILENCE_FLOOR_DB;
  }
  return { frameSec: samplesPerFrame / sampleRate, levels };
}

function percentile(sorted, fraction) {
  if (!sorted.length) return SILENCE_FLOOR_DB;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * (sorted.length - 1))));
  return sorted[index];
}

// Тишина: не громче 15 дБ над шумом дубля (10-й процентиль) или на 35 дБ тише его речи
// (90-й процентиль), но всегда хотя бы на 20 дБ тише речи и не громче -30 dBFS. Ограничение
// от речи не даёт порогу подняться в речь на дубле почти без пауз.
function pauseThresholdDb(levels) {
  const sorted = [...levels].sort((left, right) => left - right);
  const noise = percentile(sorted, 0.1);
  const speech = percentile(sorted, 0.9);
  return Math.min(-30, speech - 20, Math.max(noise + 15, speech - 35));
}

function analyzeLevels({ frameSec, levels }) {
  return { frameSec, levels, thresholdDb: pauseThresholdDb(levels) };
}

// Паузу расширяем до её настоящих краёв, даже если она выходит за окно поиска.
function silentRuns({ levels, frameSec, thresholdDb }, fromSec, toSec) {
  const silent = (index) => index >= 0 && index < levels.length && levels[index] < thresholdDb;
  const first = Math.max(0, Math.floor(fromSec / frameSec));
  const last = Math.min(levels.length - 1, Math.ceil(toSec / frameSec));
  const runs = [];
  let index = first;
  while (index <= last) {
    if (!silent(index)) {
      index += 1;
      continue;
    }
    let start = index;
    while (silent(start - 1)) start -= 1;
    let end = index;
    while (silent(end + 1)) end += 1;
    runs.push({ start: start * frameSec, end: (end + 1) * frameSec });
    index = end + 1;
  }
  return runs;
}

// Звук вне уровней неизвестен и тишиной не считается.
function isSilentSpan(analysis, start, end) {
  const first = Math.max(0, Math.floor(start / analysis.frameSec + 1e-9));
  const last = Math.max(first, Math.ceil(end / analysis.frameSec - 1e-9) - 1);
  if (last >= analysis.levels.length) return false;
  for (let index = first; index <= last; index += 1) {
    if (analysis.levels[index] >= analysis.thresholdDb) return false;
  }
  return true;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

// Whisper растягивает конец слова в паузу и начинает слово раньше паузы. Поэтому конец куска
// предпочитает паузу до себя, начало – после себя; пауза с другой стороны выигрывает, только если
// она ближе на SIDE_BIAS_SEC. Общий разрез двух соседних кусков одного дубля ('joint') берёт
// ближайшую паузу и встаёт в её середину. Точка ставится на границу видеокадра внутри паузы.
function findPauseCut(analysis, time, edge, {
  fps,
  searchSec = PAUSE_SEARCH_SEC,
  leadSec = PAUSE_LEAD_SEC,
} = {}) {
  const audioEnd = analysis.levels.length * analysis.frameSec;
  if (!(time >= 0 && time <= audioEnd)) return null;
  const rate = frameRateFromFps(fps);
  const frameRate = rate.numerator / rate.denominator;
  const minPause = Math.max(MIN_PAUSE_SEC, 1 / frameRate);
  const score = (run) => {
    if (run.distance === 0 || edge === 'joint') return run.distance;
    const preferred = edge === 'end' ? run.end <= time : run.start >= time;
    return run.distance + (preferred ? 0 : SIDE_BIAS_SEC);
  };
  const [run] = silentRuns(analysis, time - searchSec, time + searchSec)
    .filter((candidate) => candidate.end - candidate.start >= minPause - 1e-9)
    .map((candidate) => ({
      ...candidate,
      distance: time < candidate.start ? candidate.start - time : Math.max(0, time - candidate.end),
    }))
    .filter((candidate) => candidate.distance <= searchSec + 1e-9)
    .sort((left, right) => score(left) - score(right) || left.distance - right.distance);
  if (!run) return null;
  const length = run.end - run.start;
  const margin = Math.min(MIN_MARGIN_SEC, length / 2);
  let target;
  if (run.distance === 0) target = time;
  else if (edge === 'joint') target = (run.start + run.end) / 2;
  else {
    const lead = Math.min(leadSec, length / 2);
    target = edge === 'end' ? run.start + lead : run.end - lead;
  }
  const innerFirst = Math.ceil((run.start + margin) * frameRate - 1e-6);
  const innerLast = Math.floor((run.end - margin) * frameRate + 1e-6);
  const first = innerFirst <= innerLast ? innerFirst : Math.ceil(run.start * frameRate - 1e-6);
  const last = innerFirst <= innerLast ? innerLast : Math.floor(run.end * frameRate + 1e-6);
  if (first > last) return null;
  return frameToSeconds(clamp(Math.round(target * frameRate), first, last), rate);
}

function assertNoRawOverlap(ranges) {
  ranges.forEach((range, index) => {
    for (let other = 0; other < index; other += 1) {
      const previous = ranges[other];
      if (previous.take === range.take && range.start < previous.end && previous.start < range.end) {
        throw new Error(`ranges[${index}] overlaps ranges[${other}] in ${range.take}`);
      }
    }
  });
}

// Пересечение, которое сделал агент, остаётся ошибкой, а не превращается в потерю речи.
// Конец одного куска и начало другого куска того же дубля в одной точке – один разрез.
// Если сдвиг схлопывает кусок или создаёт новое пересечение, кусок и его соседи по стыку
// возвращаются к исходным границам.
function snapRangesToPauses(ranges, { takes, analyses, fps }) {
  assertNoRawOverlap(ranges);
  const frameDuration = 1 / fps;
  const partners = ranges.map(() => []);
  ranges.forEach((range, index) => ranges.forEach((other, otherIndex) => {
    if (index !== otherIndex && range.take === other.take && Math.abs(range.end - other.start) <= 1e-9) {
      partners[index].push(otherIndex);
      partners[otherIndex].push(index);
    }
  }));
  const isJoint = (index, edge) => ranges.some((other, otherIndex) => otherIndex !== index
    && other.take === ranges[index].take
    && Math.abs((edge === 'end' ? other.start : other.end) - ranges[index][edge]) <= 1e-9);
  const notes = [];
  const snapped = ranges.map((range, index) => {
    const analysis = analyses.get(range.take);
    if (!analysis) return { ...range };
    const take = takes.get(range.take);
    const next = { ...range };
    for (const edge of ['start', 'end']) {
      const from = range[edge];
      const atFileEdge = edge === 'start'
        ? from <= (take.usableStart || 0) + frameDuration
        : from >= take.duration - frameDuration;
      if (atFileEdge) continue;
      const to = findPauseCut(analysis, from, isJoint(index, edge) ? 'joint' : edge, { fps });
      if (to === null) {
        notes.push({ index, edge, from, to: from, reason: 'no-pause' });
      } else {
        next[edge] = to;
        if (Math.abs(to - from) > 1e-9) notes.push({ index, edge, from, to, reason: 'pause' });
      }
    }
    return next;
  });
  const kept = new Set();
  const revert = (index) => {
    if (kept.has(index)) return;
    kept.add(index);
    snapped[index] = { ...ranges[index] };
    for (const partner of partners[index]) revert(partner);
  };
  snapped.forEach((range, index) => {
    if (range.end - range.start < frameDuration) revert(index);
  });
  const overlaps = (left, right) => left.take === right.take
    && left.start < right.end && right.start < left.end;
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < snapped.length; index += 1) {
      for (let other = 0; other < index; other += 1) {
        if (!overlaps(snapped[index], snapped[other])) continue;
        const before = kept.size;
        revert(index);
        revert(other);
        if (kept.size !== before) changed = true;
      }
    }
  }
  const adjustments = notes.filter((item) => !kept.has(item.index));
  for (const index of kept) {
    adjustments.push(
      { index, edge: 'start', from: ranges[index].start, to: ranges[index].start, reason: 'kept' },
      { index, edge: 'end', from: ranges[index].end, to: ranges[index].end, reason: 'kept' },
    );
  }
  adjustments.sort((left, right) => left.index - right.index || (left.edge === 'start' ? -1 : 1));
  return { ranges: snapped, adjustments };
}

module.exports = {
  PAUSE_LEAD_SEC,
  PAUSE_SEARCH_SEC,
  analyzeLevels,
  findPauseCut,
  isSilentSpan,
  levelsFromPcm,
  pauseThresholdDb,
  snapRangesToPauses,
};
