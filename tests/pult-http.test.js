const test = require('node:test');
const assert = require('node:assert/strict');

const { hasUnsafePath, requestToken, safeTokenEqual } = require('../scripts/pult/http');

test('unsafe request targets are detected', () => {
  for (const target of ['/media/../x', '/%2e%2e/x', '/a\\b', '/a%5cb', '/a%00', '/%E0%A4%A']) {
    assert.equal(hasUnsafePath(target), true, target);
  }
  for (const target of ['/', '/api/cards', '/media/video?key=a%2Fb']) {
    assert.equal(hasUnsafePath(target), false, target);
  }
});

test('tokens come from the bearer header, or from the query only for media', () => {
  assert.equal(requestToken({ headers: {} }, new URL('http://127.0.0.1/api/cards?token=q')), null);
  assert.equal(requestToken({ headers: { authorization: 'Bearer abc' } }, new URL('http://127.0.0.1/api/cards')), 'abc');
  assert.equal(requestToken({ headers: {} }, new URL('http://127.0.0.1/media/video?token=q')), 'q');
  assert.equal(safeTokenEqual('abc', 'abc'), true);
  assert.equal(safeTokenEqual('abc', 'abd'), false);
  assert.equal(safeTokenEqual('abc', 'abcd'), false);
  assert.equal(safeTokenEqual(null, 'abc'), false);
});
