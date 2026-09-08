const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fsyncDirectoryIfSupported, openReadOnlyFlags } = require('../filesystem-capabilities');
const { assertTrustedDirectoryChain } = require('../render-media-bundle');

const fail = () => { throw new Error('motion requires a private, untracked project workspace without symbolic links'); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;

// Persist each directory and its parent entry before private files can use it.
function ensureDurableDirectoryChain(target, fileSystem = fs) {
  const missing = []; let existing = target;
  while (!fileSystem.existsSync(existing)) {
    missing.push(existing); existing = path.dirname(existing);
  }
  let chain = assertTrustedDirectoryChain(existing, fileSystem);
  for (const directory of missing.reverse()) {
    chain.assertCurrent();
    fileSystem.mkdirSync(directory, { mode: 0o700 });
    chain.assertCurrent();
    chain = assertTrustedDirectoryChain(directory, fileSystem);
    fsyncDirectoryIfSupported(fileSystem, directory);
    fsyncDirectoryIfSupported(fileSystem, path.dirname(directory));
    chain.assertCurrent();
  }
  fsyncDirectoryIfSupported(fileSystem, target);
  chain.assertCurrent();
  return chain;
}

function readIgnore(filename, fileSystem) {
  const before = fileSystem.lstatSync(filename);
  if (before.isSymbolicLink() || !before.isFile() || before.size > 65536 || before.nlink !== 1) fail();
  const fd = fileSystem.openSync(filename, openReadOnlyFlags(fileSystem));
  try {
    const opened = fileSystem.fstatSync(fd);
    if (!same(before, opened)) fail();
    const bytes = fileSystem.readFileSync(fd);
    const after = fileSystem.lstatSync(filename);
    if (!same(opened, after) || after.isSymbolicLink() || opened.size !== after.size
      || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) fail();
    return { bytes, stat: after };
  } finally { fileSystem.closeSync(fd); }
}

function preparePrivateWorkspace(projectDir, { fileSystem = fs, spawnSyncImpl = spawnSync } = {}) {
  try {
    if (typeof projectDir !== 'string' || !projectDir) fail();
    const dir = path.resolve(projectDir);
    let existing = dir;
    while (!fileSystem.existsSync(existing)) existing = path.dirname(existing);
    const parentChain = assertTrustedDirectoryChain(existing, fileSystem);
    const repo = spawnSyncImpl('git', ['rev-parse', '--show-toplevel'], { cwd: existing, encoding: 'utf8' });
    if (repo.status === 0) {
      const root = repo.stdout.trim();
      if (fileSystem.existsSync(dir) && fileSystem.realpathSync(root) === fileSystem.realpathSync(dir)) fail();
      const tracked = spawnSyncImpl('git', ['--literal-pathspecs', 'ls-files', '-z', '--', dir], { cwd: root, encoding: 'utf8' });
      if (tracked.status !== 0 || tracked.stdout.length) fail();
    } else {
      // Missing/broken Git cannot certify a containing repository as untracked.
      for (let ancestor = existing; ; ancestor = path.dirname(ancestor)) {
        try { fileSystem.lstatSync(path.join(ancestor, '.git')); fail(); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (path.dirname(ancestor) === ancestor) break;
      }
      if (repo.error ? repo.error.code !== 'ENOENT'
        : !/not a git repository/i.test(repo.stderr || '')) fail();
    }
    parentChain.assertCurrent();
    const chain = ensureDurableDirectoryChain(dir, fileSystem);
    const ignore = path.join(dir, '.gitignore');
    let previous = null;
    try { previous = readIgnore(ignore, fileSystem); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Keep existing comments/rules byte-for-byte. The last rule overrides any negation.
    const lastRule = previous?.bytes.toString('utf8').trimEnd().split('\n').at(-1);
    const bytes = lastRule === '*' ? previous.bytes
      : Buffer.concat([previous?.bytes || Buffer.alloc(0), Buffer.from(previous?.bytes.length ? '\n*\n' : '*\n')]);
    chain.assertCurrent();
    const constants = fileSystem.constants || fs.constants;
    const fd = fileSystem.openSync(ignore, constants.O_WRONLY | (constants.O_NOFOLLOW || 0)
      | (previous ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600);
    try {
      const opened = fileSystem.fstatSync(fd);
      const current = fileSystem.lstatSync(ignore);
      chain.assertCurrent();
      if (!opened.isFile() || current.isSymbolicLink() || !same(opened, current)
        || (previous && (!same(previous.stat, opened) || previous.stat.size !== opened.size
          || previous.stat.mtimeMs !== opened.mtimeMs || previous.stat.ctimeMs !== opened.ctimeMs))) fail();
      if (!previous || !bytes.equals(previous.bytes)) fileSystem.writeFileSync(fd, bytes);
      fileSystem.fsyncSync(fd);
    } finally { fileSystem.closeSync(fd); }
    fsyncDirectoryIfSupported(fileSystem, dir);
    chain.assertCurrent();
    const protectedIgnore = readIgnore(ignore, fileSystem);
    if (!protectedIgnore.bytes.equals(bytes)) fail();
    const assertCurrent = () => {
      try {
        chain.assertCurrent();
        const current = readIgnore(ignore, fileSystem);
        if (!same(current.stat, protectedIgnore.stat) || !current.bytes.equals(bytes)) fail();
      } catch (_) { fail(); }
    };
    assertCurrent();
    return { dir, assertCurrent };
  } catch (_) { fail(); }
}

module.exports = { ensureDurableDirectoryChain, preparePrivateWorkspace };
