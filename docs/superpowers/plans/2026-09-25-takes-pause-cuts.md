# Takes Pause Cuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `automontage master` для дублей сам сдвигает каждую границу куска в ближайшую паузу в звуке, не переносит в транскрипт слова-галлюцинации Whisper в тишине на краях кусков, а навык `reel-turnkey` умеет собирать тем же маршрутом один ролик из разных записей по сценарию.

**Architecture:** новый модуль `scripts/project/take-pauses.js` читает уровень звука дубля окнами по 10 мс на той же оси, что и `trim`, и сдвигает границы в паузы до кадрового выравнивания. `takes-edit.js` помнит запрошенный диапазон и отбрасывает слова вне его и слова в тишине на краях куска. `build-takes-master.js` связывает это и возвращает итоговые куски, время стыков и решения по каждой границе; `build-master.js` печатает их.

**Tech Stack:** Node.js 20 CommonJS, Node test runner, FFmpeg 6.x-9.x (PCM `s16le` через `aresample=async=1:min_hard_comp=0:first_pts=0`).

**Основание:** живая проба ветки `feat/multi-take-master` на прошлых записях (проекты `projects/2026.09.25_takes-probe-tsennaya` и `projects/2026.09.25_takes-probe-mix`).

---

## Факты, на которых построен план

Проверено прототипом 2026-09-25 на FFmpeg 9.0.1 и 7.1.5.

- **P1. Границы по Whisper режут слова.** На пробе 3 из 8 краёв кусков попали внутрь слова (обрывок 60-100 мс): Whisper растягивает конец слова в паузу («эксперта?» до 3.54 при тишине с 3.46) и начинает слово раньше паузы («И» длиной 0.58 с). Повторная расшифровка master 2 из 3 обрывков не заметила.
- **P2. Паузы видны по уровню.** Окна по 10 мс: тишина между словами на записях -65…-95 dBFS, обрывки слов около -27 dBFS. Порог `min(-30, речь - 20, max(шум + 15, речь - 35))`, где шум = 10-й и речь = 90-й процентиль уровней дубля, дал -49…-50 dB на реальных дублях (короткие паузы -53…-65, согласные на хвостах слов -41…-48). Ограничение `речь - 20` держит порог ниже речи на дубле почти без пауз; шум по 2-му процентилю отвергнут: он дал -60 и потерял короткие паузы.
- **P3. Прототип нашёл те же точки, что человек вручную.** 3.57 → 3.52 (пауза 3.46-3.54, агент выбрал 3.48), 5.35 → 5.28 (пауза 5.23-5.31), 68.66 → 69.08 (пауза 68.75-69.16). Чтение уровней: 0.23-0.31 с на 80-секундный дубль.
- **P4. Направление поиска.** Конец куска предпочитает паузу до себя, начало – после себя (так Whisper растягивает слова); пауза с другой стороны выигрывает, только если она ближе на 0.1 с. Пауза короче 50 мс не считается (смычка согласного). Разрез не ближе 40 мс к речи. Все три дефекта пробы лежат в предпочтительной стороне.
- **P7. Ревизия после ревью Task 1.** Независимый сдвиг конца и начала соседних кусков одного дубля терял слово между двумя паузами – такой стык теперь один общий разрез в середине ближайшей паузы. Пересечение кусков агента остаётся ошибкой. Края файла не двигаются. Длинная пауза видна до настоящих краёв.
- **P5. Галлюцинация в хвосте.** Whisper «услышал» «Продолжение» (слово нулевой длины, нормализованное до 0.01 с) в тишине в конце дубля; после кадрового округления конца оно попадало внутрь куска и в транскрипт.
- **P6. Разные записи.** `takes add` и `master` без изменений склеивают куски разных записей одного формата; на стыке виден скачок положения головы, нужна смена сцены.

## Глобальные ограничения

- Формат `edit/vNN-takes.json` и `edit/vNN-source.json` не меняется; обычный source-edit master не меняется.
- Никаких provider API. Никакого длинного тире U+2014 и абсолютных личных путей в публичных файлах.
- Коммиты в ветке `feat/multi-take-master`; push и PR только по просьбе владельца; pre-commit hook не обходить.
- Полный набор: `PATH="/opt/homebrew/opt/ffmpeg-full/bin:$PATH" npm test`.

## Карта файлов

- Create: `scripts/project/take-pauses.js` – уровни звука, порог паузы, поиск паузы, сдвиг границ, проверка тишины слова.
- Create: `tests/take-pauses.test.js`.
- Modify: `scripts/project/takes-edit.js` – `requestedStart/requestedEnd`, отбор слов по запрошенному диапазону, обрезка слов в тишине на краях.
- Modify: `scripts/project/build-takes-master.js`, `scripts/project/build-master.js` – связка и вывод.
- Modify: `scripts/project/takes-pack.js` – строка заголовка сводки.
- Modify tests: `tests/takes-edit.test.js`, `tests/takes-master.test.js`, `tests/takes-master-media.test.js`, `tests/takes-pack.test.js`.
- Modify docs: `skills/reel-turnkey/references/takes-selection.md`, `skills/reel-turnkey/SKILL.md`, `skills/reel-turnkey/evals/evals.json`, `README.md`, `ARCHITECTURE.md`, `TESTING.md`, `DECISIONS.md`, `CHANGELOG.md`.

---

### Task 1: Модуль `take-pauses.js`: уровни, порог и поиск паузы

**Files:**
- Create: `scripts/project/take-pauses.js`
- Create: `tests/take-pauses.test.js`

- [ ] **Step 1: Написать падающие тесты `tests/take-pauses.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeLevels,
  findPauseCut,
  isSilentSpan,
  levelsFromPcm,
  pauseThresholdDb,
  snapRangesToPauses,
} = require('../scripts/project/take-pauses');

// Окна по 10 мс: речь speechDb, тишина silenceDb в интервалах pauses (секунды).
function levelsWithPauses(pauses, { duration = 3, speechDb = -20, silenceDb = -90 } = {}) {
  const levels = [];
  for (let index = 0; index < duration * 100; index += 1) {
    const time = index / 100;
    levels.push(pauses.some(([from, to]) => time >= from && time < to) ? silenceDb : speechDb);
  }
  return { frameSec: 0.01, levels };
}

// Речь на 0-1.0 и 1.3-2.5 с, тишина на 1.0-1.3 и 2.5-3.0 с.
function speechLevels() {
  return levelsWithPauses([[1, 1.3], [2.5, 3]]);
}

function twoTakes() {
  return new Map([
    ['take-01', { id: 'take-01', duration: 3, usableStart: 0 }],
    ['take-02', { id: 'take-02', duration: 3, usableStart: 0 }],
  ]);
}

test('pcm levels are RMS frames in dBFS with a floor for digital silence', () => {
  const buffer = Buffer.alloc(320 * 2);
  for (let index = 160; index < 320; index += 1) buffer.writeInt16LE(16384, index * 2);
  const { frameSec, levels } = levelsFromPcm(buffer, { sampleRate: 16000 });
  assert.equal(frameSec, 0.01);
  assert.equal(levels.length, 2);
  assert.equal(levels[0], -120);
  assert.ok(Math.abs(levels[1] - 20 * Math.log10(0.5)) < 1e-9);
  assert.equal(levelsFromPcm(Buffer.alloc(0), { sampleRate: 22050 }).frameSec, 221 / 22050);
});

test('pause threshold follows the take noise and stays at least 20 dB below speech', () => {
  assert.equal(pauseThresholdDb(speechLevels().levels), -55);
  const phone = speechLevels().levels.map((level) => (level === -90 ? -50 : level));
  assert.equal(pauseThresholdDb(phone), -40);
  assert.equal(pauseThresholdDb(new Array(100).fill(-20)), -40);
  // Почти без пауз 10-й процентиль попадает в речь; ограничение от речи не даёт порогу подняться.
  assert.equal(pauseThresholdDb([...new Array(98).fill(-20), -90, -90]), -40);
  assert.equal(pauseThresholdDb([...new Array(98).fill(-44), -90, -90]), -64);
});

test('a cut inside speech moves to the nearest pause on the video frame grid', () => {
  const analysis = analyzeLevels(speechLevels());
  assert.equal(findPauseCut(analysis, 1.36, 'end', { fps: 25 }), 1.12);
  assert.equal(findPauseCut(analysis, 1.36, 'start', { fps: 25 }), 1.2);
  assert.equal(findPauseCut(analysis, 2.4, 'end', { fps: 25 }), 2.6);
  assert.equal(findPauseCut(analysis, 1.13, 'end', { fps: 25 }), 1.12);
  assert.equal(findPauseCut(analysis, 0.5, 'end', { fps: 25 }), null);
  assert.equal(findPauseCut(analysis, 1.36, 'end', { fps: 30000 / 1001 }), 33 * 1001 / 30000);
  assert.equal(findPauseCut(analysis, 3.2, 'end', { fps: 25 }), null);
});

test('the expected side wins unless the other pause is clearly closer', () => {
  // Конец куска ищет паузу сначала до себя.
  const preferred = analyzeLevels(levelsWithPauses([[0.95, 1.05], [1.17, 1.27]]));
  assert.equal(findPauseCut(preferred, 1.12, 'end', { fps: 25 }), 1);
  // Но пауза сразу после границы бьёт далёкий провал до неё.
  const closer = analyzeLevels(levelsWithPauses([[0.9, 0.98], [1.2, 1.3]]));
  assert.equal(findPauseCut(closer, 1.17, 'end', { fps: 25 }), 1.24);
});

test('dips shorter than 50 ms are not pauses and cuts keep a margin from speech', () => {
  const dip = analyzeLevels(levelsWithPauses([[1.2, 1.24], [2.5, 3]]));
  assert.equal(findPauseCut(dip, 1.3, 'end', { fps: 25 }), null);
  const analysis = analyzeLevels(speechLevels());
  assert.equal(findPauseCut(analysis, 1.01, 'end', { fps: 25 }), 1.04);
  assert.equal(findPauseCut(analysis, 1.29, 'start', { fps: 25 }), 1.24);
});

test('a long pause is seen to its real edges', () => {
  const analysis = analyzeLevels(levelsWithPauses([[1, 4]], { duration: 5 }));
  assert.equal(findPauseCut(analysis, 4.1, 'end', { fps: 25 }), 1.12);
});

test('a span is silent only when every covered level frame is below the threshold', () => {
  const analysis = analyzeLevels(speechLevels());
  assert.equal(isSilentSpan(analysis, 1.05, 1.06), true);
  assert.equal(isSilentSpan(analysis, 2.6, 2.6), true);
  assert.equal(isSilentSpan(analysis, 0.95, 1.05), false);
  assert.equal(isSilentSpan(analysis, 0.2, 0.6), false);
  assert.equal(isSilentSpan(analysis, 5, 5.1), false);
  assert.equal(isSilentSpan(analyzeLevels({ frameSec: 0.01, levels: [] }), 0, 0.1), false);
});

test('ranges move into pauses and report every moved or unmovable edge', () => {
  const analysis = analyzeLevels(speechLevels());
  const result = snapRangesToPauses([
    { take: 'take-01', start: 0, end: 1.36, beat: 'A', reason: 'x' },
    { take: 'take-01', start: 1.36, end: 2.4, beat: 'B', reason: 'y' },
    { take: 'take-02', start: 0.4, end: 0.6, beat: 'C', reason: 'z' },
  ], {
    takes: twoTakes(),
    analyses: new Map([['take-01', analysis], ['take-02', analysis]]),
    fps: 25,
  });
  assert.deepEqual(result.ranges.map(({ start, end }) => [start, end]), [[0, 1.16], [1.16, 2.6], [0.4, 0.6]]);
  assert.equal(result.ranges[0].beat, 'A');
  assert.deepEqual(result.adjustments, [
    { index: 0, edge: 'end', from: 1.36, to: 1.16, reason: 'pause' },
    { index: 1, edge: 'start', from: 1.36, to: 1.16, reason: 'pause' },
    { index: 1, edge: 'end', from: 2.4, to: 2.6, reason: 'pause' },
    { index: 2, edge: 'start', from: 0.4, to: 0.4, reason: 'no-pause' },
    { index: 2, edge: 'end', from: 0.6, to: 0.6, reason: 'no-pause' },
  ]);
});

test('touching pieces of one take share one cut, so no word between pauses is lost', () => {
  const analysis = analyzeLevels(levelsWithPauses([[1, 1.1], [1.3, 1.4]]));
  const result = snapRangesToPauses([
    { take: 'take-01', start: 0.2, end: 1.2, beat: 'A', reason: 'x' },
    { take: 'take-01', start: 1.2, end: 2.9, beat: 'B', reason: 'y' },
  ], { takes: twoTakes(), analyses: new Map([['take-01', analysis]]), fps: 25 });
  assert.deepEqual(result.ranges.map(({ start, end }) => [start, end]), [[0.2, 1.04], [1.04, 2.9]]);
});

test('overlapping agent ranges still fail instead of being hidden by pause cuts', () => {
  const analysis = analyzeLevels(speechLevels());
  assert.throws(() => snapRangesToPauses([
    { take: 'take-01', start: 0, end: 1.4, beat: 'A', reason: 'x' },
    { take: 'take-01', start: 1.3, end: 2.5, beat: 'B', reason: 'y' },
  ], { takes: twoTakes(), analyses: new Map([['take-01', analysis]]), fps: 25 }), /ranges\[1\] overlaps ranges\[0\] in take-01/);
});

test('a range that would collapse or overlap keeps its original edges', () => {
  const analysis = analyzeLevels(speechLevels());
  const analyses = new Map([['take-01', analysis]]);
  const collapsed = snapRangesToPauses(
    [{ take: 'take-01', start: 1.32, end: 1.38, beat: 'B', reason: 'y' }],
    { takes: twoTakes(), analyses, fps: 25 },
  );
  assert.deepEqual(collapsed.ranges.map(({ start, end }) => [start, end]), [[1.32, 1.38]]);
  assert.deepEqual(collapsed.adjustments.map(({ edge, reason }) => [edge, reason]), [['start', 'kept'], ['end', 'kept']]);
  const overlapped = snapRangesToPauses([
    { take: 'take-01', start: 0, end: 2.4, beat: 'A', reason: 'x' },
    { take: 'take-01', start: 2.55, end: 2.9, beat: 'B', reason: 'y' },
  ], { takes: twoTakes(), analyses, fps: 25 });
  assert.deepEqual(overlapped.ranges.map(({ start, end }) => [start, end]), [[0, 2.4], [2.55, 2.9]]);
  assert.deepEqual(
    overlapped.adjustments.map(({ index, edge, reason }) => [index, edge, reason]),
    [[0, 'start', 'kept'], [0, 'end', 'kept'], [1, 'start', 'kept'], [1, 'end', 'kept']],
  );
});

test('edges at or past the file boundaries stay and takes without levels are untouched', () => {
  const analysis = analyzeLevels(speechLevels());
  const pastEnd = snapRangesToPauses(
    [{ take: 'take-01', start: 1.2, end: 3.2, beat: 'A', reason: 'x' }],
    { takes: twoTakes(), analyses: new Map([['take-01', analysis]]), fps: 25 },
  );
  assert.deepEqual(pastEnd.ranges.map(({ start, end }) => [start, end]), [[1.2, 3.2]]);
  assert.deepEqual(pastEnd.adjustments, []);
  const tone = analyzeLevels({ frameSec: 0.01, levels: new Array(300).fill(-20) });
  const edges = snapRangesToPauses(
    [{ take: 'take-01', start: 0, end: 3, beat: 'A', reason: 'x' }],
    { takes: twoTakes(), analyses: new Map([['take-01', tone]]), fps: 25 },
  );
  assert.deepEqual(edges.ranges.map(({ start, end }) => [start, end]), [[0, 3]]);
  assert.deepEqual(edges.adjustments, []);
  const untouched = snapRangesToPauses(
    [{ take: 'take-02', start: 0.4, end: 0.6, beat: 'A', reason: 'x' }],
    { takes: twoTakes(), analyses: new Map(), fps: 25 },
  );
  assert.deepEqual(untouched.ranges.map(({ start, end }) => [start, end]), [[0.4, 0.6]]);
  assert.deepEqual(untouched.adjustments, []);
});
```

Run: `node --test tests/take-pauses.test.js`
Expected: FAIL `Cannot find module '../scripts/project/take-pauses'`.

- [ ] **Step 2: Создать `scripts/project/take-pauses.js`**

```js
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
```


- [ ] **Step 3: Проверить**

Run: `node --test tests/take-pauses.test.js`
Expected: PASS (12 tests).

- [ ] **Step 4: Commit**

```bash
git add scripts/project/take-pauses.js tests/take-pauses.test.js
git commit -m "feat: find pauses near take cut points from audio levels"
```

---

### Task 2: Чтение уровней звука дубля `readTakeLevels`

**Files:**
- Modify: `scripts/project/take-pauses.js`
- Modify: `tests/take-pauses.test.js`

- [ ] **Step 1: Добавить падающие тесты в конец `tests/take-pauses.test.js`**

В начало файла к импортам добавить:

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ffmpegEncoderAvailable, runTool: runFixture, toolAvailable } = require('./helpers/media-fixtures');
```

и `readTakeLevels` в список импорта из `../scripts/project/take-pauses`. В конец файла:

```js
test('readTakeLevels decodes mono 16 kHz PCM on the trim axis and removes its temp dir', () => {
  const calls = [];
  let tempDir = null;
  const levels = readTakeLevels('clip.mp4', {
    runToolImpl(command, args, options) {
      calls.push({ command, args, options });
      tempDir = path.dirname(args.at(-1));
      fs.writeFileSync(args.at(-1), Buffer.alloc(320 * 2));
    },
  });
  assert.equal(calls[0].command, 'ffmpeg');
  assert.deepEqual(calls[0].args.slice(-9), [
    '-af', 'aresample=async=1:min_hard_comp=0:first_pts=0',
    '-ac', '1', '-ar', '16000', '-f', 's16le', calls[0].args.at(-1),
  ]);
  assert.equal(calls[0].args.includes(path.resolve('clip.mp4')), true);
  assert.equal(calls[0].options.stage, 'take levels');
  assert.deepEqual(levels, { frameSec: 0.01, levels: [-120, -120] });
  assert.equal(fs.existsSync(tempDir), false);
});

test('real levels show the pause of a generated take', { timeout: 60_000 }, (t) => {
  if (!toolAvailable('ffmpeg') || !ffmpegEncoderAvailable('libx264')) {
    t.skip('real levels require ffmpeg and libx264');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-take-levels-real-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const take = path.join(dir, 'take.mp4');
  runFixture('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=3',
    '-f', 'lavfi', '-i', "aevalsrc='if(lt(t,1)+between(t,1.3,2.5),0.3*sin(2*PI*440*t),0)':s=48000:d=3",
    '-ac', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', take,
  ], dir);
  const analysis = analyzeLevels(readTakeLevels(take));
  assert.equal(isSilentSpan(analysis, 1.05, 1.25), true);
  assert.equal(isSilentSpan(analysis, 0.2, 0.8), false);
  const cut = findPauseCut(analysis, 1.36, 'end', { fps: 25 });
  assert.ok(cut >= 1 && cut <= 1.3, String(cut));
});
```

Run: `node --test tests/take-pauses.test.js`
Expected: FAIL `readTakeLevels is not a function`.

- [ ] **Step 2: Добавить `readTakeLevels` в `scripts/project/take-pauses.js`**

В начало файла, перед импортом `../review/media-time`, добавить:

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { hostPath, runTool } = require('../process');
```

Перед `module.exports` добавить функцию:

```js
// Та же ось, что у trim и у WAV для Whisper: aresample восстанавливает тишину в начале и
// короткие разрывы внутри звука. Моно 16 кГц хватает, чтобы увидеть паузы между словами.
function readTakeLevels(filePath, {
  stage = 'take levels',
  fileSystem = fs,
  runToolImpl = runTool,
  sampleRate = 16000,
} = {}) {
  const directory = fileSystem.mkdtempSync(path.join(os.tmpdir(), 'automontage-take-levels-'));
  try {
    const pcmPath = path.join(directory, 'audio.raw');
    runToolImpl('ffmpeg', [
      '-v', 'error', '-y', '-i', hostPath(filePath), '-vn',
      '-af', 'aresample=async=1:min_hard_comp=0:first_pts=0',
      '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', pcmPath,
    ], { stage });
    return levelsFromPcm(fileSystem.readFileSync(pcmPath), { sampleRate });
  } finally {
    fileSystem.rmSync(directory, { recursive: true, force: true });
  }
}
```

и добавить `readTakeLevels` в `module.exports` (после `pauseThresholdDb`).

- [ ] **Step 3: Проверить**

Run: `node --test tests/take-pauses.test.js` и `PATH="/opt/homebrew/opt/ffmpeg@7/bin:$PATH" node --test tests/take-pauses.test.js`
Expected: PASS (14 tests) на обоих FFmpeg, реальный тест не пропущен.

- [ ] **Step 4: Commit**

```bash
git add scripts/project/take-pauses.js tests/take-pauses.test.js
git commit -m "feat: read take audio levels on the trim axis"
```

---

### Task 3: Слова вне запрошенного диапазона и в тишине на краях куска

**Files:**
- Modify: `scripts/project/takes-edit.js`
- Modify: `tests/takes-edit.test.js`

- [ ] **Step 1: Добавить падающие тесты в конец `tests/takes-edit.test.js`**

```js
test('a word lying only in the frame rounding overhang is not carried over', () => {
  const longTakes = new Map([['take-01', { id: 'take-01', filePath: 'take-01.mp4', duration: 80 }]]);
  const ranges = snapTakeRanges(
    [{ take: 'take-01', start: 1, end: 79.58, beat: 'CTA', reason: 'x' }],
    { fps: 25, takes: longTakes },
  );
  assert.equal(ranges[0].end, 79.6);
  assert.equal(ranges[0].requestedEnd, 79.58);
  const words = remapTakeRangesTranscript(ranges, new Map([['take-01', [
    { w: 'скилл', s: 79, e: 79.34 },
    { w: 'Продолжение', s: 79.58, e: 79.59 },
  ]]]), 25);
  assert.deepEqual(words.map((word) => word.w), ['скилл']);
});

test('silent words at the edges of a piece are dropped, silent words inside stay', () => {
  const ranges = snapTakeRanges(
    [{ take: 'take-01', start: 4, end: 6, beat: 'CTA', reason: 'x' }],
    { fps: 25, takes },
  );
  const silent = new Set(['шум', 'и', 'Продолжение']);
  const words = remapTakeRangesTranscript(ranges, new Map([['take-01', [
    { w: 'шум', s: 4, e: 4.05 },
    { w: 'пока', s: 4.3, e: 4.6 },
    { w: 'и', s: 4.7, e: 4.72 },
    { w: 'всё', s: 4.8, e: 5.2 },
    { w: 'Продолжение', s: 5.9, e: 5.99 },
  ]]]), 25, { isSilentWord: (takeId, word) => takeId === 'take-01' && silent.has(word.w) });
  assert.deepEqual(words.map((word) => word.w), ['пока', 'и', 'всё']);
});
```

Run: `node --test tests/takes-edit.test.js`
Expected: FAIL: first test `undefined !== 79.58` (no `requestedEnd`), second test includes `шум` and `Продолжение`.

- [ ] **Step 2: Изменить `scripts/project/takes-edit.js`**

В `snapTakeRanges` в возвращаемом объекте первого `map` сразу после `...range,` добавить:

```js
      requestedStart: range.start,
      requestedEnd: range.end,
```

Перед функцией `remapTakeRangesTranscript` добавить:

```js
// Кадровое округление может расширить кусок на долю кадра за пределы того, что просил агент
// (или что выбрал поиск паузы). Слово целиком в этом расширении никто не выбирал, часто это
// галлюцинация Whisper на тишине, поэтому такое слово в транскрипт не переносится.
function dropOutsideRequested(words, range) {
  if (!Array.isArray(words)
    || !Number.isFinite(range.requestedStart) || !Number.isFinite(range.requestedEnd)) {
    return words;
  }
  return words.filter((word) => word.e > range.requestedStart && word.s < range.requestedEnd);
}

// Whisper на тишине иногда «слышит» слова («Продолжение следует»). На краях куска такие слова
// лежат целиком в паузе: их убираем с начала и с конца куска, слова внутри куска не трогаем.
function trimSilentEdgeWords(words, range, isSilent) {
  if (!Array.isArray(words) || typeof isSilent !== 'function') return words;
  const inside = words
    .filter((word) => word.e > range.start && word.s < range.end)
    .sort((left, right) => left.s - right.s || left.e - right.e);
  let first = 0;
  let last = inside.length - 1;
  while (first <= last && isSilent(inside[first])) first += 1;
  while (last >= first && isSilent(inside[last])) last -= 1;
  return inside.slice(first, last + 1);
}
```

Заменить начало `remapTakeRangesTranscript` (сигнатуру и первую строку тела цикла):

```js
function remapTakeRangesTranscript(ranges, wordsByTake, fps, { isSilentWord = null } = {}) {
  const words = [];
  let offset = 0;
  for (const range of ranges) {
    let takeWords = dropOutsideRequested(wordsByTake.get(range.take), range);
    takeWords = dropClippedSlivers(takeWords, range, fps);
    if (isSilentWord) {
      takeWords = trimSilentEdgeWords(takeWords, range, (word) => isSilentWord(range.take, word));
    }
    const local = remapTranscriptWords(takeWords, [range], fps);
```

(остальное тело функции без изменений).

- [ ] **Step 3: Проверить**

Run: `node --test tests/takes-edit.test.js tests/takes-master.test.js`
Expected: PASS, все прежние тесты без изменений.

- [ ] **Step 4: Commit**

```bash
git add scripts/project/takes-edit.js tests/takes-edit.test.js
git commit -m "fix: keep whisper words outside the requested range and silent edge words out of takes"
```

---

### Task 4: Master сдвигает границы в паузы и печатает итог

**Files:**
- Modify: `scripts/project/build-takes-master.js`
- Modify: `scripts/project/build-master.js`
- Modify: `tests/takes-master.test.js`

- [ ] **Step 1: Подготовить и добавить падающие тесты в `tests/takes-master.test.js`**

Импорт `build-master` заменить на:

```js
const { buildMaster, takesSummaryLines } = require('../scripts/project/build-master');
```

В `masterDependencies` после `probeMediaPathImpl: () => media(),` добавить (прежние тесты остаются без анализа звука):

```js
    readTakeLevelsImpl: () => null,
```

В конец файла:

```js
function levelsWithPauses(pauses, duration = 10) {
  const levels = [];
  for (let index = 0; index < duration * 100; index += 1) {
    const time = index / 100;
    levels.push(pauses.some(([from, to]) => time >= from && time < to) ? -90 : -20);
  }
  return { frameSec: 0.01, levels };
}

test('takes master moves cuts into pauses, drops silent edge words and reports joints', (t) => {
  const fixture = setupTakes(t);
  const editPath = writeEdit(fixture.dir);
  const calls = [];
  const result = buildMaster({ projectDir: fixture.dir, editPath }, masterDependencies(calls, {
    readTakeLevelsImpl: (file) => (file.includes('take-02')
      ? levelsWithPauses([[2.3, 2.45]])
      : levelsWithPauses([[3.8, 4.1], [5.8, 6.4]])),
    probeVideoImpl(filename) {
      return path.basename(filename).startsWith('.source-v')
        ? { width: 1920, height: 1080, fps: 25, duration: 3.36 }
        : { width: 1920, height: 1080, fps: 25, duration: 10 };
    },
  }));
  const [, trim] = calls[0];
  assert.deepEqual(trim.segments, [
    { input: 0, start: 1, end: 2.36 },
    { input: 1, start: 4, end: 6 },
  ]);
  assert.deepEqual(result.pauseAdjustments, [
    { index: 0, edge: 'start', from: 1.02, to: 1.02, reason: 'no-pause' },
    { index: 0, edge: 'end', from: 2.51, to: 2.36, reason: 'pause' },
  ]);
  assert.deepEqual(result.joints, [1.36]);
  assert.equal(result.duration, 3.36);
  assert.deepEqual(JSON.parse(fs.readFileSync(
    path.join(fixture.dir, 'transcript', 'words-v02.json'), 'utf8',
  ))[0].words, [
    { w: 'привет', s: 0.1, e: 0.5 },
    { w: 'пока', s: 1.86, e: 2.36 },
  ]);
});

test('master summary lists final ranges, joints and every pause decision', () => {
  assert.deepEqual(takesSummaryLines({
    takes: ['take-02', 'take-01'],
    ranges: [
      { take: 'take-02', start: 1, end: 2.52, beat: 'HOOK' },
      { take: 'take-01', start: 4, end: 6, beat: 'CTA' },
    ],
    joints: [1.52],
    pauseAdjustments: [
      { index: 0, edge: 'end', from: 2.51, to: 2.52, reason: 'pause' },
      { index: 1, edge: 'start', from: 4, to: 4, reason: 'no-pause' },
      { index: 1, edge: 'end', from: 6, to: 6, reason: 'kept' },
    ],
  }), [
    '   takes: take-02, take-01',
    '   ranges: 2',
    '     1. take-02 1.00-2.52 HOOK',
    '     2. take-01 4.00-6.00 CTA',
    '   joints: 1.52',
    '   pause: ranges[0].end 2.51 -> 2.52',
    '   no pause near: ranges[1].start 4.00',
    '   kept: ranges[1].end 6.00 (moving would collapse or overlap)',
  ]);
});
```

Run: `node --test tests/takes-master.test.js`
Expected: FAIL (`takesSummaryLines is not a function`; segments end 2.52 instead of 2.36).

- [ ] **Step 2: Изменить `scripts/project/build-takes-master.js`**

Добавить импорт после `./source-revision`:

```js
const { analyzeLevels, isSilentSpan, snapRangesToPauses } = require('./take-pauses');
```

В деструктуризации `dependencies` добавить `readTakeLevelsImpl,` после `runSegmentsTrimImpl,`.

Заменить две строки

```js
  const [first] = used;
  const ranges = snapTakeRanges(normalized.ranges, { fps: first.fps, takes });
```

на

```js
  const [first] = used;
  // Граница, выбранная по таймингам Whisper, может попасть внутрь слова: Whisper прячет паузы
  // внутрь соседних слов. Поэтому каждая граница сначала уходит в ближайшую паузу по звуку.
  const analyses = new Map();
  for (const take of used) {
    const levels = readTakeLevelsImpl(take.filePath, { stage: `${take.id} levels` });
    if (levels && levels.levels.length) analyses.set(take.id, analyzeLevels(levels));
  }
  const paused = snapRangesToPauses(normalized.ranges, { takes, analyses, fps: first.fps });
  const ranges = snapTakeRanges(paused.ranges, { fps: first.fps, takes });
```

Заменить строку

```js
  const words = remapTakeRangesTranscript(ranges, wordsByTake, first.fps);
```

на

```js
  const words = remapTakeRangesTranscript(ranges, wordsByTake, first.fps, {
    isSilentWord: (takeId, word) => analyses.has(takeId)
      && isSilentSpan(analyses.get(takeId), word.s, word.e),
  });
  const joints = [];
  let elapsed = 0;
  for (const range of ranges.slice(0, -1)) {
    elapsed += range.end - range.start;
    joints.push(roundedTime(elapsed, first.fps));
  }
```

В возвращаемом объекте после поля `ranges: ...` добавить:

```js
    joints,
    // Для сдвинутой границы показываем итоговую точку после кадрового выравнивания.
    pauseAdjustments: paused.adjustments.map((item) => ({
      ...item,
      from: roundedTime(item.from, first.fps),
      to: roundedTime(item.reason === 'pause' ? ranges[item.index][item.edge] : item.to, first.fps),
    })),
```

- [ ] **Step 3: Изменить `scripts/project/build-master.js`**

Добавить импорт после `./takes-edit`:

```js
const { readTakeLevels } = require('./take-pauses');
```

В вызове `buildTakesMaster` в объект зависимостей после `runSegmentsTrimImpl: ...` добавить:

```js
      readTakeLevelsImpl: dependencies.readTakeLevelsImpl || readTakeLevels,
```

Перед `function parseMasterOptions` добавить:

```js
function takesSummaryLines(result) {
  const lines = [
    `   takes: ${result.takes.join(', ')}`,
    `   ranges: ${result.ranges.length}`,
    ...result.ranges.map((range, index) => (
      `     ${index + 1}. ${range.take} ${range.start.toFixed(2)}-${range.end.toFixed(2)} ${range.beat}`
    )),
  ];
  if (result.joints.length) {
    lines.push(`   joints: ${result.joints.map((time) => time.toFixed(2)).join(', ')}`);
  }
  for (const item of result.pauseAdjustments) {
    const label = `ranges[${item.index}].${item.edge}`;
    if (item.reason === 'pause') {
      lines.push(`   pause: ${label} ${item.from.toFixed(2)} -> ${item.to.toFixed(2)}`);
    } else if (item.reason === 'no-pause') {
      lines.push(`   no pause near: ${label} ${item.from.toFixed(2)}`);
    } else {
      lines.push(`   kept: ${label} ${item.from.toFixed(2)} (moving would collapse or overlap)`);
    }
  }
  return lines;
}
```

В `main` заменить

```js
    if (result.kind === 'takes') {
      console.log(`   takes: ${result.takes.join(', ')}`);
      console.log(`   ranges: ${result.ranges.length}`);
    } else {
```

на

```js
    if (result.kind === 'takes') {
      for (const line of takesSummaryLines(result)) console.log(line);
    } else {
```

В `module.exports` добавить `takesSummaryLines` (после `remapTranscriptWords`, до `validateSourceEdit`).

- [ ] **Step 4: Проверить**

Run: `node --test tests/takes-master.test.js tests/takes-edit.test.js tests/take-pauses.test.js tests/source-edit.test.js tests/takes-master-media.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/project/build-takes-master.js scripts/project/build-master.js tests/takes-master.test.js
git commit -m "feat: move take cuts into audio pauses and report joints in master"
```

---

### Task 5: Сквозной тест с настоящим FFmpeg

**Files:**
- Modify: `tests/takes-master-media.test.js`

- [ ] **Step 1: Добавить тест в конец файла** (импорт `readTakeLevels`, `analyzeLevels` из `../scripts/project/take-pauses` добавить к импортам файла):

```js
test('real takes master moves cuts inside speech into the nearest pause', { timeout: 180_000 }, (t) => {
  if (!toolAvailable('ffmpeg') || !toolAvailable('ffprobe') || !ffmpegEncoderAvailable('libx264')) {
    t.skip('real pause cuts require ffmpeg, ffprobe and libx264');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-takes-pauses-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'take1.mp4');
  const second = path.join(root, 'take2.mp4');
  // Тон вместо речи: take1 звучит 0-1.0 и 1.3-2.5 с, take2 звучит 0-0.8 и с 1.2 с.
  runFixture('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=3',
    '-f', 'lavfi', '-i', "aevalsrc='if(lt(t,1)+between(t,1.3,2.5),0.3*sin(2*PI*440*t),0)':s=48000:d=3",
    '-ac', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', first,
  ], root);
  runFixture('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'smptebars=s=160x90:r=25:d=3',
    '-f', 'lavfi', '-i', "aevalsrc='if(lt(t,0.8)+gte(t,1.2),0.3*sin(2*PI*660*t),0)':s=48000:d=3",
    '-ac', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', second,
  ], root);
  const workspace = createOrOpenProject({
    projectDir: path.join(root, 'project'), name: 'Pause cuts', sourcePath: first,
  });
  const takeWords = {
    'source.mp4': [
      { w: 'один', s: 0.2, e: 0.9 },
      { w: 'Продолжение', s: 1.02, e: 1.08 },
    ],
    'take-02.mp4': [{ w: 'три', s: 1.3, e: 1.9 }],
  };
  addTakes({ projectDir: workspace.dir, files: [second] }, {
    transcribeImpl: ({ videoPath }) => [{
      start: 0, end: 3, text: 'x', words: takeWords[path.basename(videoPath)],
    }],
  });
  fs.writeFileSync(path.join(workspace.dir, 'edit', 'v02-takes.json'), `${JSON.stringify({
    version: 1,
    kind: 'takes',
    sourceRevision: 1,
    ranges: [
      { take: 'take-01', start: 0, end: 1.36, beat: 'HOOK', reason: 'конец внутри второго тона' },
      { take: 'take-02', start: 0.75, end: 2, beat: 'CTA', reason: 'начало внутри первого тона' },
    ],
  }, null, 2)}\n`);

  const result = buildMaster({ projectDir: workspace.dir, editPath: 'edit/v02-takes.json' });

  const moved = (index, edge) => result.pauseAdjustments
    .find((item) => item.index === index && item.edge === edge && item.reason === 'pause');
  assert.ok(moved(0, 'end') && moved(0, 'end').to >= 1 && moved(0, 'end').to <= 1.3, JSON.stringify(result.pauseAdjustments));
  assert.ok(moved(1, 'start') && moved(1, 'start').to >= 0.8 && moved(1, 'start').to <= 1.2, JSON.stringify(result.pauseAdjustments));
  const [pieceOne, pieceTwo] = result.ranges;
  const expectedFrames = Math.round(pieceOne.end * 25) + Math.round((pieceTwo.end - pieceTwo.start) * 25);
  const probe = spawnSync('ffprobe', [
    '-v', 'error', '-count_frames',
    '-show_entries', 'stream=codec_type,nb_read_frames,duration', '-of', 'json', result.sourcePath,
  ], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  const output = JSON.parse(probe.stdout).streams;
  const video = output.find((stream) => stream.codec_type === 'video');
  const audio = output.find((stream) => stream.codec_type === 'audio');
  assert.equal(Number(video.nb_read_frames), expectedFrames);
  assert.ok(Math.abs(Number(audio.duration) - Number(video.duration)) < 0.02, `${audio.duration} vs ${video.duration}`);
  const [joint] = result.joints;
  const levels = analyzeLevels(readTakeLevels(result.sourcePath));
  const around = levels.levels.slice(Math.round((joint - 0.1) * 100), Math.round((joint + 0.08) * 100));
  assert.ok(Math.max(...around) < -60, `joint ${joint}: ${Math.max(...around)} dB`);
  const words = JSON.parse(fs.readFileSync(result.transcriptPath, 'utf8'))[0].words;
  assert.deepEqual(words.map((word) => word.w), ['один', 'три']);
});
```

- [ ] **Step 2: Прогнать на FFmpeg 9 и 7**

Run: `node --test tests/takes-master-media.test.js` и `PATH="/opt/homebrew/opt/ffmpeg@7/bin:$PATH" node --test tests/takes-master-media.test.js`
Expected: PASS (3 tests), без `# SKIP`. Прототип дал: `ranges[0].end 1.36 -> 1.12`, `ranges[1].start 0.75 -> 1.08`, `ranges[1].end 2` без паузы, 51 кадр, звук = видео = 2.04 с, окно стыка -120 dB.

- [ ] **Step 3: Commit**

```bash
git add tests/takes-master-media.test.js
git commit -m "test: cover pause cuts in the takes master with real ffmpeg"
```

---

### Task 6: Навык и заголовок сводки

**Files:**
- Modify: `scripts/project/takes-pack.js`, `tests/takes-pack.test.js`
- Modify: `skills/reel-turnkey/references/takes-selection.md`, `skills/reel-turnkey/SKILL.md`, `skills/reel-turnkey/evals/evals.json`

- [ ] **Step 1: Заголовок сводки.** В `scripts/project/takes-pack.js` строку
  `'Пауза до соседней фразы: начало следующей строки минус конец текущей. Запас на стыке не больше половины этой паузы.',`
  заменить на
  `'Пауза до соседней фразы: начало следующей строки минус конец текущей. Master сам сдвигает границы кусков в ближайшую паузу в звуке.',`
  и ту же строку в ожидании теста `packed markdown lists every take with fixed-width time ranges` в `tests/takes-pack.test.js`. Сначала изменить тест, убедиться, что он падает, затем код. Run: `node --test tests/takes-pack.test.js` → PASS.

- [ ] **Step 2: `takes-selection.md`, вступление.** После абзаца, который заканчивается `задай один вопрос.`, вставить:

```markdown

Тем же маршрутом собирается один ролик из нескольких разных записей по сценарию пользователя:
каждая запись регистрируется как дубль (`take-NN` = файл записи), а куски идут в порядке сценария,
а не лучших попыток. Записи должны совпадать по тем же параметрам, что и дубли. На каждом стыке
разных записей и на скачке внутри одной записи ставь смену сцены (B-roll, графика, другой план),
иначе виден прыжок головы.
```

- [ ] **Step 3: `takes-selection.md`, шаг 2.** После строки `расшифрует только новые файлы.` добавить в тот же пункт:

```markdown
   Ориентир скорости: на Apple M1 Pro расшифровка занимает примерно треть длительности записи.
```

- [ ] **Step 4: `takes-selection.md`, шаг 5.** После абзаца, который заканчивается `Путь в `--edit` указывается от папки проекта. Собери master:` и блока команды master, добавить (3 пробела отступа):

```markdown
   Master сам сдвигает каждую границу в ближайшую паузу в звуке (не дальше 0.25 с) и печатает
   итоговые куски, время стыков (`joints`), сдвинутые границы (`pause`) и границы, у которых
   рядом нет паузы (`no pause near`). Граница без паузы рядом режет речь: выбери другую границу
   в новом `edit/vNN-takes.json`.
```

- [ ] **Step 5: `takes-selection.md`, шаг 6.** Заменить его текст целиком (от `6. Проверь стыки до draft.` до `повтор исправь новым `edit/vNN-takes.json` до draft.`) на:

```markdown
6. Проверь стыки до draft. Время стыков печатает master (`joints`). Для каждого стыка посмотри
   кадры по обе стороны (`ffmpeg -ss <время> -frames:v 1`). Звук проверь по уровню, а не на слух:
   в последних 0.1 с куска до стыка и первых 0.1 с после него не должно быть речи громче
   примерно -45 dB (окна по 10 мс, например `ffmpeg -ss <t> -t 0.2 -i <master> -af
   astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.Peak_level -f null -`).
   Повторная расшифровка master обрывки слов не ловит. Обрезанное слово, щелчок или повтор
   исправь новым `edit/vNN-takes.json` до draft.
```

- [ ] **Step 6: `takes-selection.md`, правила брифа.** Правило, которое начинается `- пауза до соседа:`, (3 строки) заменить на:

```markdown
- ставь start и end у краёв слов по сводке, запас вручную не добавляй: master сам сдвинет
  каждую границу в ближайшую паузу в звуке и сообщит границы без паузы рядом;
- если одинаковый блок есть в нескольких дублях (тот же текст и длительности фраз), не
  переключай дубль: лишний стык – лишний риск;
- фраз, которых нет в речи (часто в конце дубля на тишине: «Продолжение следует», «Субтитры
  сделал»), не бери: это галлюцинации Whisper;
```

- [ ] **Step 7: `SKILL.md`.** В разделе `### Пакетный режим` после предложения, которое заканчивается `задай один вопрос.`, добавить: `Один ролик из нескольких разных записей по сценарию собирается тем же маршрутом дублей.` В разделе `### Несколько дублей одного ролика` после первого предложения добавить: `Тем же маршрутом собирается один ролик из разных записей по сценарию.`

- [ ] **Step 8: `evals/evals.json`.** После eval id 10 добавить:

```json
    {
      "id": 11,
      "prompt": "Вот три записи: intro.mp4, main.mp4 и outro.mp4. Собери из них один ролик по такому сценарию: хук из intro, главная мысль из main, призыв из outro.",
      "expected_output": "Агент понимает, что это один ролик из разных записей, а не пакет выходов. Создаёт проект из первой записи, добавляет остальные через automontage takes add, выбирает куски по сценарию, собирает master через edit/vNN-takes.json, читает напечатанные joints и границы без паузы, ставит смену сцены на каждом стыке разных записей и доводит до preview без final без утверждения.",
      "files": [],
      "expectations": [
        "Три файла не превращаются в три отдельных проекта или выхода.",
        "Куски идут в порядке сценария пользователя.",
        "Границы без паузы рядом из вывода master исправлены до draft.",
        "На каждом стыке разных записей стоит смена сцены."
      ]
    }
```

- [ ] **Step 9: Проверить**

Run: `node -e "JSON.parse(require('fs').readFileSync('skills/reel-turnkey/evals/evals.json','utf8'))" && node --test tests/takes-pack.test.js tests/creative-motion-instructions.test.js tests/batch-workflow-docs.test.js tests/reel-from-donor-skill.test.js` и `git diff -U0 | grep '^+' | grep -c "$(printf '\342\200\224')"` → 0.

- [ ] **Step 10: Commit**

```bash
git add scripts/project/takes-pack.js tests/takes-pack.test.js skills/reel-turnkey
git commit -m "docs: teach reel-turnkey pause cuts and one video from different recordings"
```

---

### Task 7: Документация

**Files:** `README.md`, `ARCHITECTURE.md`, `TESTING.md`, `DECISIONS.md`, `CHANGELOG.md`

- [ ] **Step 1: `README.md`.** В абзаце про дубли после предложения о `automontage master ... собирает куски в новую source revision.` вставить: `Master сам сдвигает каждую границу куска в ближайшую паузу в звуке (не дальше 0.25 с), потому что Whisper прячет паузы внутрь слов, и печатает итоговые куски, время стыков и границы без паузы рядом. Тем же маршрутом можно собрать один ролик из разных записей по сценарию: каждая запись становится дублем.`

- [ ] **Step 2: `ARCHITECTURE.md`.** В абзац про дубли (где `build-takes-master.js`) дописать: ``scripts/project/take-pauses.js` читает уровень звука каждого дубля окнами по 10 мс на той же оси, что и `trim`, и до кадрового выравнивания сдвигает границы кусков в ближайшую паузу (не дальше 0.25 с, до 0.1 с тишины у края); слова целиком вне запрошенного диапазона и слова в тишине на краях куска в транскрипт не переносятся.`` В строку таблицы `| Source revisions и дубли | ... |` добавить `` `scripts/project/take-pauses.js` ``.

- [ ] **Step 3: `TESTING.md`.** В абзац про тесты дублей дописать: ``tests/take-pauses.test.js` закрывает уровни, порог паузы и выбор точки разреза; `tests/takes-master-media.test.js` проверяет на настоящем FFmpeg, что граница внутри звучания уходит в паузу и окно стыка тихое.``

- [ ] **Step 4: `DECISIONS.md`, D-031.** Перед абзацем `Отклонены:` вставить абзац:

```markdown
Границы кусков по таймингам Whisper на живой пробе попали внутрь слова в 3 случаях из 8, и
повторная расшифровка master этого не заметила. Поэтому master сам сдвигает каждую границу в
ближайшую паузу по уровню звука дубля: окна по 10 мс; тишина не громче 15 дБ над шумом дубля или
на 35 дБ тише его речи, но всегда хотя бы на 20 дБ тише речи и не выше -30 dBFS; пауза не короче
50 мс; поиск не дальше 0.25 с; у края куска до 0.1 с тишины и не меньше 40 мс до речи. Конец куска
предпочитает паузу до себя, начало после себя, потому что Whisper растягивает слова в паузы.
Стык соседних кусков одного дубля – один общий разрез, иначе слово между двумя паузами терялось. Граница без паузы рядом остаётся на месте и печатается. Слова в тишине на краях куска
считаются галлюцинациями Whisper и в транскрипт не попадают. Отклонены только инструкция агенту
(агент не слышит звук, ручная проверка трудоёмка) и повторная расшифровка master (обрывки не ловит).
```

- [ ] **Step 5: `CHANGELOG.md`.** В `## [Unreleased]` → `### Добавлено` в конец добавить:

```markdown
- `automontage master` для дублей сам сдвигает каждую границу куска в ближайшую паузу в звуке и
  печатает итоговые куски, время стыков и границы без паузы рядом; слова-галлюцинации Whisper в
  тишине на краях кусков не попадают в транскрипт. Навык `reel-turnkey` собирает тем же маршрутом
  один ролик из разных записей по сценарию.
```

- [ ] **Step 6: Проверить**: `npm run check:privacy`, `npm run check:release`, `git diff -U0 | grep '^+' | grep -c "$(printf '\342\200\224')"` → 0.

- [ ] **Step 7: Commit**

```bash
git add README.md ARCHITECTURE.md TESTING.md DECISIONS.md CHANGELOG.md
git commit -m "docs: document pause cuts in the takes master"
```

---

### Task 8: Итоговая проверка и повтор живой пробы

- [ ] **Step 1:** `PATH="/opt/homebrew/opt/ffmpeg-full/bin:$PATH" npm test` → 0 fail; `PATH="/opt/homebrew/opt/ffmpeg@7/bin:$PATH" node --test tests/take-pauses.test.js tests/takes-master-media.test.js tests/trim-media-real.test.js` → PASS.
- [ ] **Step 2:** В пробных проектах `projects/2026.09.25_takes-probe-tsennaya` и `projects/2026.09.25_takes-probe-mix` (ревизия 3) создать `edit/v04-takes.json` с диапазонами из `edit/v02-takes.json` (те, что дали обрывки слов) и `sourceRevision: 3`, собрать `node scripts/cli.js master --project-dir <папка> --edit edit/v04-takes.json` (с `PATH` на `.venv` основной папки и ffmpeg-full). Expected: печать `pause:` для `take-04` конца 3.57, `take-02` конца 5.35 и `take-03` начала 68.66; окна стыков тихие по `readTakeLevels`; в `transcript/words-v04.json` нет слова «Продолжение». Результаты пробы не коммитятся.
- [ ] **Step 3:** Обновить `_progress.md` и память проекта (дневник основной папки).

---

## Самопроверка плана

- **Покрытие:** сдвиг границ в паузы (Tasks 1, 2, 4, 5), галлюцинация в хвосте (Tasks 3, 4, 5), маршрут «один ролик из разных записей» (Task 6), документы (Task 7), проверка на реальных дефектах пробы (Task 8).
- **Имена:** `analyzeLevels`, `findPauseCut`, `isSilentSpan`, `levelsFromPcm`, `pauseThresholdDb`, `snapRangesToPauses`, `readTakeLevels`, `readTakeLevelsImpl`, `requestedStart/requestedEnd`, `isSilentWord`, `pauseAdjustments`, `joints`, `takesSummaryLines` определены в задачах 1-4 и используются с теми же сигнатурами.
- **Вне объёма:** сдвиг границ для обычного source-edit master; распознавание галлюцинаций внутри куска; перекодирование несовместимых записей.
