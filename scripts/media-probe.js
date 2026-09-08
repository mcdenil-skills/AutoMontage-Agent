const { spawnSync } = require('node:child_process');

const { assertProcessResult, captureTool, hostPath } = require('./process');
const {
  fileSystemCapabilities,
  openReadOnlyFlags,
} = require('./filesystem-capabilities');

const OPENED_MEDIA_PROBE_ENTRIES = [
  'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,duration,duration_ts,time_base,pix_fmt,sample_rate,channels',
  'stream_tags=rotate,DURATION',
  'stream_disposition=attached_pic',
  'stream_side_data=rotation',
  'format=format_name,duration',
].join(':');
const OPENED_MEDIA_PROBE_MAX_BYTES = 1024 * 1024;

function sameOpenedFileSnapshot(left, right, platform = process.platform) {
  if (!left || !right || left.dev !== right.dev || left.ino !== right.ino
    || left.size !== right.size || left.mtimeNs !== right.mtimeNs
    || left.ctimeNs !== right.ctimeNs) return false;
  return !fileSystemCapabilities(platform).posixPermissions
    || (left.mode === right.mode && left.nlink === right.nlink);
}

function probeOpenedMedia({
  fileDescriptor,
  runToolImpl = spawnSync,
  stage = 'media probe',
} = {}) {
  if (!Number.isInteger(fileDescriptor) || fileDescriptor < 0) {
    throw new Error(`${stage}: opened media descriptor is invalid`);
  }
  const command = 'ffprobe';
  const args = [
    '-v', 'error',
    '-show_entries', OPENED_MEDIA_PROBE_ENTRIES,
    '-of', 'json',
    'pipe:0',
  ];
  const result = runToolImpl(command, args, {
    encoding: 'utf8',
    killSignal: 'SIGTERM',
    maxBuffer: OPENED_MEDIA_PROBE_MAX_BYTES,
    shell: false,
    stdio: [fileDescriptor, 'pipe', 'pipe'],
    timeout: 30_000,
  });
  const stdout = typeof result === 'string'
    ? result
    : assertProcessResult(result || {}, { command, stage }).stdout;
  if (typeof stdout !== 'string'
    || Buffer.byteLength(stdout, 'utf8') > OPENED_MEDIA_PROBE_MAX_BYTES) {
    throw new Error(`${stage}: ffprobe вернул недопустимое JSON`);
  }
  return parseMediaProbeJson(stdout);
}

function probeOpenedAudio({
  fileDescriptor,
  runToolImpl = spawnSync,
  stage = 'audio probe',
} = {}) {
  if (!Number.isInteger(fileDescriptor) || fileDescriptor < 0) {
    throw new Error(`${stage}: opened audio descriptor is invalid`);
  }
  const command = 'ffprobe';
  const args = [
    '-v', 'error',
    '-show_entries', OPENED_MEDIA_PROBE_ENTRIES,
    '-of', 'json',
    'cache:pipe:0',
  ];
  const result = runToolImpl(command, args, {
    encoding: 'utf8',
    killSignal: 'SIGTERM',
    maxBuffer: OPENED_MEDIA_PROBE_MAX_BYTES,
    shell: false,
    stdio: [fileDescriptor, 'pipe', 'pipe'],
    timeout: 30_000,
  });
  const stdout = typeof result === 'string'
    ? result
    : assertProcessResult(result || {}, { command, stage }).stdout;
  if (typeof stdout !== 'string'
    || Buffer.byteLength(stdout, 'utf8') > OPENED_MEDIA_PROBE_MAX_BYTES) {
    throw new Error(`${stage}: ffprobe вернул недопустимое JSON`);
  }
  return parseAudioProbeJson(stdout, stage);
}

function fail(stage, field) {
  throw new Error(`${stage}: ffprobe вернул недопустимое ${field}`);
}

function parseRate(value, stage) {
  const text = String(value ?? '');
  const parts = text.split('/');
  if (parts.length > 2 || parts.length === 0) fail(stage, 'FPS');
  const numerator = Number(parts[0]);
  const denominator = parts.length === 2 ? Number(parts[1]) : 1;
  const fps = numerator / denominator;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)
    || denominator === 0 || !Number.isFinite(fps) || fps <= 0) {
    fail(stage, 'FPS');
  }
  return fps;
}

function preferredVideoRate(video, stage) {
  try {
    return parseRate(video?.avg_frame_rate, stage);
  } catch (_) {
    return parseRate(video?.r_frame_rate, stage);
  }
}

function parseClockDuration(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const duration = (hours * 3600) + (minutes * 60) + seconds;
  return Number.isFinite(duration) && minutes < 60 && seconds < 60 && duration > 0
    ? duration
    : null;
}

function parseStreamDuration(stream) {
  const direct = Number(stream?.duration);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const durationTs = Number(stream?.duration_ts);
  if (Number.isFinite(durationTs) && durationTs > 0 && stream?.time_base) {
    const parts = String(stream.time_base).split('/');
    if (parts.length === 2) {
      const numerator = Number(parts[0]);
      const denominator = Number(parts[1]);
      const duration = durationTs * numerator / denominator;
      if (Number.isFinite(duration) && denominator > 0 && duration > 0) return duration;
    }
  }
  return parseClockDuration(stream?.tags?.DURATION ?? stream?.tags?.duration);
}

function parseContainerDuration(format) {
  const duration = Number(format?.duration);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function parseAudioProbeJson(raw, stage = 'audio probe') {
  let data;
  try {
    if (typeof raw !== 'string' || raw.trim() === '') fail(stage, 'JSON');
    data = JSON.parse(raw);
  } catch (error) {
    if (error.message.startsWith(`${stage}:`)) throw error;
    throw new Error(`${stage}: ffprobe вернул недопустимое JSON`);
  }

  const streams = Array.isArray(data.streams) ? data.streams : [];
  const audio = streams.find((stream) => stream && stream.codec_type === 'audio');
  if (!audio) fail(stage, 'audio stream');

  const durationSec = parseStreamDuration(audio) ?? parseContainerDuration(data.format);
  if (durationSec === null) fail(stage, 'duration');
  const sampleRate = Number(audio.sample_rate);
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) fail(stage, 'sample rate');
  const channels = Number(audio.channels);
  if (!Number.isSafeInteger(channels) || channels <= 0) fail(stage, 'channels');
  const codec = typeof audio.codec_name === 'string' ? audio.codec_name.trim() : '';
  if (!codec) fail(stage, 'codec');

  return {
    mediaKind: 'audio',
    durationSec,
    sampleRate,
    channels,
    codec,
  };
}

function parseVideoProbe(raw, stage = 'video probe') {
  let data;
  try {
    if (typeof raw !== 'string' || raw.trim() === '') fail(stage, 'JSON');
    data = JSON.parse(raw);
  } catch (error) {
    if (error.message.startsWith(`${stage}:`)) throw error;
    throw new Error(`${stage}: ffprobe вернул недопустимое JSON`);
  }

  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((stream) => stream && stream.codec_type === 'video') || streams[0];
  if (!video || video.codec_type && video.codec_type !== 'video') fail(stage, 'video stream');

  const width = Number(video.width);
  const height = Number(video.height);
  if (!Number.isSafeInteger(width) || width <= 0
    || !Number.isSafeInteger(height) || height <= 0) {
    fail(stage, 'geometry');
  }
  const fps = parseRate(video.r_frame_rate, stage);
  const duration = Number(data.format?.duration ?? video.duration);
  if (!Number.isFinite(duration) || duration <= 0) fail(stage, 'duration');

  return { width, height, fps, duration };
}

function parseMediaProbeJson(raw) {
  const stage = 'media probe';
  let data;
  try {
    if (typeof raw !== 'string' || raw.trim() === '') fail(stage, 'JSON');
    data = JSON.parse(raw);
  } catch (error) {
    if (error.message.startsWith(`${stage}:`)) throw error;
    throw new Error(`${stage}: ffprobe вернул недопустимое JSON`);
  }

  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((stream) => stream && stream.codec_type === 'video'
    && Number(stream.disposition?.attached_pic || 0) !== 1);
  if (!video) fail(stage, 'primary video stream');

  const width = Number(video.width);
  const height = Number(video.height);
  if (!Number.isSafeInteger(width) || width <= 0
    || !Number.isSafeInteger(height) || height <= 0) {
    fail(stage, 'geometry');
  }

  const formatNames = String(data.format?.format_name || '').split(',');
  const imageFormats = new Set([
    'avif', 'gif', 'image2', 'image2pipe', 'jpeg_pipe', 'mjpeg',
    'png_pipe', 'webp_pipe',
  ]);
  const audio = streams.find((stream) => stream && stream.codec_type === 'audio') || null;
  const majorBrand = String(data.format?.tags?.major_brand || '');
  const compatibleBrands = String(data.format?.tags?.compatible_brands || '');
  const compatibleBrandChunks = compatibleBrands
    .split(/[\s,]+/)
    .flatMap((group) => Array.from(
      { length: Math.floor(group.length / 4) },
      (_, index) => group.slice(index * 4, index * 4 + 4),
    ));
  const avifBrand = majorBrand === 'avif' || majorBrand === 'avis'
    || compatibleBrandChunks.includes('avif') || compatibleBrandChunks.includes('avis');
  const avifImage = video.codec_name === 'av1' && avifBrand && audio === null;
  const mediaKind = formatNames.some((name) => imageFormats.has(name)) || avifImage
    ? 'image'
    : 'video';
  let fps = 0;
  let durationSec = 0;
  let videoDurationSec = null;
  let audioDurationSec = null;
  let hasAudio = false;
  const containerDurationSec = parseContainerDuration(data.format);
  if (mediaKind === 'video') {
    fps = preferredVideoRate(video, stage);
    videoDurationSec = parseStreamDuration(video);
    if (videoDurationSec === null) fail(stage, 'video stream duration');
    durationSec = videoDurationSec;
    hasAudio = Boolean(audio);
    if (hasAudio) {
      audioDurationSec = parseStreamDuration(audio);
      if (audioDurationSec === null) fail(stage, 'audio stream duration');
    }
  }

  const sideDataRotation = Array.isArray(video.side_data_list)
    ? video.side_data_list.find((entry) => Number.isFinite(Number(entry?.rotation)))?.rotation
    : undefined;
  const rawRotation = Number(sideDataRotation ?? video.tags?.rotate ?? 0);
  if (!Number.isFinite(rawRotation)) fail(stage, 'rotation');
  const normalizedRotation = ((Math.round(rawRotation) % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(normalizedRotation)) fail(stage, 'rotation');

  const container = String(data.format?.format_name || '');
  const videoCodec = typeof video.codec_name === 'string' ? video.codec_name : '';
  const pixelFormat = typeof video.pix_fmt === 'string' ? video.pix_fmt : '';
  // FFmpeg decodes even fully opaque GIF frames as BGRA. That pixel format alone therefore
  // cannot prove semantic transparency; the forced RGBA → WebP encode still preserves any
  // transparency that is actually present in the decoded first frame.
  const hasAlpha = videoCodec !== 'gif'
    && /(?:^yuva|rgba|argb|bgra|abgr|gbrap|ya8|ya16)/.test(pixelFormat);
  const sampleRate = Number(audio?.sample_rate);
  const channels = Number(audio?.channels);

  return {
    mediaKind,
    width,
    height,
    fps,
    durationSec,
    containerDurationSec,
    videoDurationSec,
    audioDurationSec,
    hasAudio,
    rotation: normalizedRotation,
    container,
    videoCodec,
    pixelFormat,
    hasAlpha,
    audioCodec: typeof audio?.codec_name === 'string' ? audio.codec_name : null,
    audioSampleRate: Number.isSafeInteger(sampleRate) && sampleRate > 0 ? sampleRate : null,
    audioChannels: Number.isSafeInteger(channels) && channels > 0 ? channels : null,
  };
}

function probeVideo(file, options = {}) {
  const stage = options.stage || 'video probe';
  const stdout = captureTool('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_type,width,height,r_frame_rate,duration:format=duration',
    '-of', 'json',
    hostPath(file, options.cwd),
  ], {
    cwd: options.cwd,
    env: options.env,
    maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
    stage,
    spawnSyncImpl: options.spawnSyncImpl,
  });
  return parseVideoProbe(stdout, stage);
}

module.exports = {
  fileSystemCapabilities,
  openReadOnlyFlags,
  parseAudioProbeJson,
  parseMediaProbeJson,
  parseRate,
  parseVideoProbe,
  probeOpenedAudio,
  probeOpenedMedia,
  probeVideo,
  sameOpenedFileSnapshot,
};
