const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  ffmpegEncoderAvailable,
  runTool: runFixture,
  toolAvailable,
} = require('./helpers/media-fixtures');
const { runSegmentsTrim, runTrim } = require('../scripts/trim-media');

test('real runTrim encodes with the installed ffmpeg major version', { timeout: 120_000 }, (t) => {
  if (!toolAvailable('ffmpeg') || !toolAvailable('ffprobe') || !ffmpegEncoderAvailable('libx264')) {
    t.skip('real trim requires ffmpeg, ffprobe and libx264');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-trim-real-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'input.mp4');
  const output = path.join(dir, 'output.mp4');
  runFixture('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', input,
  ], dir);

  runTrim({ input, output, intervals: [[0.2, 1], [1.6, 2.4]], audioFadeSec: 0.04, precision: 6 });

  const probe = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', output,
  ], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  assert.ok(Math.abs(Number(probe.stdout) - 1.6) < 0.1, probe.stdout);
});

test('real segments concat keeps whole frames from a jittered variable-frame-rate take', { timeout: 180_000 }, (t) => {
  if (!toolAvailable('ffmpeg') || !toolAvailable('ffprobe') || !ffmpegEncoderAvailable('libx264')) {
    t.skip('real segments concat requires ffmpeg, ffprobe and libx264');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-trim-vfr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'input.mp4');
  const output = path.join(dir, 'output.mp4');

  // Дубль 13 с с номинальными 30 fps и нарочно неровными таймстемпами: setpts считает в таймбейзе
  // 1/30 и отбрасывает дробную часть, поэтому детерминированный random(1) даёт повторы и пропуски
  // кадров, как у съёмки с переменной частотой. Старый порядок trim,setpts,fps терял здесь 3 кадра.
  runFixture('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=13',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=13',
    '-vf', "setpts='(N/30+(random(1)-0.5)*0.001)/TB'",
    '-fps_mode', 'passthrough', '-enc_time_base', '1/90000', '-video_track_timescale', '90000',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-shortest', input,
  ], dir);

  const segmentFrames = [
    [5, 18], [29, 39], [75, 25], [109, 37], [148, 39], [190, 15],
    [215, 11], [230, 10], [242, 30], [281, 34], [323, 11], [341, 24],
  ];
  const totalFrames = segmentFrames.reduce((sum, [, count]) => sum + count, 0);
  const segments = segmentFrames.map(([startFrame, frameCount]) => ({
    input: 0,
    start: startFrame / 30,
    end: (startFrame + frameCount) / 30,
  }));

  runSegmentsTrim({
    inputs: [input],
    output,
    segments,
    audioFadeSec: 0.04,
    precision: 6,
    fps: '30/1',
    audioFormat: { sampleRate: 48000, channelLayout: 'stereo' },
  });

  const probe = spawnSync('ffprobe', [
    '-v', 'error', '-count_frames',
    '-show_entries', 'stream=codec_type,nb_read_frames,duration',
    '-of', 'json', output,
  ], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  const streams = JSON.parse(probe.stdout).streams;
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');

  assert.equal(Number(video.nb_read_frames), totalFrames, JSON.stringify(video));
  const drift = Math.abs(Number(audio.duration) - Number(video.duration));
  assert.ok(drift < 0.02, `audio/video duration drift too large: ${drift} (audio=${audio.duration}, video=${video.duration})`);
});
