const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const { parseVideoProbe } = require('../media-probe');
const { captureToolResult } = require('../process');
const { ensureDirectory, readJsonIfExists, writeJsonAtomic } = require('./files');

// Зависший ffprobe/ffmpeg (файл ещё копируется по сети, битая шара) не должен вешать
// однопоточный сервер пульта навечно.
const TOOL_TIMEOUT_MS = 15000;

function cacheDir(projectsDir) {
  return path.join(projectsDir, '.pult', 'cache');
}

// mkdir -p следует за символической ссылкой .pult, если проверить lstat только у
// .pult/cache: враждебная .pult могла бы вывести весь кэш за пределы projects/.
// Проверяем обе ступени пути.
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

// Прочитанный кэш уходит в браузер как meta: подменённый вручную файл не должен
// протаскивать посторонние поля или неверные типы – читаем только три проверенных
// числа и возвращаем ровно их.
function isValidCachedProbe(value) {
  return isPlainObject(value)
    && Number.isFinite(value.width) && value.width > 0
    && Number.isFinite(value.height) && value.height > 0
    && Number.isFinite(value.durationSec) && value.durationSec >= 0;
}

function probeMedia(projectsDir, filePath, { captureImpl = captureToolResult } = {}) {
  try {
    // Проверка символической ссылки – самым первым шагом, до любого чтения кэша:
    // враждебная .pult, уже указывающая на чужой заполненный кэш с совпадающим по
    // ключу именем файла, не должна быть молча прочитана как «свой» результат.
    ensureCacheDir(projectsDir);
    const cachePath = path.join(cacheDir(projectsDir), `${cacheKey(filePath)}.json`);
    let cached;
    try {
      cached = readJsonIfExists(cachePath, 'probe cache');
    } catch (_) {
      // Битый (непарсящийся) кэш – это промах кэша, а не постоянный отказ:
      // ниже мы просто перепробируем файл заново.
      cached = undefined;
    }
    if (isValidCachedProbe(cached)) {
      return { width: cached.width, height: cached.height, durationSec: cached.durationSec };
    }
    const result = captureImpl('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_type,width,height,r_frame_rate,duration:format=duration',
      '-of', 'json',
      path.resolve(filePath),
    ], { maxBuffer: 4 * 1024 * 1024, stage: 'pult probe', timeout: TOOL_TIMEOUT_MS });
    const probe = parseVideoProbe(result.stdout, 'pult probe');
    const value = {
      width: probe.width,
      height: probe.height,
      durationSec: Math.round(probe.duration * 100) / 100,
    };
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
    ], { maxBuffer: 1024 * 1024, stage: 'pult frame', timeout: TOOL_TIMEOUT_MS });
    const ok = fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
    // Провал не должен оставлять недорисованный кадр на диске (ни 0 байт, ни мусор).
    if (!ok) fs.rmSync(outPath, { force: true });
    return ok;
  } catch (_) {
    fs.rmSync(outPath, { force: true });
    return false;
  }
}

// Снимок места правки лид-магнита: вырезает прямоугольник из скриншота проверки (qa/*.png).
// Размер ограничен, крупный кусок уменьшается до 640 px по ширине; провал – без мусора на диске.
function cropImage(sourcePath, rect, outPath, { captureImpl = captureToolResult } = {}) {
  const values = [rect && rect.x, rect && rect.y, rect && rect.w, rect && rect.h];
  if (!values.every(Number.isFinite)) return false;
  const [x, y] = values.slice(0, 2).map((value) => Math.max(0, Math.round(value)));
  const w = Math.min(Math.round(values[2]), 1280);
  const h = Math.min(Math.round(values[3]), 1600);
  if (w < 4 || h < 4) return false;
  try {
    captureImpl('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', path.resolve(sourcePath),
      '-vf', `crop='min(${w},iw-${x})':'min(${h},ih-${y})':${x}:${y},scale='min(640,iw)':-2`,
      '-frames:v', '1',
      outPath,
    ], { maxBuffer: 1024 * 1024, stage: 'pult snapshot', timeout: TOOL_TIMEOUT_MS });
    const ok = fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
    if (!ok) fs.rmSync(outPath, { force: true });
    return ok;
  } catch (_) {
    fs.rmSync(outPath, { force: true });
    return false;
  }
}

function thumbnailFor(projectsDir, filePath, { captureImpl = captureToolResult } = {}) {
  try {
    // Проверка символической ссылки – самым первым шагом, до fs.existsSync: та же
    // причина, что и в probeMedia.
    ensureCacheDir(projectsDir);
    const target = path.join(cacheDir(projectsDir), `${cacheKey(filePath)}.jpg`);
    // Нулевой байт в кэше – это испорченная обложка, а не валидный результат:
    // считаем это промахом и перерисовываем.
    if (fs.existsSync(target) && fs.statSync(target).size > 0) return target;
    // Рендерим во временный файл рядом с целевым и переименовываем только при успехе,
    // чтобы упавший на середине рендер не оставил в кэше частично записанную обложку.
    const temp = path.join(cacheDir(projectsDir), `${cacheKey(filePath)}.tmp-${randomUUID()}.jpg`);
    const ok = extractFrame(filePath, 1, temp, { captureImpl })
      || extractFrame(filePath, 0, temp, { captureImpl });
    if (!ok) {
      fs.rmSync(temp, { force: true });
      return null;
    }
    fs.renameSync(temp, target);
    return target;
  } catch (_) {
    return null;
  }
}

module.exports = { cropImage, extractFrame, probeMedia, thumbnailFor };
