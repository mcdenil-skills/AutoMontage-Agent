// tests/lead-magnet-offers.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { addOffer, readOffers } = require('../scripts/lead-magnet/offers');
const { QUOTE, UNITS, makeVideoProject } = require('./helpers/lead-magnet-fixtures');

const NOW = () => new Date('2026-09-30T10:00:00.000Z');

test('offer stores the verbatim quote with the transcript timecode', (t) => {
  const { projectDir } = makeVideoProject(t);
  const offer = addOffer(projectDir, {
    codeWord: 'гайд', kind: 'comment-keyword', quote: QUOTE, units: UNITS, format: 'guide', audience: 'новички',
  }, { now: NOW });
  assert.equal(offer.id, 'o-gayd');
  assert.equal(offer.codeWord, 'ГАЙД');
  assert.equal(offer.startSec, 60);
  assert.equal(offer.endSec, 63.75);
  assert.equal(offer.source.kind, 'transcript');
  assert.equal(offer.source.path, 'transcript/words.json');
  assert.match(offer.source.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(readOffers(projectDir), [offer]);
});

test('re-detecting the same code word replaces the offer instead of duplicating it', (t) => {
  const { projectDir } = makeVideoProject(t);
  addOffer(projectDir, { codeWord: 'ГАЙД', kind: 'comment-keyword', quote: QUOTE, units: UNITS }, { now: NOW });
  addOffer(projectDir, { codeWord: 'гайд', kind: 'dm', quote: QUOTE, units: UNITS }, { now: NOW });
  const offers = readOffers(projectDir);
  assert.equal(offers.length, 1);
  assert.equal(offers[0].kind, 'dm');
});

test('valid long Cyrillic code words get bounded, stable, distinct IDs', (t) => {
  const { projectDir } = makeVideoProject(t);
  const firstWord = 'Щ'.repeat(40);
  const secondWord = `${'Щ'.repeat(39)}Ш`;
  const input = { kind: 'comment-keyword', quote: QUOTE, units: UNITS };
  const first = addOffer(projectDir, { ...input, codeWord: firstWord }, { now: NOW });
  const second = addOffer(projectDir, { ...input, codeWord: secondWord }, { now: NOW });
  assert.match(first.id, /^o-[a-z0-9-]{1,60}$/);
  assert.match(second.id, /^o-[a-z0-9-]{1,60}$/);
  assert.notEqual(first.id, second.id);
  assert.equal(addOffer(projectDir, { ...input, codeWord: firstWord.toLowerCase() }, { now: NOW }).id, first.id);
  assert.equal(readOffers(projectDir).length, 2);
});

test('a quote that is not in the speech is rejected and nothing is written', (t) => {
  const { projectDir } = makeVideoProject(t);
  assert.throws(
    () => addOffer(projectDir, { codeWord: 'ГАЙД', kind: 'comment-keyword', quote: 'пришлю тринадцать промптов бесплатно', units: UNITS }),
    /цитата не найдена/,
  );
  assert.equal(fs.existsSync(path.join(projectDir, 'lead-magnet', 'offers.json')), false);
});

test('script source verifies the quote in the script and leaves timecodes empty', (t) => {
  const { projectDir } = makeVideoProject(t);
  fs.writeFileSync(path.join(projectDir, 'script.txt'), `Финал. ${QUOTE.toUpperCase()}!`);
  const offer = addOffer(projectDir, {
    codeWord: 'ГАЙД', kind: 'comment-keyword', quote: QUOTE, units: UNITS, sourceKind: 'script', scriptPath: 'script.txt',
  }, { now: NOW });
  assert.equal(offer.startSec, null);
  assert.equal(offer.source.kind, 'script');
  assert.throws(() => addOffer(projectDir, {
    codeWord: 'ГАЙД', kind: 'comment-keyword', quote: QUOTE, units: UNITS, sourceKind: 'script', scriptPath: '../outside.txt',
  }), /источник обещания/);
});

test('invalid units and tampered offers.json are rejected', (t) => {
  const { projectDir } = makeVideoProject(t);
  assert.throws(() => addOffer(projectDir, {
    codeWord: 'ГАЙД', kind: 'comment-keyword', quote: QUOTE, units: [{ key: 'Bad Key', count: 1, label: 'x' }],
  }), /схеме/);
  fs.mkdirSync(path.join(projectDir, 'lead-magnet'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'lead-magnet', 'offers.json'), JSON.stringify({ version: 1, offers: [{ id: 'x' }] }));
  assert.throws(() => readOffers(projectDir), /неверный формат/);
});
