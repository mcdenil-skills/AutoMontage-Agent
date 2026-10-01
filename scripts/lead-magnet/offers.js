// scripts/lead-magnet/offers.js
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Ajv = require('ajv');

const schema = require('../../schema/lead-magnet-offers.schema.json');
const { resolveProjectPath, slugifyProjectName } = require('../project/workspace');
const { hashFile, readJsonIfExists, writeJsonAtomic } = require('../pult/files');
const { formatAjvErrors, normalizeCodeWord } = require('./constants');
const { findQuoteInSegments, normalizeText, tokenize } = require('./text');

const OFFERS_LABEL = 'lead-magnet/offers.json';
const validateOffers = new Ajv({ allErrors: true }).compile(schema);

function offersPath(projectDir) {
  return path.join(projectDir, 'lead-magnet', 'offers.json');
}

function readOffers(projectDir) {
  const value = readJsonIfExists(offersPath(projectDir), OFFERS_LABEL);
  if (value === undefined) return [];
  if (!validateOffers(value)) throw new Error(`${OFFERS_LABEL}: неверный формат`);
  return value.offers;
}

function transcriptWordsPath(projectDir) {
  const manifest = readJsonIfExists(path.join(projectDir, 'project.json'), 'project.json');
  const stored = manifest && manifest.transcript && manifest.transcript.words;
  if (typeof stored !== 'string') throw new Error('у ролика нет расшифровки: сначала транскрибируй исходник');
  return stored;
}

function resolveSource(projectDir, sourceKind, stored) {
  try {
    return resolveProjectPath(projectDir, stored, { label: 'source', mustExist: true, type: 'file' });
  } catch (_) {
    throw new Error(`источник обещания (${sourceKind}) не найден внутри папки ролика`);
  }
}

function offerId(codeWord) {
  const slug = slugifyProjectName(codeWord);
  if (slug.length <= 60) return `o-${slug}`;
  const suffix = createHash('sha256').update(codeWord).digest('hex').slice(0, 16);
  return `o-${slug.slice(0, 43).replace(/-+$/, '')}-${suffix}`;
}

// Агент не придумывает цитату: она обязана дословно (с точностью до регистра и
// пунктуации) найтись в расшифровке или в утверждённом сценарии. Иначе запись не пишется.
function addOffer(projectDir, input, { now = () => new Date() } = {}) {
  const codeWord = normalizeCodeWord(input.codeWord);
  const sourceKind = input.sourceKind || 'transcript';
  if (sourceKind !== 'transcript' && sourceKind !== 'script') {
    throw new Error('источник обещания: transcript или script');
  }
  const stored = sourceKind === 'transcript' ? transcriptWordsPath(projectDir) : input.scriptPath;
  const absolute = resolveSource(projectDir, sourceKind, stored);
  const quote = String(input.quote || '').trim();
  let startSec = null;
  let endSec = null;
  if (sourceKind === 'transcript') {
    const matches = findQuoteInSegments(JSON.parse(fs.readFileSync(absolute, 'utf8')), quote);
    if (!matches.length) throw new Error('цитата не найдена в расшифровке: скопируй её из words.json дословно');
    // Призыв обычно звучит в концовке: при повторе фразы берём последнее вхождение.
    ({ startSec, endSec } = matches[matches.length - 1]);
  } else {
    if (tokenize(quote).length < 3) throw new Error('цитата обещания слишком короткая: нужно не меньше трёх слов');
    const haystack = ` ${normalizeText(fs.readFileSync(absolute, 'utf8'))} `;
    if (!haystack.includes(` ${normalizeText(quote)} `)) {
      throw new Error('цитата не найдена в сценарии: скопируй её дословно');
    }
  }
  const offer = {
    id: offerId(codeWord),
    codeWord,
    kind: input.kind,
    quote,
    source: { kind: sourceKind, path: stored, sha256: hashFile(absolute) },
    startSec,
    endSec,
    units: input.units,
    suggest: { format: input.format || 'guide', audience: input.audience || '' },
    detectedAt: now().toISOString(),
  };
  const value = { version: 1, offers: [...readOffers(projectDir).filter((item) => item.id !== offer.id), offer] };
  if (!validateOffers(value)) {
    throw new Error(`обещание не соответствует схеме: ${formatAjvErrors(validateOffers.errors)}`);
  }
  writeJsonAtomic(offersPath(projectDir), value);
  return offer;
}

module.exports = { addOffer, offersPath, readOffers };
