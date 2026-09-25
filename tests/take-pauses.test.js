const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ffmpegEncoderAvailable, runTool: runFixture, toolAvailable } = require('./helpers/media-fixtures');

const {
  analyzeLevels,
  findPauseCut,
  isSilentSpan,
  levelsFromPcm,
  pauseThresholdDb,
  readTakeLevels,
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
  // Дубль почти весь из тишины: опора на громкую речь сохраняет поиск пауз.
  assert.equal(pauseThresholdDb([...new Array(50).fill(-20), ...new Array(950).fill(-70)]), -55);
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

test('an edge inside a sound cuts at the pause on the side of the smaller part', () => {
  // Пауза 0.95-1.05, звук 1.05-1.17, пауза 1.17-1.27. Сторону выбирает звук, а не тип края:
  // разрез уходит через меньшую часть звука, а ровно в его середине (1.11) паузы нет.
  const analysis = analyzeLevels(levelsWithPauses([[0.95, 1.05], [1.17, 1.27]]));
  assert.equal(findPauseCut(analysis, 1.08, 'end', { fps: 25 }), 1);
  assert.equal(findPauseCut(analysis, 1.08, 'start', { fps: 25 }), 1);
  assert.equal(findPauseCut(analysis, 1.14, 'end', { fps: 25 }), 1.24);
  assert.equal(findPauseCut(analysis, 1.14, 'start', { fps: 25 }), 1.2);
  for (const edge of ['end', 'start', 'joint']) {
    assert.equal(findPauseCut(analysis, 1.11, edge, { fps: 25 }), null, edge);
  }
});

test('dips shorter than 50 ms are not pauses and cuts keep a margin from speech', () => {
  const dip = analyzeLevels(levelsWithPauses([[1.2, 1.24], [2.5, 3]]));
  assert.equal(findPauseCut(dip, 1.3, 'end', { fps: 25 }), null);
  const analysis = analyzeLevels(speechLevels());
  assert.equal(findPauseCut(analysis, 1.01, 'end', { fps: 25 }), 1.04);
  assert.equal(findPauseCut(analysis, 1.29, 'start', { fps: 25 }), 1.24);
});

test('a short pause of the live probe still yields a frame cut inside it', () => {
  const analysis = analyzeLevels(levelsWithPauses([[3.46, 3.54]], { duration: 5 }));
  assert.equal(findPauseCut(analysis, 3.57, 'end', { fps: 25 }), 3.52);
});

test('a pause too short for both margins gives the margin to the speech kept in the piece', () => {
  // Пауза 3.18-3.24 при 60 fps вмещает кадры 191-194. Конец куска встаёт у конца паузы, дальше
  // всего от своей речи до неё, а не в 3.1833 у края этой речи.
  const analysis = analyzeLevels(levelsWithPauses([[3.18, 3.24]], { duration: 5 }));
  assert.equal(findPauseCut(analysis, 3.18, 'end', { fps: 60 }), 194 / 60);
});

test('a start edge in a short pause takes its earliest frame', () => {
  // Пауза 3.18-3.26 при 25 fps вмещает кадры 3.20 и 3.24: начало куска встаёт дальше от своей
  // речи после паузы, и из паузы, и из хвоста прошлого слова.
  const analysis = analyzeLevels(levelsWithPauses([[3.18, 3.26]], { duration: 5 }));
  assert.equal(findPauseCut(analysis, 3.24, 'start', { fps: 25 }), 3.2);
  assert.equal(findPauseCut(analysis, 3.15, 'start', { fps: 25 }), 3.2);
});

test('a joint in a short pause takes its middle', () => {
  // Общий разрез оставляет речь с обеих сторон в кусках, поэтому встаёт в середине паузы 3.18-3.24.
  const analysis = analyzeLevels(levelsWithPauses([[3.18, 3.24]], { duration: 5 }));
  assert.equal(findPauseCut(analysis, 3.18, 'joint', { fps: 60 }), 193 / 60);
});

test('a pause cut never drops a short word between the pause and the edge', () => {
  // Пауза 2.00-2.10, слово «да» 2.10-2.25, провал 40 мс, дальше речь с 2.29. 2.25 – ровно конец
  // слова, 2.245 – вне сетки уровней, внутри последнего окна слова. 2.20-2.24 – граница у конца
  // слова: большая часть «да» лежит до неё, поэтому слово остаётся в куске.
  const analysis = analyzeLevels(levelsWithPauses([[2, 2.1], [2.25, 2.29]]));
  for (const end of [2.2, 2.23, 2.24, 2.245, 2.25, 2.26, 2.28, 2.3]) {
    assert.equal(findPauseCut(analysis, end, 'end', { fps: 25 }), null, String(end));
    assert.equal(findPauseCut(analysis, end, 'joint', { fps: 25 }), null, String(end));
    const result = snapRangesToPauses(
      [{ take: 'take-01', start: 0, end, beat: 'A', reason: 'x' }],
      { takes: twoTakes(), analyses: new Map([['take-01', analysis]]), fps: 25 },
    );
    assert.deepEqual(result.ranges.map((range) => [range.start, range.end]), [[0, end]]);
    assert.deepEqual(result.adjustments, [{ index: 0, edge: 'end', from: end, to: end, reason: 'no-pause' }]);
  }
});

test('a pause cut never drops the first word after a short gap', () => {
  // Речь до 2.00, провал 30 мс, «И» 2.03-2.15, пауза 2.15-2.25, дальше речь. 2.04 и 2.08 – граница
  // у начала слова: большая часть «И» лежит после неё, поэтому слово остаётся в куске.
  const analysis = analyzeLevels(levelsWithPauses([[2, 2.03], [2.15, 2.25]]));
  for (const start of [2.03, 2.035, 2.04, 2.08]) {
    assert.equal(findPauseCut(analysis, start, 'start', { fps: 25 }), null, String(start));
  }
});

test('the midpoint rule lets an edge cross the smaller part of a short word', () => {
  // «И» 2.03-2.15 перед паузой 2.15-2.25: начало куска в 2.10 оставило до себя 70 мс слова, а после
  // себя 50 мс. Большая часть слова уже вне куска, поэтому разрез уходит через хвост в паузу.
  const analysis = analyzeLevels(levelsWithPauses([[2, 2.03], [2.15, 2.25]]));
  assert.equal(findPauseCut(analysis, 2.1, 'start', { fps: 25 }), 2.2);
});

test('a one-window dip inside the sound beyond the edge does not end that sound', () => {
  // Живой дубль: пауза 5.23-5.31, звук 5.31-5.37, одно окно 5.37-5.38 под порогом (-48 dB при
  // пороге -47.8 dB), громкая речь 5.38-5.60. Конец куска в 5.35 попал в начало этой речи: провал
  // в одно окно её не обрывает, большая часть звука лежит после границы, и разрез уходит в паузу.
  const analysis = analyzeLevels(
    levelsWithPauses([[5.23, 5.31], [5.37, 5.38], [5.6, 6]], { duration: 6 }),
  );
  assert.equal(findPauseCut(analysis, 5.35, 'end', { fps: 25 }), 5.28);
});

test('a pause cut never brings back a filler the agent cut off', () => {
  // «слово» кончается в 2.00, провал 30 мс, «эм» 2.03-2.20, пауза 2.20-2.50.
  const analysis = analyzeLevels(levelsWithPauses([[2, 2.03], [2.2, 2.5]]));
  assert.equal(findPauseCut(analysis, 2, 'end', { fps: 25 }), null);
});

test('an edge inside a word still crosses the rest of that word into the pause', () => {
  // Конец куска попал в начало следующего слова: разрез возвращается в паузу перед ним.
  // Пауза 3.45-3.54 коротка для отступов с обеих сторон, поэтому конец встаёт у её конца.
  const head = analyzeLevels(levelsWithPauses([[3.45, 3.54], [3.74, 3.9]], { duration: 5 }));
  assert.equal(findPauseCut(head, 3.57, 'end', { fps: 25 }), 3.52);
  // Слова живой пробы не мешают: середины «эксперта?» и «Если» лежат вне пройденного звука.
  const headWords = [{ w: 'эксперта?', s: 2.98, e: 3.57 }, { w: 'Если', s: 3.57, e: 3.9 }];
  assert.equal(findPauseCut(head, 3.57, 'end', { fps: 25, words: headWords }), 3.52);
  // Начало куска попало в хвост прошлого слова: разрез уходит вперёд в паузу после него.
  const tail = analyzeLevels(levelsWithPauses([[68.75, 69.18]], { duration: 70 }));
  assert.equal(findPauseCut(tail, 68.66, 'start', { fps: 25 }), 69.08);
  // Whisper растянул «И» на паузу: середина слова внутри паузы разрез не останавливает.
  const tailWords = [{ w: 'тебя.', s: 68.36, e: 68.66 }, { w: 'И', s: 68.66, e: 69.24 }];
  assert.equal(findPauseCut(tail, 68.66, 'start', { fps: 25, words: tailWords }), 69.08);
});

// «это.» 1.40-2.00, пауза 2.00-2.10, «Не» 2.10-2.22 и «работает» 2.22-2.80 звучат без паузы между
// ними, дальше пауза 2.80-3.00.
function gluedNot() {
  return {
    analysis: analyzeLevels(levelsWithPauses([[2, 2.1], [2.8, 3]])),
    words: [{ w: 'это.', s: 1.4, e: 2 }, { w: 'Не', s: 2.1, e: 2.22 }, { w: 'работает', s: 2.22, e: 2.8 }],
  };
}

test('Whisper words stop an end cut inside a short word glued to the next one', () => {
  // Уровни не видят границу склеенных слов: без слов конец куска точно на этой границе уходит через
  // «Не» в паузу, и смысл меняется на обратный. Середина «Не» в пройденном звуке это запрещает.
  const { analysis, words } = gluedNot();
  assert.equal(findPauseCut(analysis, 2.22, 'end', { fps: 25 }), 2.04);
  assert.equal(findPauseCut(analysis, 2.22, 'end', { fps: 25, words }), null);
  assert.equal(findPauseCut(analysis, 2.22, 'joint', { fps: 25, words }), null);
});

test('Whisper words stop a start cut inside a short word glued to the previous one', () => {
  // Зеркально: «повтор» 1.30-2.00 склеен с «и» 2.00-2.10, дальше пауза 2.10-2.25. Начало куска в
  // 2.00 без слов ушло бы через «и» в паузу.
  const analysis = analyzeLevels(levelsWithPauses([[1.2, 1.3], [2.1, 2.25]]));
  const words = [{ w: 'повтор', s: 1.3, e: 2 }, { w: 'и', s: 2, e: 2.1 }, { w: 'дальше', s: 2.25, e: 2.8 }];
  assert.equal(findPauseCut(analysis, 2, 'start', { fps: 25 }), 2.16);
  assert.equal(findPauseCut(analysis, 2, 'start', { fps: 25, words }), null);
});

test('ranges pass the words of their take to the pause search of edges and joints', () => {
  // Слова дубля доходят до поиска паузы и у отдельного края, и у общего разреза стыка: граница
  // между «Не» и «работает» остаётся на месте и печатается как граница без паузы.
  const { analysis, words } = gluedNot();
  const analyses = new Map([['take-01', analysis]]);
  const wordsByTake = new Map([['take-01', words]]);
  const single = snapRangesToPauses(
    [{ take: 'take-01', start: 0, end: 2.22, beat: 'A', reason: 'x' }],
    { takes: twoTakes(), analyses, fps: 25, wordsByTake },
  );
  assert.deepEqual(single.ranges.map((range) => [range.start, range.end]), [[0, 2.22]]);
  assert.deepEqual(single.adjustments, [{ index: 0, edge: 'end', from: 2.22, to: 2.22, reason: 'no-pause' }]);
  const joint = snapRangesToPauses([
    { take: 'take-01', start: 0, end: 2.22, beat: 'A', reason: 'x' },
    { take: 'take-01', start: 2.22, end: 3, beat: 'B', reason: 'y' },
  ], { takes: twoTakes(), analyses, fps: 25, wordsByTake });
  assert.deepEqual(joint.ranges.map((range) => [range.start, range.end]), [[0, 2.22], [2.22, 3]]);
  assert.deepEqual(joint.adjustments.map(({ index, edge, reason }) => [index, edge, reason]), [
    [0, 'end', 'no-pause'], [1, 'start', 'no-pause'],
  ]);
});

test('a short dip blocks the pause behind it and the midpoint lets the other side through', () => {
  // Пауза 0.90-1.02, звук 1.02-1.05, провал 30 мс, звук 1.08-1.20, пауза 1.20-1.35.
  const analysis = analyzeLevels(levelsWithPauses([[0.9, 1.02], [1.05, 1.08], [1.2, 1.35]]));
  // В 1.10 большая часть звука до паузы 1.20 лежит впереди, а назад путь идёт через провал:
  // паузы нет.
  assert.equal(findPauseCut(analysis, 1.1, 'end', { fps: 25 }), null);
  // В 1.15 назад по-прежнему мешает провал, а впереди осталась меньшая часть звука: разрез уходит
  // вперёд.
  assert.equal(findPauseCut(analysis, 1.15, 'end', { fps: 25 }), 1.28);
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
  assert.deepEqual(result.ranges.map(({ start, end }) => [start, end]), [[0, 1.2], [1.2, 2.6], [0.4, 0.6]]);
  assert.equal(result.ranges[0].beat, 'A');
  assert.deepEqual(result.adjustments, [
    { index: 0, edge: 'end', from: 1.36, to: 1.2, reason: 'pause' },
    { index: 1, edge: 'start', from: 1.36, to: 1.2, reason: 'pause' },
    { index: 1, edge: 'end', from: 2.4, to: 2.6, reason: 'pause' },
    { index: 2, edge: 'start', from: 0.4, to: 0.4, reason: 'no-pause' },
    { index: 2, edge: 'end', from: 0.6, to: 0.6, reason: 'no-pause' },
  ]);
});

test('touching pieces of one take share one cut at the pause edge near the joint', () => {
  // Длинная пауза 0.50-1.00, стык в 1.03 у начала речи. Порознь конец первого куска встал бы в
  // начале паузы, а начало второго у её конца, и между кусками выпал бы кусок дубля. Общий разрез
  // встаёт у края паузы, ближнего к стыку, и куски продолжают друг друга.
  const analysis = analyzeLevels(levelsWithPauses([[0.5, 1]]));
  const result = snapRangesToPauses([
    { take: 'take-01', start: 0.2, end: 1.03, beat: 'A', reason: 'x' },
    { take: 'take-01', start: 1.03, end: 2.9, beat: 'B', reason: 'y' },
  ], { takes: twoTakes(), analyses: new Map([['take-01', analysis]]), fps: 25 });
  assert.deepEqual(result.ranges.map(({ start, end }) => [start, end]), [[0.2, 0.92], [0.92, 2.9]]);
  assert.equal(result.ranges[0].end, result.ranges[1].start);
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
    [[0, 'end', 'kept'], [1, 'start', 'kept'], [1, 'end', 'kept']],
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

test('pieces of one take less than a frame apart share one cut', () => {
  // Та же длинная пауза 0.50-1.00, куски расходятся на 10 мс (1.02 и 1.03): это тоже один стык.
  const pause = analyzeLevels(levelsWithPauses([[0.5, 1]]));
  const shared = snapRangesToPauses([
    { take: 'take-01', start: 0.2, end: 1.02, beat: 'A', reason: 'x' },
    { take: 'take-01', start: 1.03, end: 2.9, beat: 'B', reason: 'y' },
  ], { takes: twoTakes(), analyses: new Map([['take-01', pause]]), fps: 25 });
  assert.deepEqual(shared.ranges.map(({ start, end }) => [start, end]), [[0.2, 0.92], [0.92, 2.9]]);
  // Стык 1.205 почти в середине звука 1.10-1.30 паузы не получает. Порознь начало второго куска
  // ушло бы в паузу 1.30-1.40 и выбросило бы конец слова, а общий разрез держит оба края на месте.
  const word = analyzeLevels(levelsWithPauses([[1, 1.1], [1.3, 1.4]]));
  const blocked = snapRangesToPauses([
    { take: 'take-01', start: 0.2, end: 1.2, beat: 'A', reason: 'x' },
    { take: 'take-01', start: 1.21, end: 2.9, beat: 'B', reason: 'y' },
  ], { takes: twoTakes(), analyses: new Map([['take-01', word]]), fps: 25 });
  assert.deepEqual(blocked.ranges.map(({ start, end }) => [start, end]), [[0.2, 1.2], [1.21, 2.9]]);
  // Оба края стыка печатаются как граница без паузы, чтобы агент проверил их.
  assert.deepEqual(
    blocked.adjustments.map(({ index, edge, reason }) => [index, edge, reason]),
    [
      [0, 'start', 'no-pause'], [0, 'end', 'no-pause'],
      [1, 'start', 'no-pause'], [1, 'end', 'no-pause'],
    ],
  );
});

test('a joint cut stays at the near edge of a long pause', () => {
  const analysis = analyzeLevels(levelsWithPauses([[5.2, 9.2]], { duration: 12 }));
  const takes = new Map([['take-01', { id: 'take-01', duration: 12, usableStart: 0 }]]);
  const result = snapRangesToPauses([
    { take: 'take-01', start: 3, end: 5, beat: 'A', reason: 'x' },
    { take: 'take-01', start: 5, end: 10.5, beat: 'B', reason: 'y' },
  ], { takes, analyses: new Map([['take-01', analysis]]), fps: 25 });
  assert.deepEqual(result.ranges.map(({ start, end }) => [start, end]), [[3, 5.32], [5.32, 10.5]]);
});

test('a collapsing piece reverts its joint partner too, so no speech falls between them', () => {
  const analysis = analyzeLevels(levelsWithPauses([[1, 1.1]]));
  const result = snapRangesToPauses([
    { take: 'take-01', start: 0.2, end: 1.2, beat: 'A', reason: 'x' },
    { take: 'take-01', start: 1.2, end: 1.3, beat: 'B', reason: 'y' },
  ], { takes: twoTakes(), analyses: new Map([['take-01', analysis]]), fps: 25 });
  assert.deepEqual(result.ranges.map(({ start, end }) => [start, end]), [[0.2, 1.2], [1.2, 1.3]]);
  assert.deepEqual(
    result.adjustments.map(({ index, edge, reason }) => [index, edge, reason]),
    [[0, 'start', 'no-pause'], [0, 'end', 'kept'], [1, 'start', 'kept'], [1, 'end', 'kept']],
  );
});

test('the collapse check uses the part of a piece that fits the take', () => {
  const analysis = analyzeLevels(levelsWithPauses([[9.91, 10.11]], { duration: 11 }));
  const takes = new Map([['take-01', { id: 'take-01', duration: 10, usableStart: 0 }]]);
  const result = snapRangesToPauses(
    [{ take: 'take-01', start: 9.8, end: 10.2, beat: 'A', reason: 'x' }],
    { takes, analyses: new Map([['take-01', analysis]]), fps: 25 },
  );
  assert.deepEqual(result.ranges.map(({ start, end }) => [start, end]), [[9.8, 10.2]]);
  assert.deepEqual(result.adjustments.map(({ edge, reason }) => [edge, reason]), [['start', 'kept']]);
});

test('a reverted range reports only edges that pause cuts moved', () => {
  const analysis = analyzeLevels(speechLevels());
  // Первый кусок уходит концом в паузу 2.5-3.0 и налезает на второй, поэтому оба возвращаются.
  // Край без паузы остаётся no-pause, а конец второго куска у конца файла не двигался и молчит.
  const result = snapRangesToPauses([
    { take: 'take-01', start: 0.4, end: 2.4, beat: 'A', reason: 'x' },
    { take: 'take-01', start: 2.55, end: 2.98, beat: 'B', reason: 'y' },
  ], { takes: twoTakes(), analyses: new Map([['take-01', analysis]]), fps: 25 });
  assert.deepEqual(result.ranges.map(({ start, end }) => [start, end]), [[0.4, 2.4], [2.55, 2.98]]);
  assert.deepEqual(result.adjustments, [
    { index: 0, edge: 'start', from: 0.4, to: 0.4, reason: 'no-pause' },
    { index: 0, edge: 'end', from: 2.4, to: 2.4, reason: 'kept' },
    { index: 1, edge: 'start', from: 2.55, to: 2.55, reason: 'kept' },
  ]);
});

test('a pause target before the usable start of the take is not reported as a pause', () => {
  const analysis = analyzeLevels(levelsWithPauses([[0, 0.15]], { duration: 3 }));
  const takes = new Map([['take-01', { id: 'take-01', duration: 3, usableStart: 0.2 }]]);
  const result = snapRangesToPauses(
    [{ take: 'take-01', start: 0.3, end: 2.5, beat: 'A', reason: 'x' }],
    { takes, analyses: new Map([['take-01', analysis]]), fps: 25 },
  );
  assert.equal(result.ranges[0].start, 0.3);
  assert.deepEqual(result.adjustments, [
    { index: 0, edge: 'start', from: 0.3, to: 0.3, reason: 'no-pause' },
    { index: 0, edge: 'end', from: 2.5, to: 2.5, reason: 'no-pause' },
  ]);
});

test('a pause target past the usable end of the take is not reported as a pause', () => {
  const analysis = analyzeLevels(levelsWithPauses([[3.05, 3.4]], { duration: 3.4 }));
  const takes = new Map([['take-01', { id: 'take-01', duration: 3, usableStart: 0 }]]);
  const result = snapRangesToPauses(
    [{ take: 'take-01', start: 1, end: 2.9, beat: 'A', reason: 'x' }],
    { takes, analyses: new Map([['take-01', analysis]]), fps: 25 },
  );
  assert.equal(result.ranges[0].end, 2.9);
  assert.deepEqual(result.adjustments, [
    { index: 0, edge: 'start', from: 1, to: 1, reason: 'no-pause' },
    { index: 0, edge: 'end', from: 2.9, to: 2.9, reason: 'no-pause' },
  ]);
});

test('readTakeLevels decodes mono 16 kHz PCM on the trim axis and removes its temp dir', () => {
  const calls = [];
  let tempDir = null;
  const levels = readTakeLevels('clip.mp4', {
    runToolImpl(command, args, options) {
      calls.push({ command, args, options });
      const pcmPath = args[args.indexOf('s16le') + 1];
      tempDir = path.dirname(pcmPath);
      fs.writeFileSync(pcmPath, Buffer.alloc(320 * 2));
    },
  });
  const { args } = calls[0];
  const pcmPath = args[args.indexOf('s16le') + 1];
  assert.equal(calls[0].command, 'ffmpeg');
  // -map 0:a:0 pins the first audio track right after the input, exactly like trim's [N:a].
  assert.deepEqual(args.slice(0, 7), ['-v', 'error', '-y', '-i', path.resolve('clip.mp4'), '-map', '0:a:0']);
  assert.deepEqual(args.slice(7, 15), [
    '-af', 'aresample=async=1:min_hard_comp=0:first_pts=0',
    '-ac', '1', '-ar', '16000', '-f', 's16le',
  ]);
  assert.equal(args[15], pcmPath);
  // The second null output keeps the video stream in use so MPEG-TS does not recompute the
  // start time from audio alone, without spending time decoding frames we do not need.
  assert.deepEqual(args.slice(-7), ['-map', '0:v:0?', '-c', 'copy', '-f', 'null', '-']);
  assert.equal(calls[0].options.stage, 'take levels');
  assert.deepEqual(levels, { frameSec: 0.01, levels: [-120, -120] });
  assert.equal(fs.existsSync(tempDir), false);
});

test('readTakeLevels rethrows a failed decode and still removes its temp dir', () => {
  const created = [];
  const fileSystem = {
    ...fs,
    mkdtempSync(prefix) {
      const directory = fs.mkdtempSync(prefix);
      created.push(directory);
      return directory;
    },
  };
  assert.throws(() => readTakeLevels('clip.mp4', {
    fileSystem,
    runToolImpl() {
      throw new Error('ffmpeg failed');
    },
  }), /ffmpeg failed/);
  assert.equal(created.length, 1);
  assert.equal(fs.existsSync(created[0]), false);
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

test('real levels keep the leading gap of a late-audio take on the trim axis', { timeout: 60_000 }, (t) => {
  if (!toolAvailable('ffmpeg') || !ffmpegEncoderAvailable('libx264')) {
    t.skip('real levels require ffmpeg and libx264');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-take-levels-late-audio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Video runs 0-4 s. The audio input is delayed 0.5 s by -itsoffset, so its own pattern
  // (tone 0-1 s, pause 1.0-1.3 s, tone 1.3-3 s) lands on the container/trim axis shifted by
  // 0.5 s: tone 0.5-1.5 s, pause 1.5-1.8 s, tone 1.8-3.5 s. Without -copyts, MPEG-TS recomputes
  // the start time from the streams ffmpeg actually decodes: dropping the video (-vn) used to
  // move the start to the first audio sample at 0.5 s and erase this leading gap.
  for (const extension of ['ts', 'mp4']) {
    const take = path.join(dir, `late-audio.${extension}`);
    runFixture('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=4',
      '-itsoffset', '0.5', '-f', 'lavfi', '-i', "aevalsrc='if(lt(t,1)+between(t,1.3,3),0.3*sin(2*PI*440*t),0)':s=48000:d=3",
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', take,
    ], dir);
    const analysis = analyzeLevels(readTakeLevels(take));
    assert.equal(isSilentSpan(analysis, 1.55, 1.75), true, extension);
    assert.equal(isSilentSpan(analysis, 1.05, 1.25), false, extension);
  }
});
