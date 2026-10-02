const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseMediaProbeJson } = require('../media-probe');
const { validateProvenance } = require('../broll/provenance');
const { scanEmbeddedText } = require('../broll/text-scan');
const {
  buildImportedAssetRecord,
  buildImportedPublicationClaim,
  cleanupOrphanImportedStages,
  inspectImportedAssetBundle,
  verifyImportedAssetFiles,
} = require('./imported-assets');
const { acquireProjectMutationLease } = require('../project/workspace');
const { claimAndRemoveOwnedPath } = require('../project/owned-removal');
const { IMAGE_MAX_BYTES, VIDEO_MAX_BYTES } = require('./media-limits');
const {
  fileSystemCapabilities,
  fsyncDirectoryIfSupported,
  openReadOnlyFlags,
  privateModeMatches,
  setPrivateDescriptorMode,
  setPrivatePathMode,
  withNoFollow,
} = require('../filesystem-capabilities');

const DISK_RESERVE_BYTES = 512n * 1024n * 1024n;
const IMPORT_OVERHEAD_BYTES = 4n * 1024n * 1024n;
const MAX_IMAGE_OUTPUT_BYTES = 128n * 1024n * 1024n;
const MAX_MASTER_OUTPUT_BYTES = 2n * 1024n * 1024n * 1024n;
const MAX_PROXY_OUTPUT_BYTES = 512n * 1024n * 1024n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL = /\p{Cc}/u;
const OWNER_PURPOSE = 'review-media-import-owner';
const OWNER_MAX_BYTES = 64 * 1024;
const OWNER_RECORD_KEYS = [
  'version', 'purpose', 'id', 'hostname', 'pid', 'token', 'quarantine', 'bundle',
  'upload', 'canonical', 'preview', 'claim', 'previewStage', 'previewFinal',
  'assetDirectory', 'canonicalFinal', 'metadataFinal', 'committed',
];
const IMAGE_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);
const VIDEO_TYPES = new Map([
  ['.mp4', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.m4v', 'video/x-m4v'],
  ['.webm', 'video/webm'],
]);

function mediaImportError(status, code, message = code, properties = {}) {
  return Object.assign(new Error(message), { status, code, ...properties });
}

function singleHeader(headers, name, code) {
  const matches = Object.entries(headers || {}).filter(([key]) => key.toLowerCase() === name);
  if (matches.length !== 1 || typeof matches[0][1] !== 'string') {
    throw mediaImportError(400, code);
  }
  return matches[0][1];
}

function parseImportHeaders(headers) {
  const lengthText = singleHeader(headers, 'content-length', 'MEDIA_IMPORT_LENGTH_INVALID');
  if (!/^[1-9][0-9]*$/.test(lengthText)) {
    throw mediaImportError(400, 'MEDIA_IMPORT_LENGTH_INVALID');
  }
  const lengthBigInt = BigInt(lengthText);
  if (lengthBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw mediaImportError(400, 'MEDIA_IMPORT_LENGTH_INVALID');
  }

  const encodedFilename = singleHeader(
    headers,
    'x-automontage-filename',
    'MEDIA_IMPORT_FILENAME_INVALID',
  );
  let decodedFilename;
  try {
    decodedFilename = decodeURIComponent(encodedFilename);
  } catch (_) {
    throw mediaImportError(400, 'MEDIA_IMPORT_FILENAME_INVALID');
  }
  const filename = decodedFilename.normalize('NFKC');
  const extension = path.posix.extname(filename).toLowerCase();
  const stem = filename.slice(0, -extension.length);
  if (!filename || encodeURIComponent(decodedFilename) !== encodedFilename
    || CONTROL.test(filename) || /[\\/]/.test(filename)
    || Buffer.byteLength(filename, 'utf8') > 255
    || !extension || !stem || stem.includes('.')) {
    throw mediaImportError(400, 'MEDIA_IMPORT_FILENAME_INVALID');
  }

  const imageType = IMAGE_TYPES.get(extension);
  const videoType = VIDEO_TYPES.get(extension);
  if (!imageType && !videoType) {
    throw mediaImportError(415, 'MEDIA_IMPORT_TYPE_UNSUPPORTED');
  }
  let contentType;
  try {
    contentType = singleHeader(headers, 'content-type', 'MEDIA_IMPORT_TYPE_UNSUPPORTED');
  } catch (error) {
    if (error.code === 'MEDIA_IMPORT_TYPE_UNSUPPORTED') error.status = 415;
    throw error;
  }
  const expectedType = imageType || videoType;
  if (contentType !== expectedType && contentType !== 'application/octet-stream') {
    throw mediaImportError(415, 'MEDIA_IMPORT_TYPE_UNSUPPORTED');
  }

  const mediaKind = imageType ? 'image' : 'video';
  const contentLength = Number(lengthBigInt);
  const limit = mediaKind === 'image' ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;
  if (contentLength > limit) throw mediaImportError(413, 'MEDIA_IMPORT_TOO_LARGE');
  return { contentLength, contentType, extension, filename, mediaKind };
}

function requiredFreeBytes(contentLength) {
  return 4n * BigInt(contentLength) + DISK_RESERVE_BYTES;
}

function clampBudget(value, minimum, maximum) {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

function deriveOutputBudgets({
  mediaKind,
  inputBytes,
  width,
  height,
  durationSec = 0,
  fps = 0,
  hasAudio = false,
} = {}) {
  if (!['image', 'video'].includes(mediaKind)
    || !Number.isSafeInteger(inputBytes) || inputBytes <= 0
    || !Number.isSafeInteger(width) || width <= 0
    || !Number.isSafeInteger(height) || height <= 0) {
    throw mediaImportError(422, 'MEDIA_IMPORT_OUTPUT_BUDGET_INVALID');
  }
  const input = BigInt(inputBytes);
  const pixels = BigInt(width) * BigInt(height);
  if (mediaKind === 'image') {
    return {
      image: clampBudget(
        (2n * input) + (4n * pixels) + IMPORT_OVERHEAD_BYTES,
        2n * 1024n * 1024n,
        MAX_IMAGE_OUTPUT_BYTES,
      ),
      master: 0n,
      proxy: 0n,
    };
  }
  const frameCountNumber = Math.ceil(durationSec * fps);
  if (!Number.isFinite(durationSec) || durationSec <= 0
    || !Number.isFinite(fps) || fps <= 0
    || !Number.isSafeInteger(frameCountNumber) || frameCountNumber <= 0) {
    throw mediaImportError(422, 'MEDIA_IMPORT_OUTPUT_BUDGET_INVALID');
  }
  const frames = BigInt(frameCountNumber);
  const durationMillis = BigInt(Math.ceil(durationSec * 1000));
  const audioBytes = hasAudio ? (durationMillis * 32_000n + 999n) / 1000n : 0n;
  const master = clampBudget(
    (2n * input) + ((pixels * frames + 15n) / 16n) + audioBytes + IMPORT_OVERHEAD_BYTES,
    8n * 1024n * 1024n,
    MAX_MASTER_OUTPUT_BYTES,
  );
  const scale = Math.min(1, 1280 / Math.max(width, height));
  const proxyWidth = BigInt(Math.max(2, Math.ceil(width * scale / 2) * 2));
  const proxyHeight = BigInt(Math.max(2, Math.ceil(height * scale / 2) * 2));
  const proxyPixels = proxyWidth * proxyHeight;
  const proxy = clampBudget(
    (input / 2n) + ((proxyPixels * frames + 31n) / 32n)
      + (hasAudio ? (durationMillis * 16_000n + 999n) / 1000n : 0n)
      + IMPORT_OVERHEAD_BYTES,
    4n * 1024n * 1024n,
    MAX_PROXY_OUTPUT_BYTES,
  );
  return { image: 0n, master, proxy };
}

function phaseFreeBytes(mediaKind, budgets, phase) {
  const overhead = IMPORT_OVERHEAD_BYTES + DISK_RESERVE_BYTES;
  if (mediaKind === 'image') {
    return phase === 'encode'
      ? (2n * budgets.image) + overhead
      : budgets.image + overhead;
  }
  if (phase === 'master') return (2n * budgets.master) + (2n * budgets.proxy) + overhead;
  if (phase === 'proxy') return budgets.master + (2n * budgets.proxy) + overhead;
  if (phase === 'preview-publication') return budgets.master + budgets.proxy + overhead;
  if (phase === 'canonical-publication') return budgets.master + overhead;
  throw mediaImportError(500, 'MEDIA_IMPORT_FILESYSTEM_UNSAFE');
}

function availableDiskBytes(projectDir, statfsImpl) {
  try {
    const stats = statfsImpl(projectDir);
    const available = BigInt(stats.bavail) * BigInt(stats.bsize);
    return available >= 0n ? available : 0n;
  } catch (_) {
    throw unsafeFilesystem();
  }
}

function assertDiskSpace(projectDir, statfsImpl, required) {
  if (availableDiskBytes(projectDir, statfsImpl) < required) {
    throw mediaImportError(507, 'MEDIA_IMPORT_DISK_FULL');
  }
}

function createImportController() {
  let busy = false;
  return {
    acquire() {
      if (busy) return false;
      busy = true;
      return true;
    },
    release() {
      busy = false;
    },
    get busy() {
      return busy;
    },
  };
}

function identity(stat) {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(stat, expected) {
  return stat && expected && stat.dev === expected.dev && stat.ino === expected.ino;
}

function openedFileIdentity(stat, nanosecondStat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: nanosecondStat.mtimeNs,
  };
}

function exactSetupFileIdentity(nanosecondStat, bytes = undefined) {
  return {
    dev: nanosecondStat.dev,
    ino: nanosecondStat.ino,
    size: nanosecondStat.size,
    mtimeNs: nanosecondStat.mtimeNs,
    ...(bytes === undefined ? {} : { bytes: Buffer.from(bytes) }),
  };
}

function persistedFileIdentity(value) {
  return value ? {
    dev: String(value.dev), ino: String(value.ino), size: String(value.size),
    mtimeNs: String(value.mtimeNs),
  } : null;
}

function persistedDirectoryIdentity(value) {
  return value ? { dev: String(value.dev), ino: String(value.ino) } : null;
}

function ownerRecord(owned) {
  return {
    version: 1,
    purpose: OWNER_PURPOSE,
    id: owned.id,
    hostname: owned.ownerHostname,
    pid: owned.ownerPid,
    token: owned.ownerToken,
    quarantine: persistedDirectoryIdentity(owned.quarantineIdentity),
    bundle: persistedDirectoryIdentity(owned.bundleIdentity),
    upload: persistedFileIdentity(owned.uploadIdentity),
    canonical: persistedFileIdentity(owned.canonicalIdentity),
    preview: persistedFileIdentity(owned.previewIdentity),
    claim: persistedFileIdentity(owned.claimIdentity),
    previewStage: persistedFileIdentity(owned.previewStageIdentity),
    previewFinal: persistedFileIdentity(owned.publishedPreviewIdentity),
    assetDirectory: persistedDirectoryIdentity(owned.assetFinalIdentity),
    canonicalFinal: persistedFileIdentity(owned.canonicalFinalIdentity),
    metadataFinal: persistedFileIdentity(owned.metadataFinalIdentity),
    committed: owned.published === true,
  };
}

function appendOwnerRecord(owned, fileSystem) {
  if (owned.ownerFd === null || owned.ownerFd === undefined) throw unsafeFilesystem();
  const bytes = Buffer.from(`${JSON.stringify(ownerRecord(owned))}\n`);
  let offset = 0;
  while (offset < bytes.length) {
    const written = fileSystem.writeSync(
      owned.ownerFd, bytes, offset, bytes.length - offset, null,
    );
    if (!Number.isSafeInteger(written) || written <= 0) throw unsafeFilesystem();
    offset += written;
  }
  fileSystem.fsyncSync(owned.ownerFd);
  owned.ownerBytes = Buffer.concat([owned.ownerBytes, bytes]);
  owned.ownerIdentity = openedFileIdentity(
    fileSystem.fstatSync(owned.ownerFd),
    fileSystem.fstatSync(owned.ownerFd, { bigint: true }),
  );
  owned.ownerIdentity.bytes = Buffer.from(owned.ownerBytes);
}

function createOwnedOutputPlaceholder(
  fileSystem,
  filePath,
  platform = process.platform,
  onCreate = null,
) {
  const constants = fileSystem.constants || fs.constants;
  const descriptor = fileSystem.openSync(
    filePath,
    withNoFollow(
      fileSystem, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, platform,
    ),
    0o600,
  );
  try {
    const createdStat = fileSystem.fstatSync(descriptor);
    const createdSetupStat = fileSystem.fstatSync(descriptor, { bigint: true });
    const createdIdentity = openedFileIdentity(createdStat, createdSetupStat);
    onCreate?.(createdIdentity, exactSetupFileIdentity(createdSetupStat, Buffer.alloc(0)));
    setPrivateDescriptorMode(fileSystem, descriptor, 0o600, platform);
    fileSystem.fsyncSync(descriptor);
    return openedFileIdentity(
      fileSystem.fstatSync(descriptor),
      fileSystem.fstatSync(descriptor, { bigint: true }),
    );
  } finally {
    fileSystem.closeSync(descriptor);
  }
}

function sameFileIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative));
}

function unsafeFilesystem() {
  return mediaImportError(500, 'MEDIA_IMPORT_FILESYSTEM_UNSAFE');
}

function ensureOwnedDirectories(fileSystem, projectDir, segments, platform = process.platform) {
  const resolvedProject = path.resolve(projectDir);
  let projectStat;
  let projectReal;
  try {
    projectStat = fileSystem.lstatSync(resolvedProject);
    if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) throw unsafeFilesystem();
    projectReal = fileSystem.realpathSync(resolvedProject);
  } catch (error) {
    if (error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE') throw error;
    throw unsafeFilesystem();
  }
  const snapshots = new Map([[resolvedProject, identity(projectStat)]]);
  let current = resolvedProject;
  for (const segment of segments) {
    current = path.join(current, segment);
    let created = false;
    try {
      fileSystem.mkdirSync(current, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw unsafeFilesystem();
    }
    let stat;
    try {
      if (created) setPrivatePathMode(fileSystem, current, 0o700, platform);
      stat = fileSystem.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || (created && !privateModeMatches(stat, 0o700, platform))
        || !isInside(projectReal, fileSystem.realpathSync(current))) throw unsafeFilesystem();
    } catch (error) {
      if (error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE') throw error;
      throw unsafeFilesystem();
    }
    snapshots.set(current, identity(stat));
  }
  return { resolvedProject, projectReal, snapshots, directory: current };
}

function assertOwnedDirectory(fileSystem, directory, expected, projectReal) {
  try {
    const stat = fileSystem.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(stat, expected)
      || !isInside(projectReal, fileSystem.realpathSync(directory))) throw unsafeFilesystem();
  } catch (error) {
    if (error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE') throw error;
    throw unsafeFilesystem();
  }
}

function setupFileIdentity(fileSystem, target) {
  const nanosecondStat = fileSystem.lstatSync(target, { bigint: true });
  if (!nanosecondStat.isFile() || nanosecondStat.isSymbolicLink()) throw unsafeFilesystem();
  return exactSetupFileIdentity(nanosecondStat);
}

const WIN32_SETUP_ROOT_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY']);
const SETUP_ROOT_RETRY_DELAYS_MS = [10, 20, 40, 80, 160];
const SETUP_ROOT_RETRY_WAIT = new Int32Array(new SharedArrayBuffer(4));

function removeOwnedEmptySetupRoot(fileSystem, target, expected, platform) {
  const attempts = platform === 'win32' ? SETUP_ROOT_RETRY_DELAYS_MS.length + 1 : 1;
  let removalUncertain = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let stat;
    try {
      stat = fileSystem.lstatSync(target, { bigint: true });
    } catch (error) {
      if (error?.code === 'ENOENT' && removalUncertain) return true;
      return false;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || String(stat.dev) !== String(expected?.dev)
      || String(stat.ino) !== String(expected?.ino)) return false;
    try {
      if (fileSystem.readdirSync(target).length !== 0) return false;
    } catch (_) {
      return false;
    }
    try {
      fileSystem.rmdirSync(target);
      return true;
    } catch (error) {
      if (platform !== 'win32' || !WIN32_SETUP_ROOT_RETRY_CODES.has(error?.code)) return false;
      removalUncertain = true;
      if (attempt === attempts - 1) {
        try {
          const reconciled = fileSystem.lstatSync(target, { bigint: true });
          if (!reconciled.isDirectory() || reconciled.isSymbolicLink()
            || String(reconciled.dev) !== String(expected?.dev)
            || String(reconciled.ino) !== String(expected?.ino)
            || fileSystem.readdirSync(target).length !== 0) return false;
        } catch (reconcileError) {
          if (reconcileError?.code === 'ENOENT') return true;
        }
        return false;
      }
      Atomics.wait(SETUP_ROOT_RETRY_WAIT, 0, 0, SETUP_ROOT_RETRY_DELAYS_MS[attempt]);
    }
  }
  return false;
}

function cleanupOwnedSetupEntries(fileSystem, entries, platform) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    try {
      if (entry.root) {
        removeOwnedEmptySetupRoot(fileSystem, entry.target, entry.expected, platform);
      } else {
        claimAndRemoveOwnedPath({
          target: entry.target,
          expected: entry.expected,
          kind: entry.kind,
          fileSystem,
        });
      }
    } catch (_) {
      // A replacement or late foreign child stays recoverable in the quarantine.
    }
  }
}

function createOwnedQuarantine(projectDir, id, mediaKind, fileSystem, lease,
  platform = process.platform) {
  if (!UUID.test(id)) throw unsafeFilesystem();
  const quarantineParent = ensureOwnedDirectories(
    fileSystem, projectDir, ['tmp', 'review-imports'], platform,
  );
  const assetParent = ensureOwnedDirectories(fileSystem, projectDir, [
    'assets', 'broll', mediaKind === 'image' ? 'images' : 'video',
  ], platform);
  const previewParent = mediaKind === 'video'
    ? ensureOwnedDirectories(fileSystem, projectDir, ['previews', 'broll'], platform)
    : null;
  const quarantinePath = path.join(quarantineParent.directory, id);
  let owned;
  const setupEntries = [];
  try {
    fileSystem.mkdirSync(quarantinePath, { mode: 0o700 });
    const quarantineSetupStat = fileSystem.lstatSync(quarantinePath, { bigint: true });
    if (!quarantineSetupStat.isDirectory() || quarantineSetupStat.isSymbolicLink()) {
      throw unsafeFilesystem();
    }
    setupEntries.push({
      target: quarantinePath, expected: identity(quarantineSetupStat), kind: 'directory', root: true,
    });
    const quarantineIdentity = {
      dev: Number(quarantineSetupStat.dev),
      ino: Number(quarantineSetupStat.ino),
    };
    setPrivatePathMode(fileSystem, quarantinePath, 0o700, platform);
    if (!privateModeMatches(fileSystem.lstatSync(quarantinePath), 0o700, platform)) {
      throw unsafeFilesystem();
    }

    const bundlePath = path.join(quarantinePath, 'bundle');
    fileSystem.mkdirSync(bundlePath, { mode: 0o700 });
    const bundleSetupStat = fileSystem.lstatSync(bundlePath, { bigint: true });
    if (!bundleSetupStat.isDirectory() || bundleSetupStat.isSymbolicLink()) {
      throw unsafeFilesystem();
    }
    setupEntries.push({
      target: bundlePath, expected: identity(bundleSetupStat), kind: 'directory', root: false,
    });
    const bundleIdentity = {
      dev: Number(bundleSetupStat.dev),
      ino: Number(bundleSetupStat.ino),
    };
    setPrivatePathMode(fileSystem, bundlePath, 0o700, platform);
    if (!privateModeMatches(fileSystem.lstatSync(bundlePath), 0o700, platform)) {
      throw unsafeFilesystem();
    }

    const uploadPath = path.join(quarantinePath, 'upload.bin');
    const constants = fileSystem.constants || fs.constants;
    const uploadFd = fileSystem.openSync(
      uploadPath,
      withNoFollow(
        fileSystem, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, platform,
      ),
      0o600,
    );
    const uploadStat = fileSystem.fstatSync(uploadFd);
    const uploadNanosecondStat = fileSystem.fstatSync(uploadFd, { bigint: true });
    if (!uploadStat.isFile()) {
      fileSystem.closeSync(uploadFd);
      throw unsafeFilesystem();
    }
    const uploadSetupEntry = {
      target: uploadPath,
      expected: exactSetupFileIdentity(uploadNanosecondStat, Buffer.alloc(0)),
      kind: 'file',
      root: false,
    };
    setupEntries.push(uploadSetupEntry);
    setPrivateDescriptorMode(fileSystem, uploadFd, 0o600, platform);
    if (!privateModeMatches(fileSystem.fstatSync(uploadFd), 0o600, platform)) {
      fileSystem.closeSync(uploadFd);
      throw unsafeFilesystem();
    }
    owned = {
      id,
      projectDir: quarantineParent.resolvedProject,
      projectReal: quarantineParent.projectReal,
      quarantinePath,
      quarantineIdentity,
      bundlePath,
      bundleIdentity,
      uploadPath,
      uploadFd,
      uploadIdentity: openedFileIdentity(uploadStat, uploadNanosecondStat),
      assetParent: assetParent.directory,
      assetParentIdentity: assetParent.snapshots.get(assetParent.directory),
      claimPath: path.join(assetParent.directory, `.${id}.claim`),
      claimPrivatePath: path.join(quarantinePath, 'publication.claim'),
      claimFd: null,
      claimIdentity: null,
      previewParent: previewParent?.directory || null,
      previewParentIdentity: previewParent?.snapshots.get(previewParent.directory) || null,
      canonicalPath: path.join(bundlePath, mediaKind === 'image' ? 'media.webp' : 'media.mp4'),
      normalizedPreviewPath: mediaKind === 'video' ? path.join(quarantinePath, 'preview.webm') : null,
      assetFinalPath: path.join(assetParent.directory, id),
      previewStagePath: previewParent ? path.join(previewParent.directory, `.${id}.stage.webm`) : null,
      previewFinalPath: previewParent ? path.join(previewParent.directory, `${id}.webm`) : null,
      published: false,
      publishedPreviewIdentity: null,
      ownerHostname: lease.owner.hostname,
      ownerPid: lease.owner.pid,
      ownerToken: lease.owner.token,
      ownerPath: path.join(quarantinePath, 'owner.jsonl'),
      ownerAnchorPath: path.join(quarantinePath, 'owner.anchor'),
      ownerFd: null,
      ownerBytes: Buffer.alloc(0),
      claimBytes: Buffer.alloc(0),
      platform,
    };
    owned.ownerFd = fileSystem.openSync(
      owned.ownerPath,
      withNoFollow(
        fileSystem,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL,
        platform,
      ),
      0o600,
    );
    const ownerStat = fileSystem.fstatSync(owned.ownerFd);
    const ownerSetupStat = fileSystem.fstatSync(owned.ownerFd, { bigint: true });
    owned.ownerIdentity = openedFileIdentity(ownerStat, ownerSetupStat);
    owned.ownerIdentity.bytes = Buffer.alloc(0);
    const ownerSetupEntry = {
      target: owned.ownerPath,
      expected: exactSetupFileIdentity(ownerSetupStat, Buffer.alloc(0)),
      kind: 'file',
      root: false,
    };
    setupEntries.push(ownerSetupEntry);
    setPrivateDescriptorMode(fileSystem, owned.ownerFd, 0o600, platform);
    fileSystem.linkSync(owned.ownerPath, owned.ownerAnchorPath);
    const ownerAnchorSetupEntry = {
      target: owned.ownerAnchorPath, expected: ownerSetupEntry.expected,
      kind: 'file',
      root: false,
    };
    setupEntries.push(ownerAnchorSetupEntry);
    const ownerAnchorSetupIdentity = setupFileIdentity(fileSystem, owned.ownerAnchorPath);
    if (ownerAnchorSetupIdentity.dev !== ownerSetupEntry.expected.dev
      || ownerAnchorSetupIdentity.ino !== ownerSetupEntry.expected.ino) throw unsafeFilesystem();
    ownerAnchorSetupEntry.expected = exactSetupFileIdentity(
      ownerAnchorSetupIdentity, Buffer.alloc(0),
    );
    owned.claimFd = fileSystem.openSync(
      owned.claimPrivatePath,
      withNoFollow(
        fileSystem,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL,
        platform,
      ),
      0o600,
    );
    const claimStat = fileSystem.fstatSync(owned.claimFd);
    const claimSetupStat = fileSystem.fstatSync(owned.claimFd, { bigint: true });
    owned.claimIdentity = openedFileIdentity(claimStat, claimSetupStat);
    owned.claimIdentity.bytes = Buffer.alloc(0);
    setupEntries.push({
      target: owned.claimPrivatePath,
      expected: exactSetupFileIdentity(claimSetupStat, Buffer.alloc(0)),
      kind: 'file',
      root: false,
    });
    setPrivateDescriptorMode(fileSystem, owned.claimFd, 0o600, platform);
    let canonicalSetupEntry;
    owned.canonicalIdentity = createOwnedOutputPlaceholder(
      fileSystem,
      owned.canonicalPath,
      platform,
      (_expected, exactExpected) => {
        canonicalSetupEntry = {
          target: owned.canonicalPath,
          expected: exactExpected,
          kind: 'file',
          root: false,
        };
        setupEntries.push(canonicalSetupEntry);
      },
    );
    if (owned.normalizedPreviewPath) {
      let previewSetupEntry;
      owned.previewIdentity = createOwnedOutputPlaceholder(
        fileSystem,
        owned.normalizedPreviewPath,
        platform,
        (_expected, exactExpected) => {
          previewSetupEntry = {
            target: owned.normalizedPreviewPath,
            expected: exactExpected,
            kind: 'file',
            root: false,
          };
          setupEntries.push(previewSetupEntry);
        },
      );
    }
    appendOwnerRecord(owned, fileSystem);
    const finalOwnerSetupIdentity = exactSetupFileIdentity(
      fileSystem.fstatSync(owned.ownerFd, { bigint: true }), owned.ownerBytes,
    );
    ownerSetupEntry.expected = finalOwnerSetupIdentity;
    ownerAnchorSetupEntry.expected = {
      ...finalOwnerSetupIdentity,
      dev: ownerAnchorSetupEntry.expected.dev,
      ino: ownerAnchorSetupEntry.expected.ino,
    };
    fsyncDirectoryIfSupported(
      fileSystem, quarantinePath, fileSystemCapabilities(platform),
    );
    return owned;
  } catch (error) {
    if (owned?.uploadFd !== null && owned?.uploadFd !== undefined) {
      try { fileSystem.closeSync(owned.uploadFd); } catch (_) { /* owned cleanup only */ }
    }
    if (owned?.ownerFd !== null && owned?.ownerFd !== undefined) {
      try { fileSystem.closeSync(owned.ownerFd); } catch (_) { /* owned descriptor */ }
    }
    if (owned?.claimFd !== null && owned?.claimFd !== undefined) {
      try { fileSystem.closeSync(owned.claimFd); } catch (_) { /* owned descriptor */ }
    }
    cleanupOwnedSetupEntries(fileSystem, setupEntries, platform);
    throw error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE' ? error : unsafeFilesystem();
  }
}

function assertOwnedImport(fileSystem, owned) {
  assertOwnedDirectory(
    fileSystem,
    owned.quarantinePath,
    owned.quarantineIdentity,
    owned.projectReal,
  );
  assertOwnedDirectory(fileSystem, owned.bundlePath, owned.bundleIdentity, owned.projectReal);
  assertOwnedDirectory(fileSystem, owned.assetParent, owned.assetParentIdentity, owned.projectReal);
  if (owned.previewParent) {
    assertOwnedDirectory(
      fileSystem,
      owned.previewParent,
      owned.previewParentIdentity,
      owned.projectReal,
    );
  }
}

function assertOwnedFile(fileSystem, filePath, expected) {
  try {
    const stat = fileSystem.lstatSync(filePath);
    const nanosecondStat = fileSystem.lstatSync(filePath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()
      || !sameFileIdentity(openedFileIdentity(stat, nanosecondStat), expected)) {
      throw unsafeFilesystem();
    }
  } catch (error) {
    if (error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE') throw error;
    throw unsafeFilesystem();
  }
}

function captureOwnedFile(fileSystem, filePath, {
  chmod = false,
  maxBytes = null,
  platform = process.platform,
} = {}) {
  try {
    if (chmod) setPrivatePathMode(fileSystem, filePath, 0o600, platform);
    const stat = fileSystem.lstatSync(filePath);
    const nanosecondStat = fileSystem.lstatSync(filePath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0
      || (chmod && !privateModeMatches(stat, 0o600, platform))) throw unsafeFilesystem();
    if (maxBytes !== null && BigInt(stat.size) > maxBytes) {
      throw mediaImportError(507, 'MEDIA_IMPORT_OUTPUT_QUOTA_EXCEEDED');
    }
    return openedFileIdentity(stat, nanosecondStat);
  } catch (error) {
    if (error.status) throw error;
    if (error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE') throw error;
    throw mediaImportError(422, 'MEDIA_IMPORT_OUTPUT_INVALID');
  }
}

function assertOutputIdentities(fileSystem, owned) {
  if (owned.canonicalIdentity) {
    assertOwnedFile(fileSystem, owned.canonicalPath, owned.canonicalIdentity);
  }
  if (owned.previewIdentity) {
    assertOwnedFile(fileSystem, owned.normalizedPreviewPath, owned.previewIdentity);
  }
}

async function streamExactBody(request, owned, expectedBytes, signal, fileSystem) {
  const abortError = () => mediaImportError(499, 'MEDIA_IMPORT_ABORTED');
  if (signal?.aborted) throw abortError();
  const onAbort = () => request.destroy?.(abortError());
  signal?.addEventListener('abort', onAbort, { once: true });
  let total = 0;
  try {
    for await (const value of request) {
      if (signal?.aborted) throw abortError();
      const chunk = Buffer.from(value);
      if (total + chunk.length > expectedBytes) {
        throw mediaImportError(400, 'MEDIA_IMPORT_LENGTH_MISMATCH');
      }
      let offset = 0;
      while (offset < chunk.length) {
        const written = fileSystem.writeSync(
          owned.uploadFd,
          chunk,
          offset,
          chunk.length - offset,
        );
        if (!Number.isSafeInteger(written) || written <= 0) throw unsafeFilesystem();
        offset += written;
      }
      total += chunk.length;
    }
    if (signal?.aborted) throw abortError();
    if (total !== expectedBytes) throw mediaImportError(400, 'MEDIA_IMPORT_LENGTH_MISMATCH');
    fileSystem.fsyncSync(owned.uploadFd);
    owned.uploadIdentity = openedFileIdentity(
      fileSystem.fstatSync(owned.uploadFd),
      fileSystem.fstatSync(owned.uploadFd, { bigint: true }),
    );
    appendOwnerRecord(owned, fileSystem);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (owned.uploadFd !== null) {
      fileSystem.closeSync(owned.uploadFd);
      owned.uploadFd = null;
    }
  }
}

function buildProbeInvocation(inputPath, signal) {
  return {
    command: 'ffprobe',
    args: [
      '-v', 'error',
      '-show_entries',
      'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,duration,duration_ts,time_base,pix_fmt,sample_rate,channels:stream_tags=rotate,DURATION:stream_disposition=attached_pic:stream_side_data=rotation:format=format_name,duration:format_tags=major_brand,compatible_brands',
      '-of', 'json',
      inputPath,
    ],
    cwd: path.dirname(inputPath),
    signal,
    timeoutMs: 30_000,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 1024 * 1024,
  };
}

function sourceMatchesExtension(source, extension) {
  const imageCodecs = {
    '.avif': new Set(['av1', 'avif']),
    '.gif': new Set(['gif']),
    '.jpeg': new Set(['mjpeg']),
    '.jpg': new Set(['mjpeg']),
    '.png': new Set(['png']),
    '.webp': new Set(['webp']),
  };
  if (imageCodecs[extension]) return imageCodecs[extension].has(source.videoCodec);
  const containers = new Set(String(source.container || '').split(','));
  if (extension === '.webm') return containers.has('webm');
  return ['.mp4', '.mov', '.m4v'].includes(extension)
    && (containers.has('mov') || containers.has('mp4'));
}

function assertMediaLimits(source, headers) {
  const expectedKind = headers.mediaKind;
  if (source.mediaKind !== expectedKind || !sourceMatchesExtension(source, headers.extension)) {
    throw mediaImportError(422, 'MEDIA_IMPORT_CONTENT_MISMATCH');
  }
  const maxDimension = expectedKind === 'image' ? 12_000 : 4_096;
  const maxPixels = expectedKind === 'image' ? 100_000_000 : 8_847_360;
  if (source.width > maxDimension || source.height > maxDimension
    || source.width * source.height > maxPixels) {
    throw mediaImportError(422, 'MEDIA_IMPORT_GEOMETRY_UNSUPPORTED');
  }
  if (expectedKind === 'video' && source.durationSec > 1_800) {
    throw mediaImportError(422, 'MEDIA_IMPORT_DURATION_UNSUPPORTED');
  }
}

function imageInvocation(owned, signal, quota) {
  return {
    command: 'ffmpeg',
    args: [
      '-hide_banner', '-loglevel', 'error', '-i', owned.uploadPath,
      '-map', '0:v:0', '-map_metadata', '-1', '-frames:v', '1',
      '-vf', 'format=rgba', '-c:v', 'libwebp', '-quality', '90', '-pix_fmt', 'yuva420p',
      '-fs', String(quota),
      '-y', owned.canonicalPath,
    ],
    cwd: owned.quarantinePath,
    signal,
    timeoutMs: 10 * 60_000,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 4 * 1024 * 1024,
  };
}

function videoMasterInvocation(owned, source, outputFps, signal, quota) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-i', owned.uploadPath,
    '-map', '0:v:0',
  ];
  if (source.hasAudio) args.push('-map', '0:a:0');
  args.push(
    '-map_metadata', '-1', '-metadata:s:v:0', 'rotate=0',
    '-vf', `fps=${outputFps},pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-crf', '18', '-preset', 'medium',
  );
  if (source.hasAudio) {
    args.push('-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '160k');
  } else {
    args.push('-an');
  }
  args.push(
    '-t', String(source.durationSec),
    '-movflags', '+faststart', '-fs', String(quota), '-y', owned.canonicalPath,
  );
  return {
    command: 'ffmpeg', args, cwd: owned.quarantinePath, signal,
    timeoutMs: 2 * 60 * 60_000,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 4 * 1024 * 1024,
  };
}

function remuxConformity(source, outputFps) {
  if (source.videoCodec !== 'h264') return { ok: false, reason: 'видеокодек должен быть h264' };
  if (source.pixelFormat !== 'yuv420p') return { ok: false, reason: 'формат пикселей должен быть yuv420p' };
  if (source.rotation !== 0) return { ok: false, reason: 'видео содержит поворот' };
  if (source.width % 2 !== 0 || source.height % 2 !== 0) return { ok: false, reason: 'ширина и высота должны быть чётными' };
  if (!Number.isFinite(source.fps) || !(Math.abs(source.fps - outputFps) <= 1e-6)) {
    return { ok: false, reason: 'частота кадров не совпадает с исходником' };
  }
  if (source.hasAudio) {
    if (source.audioCodec !== 'aac') return { ok: false, reason: 'аудиокодек должен быть AAC' };
    if (source.audioSampleRate !== 48000) return { ok: false, reason: 'частота звука должна быть 48 кГц' };
    if (source.audioChannels !== 2) return { ok: false, reason: 'звук должен быть стерео' };
  }
  return { ok: true, reason: null };
}

function videoRemuxInvocation(owned, source, signal, quota) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-i', owned.uploadPath,
    '-map', '0:v:0',
  ];
  if (source.hasAudio) args.push('-map', '0:a:0');
  args.push('-map_metadata', '-1', '-c', 'copy', '-t', String(source.durationSec),
    '-movflags', '+faststart', '-fs', String(quota), '-y', owned.canonicalPath);
  return {
    command: 'ffmpeg', args, cwd: owned.quarantinePath, signal,
    timeoutMs: 2 * 60 * 60_000,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 4 * 1024 * 1024,
  };
}

function videoProxyInvocation(owned, source, outputFps, signal, quota, { fast = false } = {}) {
  const proxyFps = Math.min(30, outputFps);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-i', owned.canonicalPath,
    '-map', '0:v:0',
  ];
  if (source.hasAudio) args.push('-map', '0:a:0');
  args.push(
    '-map_metadata', '-1',
    '-vf', `scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=${proxyFps},pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0`,
    '-c:v', 'libvpx', '-threads', fast ? '4' : '1',
    ...(fast ? ['-cpu-used', '4'] : []), '-crf', '32', '-b:v', '0',
  );
  if (source.hasAudio) {
    args.push('-c:a', 'libopus', '-ar', '48000', '-ac', '2', '-b:a', '96k');
  } else {
    args.push('-an');
  }
  args.push('-t', String(source.durationSec), '-fs', String(quota), '-y', owned.normalizedPreviewPath);
  return {
    command: 'ffmpeg', args, cwd: owned.quarantinePath, signal,
    timeoutMs: 2 * 60 * 60_000,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 4 * 1024 * 1024,
  };
}

function decodeInvocation(inputPath, signal) {
  return {
    command: 'ffmpeg',
    args: ['-hide_banner', '-loglevel', 'error', '-i', inputPath, '-f', 'null', '-'],
    cwd: path.dirname(inputPath),
    signal,
    timeoutMs: 2 * 60 * 60_000,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 4 * 1024 * 1024,
  };
}

async function normalizeIntoQuarantine({
  source, outputFps, owned, signal, fileSystem, run, budgets, checkDisk, masterStrategy, log,
}) {
  if (source.mediaKind === 'video'
    && (!Number.isFinite(outputFps) || outputFps <= 0 || outputFps > 120)) {
    throw mediaImportError(500, 'MEDIA_IMPORT_OUTPUT_FPS_INVALID');
  }
  assertOwnedImport(fileSystem, owned);
  if (source.mediaKind === 'image') {
    checkDisk('encode');
    await run(imageInvocation(owned, signal, budgets.image));
    assertOwnedImport(fileSystem, owned);
    owned.canonicalIdentity = captureOwnedFile(fileSystem, owned.canonicalPath, {
      chmod: true,
      maxBytes: budgets.image,
      platform: owned.platform,
    });
    appendOwnerRecord(owned, fileSystem);
  } else {
    checkDisk('master');
    const conformity = masterStrategy === 'remux-if-conforming' ? remuxConformity(source, outputFps) : null;
    if (conformity) {
      log(conformity.ok ? 'мастер: переупаковка без перекодирования' : `мастер: перекодирование – ${conformity.reason}`);
    }
    await run(conformity?.ok
      ? videoRemuxInvocation(owned, source, signal, budgets.master)
      : videoMasterInvocation(owned, source, outputFps, signal, budgets.master));
    assertOwnedImport(fileSystem, owned);
    owned.canonicalIdentity = captureOwnedFile(fileSystem, owned.canonicalPath, {
      chmod: true,
      maxBytes: budgets.master,
      platform: owned.platform,
    });
    appendOwnerRecord(owned, fileSystem);
    assertOutputIdentities(fileSystem, owned);
    checkDisk('proxy');
    await run(videoProxyInvocation(owned, source, outputFps, signal, budgets.proxy, { fast: masterStrategy !== 'encode' }));
    assertOwnedFile(fileSystem, owned.canonicalPath, owned.canonicalIdentity);
    owned.previewIdentity = captureOwnedFile(
      fileSystem,
      owned.normalizedPreviewPath,
      { chmod: true, maxBytes: budgets.proxy, platform: owned.platform },
    );
    appendOwnerRecord(owned, fileSystem);
  }
  assertOwnedImport(fileSystem, owned);
  assertOutputIdentities(fileSystem, owned);
}

async function verifyNormalizedOutputs({ source, outputFps, owned, signal, fileSystem, run }) {
  assertOutputIdentities(fileSystem, owned);
  const masterProbe = await run(buildProbeInvocation(owned.canonicalPath, signal));
  assertOutputIdentities(fileSystem, owned);
  const master = parseMediaProbeJson(masterProbe.stdout);
  const swapsAxes = source.rotation === 90 || source.rotation === 270;
  const rotatedWidth = swapsAxes ? source.height : source.width;
  const rotatedHeight = swapsAxes ? source.width : source.height;
  const expectedWidth = source.mediaKind === 'video'
    ? Math.ceil(rotatedWidth / 2) * 2
    : rotatedWidth;
  const expectedHeight = source.mediaKind === 'video'
    ? Math.ceil(rotatedHeight / 2) * 2
    : rotatedHeight;
  if (master.mediaKind !== source.mediaKind || master.rotation !== 0
    || master.width !== expectedWidth || master.height !== expectedHeight) {
    throw mediaImportError(422, 'MEDIA_IMPORT_OUTPUT_INVALID');
  }
  if (source.mediaKind === 'image' && (master.videoCodec !== 'webp'
    || !String(master.container).split(',').includes('webp_pipe')
    || (source.hasAlpha && !master.hasAlpha))) {
    throw mediaImportError(422, 'MEDIA_IMPORT_OUTPUT_INVALID');
  }
  assertOutputIdentities(fileSystem, owned);
  await run(decodeInvocation(owned.canonicalPath, signal));
  assertOutputIdentities(fileSystem, owned);
  if (source.mediaKind === 'video') {
    const expectedMasterAudio = !source.hasAudio || (
      master.audioCodec === 'aac' && master.audioSampleRate === 48_000
      && master.audioChannels === 2
    );
    const expectedAudioDuration = source.hasAudio
      ? Math.min(source.audioDurationSec, source.durationSec)
      : null;
    const masterAudioDurationMatches = expectedAudioDuration === null
      ? master.audioDurationSec === null
      : Number.isFinite(master.audioDurationSec)
        && Math.abs(master.audioDurationSec - expectedAudioDuration) <= (1 / outputFps) + 0.001;
    if (master.videoCodec !== 'h264' || master.pixelFormat !== 'yuv420p'
      || Math.abs(master.fps - outputFps) > 1e-6 || master.hasAudio !== source.hasAudio
      || !expectedMasterAudio
      || !masterAudioDurationMatches
      || Math.abs(master.durationSec - source.durationSec) > (1 / outputFps) + 0.001) {
      throw mediaImportError(422, 'MEDIA_IMPORT_OUTPUT_INVALID');
    }
    assertOutputIdentities(fileSystem, owned);
    const previewProbe = await run(buildProbeInvocation(owned.normalizedPreviewPath, signal));
    assertOutputIdentities(fileSystem, owned);
    const preview = parseMediaProbeJson(previewProbe.stdout);
    const durationTolerance = 1 / master.fps;
    const aspectError = Math.abs(
      preview.width * master.height - preview.height * master.width,
    );
    const expectedPreviewAudio = !source.hasAudio || (
      preview.audioCodec === 'opus' && preview.audioSampleRate === 48_000
      && preview.audioChannels === 2
    );
    if (preview.mediaKind !== 'video' || preview.videoCodec !== 'vp8'
      || preview.width > 1280 || preview.height > 1280
      || Math.abs(preview.fps - Math.min(30, outputFps)) > 1e-6
      || preview.hasAudio !== master.hasAudio
      || !expectedPreviewAudio
      || (master.audioDurationSec === null
        ? preview.audioDurationSec !== null
        : !Number.isFinite(preview.audioDurationSec)
          || Math.abs(preview.audioDurationSec - master.audioDurationSec) > durationTolerance + 0.001)
      || aspectError > Math.max(master.width, master.height)
      || Math.abs(preview.durationSec - master.durationSec) > durationTolerance + 0.001) {
      throw mediaImportError(422, 'MEDIA_IMPORT_OUTPUT_INVALID');
    }
    assertOutputIdentities(fileSystem, owned);
    await run(decodeInvocation(owned.normalizedPreviewPath, signal));
    assertOutputIdentities(fileSystem, owned);
  }
  assertOwnedImport(fileSystem, owned);
  return master;
}

function hashOpenedFile(fileSystem, filePath, expectedIdentity, platform = process.platform) {
  let descriptor = null;
  try {
    descriptor = fileSystem.openSync(filePath, openReadOnlyFlags(fileSystem, platform));
    const stat = fileSystem.fstatSync(descriptor);
    const nanosecondStat = fileSystem.fstatSync(descriptor, { bigint: true });
    const before = openedFileIdentity(stat, nanosecondStat);
    if (!stat.isFile() || !sameFileIdentity(before, expectedIdentity)) throw unsafeFilesystem();
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytesRead;
    do {
      bytesRead = fileSystem.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
    const after = openedFileIdentity(
      fileSystem.fstatSync(descriptor),
      fileSystem.fstatSync(descriptor, { bigint: true }),
    );
    if (!sameFileIdentity(before, after)) throw unsafeFilesystem();
    return hash.digest('hex');
  } finally {
    if (descriptor !== null) fileSystem.closeSync(descriptor);
  }
}

function writeExclusive(fileSystem, filePath, bytes, onOwned = () => {},
  platform = process.platform) {
  const constants = fileSystem.constants || fs.constants;
  let descriptor = null;
  try {
    descriptor = fileSystem.openSync(
      filePath,
      withNoFollow(
        fileSystem, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, platform,
      ),
      0o600,
    );
    setPrivateDescriptorMode(fileSystem, descriptor, 0o600, platform);
    onOwned(identity(fileSystem.fstatSync(descriptor)));
    const buffer = Buffer.from(bytes);
    let offset = 0;
    while (offset < buffer.length) {
      const written = fileSystem.writeSync(descriptor, buffer, offset, buffer.length - offset);
      if (written <= 0) throw unsafeFilesystem();
      offset += written;
    }
    fileSystem.fsyncSync(descriptor);
    const stat = fileSystem.fstatSync(descriptor);
    const nanosecondStat = fileSystem.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || !privateModeMatches(stat, 0o600, platform)) throw unsafeFilesystem();
    return openedFileIdentity(stat, nanosecondStat);
  } finally {
    if (descriptor !== null) fileSystem.closeSync(descriptor);
  }
}

function writePublicationClaimState(owned, fileSystem) {
  const claim = buildImportedPublicationClaim({
    id: owned.id,
    mediaKind: owned.normalizedPreviewPath ? 'video' : 'image',
    directory: owned.assetFinalIdentity,
    canonical: owned.canonicalFinalIdentity,
    preview: owned.publishedPreviewIdentity,
  });
  if (!claim || owned.claimFd === null) throw unsafeFilesystem();
  const bytes = Buffer.from(`${JSON.stringify(claim)}\n`);
  const before = fileSystem.fstatSync(owned.claimFd);
  let offset = 0;
  while (offset < bytes.length) {
    const written = fileSystem.writeSync(
      owned.claimFd,
      bytes,
      offset,
      bytes.length - offset,
      null,
    );
    if (!Number.isSafeInteger(written) || written <= 0) throw unsafeFilesystem();
    offset += written;
  }
  fileSystem.fsyncSync(owned.claimFd);
  const stat = fileSystem.fstatSync(owned.claimFd);
  const nanosecondStat = fileSystem.fstatSync(owned.claimFd, { bigint: true });
  if (!stat.isFile() || !privateModeMatches(stat, 0o600, owned.platform)
    || stat.size !== before.size + bytes.length) {
    throw unsafeFilesystem();
  }
  owned.claimBytes = Buffer.concat([owned.claimBytes, bytes]);
  owned.claimIdentity = openedFileIdentity(stat, nanosecondStat);
  owned.claimIdentity.bytes = Buffer.from(owned.claimBytes);
  assertOwnedFile(fileSystem, owned.claimPath, owned.claimIdentity);
}

function openPublicationClaim(owned, fileSystem) {
  assertOwnedFile(fileSystem, owned.claimPrivatePath, owned.claimIdentity);
  fileSystem.linkSync(owned.claimPrivatePath, owned.claimPath);
  assertOwnedFile(fileSystem, owned.claimPath, owned.claimIdentity);
  fsyncDirectoryIfSupported(
    fileSystem, owned.assetParent, fileSystemCapabilities(owned.platform),
  );
  writePublicationClaimState(owned, fileSystem);
  fsyncDirectoryIfSupported(
    fileSystem, owned.assetParent, fileSystemCapabilities(owned.platform),
  );
  appendOwnerRecord(owned, fileSystem);
}

function copyExclusiveFile({
  fileSystem,
  sourcePath,
  sourceIdentity,
  targetPath,
  preownedIdentity = null,
  onOwned = () => {},
  platform = process.platform,
  maxBytes = null,
}) {
  const constants = fileSystem.constants || fs.constants;
  let sourceFd = null;
  let targetFd = null;
  let targetBytes = 0;
  try {
    sourceFd = fileSystem.openSync(sourcePath, openReadOnlyFlags(fileSystem, platform));
    const sourceBefore = openedFileIdentity(
      fileSystem.fstatSync(sourceFd),
      fileSystem.fstatSync(sourceFd, { bigint: true }),
    );
    if (!sameFileIdentity(sourceBefore, sourceIdentity)) throw unsafeFilesystem();
    targetFd = fileSystem.openSync(targetPath, withNoFollow(
      fileSystem,
      preownedIdentity
        ? constants.O_WRONLY
        : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      platform,
    ), 0o600);
    setPrivateDescriptorMode(fileSystem, targetFd, 0o600, platform);
    const openedTarget = openedFileIdentity(
      fileSystem.fstatSync(targetFd),
      fileSystem.fstatSync(targetFd, { bigint: true }),
    );
    if (preownedIdentity && !sameIdentity(openedTarget, preownedIdentity)) throw unsafeFilesystem();
    onOwned(openedTarget);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let count;
    do {
      count = fileSystem.readSync(sourceFd, buffer, 0, buffer.length, null);
      if (count > 0) {
        hash.update(buffer.subarray(0, count));
        if (maxBytes !== null && BigInt(targetBytes + count) > maxBytes) {
          throw mediaImportError(507, 'MEDIA_IMPORT_OUTPUT_QUOTA_EXCEEDED');
        }
        let offset = 0;
        while (offset < count) {
          const written = fileSystem.writeSync(targetFd, buffer, offset, count - offset);
          if (written <= 0) throw unsafeFilesystem();
          offset += written;
        }
        targetBytes += count;
      }
    } while (count > 0);
    fileSystem.fsyncSync(targetFd);
    const sourceAfter = openedFileIdentity(
      fileSystem.fstatSync(sourceFd),
      fileSystem.fstatSync(sourceFd, { bigint: true }),
    );
    const targetStat = fileSystem.fstatSync(targetFd);
    const targetIdentity = openedFileIdentity(
      targetStat,
      fileSystem.fstatSync(targetFd, { bigint: true }),
    );
    if (!sameFileIdentity(sourceBefore, sourceAfter) || targetIdentity.size !== sourceBefore.size
      || !privateModeMatches(targetStat, 0o600, platform)) throw unsafeFilesystem();
    return { identity: targetIdentity, sha256: hash.digest('hex') };
  } finally {
    if (targetFd !== null) fileSystem.closeSync(targetFd);
    if (sourceFd !== null) fileSystem.closeSync(sourceFd);
  }
}

function buildCanonicalMetadata(owned, headers, master, fileSystem, discovery = null) {
  assertOutputIdentities(fileSystem, owned);
  const canonicalSha256 = hashOpenedFile(
    fileSystem,
    owned.canonicalPath,
    owned.canonicalIdentity,
    owned.platform,
  );
  assertOutputIdentities(fileSystem, owned);
  const previewSha256 = owned.normalizedPreviewPath
    ? hashOpenedFile(
      fileSystem, owned.normalizedPreviewPath, owned.previewIdentity, owned.platform,
    )
    : null;
  assertOutputIdentities(fileSystem, owned);
  const metadata = {
    version: discovery ? 3 : 2,
    id: owned.id,
    label: headers.filename,
    mediaKind: headers.mediaKind,
    canonicalSha256,
    previewSha256,
    width: master.width,
    height: master.height,
    fps: headers.mediaKind === 'image' ? 0 : master.fps,
    durationSec: headers.mediaKind === 'image' ? 0 : master.durationSec,
    audioDurationSec: headers.mediaKind === 'image' ? null : master.audioDurationSec,
    hasAudio: headers.mediaKind === 'image' ? false : master.hasAudio,
    ...(discovery ? {
      provenance: discovery.provenance,
      textScan: discovery.textScan,
    } : {}),
  };
  return metadata;
}

function removeIfOwnedFile(fileSystem, target, expected) {
  if (!target || !expected) return false;
  try {
    return claimAndRemoveOwnedPath({ target, expected, fileSystem });
  } catch (_) { /* never broaden cleanup after a race */ }
  return false;
}

function ownedFileAbsentOrRemoved(fileSystem, target, expected) {
  if (!target) return true;
  try {
    return claimAndRemoveOwnedPath({ target, expected, fileSystem });
  } catch (_) {
    return false;
  }
}

function ownedDirectoryAbsentOrRemoved(fileSystem, target, expected) {
  if (!target) return true;
  try {
    return claimAndRemoveOwnedPath({ target, expected, kind: 'directory', fileSystem });
  } catch (_) {
    return false;
  }
}

function claimFinalDirectory(owned, fileSystem) {
  try {
    fileSystem.mkdirSync(owned.assetFinalPath, { mode: 0o700 });
  } catch (_) {
    throw unsafeFilesystem();
  }
  const created = fileSystem.lstatSync(owned.assetFinalPath);
  if (!created.isDirectory() || created.isSymbolicLink()) throw unsafeFilesystem();
  owned.assetFinalIdentity = identity(created);
  setPrivatePathMode(fileSystem, owned.assetFinalPath, 0o700, owned.platform);
  const checked = fileSystem.lstatSync(owned.assetFinalPath);
  if (!checked.isDirectory() || checked.isSymbolicLink()
    || !sameIdentity(checked, owned.assetFinalIdentity)
    || !privateModeMatches(checked, 0o700, owned.platform)) throw unsafeFilesystem();
}

function publishImportedBundle({ owned, metadata, fileSystem, budgets, checkDisk }) {
  assertOwnedImport(fileSystem, owned);
  assertOutputIdentities(fileSystem, owned);
  openPublicationClaim(owned, fileSystem);
  if (owned.normalizedPreviewPath) {
    checkDisk('preview-publication');
    owned.previewStageIdentity = createOwnedOutputPlaceholder(
      fileSystem, owned.previewStagePath, owned.platform,
    );
    appendOwnerRecord(owned, fileSystem);
    const previewCopy = copyExclusiveFile({
      fileSystem,
      sourcePath: owned.normalizedPreviewPath,
      sourceIdentity: owned.previewIdentity,
      targetPath: owned.previewStagePath,
      preownedIdentity: owned.previewStageIdentity,
      onOwned: (value) => { owned.previewStageIdentity = value; },
      platform: owned.platform,
      maxBytes: budgets.proxy,
    });
    if (previewCopy.sha256 !== metadata.previewSha256) throw unsafeFilesystem();
    owned.previewStageIdentity = previewCopy.identity;
    owned.publishedPreviewIdentity = previewCopy.identity;
    writePublicationClaimState(owned, fileSystem);
    appendOwnerRecord(owned, fileSystem);
    fileSystem.linkSync(owned.previewStagePath, owned.previewFinalPath);
    assertOwnedFile(fileSystem, owned.previewFinalPath, owned.publishedPreviewIdentity);
    if (removeIfOwnedFile(fileSystem, owned.previewStagePath, owned.previewStageIdentity)) {
      owned.previewStageIdentity = null;
      appendOwnerRecord(owned, fileSystem);
    }
  }
  assertOwnedDirectory(fileSystem, owned.assetParent, owned.assetParentIdentity, owned.projectReal);
  checkDisk('canonical-publication');
  claimFinalDirectory(owned, fileSystem);
  appendOwnerRecord(owned, fileSystem);
  writePublicationClaimState(owned, fileSystem);
  appendOwnerRecord(owned, fileSystem);
  const finalCanonicalPath = path.join(
    owned.assetFinalPath,
    metadata.mediaKind === 'image' ? 'media.webp' : 'media.mp4',
  );
  owned.canonicalFinalPath = finalCanonicalPath;
  owned.canonicalFinalIdentity = createOwnedOutputPlaceholder(
    fileSystem, owned.canonicalFinalPath, owned.platform,
  );
  appendOwnerRecord(owned, fileSystem);
  const canonicalCopy = copyExclusiveFile({
    fileSystem,
    sourcePath: owned.canonicalPath,
    sourceIdentity: owned.canonicalIdentity,
    targetPath: finalCanonicalPath,
    preownedIdentity: owned.canonicalFinalIdentity,
    onOwned: (value) => { owned.canonicalFinalIdentity = value; },
    platform: owned.platform,
    maxBytes: metadata.mediaKind === 'image' ? budgets.image : budgets.master,
  });
  if (canonicalCopy.sha256 !== metadata.canonicalSha256) throw unsafeFilesystem();
  owned.canonicalFinalIdentity = canonicalCopy.identity;
  writePublicationClaimState(owned, fileSystem);
  appendOwnerRecord(owned, fileSystem);
  const verified = verifyImportedAssetFiles({
    id: owned.id,
    mediaKind: metadata.mediaKind,
    assetDirectory: owned.assetFinalPath,
    previewPath: owned.previewFinalPath,
    metadata,
    fileSystem,
    platform: owned.platform,
  });
  if (!verified
    || !sameFileIdentity(verified.canonical, owned.canonicalFinalIdentity)
    || (verified.preview && !sameFileIdentity(verified.preview, owned.publishedPreviewIdentity))) {
    throw mediaImportError(500, 'MEDIA_IMPORT_PUBLICATION_INVALID');
  }
  const record = buildImportedAssetRecord({
    projectDir: owned.projectDir,
    mediaType: metadata.mediaKind === 'image' ? 'images' : 'video',
    id: owned.id,
    verified,
  });
  assertOwnedFile(fileSystem, owned.canonicalFinalPath, owned.canonicalFinalIdentity);
  if (owned.previewFinalPath) {
    assertOwnedFile(fileSystem, owned.previewFinalPath, owned.publishedPreviewIdentity);
  }
  assertOwnedDirectory(
    fileSystem,
    owned.assetFinalPath,
    owned.assetFinalIdentity,
    owned.projectReal,
  );
  owned.metadataFinalPath = path.join(owned.assetFinalPath, 'asset.json');
  owned.metadataFinalIdentity = writeExclusive(
    fileSystem,
    owned.metadataFinalPath,
    `${JSON.stringify(metadata)}\n`,
    (value) => { owned.metadataFinalIdentity = value; },
    owned.platform,
  );
  owned.published = true;
  appendOwnerRecord(owned, fileSystem);
  return record;
}

function cleanupOwnedImport(owned, fileSystem) {
  if (!owned) return;
  if (owned.uploadFd !== null) {
    try { fileSystem.closeSync(owned.uploadFd); } catch (_) { /* owned descriptor */ }
    owned.uploadFd = null;
  }
  if (owned.claimFd !== null) {
    try { fileSystem.closeSync(owned.claimFd); } catch (_) { /* owned descriptor */ }
    owned.claimFd = null;
  }
  if (owned.ownerFd !== null) {
    try { fileSystem.closeSync(owned.ownerFd); } catch (_) { /* owned descriptor */ }
    owned.ownerFd = null;
  }
  if (!owned.published) {
    const targetsRemoved = [
      ownedFileAbsentOrRemoved(
        fileSystem,
        owned.previewFinalPath,
        owned.publishedPreviewIdentity,
      ),
      ownedFileAbsentOrRemoved(
        fileSystem,
        owned.metadataFinalPath,
        owned.metadataFinalIdentity,
      ),
      ownedFileAbsentOrRemoved(
        fileSystem,
        owned.canonicalFinalPath,
        owned.canonicalFinalIdentity,
      ),
      ownedFileAbsentOrRemoved(
        fileSystem,
        owned.previewStagePath,
        owned.previewStageIdentity,
      ),
    ].every(Boolean);
    if (targetsRemoved && ownedDirectoryAbsentOrRemoved(
      fileSystem,
      owned.assetFinalPath,
      owned.assetFinalIdentity,
    )) {
      removeIfOwnedFile(fileSystem, owned.claimPath, owned.claimIdentity);
    }
  }
  try {
    const expectedRoot = new Set([
      'owner.jsonl', 'owner.anchor', 'publication.claim', 'bundle', 'upload.bin',
    ]);
    if (owned.previewIdentity) expectedRoot.add('preview.webm');
    const expectedBundle = new Set(owned.canonicalIdentity
      ? [owned.previewIdentity ? 'media.mp4' : 'media.webp'] : []);
    const rootEntries = fileSystem.readdirSync(owned.quarantinePath);
    const bundleEntries = fileSystem.readdirSync(owned.bundlePath);
    if (rootEntries.length === expectedRoot.size
      && rootEntries.every((entry) => expectedRoot.has(entry))
      && bundleEntries.length === expectedBundle.size
      && bundleEntries.every((entry) => expectedBundle.has(entry))) {
      const contentRemoved = [
        [owned.canonicalPath, owned.canonicalIdentity, 'mutable-file'],
        [owned.normalizedPreviewPath, owned.previewIdentity, 'mutable-file'],
        [owned.uploadPath, owned.uploadIdentity, 'mutable-file'],
        [owned.claimPrivatePath, owned.claimIdentity, 'file'],
      ].every(([target, expected, kind]) => !target || !expected
        || claimAndRemoveOwnedPath({ target, expected, kind, fileSystem }));
      if (contentRemoved
        && removeIfOwnedFile(fileSystem, owned.ownerAnchorPath, owned.ownerIdentity)
        && removeIfOwnedFile(fileSystem, owned.ownerPath, owned.ownerIdentity)
        && ownedDirectoryAbsentOrRemoved(
          fileSystem, owned.bundlePath, owned.bundleIdentity,
        )) {
        ownedDirectoryAbsentOrRemoved(
          fileSystem, owned.quarantinePath, owned.quarantineIdentity,
        );
      }
    }
  } catch (_) { /* an identity race leaves the exact remnant for lease recovery */ }
  if (owned.published) {
    removeIfOwnedFile(fileSystem, owned.previewStagePath, owned.previewStageIdentity);
  }
}

function numericIdentity(value, directory = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = directory ? ['dev', 'ino'] : ['dev', 'ino', 'size', 'mtimeNs'];
  if (Object.keys(value).length !== keys.length
    || !keys.every((key) => typeof value[key] === 'string' && /^(0|[1-9][0-9]*)$/.test(value[key]))) {
    return null;
  }
  return value;
}

function readRecoveryOwner(fileSystem, quarantinePath, id, platform = process.platform) {
  const ownerPath = path.join(quarantinePath, 'owner.jsonl');
  const anchorPath = path.join(quarantinePath, 'owner.anchor');
  let ownerStat;
  let anchorStat;
  let bytes;
  try {
    ownerStat = fileSystem.lstatSync(ownerPath, { bigint: true });
    anchorStat = fileSystem.lstatSync(anchorPath, { bigint: true });
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || !anchorStat.isFile()
      || anchorStat.isSymbolicLink() || ownerStat.dev !== anchorStat.dev
      || ownerStat.ino !== anchorStat.ino || !privateModeMatches(ownerStat, 0o600, platform)
      || ownerStat.size <= 0n || ownerStat.size > BigInt(OWNER_MAX_BYTES)) return null;
    bytes = fileSystem.readFileSync(ownerPath);
    const after = fileSystem.lstatSync(ownerPath, { bigint: true });
    if (after.dev !== ownerStat.dev || after.ino !== ownerStat.ino
      || after.size !== ownerStat.size || after.mtimeNs !== ownerStat.mtimeNs) return null;
  } catch (_) {
    return null;
  }
  const text = bytes.toString('utf8');
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline < 0) return null;
  const records = text.slice(0, lastNewline).split('\n');
  let latest = null;
  for (const line of records) {
    let record;
    try { record = JSON.parse(line); } catch (_) { return null; }
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || Object.keys(record).length !== OWNER_RECORD_KEYS.length
      || !OWNER_RECORD_KEYS.every((key) => Object.hasOwn(record, key))
      || record.version !== 1 || record.purpose !== OWNER_PURPOSE
      || record.id !== id
      || typeof record.hostname !== 'string' || !Number.isInteger(record.pid) || record.pid <= 0
      || typeof record.token !== 'string' || !/^[A-Za-z0-9_-]+$/.test(record.token)
      || !numericIdentity(record.quarantine, true) || !numericIdentity(record.bundle, true)
      || !numericIdentity(record.upload)
      || !['canonical', 'preview', 'claim', 'previewStage', 'previewFinal',
        'assetDirectory', 'canonicalFinal', 'metadataFinal'].every((key) => (
        record[key] === null || numericIdentity(record[key], key === 'assetDirectory')
      )) || typeof record.committed !== 'boolean') return null;
    if (latest && (record.hostname !== latest.hostname || record.pid !== latest.pid
      || record.token !== latest.token
      || JSON.stringify(record.quarantine) !== JSON.stringify(latest.quarantine)
      || JSON.stringify(record.bundle) !== JSON.stringify(latest.bundle))) return null;
    latest = record;
  }
  return latest ? {
    record: latest,
    ownerIdentity: {
      dev: String(ownerStat.dev),
      ino: String(ownerStat.ino),
      size: String(ownerStat.size),
      mtimeNs: String(ownerStat.mtimeNs),
      bytes: Buffer.from(bytes),
    },
    ownerPath,
    anchorPath,
  } : null;
}

function recoveryTargetMatches(fileSystem, target, expected, directory = false) {
  if (!expected) return false;
  try {
    const stat = fileSystem.lstatSync(target, { bigint: true });
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) return false;
    return String(stat.dev) === expected.dev && String(stat.ino) === expected.ino
      && (directory || (String(stat.size) === expected.size
        && String(stat.mtimeNs) === expected.mtimeNs));
  } catch (_) {
    return false;
  }
}

function removeRecoveryFile(fileSystem, target, expected) {
  try {
    return claimAndRemoveOwnedPath({ target, expected, fileSystem });
  } catch (_) { return false; }
}

function removeRecoveryNode(fileSystem, target, expected) {
  try {
    return claimAndRemoveOwnedPath({
      target, expected, kind: 'mutable-file', fileSystem,
    });
  } catch (_) { return false; }
}

function recoverQuarantine({
  projectDir,
  quarantinePath,
  id,
  fileSystem,
  hostname,
  killProcess,
  platform,
}) {
  const owned = readRecoveryOwner(fileSystem, quarantinePath, id, platform);
  if (!owned || owned.record.hostname !== hostname) return [];
  try {
    killProcess(owned.record.pid, 0);
    return [];
  } catch (error) {
    if (!error || error.code !== 'ESRCH') return [];
  }
  const { record } = owned;
  if (!recoveryTargetMatches(fileSystem, quarantinePath, record.quarantine, true)
    || !recoveryTargetMatches(fileSystem, path.join(quarantinePath, 'bundle'), record.bundle, true)) {
    return [];
  }
  const bundlePath = path.join(quarantinePath, 'bundle');
  const expectedRoot = new Set([
    'owner.jsonl', 'owner.anchor', 'publication.claim', 'bundle', 'upload.bin',
  ]);
  if (record.preview) expectedRoot.add('preview.webm');
  const expectedBundle = new Set(record.canonical
    ? [record.preview === null ? 'media.webp' : 'media.mp4'] : []);
  let rootEntries;
  let bundleEntries;
  try {
    rootEntries = fileSystem.readdirSync(quarantinePath);
    bundleEntries = fileSystem.readdirSync(bundlePath);
  } catch (_) {
    return [];
  }
  if (!rootEntries.includes('owner.jsonl') || !rootEntries.includes('owner.anchor')
    || !rootEntries.includes('bundle')
    || rootEntries.some((entry) => !expectedRoot.has(entry)
      && !/^\.(?:upload\.bin|preview\.webm|publication\.claim|owner\.jsonl|owner\.anchor|bundle)\.remove-[A-Za-z0-9_-]+$/.test(entry))
    || bundleEntries.some((entry) => !expectedBundle.has(entry)
      && !/^\.media\.(?:mp4|webp)\.remove-[A-Za-z0-9_-]+$/.test(entry))) return [];

  const removed = [];
  const mediaType = record.preview === null ? 'images' : 'video';
  const assetDirectory = path.join(projectDir, 'assets', 'broll', mediaType, id);
  const committed = record.committed || Boolean(inspectImportedAssetBundle({
    projectDir,
    assetDirectory,
    fileSystem,
    platform,
  }));
  if (!committed) {
    for (const [target, expected, kind] of [
      [record.previewFinal ? path.join(projectDir, 'previews', 'broll', `${id}.webm`) : null,
        record.previewFinal, 'file'],
      [record.metadataFinal ? path.join(assetDirectory, 'asset.json') : null,
        record.metadataFinal, 'file'],
      [record.canonicalFinal ? path.join(
        assetDirectory, record.preview === null ? 'media.webp' : 'media.mp4',
      ) : null, record.canonicalFinal, 'mutable-file'],
      [record.previewStage ? path.join(projectDir, 'previews', 'broll', `.${id}.stage.webm`) : null,
        record.previewStage, 'mutable-file'],
      [record.claim ? path.join(
        projectDir, 'assets', 'broll', mediaType, `.${id}.claim`,
      ) : null, record.claim, 'mutable-file'],
    ]) {
      if (!target || !expected) continue;
      try {
        if (!claimAndRemoveOwnedPath({ target, expected, kind, fileSystem })) return removed;
        removed.push(target);
      } catch (_) { return removed; }
    }
    if (record.assetDirectory) {
      try {
        if (!claimAndRemoveOwnedPath({
          target: assetDirectory,
          expected: record.assetDirectory,
          kind: 'directory',
          fileSystem,
        })) return removed;
        removed.push(assetDirectory);
      } catch (_) { return removed; }
    }
  }
  for (const [target, expected, mutable] of [
    [path.join(bundlePath, record.preview === null ? 'media.webp' : 'media.mp4'), record.canonical, true],
    [path.join(quarantinePath, 'preview.webm'), record.preview, true],
    [path.join(quarantinePath, 'upload.bin'), record.upload, true],
    [path.join(quarantinePath, 'publication.claim'), record.claim, true],
  ]) {
    if (!target || !expected) continue;
    try {
      if (!(mutable
        ? removeRecoveryNode(fileSystem, target, expected)
        : removeRecoveryFile(fileSystem, target, expected))) return removed;
      removed.push(target);
    } catch (_) { return removed; }
  }
  try {
    if (!claimAndRemoveOwnedPath({
      target: owned.anchorPath, expected: owned.ownerIdentity, fileSystem,
    }) || !claimAndRemoveOwnedPath({
      target: owned.ownerPath, expected: owned.ownerIdentity, fileSystem,
    }) || !claimAndRemoveOwnedPath({
      target: bundlePath, expected: record.bundle, kind: 'directory', fileSystem,
    }) || !claimAndRemoveOwnedPath({
      target: quarantinePath, expected: record.quarantine, kind: 'directory', fileSystem,
    })) return removed;
    removed.push(owned.anchorPath, owned.ownerPath, bundlePath, quarantinePath);
  } catch (_) { /* resumable on the next lease owner */ }
  return removed;
}

function cleanupOrphanImportQuarantines({
  projectDir,
  fileSystem = fs,
  mutationLease = null,
  hostname = os.hostname(),
  killProcess = process.kill,
  platform = process.platform,
} = {}) {
  const lease = mutationLease || acquireProjectMutationLease(projectDir, { fileSystem, platform });
  const ownsLease = !mutationLease;
  const removed = [];
  try {
    const parent = path.join(path.resolve(projectDir), 'tmp', 'review-imports');
    let entries;
    try { entries = fileSystem.readdirSync(parent, { withFileTypes: true }); } catch (_) { return removed; }
    for (const entry of entries) {
      if (!UUID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      removed.push(...recoverQuarantine({
        projectDir: path.resolve(projectDir),
        quarantinePath: path.join(parent, entry.name),
        id: entry.name,
        fileSystem,
        hostname,
        killProcess,
        platform,
      }));
    }
    return removed;
  } finally {
    if (ownsLease) lease.release();
  }
}

async function importReviewMedia({
  request,
  signal,
  projectDir,
  outputFps,
  headers,
  controller,
  fileSystem = fs,
  runMediaProcessImpl,
  statfsImpl = fs.statfsSync,
  randomId = crypto.randomUUID,
  platform = process.platform,
  provenance = null,
  scanEmbeddedTextImpl = scanEmbeddedText,
  masterStrategy = 'encode',
  log = console.log,
}) {
  if (!['encode', 'remux-if-conforming'].includes(masterStrategy)) {
    throw new Error('masterStrategy: допустимы encode и remux-if-conforming');
  }
  if (!controller?.acquire()) throw mediaImportError(409, 'MEDIA_IMPORT_BUSY');
  let owned;
  let mutationLease;
  let workError = null;
  try {
    const parsedHeaders = parseImportHeaders(headers);
    const discoveryProvenance = provenance === null ? null : validateProvenance(provenance);
    assertDiskSpace(projectDir, statfsImpl, requiredFreeBytes(parsedHeaders.contentLength));
    try {
      mutationLease = acquireProjectMutationLease(projectDir, { fileSystem, platform });
    } catch (error) {
      if (error && error.code === 'PROJECT_MANIFEST_CONFLICT') {
        throw mediaImportError(409, 'MEDIA_IMPORT_BUSY');
      }
      throw error;
    }
    cleanupOrphanImportQuarantines({ projectDir, fileSystem, mutationLease, platform });
    cleanupOrphanImportedStages({ projectDir, fileSystem, mutationLease, platform });
    owned = createOwnedQuarantine(
      projectDir, randomId(), parsedHeaders.mediaKind, fileSystem, mutationLease, platform,
    );
    await streamExactBody(request, owned, parsedHeaders.contentLength, signal, fileSystem);
    assertOwnedFile(fileSystem, owned.uploadPath, owned.uploadIdentity);

    let source;
    try {
      const probeOutput = await runMediaProcessImpl(buildProbeInvocation(owned.uploadPath, signal));
      assertOwnedFile(fileSystem, owned.uploadPath, owned.uploadIdentity);
      source = parseMediaProbeJson(probeOutput.stdout);
    } catch (error) {
      if (error.status || error.code === 'MEDIA_PROCESS_ABORTED') throw error;
      throw mediaImportError(422, 'MEDIA_IMPORT_DECODE_FAILED', 'media decode failed', { cause: error });
    }
    assertMediaLimits(source, parsedHeaders);
    const budgets = deriveOutputBudgets({
      mediaKind: source.mediaKind,
      inputBytes: parsedHeaders.contentLength,
      width: source.width,
      height: source.height,
      durationSec: source.durationSec,
      fps: source.mediaKind === 'video' ? outputFps : 0,
      hasAudio: source.hasAudio,
    });
    const checkDisk = (phase) => assertDiskSpace(
      projectDir,
      statfsImpl,
      phaseFreeBytes(source.mediaKind, budgets, phase),
    );
    let metadata;
    try {
      await normalizeIntoQuarantine({
        source, outputFps, owned, signal, fileSystem, run: runMediaProcessImpl,
        budgets, checkDisk, masterStrategy, log,
      });
      const master = await verifyNormalizedOutputs({
        source, outputFps, owned, signal, fileSystem, run: runMediaProcessImpl,
      });
      let discovery = null;
      if (discoveryProvenance) {
        let textScan;
        try {
          textScan = await scanEmbeddedTextImpl({
            filePath: owned.canonicalPath,
            mediaKind: parsedHeaders.mediaKind,
            durationSec: parsedHeaders.mediaKind === 'video' ? master.durationSec : 0,
            signal,
            run: runMediaProcessImpl,
          });
        } catch (error) {
          if (signal?.aborted || error?.code === 'MEDIA_PROCESS_ABORTED') {
            if (error?.code === 'MEDIA_PROCESS_ABORTED') throw error;
            throw Object.assign(new Error('media import aborted'), {
              code: 'MEDIA_PROCESS_ABORTED', cause: error,
            });
          }
          textScan = {
            status: 'unavailable', text: '', reasons: ['ocr-failed'], engine: 'tesseract',
          };
        }
        if (signal?.aborted) {
          throw Object.assign(new Error('media import aborted'), {
            code: 'MEDIA_PROCESS_ABORTED',
          });
        }
        discovery = { provenance: discoveryProvenance, textScan };
      }
      metadata = buildCanonicalMetadata(
        owned, parsedHeaders, master, fileSystem, discovery,
      );
      const staged = verifyImportedAssetFiles({
        id: owned.id,
        mediaKind: parsedHeaders.mediaKind,
        assetDirectory: owned.bundlePath,
        previewPath: owned.normalizedPreviewPath,
        metadata,
        fileSystem,
        platform,
      });
      if (!staged
        || !sameFileIdentity(staged.canonical, owned.canonicalIdentity)
        || (staged.preview && !sameFileIdentity(staged.preview, owned.previewIdentity))) {
        throw mediaImportError(422, 'MEDIA_IMPORT_OUTPUT_INVALID');
      }
    } catch (error) {
      if (error.status || error.code === 'MEDIA_PROCESS_ABORTED') throw error;
      throw mediaImportError(422, 'MEDIA_IMPORT_NORMALIZATION_FAILED', 'media normalization failed', { cause: error });
    }
    try {
      return publishImportedBundle({ owned, metadata, fileSystem, budgets, checkDisk });
    } catch (error) {
      if (error.status) throw error;
      throw mediaImportError(500, 'MEDIA_IMPORT_FILESYSTEM_UNSAFE', undefined, { cause: error });
    }
  } catch (error) {
    workError = error;
    throw error;
  } finally {
    let finalizationError = null;
    try {
      cleanupOwnedImport(owned, fileSystem);
    } catch (error) {
      finalizationError = error;
    }
    try {
      if (mutationLease) mutationLease.release();
    } catch (error) {
      if (workError) workError.leaseReleaseError = error;
      else if (finalizationError) finalizationError.leaseReleaseError = error;
      else finalizationError = error;
    } finally {
      controller.release();
    }
    if (!workError && finalizationError) throw finalizationError;
  }
}

module.exports = {
  DISK_RESERVE_BYTES,
  IMAGE_MAX_BYTES,
  MAX_IMAGE_OUTPUT_BYTES,
  MAX_MASTER_OUTPUT_BYTES,
  MAX_PROXY_OUTPUT_BYTES,
  VIDEO_MAX_BYTES,
  createImportController,
  cleanupOrphanImportQuarantines,
  deriveOutputBudgets,
  importReviewMedia,
  mediaImportError,
  parseImportHeaders,
  requiredFreeBytes,
  remuxConformity,
};
