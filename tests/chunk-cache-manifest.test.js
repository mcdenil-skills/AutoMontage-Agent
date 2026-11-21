// Регресс из PR #14 (Windows: fsync дескриптора только для чтения → EPERM), тест автора PR.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeManifestAtomic, loadCacheManifest, CACHE_VERSION } = require('../scripts/chunk-cache');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chunk-cache-manifest-'));
}

const MANIFEST = {
  version: CACHE_VERSION,
  jobKey: 'test-job',
  job: { descriptor: true },
  chunks: [],
};

// Windows отклоняет FlushFileBuffers на дескрипторе, открытом только для чтения:
// fsync такого хэндла падает с EPERM. Симулируем это правило, чтобы регресс
// ловился и на macOS/Linux, где fsync(O_RDONLY) разрешён.
function readOnlyFsyncRejectingFileSystem(fileSystem = fs) {
  const portable = Object.create(fileSystem);
  const writable = new Set();
  portable.platform = 'win32';
  portable.openSync = (target, flags, mode) => {
    const descriptor = fileSystem.openSync(target, flags, mode);
    const readOnly = flags === 'r'
      || (typeof flags === 'number' && (flags & fs.constants.O_ACCMODE) === fs.constants.O_RDONLY);
    if (!readOnly) writable.add(descriptor);
    return descriptor;
  };
  portable.closeSync = (descriptor) => {
    writable.delete(descriptor);
    return fileSystem.closeSync(descriptor);
  };
  portable.fsyncSync = (descriptor) => {
    if (!writable.has(descriptor)) {
      const error = new Error('EPERM: operation not permitted, fsync');
      error.code = 'EPERM';
      throw error;
    }
    return fileSystem.fsyncSync(descriptor);
  };
  return portable;
}

test('writeManifestAtomic сохраняет манифест на реальной файловой системе', () => {
  const directory = temporaryDirectory();
  try {
    writeManifestAtomic(directory, MANIFEST);
    assert.deepEqual(loadCacheManifest(directory, { key: 'test-job', descriptor: { descriptor: true } }), MANIFEST);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('writeManifestAtomic не делает fsync дескриптора, открытого только для чтения', () => {
  const directory = temporaryDirectory();
  try {
    writeManifestAtomic(directory, MANIFEST, {
      fileSystem: readOnlyFsyncRejectingFileSystem(),
    });
    assert.equal(fs.existsSync(path.join(directory, 'manifest.json')), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
