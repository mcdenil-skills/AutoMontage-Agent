const { frameRateFromFps, frameToSeconds } = require('../review/media-time');

// Окно 10 мс видит паузу между словами и не размазывает её соседними словами.
const LEVEL_FRAME_SEC = 0.01;
const SILENCE_FLOOR_DB = -120;
// Граница двигается только в паузу не дальше этого расстояния от точки, выбранной агентом.
const PAUSE_SEARCH_SEC = 0.25;
// Сколько тишины оставить у края куска: конец чуть после последнего слова, начало чуть до первого.
const PAUSE_LEAD_SEC = 0.1;
// Паузу собираем с запасом за окном поиска, чтобы видеть её настоящие края.
const RUN_CONTEXT_SEC = 1;

function levelsFromPcm(buffer, { sampleRate = 16000, frameSec = LEVEL_FRAME_SEC } = {}) {
  const samplesPerFrame = Math.round(sampleRate * frameSec);
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
  return { frameSec, levels };
}

function percentile(sorted, fraction) {
  if (!sorted.length) return SILENCE_FLOOR_DB;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * (sorted.length - 1))));
  return sorted[index];
}

// Тишина: на 35 дБ тише обычной речи дубля или не громче 15 дБ над его шумом, но никогда не
// громче -30 dBFS. Так порог подходит и студийной записи (шум около -90), и телефону (около -50).
function pauseThresholdDb(levels) {
  const sorted = [...levels].sort((left, right) => left - right);
  const noise = percentile(sorted, 0.1);
  const speech = percentile(sorted, 0.9);
  return Math.min(-30, Math.max(noise + 15, speech - 35));
}

function analyzeLevels({ frameSec, levels }) {
  return { frameSec, levels, thresholdDb: pauseThresholdDb(levels) };
}

function silentRuns({ levels, frameSec, thresholdDb }, fromSec, toSec) {
  const first = Math.max(0, Math.floor(fromSec / frameSec));
  const last = Math.min(levels.length - 1, Math.ceil(toSec / frameSec));
  const runs = [];
  let runStart = null;
  for (let index = first; index <= last + 1; index += 1) {
    const silent = index <= last && levels[index] < thresholdDb;
    if (silent && runStart === null) runStart = index;
    if (!silent && runStart !== null) {
      runs.push({ start: runStart * frameSec, end: index * frameSec });
      runStart = null;
    }
  }
  return runs;
}

function isSilentSpan(analysis, start, end) {
  const first = Math.max(0, Math.floor(start / analysis.frameSec + 1e-9));
  const last = Math.max(first, Math.ceil(end / analysis.frameSec - 1e-9) - 1);
  for (let index = first; index <= last && index < analysis.levels.length; index += 1) {
    if (analysis.levels[index] >= analysis.thresholdDb) return false;
  }
  return true;
}

// Whisper растягивает конец слова в паузу и начинает слово раньше паузы. Поэтому конец куска
// сначала ищет паузу до себя, начало – после себя; если там паузы нет, берётся другая сторона.
// Точка ставится на границу видеокадра внутри паузы, чтобы кадровое округление её не сдвинуло.
function findPauseCut(analysis, time, edge, {
  fps,
  searchSec = PAUSE_SEARCH_SEC,
  leadSec = PAUSE_LEAD_SEC,
} = {}) {
  const rate = frameRateFromFps(fps);
  const frameRate = rate.numerator / rate.denominator;
  const minPause = Math.max(0.03, 1 / frameRate);
  const rank = (run) => {
    if (run.distance === 0) return 0;
    const preferred = edge === 'end' ? run.end <= time : run.start >= time;
    return preferred ? 1 : 2;
  };
  const [run] = silentRuns(analysis, time - searchSec - RUN_CONTEXT_SEC, time + searchSec + RUN_CONTEXT_SEC)
    .filter((candidate) => candidate.end - candidate.start >= minPause - 1e-9)
    .map((candidate) => ({
      ...candidate,
      distance: time < candidate.start ? candidate.start - time : Math.max(0, time - candidate.end),
    }))
    .filter((candidate) => candidate.distance <= searchSec + 1e-9)
    .sort((left, right) => rank(left) - rank(right) || left.distance - right.distance);
  if (!run) return null;
  const margin = Math.min(leadSec, (run.end - run.start) / 2);
  const target = run.distance === 0 ? time : (edge === 'end' ? run.start + margin : run.end - margin);
  const firstFrame = Math.ceil(run.start * frameRate - 1e-6);
  const lastFrame = Math.floor(run.end * frameRate + 1e-6);
  if (firstFrame > lastFrame) return null;
  return frameToSeconds(Math.min(lastFrame, Math.max(firstFrame, Math.round(target * frameRate))), rate);
}

function keptEdges(range, index) {
  return [
    { index, edge: 'start', from: range.start, to: range.start, reason: 'kept' },
    { index, edge: 'end', from: range.end, to: range.end, reason: 'kept' },
  ];
}

function snapRangesToPauses(ranges, { takes, analyses, fps }) {
  const frameDuration = 1 / fps;
  const adjustments = [];
  const snapped = ranges.map((range, index) => {
    const analysis = analyses.get(range.take);
    if (!analysis) return { ...range };
    const take = takes.get(range.take);
    const edges = {};
    const notes = [];
    for (const edge of ['start', 'end']) {
      const from = range[edge];
      const to = findPauseCut(analysis, from, edge, { fps });
      // Край файла – естественная граница, без паузы рядом он не считается ошибкой.
      const atFileEdge = edge === 'start'
        ? from <= (take.usableStart || 0) + frameDuration
        : from >= take.duration - frameDuration;
      if (to === null) {
        edges[edge] = from;
        if (!atFileEdge) notes.push({ index, edge, from, to: from, reason: 'no-pause' });
      } else {
        edges[edge] = to;
        if (Math.abs(to - from) > 1e-9) notes.push({ index, edge, from, to, reason: 'pause' });
      }
    }
    if (edges.end - edges.start < frameDuration) {
      adjustments.push(...keptEdges(range, index));
      return { ...range };
    }
    adjustments.push(...notes);
    return { ...range, start: edges.start, end: edges.end };
  });
  // Сдвиг в паузу не должен создать пересечение кусков одного дубля, которого не было у агента:
  // тогда оба куска возвращаются к исходным границам.
  const overlaps = (left, right) => left.take === right.take
    && left.start < right.end && right.start < left.end;
  const kept = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < snapped.length; index += 1) {
      for (let other = 0; other < index; other += 1) {
        if (!overlaps(snapped[index], snapped[other]) || overlaps(ranges[index], ranges[other])) continue;
        for (const revert of [index, other]) {
          snapped[revert] = { ...ranges[revert] };
          kept.add(revert);
        }
        changed = true;
      }
    }
  }
  const final = adjustments.filter((item) => !kept.has(item.index));
  for (const index of kept) final.push(...keptEdges(ranges[index], index));
  final.sort((left, right) => left.index - right.index || (left.edge === 'start' ? -1 : 1));
  return { ranges: snapped, adjustments: final };
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
