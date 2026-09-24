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
          .filter((dirent) => dirent.isFile() && dirent.name.toLowerCase().endsWith('.mp4') && dirent.name !== 'raw.mp4')
          .map((dirent) => dirent.name)
          .sort();
      } catch (_) {
        names = [];
      }
      const version = `v${String(render.version).padStart(2, '0')}`;
      return names.slice(0, 3).map((name) => ({
        label: `Рендер ${version} — ${render.label}`,
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
    if (file) updatedAt = fs.statSync(file).mtime.toISOString();
    return {
      key: `${folder}#${index}`,
      folder,
      kind: 'legacy',
      title: card.title || folder,
      group: card.group || null,
      variantLabel: variant.label,
      projectKind: 'video',
      updatedAt,
      pendingComments,
      reviewable: false,
      history: [],
      status: pendingComments > 0 ? 'working' : legacy.status,
      nextStep: pendingComments > 0
        ? `Ждёт агента: ${pluralEdits(pendingComments)}`
        : (legacy.nextStep || LEGACY_STEPS[legacy.status]),
      video: file ? { kind: variant.final ? 'final' : 'preview', path: variant.video, sha256: null } : null,
      approvable: false,
      needsFinal: false,
      briefPath: null,
      previewSha256: null,
    };
  });
}

// Только чтение: сканирование никогда не меняет папки роликов.
function scanProjects({ projectsDir }) {
  const entries = [];
  const unregistered = [];
  const broken = [];
  for (const folder of listFolders(projectsDir)) {
    const projectDir = path.join(projectsDir, folder);
    const cardResult = readPultCard(projectDir);
    const card = cardResult.ok ? cardResult.card : null;
    if (fs.existsSync(path.join(projectDir, 'project.json'))) {
      try {
        entries.push(standardEntry(folder, projectDir, readProjectManifest(projectDir), card));
        continue;
      } catch (_) {
        if (!(card && card.legacy)) {
          broken.push({ folder, error: 'Паспорт ролика не читается' });
          continue;
        }
      }
    }
    if (!cardResult.ok) {
      broken.push({ folder, error: cardResult.error });
      continue;
    }
    if (card && card.legacy) {
      entries.push(...legacyEntries(folder, projectDir, card));
      continue;
    }
    unregistered.push({ folder });
  }
  return { entries, unregistered, broken };
}

module.exports = { ENTRY_KEY, scanProjects };
