const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { isCanonicalBrollReference, videoEndFrame } = require('./broll-media');
const {
  openReadOnlyFlags,
  probeOpenedMedia,
  sameOpenedFileSnapshot,
} = require('../media-probe');
const { parseImportedAssetMetadata } = require('../review/imported-assets');

const HASH_BUFFER_BYTES = 64 * 1024;
const MAX_METADATA_BYTES = 32 * 1024;
const { hashTextScan } = require('../broll/text-scan');
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const NORMALIZED_IMAGE = new RegExp(`^assets/broll/images/(${UUID})/media\\.webp$`);
const NORMALIZED_VIDEO = new RegExp(`^assets/broll/video/(${UUID})/media\\.mp4$`);
const ERROR_MESSAGES = Object.freeze({
  BROLL_PREVIEW_REQUIRED: 'discovered b-roll requires an approved full-preview receipt',
  BROLL_TEXT_REVIEW_REQUIRED: 'b-roll embedded text requires acknowledgement of the exact media and scan',
  BROLL_INTENT_UNRESOLVED: 'b-roll search intent requires selected local media',
  BROLL_MEDIA_PATH_INVALID: 'b-roll media reference is not allowed',
  BROLL_MEDIA_MISSING: 'b-roll media file is missing',
  BROLL_MEDIA_SYMLINK: 'b-roll media path contains a symbolic link',
  BROLL_MEDIA_NOT_REGULAR: 'b-roll media must be a regular file',
  BROLL_MEDIA_OPEN_FAILED: 'b-roll media could not be opened safely',
  BROLL_MEDIA_PROBE_FAILED: 'b-roll media could not be verified',
  BROLL_MEDIA_KIND_MISMATCH: 'b-roll media kind does not match the draft',
  BROLL_MEDIA_HASH_MISMATCH: 'b-roll media hash does not match the draft',
  BROLL_MEDIA_VIDEO_NOT_NORMALIZED: 'b-roll video is not a normalized imported asset',
  BROLL_MEDIA_METADATA_INVALID: 'b-roll asset metadata is invalid',
  BROLL_MEDIA_METADATA_MISMATCH: 'b-roll asset metadata does not match the media',
  BROLL_MEDIA_PROXY_MISSING: 'b-roll preview proxy is missing',
  BROLL_MEDIA_PROXY_HASH_MISMATCH: 'b-roll preview proxy hash is invalid',
  BROLL_MEDIA_CLIP_OVERRUN: 'b-roll video clip exceeds media duration',
  BROLL_MEDIA_AUDIO_REQUIRED: 'b-roll audio mode requires an audio stream',
  BROLL_MEDIA_IDENTITY_CHANGED: 'b-roll media identity changed during approval',
  BROLL_MEDIA_SCENE_INVALID: 'b-roll media is allowed only on a b-roll scene',
});

function fail(code) {
  const error = new Error(`${code}: ${ERROR_MESSAGES[code]}`);
  error.code = code;
  throw error;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative));
}

function snapshot(fileSystem, descriptor) {
  const stat = fileSystem.fstatSync(descriptor, { bigint: true });
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    mode: stat.mode,
    nlink: stat.nlink,
    isFile: stat.isFile(),
  };
}

function sameSnapshot(left, right, platform = process.platform) {
  return sameOpenedFileSnapshot(left, right, platform);
}

function preflightBriefBrollMedia(brief) {
  for (const scene of Array.isArray(brief?.scenes) ? brief.scenes : []) {
    const hasLegacy = scene && Object.hasOwn(scene, 'brollSrc');
    const hasPersisted = scene && Object.hasOwn(scene, 'brollMedia');
    if (scene?.scene !== 'broll' && (hasLegacy || hasPersisted)) {
      fail('BROLL_MEDIA_SCENE_INVALID');
    }
    if (scene?.scene === 'broll' && hasPersisted
      && !isCanonicalBrollReference(scene.brollMedia?.src)) {
      fail('BROLL_MEDIA_PATH_INVALID');
    }
  }
}

function resolveContainedFile({
  storageRoot,
  storedReference,
  fileSystem,
  missingCode = 'BROLL_MEDIA_MISSING',
} = {}) {
  const resolvedRoot = path.resolve(storageRoot);
  const segments = storedReference.split('/');
  const candidate = path.resolve(resolvedRoot, ...segments);
  if (!isInside(resolvedRoot, candidate)) fail('BROLL_MEDIA_PATH_INVALID');
  let current = resolvedRoot;
  const pathGuards = [];
  for (const segment of ['', ...segments]) {
    if (segment) current = path.join(current, segment);
    let stat;
    try {
      stat = fileSystem.lstatSync(current, { bigint: true });
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) fail(missingCode);
      fail('BROLL_MEDIA_OPEN_FAILED');
    }
    if (stat.isSymbolicLink()) fail('BROLL_MEDIA_SYMLINK');
    if (current !== candidate && !stat.isDirectory()) fail('BROLL_MEDIA_PATH_INVALID');
    if (current === candidate && !stat.isFile()) fail('BROLL_MEDIA_NOT_REGULAR');
    pathGuards.push({
      path: current,
      dev: stat.dev,
      ino: stat.ino,
      directory: stat.isDirectory(),
    });
  }
  return {
    filePath: candidate,
    identity: pathGuards.at(-1),
    assertSafe() {
      for (const guard of pathGuards) {
        const stat = fileSystem.lstatSync(guard.path, { bigint: true });
        if (stat.isSymbolicLink() || stat.dev !== guard.dev || stat.ino !== guard.ino
          || (guard.directory ? !stat.isDirectory() : !stat.isFile())) {
          fail('BROLL_MEDIA_IDENTITY_CHANGED');
        }
      }
    },
  };
}

function resolvePersistedBrollMedia({ root, workspace, media, fileSystem = fs } = {}) {
  if (!media || !isCanonicalBrollReference(media.src)
    || typeof workspace?.dir !== 'string' || typeof root !== 'string') {
    fail('BROLL_MEDIA_PATH_INVALID');
  }
  const projectReference = media.src.startsWith('assets/');
  const storedReference = projectReference ? media.src : media.src.replace(/^public\//, '');
  const resolved = resolveContainedFile({
    storageRoot: projectReference ? workspace.dir : path.join(root, 'public'),
    storedReference,
    fileSystem,
  });
  return {
    ...resolved,
    reference: media.src,
    scope: projectReference ? 'project' : 'public',
  };
}

function runOpenedProbe(descriptor, runToolImpl) {
  try {
    return probeOpenedMedia({
      fileDescriptor: descriptor,
      ...(runToolImpl ? { runToolImpl } : {}),
      stage: 'b-roll media probe',
    });
  } catch (_) {
    fail('BROLL_MEDIA_PROBE_FAILED');
  }
}

function hashOpened(fileSystem, descriptor, expected,
  changedCode = 'BROLL_MEDIA_IDENTITY_CHANGED', platform = process.platform) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  if (expected.size > BigInt(Number.MAX_SAFE_INTEGER)) fail(changedCode);
  let position = 0;
  while (position < Number(expected.size)) {
    const count = fileSystem.readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.length, Number(expected.size) - position),
      position,
    );
    if (count <= 0) fail(changedCode);
    hash.update(buffer.subarray(0, count));
    position += count;
  }
  if (!sameSnapshot(expected, snapshot(fileSystem, descriptor), platform)) {
    fail(changedCode);
  }
  return hash.digest('hex');
}

function readOpenedBytes(fileSystem, descriptor, expected, maxBytes, platform) {
  if (expected.size <= 0n || expected.size > BigInt(maxBytes)) {
    fail('BROLL_MEDIA_METADATA_INVALID');
  }
  const bytes = Buffer.alloc(Number(expected.size));
  let position = 0;
  while (position < bytes.length) {
    const count = fileSystem.readSync(
      descriptor, bytes, position, bytes.length - position, position,
    );
    if (count <= 0) fail('BROLL_MEDIA_METADATA_INVALID');
    position += count;
  }
  if (!sameSnapshot(expected, snapshot(fileSystem, descriptor), platform)) {
    fail('BROLL_MEDIA_IDENTITY_CHANGED');
  }
  return bytes;
}

function openTrackedFile({
  resolved,
  fileSystem,
  missingCode = 'BROLL_MEDIA_MISSING',
  platform = process.platform,
}) {
  let descriptor;
  try {
    descriptor = fileSystem.openSync(
      resolved.filePath,
      openReadOnlyFlags(fileSystem, platform),
    );
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) fail(missingCode);
    if (error && error.code === 'ELOOP') fail('BROLL_MEDIA_SYMLINK');
    fail('BROLL_MEDIA_OPEN_FAILED');
  }
  let identity;
  try {
    identity = snapshot(fileSystem, descriptor);
  } catch (_) {
    fileSystem.closeSync(descriptor);
    fail('BROLL_MEDIA_OPEN_FAILED');
  }
  if (!identity.isFile) {
    fileSystem.closeSync(descriptor);
    fail('BROLL_MEDIA_NOT_REGULAR');
  }
  if (!resolved.identity || resolved.identity.dev !== identity.dev
    || resolved.identity.ino !== identity.ino) {
    fileSystem.closeSync(descriptor);
    fail('BROLL_MEDIA_IDENTITY_CHANGED');
  }
  return {
    descriptor, identity, resolved, expectedHash: null, closed: false, platform,
  };
}

function assertTrackedIdentity(fileSystem, tracked) {
  if (tracked.closed) fail('BROLL_MEDIA_IDENTITY_CHANGED');
  try {
    tracked.resolved.assertSafe();
    const pathStat = fileSystem.lstatSync(tracked.resolved.filePath, { bigint: true });
    const pathIdentity = {
      dev: pathStat.dev,
      ino: pathStat.ino,
      size: pathStat.size,
      mtimeNs: pathStat.mtimeNs,
      ctimeNs: pathStat.ctimeNs,
      mode: pathStat.mode,
      nlink: pathStat.nlink,
    };
    if (pathStat.isSymbolicLink() || !pathStat.isFile()
      || !sameSnapshot(tracked.identity, snapshot(fileSystem, tracked.descriptor), tracked.platform)
      || !sameSnapshot(tracked.identity, pathIdentity, tracked.platform)) {
      fail('BROLL_MEDIA_IDENTITY_CHANGED');
    }
  } catch (error) {
    if (error?.code === 'BROLL_MEDIA_IDENTITY_CHANGED') throw error;
    fail('BROLL_MEDIA_IDENTITY_CHANGED');
  }
}

function verifyTrackedContent(fileSystem, tracked) {
  assertTrackedIdentity(fileSystem, tracked);
  if (tracked.expectedHash
    && hashOpened(fileSystem, tracked.descriptor, tracked.identity,
      'BROLL_MEDIA_IDENTITY_CHANGED', tracked.platform) !== tracked.expectedHash) {
    fail('BROLL_MEDIA_IDENTITY_CHANGED');
  }
  assertTrackedIdentity(fileSystem, tracked);
}

function closeTracked(fileSystem, tracked) {
  if (tracked.closed) return;
  tracked.closed = true;
  fileSystem.closeSync(tracked.descriptor);
}

function closeAll(fileSystem, trackedFiles) {
  let firstError = null;
  for (const tracked of [...trackedFiles].reverse()) {
    try {
      closeTracked(fileSystem, tracked);
    } catch (error) {
      if (!firstError) firstError = error;
    }
  }
  if (firstError) throw firstError;
}

function normalizedBundle(media) {
  const imageMatch = NORMALIZED_IMAGE.exec(media.src);
  const videoMatch = NORMALIZED_VIDEO.exec(media.src);
  if (media.kind === 'video' && !videoMatch) fail('BROLL_MEDIA_VIDEO_NOT_NORMALIZED');
  if (media.kind === 'image' && videoMatch) fail('BROLL_MEDIA_KIND_MISMATCH');
  if (/^assets\/broll\/(?:images|video)\//.test(media.src) && !imageMatch && !videoMatch) {
    fail('BROLL_MEDIA_METADATA_INVALID');
  }
  const match = imageMatch || videoMatch;
  return match ? {
    id: match[1],
    kind: imageMatch ? 'image' : 'video',
    metadataReference: `${path.posix.dirname(media.src)}/asset.json`,
    proxyReference: videoMatch ? `previews/broll/${match[1]}.webm` : null,
  } : null;
}

function readBundleMetadata({ workspace, bundle, fileSystem, trackedFiles, platform }) {
  const resolved = resolveContainedFile({
    storageRoot: workspace.dir,
    storedReference: bundle.metadataReference,
    fileSystem,
    missingCode: 'BROLL_MEDIA_METADATA_INVALID',
  });
  const tracked = openTrackedFile({
    resolved, fileSystem, missingCode: 'BROLL_MEDIA_METADATA_INVALID', platform,
  });
  trackedFiles.push(tracked);
  const bytes = readOpenedBytes(
    fileSystem, tracked.descriptor, tracked.identity, MAX_METADATA_BYTES, platform,
  );
  tracked.expectedHash = crypto.createHash('sha256').update(bytes).digest('hex');
  try {
    return parseImportedAssetMetadata({ bytes, expectedId: bundle.id });
  } catch (_) {
    fail('BROLL_MEDIA_METADATA_INVALID');
  }
}

function probeMatchesMetadata(metadata, probe) {
  if (metadata.mediaKind !== probe.mediaKind
    || metadata.width !== probe.width || metadata.height !== probe.height
    || metadata.hasAudio !== probe.hasAudio) return false;
  if (metadata.mediaKind === 'image') {
    return metadata.fps === 0 && metadata.durationSec === 0 && probe.fps === 0
      && probe.durationSec === 0;
  }
  const tolerance = (1 / metadata.fps) + 0.001;
  return Number.isFinite(probe.fps) && Math.abs(metadata.fps - probe.fps) <= 1e-6
    && Number.isFinite(probe.durationSec)
    && Math.abs(metadata.durationSec - probe.durationSec) <= tolerance
    && (metadata.hasAudio === false
      ? metadata.audioDurationSec === null && probe.audioDurationSec === null
      : Number.isFinite(metadata.audioDurationSec) && Number.isFinite(probe.audioDurationSec)
        && Math.abs(metadata.audioDurationSec - probe.audioDurationSec) <= tolerance);
}

function verifyOpenedBrollAsset({
  root,
  workspace,
  media,
  runToolImpl,
  fileSystem = fs,
  platform = process.platform,
} = {}) {
  const resolved = resolvePersistedBrollMedia({
    root, workspace, media, fileSystem,
  });
  const bundle = normalizedBundle(media);
  const trackedFiles = [];
  try {
    const canonical = openTrackedFile({ resolved, fileSystem, platform });
    trackedFiles.push(canonical);
    const metadata = bundle
      ? readBundleMetadata({ workspace, bundle, fileSystem, trackedFiles, platform })
      : null;
    if (metadata && (metadata.mediaKind !== bundle.kind
      || metadata.mediaKind !== media.kind
      || metadata.canonicalSha256 !== media.sha256)) {
      fail('BROLL_MEDIA_METADATA_MISMATCH');
    }
    const probe = runOpenedProbe(canonical.descriptor, runToolImpl);
    if (probe.mediaKind !== media.kind) fail('BROLL_MEDIA_KIND_MISMATCH');
    if (metadata && !probeMatchesMetadata(metadata, probe)) {
      fail('BROLL_MEDIA_METADATA_MISMATCH');
    }
    const canonicalHash = hashOpened(
      fileSystem, canonical.descriptor, canonical.identity,
      'BROLL_MEDIA_IDENTITY_CHANGED', platform,
    );
    if (canonicalHash !== media.sha256) fail('BROLL_MEDIA_HASH_MISMATCH');
    canonical.expectedHash = canonicalHash;

    if (bundle?.proxyReference) {
      const proxyResolved = resolveContainedFile({
        storageRoot: workspace.dir,
        storedReference: bundle.proxyReference,
        fileSystem,
        missingCode: 'BROLL_MEDIA_PROXY_MISSING', platform,
      });
      const proxy = openTrackedFile({
        resolved: proxyResolved,
        fileSystem,
        missingCode: 'BROLL_MEDIA_PROXY_MISSING',
        platform,
      });
      trackedFiles.push(proxy);
      const proxyHash = hashOpened(
        fileSystem, proxy.descriptor, proxy.identity,
        'BROLL_MEDIA_IDENTITY_CHANGED', platform,
      );
      if (proxyHash !== metadata.previewSha256) fail('BROLL_MEDIA_PROXY_HASH_MISMATCH');
      proxy.expectedHash = proxyHash;
    }

    return { probe, metadata, trackedFiles };
  } catch (error) {
    try {
      closeAll(fileSystem, trackedFiles);
    } catch (closeError) {
      error.closeError = closeError;
    }
    throw error;
  }
}

function verifySceneBrollMedia({ scene, fps, probe }) {
  const media = scene.brollMedia;
  if (media.kind !== 'video') return;
  if (probe.hasAudio !== true && media.audioMode !== 'mute') {
    fail('BROLL_MEDIA_AUDIO_REQUIRED');
  }
  let endFrame;
  try {
    endFrame = videoEndFrame({ trimStartSec: media.trimStartSec, scene, fps });
  } catch (_) {
    fail('BROLL_MEDIA_CLIP_OVERRUN');
  }
  const clipFrames = Math.round(probe.durationSec * fps);
  const audioFrames = media.audioMode === 'replace'
    ? Math.round(Number(probe.audioDurationSec) * fps)
    : null;
  if (!Number.isSafeInteger(endFrame) || endFrame <= 0
    || !Number.isSafeInteger(clipFrames) || clipFrames <= 0 || endFrame > clipFrames
    || (media.audioMode === 'replace'
      && (!Number.isSafeInteger(audioFrames) || audioFrames <= 0 || endFrame > audioFrames))) {
    fail('BROLL_MEDIA_CLIP_OVERRUN');
  }
}

function mediaVerificationKey(media) {
  return JSON.stringify([media.kind, media.src, media.sha256]);
}

function closeVerifiedAssets(fileSystem, verifiedAssets) {
  let firstError = null;
  for (const asset of verifiedAssets) {
    try {
      closeAll(fileSystem, asset.trackedFiles);
    } catch (error) {
      if (!firstError) firstError = error;
    }
  }
  if (firstError) throw firstError;
}

function assertTransactionCurrent(fileSystem, verifiedAssets) {
  const trackedFiles = verifiedAssets.flatMap((asset) => asset.trackedFiles);
  // Phase A: finish every potentially long descriptor hash before any asset is considered current.
  for (const tracked of trackedFiles) verifyTrackedContent(fileSystem, tracked);
  // Phase B: one fast transaction-wide barrier immediately before the first approval commit.
  for (const tracked of trackedFiles) assertTrackedIdentity(fileSystem, tracked);
}

function verificationHandle(fileSystem, verifiedAssets) {
  return {
    hasDiscovery: verifiedAssets.some(asset => asset.metadata?.version === 3),
    assertIdentity() {
      for (const asset of verifiedAssets) for (const tracked of asset.trackedFiles) assertTrackedIdentity(fileSystem, tracked);
    },
    assertCurrent() {
      assertTransactionCurrent(fileSystem, verifiedAssets);
    },
    close() {
      closeVerifiedAssets(fileSystem, verifiedAssets);
    },
  };
}

function verifyPersistedBrollMedia({
  root,
  workspace,
  scene,
  fps,
  runToolImpl,
  fileSystem = fs,
  platform = process.platform,
} = {}) {
  preflightBriefBrollMedia({ scenes: [scene] });
  const asset = verifyOpenedBrollAsset({
    root, workspace, media: scene.brollMedia, runToolImpl, fileSystem, platform,
  });
  try {
    verifySceneBrollMedia({ scene, fps, probe: asset.probe });
    return verificationHandle(fileSystem, [asset]);
  } catch (error) {
    try {
      closeVerifiedAssets(fileSystem, [asset]);
    } catch (closeError) {
      error.closeError = closeError;
    }
    throw error;
  }
}

function verifyBriefBrollMedia({
  root,
  workspace,
  brief,
  runToolImpl,
  fileSystem = fs,
  platform = process.platform,
} = {}) {
  preflightBriefBrollMedia(brief);
  const verifiedByKey = new Map();
  try {
    for (const scene of brief.scenes || []) {
      if (scene?.scene === 'broll' && scene.brollIntent && !scene.brollMedia && !scene.brollSrc) fail('BROLL_INTENT_UNRESOLVED');
      if (scene?.scene === 'broll' && scene.brollMedia) {
        const key = mediaVerificationKey(scene.brollMedia);
        let asset = verifiedByKey.get(key);
        if (!asset) {
          asset = verifyOpenedBrollAsset({
            root, workspace, media: scene.brollMedia, runToolImpl, fileSystem, platform,
          });
          verifiedByKey.set(key, asset);
        }
        const scan = asset.metadata?.textScan;
        if (asset.metadata?.version === 3) {
          if (brief.status === 'approved' && (brief.brollReviewPolicy !== 'preview-required'
            || !brief.brollApproval || !require('./brief').validateLessonBrief(brief, { requireApproved: true }).ok)) fail('BROLL_PREVIEW_REQUIRED');
          const acknowledgement = scene.brollReview;
          const matches = acknowledgement?.allowEmbeddedText === true
            && acknowledgement.assetSha256 === asset.metadata.canonicalSha256
            && acknowledgement.scanSha256 === hashTextScan(scan);
          if ((scan.status !== 'clear' && !matches) || (acknowledgement && !matches)) {
            fail('BROLL_TEXT_REVIEW_REQUIRED');
          }
        } else if (scene.brollReview) fail('BROLL_TEXT_REVIEW_REQUIRED');
        verifySceneBrollMedia({ scene, fps: brief.output?.fps, probe: asset.probe });
      }
    }
  } catch (error) {
    try {
      closeVerifiedAssets(fileSystem, [...verifiedByKey.values()]);
    } catch (closeError) {
      error.closeError = closeError;
    }
    throw error;
  }
  return verificationHandle(fileSystem, [...verifiedByKey.values()]);
}

module.exports = {
  verifySceneBrollMedia,
  preflightBriefBrollMedia,
  resolvePersistedBrollMedia,
  verifyBriefBrollMedia,
  verifyPersistedBrollMedia,
};
