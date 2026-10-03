const fs = require('node:fs');
const path = require('node:path');
const { readComments } = require('../pult/comments');
const { deriveVariantStatus } = require('../pult/status');
const { activeRoughCut } = require('./rough-cut-model');

// Уровни чистки готового ролика. renders – промежуточные рендеры, preview, tmp и копии спикера:
// после них ролик по-прежнему перерендеривается из своих файлов. archive – ещё промежуточные
// ревизии нарезки и наборы b-roll и слоёв, на которые не ссылается ни текущее ТЗ, ни слой.
const CLEAN_LEVELS = ['renders', 'archive'];
const MUTATION_LOCK = '.project-mutation.lock';
const DAY_MS = 24 * 60 * 60 * 1000;
const MOTION_DIR = /^motion-v\d+$/;
const MOTION_SCRATCH = new Set(['renders', 'previews', 'out', 'checks']);
const RENDER_MEDIA = new Set(['.mp4', '.mov']);
const PREVIEW_MEDIA = new Set(['.mp4', '.mov', '.webm']);

function extension(name) {
  return path.extname(name).toLowerCase();
}

function readText(fileSystem, file) {
  try {
    return fileSystem.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function readJson(fileSystem, file) {
  try {
    return JSON.parse(fileSystem.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function regularSize(fileSystem, file) {
  const stat = fileSystem.lstatSync(file, { throwIfNoEntry: false });
  return stat?.isFile() ? stat.size : null;
}

// Путь из manifest или карточки – только относительный и внутри проекта, в POSIX-виде.
function projectRelativePath(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || path.win32.isAbsolute(value)) return null;
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  return normalized === '..' || normalized.startsWith('../') ? null : normalized;
}

function projectFile(projectDir, relative) {
  return path.join(projectDir, ...relative.split('/'));
}

// Слои проекта: папка, текст layer.json, имя копии спикера и ревизия исходника, из которой она сделана.
function readLayers(projectDir, fileSystem) {
  return fileSystem.readdirSync(projectDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && MOTION_DIR.test(entry.name))
    .map((entry) => {
      const text = readText(fileSystem, path.join(projectDir, entry.name, 'layer.json'));
      let layer = null;
      try {
        layer = text ? JSON.parse(text) : null;
      } catch {
        layer = null;
      }
      return {
        dir: entry.name,
        text,
        speaker: typeof layer?.speaker?.src === 'string' ? layer.speaker.src : null,
        source: projectRelativePath(layer?.source?.localPath),
      };
    });
}

// Копию спикера можно удалить, только если рядом лежит её ревизия исходника того же размера:
// вернуть копию – значит скопировать этот файл обратно в motion-vNN/public/.
function speakerCopies(projectDir, layers, fileSystem) {
  const result = new Set();
  for (const layer of layers) {
    if (!layer.speaker || !layer.source || /[\\/]/.test(layer.speaker)) continue;
    const copy = `${layer.dir}/public/${layer.speaker}`;
    const copySize = regularSize(fileSystem, projectFile(projectDir, copy));
    if (copySize !== null && copySize === regularSize(fileSystem, projectFile(projectDir, layer.source))) result.add(copy);
  }
  return result;
}

// Ссылки, которые держат файлы на уровне archive: текущее и отрендеренное ТЗ и все layer.json.
function referenceText(projectDir, manifest, layers, fileSystem) {
  const latest = (Array.isArray(manifest.renders) ? manifest.renders : []).find((render) => render?.dir === manifest.latestRender);
  const briefs = [...new Set([manifest.currentBrief, latest?.briefPath].map(projectRelativePath).filter(Boolean))];
  return [...briefs.map((brief) => readText(fileSystem, projectFile(projectDir, brief))), ...layers.map((layer) => layer.text)].join('\n');
}

// Промежуточная ревизия нарезки: у проекта есть оригинал, ревизия записана в истории вместе с
// существующей правкой (её можно собрать заново), она не активная и на неё не ссылаются ТЗ и слои.
function removableRevisions(projectDir, manifest, references, fileSystem) {
  const source = manifest.source || {};
  const original = projectRelativePath(source.originalLocalPath);
  if (!original || regularSize(fileSystem, projectFile(projectDir, original)) === null) return new Set();
  const active = projectRelativePath(source.localPath);
  const result = new Set();
  for (const entry of Array.isArray(source.history) ? source.history : []) {
    const revision = projectRelativePath(entry?.localPath);
    const edit = projectRelativePath(entry?.editPath);
    if (!revision || !edit || revision === original || revision === active || references.includes(revision)) continue;
    if (regularSize(fileSystem, projectFile(projectDir, edit)) !== null) result.add(revision);
  }
  return result;
}

function matchesRenders(parts, speakers) {
  const [top] = parts;
  const name = parts[parts.length - 1];
  if (top === 'renders') return RENDER_MEDIA.has(extension(name));
  // previews/broll/ – прокси импортированных b-roll и слоёв: движок их не пересоздаёт.
  if (top === 'previews') return parts[1] !== 'broll' && PREVIEW_MEDIA.has(extension(name));
  if (top === 'tmp') return parts.length > 1;
  if (!MOTION_DIR.test(top)) return false;
  if (MOTION_SCRATCH.has(parts[1]) && parts.length > 2) return true;
  return speakers.has(parts.join('/'));
}

// Набор b-roll – папка assets/broll/<вид>/<id>/ и прокси previews/broll/<id>.*: удаляется целиком,
// только если id не упомянут ни в текущем ТЗ, ни в слоях.
function matchesArchive(parts, revisions, references) {
  if (parts[0] === 'input') return revisions.has(parts.join('/'));
  if (parts[0] === 'assets' && parts[1] === 'broll' && parts.length >= 5) return !references.includes(parts[3]);
  if (parts[0] === 'previews' && parts[1] === 'broll' && parts.length === 3) {
    const id = path.basename(parts[2], path.extname(parts[2]));
    return Boolean(id) && !references.includes(id);
  }
  return false;
}

// Пути, которые нельзя трогать даже при совпадении с правилом: финал, оригинал и активная ревизия
// исходника, показанное в пульте превью и видео старых карточек пульта (legacy).
function protectedPaths(dir, manifest, fileSystem) {
  const kept = [manifest.final, manifest.source?.originalLocalPath, manifest.source?.localPath, manifest.currentPreview?.filePath];
  const card = readJson(fileSystem, path.join(dir, 'pult-card.json'));
  for (const variant of Array.isArray(card?.legacy?.variants) ? card.legacy.variants : []) kept.push(variant?.video);
  return new Set(kept.map(projectRelativePath).filter(Boolean));
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

// «Готов» – то же, что видит человек в пульте: финал собран по текущему утверждённому ТЗ и правок
// нет. Утверждённая, но ещё не отрендеренная версия или новые правки – работа не закончена.
// Активная черновая нарезка – идёт новый монтаж, даже если финал прежней версии на месте: её копию
// автор смотрит сейчас. Первый master делает нарезку историей, и чистка снова прежняя.
function pultBlocker(projectDir, manifest) {
  let pending;
  try {
    pending = readComments(projectDir).filter((comment) => comment.status === 'new').length;
  } catch {
    return 'pult/comments.json не читается';
  }
  const roughCut = activeRoughCut(manifest);
  if (roughCut) {
    return roughCut.status === 'review' ? 'черновая нарезка ждёт автора' : 'нарезка подтверждена – агент собирает слой';
  }
  const currentBrief = manifest.currentBrief ?? null;
  const entry = (Array.isArray(manifest.briefs) ? manifest.briefs : []).find((brief) => brief?.jsonPath === currentBrief);
  const derived = deriveVariantStatus({
    manifest: { ...manifest, currentBrief, renders: Array.isArray(manifest.renders) ? manifest.renders : [] },
    currentBriefStatus: entry?.status ?? null,
    currentBriefSha256: null,
    finalExists: true,
    pendingComments: pending,
  });
  return derived.status === 'ready' ? null : `не готов в пульте (${derived.nextStep})`;
}

function skipped(projectDir, reason) {
  return { projectDir, status: 'skipped', reason, files: [], bytes: 0 };
}

function planProjectCleanup(projectDir, { level = 'renders', minAgeDays = 3, now = new Date(), fileSystem = fs } = {}) {
  if (!CLEAN_LEVELS.includes(level)) throw new Error(`неизвестный уровень "${level}": используй renders или archive`);
  const manifestPath = path.join(projectDir, 'project.json');
  if (!fileSystem.existsSync(manifestPath)) return skipped(projectDir, 'нет project.json');
  const manifest = readJson(fileSystem, manifestPath);
  if (!manifest || typeof manifest !== 'object') return skipped(projectDir, 'project.json не читается');
  const final = projectRelativePath(manifest.final);
  const finalStat = final ? fileSystem.lstatSync(projectFile(projectDir, final), { throwIfNoEntry: false }) : null;
  if (!finalStat?.isFile() || finalStat.size === 0) return skipped(projectDir, 'нет финала');
  if (fileSystem.existsSync(path.join(projectDir, MUTATION_LOCK))) return skipped(projectDir, 'идёт работа (lock)');
  const changed = Math.max(fileSystem.statSync(manifestPath).mtimeMs, finalStat.mtimeMs);
  const ageDays = Math.floor((now.getTime() - changed) / DAY_MS);
  if (ageDays < minAgeDays) return skipped(projectDir, `менялся ${Math.max(0, ageDays)} дн. назад`);
  const blocker = pultBlocker(projectDir, manifest);
  if (blocker) return skipped(projectDir, blocker);

  const layers = readLayers(projectDir, fileSystem);
  const speakers = speakerCopies(projectDir, layers, fileSystem);
  const references = level === 'archive' ? referenceText(projectDir, manifest, layers, fileSystem) : '';
  const revisions = level === 'archive' ? removableRevisions(projectDir, manifest, references, fileSystem) : new Set();
  const kept = protectedPaths(projectDir, manifest, fileSystem);
  const files = walk(projectDir, fileSystem)
    .filter((parts) => matchesRenders(parts, speakers) || (level === 'archive' && matchesArchive(parts, revisions, references)))
    .map((parts) => parts.join('/'))
    .filter((relative) => !kept.has(relative))
    .map((relative) => ({ path: relative, bytes: fileSystem.lstatSync(projectFile(projectDir, relative)).size }));
  return {
    projectDir,
    status: 'eligible',
    reason: null,
    files,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

// Одна нечитаемая папка не должна обрывать отчёт по остальным роликам.
function safePlan(projectDir, options) {
  if (options.level !== undefined && !CLEAN_LEVELS.includes(options.level)) {
    throw new Error(`неизвестный уровень "${options.level}": используй renders или archive`);
  }
  try {
    return planProjectCleanup(projectDir, options);
  } catch {
    return skipped(projectDir, 'папка не читается');
  }
}

function planCleanup(projectsDir, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const projects = fileSystem.readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
    .map((name) => safePlan(path.join(projectsDir, name), options));
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
    const dir = projectFile(projectDir, parts.join('/'));
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
// работа. Удаляются только файлы, которые есть в обоих планах, обычные и только внутри проекта.
// Ошибка одного файла не останавливает остальные: она попадает в failed.
function applyCleanup(plan, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const result = { removedFiles: 0, freedBytes: 0, skipped: [], failed: [] };
  for (const project of plan.projects.filter((item) => item.status === 'eligible')) {
    const fresh = safePlan(project.projectDir, options);
    if (fresh.status !== 'eligible') {
      result.skipped.push({ projectDir: project.projectDir, reason: fresh.reason });
      continue;
    }
    const planned = new Set(project.files.map((file) => file.path));
    for (const file of fresh.files.filter((item) => planned.has(item.path))) {
      const absolute = projectFile(project.projectDir, file.path);
      try {
        const stat = fileSystem.lstatSync(absolute, { throwIfNoEntry: false });
        if (!stat?.isFile() || !insideProject(project.projectDir, absolute, fileSystem)) continue;
        fileSystem.unlinkSync(absolute);
        result.removedFiles += 1;
        result.freedBytes += stat.size;
        pruneEmptyParents(project.projectDir, file.path, fileSystem);
      } catch (error) {
        result.failed.push({ path: absolute, code: error.code || error.message });
      }
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
      log('Чтобы удалить, повторите с --yes. Финал, ТЗ, транскрипты, исходники сцен, оригинал и активная ревизия исходника и материалы текущего ТЗ не удаляются.');
      return 0;
    }
    const result = applyCleanup(plan, { level: options.level, minAgeDays: options.minAgeDays, now });
    for (const item of result.skipped) log(`  ${path.basename(item.projectDir)}: пропущен при удалении – ${item.reason}`);
    for (const item of result.failed) error(`  не удалён ${item.path}: ${item.code}`);
    log(`Удалено ${result.removedFiles} файлов, освобождено ${formatSize(result.freedBytes)}`);
    return result.failed.length ? 1 : 0;
  } catch (failure) {
    error(`❌ clean: ${failure.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { CLEAN_LEVELS, applyCleanup, main, planCleanup, planProjectCleanup };
