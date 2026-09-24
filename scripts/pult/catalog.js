const fs = require('node:fs');
const path = require('node:path');

const { readProjectManifest, resolveProjectPath } = require('../project/workspace');
const { readPultCard } = require('./card-file');
const { countNewComments } = require('./comments');
const { hashFile } = require('./files');
const { SAFE_NAME, isSafeName } = require('./names');
const { deriveVariantStatus, pluralEdits } = require('./status');

// Ключ карточки — то же самое deny-list правило, что и для имён папок (см. names.js):
// allow-list из букв/цифр отклонял реальные legacy-папки (NFD й/ё, скобки, плюс), их
// нельзя было бы ни открыть, ни прокомментировать.
const ENTRY_KEY = new RegExp(`^${SAFE_NAME}(?:#\\d{1,3})?$`, 'u');
const LEGACY_STEPS = Object.freeze({
  ready: 'Готов — можно забирать',
  waiting: 'Посмотрите и напишите правки',
  working: 'Агент работает',
});
const FOLDER_HASH_ERROR = 'Символ # в имени папки не поддерживается — переименуйте папку';
const MANIFEST_UNREADABLE_ERROR = 'Паспорт ролика не читается';
const FOLDER_UNREADABLE_ERROR = 'Папка ролика не читается';
const MISSING_VIDEO_STEP = 'Видео не найдено — проверьте pult-card.json';
// Реальные рендеры кладут промежуточные файлы вроде layout-revision.raw.mp4, не только
// точное raw.mp4 — суффикс должен отсекать оба варианта, без учёта регистра.
const RAW_RENDER_SUFFIX = /(^|\.)raw\.mp4$/i;

function listFolders(projectsDir) {
  let dirents;
  try {
    dirents = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  // Dirent отражает сам симлинк, поэтому ссылки на чужие папки сюда не попадают.
  // isSafeName дополнительно отсеивает имена с управляющими символами и другими
  // байтами, которые нельзя безопасно адресовать ключом карточки.
  return dirents
    .filter((dirent) => dirent.isDirectory() && !dirent.name.startsWith('.') && isSafeName(dirent.name))
    .map((dirent) => dirent.name)
    .sort((left, right) => left.localeCompare(right));
}

function projectFile(projectDir, relative) {
  try {
    return resolveProjectPath(projectDir, relative, { mustExist: true, type: 'file' });
  } catch (_) {
    return null;
  }
}

function renderHistory(projectDir, manifest) {
  return manifest.renders
    .filter((render) => render.status === 'complete')
    .sort((left, right) => right.version - left.version)
    .flatMap((render) => {
      let names = [];
      try {
        names = fs.readdirSync(path.join(projectDir, ...render.dir.split('/')), { withFileTypes: true })
          .filter((dirent) => dirent.isFile()
            && dirent.name.toLowerCase().endsWith('.mp4')
            && !RAW_RENDER_SUFFIX.test(dirent.name))
          .map((dirent) => dirent.name)
          // final.mp4 всегда первым, дальше по алфавиту — человек должен сразу видеть
          // главный файл рендера, даже если у него несколько экспортов.
          .sort((left, right) => {
            const leftIsFinal = left.toLowerCase() === 'final.mp4';
            const rightIsFinal = right.toLowerCase() === 'final.mp4';
            if (leftIsFinal !== rightIsFinal) return leftIsFinal ? -1 : 1;
            return left.localeCompare(right);
          });
      } catch (_) {
        names = [];
      }
      const version = `v${String(render.version).padStart(2, '0')}`;
      const selected = names.slice(0, 3);
      return selected.map((name) => ({
        // Имя файла в подписи нужно только когда файлов несколько — иначе это шум.
        label: selected.length > 1
          ? `Рендер ${version} — ${render.label} (${name})`
          : `Рендер ${version} — ${render.label}`,
        path: `${render.dir}/${name}`,
      }));
    });
}

function standardEntry(folder, projectDir, manifest, card) {
  const briefEntry = manifest.currentBrief
    ? manifest.briefs.find((brief) => brief.jsonPath === manifest.currentBrief) || null
    : null;
  const briefFile = manifest.currentBrief ? projectFile(projectDir, manifest.currentBrief) : null;
  const pendingComments = countNewComments(projectDir);
  const derived = deriveVariantStatus({
    manifest,
    currentBriefStatus: briefEntry ? briefEntry.status : null,
    currentBriefSha256: briefFile ? hashFile(briefFile) : null,
    finalExists: Boolean(projectFile(projectDir, manifest.final)),
    pendingComments,
  });
  return {
    key: folder,
    folder,
    kind: 'standard',
    title: (card && card.title) || manifest.name,
    group: card && card.group ? card.group : null,
    variantLabel: (card && card.variantLabel) || 'Основной',
    projectKind: manifest.projectKind || 'video',
    updatedAt: manifest.updatedAt,
    pendingComments,
    reviewable: Boolean(manifest.currentBrief),
    history: renderHistory(projectDir, manifest),
    ...derived,
  };
}

function legacyEntries(folder, projectDir, card) {
  const { legacy } = card;
  return legacy.variants.map((variant, index) => {
    const pendingComments = countNewComments(projectDir, variant.video);
    const file = projectFile(projectDir, variant.video);
    let updatedAt = new Date(0).toISOString();
    if (file) {
      try {
        updatedAt = fs.statSync(file).mtime.toISOString();
      } catch (_) {
        // Файл мог исчезнуть между resolveProjectPath и statSync — остаётся эпоха.
      }
    }
    let nextStep;
    if (pendingComments > 0) {
      nextStep = `Ждёт агента: ${pluralEdits(pendingComments)}`;
    } else if (!file) {
      // Карточка ссылается на видео, которого нет на диске — это ошибка карточки,
      // а не обычный шаг монтажа, и должно быть явно видно человеку.
      nextStep = MISSING_VIDEO_STEP;
    } else {
      nextStep = legacy.nextStep || LEGACY_STEPS[legacy.status];
    }
    return {
      key: `${folder}#${index}`,
      folder,
      kind: 'legacy',
      // Папка может быть в NFD (macOS), а заголовок должен выглядеть привычно;
      // сам ключ остаётся «сырым», чтобы не разойтись с именем на диске.
      title: card.title || folder.normalize('NFC'),
      group: card.group || null,
      variantLabel: variant.label,
      projectKind: 'video',
      updatedAt,
      pendingComments,
      reviewable: false,
      history: [],
      status: pendingComments > 0 ? 'working' : legacy.status,
      nextStep,
      video: file ? { kind: variant.final ? 'final' : 'preview', path: variant.video, sha256: null } : null,
      approvable: false,
      needsFinal: false,
      briefPath: null,
      previewSha256: null,
    };
  });
}

// Сканирует одну папку и классифицирует её без исключений наружу — сервер вызывает эту
// функцию и на весь каталог (из scanProjects), и точечно по одному ключу (Task 10), в том
// числе с именем папки, пришедшим из URL. Поэтому здесь же — полная проверка безопасности
// имени, а не только та, что уже прошла через listFolders.
function scanFolder(projectsDir, folder) {
  const empty = () => ({ entries: [], unregistered: [], broken: [] });
  if (!isSafeName(folder)) return empty();
  // APFS и NTFS по умолчанию нечувствительны к регистру и нормализации Unicode:
  // проверка через lstat нашла бы папку «Clip» и по ключу «clip», и по NFC-записи
  // NFD-имени. Сервер обращается сюда по ключу из браузера, поэтому разное написание
  // одной и той же папки не должно давать один результат — иначе архивные id, кэш и
  // билеты утверждения разъедутся между «одинаковыми» на вид ключами. Сверяем точное
  // имя из readdir, а не доверяем тому, что нашла файловая система; заодно это и есть
  // проверка «папка реально существует, это каталог и не симлинк», которую раньше
  // делал отдельный lstat — listFolders уже её выполняет.
  if (!listFolders(projectsDir).includes(folder)) return empty();

  const projectDir = path.join(projectsDir, folder);

  if (folder.includes('#')) {
    // '#' в имени папки конфликтует с разделителем варианта в ключе (`folder#index`):
    // папка `series#0` неотличима от варианта 0 папки `series`. Дальше не сканируем.
    return { entries: [], unregistered: [], broken: [{ folder, error: FOLDER_HASH_ERROR }] };
  }

  const cardResult = readPultCard(projectDir);
  const card = cardResult.ok ? cardResult.card : null;
  const hasManifest = fs.existsSync(path.join(projectDir, 'project.json'));

  if (hasManifest) {
    let manifest = null;
    let manifestReadOk = true;
    try {
      manifest = readProjectManifest(projectDir);
    } catch (_) {
      manifestReadOk = false;
    }
    if (manifestReadOk) {
      try {
        const entry = standardEntry(folder, projectDir, manifest, card);
        // Карточка стандартного проекта необязательна, но если она есть и битая —
        // человек должен увидеть это в «Не читается», а не потерять её незаметно.
        const broken = cardResult.ok ? [] : [{ folder, error: cardResult.error }];
        return { entries: [entry], unregistered: [], broken };
      } catch (_) {
        // Паспорт прочитался, но что-то внутри проекта (например, brief) само не
        // читается — это отдельный класс ошибки от «паспорт не читается».
        return { entries: [], unregistered: [], broken: [{ folder, error: FOLDER_UNREADABLE_ERROR }] };
      }
    }
    if (!(card && card.legacy)) {
      return { entries: [], unregistered: [], broken: [{ folder, error: MANIFEST_UNREADABLE_ERROR }] };
    }
    // project.json битый, но рядом легитимная legacy-карточка — читаем как legacy ниже.
  }

  if (!cardResult.ok) {
    return { entries: [], unregistered: [], broken: [{ folder, error: cardResult.error }] };
  }
  if (card && card.legacy) {
    return { entries: legacyEntries(folder, projectDir, card), unregistered: [], broken: [] };
  }
  return { entries: [], unregistered: [{ folder }], broken: [] };
}

// Ключ варианта — `folder` либо `folder#index`; для точечного поиска (Task 10) нужно имя
// самой папки на диске. Ключ может прийти прямо из запроса браузера, поэтому не строка —
// не паспорт ролика, а просто пустой результат.
function folderFromKey(key) {
  if (typeof key !== 'string') return '';
  return key.replace(/#\d{1,3}$/, '');
}

// Только чтение: сканирование никогда не меняет папки роликов. Одна нечитаемая или
// неожиданно ведущая себя папка не должна ронять весь каталог — сервер зовёт эту функцию
// на каждый запрос.
function scanProjects({ projectsDir }) {
  const entries = [];
  const unregistered = [];
  const broken = [];
  for (const folder of listFolders(projectsDir)) {
    let result;
    try {
      result = scanFolder(projectsDir, folder);
    } catch (_) {
      result = { entries: [], unregistered: [], broken: [{ folder, error: FOLDER_UNREADABLE_ERROR }] };
    }
    entries.push(...result.entries);
    unregistered.push(...result.unregistered);
    broken.push(...result.broken);
  }
  return { entries, unregistered, broken };
}

module.exports = { ENTRY_KEY, folderFromKey, scanFolder, scanProjects };
