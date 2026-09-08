const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseAudioProbeJson,
  parseMediaProbeJson,
  parseVideoProbe,
  probeOpenedAudio,
} = require('../scripts/media-probe');

function validProbe(overrides = {}) {
  return JSON.stringify({
    streams: [{
      codec_type: 'video',
      width: 1920,
      height: 1080,
      r_frame_rate: '25/1',
      duration: '14.0',
      ...overrides,
    }],
    format: { duration: '14.0' },
  });
}

test('video probe parses finite geometry, FPS and duration', () => {
  assert.deepEqual(parseVideoProbe(validProbe(), 'source probe'), {
    width: 1920,
    height: 1080,
    fps: 25,
    duration: 14,
  });
});

test('video probe fails cleanly on empty, malformed or missing video JSON', () => {
  for (const input of ['', '{broken', '{"streams":[],"format":{"duration":"1"}}']) {
    assert.throws(() => parseVideoProbe(input, 'source probe'), /source probe/);
  }
});

test('video probe rejects invalid FPS and non-positive durations', () => {
  for (const rate of ['25/0', 'N/A', 'NaN', 'Infinity', '0/1']) {
    assert.throws(() => parseVideoProbe(validProbe({ r_frame_rate: rate }), 'source probe'), /source probe.*FPS/);
  }
  for (const duration of ['0', '-1', 'N/A', 'NaN', 'Infinity']) {
    const input = JSON.stringify({
      streams: [{ codec_type: 'video', width: 10, height: 10, r_frame_rate: '25/1' }],
      format: { duration },
    });
    assert.throws(() => parseVideoProbe(input, 'source probe'), /source probe.*duration/);
  }
});

test('media probe distinguishes still images and reports audio, VFR timing, and rotation', () => {
  const probe = JSON.stringify({
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: 1080,
        height: 1920,
        avg_frame_rate: '24000/1001',
        r_frame_rate: '30/1',
        duration: '11.75',
        pix_fmt: 'yuv420p',
        side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }],
      },
      {
        codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2,
        duration: '8.25',
      },
    ],
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '12.5' },
  });
  assert.deepEqual(parseMediaProbeJson(probe), {
    mediaKind: 'video',
    width: 1080,
    height: 1920,
    fps: 24000 / 1001,
    durationSec: 11.75,
    containerDurationSec: 12.5,
    videoDurationSec: 11.75,
    audioDurationSec: 8.25,
    hasAudio: true,
    rotation: 270,
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    videoCodec: 'h264',
    pixelFormat: 'yuv420p',
    hasAlpha: false,
    audioCodec: 'aac',
    audioSampleRate: 48000,
    audioChannels: 2,
  });

  assert.deepEqual(parseMediaProbeJson(JSON.stringify({
    streams: [{
      codec_type: 'video', codec_name: 'png', width: 640, height: 480,
      r_frame_rate: '25/1', pix_fmt: 'rgba',
    }],
    format: { format_name: 'png_pipe' },
  })), {
    mediaKind: 'image',
    width: 640,
    height: 480,
    fps: 0,
    durationSec: 0,
    containerDurationSec: null,
    videoDurationSec: null,
    audioDurationSec: null,
    hasAudio: false,
    rotation: 0,
    container: 'png_pipe',
    videoCodec: 'png',
    pixelFormat: 'rgba',
    hasAlpha: true,
    audioCodec: null,
    audioSampleRate: null,
    audioChannels: null,
  });
});

test('media probe prefers a valid average video frame rate', () => {
  const parsed = parseMediaProbeJson(JSON.stringify({
    streams: [{
      codec_type: 'video', codec_name: 'h264', width: 320, height: 180,
      avg_frame_rate: '24000/1001', r_frame_rate: '30/1', duration: '1',
    }],
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1' },
  }));
  assert.equal(parsed.fps, 24000 / 1001);
});

test('media probe falls back to a valid real frame rate when average is unusable', () => {
  for (const avgFrameRate of [undefined, '', '0/0', 'N/A', '25/0']) {
    const parsed = parseMediaProbeJson(JSON.stringify({
      streams: [{
        codec_type: 'video', codec_name: 'h264', width: 320, height: 180,
        avg_frame_rate: avgFrameRate, r_frame_rate: '30000/1001', duration: '1',
      }],
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1' },
    }));
    assert.equal(parsed.fps, 30000 / 1001, String(avgFrameRate));
  }
});

test('media probe keeps the exact FPS error when average and real rates are invalid', () => {
  assert.throws(() => parseMediaProbeJson(JSON.stringify({
    streams: [{
      codec_type: 'video', codec_name: 'h264', width: 320, height: 180,
      avg_frame_rate: '0/0', r_frame_rate: 'N/A', duration: '1',
    }],
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1' },
  })), (error) => error.message === 'media probe: ffprobe вернул недопустимое FPS');
});

test('media probe never substitutes container or audio duration for visual stream duration', () => {
  const mismatched = parseMediaProbeJson(JSON.stringify({
    streams: [
      {
        codec_type: 'video', codec_name: 'h264', width: 320, height: 180,
        avg_frame_rate: '25/1', r_frame_rate: '25/1', duration: '1.000000',
        pix_fmt: 'yuv420p',
      },
      {
        codec_type: 'audio', codec_name: 'aac', duration: '3.000000',
        sample_rate: '48000', channels: 2,
      },
    ],
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '3.000000' },
  }));
  assert.equal(mismatched.durationSec, 1);
  assert.equal(mismatched.videoDurationSec, 1);
  assert.equal(mismatched.audioDurationSec, 3);
  assert.equal(mismatched.containerDurationSec, 3);

  for (const duration of [undefined, 'N/A', 'NaN', '0', '-1']) {
    const raw = JSON.stringify({
      streams: [
        {
          codec_type: 'video', codec_name: 'h264', width: 320, height: 180,
          avg_frame_rate: '25/1', r_frame_rate: '25/1', duration,
        },
        { codec_type: 'audio', codec_name: 'aac', duration: '3', sample_rate: '48000', channels: 2 },
      ],
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '3' },
    });
    assert.throws(
      () => parseMediaProbeJson(raw),
      /media probe.*video stream duration/i,
    );
  }
});

test('media probe recognizes AVIF brand but keeps renamed AV1 video as video', () => {
  const av1Stream = {
    codec_type: 'video', codec_name: 'av1', width: 64, height: 48,
    avg_frame_rate: '1/1', r_frame_rate: '1/1', duration: '1', pix_fmt: 'yuv420p',
  };
  const still = parseMediaProbeJson(JSON.stringify({
    streams: [av1Stream],
    format: {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      tags: { major_brand: 'avif', compatible_brands: 'avifmif1miafMA1B' },
    },
  }));
  assert.equal(still.mediaKind, 'image');
  assert.deepEqual([still.fps, still.durationSec, still.hasAudio], [0, 0, false]);

  const renamedVideo = parseMediaProbeJson(JSON.stringify({
    streams: [{ ...av1Stream, avg_frame_rate: '25/1', r_frame_rate: '25/1' }],
    format: {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      duration: '1',
      tags: { major_brand: 'isom', compatible_brands: 'isomav01iso2mp41' },
    },
  }));
  assert.equal(renamedVideo.mediaKind, 'video');

  const crossBoundaryLookalike = parseMediaProbeJson(JSON.stringify({
    streams: [{ ...av1Stream, avg_frame_rate: '25/1', r_frame_rate: '25/1' }],
    format: {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      duration: '1',
      tags: { major_brand: 'isom', compatible_brands: 'zzaviszz' },
    },
  }));
  assert.equal(crossBoundaryLookalike.mediaKind, 'video');
});

test('media probe rejects malformed JSON, attached-picture-only media, and invalid geometry', () => {
  for (const input of [
    '',
    '{broken',
    JSON.stringify({ streams: [], format: { format_name: 'mov', duration: '1' } }),
    JSON.stringify({
      streams: [{ codec_type: 'video', width: 640, height: 480, disposition: { attached_pic: 1 } }],
      format: { format_name: 'mp3', duration: '1' },
    }),
    JSON.stringify({
      streams: [{ codec_type: 'video', width: 0, height: 480, avg_frame_rate: '25/1' }],
      format: { format_name: 'mov', duration: '1' },
    }),
  ]) {
    assert.throws(() => parseMediaProbeJson(input), /media probe/i);
  }
});

test('audio probe returns the dedicated narration metadata shape', () => {
  assert.deepEqual(parseAudioProbeJson(JSON.stringify({
    streams: [{
      codec_type: 'audio',
      codec_name: 'mp3',
      sample_rate: '44100',
      channels: 1,
      duration: '50.633000',
    }],
    format: { duration: '50.700000' },
  })), {
    mediaKind: 'audio',
    durationSec: 50.633,
    sampleRate: 44100,
    channels: 1,
    codec: 'mp3',
  });
});

test('audio probe rejects malformed JSON, missing audio and invalid stream fields', () => {
  const validAudio = {
    codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, duration: '1.25',
  };
  const invalidJson = (error) => (
    error.message === 'audio probe: ffprobe вернул недопустимое JSON'
  );
  const cases = [
    ['', /audio probe.*JSON/i],
    ['{broken', /audio probe.*JSON/i],
    ['null', invalidJson],
    ['[]', invalidJson],
    ['"audio"', invalidJson],
    [JSON.stringify({ streams: [], format: { duration: '1' } }), /audio probe.*audio stream/i],
    [JSON.stringify({ streams: [{ codec_type: 'video' }], format: { duration: '1' } }), /audio probe.*audio stream/i],
    [JSON.stringify({ streams: [{ ...validAudio, duration: '0' }] }), /audio probe.*duration/i],
    [JSON.stringify({ streams: [{ ...validAudio, sample_rate: 'NaN' }] }), /audio probe.*sample rate/i],
    [JSON.stringify({ streams: [{ ...validAudio, channels: 0 }] }), /audio probe.*channels/i],
    [JSON.stringify({ streams: [{ ...validAudio, codec_name: '' }] }), /audio probe.*codec/i],
  ];

  for (const [raw, expected] of cases) {
    assert.throws(() => parseAudioProbeJson(raw), expected);
  }
});

test('audio probe reads an already-opened descriptor without enabling audio in media probe', () => {
  const raw = JSON.stringify({
    streams: [{
      codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '16000', channels: 1,
      duration_ts: '4000', time_base: '1/16000',
    }],
    format: { duration: '0.250000' },
  });
  let invocation;
  const parsed = probeOpenedAudio({
    fileDescriptor: 17,
    runToolImpl(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, signal: null, stdout: raw, stderr: '' };
    },
  });

  assert.deepEqual(parsed, {
    mediaKind: 'audio', durationSec: 0.25, sampleRate: 16000, channels: 1, codec: 'pcm_s16le',
  });
  assert.equal(invocation.command, 'ffprobe');
  assert.deepEqual(invocation.options.stdio, [17, 'pipe', 'pipe']);
  assert.throws(() => parseMediaProbeJson(raw), /primary video stream/i);
});
