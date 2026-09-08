const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');

const { validateLessonBrief } = require('../lesson/brief');
const {
  openReadOnlyFlags,
  setPrivateDescriptorMode,
  withNoFollow,
} = require('../filesystem-capabilities');
const { probeOpenedMedia } = require('../media-probe');
const {
  approveBrief,
  acquireProjectMutationLease,
  nextBriefPaths,
  readProjectManifest,
  resolveProjectPath,
  saveDraftRevision,
} = require('../project/workspace');
const {
  listReviewAssetRecords,
  resolveReviewAsset,
} = require('./assets');
const {
  applyReviewCommands,
  isOpaqueAssetId,
  validateReviewCandidate,
} = require('./commands');
const { diffLessonBrief } = require('./diff');
const { cleanupOrphanImportedStages } = require('./imported-assets');
const {
  cleanupOrphanImportQuarantines,
  createImportController,
  importReviewMedia,
} = require('./media-import');
const { runMediaProcess } = require('./media-process');
const {
  buildReviewState,
  buildReviewStateFromEdit,
  buildReviewCandidateBase,
  loadReviewBase,
} = require('./model');
const { auditBriefTiming } = require('./timing-audit');
const { isDeepStrictEqual } = require('node:util');
const { createPreviewJobs } = require('./preview-jobs');
const { createBrollDiscovery } = require('./broll-discovery');
const { createPexelsProvider } = require('../broll/pexels');
const { loadBrollConfig } = require('../broll/config');
const { browserProvenance } = require('../broll/provenance');
const { ensureWaveformPreview } = require('./waveform');

const BODY_LIMIT = 256 * 1024;
const HANDOFF_TTL_MS = 10 * 60 * 1000;
const SAFE_HANDOFF_ID = /^[A-Za-z0-9_-]+$/;
const STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/media-import.js', 'media-import.js'],
  ['/broll-discovery.js', 'broll-discovery.js'],
  ['/timeline.js', 'timeline.js'],
  ['/player-sync.js', 'player-sync.js'],
  ['/styles.css', 'styles.css'],
]);
const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.aac', 'audio/aac'],
  ['.avif', 'image/avif'],
  ['.flac', 'audio/flac'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.m4a', 'audio/mp4'],
  ['.m4v', 'video/x-m4v'],
  ['.mov', 'video/quicktime'],
  ['.mp3', 'audio/mpeg'],
  ['.mp4', 'video/mp4'],
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.wav', 'audio/wav'],
  ['.webm', 'video/webm'],
  ['.webp', 'image/webp'],
]);
const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
});

function responseHeaders(extra = {}) {
  return { ...SECURITY_HEADERS, ...extra };
}

function send(response, status, body = '', headers = {}, head = false) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  response.writeHead(status, responseHeaders({
    'Content-Length': payload.length,
    ...headers,
  }));
  response.end(head ? undefined : payload);
}

function sendError(response, status, head = false) {
  send(response, status, 'Request rejected', {
    'Content-Type': 'text/plain; charset=utf-8',
  }, head);
}

function sendJson(response, status, value) {
  send(response, status, JSON.stringify(value), {
    'Content-Type': 'application/json; charset=utf-8',
  });
}

class ReviewRequestError extends Error {
  constructor(status, code) {
    super(code);
    this.name = 'ReviewRequestError';
    this.status = status;
    this.code = code;
  }
}

function rejectRequest(status, code) {
  throw new ReviewRequestError(status, code);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactOwnKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== 'string')) {
    return false;
  }
  return expectedKeys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return keys.includes(key) && descriptor && Object.hasOwn(descriptor, 'value');
  });
}

function parseEditBody(bytes) {
  let body;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (_) {
    rejectRequest(400, 'MALFORMED_JSON');
  }
  if (!hasExactOwnKeys(body, ['baseRevision', 'baseHash', 'manifestHash', 'commands'])
    || !Number.isSafeInteger(body.baseRevision) || body.baseRevision < 1
    || typeof body.baseHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.baseHash)
    || typeof body.manifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.manifestHash)
    || !Array.isArray(body.commands)) {
    rejectRequest(400, 'MALFORMED_EDIT_REQUEST');
  }
  return body;
}

function safeTokenEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

function requestToken(request, url) {
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length);
  }
  return url.pathname.startsWith('/media/') ? url.searchParams.get('token') : null;
}

function isAuthenticated(request, url, token) {
  return safeTokenEqual(requestToken(request, url), token);
}

function hasUnsafePath(requestTarget) {
  const rawPath = String(requestTarget || '').split('?', 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch (_) {
    return true;
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return true;
  return decoded.split('/').some((segment) => segment === '.' || segment === '..');
}

function hasRequestBody(request) {
  return request.headers['content-length'] !== undefined
    || request.headers['transfer-encoding'] !== undefined;
}

function consumeLimitedBody(request, response) {
  if (!hasRequestBody(request)) return Promise.resolve(Buffer.alloc(0));
  const declared = request.headers['content-length'];
  if (declared !== undefined) {
    if (typeof declared !== 'string' || !/^\d+$/.test(declared)) {
      request.resume();
      sendError(response, 400);
      return Promise.resolve(null);
    }
    if (Number(declared) > BODY_LIMIT) {
      request.resume();
      sendError(response, 413);
      return Promise.resolve(null);
    }
  }

  return new Promise((resolve) => {
    let size = 0;
    let rejected = false;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (!rejected && size > BODY_LIMIT) {
        rejected = true;
        sendError(response, 413);
      } else if (!rejected) {
        chunks.push(chunk);
      }
    });
    request.on('end', () => resolve(rejected ? null : Buffer.concat(chunks)));
    request.on('aborted', () => resolve(null));
    request.on('error', () => resolve(null));
  });
}

function snapshotFile(filePath) {
  let descriptor = null;
  try {
    descriptor = fs.openSync(filePath, openReadOnlyFlags(fs));
    const stat = fs.fstatSync(descriptor);
    const nanosecondStat = fs.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile()) return null;
    return {
      filePath,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: nanosecondStat.mtimeNs,
    };
  } catch (_) {
    return null;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function scanAssetFiles({ root, projectDir }) {
  return listReviewAssetRecords({ root, projectDir });
}

function buildAssetFiles({ root, projectDir }) {
  const candidates = scanAssetFiles({ root, projectDir });
  return new Map(candidates.map((candidate, index) => [`asset-${index + 1}`, candidate]));
}

function assetIdentityKey(asset) {
  return `${asset.kind}\0${asset.reference}`;
}

function sameSnapshotIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size
    && (left.mtimeNs === undefined || right.mtimeNs === undefined || left.mtimeNs === right.mtimeNs);
}

function sameAssetIdentity(left, right) {
  if (!sameSnapshotIdentity(left, right) || left.previewPath !== right.previewPath) return false;
  if (!left.previewPath) return true;
  return sameSnapshotIdentity({
    dev: left.previewDev,
    ino: left.previewIno,
    size: left.previewSize,
    mtimeNs: left.previewMtimeNs,
  }, {
    dev: right.previewDev,
    ino: right.previewIno,
    size: right.previewSize,
    mtimeNs: right.previewMtimeNs,
  });
}

function sameAuthoritativeAssetRecord(left, right) {
  if (!sameAssetIdentity(left, right)) return false;
  for (const field of [
    'kind', 'mediaKind', 'label', 'filePath', 'previewPath', 'reference',
    'canonicalSha256', 'previewSha256', 'width', 'height', 'fps',
    'durationSec', 'audioDurationSec', 'hasAudio',
  ]) {
    if (left[field] !== right[field]) return false;
  }
  if (!isDeepStrictEqual(left.provenance, right.provenance)
    || !isDeepStrictEqual(left.textScan, right.textScan)
    || left.scanSha256 !== right.scanSha256) return false;
  for (const capability of ['preview', 'brollImage', 'brollVideo']) {
    if (left.capabilities?.[capability] !== right.capabilities?.[capability]) return false;
  }
  return true;
}

function registeredAssetIdentityIsCurrent(asset) {
  if (!sameSnapshotIdentity(asset, snapshotFile(asset.filePath))) return false;
  if (!asset.previewPath) return true;
  return sameSnapshotIdentity({
    dev: asset.previewDev,
    ino: asset.previewIno,
    size: asset.previewSize,
    mtimeNs: asset.previewMtimeNs,
  }, snapshotFile(asset.previewPath));
}

function descriptorForAsset(id, asset) {
  return {
    id,
    kind: asset.kind,
    mediaKind: asset.mediaKind,
    label: asset.label,
    url: `/media/assets/${id}`,
    ...(asset.previewPath ? { previewUrl: `/media/assets/${id}/preview` } : {}),
    ...(asset.width ? {
      width: asset.width,
      height: asset.height,
      fps: asset.fps,
      durationSec: asset.durationSec,
      audioDurationSec: asset.audioDurationSec,
      hasAudio: asset.hasAudio,
    } : {}),
    capabilities: { ...asset.capabilities },
    ...(asset.provenance ? { provenance: browserProvenance(asset.provenance), textScan: structuredClone(asset.textScan) } : {}),
  };
}

function descriptorForPublished(imported, assetFiles) {
  for (const [id, asset] of assetFiles) {
    if (assetIdentityKey(asset) === assetIdentityKey(imported)
      && sameAssetIdentity(asset, imported)) {
      return descriptorForAsset(id, asset);
    }
  }
  throw new Error('published review media is not registered');
}

function cleanupIdleImportedStages({ projectDir, runtime, fileSystem }) {
  if (runtime.importController.busy) return;
  let lease;
  try {
    lease = acquireProjectMutationLease(projectDir, { fileSystem });
  } catch (error) {
    if (error && error.code === 'PROJECT_MANIFEST_CONFLICT') return;
    throw error;
  }
  try {
    if (runtime.importController.busy) return;
    cleanupOrphanImportQuarantines({ projectDir, fileSystem, mutationLease: lease });
    cleanupOrphanImportedStages({ projectDir, fileSystem, mutationLease: lease });
  } finally {
    lease.release();
  }
}

function refreshAssetFiles({ root, projectDir, runtime }) {
  const currentCandidates = scanAssetFiles({ root, projectDir });
  const previousByIdentity = new Map([...runtime.assetFiles].map(([id, asset]) => (
    [assetIdentityKey(asset), { id, asset }]
  )));
  const currentKeys = new Set(currentCandidates.map(assetIdentityKey));
  for (const [key] of previousByIdentity) {
    if (!currentKeys.has(key)) rejectRequest(409, 'REVIEW_MEDIA_IDENTITY_CHANGED');
  }

  const assetFiles = new Map();
  const descriptors = [];
  for (const candidate of currentCandidates) {
    const previous = previousByIdentity.get(assetIdentityKey(candidate));
    let id;
    if (previous) {
      if (!sameAuthoritativeAssetRecord(previous.asset, candidate)) {
        rejectRequest(409, 'REVIEW_MEDIA_IDENTITY_CHANGED');
      }
      id = previous.id;
    } else {
      id = `asset-${runtime.nextAssetId}`;
      runtime.nextAssetId += 1;
    }
    assetFiles.set(id, candidate);
    descriptors.push(descriptorForAsset(id, candidate));
  }
  return { assetFiles, descriptors };
}

function rebuildEditAssetFiles({ root, projectDir, runtime }) {
  const currentCandidates = scanAssetFiles({ root, projectDir });
  const previousByIdentity = new Map([...runtime.assetFiles].map(([id, asset]) => (
    [assetIdentityKey(asset), { id, asset }]
  )));
  const currentKeys = new Set(currentCandidates.map(assetIdentityKey));
  const unavailableIds = new Set([...previousByIdentity]
    .filter(([key]) => !currentKeys.has(key))
    .map(([, previous]) => previous.id));
  const assetFiles = new Map();
  const descriptors = [];
  let nextAssetId = runtime.nextAssetId;
  for (const candidate of currentCandidates) {
    const previous = previousByIdentity.get(assetIdentityKey(candidate));
    if (previous && !sameAuthoritativeAssetRecord(previous.asset, candidate)) {
      unavailableIds.add(previous.id);
      continue;
    }
    const id = previous ? previous.id : `asset-${nextAssetId++}`;
    assetFiles.set(id, candidate);
    descriptors.push(descriptorForAsset(id, candidate));
  }
  return { assetFiles, descriptors, unavailableIds, nextAssetId };
}

function requestsUnavailableAsset(commands, unavailableIds) {
  return commands.some((command) => (
    hasExactOwnKeys(command, ['type', 'sceneIndex', 'assetId'])
    && command.type === 'replace-broll'
    && unavailableIds.has(command.assetId)
  ));
}

function stabilizeEditAssetFiles({ root, projectDir, replay }) {
  const candidates = scanAssetFiles({ root, projectDir });
  const currentByIdentity = new Map(candidates.map((asset) => (
    [assetIdentityKey(asset), asset]
  )));
  if (candidates.length !== replay.assetFiles.size
    || currentByIdentity.size !== candidates.length) {
    rejectRequest(409, 'REVIEW_MEDIA_IDENTITY_CHANGED');
  }
  const assetFiles = new Map();
  const descriptors = [];
  for (const [id, registered] of replay.assetFiles) {
    const current = currentByIdentity.get(assetIdentityKey(registered));
    if (!current || !sameAuthoritativeAssetRecord(registered, current)) {
      rejectRequest(409, 'REVIEW_MEDIA_IDENTITY_CHANGED');
    }
    assetFiles.set(id, current);
    descriptors.push(descriptorForAsset(id, current));
  }
  return {
    assetFiles,
    descriptors,
    nextAssetId: replay.nextAssetId,
  };
}

function refreshRuntimeState({
  root,
  projectDir,
  editable,
  runtime,
  sourceFile,
  waveformFile,
}) {
  const base = loadReviewBase({ projectDir });
  const currentSourcePath = resolveProjectPath(
    projectDir,
    base.workspace.manifest.source.localPath,
    { label: 'review source', mustExist: true, type: 'file' },
  );
  const currentSource = snapshotFile(currentSourcePath);
  if (path.resolve(currentSourcePath) !== path.resolve(sourceFile.filePath)
    || !sameSnapshotIdentity(sourceFile, currentSource)) {
    rejectRequest(409, 'REVIEW_MEDIA_IDENTITY_CHANGED');
  }
  cleanupIdleImportedStages({ projectDir, runtime, fileSystem: runtime.fileSystem });
  const refreshedAssets = refreshAssetFiles({ root, projectDir, runtime });
  const state = buildReviewState({
    root,
    base,
    assetFiles: refreshedAssets.assetFiles,
    editable,
    waveformAvailable: Boolean(waveformFile),
  });
  state.assets = base.entry.kind === 'motion-reel' ? [] : refreshedAssets.descriptors;
  runtime.assetFiles = refreshedAssets.assetFiles;
  runtime.state = state;
  return state;
}

function fixedStaticFile(root, pathname) {
  const filename = STATIC_FILES.get(pathname);
  if (!filename) return null;
  const reviewDirectory = path.resolve(root, 'review');
  const filePath = path.join(reviewDirectory, filename);
  try {
    const directoryStat = fs.lstatSync(reviewDirectory);
    const fileStat = fs.lstatSync(filePath);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()
      || fileStat.isSymbolicLink() || !fileStat.isFile()) return null;
    return filePath;
  } catch (_) {
    return null;
  }
}

function contentType(filePath) {
  return CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

function parseRange(value, size) {
  if (typeof value !== 'string') return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return false;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || start >= size || end < start) return false;
  return { start, end: Math.min(end, size - 1) };
}

function serveFile(request, response, file) {
  const expected = typeof file === 'string' ? snapshotFile(file) : file;
  let descriptor;
  let stat;
  try {
    if (!expected) throw new Error('missing file');
    descriptor = fs.openSync(expected.filePath, openReadOnlyFlags(fs));
    stat = fs.fstatSync(descriptor);
  } catch (_) {
    sendError(response, 404, request.method === 'HEAD');
    return;
  }
  const current = {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: fs.fstatSync(descriptor, { bigint: true }).mtimeNs,
  };
  if (!stat.isFile() || !sameSnapshotIdentity(expected, current)) {
    fs.closeSync(descriptor);
    sendError(response, 404, request.method === 'HEAD');
    return;
  }
  if (expected.sha256) {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, position);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
    } while (bytesRead > 0);
    const after = fs.fstatSync(descriptor);
    const afterNanoseconds = fs.fstatSync(descriptor, { bigint: true });
    if (!sameSnapshotIdentity(expected, {
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeNs: afterNanoseconds.mtimeNs,
    }) || !safeHashEqual(hash.digest('hex'), expected.sha256)) {
      fs.closeSync(descriptor);
      sendError(response, 404, request.method === 'HEAD');
      return;
    }
  }

  const range = parseRange(request.headers.range, stat.size);
  if (range === false) {
    fs.closeSync(descriptor);
    sendError(response, 416, request.method === 'HEAD');
    return;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : stat.size - 1;
  const length = stat.size === 0 ? 0 : end - start + 1;
  const headers = responseHeaders({
    'Accept-Ranges': 'bytes',
    'Content-Length': length,
    'Content-Type': contentType(expected.filePath),
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}),
  });
  response.writeHead(range ? 206 : 200, headers);
  if (request.method === 'HEAD' || stat.size === 0) {
    fs.closeSync(descriptor);
    response.end();
    return;
  }
  const stream = fs.createReadStream(expected.filePath, {
    fd: descriptor,
    autoClose: true,
    start,
    end,
  });
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

function verifiedCurrentPreview(projectDir) {
  try {
    const manifest = readProjectManifest(projectDir);
    const metadata = manifest.currentPreview;
    if (!metadata) return null;
    const revisionPath = resolveProjectPath(projectDir, metadata.filePath, {
      label: 'current preview revision', mustExist: true, type: 'file',
    });
    const revision = snapshotFile(revisionPath);
    const currentPath = resolveProjectPath(projectDir, 'previews/current-preview.mp4', {
      label: 'current preview', mustExist: true, type: 'file',
    });
    const current = snapshotFile(currentPath);
    if (!revision || !current) return null;
    return {
      revision: { ...revision, sha256: metadata.sha256 },
      current: { ...current, sha256: metadata.sha256 },
    };
  } catch (_) {
    return null;
  }
}

function snapshotMatchesHash(expected) {
  let descriptor = null;
  try {
    descriptor = fs.openSync(expected.filePath, openReadOnlyFlags(fs));
    const stat = fs.fstatSync(descriptor);
    const nanoseconds = fs.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || !sameSnapshotIdentity(expected, {
      dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: nanoseconds.mtimeNs,
    })) return false;
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, position);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
    } while (bytesRead > 0);
    const after = fs.fstatSync(descriptor);
    const afterNanoseconds = fs.fstatSync(descriptor, { bigint: true });
    return sameSnapshotIdentity(expected, {
      dev: after.dev, ino: after.ino, size: after.size, mtimeNs: afterNanoseconds.mtimeNs,
    }) && safeHashEqual(hash.digest('hex'), expected.sha256);
  } catch (_) {
    return false;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function safeHashEqual(actual, expected) {
  return /^[a-f0-9]{64}$/.test(actual)
    && /^[a-f0-9]{64}$/.test(expected)
    && safeTokenEqual(actual, expected);
}

function currentAssetReference({ root, workspace, assetFiles, assetId }) {
  const registered = assetFiles.get(assetId);
  if (!registered || (registered.capabilities?.brollImage !== true
    && registered.capabilities?.brollVideo !== true)) return null;
  const currentSnapshot = snapshotFile(registered.filePath);
  if (!sameSnapshotIdentity(registered, currentSnapshot)) return null;
  const current = resolveReviewAsset({
    root,
    workspace,
    reference: registered.reference,
    id: assetId,
  });
  if (!current || current.kind !== registered.kind) return null;
  return registered.reference;
}

function assertCurrentReviewAssets({ root, workspace, assetFiles, candidate }) {
  for (const scene of candidate.scenes) {
    const assetId = scene?.brollMedia?.assetId;
    if (!isOpaqueAssetId(assetId)) continue;
    if (!currentAssetReference({
      root,
      workspace,
      assetFiles,
      assetId,
    })) {
      rejectRequest(422, 'UNRESOLVED_REVIEW_ASSET');
    }
  }
}

function assertCurrentSourceIdentity({ projectDir, current, sourceFile }) {
  const currentSourcePath = resolveProjectPath(
    projectDir,
    current.workspace.manifest.source.localPath,
    { label: 'review source', mustExist: true, type: 'file' },
  );
  const currentSource = snapshotFile(currentSourcePath);
  if (path.resolve(currentSourcePath) !== path.resolve(sourceFile.filePath)
    || !sameSnapshotIdentity(sourceFile, currentSource)) {
    rejectRequest(409, 'REVIEW_MEDIA_IDENTITY_CHANGED');
  }
}

function assertOtherRegisteredAssetIdentities({ root, projectDir, assetFiles, candidate }) {
  const selectedIds = new Set(candidate.scenes
    .map((scene) => scene?.brollMedia?.assetId)
    .filter(isOpaqueAssetId));
  const currentByKey = new Map(scanAssetFiles({ root, projectDir }).map((asset) => (
    [assetIdentityKey(asset), asset]
  )));
  for (const [id, registered] of assetFiles) {
    if (selectedIds.has(id)) continue;
    const current = currentByKey.get(assetIdentityKey(registered));
    if (!sameAuthoritativeAssetRecord(registered, current)) {
      rejectRequest(409, 'REVIEW_MEDIA_IDENTITY_CHANGED');
    }
  }
}

function requestStatusForCommandError(error) {
  const message = error && typeof error.message === 'string' ? error.message : '';
  return /boundary seconds|boundary is invalid|produced an invalid lesson brief|duration|unresolved/.test(message)
    ? 422
    : 400;
}

function replayReviewEdit({ root, projectDir, runtime, body, sourceFile }) {
  const current = loadReviewBase({ projectDir });
  if (current.entry.revision !== body.baseRevision
    || !safeHashEqual(body.baseHash, current.baseHash)
    || !safeHashEqual(body.manifestHash, current.manifestHash)) {
    rejectRequest(409, 'STALE_REVIEW_BASE');
  }
  assertCurrentSourceIdentity({ projectDir, current, sourceFile });
  const refreshedAssets = rebuildEditAssetFiles({ root, projectDir, runtime });
  if (requestsUnavailableAsset(body.commands, refreshedAssets.unavailableIds)) {
    rejectRequest(422, 'UNRESOLVED_REVIEW_ASSET');
  }
  const candidateBase = buildReviewCandidateBase({
    canonicalBrief: current.brief,
    assetFiles: refreshedAssets.assetFiles,
  });

  let candidate;
  try {
    candidate = applyReviewCommands({
      brief: candidateBase,
      commands: body.commands,
      assets: refreshedAssets.assetFiles,
      fps: current.brief.output.fps,
    });
  } catch (error) {
    rejectRequest(requestStatusForCommandError(error), 'INVALID_REVIEW_COMMAND');
  }
  if (refreshedAssets.unavailableIds.size > 0) {
    rejectRequest(409, 'REVIEW_MEDIA_IDENTITY_CHANGED');
  }
  assertCurrentReviewAssets({
    root,
    workspace: current.workspace,
    assetFiles: refreshedAssets.assetFiles,
    candidate,
  });
  assertOtherRegisteredAssetIdentities({
    root,
    projectDir,
    assetFiles: refreshedAssets.assetFiles,
    candidate,
  });
  try {
    validateReviewCandidate({
      candidate,
      base: candidateBase,
      assets: refreshedAssets.assetFiles,
      fps: current.brief.output.fps,
    });
  } catch (_) {
    rejectRequest(422, 'INVALID_REVIEW_BRIEF');
  }

  let diff;
  try {
    diff = diffLessonBrief({ before: candidateBase, after: candidate });
  } catch (_) {
    throw new Error('review edit replay produced an unsupported diff');
  }
  const timing = auditBriefTiming({
    brief: candidate,
    words: runtime.state.transcript.words,
  });
  if (timing.errors.length > 0) rejectRequest(422, 'INVALID_REVIEW_TIMING');
  return {
    current,
    candidateBase,
    candidate,
    diff,
    timing,
    assetFiles: refreshedAssets.assetFiles,
    assetDescriptors: refreshedAssets.descriptors,
    nextAssetId: refreshedAssets.nextAssetId,
  };
}

function openedFileSnapshot(descriptor) {
  const stat = fs.fstatSync(descriptor);
  const nanosecondStat = fs.fstatSync(descriptor, { bigint: true });
  if (!stat.isFile()) return null;
  return {
    dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: nanosecondStat.mtimeNs,
  };
}

function hashOpenedFile(descriptor, expected) {
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < expected.size) {
    const count = fs.readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.length, expected.size - position),
      position,
    );
    if (count <= 0) return null;
    digest.update(buffer.subarray(0, count));
    position += count;
  }
  const after = openedFileSnapshot(descriptor);
  return position === expected.size && sameSnapshotIdentity(expected, after)
    ? digest.digest('hex')
    : null;
}

function probeReviewMedia(target) {
  return probeOpenedMedia({
    fileDescriptor: target?.fileDescriptor,
    stage: 'review media probe',
  });
}

function probeMatchesRegistered(registered, probe) {
  if (!probe || probe.mediaKind !== registered.mediaKind) return false;
  if (registered.mediaKind === 'image') {
    return probe.hasAudio === false
      && (registered.width === undefined || (probe.width === registered.width
        && probe.height === registered.height));
  }
  const tolerance = (1 / registered.fps) + 0.001;
  return probe.width === registered.width && probe.height === registered.height
    && Number.isFinite(probe.fps) && Math.abs(probe.fps - registered.fps) <= 1e-6
    && Number.isFinite(probe.durationSec)
    && Math.abs(probe.durationSec - registered.durationSec) <= tolerance
    && (registered.hasAudio === false
      ? probe.audioDurationSec === null && registered.audioDurationSec === null
      : Number.isFinite(probe.audioDurationSec)
        && Math.abs(probe.audioDurationSec - registered.audioDurationSec) <= tolerance)
    && probe.hasAudio === registered.hasAudio;
}

function currentMaterializationAsset({
  root,
  current,
  assetFiles,
  assetId,
  probeMediaImpl,
  fileSystem = fs,
  platform = process.platform,
}) {
  const registered = assetFiles.get(assetId);
  if (!registered) return null;
  const beforeScan = scanAssetFiles({ root, projectDir: current.workspace.dir })
    .find((asset) => assetIdentityKey(asset) === assetIdentityKey(registered));
  if (!beforeScan || !sameAuthoritativeAssetRecord(registered, beforeScan)) return null;
  for (const field of [
    'mediaKind', 'reference', 'canonicalSha256', 'width', 'height', 'fps',
    'durationSec', 'audioDurationSec', 'hasAudio',
  ]) {
    if (registered[field] !== beforeScan[field]) return null;
  }
  let descriptor = null;
  try {
    descriptor = fileSystem.openSync(
      registered.filePath,
      openReadOnlyFlags(fileSystem, platform),
    );
    const opened = openedFileSnapshot(descriptor);
    if (!sameSnapshotIdentity(registered, opened)) return null;
    const probe = probeMediaImpl({
      fileDescriptor: descriptor,
    });
    if (!probeMatchesRegistered(registered, probe)) return null;
    const digest = hashOpenedFile(descriptor, opened);
    if (!digest || digest !== registered.canonicalSha256
      || digest !== beforeScan.canonicalSha256) return null;
    const afterScan = scanAssetFiles({ root, projectDir: current.workspace.dir })
      .find((asset) => assetIdentityKey(asset) === assetIdentityKey(registered));
    if (!afterScan || !sameAuthoritativeAssetRecord(registered, afterScan)
      || afterScan.canonicalSha256 !== digest) return null;
    for (const field of [
      'mediaKind', 'reference', 'canonicalSha256', 'width', 'height',
      'fps', 'durationSec', 'audioDurationSec', 'hasAudio',
    ]) {
      if (registered[field] !== afterScan[field]) return null;
    }
    const finalPathSnapshot = snapshotFile(registered.filePath);
    const finalOpenedSnapshot = openedFileSnapshot(descriptor);
    if (!sameSnapshotIdentity(opened, finalOpenedSnapshot)
      || !sameSnapshotIdentity(opened, finalPathSnapshot)) return null;
    return { asset: afterScan, probe };
  } catch (_) {
    return null;
  } finally {
    if (descriptor !== null) fileSystem.closeSync(descriptor);
  }
}

function materializeReviewAssets({
  root,
  current,
  assetFiles,
  candidate,
  words,
  probeMediaImpl = probeReviewMedia,
  fileSystem = fs,
  platform = process.platform,
}) {
  const materialized = structuredClone(candidate);
  for (const scene of materialized.scenes) {
    if (scene.brollMediaBlocked === true) rejectRequest(422, 'UNRESOLVED_REVIEW_ASSET');
    if (!scene.brollMedia) continue;
    const selected = scene.brollMedia;
    const verified = currentMaterializationAsset({
      root, current, assetFiles, assetId: selected.assetId, probeMediaImpl, fileSystem, platform,
    });
    if (!verified || verified.asset.mediaKind !== selected.kind) {
      rejectRequest(422, 'UNRESOLVED_REVIEW_ASSET');
    }
    const registered = verified.asset;
    if (registered.provenance) materialized.brollReviewPolicy = 'preview-required';
    if (scene.brollReview === true && registered.provenance && registered.scanSha256) {
      scene.brollReview = {assetSha256:registered.canonicalSha256,scanSha256:registered.scanSha256,allowEmbeddedText:true};
    } else delete scene.brollReview;
    if (selected.kind === 'video') {
      const compositionFps = materialized.output.fps;
      const trimStartFrame = Math.round(selected.trimStartSec * compositionFps);
      const sceneFrames = Math.round((scene.end - scene.start) * compositionFps);
      const clipFrames = Math.round(verified.probe.durationSec * compositionFps);
      const audioFrames = selected.audioMode === 'replace'
        ? Math.round(Number(verified.probe.audioDurationSec) * compositionFps)
        : null;
      if (!Number.isSafeInteger(trimStartFrame) || trimStartFrame < 0
        || !Number.isSafeInteger(sceneFrames) || sceneFrames <= 0
        || !Number.isSafeInteger(clipFrames) || clipFrames <= 0
        || trimStartFrame + sceneFrames > clipFrames
        || (selected.audioMode === 'replace'
          && (!Number.isSafeInteger(audioFrames) || audioFrames <= 0
            || trimStartFrame + sceneFrames > audioFrames))
        || (verified.probe.hasAudio !== true && selected.audioMode !== 'mute')) {
        rejectRequest(422, 'UNRESOLVED_REVIEW_ASSET');
      }
    }
    delete scene.brollSrc;
    delete scene.brollMediaBlocked;
    scene.brollMedia = selected.kind === 'video'
      ? {
        kind: 'video',
        src: registered.reference,
        sha256: registered.canonicalSha256,
        trimStartSec: selected.trimStartSec,
        fit: selected.fit,
        audioMode: selected.audioMode,
      }
      : {
        kind: 'image',
        src: registered.reference,
        sha256: registered.canonicalSha256,
        fit: selected.fit,
      };
  }
  const validation = validateLessonBrief(materialized);
  if (!validation.ok) rejectRequest(422, 'INVALID_REVIEW_BRIEF');
  const timing = auditBriefTiming({ brief: materialized, words });
  if (timing.errors.length > 0) rejectRequest(422, 'INVALID_REVIEW_TIMING');
  return materialized;
}

function browserSafeDiff(diff, assetFiles) {
  return diff.map((change) => {
    if (change.kind === 'boundary') return { ...change };
    if (!['asset', 'fit', 'clip-start', 'audio-mode', 'broll-query', 'embedded-text'].includes(change.kind)) {
      throw new Error('review diff contains an unsafe change');
    }
    if (change.kind !== 'asset' || change.from === null || isOpaqueAssetId(change.from)) {
      return { ...change };
    }
    let previousId = null;
    for (const [assetId, registered] of assetFiles) {
      if (registered.reference === change.from
        || (registered.kind === 'public' && `public/${registered.reference}` === change.from)) {
        previousId = assetId;
        break;
      }
    }
    return { ...change, from: previousId };
  });
}

function isSaveConflict(error) {
  if (error && error.code === 'PROJECT_MANIFEST_CONFLICT') return true;
  const message = error && typeof error.message === 'string' ? error.message : '';
  return /\bstale\b|changed concurrently|no longer current/.test(message);
}

function sanitizeInternalMessage(error, sensitiveValues) {
  let message = error && typeof error.message === 'string' ? error.message : 'internal error';
  for (const value of sensitiveValues) {
    if (typeof value === 'string' && value.length > 0) message = message.replaceAll(value, '[redacted]');
  }
  return message
    .replace(/(?:[A-Za-z]:[\\/]|[\\/])[^\s]*/g, '[redacted-path]')
    .slice(0, 300);
}

function logInternalError(logger, error, sensitiveValues) {
  if (!logger || typeof logger.error !== 'function') return;
  try {
    logger.error('Review request failed', {
      name: error && typeof error.name === 'string' ? error.name : 'Error',
      code: error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
        ? error.code
        : 'INTERNAL_ERROR',
      message: sanitizeInternalMessage(error, sensitiveValues),
    });
  } catch (_) {
    // Logging must never change the response or expose request data.
  }
}

function handleEditRoute({
  pathname,
  response,
  root,
  projectDir,
  editable,
  runtime,
  bodyBytes,
  fileSystem,
  sourceFile,
  probeReviewMediaImpl,
}) {
  if (!editable) rejectRequest(405, 'READ_ONLY_REVIEW');
  if (runtime.previewJobs.busy) rejectRequest(409, 'PREVIEW_BUSY');
  const body = parseEditBody(bodyBytes);
  const replay = replayReviewEdit({ root, projectDir, runtime, body, sourceFile });
  if (pathname === '/api/validate') {
    materializeReviewAssets({
      root,
      current: replay.current,
      assetFiles: replay.assetFiles,
      candidate: replay.candidate,
      words: runtime.state.transcript.words,
      probeMediaImpl: probeReviewMediaImpl,
      fileSystem,
    });
    const stableAssets = stabilizeEditAssetFiles({ root, projectDir, replay });
    runtime.assetFiles = stableAssets.assetFiles;
    runtime.nextAssetId = stableAssets.nextAssetId;
    runtime.state = { ...runtime.state, assets: stableAssets.descriptors };
    sendJson(response, 200, {
      ok: true,
      destinationRevision: nextBriefPaths(replay.current.workspace).revision,
      diff: browserSafeDiff(replay.diff, stableAssets.assetFiles),
      timing: replay.timing,
    });
    return;
  }
  if (replay.diff.length === 0) rejectRequest(400, 'EMPTY_REVIEW_DIFF');

  const checked = replayReviewEdit({ root, projectDir, runtime, body, sourceFile });
  if (checked.diff.length === 0) rejectRequest(400, 'EMPTY_REVIEW_DIFF');
  const materialized = materializeReviewAssets({
    root,
    current: checked.current,
    assetFiles: checked.assetFiles,
    candidate: checked.candidate,
    words: runtime.state.transcript.words,
    probeMediaImpl: probeReviewMediaImpl,
    fileSystem,
  });
  const stableAssets = stabilizeEditAssetFiles({ root, projectDir, replay: checked });
  const browserCandidate = buildReviewCandidateBase({
    canonicalBrief: materialized,
    assetFiles: stableAssets.assetFiles,
  });
  const nextState = buildReviewStateFromEdit({
    state: { ...runtime.state, assets: stableAssets.descriptors },
    brief: browserCandidate,
    timing: checked.timing,
  });
  let saved;
  try {
    saved = saveDraftRevision(checked.current.workspace, {
      baseJsonPath: checked.current.briefFilePath,
      brief: materialized,
      fileSystem,
      expectedManifestHash: checked.current.manifestHash,
      expectedBaseHash: checked.current.baseHash,
    });
  } catch (error) {
    if (isSaveConflict(error)) rejectRequest(409, 'STALE_REVIEW_BASE');
    throw error;
  }

  runtime.assetFiles = stableAssets.assetFiles;
  runtime.nextAssetId = stableAssets.nextAssetId;
  nextState.session = {
    editable: true,
    baseRevision: saved.revision,
    baseHash: saved.baseHash,
    manifestHash: saved.manifestHash,
  };
  runtime.state = nextState;
  sendJson(response, 201, {
    ok: true,
    revision: saved.revision,
    path: saved.relativePath,
    session: nextState.session,
  });
}

async function routeRequest({
  request,
  response,
  token,
  origin,
  root,
  runtime,
  projectDir,
  editable,
  fileSystem,
  sourceFile,
  waveformFile,
  importMediaImpl,
  runMediaProcessImpl,
  statfsImpl,
  probeReviewMediaImpl,
}) {
  let url;
  try {
    url = new URL(request.url, origin);
  } catch (_) {
    sendError(response, 400);
    return;
  }
  const pathname = url.pathname;
  const protectedRoute = pathname.startsWith('/api/') || pathname.startsWith('/media/');
  if (protectedRoute && request.headers.host !== new URL(origin).host) {
    sendError(response, 403); return;
  }
  if (protectedRoute && !isAuthenticated(request, url, token)) {
    sendError(response, 401, request.method === 'HEAD');
    return;
  }
  if (hasUnsafePath(request.url)) {
    request.resume();
    sendError(response, 404, request.method === 'HEAD');
    return;
  }

  const safeMethod = request.method === 'GET' || request.method === 'HEAD';
  if (protectedRoute && !safeMethod && request.headers.origin !== origin) {
    request.resume();
    sendError(response, 403);
    return;
  }
  if (runtime.previewJobs.busy && request.method === 'POST') { rejectRequest(409, 'PREVIEW_BUSY'); }
  if (pathname === '/api/assets/import') {
    if (request.method !== 'POST' || !editable) {
      sendError(response, 405, request.method === 'HEAD');
      return;
    }
    const importAbortController = new AbortController();
    let resolveImportFinalized;
    const importFinalized = new Promise((resolve) => { resolveImportFinalized = resolve; });
    runtime.activeImportAbortControllers.add(importAbortController);
    runtime.activeImportFinalizers.add(importFinalized);
    const socket = request.socket;
    let importPending = true;
    const abortPendingImport = () => {
      if (importPending && !response.writableEnded) importAbortController.abort();
    };
    request.once('aborted', abortPendingImport);
    response.once('close', abortPendingImport);
    socket?.once('close', abortPendingImport);
    try {
      const imported = await importMediaImpl({
        request,
        signal: importAbortController.signal,
        projectDir,
        outputFps: runtime.state.output.fps,
        headers: request.headers,
        controller: runtime.importController,
        fileSystem,
        runMediaProcessImpl,
        statfsImpl,
      });
      cleanupIdleImportedStages({ projectDir, runtime, fileSystem });
      const refreshed = refreshAssetFiles({ root, projectDir, runtime });
      runtime.assetFiles = refreshed.assetFiles;
      runtime.state = { ...runtime.state, assets: refreshed.descriptors };
      sendJson(response, 201, {
        ok: true,
        asset: descriptorForPublished(imported, runtime.assetFiles),
      });
    } finally {
      importPending = false;
      runtime.activeImportAbortControllers.delete(importAbortController);
      runtime.activeImportFinalizers.delete(importFinalized);
      request.off('aborted', abortPendingImport);
      response.off('close', abortPendingImport);
      socket?.off('close', abortPendingImport);
      resolveImportFinalized();
    }
    return;
  }
  const editMutation = request.method === 'POST'
    && (pathname === '/api/validate' || pathname === '/api/save');
  if (editMutation && editable && (runtime.importController.busy || runtime.discovery?.busy)) {
    rejectRequest(409, 'MEDIA_IMPORT_BUSY');
  }
  if (
    [
      '/api/broll/preview',
      '/api/broll/preview-job',
      '/api/broll/approve',
    ].includes(pathname)
  ) {
    if (!editable) {
      sendError(response, 405);
      return;
    }
    if (request.headers.origin && request.headers.origin !== origin) {
      sendError(response, 403);
      return;
    }
    try {
      if (pathname === '/api/broll/preview-job') {
        if (request.method !== 'GET') {
          sendError(response, 405);
          return;
        }
        const job = runtime.previewJobs.get(url.searchParams.get('id'));
        const state = refreshRuntimeState({
          root,
          projectDir,
          editable,
          runtime,
          sourceFile,
          waveformFile,
        });
        sendJson(response, 200, { ...job, state });
        return;
      }
      if (request.method !== 'POST') {
        sendError(response, 405);
        return;
      }
      if (runtime.importController.busy || runtime.discovery.busy) {
        rejectRequest(409, 'MEDIA_IMPORT_BUSY');
      }
      if (
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
          request.headers['content-type'] || '',
        )
      ) {
        sendError(response, 400);
        return;
      }
      const bytes = await consumeLimitedBody(request, response);
      if (bytes === null) return;
      let body;
      try {
        body = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        );
      } catch (_) {
        rejectRequest(400, 'PREVIEW_INVALID_REQUEST');
      }
      const allowed =
        pathname === '/api/broll/preview'
          ? ['baseRevision', 'baseHash', 'manifestHash', 'kind', 'sceneIndex']
          : [
              'baseRevision',
              'baseHash',
              'manifestHash',
              'confirmPreviewViewed',
            ];
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => !allowed.includes(key))
      )
        rejectRequest(400, 'PREVIEW_INVALID_REQUEST');
      if (runtime.previewJobs.busy) rejectRequest(409, 'PREVIEW_BUSY');
      const current = runtime.previewJobs.check(body);
      assertCurrentSourceIdentity({ projectDir, current, sourceFile });
      if (pathname === '/api/broll/preview') {
        sendJson(response, 202, runtime.previewJobs.start(body));
        return;
      }
      if (body.confirmPreviewViewed !== true)
        rejectRequest(400, 'PREVIEW_CONFIRMATION_REQUIRED');
      approveBrief(current.workspace, current.briefFilePath, {
        root,
        fileSystem,
        confirmPreviewViewed: true,
        expectedPreviewSha256:
          current.workspace.manifest.currentPreview?.sha256,
      });
      const state = refreshRuntimeState({
        root,
        projectDir,
        editable,
        runtime,
        sourceFile,
        waveformFile,
      });
      sendJson(response, 201, { ok: true, state });
    } catch (error) {
      const code = [
        'STALE_REVIEW_BASE',
        'PREVIEW_BUSY',
        'PREVIEW_NOT_FOUND',
        'PREVIEW_INVALID_REQUEST',
        'PREVIEW_DRAFT_REQUIRED',
        'PREVIEW_CONFIRMATION_REQUIRED',
        'MEDIA_IMPORT_BUSY',
      ].includes(error?.code)
        ? error.code
        : 'PREVIEW_APPROVAL_FAILED';
      const status =
        code === 'PREVIEW_NOT_FOUND'
          ? 404
          : ['STALE_REVIEW_BASE', 'PREVIEW_BUSY', 'MEDIA_IMPORT_BUSY'].includes(
                code,
              )
            ? 409
            : code === 'PREVIEW_APPROVAL_FAILED'
              ? 422
              : 400;
      sendJson(response, status, { error: code });
    }
    return;
  }
  const discoveryRoute = pathname.startsWith('/api/broll/') || pathname.startsWith('/media/broll-candidate/');
  if (discoveryRoute) {
    if (!editable) { sendError(response, 405); return; }
    const proxy = /^\/media\/broll-candidate\/([A-Za-z0-9_-]{16,128})\/(thumbnail|preview)$/.exec(pathname);
    if ((!proxy && request.method !== 'POST') || (proxy && !safeMethod)) {sendError(response,405);return;}
    if (request.headers.origin && request.headers.origin !== origin) {sendError(response,403);return;}
    const abort = new AbortController();
    const cancel = () => { if (!response.writableEnded) abort.abort(); };
    response.once('close', cancel);
    try {
      if (proxy) {
        const media = await runtime.discovery.proxy(proxy[1], proxy[2], abort.signal);
        const range = parseRange(request.headers.range, media.bytes.length);
        if (range === false) {sendError(response,416);return;}
        send(response,range?206:200,range?media.bytes.subarray(range.start,range.end+1):media.bytes,{
          'Content-Type':media.contentType, 'Accept-Ranges':'bytes',
          ...(range?{'Content-Range':`bytes ${range.start}-${range.end}/${media.bytes.length}`}:{})
        },request.method==='HEAD');
      } else {
        if (!['/api/broll/search','/api/broll/reject','/api/broll/select'].includes(pathname)) {sendError(response,404);return;}
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type']||'')) {sendError(response,400);return;}
        const bytes = await consumeLimitedBody(request,response);if(bytes===null)return;
        let body;try {body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch {rejectRequest(400,'BROLL_REQUEST_INVALID');}
        const method=pathname.split('/').at(-1);
        const result=await runtime.discovery[method](body,abort.signal);
        sendJson(response,method==='select'?201:200,result);
      }
    } catch(error) {
      const code = /^(?:BROLL_|STALE_REVIEW_BASE|MEDIA_IMPORT_)[A-Z0-9_]*$/.test(error?.code||'') ? error.code : 'BROLL_PROVIDER_FAILED';
      if(!response.destroyed&&!response.writableEnded)sendJson(response,[400,404,409,413,415,422,507].includes(error.status)?error.status:502,{error:code});
    } finally {response.off('close',cancel);}
    return;
  }
  const bodyBytes = await consumeLimitedBody(request, response);
  if (bodyBytes === null) return;
  if (!safeMethod) {
    if (request.method === 'POST'
      && (pathname === '/api/validate' || pathname === '/api/save')) {
      if (!editable) {
        sendError(response, 405);
        return;
      }
      if (typeof request.headers['content-type'] !== 'string'
        || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'])) {
        sendError(response, 400);
        return;
      }
      handleEditRoute({
        pathname,
        response,
        root,
        projectDir,
        editable,
        runtime,
        bodyBytes,
        fileSystem,
        sourceFile,
        probeReviewMediaImpl,
      });
      return;
    }
    sendError(response, 405);
    return;
  }

  if (pathname === '/api/state') {
    const state = refreshRuntimeState({
      root,
      projectDir,
      editable,
      runtime,
      sourceFile,
      waveformFile,
    });
    send(response, 200, JSON.stringify(state), {
      'Content-Type': 'application/json; charset=utf-8',
    }, request.method === 'HEAD');
    return;
  }
  if (pathname === '/media/source') {
    serveFile(request, response, sourceFile);
    return;
  }
  if (pathname === '/media/current-preview') {
    const preview = verifiedCurrentPreview(projectDir);
    if (!preview) {
      sendError(response, 404, request.method === 'HEAD');
      return;
    }
    if (!snapshotMatchesHash(preview.revision)) {
      sendError(response, 404, request.method === 'HEAD');
      return;
    }
    serveFile(request, response, preview.current);
    return;
  }
  if (pathname === '/media/waveform') {
    if (!waveformFile) {
      sendError(response, 404, request.method === 'HEAD');
      return;
    }
    serveFile(request, response, waveformFile);
    return;
  }
  const previewMatch = /^\/media\/assets\/(asset-[1-9]\d*)\/preview$/.exec(pathname);
  if (previewMatch) {
    const asset = runtime.assetFiles.get(previewMatch[1]);
    if (!asset || !asset.previewPath || !registeredAssetIdentityIsCurrent(asset)) {
      sendError(response, 404, request.method === 'HEAD');
      return;
    }
    serveFile(request, response, {
      filePath: asset.previewPath,
      dev: asset.previewDev,
      ino: asset.previewIno,
      size: asset.previewSize,
      mtimeNs: asset.previewMtimeNs,
    });
    return;
  }
  const assetMatch = /^\/media\/assets\/(asset-[1-9]\d*)$/.exec(pathname);
  if (assetMatch) {
    const file = runtime.assetFiles.get(assetMatch[1]);
    if (!file || !registeredAssetIdentityIsCurrent(file)) {
      sendError(response, 404, request.method === 'HEAD');
      return;
    }
    serveFile(request, response, file);
    return;
  }
  if (protectedRoute) {
    sendError(response, 404, request.method === 'HEAD');
    return;
  }

  const staticFile = fixedStaticFile(root, pathname);
  if (!staticFile) {
    sendError(response, 404, request.method === 'HEAD');
    return;
  }
  serveFile(request, response, staticFile);
}

function openBrowser(url) {
  let command;
  let args;
  if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    command = 'rundll32.exe';
    args = ['url.dll,FileProtocolHandler', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { shell: false, windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
    child.unref();
  });
}

function lstatHandoffIfPresent(fileSystem, target) {
  try {
    return fileSystem.lstatSync(target);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw error;
  }
}

function createSessionHandoff({
  url,
  directory,
  handoffId,
  ttlMs,
  fileSystem,
}) {
  const id = String(handoffId());
  if (!SAFE_HANDOFF_ID.test(id)) throw new Error('review handoff id is unsafe');
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('review handoff TTL is invalid');
  const resolvedDirectory = path.resolve(directory);
  const directoryStat = fileSystem.lstatSync(resolvedDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('review handoff directory is unsafe');
  }
  const handoffPath = path.join(resolvedDirectory, `automontage-review-${id}.url`);
  const constants = fileSystem.constants || fs.constants;
  const platform = fileSystem.platform || process.platform;
  const flags = withNoFollow(
    fileSystem, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, platform,
  );
  let handle = null;
  let identity = null;
  try {
    handle = fileSystem.openSync(handoffPath, flags, 0o600);
    identity = fileSystem.fstatSync(handle);
    if (!identity.isFile()) throw new Error('review handoff must be a regular file');
    setPrivateDescriptorMode(fileSystem, handle, 0o600, platform);
    fileSystem.writeFileSync(handle, `${url}\n`, { encoding: 'utf8' });
    fileSystem.fsyncSync(handle);
    identity = fileSystem.fstatSync(handle);
    fileSystem.closeSync(handle);
    handle = null;
  } catch (error) {
    if (handle !== null) fileSystem.closeSync(handle);
    const current = lstatHandoffIfPresent(fileSystem, handoffPath);
    if (identity && current && sameSnapshotIdentity(identity, current)) {
      fileSystem.unlinkSync(handoffPath);
    }
    throw error;
  }

  let timer = null;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (timer) clearTimeout(timer);
    const current = lstatHandoffIfPresent(fileSystem, handoffPath);
    if (current && !current.isSymbolicLink() && current.isFile()
      && sameSnapshotIdentity(identity, current)) {
      fileSystem.unlinkSync(handoffPath);
    }
  };
  timer = setTimeout(cleanup, ttlMs);
  if (typeof timer.unref === 'function') timer.unref();
  return { path: handoffPath, cleanup };
}

async function closeReviewServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

async function startReviewServer({
  root = path.resolve(__dirname, '../..'),
  projectDir,
  editable = false,
  open = true,
  port = 0,
  runToolImpl,
  fileSystem = fs,
  logger = console,
  openBrowserImpl = openBrowser,
  handoffDirectory = os.tmpdir(),
  handoffId = () => randomBytes(16).toString('hex'),
  handoffTtlMs = HANDOFF_TTL_MS,
  handoffFileSystem = fs,
  importMediaImpl = importReviewMedia,
  runMediaProcessImpl = runMediaProcess,
  statfsImpl = fs.statfsSync,
  probeReviewMediaImpl = probeReviewMedia,
  importController = createImportController(),
  brollProvider,
  brollDownload,
  brollStore,
  previewSpawnImpl,
} = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedProjectDir = path.resolve(projectDir || '');
  const manifest = readProjectManifest(resolvedProjectDir);
  const sourcePath = resolveProjectPath(resolvedProjectDir, manifest.source.localPath, {
    label: 'review source',
    mustExist: true,
    type: 'file',
  });
  const sourceFile = snapshotFile(sourcePath);
  if (!sourceFile) throw new Error('review source is unavailable');
  const waveformPreview = ensureWaveformPreview({
    workspace: { dir: resolvedProjectDir, manifest },
    sourcePath,
    runToolImpl,
  });
  const waveformFile = waveformPreview.available ? snapshotFile(waveformPreview.path) : null;
  cleanupIdleImportedStages({
    projectDir: resolvedProjectDir,
    runtime: { importController },
    fileSystem,
  });
  const assetFiles = buildAssetFiles({ root: resolvedRoot, projectDir: resolvedProjectDir });
  const base = loadReviewBase({ projectDir: resolvedProjectDir });
  if (base.entry.kind === 'motion-reel') editable = false;
  const state = buildReviewState({
    root: resolvedRoot,
    base,
    assetFiles,
    editable,
    waveformAvailable: Boolean(waveformFile),
  });
  state.assets = base.entry.kind === 'motion-reel' ? [] : [...assetFiles].map(([id, asset]) => descriptorForAsset(id, asset));
  const nextAssetId = [...assetFiles.keys()].reduce((highest, id) => (
    Math.max(highest, Number(id.slice('asset-'.length)) || 0)
  ), 0) + 1;
  const runtime = {
    state,
    assetFiles,
    nextAssetId,
    importController,
    fileSystem,
    activeImportAbortControllers: new Set(),
    activeImportFinalizers: new Set(),
  };
  runtime.previewJobs = createPreviewJobs({root:resolvedRoot,projectDir:resolvedProjectDir,getBase:()=>loadReviewBase({projectDir:resolvedProjectDir}),...(previewSpawnImpl ? { spawnImpl: previewSpawnImpl } : {})});
  runtime.discovery = createBrollDiscovery({
    provider: brollProvider || {search(input) {const config=loadBrollConfig({root:resolvedRoot});return createPexelsProvider(config).search(input);}},
    ...(brollDownload?{download:brollDownload}:{}), ...(brollStore?{store:brollStore}:{}),
    getSnapshot() {
      const current=loadReviewBase({projectDir:resolvedProjectDir});
      assertCurrentSourceIdentity({projectDir:resolvedProjectDir,current,sourceFile});
      return {baseRevision:current.entry.revision,baseHash:current.baseHash,manifestHash:current.manifestHash,scenes:current.brief.scenes};
    },
    importMedia:importMediaImpl,
    importContext:{projectDir:resolvedProjectDir,outputFps:runtime.state.output.fps,controller:runtime.importController,fileSystem,runMediaProcessImpl,statfsImpl},
    registerAsset(imported) {
      const refreshed=refreshAssetFiles({root:resolvedRoot,projectDir:resolvedProjectDir,runtime});
      runtime.assetFiles=refreshed.assetFiles;runtime.state={...runtime.state,assets:refreshed.descriptors};
      return {assetId:descriptorForPublished(imported,runtime.assetFiles).id,state:runtime.state};
    },
  });
  const token = randomBytes(32).toString('base64url');
  let origin = 'http://127.0.0.1';
  const server = http.createServer((request, response) => {
    routeRequest({
      request,
      response,
      token,
      origin,
      root: resolvedRoot,
      runtime,
      projectDir: resolvedProjectDir,
      editable: Boolean(editable),
      fileSystem,
      sourceFile,
      waveformFile,
      importMediaImpl,
      runMediaProcessImpl,
      statfsImpl,
      probeReviewMediaImpl,
    }).catch((error) => {
      if (response.destroyed || response.writableEnded) return;
      const importStatus = error && /^MEDIA_IMPORT_/.test(error.code)
        && [400, 409, 413, 415, 422, 507].includes(error.status)
        ? error.status
        : null;
      const status = error instanceof ReviewRequestError ? error.status : (importStatus || 500);
      if (status === 500) {
        logInternalError(logger, error, [token, resolvedRoot, resolvedProjectDir]);
      }
      if (!response.headersSent) sendError(response, status);
      else response.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen({ host: '127.0.0.1', port }, () => {
      server.off('error', onError);
      resolve();
    });
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/#token=${token}`;
  let handoff = null;
  try {
    if (open) {
      try {
        await openBrowserImpl(url);
      } catch (_) {
        handoff = createSessionHandoff({
          url,
          directory: handoffDirectory,
          handoffId,
          ttlMs: handoffTtlMs,
          fileSystem: handoffFileSystem,
        });
      }
    } else {
      handoff = createSessionHandoff({
        url,
        directory: handoffDirectory,
        handoffId,
        ttlMs: handoffTtlMs,
        fileSystem: handoffFileSystem,
      });
    }
  } catch (error) {
    await closeReviewServer(server);
    throw error;
  }
  const originalClose = server.close.bind(server);
  server.close = (...args) => { runtime.previewJobs.close(); runtime.discovery.close(); return originalClose(...args); };
  if (handoff) server.once('close', handoff.cleanup);
  return {
    server,
    token,
    url,
    origin,
    handoffPath: handoff ? handoff.path : null,
    abortActiveImports() {
      runtime.previewJobs.close();
      runtime.discovery.close();
      for (const controller of runtime.activeImportAbortControllers) controller.abort();
    },
    async waitForActiveImports() {
      await runtime.discovery.waitIdle();
      await runtime.previewJobs.waitIdle();
      while (runtime.activeImportFinalizers.size > 0) {
        await Promise.allSettled([...runtime.activeImportFinalizers]);
      }
    },
  };
}

module.exports = {
  materializeReviewAssets,
  parseRange,
  startReviewServer,
};
