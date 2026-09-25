const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseTakesOptions } = require('../scripts/project/takes-cli');
const { addTakes } = require('../scripts/project/takes');
const { packTakes } = require('../scripts/project/takes-pack');
const { createOrOpenProject } = require('../scripts/project/workspace');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'project', 'takes-cli.js');

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

function makePackProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-takes-cli-pack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'take1.mp4');
  const second = path.join(root, 'take2.mp4');
  fs.writeFileSync(first, 'ONE');
  fs.writeFileSync(second, 'TWO');
  const workspace = createOrOpenProject({
    projectDir: path.join(root, 'project'), name: 'Pack CLI', sourcePath: first,
  });
  addTakes({ projectDir: workspace.dir, files: [second] }, {
    probeVideoImpl: () => ({ width: 160, height: 90, fps: 25, duration: 3 }),
    probeMediaPathImpl: () => ({
      mediaKind: 'video', width: 160, height: 90, rotation: 0, hasAudio: true,
      audioSampleRate: 48000, audioChannels: 2, videoDurationSec: 3, audioDurationSec: 3,
    }),
    transcribeImpl: () => [{ start: 0, end: 1, text: 'слово', words: [{ w: 'слово', s: 0.2, e: 0.6 }] }],
  });
  return workspace;
}

test('takes pack prints exactly packTakes output on stdout, nothing on stderr', (t) => {
  const workspace = makePackProject(t);
  const expected = packTakes({ projectDir: workspace.dir });
  const result = spawnSync(process.execPath, [CLI, 'pack', '--project-dir', workspace.dir], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, expected);
});

test('takes pack reports a broken take transcript on stderr with nothing on stdout', (t) => {
  const workspace = makePackProject(t);
  fs.writeFileSync(path.join(workspace.dir, 'transcript', 'takes', 'take-02.json'), '[]');
  const result = spawnSync(process.execPath, [CLI, 'pack', '--project-dir', workspace.dir], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /❌ takes отменён: take-02: нет слов/);
});

test('takes-cli --help prints usage on stdout and exits 0 without requiring --project-dir', () => {
  for (const argv of [['--help'], ['-h'], ['pack', '--help']]) {
    const result = spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });
    assert.equal(result.status, 0, argv.join(' '));
    assert.match(result.stdout, /usage: automontage takes add\|pack/, argv.join(' '));
    assert.equal(result.stderr, '', argv.join(' '));
  }
});
