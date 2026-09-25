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
  'tests/review-media-import.test.js',
];

test('affected test files leave nothing behind in their temporary directory', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-temp-hygiene-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const temporary = path.join(parent, 'tmp');
  fs.mkdirSync(temporary);
  const env = { ...process.env, TMPDIR: temporary, TEMP: temporary, TMP: temporary };
  // Вложенный runner иначе решит, что он дочерний процесс внешнего runner, и молча ничего не запустит.
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_TEST_')) delete env[key];
  }

  const result = spawnSync(process.execPath, [
    '--test', '--test-reporter=tap', '--test-concurrency=1', ...HYGIENE_FILES,
  ], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10 * 60_000,
  });

  const output = [result.error, result.signal, `${result.stdout}\n${result.stderr}`.slice(-4000)]
    .filter(Boolean).join('\n');
  assert.equal(result.status, 0, output);
  // Пустой прогон тоже даёт status 0 и пустую папку; файл без тестов считается одним pass.
  const passed = Number(/^# pass (\d+)$/m.exec(result.stdout)?.[1] ?? 0);
  assert.ok(passed > HYGIENE_FILES.length, `nested run executed only ${passed} tests\n${output}`);
  assert.deepEqual(fs.readdirSync(temporary).sort(), []);
});
