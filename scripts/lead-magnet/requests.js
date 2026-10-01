// scripts/lead-magnet/requests.js
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const Ajv = require('ajv');

const schema = require('../../schema/lead-magnet-requests.schema.json');
const { resolveProjectPath } = require('../project/workspace');
const { hashBytes, readJsonIfExists, writeJsonAtomic } = require('../pult/files');
const { openReadOnlyFlags } = require('../filesystem-capabilities');
const { formatAjvErrors, normalizeCodeWord } = require('./constants');
const library = require('./library');
const { readOffers } = require('./offers');
const { normalizeReferenceUrl, REFERENCE_LIMITS, REFS_DIR, sniffReference } = require('./references');

const LABEL = 'pult/lead-magnet.json';
const validateFile = new Ajv({ allErrors: true }).compile(schema);
const MAX_REFERENCE_BYTES = Math.max(...Object.values(REFERENCE_LIMITS));
// Эти решения не требуют работы агента: пульт или движок исполняют их сразу.
const AUTO_ACCEPTED = new Set(['decline', 'reopen', 'link', 'promise-keep']);
const REQUIRED_BY_TYPE = {
  create: ['offerId', 'codeWord', 'params'],
  decline: ['offerId', 'codeWord'],
  reopen: ['offerId', 'codeWord'],
  link: ['offerId', 'codeWord', 'leadMagnetId'],
  'promise-refresh': ['offerId', 'leadMagnetId'],
  'promise-keep': ['offerId', 'leadMagnetId'],
  'funnel-check': ['leadMagnetId'],
};

function decisionsPath(projectDir) {
  return path.join(projectDir, 'pult', 'lead-magnet.json');
}

function hasRequiredFields(decision) {
  return (REQUIRED_BY_TYPE[decision.type] || []).every((field) => Object.hasOwn(decision, field) && decision[field] !== undefined);
}

function readDecisions(projectDir) {
  const value = readJsonIfExists(decisionsPath(projectDir), LABEL);
  if (value === undefined) return [];
  if (!validateFile(value)) throw new Error(`${LABEL}: неверный формат`);
  const seen = new Set();
  for (const decision of value.decisions) {
    if (!hasRequiredFields(decision) || seen.has(decision.id)) throw new Error(`${LABEL}: неверный формат`);
    seen.add(decision.id);
  }
  return value.decisions;
}

function verifyFileReference(projectDir, reference) {
  const invalid = () => new Error('лид-магнит: файл референса изменён или его описание неверно – загрузите заново');
  try {
    const expectedPath = `${REFS_DIR}/${reference.sha256}.${path.posix.extname(reference.path).slice(1)}`;
    if (reference.path !== expectedPath) throw invalid();
    const absolute = resolveProjectPath(projectDir, reference.path, { label: 'reference', mustExist: true, type: 'file' });
    const descriptor = fs.openSync(absolute, openReadOnlyFlags(fs));
    let bytes;
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size !== reference.bytes || stat.size > MAX_REFERENCE_BYTES) throw invalid();
      bytes = fs.readFileSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    const type = sniffReference(bytes);
    if (!type || bytes.length !== reference.bytes || bytes.length > REFERENCE_LIMITS[type.ext]
      || reference.path !== `${REFS_DIR}/${reference.sha256}.${type.ext}`
      || reference.mime !== type.mime || hashBytes(bytes) !== reference.sha256) throw invalid();
  } catch (_) {
    throw invalid();
  }
}

function checkParams(projectDir, params, { hasOffer }) {
  if (hasOffer && params.promiseConfirmed !== true) {
    throw new Error('лид-магнит: подтвердите, что делаем ровно под обещание из ролика');
  }
  const { design } = params;
  if (design.mode === 'reference' && design.references.length === 0) {
    throw new Error('лид-магнит: для дизайна по референсу приложите хотя бы один референс');
  }
  if (design.mode === 'like' && !design.likeId) {
    throw new Error('лид-магнит: выберите образец – прошлый лид-магнит');
  }
  let cta;
  if (Object.hasOwn(params, 'cta') && params.cta !== undefined) {
    if (!params.cta || typeof params.cta !== 'object' || Array.isArray(params.cta)
      || Object.keys(params.cta).some((key) => !['mode', 'title', 'label', 'url'].includes(key))
      || !['brand', 'link', 'none'].includes(params.cta.mode)) {
      throw new Error('лид-магнит: неверный формат призыва');
    }
    for (const [key, limit] of [['title', 120], ['label', 60], ['url', 500]]) {
      if (params.cta[key] !== undefined && (typeof params.cta[key] !== 'string' || params.cta[key].length > limit)) {
        throw new Error('лид-магнит: неверный формат призыва');
      }
    }
    if (params.cta.mode === 'link') {
      const title = String(params.cta.title || '').trim();
      const label = String(params.cta.label || '').trim();
      if (!title || !label) throw new Error('лид-магнит: для своей ссылки нужны заголовок и надпись кнопки');
      let url;
      try { url = new URL(String(params.cta.url || '').trim()); } catch (_) { url = null; }
      if (!url || url.protocol !== 'https:' || url.username || url.password) {
        throw new Error('лид-магнит: своя ссылка должна начинаться с https://');
      }
      cta = { mode: 'link', title, label, url: url.href };
    } else {
      cta = { mode: params.cta.mode, title: '', label: '', url: '' };
    }
  }
  return {
    ...params,
    ...(cta ? { cta } : {}),
    design: {
      ...design,
      references: design.references.map((reference) => {
        if (reference.kind === 'url') return { kind: 'url', url: normalizeReferenceUrl(reference.url) };
        verifyFileReference(projectDir, reference);
        return reference;
      }),
    },
  };
}

function addDecision(projectDir, input, { now = () => new Date(), id = () => `r-${randomBytes(4).toString('hex')}` } = {}) {
  if (!REQUIRED_BY_TYPE[input.type]) throw new Error('лид-магнит: неизвестное решение');
  if (!hasRequiredFields(input)) throw new Error('лид-магнит: обязательные поля решения не заполнены');
  const createdAt = now().toISOString();
  const decision = { id: id(), type: input.type, createdAt, status: 'new' };
  for (const field of REQUIRED_BY_TYPE[input.type]) decision[field] = input[field];
  if (Object.hasOwn(decision, 'codeWord') && decision.codeWord !== null) decision.codeWord = normalizeCodeWord(decision.codeWord);
  if (decision.type === 'promise-keep' || decision.type === 'promise-refresh') {
    const passport = library.readLeadMagnet(path.dirname(projectDir), decision.leadMagnetId);
    if (passport.promise.sourceFolder !== path.basename(projectDir)) {
      throw new Error('лид-магнит: решение об обещании принимает только ролик-источник');
    }
    try {
      resolveProjectPath(projectDir, 'lead-magnet/offers.json',
        { label: 'обещания ролика-источника', mustExist: true, type: 'file' });
    } catch (_) {
      throw new Error('лид-магнит: обещания ролика-источника не читаются');
    }
    const words = passport.promise.sourceFolder === passport.videos[0]
      ? passport.codeWords.slice(0, 1) : passport.codeWords;
    const offers = readOffers(projectDir);
    const current = words.map((word) => offers.find((item) => item.codeWord === word)).find(Boolean) || null;
    if (decision.offerId !== (current ? current.id : null)
      || (decision.type === 'promise-refresh' && !current)) {
      throw new Error('лид-магнит: текущий id обещания не совпадает с роликом-источником');
    }
  }
  let offer = null;
  if (Object.hasOwn(decision, 'offerId') && decision.offerId !== null) {
    offer = readOffers(projectDir).find((item) => item.id === decision.offerId) || null;
    if (!offer && decision.type !== 'promise-keep') throw new Error('лид-магнит: такого обещания у ролика нет');
    if (Object.hasOwn(decision, 'codeWord') && decision.codeWord !== offer.codeWord) {
      throw new Error('лид-магнит: кодовое слово не совпадает с обещанием ролика');
    }
  }
  if (decision.type === 'create') {
    decision.params = checkParams(projectDir, input.params, { hasOffer: decision.offerId !== null });
  }
  if (AUTO_ACCEPTED.has(decision.type)) {
    decision.status = 'accepted';
    decision.acceptedAt = createdAt;
  }
  const value = { version: 1, decisions: [...readDecisions(projectDir), decision] };
  if (!validateFile(value)) throw new Error(`лид-магнит: решение не соответствует схеме: ${formatAjvErrors(validateFile.errors)}`);
  const projectsDir = path.dirname(projectDir);
  if (decision.type === 'link') {
    library.linkVideo(projectsDir, decision.leadMagnetId, { folder: path.basename(projectDir), codeWord: decision.codeWord });
  } else if (decision.type === 'promise-keep') {
    library.acknowledgePromise(projectsDir, decision.leadMagnetId, offer ? offer.quote : null);
  }
  writeJsonAtomic(decisionsPath(projectDir), value);
  return decision;
}

function acceptDecision(projectDir, decisionId, { now = () => new Date() } = {}) {
  const decisions = readDecisions(projectDir);
  const decision = decisions.find((item) => item.id === decisionId);
  if (!decision) throw new Error(`решение ${decisionId} не найдено`);
  if (decision.status === 'accepted') return decision;
  decision.status = 'accepted';
  decision.acceptedAt = now().toISOString();
  writeJsonAtomic(decisionsPath(projectDir), { version: 1, decisions });
  return decision;
}

// Состояние каждого обещания по последнему значимому решению:
// ask – спросить; declined – «Нет»; requested – «Разработать»; linked – «Уже есть готовый».
function offerStates(projectDir) {
  const decisions = readDecisions(projectDir);
  return readOffers(projectDir).map((offer) => {
    let state = 'ask';
    let leadMagnetId = null;
    for (const decision of decisions) {
      if (decision.offerId !== offer.id) continue;
      if (decision.type === 'decline') { state = 'declined'; leadMagnetId = null; }
      if (decision.type === 'reopen') { state = 'ask'; leadMagnetId = null; }
      if (decision.type === 'create') { state = 'requested'; leadMagnetId = null; }
      if (decision.type === 'link') { state = 'linked'; leadMagnetId = decision.leadMagnetId; }
    }
    return { offer, state, leadMagnetId };
  });
}

module.exports = { acceptDecision, addDecision, decisionsPath, offerStates, readDecisions };
