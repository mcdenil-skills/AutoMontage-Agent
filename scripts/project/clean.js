const fs = require('node:fs');
const path = require('node:path');

// Уровни чистки готового ролика. renders – то, что движок пересоберёт сам; archive – ещё и то,
// что восстанавливается из оригинала и правок (ревизии нарезки, импортированные слои и b-roll).
const CLEAN_LEVELS = ['renders', 'archive'];
const MUTATION_LOCK = '.project-mutation.lock';
const DAY_MS = 24 * 60 * 60 * 1000;
const MOTION_DIR = /^motion-v\d+$/;
const MOTION_SCRATCH = new Set(['renders', 'previews', 'out', 'checks']);
const SPEAKER = /^speaker.*\.mp4$/i;
const SOURCE_REVISION = /^source-v\d+\./;
const RENDER_MEDIA = new Set(['.mp4', '.mov']);
const PREVIEW_MEDIA = new Set(['.mp4', '.mov', '.webm']);

function extension(name) {
  return path.extname(name).toLowerCase();
}

function matchesRenders(parts) {
  const [top] = parts;
  const name = parts[parts.length - 1];
  if (top === 'renders') return RENDER_MEDIA.has(extension(name));
  if (top === 'previews') return PREVIEW_MEDIA.has(extension(name));
  if (top === 'tmp') return parts.length > 1;
  if (!MOTION_DIR.test(top)) return false;
  if (MOTION_SCRATCH.has(parts[1]) && parts.length > 2) return true;
  if (parts.length === 2) return SPEAKER.test(name);
  return parts.length === 3 && parts[1] === 'public' && SPEAKER.test(name);
}

function matchesArchive(parts) {
  if (parts[0] === 'input') return parts.length === 2 && SOURCE_REVISION.test(parts[1]);
  return parts[0] === 'assets' && parts[1] === 'broll' && PREVIEW_MEDIA.has(extension(parts[parts.length - 1]));
}

// Пути, которые нельзя трогать даже при совпадении с правилом: финал, оригинал исходника,
// показанное в пульте превью и видео старых карточек пульта (legacy).
function protectedPaths(dir, manifest, fileSystem) {
  const kept = new Set([manifest.final, manifest.source?.originalLocalPath, manifest.currentPreview?.filePath]);
  try {
    const card = JSON.parse(fileSystem.readFileSync(path.join(dir, 'pult-card.json'), 'utf8'));
    for (const variant of card?.legacy?.variants || []) kept.add(variant.video);
  } catch {
    // нет карточки или она не читается – в ней нечего беречь
  }
  return new Set([...kept].filter((item) => typeof item === 'string').map((item) => path.posix.normalize(item)));
}

// Обход без перехода по симлинкам: в план попадают только обычные файлы самого проекта.
function walk(dir, fileSystem, relative = []) {
  const result = [];
  for (const entry of fileSystem.readdirSync(path.join(dir, ...relative), { withFileTypes: true })) {
    const parts = [...relative, entry.name];
    if (entry.isDirectory()) result.push(...walk(dir, fileSystem, parts));
    else if (entry.isFile()) result.push(parts);
  }
  return result;
}

function skipped(projectDir, reason) {
  return { projectDir, status: 'skipped', reason, files: [], bytes: 0 };
}

function planProjectCleanup(projectDir, { level = 'renders', minAgeDays = 3, now = new Date(), fileSystem = fs } = {}) {
  if (!CLEAN_LEVELS.includes(level)) throw new Error(`неизвестный уровень "${level}": используй renders или archive`);
  const manifestPath = path.join(projectDir, 'project.json');
  if (!fileSystem.existsSync(manifestPath)) return skipped(projectDir, 'нет project.json');
  let manifest;
  try {
    manifest = JSON.parse(fileSystem.readFileSync(manifestPath, 'utf8'));
  } catch {
    return skipped(projectDir, 'project.json не читается');
  }
  const finalStat = typeof manifest?.final === 'string'
    ? fileSystem.lstatSync(path.join(projectDir, manifest.final), { throwIfNoEntry: false }) : null;
  if (!finalStat?.isFile() || finalStat.size === 0) return skipped(projectDir, 'нет финала');
  if (fileSystem.existsSync(path.join(projectDir, MUTATION_LOCK))) return skipped(projectDir, 'идёт работа (lock)');
  const changed = Math.max(fileSystem.statSync(manifestPath).mtimeMs, finalStat.mtimeMs);
  const ageDays = Math.floor((now.getTime() - changed) / DAY_MS);
  if (ageDays < minAgeDays) return skipped(projectDir, `менялся ${Math.max(0, ageDays)} дн. назад`);

  const kept = protectedPaths(projectDir, manifest, fileSystem);
  const files = walk(projectDir, fileSystem)
    .filter((parts) => matchesRenders(parts) || (level === 'archive' && matchesArchive(parts)))
    .map((parts) => parts.join('/'))
    .filter((relative) => !kept.has(relative))
    .map((relative) => ({ path: relative, bytes: fileSystem.lstatSync(path.join(projectDir, relative)).size }));
  return {
    projectDir,
    status: 'eligible',
    reason: null,
    files,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

module.exports = { CLEAN_LEVELS, planProjectCleanup };
