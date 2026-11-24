const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runMotion } = require('../scripts/motion/build');
const { createMotionProject } = require('../scripts/motion/source');
const { preparePrivateWorkspace } = require('../scripts/project/private-workspace');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-consumer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const consumer = path.join(root, 'consumer'); fs.mkdirSync(consumer);
  execFileSync('git', ['init', '-q', consumer]);
  const source = path.join(root, 'narration.wav'); fs.writeFileSync(source, 'private synthetic narration');
  const projectDir = path.join(consumer, 'custom', 'reel');
  return { root, consumer, source, projectDir };
}
const probe = () => ({ mediaKind: 'audio', durationSec: 2 });
const untracked = cwd => execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd, encoding: 'utf8' });
function create(f) {
  return createMotionProject({ projectDir: f.projectDir, narrationPath: f.source, name: 'Private synthetic reel', probeOpenedAudioImpl: probe });
}

for (const result of [
  { status: 128, stdout: '', stderr: 'fatal: unsafe repository' },
  { status: null, error: Object.assign(new Error('Git unavailable'), { code: 'ENOENT' }) },
]) test(`Git inspection failure ${result.status ?? 'ENOENT'} cannot privatize an unchecked repository`, t => {
  const f = fixture(t);
  assert.throws(() => preparePrivateWorkspace(f.projectDir, { spawnSyncImpl: () => result }), /private|workspace/i);
  assert.equal(fs.existsSync(f.projectDir), false);
});

test('standalone workspace still works when Git is not installed', t => {
  const f = fixture(t); const projectDir = path.join(f.root, 'standalone');
  const guard = preparePrivateWorkspace(projectDir, { spawnSyncImpl: () => ({ error: { code: 'ENOENT' } }) });
  guard.assertCurrent();
  assert.equal(fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf8'), '*\n');
});

for (const explicit of [false, true]) test(`local narration ${explicit ? 'explicit' : 'default'} consumer workspace keeps every generated file ignored`, t => {
  const f = fixture(t); const cwd = process.cwd(); process.chdir(f.consumer);
  try {
    const result = runMotion({ narrationPath: f.source, project: 'Private synthetic reel', ...(explicit ? { projectDir: f.projectDir } : {}) }, {
      probeOpenedAudioImpl: probe,
      transcribeMotionNarrationImpl({ workspace }) {
        assert.equal(untracked(f.consumer), '', 'ignore must already protect narration and manifest before transcription');
        const transcript = [{ start: 0, end: 2, text: 'Private synthetic words', words: [] }];
        fs.writeFileSync(path.join(workspace.dir, 'transcript/words.json'), JSON.stringify(transcript));
        return { transcript };
      },
    });
    assert.ok(fs.existsSync(result.jsonPath));
    assert.equal(untracked(f.consumer), '');
  } finally { process.chdir(cwd); }
});

test('existing local ignore content is preserved and a final blanket rule protects new private files', t => {
  const f = fixture(t); fs.mkdirSync(f.projectDir, { recursive: true });
  const original = '# Keep local notes\n*.log\n!notes.txt';
  fs.writeFileSync(path.join(f.projectDir, '.gitignore'), original);
  create(f);
  assert.ok(fs.readFileSync(path.join(f.projectDir, '.gitignore'), 'utf8').startsWith(original));
  fs.writeFileSync(path.join(f.projectDir, 'notes.txt'), 'private notes');
  assert.equal(untracked(f.consumer), '');
});

for (const boundary of ['repo-root', 'tracked-directory', 'symlink-ignore', 'symlink-ancestor']) test(`unsafe ${boundary} is refused before any narration or manifest is written`, t => {
  const f = fixture(t); fs.mkdirSync(f.projectDir, { recursive: true });
  if (boundary === 'repo-root') f.projectDir = f.consumer;
  if (boundary === 'tracked-directory') {
    fs.writeFileSync(path.join(f.projectDir, 'keep.txt'), 'existing');
    execFileSync('git', ['add', '.'], { cwd: f.consumer });
  }
  if (boundary === 'symlink-ignore') fs.symlinkSync(f.source, path.join(f.projectDir, '.gitignore'));
  if (boundary === 'symlink-ancestor') {
    const alias = path.join(f.consumer, 'alias'); fs.symlinkSync(path.dirname(f.projectDir), alias, 'dir');
    f.projectDir = path.join(alias, 'reel');
  }
  assert.throws(() => create(f), /private|untracked|symbolic|workspace/i);
  assert.equal(fs.existsSync(path.join(f.projectDir, 'input/narration.wav')), false);
  assert.equal(fs.existsSync(path.join(f.projectDir, 'project.json')), false);
  assert.equal(fs.readFileSync(f.source, 'utf8'), 'private synthetic narration');
});

for (const race of ['ignore-sync', 'source-stage-open', 'source-write']) test(`privacy failure at ${race} leaves no partial private files`, t => {
  const f = fixture(t); let changed = false; const handles = new Map();
  const open = fs.openSync; const close = fs.closeSync; const sync = fs.fsyncSync; const write = fs.writeSync;
  t.mock.method(fs, 'openSync', (filename, ...args) => {
    const fd = open(filename, ...args); handles.set(fd, String(filename));
    if (race === 'source-stage-open' && String(filename).includes('.tmp-source-') && !changed) {
      changed = true; if (fs.existsSync(path.join(f.projectDir, '.gitignore'))) fs.unlinkSync(path.join(f.projectDir, '.gitignore'));
    }
    return fd;
  });
  t.mock.method(fs, 'closeSync', fd => { handles.delete(fd); return close(fd); });
  t.mock.method(fs, 'fsyncSync', fd => {
    if (race === 'ignore-sync' && handles.get(fd) === path.join(f.projectDir, '.gitignore')) { changed = true; throw new Error('synthetic disk failure'); }
    return sync(fd);
  });
  t.mock.method(fs, 'writeSync', (fd, ...args) => {
    const result = write(fd, ...args);
    if (race === 'source-write' && handles.get(fd)?.includes('.tmp-source-') && !changed) {
      changed = true; if (fs.existsSync(path.join(f.projectDir, '.gitignore'))) fs.unlinkSync(path.join(f.projectDir, '.gitignore'));
    }
    return result;
  });
  assert.throws(() => create(f), /private|ignore|workspace/i);
  assert.equal(changed, true);
  assert.equal(fs.existsSync(path.join(f.projectDir, 'input/narration.wav')), false);
  assert.equal(fs.existsSync(path.join(f.projectDir, 'project.json')), false);
  assert.equal(untracked(f.consumer), '');
});

// Регрессия #164: на macOS само открытие файла на запись обновляет com.apple.provenance, а с ним ctime –
// содержимое, inode, размер и mtime прежние. Охрана принимала это за подмену, и первое «Утверждаю» в
// пульте на motion-ролике всегда падало. fchmod с тем же режимом меняет ctime так же на любой POSIX.
function bumpCtimeOnWriteOpen(t, ignore, after = () => {}) {
  const open = fs.openSync;
  let opened = 0;
  t.mock.method(fs, 'openSync', (filename, flags, ...rest) => {
    const fd = open(filename, flags, ...rest);
    const writes = typeof flags === 'number' && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR));
    if (String(filename) === ignore && writes) {
      opened += 1;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      if (process.platform !== 'win32') fs.fchmodSync(fd, fs.fstatSync(fd).mode & 0o777);
      after();
    }
    return fd;
  });
  return () => opened;
}

for (const [label, original, expected] of [
  ['already protected', '*\n', '*\n'],
  ['still missing the blanket rule', '*.log\n', '*.log\n\n*\n'],
]) test(`a ctime change from opening an ignore file ${label} is not treated as tampering`, { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); fs.mkdirSync(f.projectDir, { recursive: true });
  const ignore = path.join(f.projectDir, '.gitignore');
  fs.writeFileSync(ignore, original);
  const opened = bumpCtimeOnWriteOpen(t, ignore);
  preparePrivateWorkspace(f.projectDir).assertCurrent();
  assert.equal(opened(), 1, 'the write-open must be reproduced');
  assert.equal(fs.readFileSync(ignore, 'utf8'), expected);
});

// Негативная пара: содержимое подменили между чтением и записью с тем же размером и mtime – отказ,
// и чужие байты не затёрты.
test('an ignore file rewritten in place between the check and the write is still refused', t => {
  const f = fixture(t); fs.mkdirSync(f.projectDir, { recursive: true });
  const ignore = path.join(f.projectDir, '.gitignore');
  fs.writeFileSync(ignore, '*.log\n');
  // Целые секунды: иначе utimes округлит mtime и отказ даст сверка времени, а не байтов.
  fs.utimesSync(ignore, 1e9, 1e9);
  const before = fs.statSync(ignore);
  const opened = bumpCtimeOnWriteOpen(t, ignore, () => {
    fs.writeFileSync(ignore, '!.env\n');
    fs.utimesSync(ignore, 1e9, 1e9);
    const after = fs.statSync(ignore);
    assert.deepEqual([after.ino, after.size, after.mtimeMs, after.nlink], [before.ino, before.size, before.mtimeMs, before.nlink]);
  });
  assert.throws(() => preparePrivateWorkspace(f.projectDir), /private|workspace/i);
  assert.equal(opened(), 1);
  assert.equal(fs.readFileSync(ignore, 'utf8'), '!.env\n');
});

test('an ignore file that gained a hard link between the check and the write is refused', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); fs.mkdirSync(f.projectDir, { recursive: true });
  const ignore = path.join(f.projectDir, '.gitignore');
  fs.writeFileSync(ignore, '*.log\n');
  bumpCtimeOnWriteOpen(t, ignore, () => fs.linkSync(ignore, path.join(f.root, 'outside')));
  assert.throws(() => preparePrivateWorkspace(f.projectDir), /private|workspace/i);
  assert.equal(fs.readFileSync(path.join(f.root, 'outside'), 'utf8'), '*.log\n');
});
