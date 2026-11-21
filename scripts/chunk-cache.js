const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const { captureTool, hostPath } = require('./process');

const CACHE_VERSION = 2;
const MANIFEST_NAME = 'manifest.json';

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function fileIdentity(file, fileSystem = fs) {
  const resolved = hostPath(file);
  let handle;
  try {
    handle = fileSystem.openSync(resolved, 'r');
  } catch {
    throw new Error('chunk cache: файл для identity недоступен');
  }
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let size = 0;
  try {
    let bytesRead;
    do {
      bytesRead = fileSystem.readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
        size += bytesRead;
      }
    } while (bytesRead > 0);
  } catch {
    throw new Error('chunk cache: не удалось вычислить identity файла');
  } finally {
    fileSystem.closeSync(handle);
  }
  return { size, sha256: hash.digest('hex') };
}

function updateIdentityEntry(hash, type, relativePath, bytes = null) {
  const relative = relativePath.split(path.sep).join('/');
  hash.update(type);
  hash.update('\0');
  hash.update(String(Buffer.byteLength(relative)));
  hash.update('\0');
  hash.update(relative);
  hash.update('\0');
  if (bytes !== null) {
    hash.update(String(bytes.length));
    hash.update('\0');
    hash.update(bytes);
  }
}

function directoryIdentity(directory, fileSystem = fs) {
  const root = hostPath(directory);
  const hash = createHash('sha256');

  function visit(current, relative) {
    let stat;
    try {
      stat = fileSystem.lstatSync(current);
    } catch {
      throw new Error('chunk cache: render code недоступен');
    }
    if (stat.isSymbolicLink()) {
      throw new Error('chunk cache: symlink в render code запрещён');
    }
    if (stat.isDirectory()) {
      updateIdentityEntry(hash, 'directory', relative);
      let entries;
      try {
        entries = fileSystem.readdirSync(current, { withFileTypes: true })
          .sort((left, right) => compareText(left.name, right.name));
      } catch {
        throw new Error('chunk cache: render code недоступен');
      }
      for (const entry of entries) {
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        visit(path.join(current, entry.name), childRelative);
      }
      return;
    }
    if (!stat.isFile()) {
      throw new Error('chunk cache: render code содержит неподдерживаемый тип файла');
    }
    let bytes;
    try {
      bytes = fileSystem.readFileSync(current);
    } catch {
      throw new Error('chunk cache: render code недоступен');
    }
    updateIdentityEntry(hash, 'file', relative, bytes);
  }

  visit(root, '');
  return hash.digest('hex');
}

function isContainedPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..'
    && !path.isAbsolute(relative);
}

function resolveContainedPublicFile(value, publicDir, fileSystem = fs) {
  if (typeof value !== 'string') return null;
  const root = hostPath(publicDir);
  const candidate = path.resolve(root, value);
  if (!isContainedPath(root, candidate)) return null;
  const relative = path.relative(root, candidate);
  const segments = relative.split(path.sep);
  let current = root;
  let stat;
  try {
    stat = fileSystem.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error('chunk cache: public asset проходит через symlink');
    }
    if (!stat.isDirectory()) return null;
    for (const segment of segments) {
      current = path.join(current, segment);
      stat = fileSystem.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error('chunk cache: public asset проходит через symlink');
      }
    }
    if (!stat.isFile()) return null;
    const realRoot = fileSystem.realpathSync(root);
    const realCandidate = fileSystem.realpathSync(candidate);
    if (!isContainedPath(realRoot, realCandidate)) {
      throw new Error('chunk cache: public asset выходит за пределы public');
    }
  } catch (error) {
    if (error?.message?.startsWith('chunk cache: public asset ')) throw error;
    return null;
  }
  return candidate;
}

function referencedPublicAsset(value, publicDir, fileSystem = fs) {
  const candidate = resolveContainedPublicFile(value, publicDir, fileSystem);
  if (!candidate) return null;
  return fileIdentity(candidate, fileSystem);
}

function escapeJsonPointerSegment(segment) {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function isGeneratedSourceLease(value) {
  return /^\.automontage\/[A-Za-z0-9_-]+-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/source(?:\.[^/\\]*)?$/i
    .test(value);
}

function collectReferencedPublicAssets(props, publicDir, fileSystem = fs) {
  const assets = [];
  function visit(value, pointer) {
    if (typeof value === 'string') {
      const identity = referencedPublicAsset(value, publicDir, fileSystem);
      if (identity) assets.push({ pointer, ...identity });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${pointer}/${index}`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value).sort()) {
        visit(value[key], `${pointer}/${escapeJsonPointerSegment(key)}`);
      }
    }
  }
  visit(props, '');
  return assets.sort((left, right) => compareText(left.pointer, right.pointer));
}

function canonicalizeRenderProps(props, publicAssets) {
  const assetsByPointer = new Map(publicAssets.map((asset) => [asset.pointer, asset]));
  function visit(value, pointer) {
    const asset = assetsByPointer.get(pointer);
    if (asset && typeof value === 'string') {
      return {
        publicAsset: {
          ...(isGeneratedSourceLease(value) ? {} : { path: value }),
          size: asset.size,
          sha256: asset.sha256,
        },
      };
    }
    if (Array.isArray(value)) return value.map((item, index) => visit(item, `${pointer}/${index}`));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).map((key) => [
        key,
        visit(value[key], `${pointer}/${escapeJsonPointerSegment(key)}`),
      ]));
    }
    return value;
  }
  return visit(props, '');
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  }
  return value;
}

function createRenderJob({
  composition,
  props,
  source = null,
  audio = null,
  total,
  chunk,
  remotionOptions,
  renderCode,
  publicAssets,
}) {
  const descriptor = {
    version: CACHE_VERSION,
    composition,
    props,
    source: source ? fileIdentity(source) : null,
    audio: audio ? fileIdentity(audio) : null,
    total,
    chunk,
    remotionOptions: sortedValue(remotionOptions),
    renderCode: sortedValue(renderCode),
    publicAssets: [...publicAssets]
      .sort((left, right) => compareText(left.pointer, right.pointer))
      .map(({ pointer, size, sha256 }) => ({ pointer, size, sha256 })),
  };
  const key = createHash('sha256').update(JSON.stringify(descriptor)).digest('hex');
  return { key, descriptor };
}

function emptyManifest(job) {
  return {
    version: CACHE_VERSION,
    jobKey: job.key,
    job: job.descriptor,
    chunks: [],
  };
}

function loadCacheManifest(directory, job, fileSystem = fs) {
  const resolvedDirectory = hostPath(directory);
  const manifestPath = path.join(resolvedDirectory, MANIFEST_NAME);
  fileSystem.mkdirSync(resolvedDirectory, { recursive: true });
  if (!fileSystem.existsSync(manifestPath)) return emptyManifest(job);
  try {
    const manifest = JSON.parse(fileSystem.readFileSync(manifestPath, 'utf8'));
    if (manifest.version !== CACHE_VERSION
      || manifest.jobKey !== job.key
      || JSON.stringify(manifest.job) !== JSON.stringify(job.descriptor)
      || !Array.isArray(manifest.chunks)) {
      return emptyManifest(job);
    }
    return manifest;
  } catch {
    return emptyManifest(job);
  }
}

function writeManifestAtomic(directory, manifest, {
  fileSystem = fs,
  temporaryId = randomUUID,
} = {}) {
  const manifestPath = path.join(hostPath(directory), MANIFEST_NAME);
  const temporaryPath = `${manifestPath}.tmp-${temporaryId()}`;
  let handle = null;
  try {
    fileSystem.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`);
    // 'r+', а не 'r': Windows отклоняет fsync дескриптора, открытого только на чтение (EPERM, PR #14).
    handle = fileSystem.openSync(temporaryPath, 'r+');
    fileSystem.fsyncSync(handle);
    fileSystem.closeSync(handle);
    handle = null;
    fileSystem.renameSync(temporaryPath, manifestPath);
  } finally {
    if (handle !== null) fileSystem.closeSync(handle);
    if (fileSystem.existsSync(temporaryPath)) fileSystem.unlinkSync(temporaryPath);
  }
}

function recordChunkComplete({
  directory,
  manifest,
  part,
  from,
  to,
  frames,
}, options = {}) {
  const expectedFrames = to - from + 1;
  if (!Number.isSafeInteger(from) || from < 0
    || !Number.isSafeInteger(to) || to < from
    || frames !== expectedFrames) {
    throw new Error('chunk manifest: недопустимый диапазон или frame count');
  }
  const expectedFile = `${from}-${to}.mp4`;
  if (path.basename(part) !== expectedFile || path.dirname(hostPath(part)) !== hostPath(directory)) {
    throw new Error('chunk manifest: part должен находиться в job cache');
  }
  const identity = fileIdentity(part, options.fileSystem || fs);
  if (identity.size <= 1000) throw new Error('chunk manifest: part слишком мал');
  const entry = {
    from,
    to,
    frames,
    file: expectedFile,
    status: 'complete',
    ...identity,
  };
  const existingIndex = manifest.chunks.findIndex((chunk) => chunk.from === from);
  if (existingIndex >= 0) manifest.chunks[existingIndex] = entry;
  else manifest.chunks.push(entry);
  manifest.chunks.sort((left, right) => left.from - right.from);
  writeManifestAtomic(directory, manifest, options);
  return entry;
}

function probeChunkFrames(file, options = {}) {
  const output = captureTool('ffprobe', [
    '-v', 'error',
    '-count_frames',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames',
    '-of', 'default=nk=1:nw=1',
    hostPath(file),
  ], {
    stage: 'chunk frame probe',
    maxBuffer: 1024 * 1024,
    spawnSyncImpl: options.spawnSyncImpl,
  }).trim();
  const frames = Number(output);
  if (!Number.isSafeInteger(frames) || frames <= 0) {
    throw new Error('chunk frame probe: недопустимое число кадров');
  }
  return frames;
}

function isReusableChunk({
  directory,
  manifest,
  from,
  to,
  probeFrames = probeChunkFrames,
  fileSystem = fs,
}) {
  try {
    const expectedFile = `${from}-${to}.mp4`;
    const expectedFrames = to - from + 1;
    const entry = manifest.chunks.find((chunk) => chunk.from === from && chunk.to === to);
    if (!entry || entry.status !== 'complete'
      || entry.file !== expectedFile
      || entry.frames !== expectedFrames
      || !Number.isSafeInteger(entry.size)
      || entry.size <= 1000
      || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      return false;
    }
    const part = path.join(hostPath(directory), expectedFile);
    if (!fileSystem.existsSync(part) || !fileSystem.statSync(part).isFile()) return false;
    const identity = fileIdentity(part, fileSystem);
    if (identity.size !== entry.size || identity.sha256 !== entry.sha256) return false;
    return probeFrames(part) === expectedFrames;
  } catch {
    return false;
  }
}

module.exports = {
  CACHE_VERSION,
  canonicalizeRenderProps,
  collectReferencedPublicAssets,
  createRenderJob,
  directoryIdentity,
  fileIdentity,
  isReusableChunk,
  loadCacheManifest,
  probeChunkFrames,
  recordChunkComplete,
  resolveContainedPublicFile,
  writeManifestAtomic,
};
