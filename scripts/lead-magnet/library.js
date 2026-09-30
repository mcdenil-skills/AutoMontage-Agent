// scripts/lead-magnet/library.js
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');

const passportSchema = require('../../schema/lead-magnet.schema.json');
const requestsSchema = require('../../schema/lead-magnet-requests.schema.json');
const { resolveProjectPath, slugifyProjectName } = require('../project/workspace');
const { ensureDirectory, hashFile, readJsonIfExists, writeJsonAtomic } = require('../pult/files');
const { isSafeName } = require('../pult/names');
const { DECISION_ID, LEAD_MAGNET_ID, LIBRARY_DIR, TEXT_FILES, formatAjvErrors, normalizeCodeWord } = require('./constants');
const { normalizeText } = require('./text');

const ajv = new Ajv({ allErrors: true });
ajv.addSchema(requestsSchema, 'lead-magnet-requests.schema.json');
const validatePassport = ajv.compile(passportSchema);
const PASSPORT = 'lead-magnet.json';

function libraryRoot(projectsDir) {
  return resolveProjectPath(projectsDir, LIBRARY_DIR, { label: 'библиотека лид-магнитов', type: 'directory' });
}

function leadMagnetDir(projectsDir, id) {
  if (typeof id !== 'string' || !LEAD_MAGNET_ID.test(id)) throw new Error('лид-магнит: неверный id');
  return resolveProjectPath(projectsDir, path.join(LIBRARY_DIR, id), { label: 'лид-магнит', type: 'directory' });
}

function revisionDir(projectsDir, id, n) {
  if (!Number.isInteger(n) || n < 1 || n > 99) throw new Error('лид-магнит: неверный номер ревизии');
  leadMagnetDir(projectsDir, id);
  return resolveProjectPath(projectsDir, path.join(LIBRARY_DIR, id, `v${String(n).padStart(2, '0')}`),
    { label: 'ревизия', type: 'directory' });
}

function passportPath(projectsDir, id) {
  leadMagnetDir(projectsDir, id);
  return resolveProjectPath(projectsDir, path.join(LIBRARY_DIR, id, PASSPORT), { label: PASSPORT, type: 'file' });
}

function revisionFile(projectsDir, id, n, relative) {
  revisionDir(projectsDir, id, n);
  return resolveProjectPath(projectsDir,
    path.join(LIBRARY_DIR, id, `v${String(n).padStart(2, '0')}`, relative),
    { label: `ревизия ${relative}`, type: 'file' });
}

function readLeadMagnet(projectsDir, id) {
  const value = readJsonIfExists(passportPath(projectsDir, id), PASSPORT);
  if (value === undefined) throw new Error(`лид-магнит ${id} не найден`);
  if (value && typeof value === 'object' && !Array.isArray(value) && !Object.hasOwn(value, 'request')) {
    value.request = null;
  }
  if (!validatePassport(value) || value.id !== id) throw new Error(`${PASSPORT}: не соответствует схеме`);
  return value;
}

function savePassport(projectsDir, passport, now) {
  const next = { ...passport, updatedAt: now().toISOString() };
  if (!validatePassport(next)) throw new Error(`${PASSPORT}: ${formatAjvErrors(validatePassport.errors)}`);
  writeJsonAtomic(passportPath(projectsDir, next.id), next);
  return next;
}

function datePrefix(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
}

function assertFolder(folder) {
  if (!isSafeName(folder)) throw new Error('лид-магнит: неверная папка ролика');
  return folder;
}

function createLeadMagnet(projectsDir, input, { now = () => new Date() } = {}) {
  const codeWord = normalizeCodeWord(input.codeWord);
  const folder = assertFolder(input.videoFolder);
  const request = input.request === undefined ? null : input.request;
  if (request !== null && (typeof request !== 'object' || Array.isArray(request)
    || !isSafeName(request.folder) || request.folder !== folder || !DECISION_ID.test(request.decisionId))) {
    throw new Error('лид-магнит: неверный запрос');
  }
  const createdAt = now();
  ensureDirectory(libraryRoot(projectsDir));
  const prefix = `${datePrefix(createdAt)}_`;
  const slug = slugifyProjectName(codeWord);
  const base = `${prefix}${slug.slice(0, 80).replace(/-+$/, '')}`;
  let id = base;
  for (let attempt = 2; ; attempt += 1) {
    try {
      fs.mkdirSync(leadMagnetDir(projectsDir, id));
      break;
    } catch (error) {
      if (!error || error.code !== 'EEXIST' || attempt > 99) throw error;
      const suffix = `-${attempt}`;
      id = `${prefix}${slug.slice(0, 80 - suffix.length).replace(/-+$/, '')}${suffix}`;
    }
  }
  const passport = {
    version: 1,
    id,
    title: input.title,
    request,
    codeWords: [codeWord],
    promise: { ...input.promise, acknowledged: [] },
    units: input.units,
    params: input.params,
    videos: [folder],
    revisions: [],
    current: null,
    approved: null,
    createdAt: createdAt.toISOString(),
    updatedAt: createdAt.toISOString(),
  };
  try {
    return savePassport(projectsDir, passport, () => createdAt);
  } catch (error) {
    fs.rmSync(leadMagnetDir(projectsDir, id), { recursive: true, force: true });
    throw error;
  }
}

function listLeadMagnets(projectsDir) {
  let dirents;
  try {
    dirents = fs.readdirSync(libraryRoot(projectsDir), { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return { entries: [], broken: [] };
    throw error;
  }
  const entries = [];
  const broken = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || !LEAD_MAGNET_ID.test(dirent.name)) continue;
    try {
      entries.push(readLeadMagnet(projectsDir, dirent.name));
    } catch (error) {
      broken.push({ id: dirent.name, error: error.message });
    }
  }
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { entries, broken };
}

// Утверждённые – первыми: именно их предлагает кнопка «Уже есть готовый».
function findByCodeWord(projectsDir, codeWord) {
  const word = normalizeCodeWord(codeWord);
  const matches = listLeadMagnets(projectsDir).entries
    .filter((item) => item.codeWords.includes(word))
    .sort((a, b) => Number(b.approved !== null) - Number(a.approved !== null)
      || b.createdAt.localeCompare(a.createdAt)
      || b.id.localeCompare(a.id));
  return matches;
}

function linkVideo(projectsDir, id, { folder, codeWord }, { now = () => new Date() } = {}) {
  const passport = readLeadMagnet(projectsDir, id);
  const word = normalizeCodeWord(codeWord);
  assertFolder(folder);
  return savePassport(projectsDir, {
    ...passport,
    videos: passport.videos.includes(folder) ? passport.videos : [...passport.videos, folder],
    codeWords: passport.codeWords.includes(word) ? passport.codeWords : [...passport.codeWords, word],
  }, now);
}

function startRevision(projectsDir, id, { now = () => new Date() } = {}) {
  const passport = readLeadMagnet(projectsDir, id);
  const n = passport.revisions.length + 1;
  const dir = revisionDir(projectsDir, id, n);
  fs.mkdirSync(dir);
  fs.mkdirSync(resolveProjectPath(projectsDir, path.join(LIBRARY_DIR, id, path.basename(dir), 'texts'),
    { label: 'тексты ревизии', type: 'directory' }));
  fs.mkdirSync(resolveProjectPath(projectsDir, path.join(LIBRARY_DIR, id, path.basename(dir), 'qa'),
    { label: 'проверка ревизии', type: 'directory' }));
  savePassport(projectsDir, {
    ...passport,
    revisions: [...passport.revisions, { n, dir: path.basename(dir), status: 'building', pageSha256: null, createdAt: now().toISOString() }],
  }, now);
  return { n, dir };
}

function requiredRevisionFiles(passport) {
  return ['page.html', 'page.pdf', 'content.md', 'facts.json', ...passport.params.texts.map((kind) => TEXT_FILES[kind])];
}

function publishRevision(projectsDir, id, n, { now = () => new Date() } = {}) {
  const passport = readLeadMagnet(projectsDir, id);
  const revision = passport.revisions.find((item) => item.n === n);
  if (!revision || revision.status !== 'building') throw new Error(`ревизия ${n} не собирается сейчас`);
  revisionDir(projectsDir, id, n);
  for (const relative of requiredRevisionFiles(passport)) {
    const stat = fs.lstatSync(revisionFile(projectsDir, id, n, relative), { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) throw new Error(`ревизии не хватает файла ${relative}`);
  }
  const pageSha256 = hashFile(revisionFile(projectsDir, id, n, 'page.html'));
  const report = readJsonIfExists(revisionFile(projectsDir, id, n, 'qa/check.json'), 'qa/check.json');
  if (!report || report.pageSha256 !== pageSha256) {
    throw new Error('сначала запусти проверку: automontage lead-magnet check');
  }
  const publishedAt = now().toISOString();
  return savePassport(projectsDir, {
    ...passport,
    current: n,
    revisions: passport.revisions.map((item) => (item.n === n ? { ...item, status: 'draft', pageSha256, publishedAt } : item)),
  }, now);
}

// «Оставить как есть» при изменившемся обещании: новая цитата больше не считается расхождением.
function acknowledgePromise(projectsDir, id, quote, { now = () => new Date() } = {}) {
  const passport = readLeadMagnet(projectsDir, id);
  const normalized = quote === null ? '' : normalizeText(quote);
  const acknowledged = passport.promise.acknowledged.includes(normalized)
    ? passport.promise.acknowledged
    : [...passport.promise.acknowledged, normalized];
  return savePassport(projectsDir, { ...passport, promise: { ...passport.promise, acknowledged } }, now);
}

// «Обновить под новое»: агент переносит новую цитату в паспорт перед новой ревизией.
function updatePromise(projectsDir, id, promise, { now = () => new Date(), units } = {}) {
  const passport = readLeadMagnet(projectsDir, id);
  return savePassport(projectsDir, { ...passport, units: units === undefined ? passport.units : units, promise: { ...promise, acknowledged: [] } }, now);
}

module.exports = {
  acknowledgePromise,
  createLeadMagnet,
  findByCodeWord,
  leadMagnetDir,
  libraryRoot,
  linkVideo,
  listLeadMagnets,
  publishRevision,
  readLeadMagnet,
  requiredRevisionFiles,
  revisionDir,
  savePassport,
  startRevision,
  updatePromise,
};
