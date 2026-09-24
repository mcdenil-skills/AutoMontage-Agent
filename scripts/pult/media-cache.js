const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const { parseVideoProbe } = require('../media-probe');
const { captureToolResult } = require('../process');
const { ensureDirectory, readJsonIfExists, writeJsonAtomic } = require('./files');

function cacheDir(projectsDir) {
  return path.join(projectsDir, '.pult', 'cache');
}

// mkdir -p follows a symlinked .pult if only .pult/cache is lstat-checked: a hostile
// .pult could then redirect the whole cache outside projects/. Check both levels.
function ensureCacheDir(projectsDir) {
  ensureDirectory(path.join(projectsDir, '.pult'));
  ensureDirectory(cacheDir(projectsDir));
}

// Ключ меняется вместе с файлом: новый рендер с тем же именем получит новую обложку.
function cacheKey(filePath) {
  const stat = fs.statSync(filePath);
  return createHash('sha256')
    .update(`${path.resolve(filePath)}\0${stat.size}\0${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 32);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// The cached probe is later sent to the browser as `meta`: a hand-edited cache file
// must not leak extra fields or the wrong types through — only trust it when the
// three fields have the right shape, and return exactly those three keys.
function isValidCachedProbe(value) {
  return isPlainObject(value)
    && Number.isFinite(value.width) && value.width > 0
    && Number.isFinite(value.height) && value.height > 0
    && Number.isFinite(value.durationSec) && value.durationSec >= 0;
}

function probeMedia(projectsDir, filePath, { captureImpl = captureToolResult } = {}) {
  try {
    const cachePath = path.join(cacheDir(projectsDir), `${cacheKey(filePath)}.json`);
    const cached = readJsonIfExists(cachePath, 'probe cache');
    if (isValidCachedProbe(cached)) {
      return { width: cached.width, height: cached.height, durationSec: cached.durationSec };
    }
    const result = captureImpl('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_type,width,height,r_frame_rate,duration:format=duration',
      '-of', 'json',
      path.resolve(filePath),
    ], { maxBuffer: 4 * 1024 * 1024, stage: 'pult probe' });
    const probe = parseVideoProbe(result.stdout, 'pult probe');
    const value = {
      width: probe.width,
      height: probe.height,
      durationSec: Math.round(probe.duration * 100) / 100,
    };
    ensureCacheDir(projectsDir);
    writeJsonAtomic(cachePath, value);
    return value;
  } catch (_) {
    return null;
  }
}

function extractFrame(videoPath, timeSec, outPath, { captureImpl = captureToolResult } = {}) {
  try {
    captureImpl('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(timeSec),
      '-i', path.resolve(videoPath),
      '-frames:v', '1',
      '-vf', 'scale=480:-2',
      '-q:v', '4',
      outPath,
    ], { maxBuffer: 1024 * 1024, stage: 'pult frame' });
    return fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
  } catch (_) {
    return false;
  }
}

function thumbnailFor(projectsDir, filePath, { captureImpl = captureToolResult } = {}) {
  try {
    const target = path.join(cacheDir(projectsDir), `${cacheKey(filePath)}.jpg`);
    if (fs.existsSync(target)) return target;
    ensureCacheDir(projectsDir);
    const ok = extractFrame(filePath, 1, target, { captureImpl })
      || extractFrame(filePath, 0, target, { captureImpl });
    return ok ? target : null;
  } catch (_) {
    return null;
  }
}

module.exports = { extractFrame, probeMedia, thumbnailFor };
