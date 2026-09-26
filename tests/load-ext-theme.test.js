const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { BUILTIN, loadExtTheme } = require('../scripts/load-ext-theme');

function withThemesExt(value, callback) {
  const previous = process.env.THEMES_EXT;
  if (value == null) delete process.env.THEMES_EXT;
  else process.env.THEMES_EXT = value;
  try {
    return callback();
  } finally {
    if (previous == null) delete process.env.THEMES_EXT;
    else process.env.THEMES_EXT = previous;
  }
}

test('builtin theme ids do not require an external theme directory', () => {
  withThemesExt(null, () => {
    for (const id of BUILTIN) assert.equal(loadExtTheme(id), null);
  });
});

test('explicit external theme loads from a directory with spaces', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'themes ext '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'private-brand-test');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'theme.json'), JSON.stringify({
    colors: { bg: '#000000', text: '#ffffff' },
  }));

  const theme = withThemesExt(root, () => loadExtTheme('private-brand-test'));
  assert.equal(theme.colors.bg, '#000000');
});

test('explicit external theme fails closed when the pack is unavailable', (t) => {
  assert.throws(
    () => withThemesExt(null, () => loadExtTheme('private-brand-test')),
    /private-brand-test.*THEMES_EXT/,
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'themes missing '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => withThemesExt(root, () => loadExtTheme('private-brand-test')),
    /private-brand-test.*не найдена/,
  );
});

test('external theme rejects traversal and shell-like ids before reading files', () => {
  for (const id of ['../craft', 'brand/name', 'brand;touch-sentinel', '$(touch sentinel)']) {
    assert.throws(() => withThemesExt('/private/location', () => loadExtTheme(id)), /недопустимый id/);
  }
});

test('external theme errors never disclose the THEMES_EXT absolute path', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'secret themes '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'private-brand-test');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'theme.json'), '{broken');

  assert.throws(
    () => withThemesExt(root, () => loadExtTheme('private-brand-test')),
    (error) => {
      assert.match(error.message, /private-brand-test.*битый JSON/);
      assert.doesNotMatch(error.message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    },
  );
});
