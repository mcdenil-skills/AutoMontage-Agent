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

test('a short pause of the live probe still yields a frame cut inside it', () => {
  const analysis = analyzeLevels(levelsWithPauses([[3.46, 3.54]], { duration: 5 }));
  assert.equal(findPauseCut(analysis, 3.57, 'end', { fps: 25 }), 3.52);
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

test('pieces of one take less than a frame apart share one cut', () => {
  const analysis = analyzeLevels(levelsWithPauses([[1, 1.1], [1.3, 1.4]]));
  const result = snapRangesToPauses([
    { take: 'take-01', start: 0.2, end: 1.2, beat: 'A', reason: 'x' },
    { take: 'take-01', start: 1.21, end: 2.9, beat: 'B', reason: 'y' },
  ], { takes: twoTakes(), analyses: new Map([['take-01', analysis]]), fps: 25 });
  assert.deepEqual(result.ranges.map(({ start, end }) => [start, end]), [[0.2, 1.36], [1.36, 2.9]]);
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
    [[0, 'start', 'kept'], [0, 'end', 'kept'], [1, 'start', 'kept'], [1, 'end', 'kept']],
  );
});

test('the collapse check uses the part of a piece that fits the take', () => {
  const analysis = analyzeLevels(levelsWithPauses([[9.95, 10.15]], { duration: 11 }));
  const takes = new Map([['take-01', { id: 'take-01', duration: 10, usableStart: 0 }]]);
  const result = snapRangesToPauses(
    [{ take: 'take-01', start: 9.8, end: 10.2, beat: 'A', reason: 'x' }],
    { takes, analyses: new Map([['take-01', analysis]]), fps: 25 },
  );
  assert.deepEqual(result.ranges.map(({ start, end }) => [start, end]), [[9.8, 10.2]]);
  assert.deepEqual(result.adjustments.map(({ edge, reason }) => [edge, reason]), [['start', 'kept'], ['end', 'kept']]);
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
