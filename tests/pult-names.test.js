const test = require('node:test');
const assert = require('node:assert/strict');

const { SAFE_NAME, isSafeName } = require('../scripts/pult/names');

test('safe names accept real-world folder names', () => {
  const accepted = [
    '2026.08.19_finalnyy-den-ai-birthday',
    'мой ролик',
    'мой ролик'.normalize('NFD'),
    'ёлка'.normalize('NFD'),
    "Серия (часть 2) + бонус, O'Neil & co",
  ];
  for (const name of accepted) {
    assert.equal(isSafeName(name), true, name);
  }
});

test('safe names reject empty, dot-prefixed, path-breaking and control-char values', () => {
  const rejected = [
    '',
    '.',
    '..',
    '.pult',
    'a/b',
    'a\\b',
    'a\u0000b',
    'a\nb',
    'x'.repeat(256),
    null,
    undefined,
    42,
    {},
  ];
  for (const name of rejected) {
    assert.equal(isSafeName(name), false, String(name));
  }
});

test('SAFE_NAME compiles into a working anchored pattern', () => {
  const pattern = new RegExp(`^${SAFE_NAME}$`, 'u');
  assert.equal(pattern.test('a'), true);
  assert.equal(pattern.test('x'.repeat(255)), true);
  assert.equal(pattern.test(''), false);
  assert.equal(pattern.test('.'), false);
  assert.equal(pattern.test('a/b'), false);
});
