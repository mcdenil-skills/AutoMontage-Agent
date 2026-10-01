// tests/lead-magnet-requests.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { addOffer, offersPath } = require('../scripts/lead-magnet/offers');
const library = require('../scripts/lead-magnet/library');
const { deriveLeadMagnetStatus } = require('../scripts/lead-magnet/status');
const { storeReference } = require('../scripts/lead-magnet/references');
const { acceptDecision, addDecision, offerStates, readDecisions } = require('../scripts/lead-magnet/requests');
const { QUOTE, UNITS, makeVideoProject } = require('./helpers/lead-magnet-fixtures');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('x')]);
const NOW = () => new Date('2026-09-30T11:00:00.000Z');
let counter = 0;
const ID = () => `r-${String(counter += 1).padStart(8, '0')}`;

function params(overrides = {}) {
  return {
    format: 'guide',
    audience: 'новички',
    design: { mode: 'brand', take: { composition: true, colors: false, fonts: false }, likeId: null, note: '', references: [] },
    texts: ['dm', 'telegram', 'instagram'],
    wishes: '',
    promiseConfirmed: true,
    ...overrides,
  };
}

function withOffer(t) {
  const context = makeVideoProject(t);
  addOffer(context.projectDir, { codeWord: 'ГАЙД', kind: 'comment-keyword', quote: QUOTE, units: UNITS });
  return context;
}

test('offer states follow the decisions: ask → declined → ask → requested', (t) => {
  const { projectDir } = withOffer(t);
  assert.equal(offerStates(projectDir)[0].state, 'ask');
  addDecision(projectDir, { type: 'decline', offerId: 'o-gayd', codeWord: 'ГАЙД' }, { now: NOW, id: ID });
  assert.equal(offerStates(projectDir)[0].state, 'declined');
  addDecision(projectDir, { type: 'reopen', offerId: 'o-gayd', codeWord: 'ГАЙД' }, { now: NOW, id: ID });
  assert.equal(offerStates(projectDir)[0].state, 'ask');
  const create = addDecision(projectDir, { type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: params() }, { now: NOW, id: ID });
  assert.equal(create.status, 'new');
  assert.equal(offerStates(projectDir)[0].state, 'requested');
});

test('automatic decisions are accepted at once, agent work stays new', (t) => {
  const { projectDir, projectsDir, folder } = withOffer(t);
  const magnet = library.createLeadMagnet(projectsDir, {
    codeWord: 'ГАЙД', title: 'Готовый гайд', promise: { quote: QUOTE, startSec: 60, endSec: 63.9, sourceFolder: folder },
    units: UNITS, params: params(), videoFolder: folder,
  }, { now: NOW });
  const decline = addDecision(projectDir, { type: 'decline', offerId: 'o-gayd', codeWord: 'ГАЙД' }, { now: NOW, id: ID });
  assert.equal(decline.status, 'accepted');
  assert.equal(decline.acceptedAt, decline.createdAt);
  const link = addDecision(projectDir, { type: 'link', offerId: 'o-gayd', codeWord: 'ГАЙД', leadMagnetId: magnet.id }, { now: NOW, id: ID });
  assert.equal(link.status, 'accepted');
  assert.deepEqual(library.readLeadMagnet(projectsDir, magnet.id).videos, [folder]);
  assert.deepEqual(library.readLeadMagnet(projectsDir, magnet.id).codeWords, ['ГАЙД']);
  assert.deepEqual(offerStates(projectDir)[0], { offer: offerStates(projectDir)[0].offer, state: 'linked', leadMagnetId: magnet.id });
  const refresh = addDecision(projectDir, { type: 'promise-refresh', offerId: 'o-gayd', leadMagnetId: magnet.id }, { now: NOW, id: ID });
  assert.equal(refresh.status, 'new');
  acceptDecision(projectDir, refresh.id, { now: NOW });
  assert.equal(readDecisions(projectDir).find((item) => item.id === refresh.id).status, 'accepted');
});

test('link to a missing magnet leaves the decision file absent', (t) => {
  const { projectDir } = withOffer(t);
  assert.throws(() => addDecision(projectDir, {
    type: 'link', offerId: 'o-gayd', codeWord: 'ГАЙД', leadMagnetId: '2026.09.12_gayd',
  }, { now: NOW, id: ID }), /не найден|ENOENT/);
  assert.equal(fs.existsSync(path.join(projectDir, 'pult', 'lead-magnet.json')), false);
});

test('promise-keep acknowledges the current offer quote and restores ready card status', (t) => {
  const { projectDir, projectsDir, folder } = withOffer(t);
  const magnet = library.createLeadMagnet(projectsDir, {
    codeWord: 'ГАЙД', title: 'Готовый гайд', promise: { quote: QUOTE, startSec: 60, endSec: 63.9, sourceFolder: folder },
    units: UNITS, params: params(), videoFolder: folder,
  }, { now: NOW });
  const nextQuote = 'теперь пришлю новый набор промптов';
  const offers = JSON.parse(fs.readFileSync(offersPath(projectDir), 'utf8'));
  offers.offers[0].quote = nextQuote;
  fs.writeFileSync(offersPath(projectDir), JSON.stringify(offers));
  const card = (passport) => deriveLeadMagnetStatus({ passport: { ...passport, current: 1, approved: 1 }, newComments: 0, checkOk: true, currentQuote: nextQuote });
  assert.equal(card(library.readLeadMagnet(projectsDir, magnet.id)).status, 'waiting');
  const decision = addDecision(projectDir, { type: 'promise-keep', offerId: 'o-gayd', leadMagnetId: magnet.id }, { now: NOW, id: ID });
  assert.equal(decision.status, 'accepted');
  assert.deepEqual(library.readLeadMagnet(projectsDir, magnet.id).promise.acknowledged, [nextQuote]);
  assert.equal(card(library.readLeadMagnet(projectsDir, magnet.id)).status, 'ready');
});

test('promise-keep acknowledges a disappeared offer with null', (t) => {
  const { projectDir, projectsDir, folder } = withOffer(t);
  const magnet = library.createLeadMagnet(projectsDir, {
    codeWord: 'ГАЙД', title: 'Готовый гайд', promise: { quote: QUOTE, startSec: 60, endSec: 63.9, sourceFolder: folder },
    units: UNITS, params: params(), videoFolder: folder,
  }, { now: NOW });
  fs.writeFileSync(offersPath(projectDir), JSON.stringify({ version: 1, offers: [] }));
  const card = (passport) => deriveLeadMagnetStatus({ passport: { ...passport, current: 1, approved: 1 }, newComments: 0, checkOk: true, currentQuote: null });
  assert.equal(card(library.readLeadMagnet(projectsDir, magnet.id)).status, 'waiting');
  const decision = addDecision(projectDir, { type: 'promise-keep', offerId: null, leadMagnetId: magnet.id }, { now: NOW, id: ID });
  assert.equal(decision.status, 'accepted');
  assert.deepEqual(library.readLeadMagnet(projectsDir, magnet.id).promise.acknowledged, ['']);
  assert.equal(card(library.readLeadMagnet(projectsDir, magnet.id)).status, 'ready');
});

test('promise-keep without a usable offer id cannot mutate a passport or write a decision', (t) => {
  const { projectDir, projectsDir, folder } = withOffer(t);
  const magnet = library.createLeadMagnet(projectsDir, {
    codeWord: 'ГАЙД', title: 'Готовый гайд', promise: { quote: QUOTE, startSec: 60, endSec: 63.9, sourceFolder: folder },
    units: UNITS, params: params(), videoFolder: folder,
  }, { now: NOW });
  const passportPath = path.join(projectsDir, '.lead-magnets', magnet.id, 'lead-magnet.json');
  const before = fs.readFileSync(passportPath);
  for (const omitted of [
    { type: 'promise-keep', leadMagnetId: magnet.id },
    { type: 'promise-keep', offerId: undefined, leadMagnetId: magnet.id },
    { type: 'promise-keep', offerId: null, leadMagnetId: magnet.id },
  ]) {
    assert.throws(() => addDecision(projectDir, omitted, { now: NOW, id: ID }), /обязательн|формат|id обещания/);
    assert.deepEqual(fs.readFileSync(passportPath), before);
    assert.equal(fs.existsSync(path.join(projectDir, 'pult', 'lead-magnet.json')), false);
  }
});

test('create requires a confirmed promise, references for reference mode and a like id', (t) => {
  const { projectDir } = withOffer(t);
  const create = (p) => addDecision(projectDir, { type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: p }, { now: NOW, id: ID });
  assert.throws(() => create(params({ promiseConfirmed: false })), /обещание/);
  assert.throws(() => create(params({ design: { ...params().design, mode: 'reference' } })), /референс/);
  assert.throws(() => create(params({ design: { ...params().design, mode: 'like' } })), /образец/);
  const ref = storeReference(projectDir, PNG);
  const ok = create(params({ design: { ...params().design, mode: 'reference', references: [ref, { kind: 'url', url: 'https://example.com/' }] } }));
  assert.equal(ok.params.design.references.length, 2);
});

test('unknown offer, missing reference file and unsafe url are rejected', (t) => {
  const { projectDir } = withOffer(t);
  assert.throws(() => addDecision(projectDir, { type: 'decline', offerId: 'o-other', codeWord: 'ДРУГОЕ' }), /обещани/);
  const ghost = { kind: 'file', path: `pult/lead-magnet-refs/${'a'.repeat(64)}.png`, sha256: 'a'.repeat(64), mime: 'image/png', bytes: 1 };
  assert.throws(() => addDecision(projectDir, {
    type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: params({ design: { ...params().design, mode: 'reference', references: [ghost] } }),
  }), /референс/);
  assert.throws(() => addDecision(projectDir, {
    type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: params({ design: { ...params().design, mode: 'reference', references: [{ kind: 'url', url: 'javascript:alert(1)' }] } }),
  }), /ссылка/);
  assert.equal(fs.existsSync(path.join(projectDir, 'pult', 'lead-magnet.json')), false);
});

test('manual create without an offer is allowed and a tampered file is unreadable', (t) => {
  const { projectDir } = withOffer(t);
  const manual = addDecision(projectDir, { type: 'create', offerId: null, codeWord: null, params: params({ promiseConfirmed: false }) }, { now: NOW, id: ID });
  assert.equal(manual.offerId, null);
  fs.writeFileSync(path.join(projectDir, 'pult', 'lead-magnet.json'), JSON.stringify({ version: 1, decisions: [{ id: 'r-00000001', type: 'create', createdAt: 'x', status: 'new' }] }));
  assert.throws(() => readDecisions(projectDir), /неверный формат/);
});

test('decision code word must match its offer after normalization', (t) => {
  const { projectDir } = withOffer(t);
  assert.throws(() => addDecision(projectDir, {
    type: 'decline', offerId: 'o-gayd', codeWord: 'ЧЕКЛИСТ',
  }, { now: NOW, id: ID }), /кодовое слово|обещани/);
  assert.equal(fs.existsSync(path.join(projectDir, 'pult', 'lead-magnet.json')), false);
  const accepted = addDecision(projectDir, {
    type: 'decline', offerId: 'o-gayd', codeWord: '  гайд  ',
  }, { now: NOW, id: ID });
  assert.equal(accepted.codeWord, 'ГАЙД');
});

test('file reference descriptor and stored bytes must match the uploaded reference', (t) => {
  const { projectDir } = withOffer(t);
  const reference = storeReference(projectDir, PNG);
  const create = (file) => addDecision(projectDir, {
    type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД',
    params: params({ design: { ...params().design, mode: 'reference', references: [file] } }),
  }, { now: NOW, id: ID });
  for (const altered of [
    { ...reference, sha256: 'a'.repeat(64) },
    { ...reference, bytes: reference.bytes + 1 },
    { ...reference, mime: 'image/jpeg' },
    { ...reference, path: `pult/lead-magnet-refs/${'a'.repeat(64)}.png` },
  ]) assert.throws(() => create(altered), /референс/);
  assert.equal(fs.existsSync(path.join(projectDir, 'pult', 'lead-magnet.json')), false);
  const alteredBytes = Buffer.from(PNG);
  alteredBytes[alteredBytes.length - 1] ^= 1;
  fs.writeFileSync(path.join(projectDir, reference.path), alteredBytes);
  assert.throws(() => create(reference), /референс/);
  fs.writeFileSync(path.join(projectDir, reference.path), PNG);
  assert.equal(create(reference).params.design.references[0].sha256, reference.sha256);
});

test('the closing call is optional; a custom link needs a title, a label and an https address', (t) => {
  const { projectDir } = withOffer(t);
  const create = (cta) => addDecision(projectDir, { type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: params({ cta }) }, { now: NOW, id: ID });
  const link = create({ mode: 'link', title: 'Хочешь глубже?', label: 'Практикум', url: 'https://example.com/p' });
  assert.deepEqual(link.params.cta, { mode: 'link', title: 'Хочешь глубже?', label: 'Практикум', url: 'https://example.com/p' });
  assert.deepEqual(create({ mode: 'none', title: 'x', label: 'y', url: 'z' }).params.cta, { mode: 'none', title: '', label: '', url: '' });
  assert.throws(() => create({ mode: 'link', title: 'Глубже', label: 'Практикум', url: 'http://example.com' }), /https/);
  assert.throws(() => create({ mode: 'link', title: '', label: 'Практикум', url: 'https://example.com' }), /заголов/);
  assert.equal(create(undefined).params.cta, undefined);
  assert.deepEqual(create({ mode: 'brand' }).params.cta, { mode: 'brand', title: '', label: '', url: '' });
  for (const cta of [null, false, [], { mode: 'bad' }, { mode: 'brand', injected: true },
    { mode: 'link', title: 123, label: 'Кнопка', url: 'https://example.com' },
    { mode: 'link', title: 'x'.repeat(121), label: 'Кнопка', url: 'https://example.com' }]) {
    assert.throws(() => create(cta), /формат/);
  }
  for (const url of ['javascript:alert(1)', 'https://', 'https://user:password@example.com']) {
    assert.throws(() => create({ mode: 'link', title: 'Глубже', label: 'Кнопка', url }), /https/);
  }
  assert.throws(() => create({ mode: 'link', title: 'Глубже', label: ' ', url: 'https://example.com' }), /надпись/);

});
