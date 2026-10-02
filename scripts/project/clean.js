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

function planCleanup(projectsDir, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const projects = fileSystem.readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
    .map((name) => planProjectCleanup(path.join(projectsDir, name), options));
  return { projects, bytes: projects.reduce((sum, item) => sum + item.bytes, 0) };
}

function insideProject(projectDir, file, fileSystem) {
  const root = fileSystem.realpathSync(projectDir);
  const parent = fileSystem.realpathSync(path.dirname(file));
  return parent === root || parent.startsWith(`${root}${path.sep}`);
}

// Пустые папки убираются только глубже первого уровня: tmp/, previews/, renders/ и motion-vNN/
// остаются – движок ждёт их на месте, а motion-vNN хранит исходники сцен.
function pruneEmptyParents(projectDir, relative, fileSystem) {
  const parts = relative.split('/').slice(0, -1);
  while (parts.length >= 2) {
    const dir = path.join(projectDir, ...parts);
    try {
      if (fileSystem.readdirSync(dir).length > 0) return;
      fileSystem.rmdirSync(dir);
    } catch {
      return;
    }
    parts.pop();
  }
}

// Перед удалением проект проверяется заново: за время между отчётом и --yes в нём могла начаться
// работа. Удаляются только файлы, которые есть в обоих планах, только обычные и только внутри проекта.
function applyCleanup(plan, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const result = { removedFiles: 0, freedBytes: 0, skipped: [] };
  for (const project of plan.projects.filter((item) => item.status === 'eligible')) {
    const fresh = planProjectCleanup(project.projectDir, options);
    if (fresh.status !== 'eligible') {
      result.skipped.push({ projectDir: project.projectDir, reason: fresh.reason });
      continue;
    }
    const planned = new Set(project.files.map((file) => file.path));
    for (const file of fresh.files.filter((item) => planned.has(item.path))) {
      const absolute = path.join(project.projectDir, ...file.path.split('/'));
      const stat = fileSystem.lstatSync(absolute, { throwIfNoEntry: false });
      if (!stat?.isFile() || !insideProject(project.projectDir, absolute, fileSystem)) continue;
      fileSystem.unlinkSync(absolute);
      result.removedFiles += 1;
      result.freedBytes += stat.size;
      pruneEmptyParents(project.projectDir, file.path, fileSystem);
    }
  }
  return result;
}

function formatSize(bytes) {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} ГБ` : `${(bytes / 1024 ** 2).toFixed(1)} МБ`;
}

function parseCleanOptions(argv) {
  const options = { projectsDir: path.join(__dirname, '..', '..', 'projects'), level: 'renders', minAgeDays: 3, yes: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--yes') {
      options.yes = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} требует значение`);
    index += 1;
    if (key === '--projects-dir') options.projectsDir = path.resolve(value);
    else if (key === '--level') options.level = value;
    else if (key === '--min-age-days') {
      options.minAgeDays = Number(value);
      if (!Number.isInteger(options.minAgeDays) || options.minAgeDays < 0) throw new Error('--min-age-days – целое число дней ≥ 0');
    } else throw new Error(`неизвестная опция clean: ${key}`);
  }
  if (!CLEAN_LEVELS.includes(options.level)) throw new Error(`неизвестный уровень "${options.level}": используй renders или archive`);
  return options;
}

function main(argv = process.argv.slice(2), { now = new Date(), log = console.log, error = console.error } = {}) {
  try {
    const options = parseCleanOptions(argv);
    const plan = planCleanup(options.projectsDir, { level: options.level, minAgeDays: options.minAgeDays, now });
    log(`Чистка готовых роликов (уровень ${options.level}) – ${options.projectsDir}`);
    for (const project of plan.projects) {
      const name = path.basename(project.projectDir);
      log(project.status === 'eligible'
        ? `  ${name}: ${formatSize(project.bytes)} (${project.files.length} файл.)`
        : `  ${name}: пропущен – ${project.reason}`);
    }
    log(`Можно освободить: ${formatSize(plan.bytes)}`);
    if (!options.yes) {
      log('Чтобы удалить, повторите с --yes. Финалы, ТЗ, транскрипты и оригинал исходника не удаляются.');
      return 0;
    }
    const result = applyCleanup(plan, { level: options.level, minAgeDays: options.minAgeDays, now });
    for (const item of result.skipped) log(`  ${path.basename(item.projectDir)}: пропущен при удалении – ${item.reason}`);
    log(`Удалено ${result.removedFiles} файлов, освобождено ${formatSize(result.freedBytes)}`);
    return 0;
  } catch (failure) {
    error(`❌ clean: ${failure.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { CLEAN_LEVELS, applyCleanup, main, planCleanup, planProjectCleanup };
