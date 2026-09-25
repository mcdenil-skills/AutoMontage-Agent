'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

// Файлы, которые раньше оставляли мусор в os.tmpdir() (#31).
const HYGIENE_FILES = [
  'tests/release-hygiene.test.js',
];

test('affected test files leave nothing behind in their temporary directory', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-temp-hygiene-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const temporary = path.join(parent, 'tmp');
  fs.mkdirSync(temporary);
  const env = { ...process.env, TMPDIR: temporary, TEMP: temporary, TMP: temporary };
  // Вложенный runner иначе решит, что он дочерний процесс внешнего runner.
  delete env.NODE_TEST_CONTEXT;

  const result = spawnSync(process.execPath, ['--test', ...HYGIENE_FILES], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.slice(-4000));
  assert.deepEqual(fs.readdirSync(temporary).sort(), []);
});
