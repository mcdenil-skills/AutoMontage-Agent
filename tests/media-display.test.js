const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { ffmpegEncoderAvailable, toolAvailable } = require('./helpers/media-fixtures');
const { displayDimensions, probeMediaPath } = require('../scripts/media-probe');

test('quarter-turn rotation swaps displayed dimensions', () => {
  assert.deepEqual(displayDimensions({ width: 1920, height: 1080, rotation: 90 }), { width: 1080, height: 1920 });
  assert.deepEqual(displayDimensions({ width: 1920, height: 1080, rotation: 270 }), { width: 1080, height: 1920 });
  assert.deepEqual(displayDimensions({ width: 1920, height: 1080, rotation: 180 }), { width: 1920, height: 1080 });
  assert.deepEqual(displayDimensions({ width: 1920, height: 1080 }), { width: 1920, height: 1080 });
});

test('probeMediaPath probes a regular file by path and refuses symbolic links', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-probe-path-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'clip.mp4');
  fs.writeFileSync(file, 'MEDIA');
  const probeJson = JSON.stringify({
    streams: [{
      codec_type: 'video',
      codec_name: 'h264',
      width: 160,
      height: 90,
      avg_frame_rate: '25/1',
      r_frame_rate: '25/1',
      duration: '3.000000',
    }],
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '3.000000' },
  });
  let seen = null;
  const result = probeMediaPath(file, {
    stage: 'take probe',
    captureToolImpl(command, args, options) {
      seen = { command, args, options };
      return probeJson;
    },
  });
  assert.equal(seen.command, 'ffprobe');
  assert.equal(seen.args.at(-1), path.resolve(file));
  assert.equal(seen.options.stage, 'take probe');
  assert.equal(result.width, 160);
  assert.equal(result.height, 90);
  assert.equal(result.rotation, 0);
  assert.equal(result.videoDurationSec, 3);
  if (process.platform !== 'win32') {
    const link = path.join(dir, 'link.mp4');
    fs.symlinkSync(file, link);
    assert.throws(
      () => probeMediaPath(link, { captureToolImpl: () => { throw new Error('must not probe'); } }),
      /symbolic link/,
    );
  }
  assert.throws(
    () => probeMediaPath(dir, { captureToolImpl: () => { throw new Error('must not probe'); } }),
    /symbolic link/,
  );
});

test('probeMediaPath reports the offset between the video and audio start_time', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-probe-start-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'late.mp4');
  fs.writeFileSync(file, 'MEDIA');
  const probeJson = JSON.stringify({
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: 160,
        height: 90,
        avg_frame_rate: '25/1',
        r_frame_rate: '25/1',
        duration: '3.000000',
        start_time: '0.040000',
      },
      {
        codec_type: 'audio',
        codec_name: 'aac',
        sample_rate: '48000',
        channels: 2,
        duration: '3.000000',
        start_time: '0.000000',
      },
    ],
    format: {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '3.000000', start_time: '0.000000',
    },
  });
  let seen = null;
  const result = probeMediaPath(file, {
    stage: 'take probe',
    captureToolImpl(command, args, options) {
      seen = { command, args, options };
      return probeJson;
    },
  });
  assert.ok(seen.args.includes('-show_entries'));
  assert.ok(seen.args.some((arg) => String(arg).includes('start_time')));
  assert.ok(Math.abs(result.startOffsetSec - 0.04) < 1e-9);
});

test('probeMediaPath reduces sample_aspect_ratio and normalizes missing or unset values to 1:1', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-probe-sar-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'clip.mp4');
  fs.writeFileSync(file, 'MEDIA');

  function probeWithSar(sampleAspectRatio) {
    const stream = {
      codec_type: 'video',
      codec_name: 'h264',
      width: 160,
      height: 90,
      avg_frame_rate: '25/1',
      r_frame_rate: '25/1',
      duration: '3.000000',
    };
    if (sampleAspectRatio !== undefined) stream.sample_aspect_ratio = sampleAspectRatio;
    let seen = null;
    const result = probeMediaPath(file, {
      stage: 'take probe',
      captureToolImpl(command, args, options) {
        seen = { command, args, options };
        return JSON.stringify({
          streams: [stream],
          format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '3.000000' },
        });
      },
    });
    return { result, seen };
  }

  const reduced = probeWithSar('8:6');
  assert.equal(reduced.result.sampleAspectRatio, '4:3');
  assert.ok(reduced.seen.args.includes('-show_entries'));
  assert.ok(reduced.seen.args.some((arg) => String(arg).includes('sample_aspect_ratio')));

  assert.equal(probeWithSar('0:1').result.sampleAspectRatio, '1:1');
  assert.equal(probeWithSar(undefined).result.sampleAspectRatio, '1:1');
});

test('probeMediaPath fills missing stream durations from the container', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-probe-flv-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'clip.flv');
  fs.writeFileSync(file, 'MEDIA');
  const streamsWithoutDuration = [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 160,
      height: 90,
      avg_frame_rate: '25/1',
      r_frame_rate: '25/1',
    },
    {
      codec_type: 'audio',
      codec_name: 'aac',
      sample_rate: '48000',
      channels: 2,
    },
  ];
  const media = probeMediaPath(file, {
    containerDurationFallback: true,
    captureToolImpl: () => JSON.stringify({
      streams: streamsWithoutDuration,
      format: { format_name: 'flv', duration: '3.000000' },
    }),
  });
  assert.equal(media.videoDurationSec, 3);
  assert.equal(media.audioDurationSec, 3);

  assert.throws(
    () => probeMediaPath(file, {
      containerDurationFallback: true,
      captureToolImpl: () => JSON.stringify({
        streams: streamsWithoutDuration,
        format: { format_name: 'flv' },
      }),
    }),
    /video stream duration/,
  );

  // The fallback is opt-in: without it, the same container-only JSON must still fail closed
  // (master needs geometry/rotation only; take duplication needs the true, shortest stream length).
  assert.throws(
    () => probeMediaPath(file, {
      captureToolImpl: () => JSON.stringify({
        streams: streamsWithoutDuration,
        format: { format_name: 'flv', duration: '3.000000' },
      }),
    }),
    /video stream duration/,
  );
});

test('real probe by path accepts FLV whose streams carry no duration', { timeout: 60_000 }, (t) => {
  if (!toolAvailable('ffmpeg') || !toolAvailable('ffprobe') || !ffmpegEncoderAvailable('libx264')) {
    t.skip('FLV container-only duration probe requires ffmpeg, ffprobe and libx264');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-probe-flv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clipFlv = path.join(dir, 'clip.flv');
  const encode = spawnSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    clipFlv,
  ], { encoding: 'utf8' });
  assert.equal(encode.status, 0, encode.stderr);

  // Without the opt-in fallback, this fixture must fail closed: proves it genuinely carries
  // no per-stream duration, not just that the fallback happens to produce a plausible number.
  assert.throws(
    () => probeMediaPath(clipFlv, { stage: 'flv probe' }),
    /video stream duration/,
  );

  const media = probeMediaPath(clipFlv, { stage: 'flv probe', containerDurationFallback: true });
  assert.ok(
    Math.abs(media.videoDurationSec - 3) < 0.1,
    `expected videoDurationSec near 3, got ${media.videoDurationSec}`,
  );
  assert.deepEqual(displayDimensions(media), { width: 160, height: 90 });
});

test('real rotated clip reports displayed portrait dimensions', { timeout: 60_000 }, (t) => {
  if (!toolAvailable('ffmpeg') || !toolAvailable('ffprobe')) {
    t.skip('rotation probe requires ffmpeg and ffprobe');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-rotation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = path.join(dir, 'base.mp4');
  const rotated = path.join(dir, 'rotated.mp4');
  const encode = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=0.4', '-pix_fmt', 'yuv420p', base], { encoding: 'utf8' });
  assert.equal(encode.status, 0, encode.stderr);
  const rotate = spawnSync('ffmpeg', ['-y', '-v', 'error', '-display_rotation', '90', '-i', base, '-c', 'copy', rotated], { encoding: 'utf8' });
  if (rotate.status !== 0) {
    t.skip('ffmpeg lacks -display_rotation fixture support');
    return;
  }
  const media = probeMediaPath(rotated, { stage: 'rotation probe' });
  assert.equal(media.rotation, 90);
  assert.deepEqual(displayDimensions(media), { width: 90, height: 160 });
});

test('real probe by path reads full durations of fragmented MP4 and MPEG-TS takes', { timeout: 60_000 }, (t) => {
  if (!toolAvailable('ffmpeg') || !toolAvailable('ffprobe') || !ffmpegEncoderAvailable('libx264')) {
    t.skip('container probe requires ffmpeg, ffprobe and libx264');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-probe-containers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const fragMp4 = path.join(dir, 'frag.mp4');
  const frag = spawnSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=3',
    '-c:v', 'libx264', '-g', '25', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    '-movflags', 'frag_keyframe+empty_moov',
    fragMp4,
  ], { encoding: 'utf8' });
  assert.equal(frag.status, 0, frag.stderr);

  const clipMts = path.join(dir, 'clip.mts');
  const mts = spawnSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=3',
    '-c:v', 'libx264', '-g', '25', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    clipMts,
  ], { encoding: 'utf8' });
  assert.equal(mts.status, 0, mts.stderr);

  for (const file of [fragMp4, clipMts]) {
    const media = probeMediaPath(file, { stage: 'container probe' });
    assert.ok(
      Math.abs(media.videoDurationSec - 3) < 0.05,
      `${path.basename(file)}: expected videoDurationSec near 3, got ${media.videoDurationSec}`,
    );
    assert.ok(
      media.audioDurationSec > 2.5 && media.audioDurationSec < 3.2,
      `${path.basename(file)}: expected audioDurationSec in (2.5, 3.2), got ${media.audioDurationSec}`,
    );
    assert.deepEqual(
      displayDimensions(media),
      { width: 160, height: 90 },
      `${path.basename(file)}: expected display dimensions 160x90`,
    );
  }
});

test('real probe reports the start_time offset of a video stream delayed against audio', { timeout: 60_000 }, (t) => {
  if (!toolAvailable('ffmpeg') || !toolAvailable('ffprobe') || !ffmpegEncoderAvailable('libx264')) {
    t.skip('start_time offset probe requires ffmpeg, ffprobe and libx264');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-probe-start-real-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const late = path.join(dir, 'late.mp4');
  // FFmpeg 6.x по умолчанию (vsync cfr для MP4) заполняет первые 0.04 с копией первого кадра, и
  // видео начинается в 0 вместе со звуком; passthrough сохраняет задержку и на 7+ ничего не меняет.
  const encode = spawnSync('ffmpeg', [
    '-y', '-v', 'error',
    '-itsoffset', '0.04', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough',
    '-c:a', 'aac', '-shortest',
    late,
  ], { encoding: 'utf8' });
  assert.equal(encode.status, 0, encode.stderr);

  const media = probeMediaPath(late, { stage: 'start offset probe' });
  assert.ok(
    Math.abs(media.startOffsetSec - 0.04) < 0.002,
    `expected startOffsetSec near 0.04, got ${media.startOffsetSec}`,
  );
});
