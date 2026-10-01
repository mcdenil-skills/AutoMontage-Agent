const path = require('node:path');

const { countNewLeadMagnetComments } = require('../lead-magnet/comments');
const { listLeadMagnets } = require('../lead-magnet/library');
const { readOffers } = require('../lead-magnet/offers');
const { revisionReadiness } = require('../lead-magnet/readiness');
const { offerStates, readDecisions } = require('../lead-magnet/requests');
const { deriveLeadMagnetStatus } = require('../lead-magnet/status');
const { STATUS_ORDER } = require('./status');

const PENDING_STEP = 'Агент готовит лид-магнит';
const BROKEN_STEP = 'Лид-магнит: файл повреждён – попросите агента проверить';
const BROKEN_FOLDER = 'Файл обещаний или решений лид-магнита повреждён – попросите агента проверить';
const BROKEN_LIBRARY = 'Библиотека лид-магнитов: файл повреждён – попросите агента проверить';

// Один проход по библиотеке на запрос: какие лид-магниты привязаны к какой папке ролика.
function buildLeadMagnetIndex(projectsDir) {
  const { entries, broken } = listLeadMagnets(projectsDir);
  const byFolder = new Map();
  for (const passport of entries) {
    for (const folder of passport.videos) {
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      byFolder.get(folder).push(passport);
    }
  }
  return { entries, broken, byFolder };
}

// undefined – сравнивать не с чем (не ролик-источник); null – обещание с этим
// словом из ролика-источника пропало; строка – текущая цитата.
function currentQuoteFor(projectsDir, passport) {
  const folder = passport.promise.sourceFolder;
  if (!folder || !passport.promise.quote) return undefined;
  let offers;
  try {
    offers = readOffers(path.join(projectsDir, folder));
  } catch (_) {
    return undefined;
  }
  // Первое слово задано при создании паспорта; linkVideo дописывает слова других роликов.
  // По ним нельзя подменять исчезнувшее обещание ролика-источника.
  const match = offers.find((offer) => offer.codeWord === passport.codeWords[0]);
  return match ? match.quote : null;
}

function magnetSummary(projectsDir, passport) {
  const base = {
    id: passport.id, title: passport.title, codeWords: passport.codeWords, current: passport.current, approved: passport.approved,
  };
  try {
    const newComments = countNewLeadMagnetComments(projectsDir, passport.id);
    const needsCheck = passport.current !== null && passport.current !== passport.approved;
    const checkOk = needsCheck ? revisionReadiness(projectsDir, passport, passport.current).ok : false;
    const status = deriveLeadMagnetStatus({ passport, newComments, checkOk, currentQuote: currentQuoteFor(projectsDir, passport) });
    return { ...base, newComments, error: false, ...status, promiseChanged: Boolean(status.promiseChanged) };
  } catch (_) {
    return { ...base, newComments: 0, error: true, status: 'working', nextStep: BROKEN_STEP, approvable: false, promiseChanged: false };
  }
}

function offerForBrowser({ offer, state, leadMagnetId }) {
  return {
    offerId: offer.id, codeWord: offer.codeWord, kind: offer.kind, quote: offer.quote,
    startSec: offer.startSec, endSec: offer.endSec, units: offer.units, suggest: offer.suggest, state, leadMagnetId,
  };
}

function folderLeadMagnet(projectsDir, folder, index) {
  const projectDir = path.join(projectsDir, folder);
  let states = [];
  let decisions = [];
  let error = index.broken?.length ? BROKEN_LIBRARY : null;
  try {
    states = offerStates(projectDir);
    decisions = readDecisions(projectDir);
  } catch (_) {
    states = [];
    decisions = [];
    error = BROKEN_FOLDER;
  }
  const linked = index.byFolder.get(folder) || [];
  const magnets = linked.map((passport) => magnetSummary(projectsDir, passport));
  // Запрос «Разработать» ждёт агента, пока по нему не создан паспорт (create идемпотентен
  // и записывает request.decisionId).
  const created = new Set(index.entries
    .filter((passport) => passport.request && passport.request.folder === folder)
    .map((passport) => passport.request.decisionId));
  const pending = decisions
    .filter((decision) => decision.type === 'create' && decision.status === 'new' && !created.has(decision.id))
    .map((decision) => decision.codeWord);
  const candidates = magnets.map((magnet) => ({ status: magnet.status, nextStep: magnet.nextStep }));
  if (pending.length) candidates.push({ status: 'working', nextStep: PENDING_STEP });
  const broken = error || magnets.some((magnet) => magnet.error);
  const top = broken ? { status: 'working', nextStep: BROKEN_STEP }
    : candidates.sort((left, right) => STATUS_ORDER[left.status] - STATUS_ORDER[right.status])[0] || null;
  return {
    offers: states.map(offerForBrowser),
    pending,
    magnets,
    error,
    status: top ? top.status : null,
    nextStep: top ? top.nextStep : null,
  };
}

// Лёгкая сводка для /api/cards: только то, что нужно лицу карточки и выбору раздела.
function attachLeadMagnets(projectsDir, entries) {
  let index;
  try {
    index = buildLeadMagnetIndex(projectsDir);
  } catch (_) {
    index = { entries: [], broken: [{ id: null }], byFolder: new Map() };
  }
  const byFolder = new Map();
  return entries.map((entry) => {
    if (!byFolder.has(entry.folder)) {
      const folderView = folderLeadMagnet(projectsDir, entry.folder, index);
      const ask = folderView.offers.some((offer) => offer.state === 'ask');
      byFolder.set(entry.folder, ask || folderView.status
        ? { ask, status: folderView.status, nextStep: folderView.nextStep }
        : null);
    }
    const leadMagnet = byFolder.get(entry.folder);
    return leadMagnet ? { ...entry, leadMagnet } : entry;
  });
}

module.exports = { attachLeadMagnets, buildLeadMagnetIndex, folderLeadMagnet, magnetSummary };
