const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCards } = require('../scripts/pult/cards');

function entry(overrides) {
  return {
    key: overrides.folder,
    kind: 'standard',
    title: 'Без названия',
    group: null,
    variantLabel: 'Основной',
    updatedAt: '2026-09-20T10:00:00.000Z',
    status: 'ready',
    nextStep: 'Готов — можно забирать',
    ...overrides,
  };
}

const scan = (entries, extra = {}) => ({ entries, unregistered: [], broken: [], ...extra });

test('variants of one group become one card with the most urgent status', () => {
  const group = { id: 'value-thing', title: 'Самая ценная вещь' };
  const sections = buildCards(scan([
    entry({ folder: 'hook-1', group, variantLabel: 'Хук 1' }),
    entry({ folder: 'hook-2', group, variantLabel: 'Хук 2', status: 'waiting', nextStep: 'Посмотрите preview и утвердите' }),
    entry({ folder: 'solo', title: 'Отдельный' }),
  ]));
  assert.equal(sections.waiting.length, 1);
  const card = sections.waiting[0];
  assert.equal(card.id, 'group:value-thing');
  assert.equal(card.title, 'Самая ценная вещь');
  assert.equal(card.nextStep, 'Хук 2: Посмотрите preview и утвердите');
  assert.deepEqual(card.variants.map((variant) => variant.variantLabel), ['Хук 1', 'Хук 2']);
  assert.deepEqual(sections.ready.map((item) => item.id), ['folder:solo']);
});

test('cards are ordered by urgency, then newest first', () => {
  const sections = buildCards(scan([
    entry({ folder: 'old', status: 'working', updatedAt: '2026-09-01T00:00:00.000Z' }),
    entry({ folder: 'new', status: 'working', updatedAt: '2026-09-22T00:00:00.000Z' }),
  ]));
  assert.deepEqual(sections.working.map((card) => card.id), ['folder:new', 'folder:old']);
});

test('archived cards leave the active sections', () => {
  const sections = buildCards(scan([entry({ folder: 'a' }), entry({ folder: 'b' })]), { archived: ['folder:a'] });
  assert.deepEqual(sections.ready.map((card) => card.id), ['folder:b']);
  assert.deepEqual(sections.archive.map((card) => [card.id, card.archived]), [['folder:a', true]]);
});

test('unregistered and broken folders are passed through', () => {
  const sections = buildCards(scan([], {
    unregistered: [{ folder: 'research' }],
    broken: [{ folder: 'old', error: 'Паспорт ролика не читается' }],
  }));
  assert.deepEqual(sections.unregistered, [{ folder: 'research' }]);
  assert.deepEqual(sections.broken, [{ folder: 'old', error: 'Паспорт ролика не читается' }]);
});
