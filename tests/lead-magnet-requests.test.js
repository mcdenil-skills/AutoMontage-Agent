// tests/lead-magnet-requests.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { addOffer } = require('../scripts/lead-magnet/offers');
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
  const { projectDir } = withOffer(t);
  const decline = addDecision(projectDir, { type: 'decline', offerId: 'o-gayd', codeWord: 'ГАЙД' }, { now: NOW, id: ID });
  assert.equal(decline.status, 'accepted');
  assert.equal(decline.acceptedAt, decline.createdAt);
  const link = addDecision(projectDir, { type: 'link', offerId: 'o-gayd', codeWord: 'ГАЙД', leadMagnetId: '2026.09.12_gayd' }, { now: NOW, id: ID });
  assert.equal(link.status, 'accepted');
  assert.deepEqual(offerStates(projectDir)[0], { offer: offerStates(projectDir)[0].offer, state: 'linked', leadMagnetId: '2026.09.12_gayd' });
  const refresh = addDecision(projectDir, { type: 'promise-refresh', offerId: 'o-gayd', leadMagnetId: '2026.09.12_gayd' }, { now: NOW, id: ID });
  assert.equal(refresh.status, 'new');
  acceptDecision(projectDir, refresh.id, { now: NOW });
  assert.equal(readDecisions(projectDir).find((item) => item.id === refresh.id).status, 'accepted');
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
