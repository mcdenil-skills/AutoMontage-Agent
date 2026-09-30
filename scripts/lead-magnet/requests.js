// scripts/lead-magnet/requests.js
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const Ajv = require('ajv');

const schema = require('../../schema/lead-magnet-requests.schema.json');
const { resolveProjectPath } = require('../project/workspace');
const { readJsonIfExists, writeJsonAtomic } = require('../pult/files');
const { formatAjvErrors, normalizeCodeWord } = require('./constants');
const { readOffers } = require('./offers');
const { normalizeReferenceUrl } = require('./references');

const LABEL = 'pult/lead-magnet.json';
const validateFile = new Ajv({ allErrors: true }).compile(schema);
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
  return (REQUIRED_BY_TYPE[decision.type] || []).every((field) => Object.hasOwn(decision, field));
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
  return {
    ...params,
    design: {
      ...design,
      references: design.references.map((reference) => {
        if (reference.kind === 'url') return { kind: 'url', url: normalizeReferenceUrl(reference.url) };
        try {
          resolveProjectPath(projectDir, reference.path, { label: 'reference', mustExist: true, type: 'file' });
        } catch (_) {
          throw new Error('лид-магнит: файл референса не найден – загрузите его заново');
        }
        return reference;
      }),
    },
  };
}

function addDecision(projectDir, input, { now = () => new Date(), id = () => `r-${randomBytes(4).toString('hex')}` } = {}) {
  if (!REQUIRED_BY_TYPE[input.type]) throw new Error('лид-магнит: неизвестное решение');
  const createdAt = now().toISOString();
  const decision = { id: id(), type: input.type, createdAt, status: 'new' };
  for (const field of REQUIRED_BY_TYPE[input.type]) decision[field] = input[field];
  if (Object.hasOwn(decision, 'codeWord') && decision.codeWord !== null) decision.codeWord = normalizeCodeWord(decision.codeWord);
  if (Object.hasOwn(decision, 'offerId') && decision.offerId !== null) {
    if (!readOffers(projectDir).some((offer) => offer.id === decision.offerId)) {
      throw new Error('лид-магнит: такого обещания у ролика нет');
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
