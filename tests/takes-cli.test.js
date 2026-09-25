const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseTakesOptions } = require('../scripts/project/takes-cli');

const ROOT = path.join(__dirname, '..');

test('takes options keep repeated files in order and reject foreign flags', () => {
  assert.deepEqual(parseTakesOptions([
    'add', '--project-dir', 'p', '--file', 'a.mp4', '--file', 'b.mov', '--model', 'small',
  ]), {
    action: 'add', projectDir: 'p', files: ['a.mp4', 'b.mov'], model: 'small', prompt: null, silence: 0.5,
  });
  assert.deepEqual(parseTakesOptions(['pack', '--project-dir', 'p', '--silence', '0.4']), {
    action: 'pack', projectDir: 'p', files: [], model: 'large-v3-turbo', prompt: null, silence: 0.4,
  });
  for (const [argv, pattern] of [
    [['cut', '--project-dir', 'p'], /usage/],
    [['add', '--file', 'a.mp4'], /--project-dir/],
    [['add', '--project-dir', 'p'], /--file/],
    [['pack', '--project-dir', 'p', '--file', 'a.mp4'], /unknown takes option/],
    [['pack', '--project-dir', 'p', '--silence', '9'], /silence/],
    [['add', '--project-dir'], /requires a value/],
  ]) {
    assert.throws(() => parseTakesOptions(argv), pattern, argv.join(' '));
  }
});

test('takes and master modules contain no shell execution escape hatch', () => {
  for (const file of [
    'build-master.js', 'build-takes-master.js', 'source-revision.js',
    'takes.js', 'takes-cli.js', 'takes-edit.js', 'takes-pack.js',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, 'scripts', 'project', file), 'utf8');
    assert.doesNotMatch(source, /\bexecSync\b|shell\s*:\s*true/, file);
  }
});
