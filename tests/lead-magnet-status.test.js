const test = require('node:test');
const assert = require('node:assert/strict');

const { deriveLeadMagnetStatus } = require('../scripts/lead-magnet/status');

const QUOTE = 'и я пришлю пошаговую инструкцию';
function passport(overrides = {}) {
  return {
    current: null, approved: null, revisions: [],
    promise: { quote: QUOTE, startSec: 1, endSec: 2, sourceFolder: 'clip', acknowledged: [] },
    ...overrides,
  };
}
const draft = { current: 1, revisions: [{ n: 1, status: 'draft' }] };
const approved = { current: 1, approved: 1, revisions: [{ n: 1, status: 'approved' }] };

test('status order: promise changed → comments → approved → draft → building', () => {
  const base = { newComments: 0, checkOk: true, currentQuote: QUOTE };
  assert.deepEqual(deriveLeadMagnetStatus({ ...base, passport: passport() }), { status: 'working', nextStep: 'Агент готовит лид-магнит', approvable: false });
  assert.deepEqual(deriveLeadMagnetStatus({ ...base, passport: passport(draft) }), { status: 'waiting', nextStep: 'Лид-магнит: посмотрите и утвердите', approvable: true });
  assert.equal(deriveLeadMagnetStatus({ ...base, checkOk: false, passport: passport(draft) }).nextStep, 'Лид-магнит: проверка не пройдена – агент исправляет');
  assert.deepEqual(deriveLeadMagnetStatus({ ...base, passport: passport(approved) }), { status: 'ready', nextStep: 'Лид-магнит утверждён', approvable: false });
  assert.deepEqual(deriveLeadMagnetStatus({ ...base, newComments: 2, passport: passport(draft) }), { status: 'working', nextStep: 'Лид-магнит: ждёт агента, правок: 2', approvable: false });
  const changed = deriveLeadMagnetStatus({ ...base, newComments: 2, currentQuote: 'и я пришлю семь промптов', passport: passport(approved) });
  assert.deepEqual(changed, { status: 'waiting', nextStep: 'Обещание в ролике изменилось – проверьте лид-магнит', approvable: false, promiseChanged: true });
});

test('a missing promise counts as changed; acknowledged and punctuation-only changes do not', () => {
  const base = { newComments: 0, checkOk: true, passport: passport(approved) };
  assert.equal(deriveLeadMagnetStatus({ ...base, currentQuote: null }).promiseChanged, true);
  assert.equal(deriveLeadMagnetStatus({ ...base, currentQuote: 'И я пришлю — пошаговую инструкцию!' }).status, 'ready');
  const acknowledged = passport({ ...approved, promise: { ...passport().promise, acknowledged: ['и я пришлю семь промптов'] } });
  assert.equal(deriveLeadMagnetStatus({ ...base, passport: acknowledged, currentQuote: 'и я пришлю семь промптов' }).status, 'ready');
  assert.equal(deriveLeadMagnetStatus({ ...base, currentQuote: undefined }).status, 'ready');
});
