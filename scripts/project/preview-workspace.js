const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const {
  resolveProjectPath,
  withProjectMutation,
} = require('./workspace');

function projectRelative(workspace, target) {
  const relative = path.relative(workspace.dir, path.resolve(target));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw new Error('preview path must stay inside the project workspace');
  }
  return relative.split(path.sep).join('/');
}

function safeRangePart(value) {
  return Number(value).toFixed(3).replace(/0+$/, '').replace(/\.$/, '').replace('.', '_');
}

function safeTemporaryToken(temporaryId) {
  const token = String(temporaryId());
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('preview temporary id is unsafe');
  return token;
}

function planPreview(workspace, {
  briefPath,
  briefSha256,
  sourceSha256,
  manifestHash,
  range,
  temporaryId = randomUUID,
  fileSystem = fs,
} = {}) {
  if (!workspace?.manifest || !range || !['full', 'excerpt'].includes(range.kind)) {
    throw new Error('preview plan requires a project and explicit range');
  }
  const resolvedBrief = resolveProjectPath(workspace.dir, projectRelative(workspace, briefPath), {
    label: 'preview brief path', fileSystem, mustExist: true, type: 'file',
  });
  const relativeBrief = projectRelative(workspace, resolvedBrief);
  const entry = workspace.manifest.briefs.find((item) => item.jsonPath === relativeBrief);
  if (!entry || entry.status !== 'draft' || workspace.manifest.currentBrief !== relativeBrief) {
    throw new Error('preview requires the current persisted draft brief');
  }
  const suffix = range.kind === 'full'
    ? 'full'
    : `${safeRangePart(range.fromSec)}-${safeRangePart(range.toSec)}`;
  const base = `v${String(entry.revision).padStart(2, '0')}-draft-${suffix}`;
  let attempt = 1;
  let revisionPath;
  do {
    const name = attempt === 1 ? `${base}.mp4` : `${base}-${String(attempt).padStart(2, '0')}.mp4`;
    revisionPath = resolveProjectPath(workspace.dir, path.posix.join('previews', name), {
      label: 'preview revision path', fileSystem, mustExist: false, type: 'file',
    });
    attempt += 1;
  } while (fileSystem.existsSync(revisionPath));
  const currentPath = resolveProjectPath(workspace.dir, 'previews/current-preview.mp4', {
    label: 'current preview path', fileSystem, mustExist: false, type: 'file',
  });
  const token = safeTemporaryToken(temporaryId);
  const temporary = (name) => resolveProjectPath(
    workspace.dir,
    path.posix.join('previews', `.${base}-${token}-${name}`),
    { label: `preview ${name} path`, fileSystem, mustExist: false, type: 'file' },
  );
  return {
    briefSha256,
    manifestHash,
    sourceSha256: sourceSha256 || hashFile(fileSystem, resolveProjectPath(workspace.dir, workspace.manifest.source.localPath, { fileSystem, mustExist: true, type: 'file' })),
    briefPath: resolvedBrief,
    briefRelativePath: relativeBrief,
    range,
    revisionPath,
    currentPath,
    propsPath: temporary('props.json'),
    rawPath: temporary('raw.mp4'),
    finishedPath: temporary('finished.mp4'),
    mixedPath: temporary('mixed.mp4'),
  };
}

function hashFile(fileSystem, filename) {
  const before = fileSystem.lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('preview input must be regular');
  const descriptor = fileSystem.openSync(filename, fileSystem.constants.O_RDONLY | (fileSystem.constants.O_NOFOLLOW || 0));
  if (!sameIdentity(before, fileSystem.fstatSync(descriptor))) { fileSystem.closeSync(descriptor); throw new Error('preview input changed'); }
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let read;
    do {
      read = fileSystem.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read > 0) hash.update(buffer.subarray(0, read));
    } while (read > 0);
  } finally {
    fileSystem.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function copyFsync(fileSystem, source, destination, flags = 0) {
  fileSystem.copyFileSync(source, destination, flags);
  const descriptor = fileSystem.openSync(destination, 'r+');
  try {
    fileSystem.fsyncSync(descriptor);
    return fileSystem.fstatSync(descriptor);
  } finally {
    fileSystem.closeSync(descriptor);
  }
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function removeOwned(fileSystem, target, identity) {
  try {
    const current = fileSystem.lstatSync(target);
    if (!current.isSymbolicLink() && current.isFile() && sameIdentity(current, identity)) {
      fileSystem.unlinkSync(target);
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

function publishCurrentPreview(workspace, planned, stagedMp4, metadata, {
  fileSystem = fs,
  temporaryId = randomUUID,
} = {}) {
  const stagedRelative = projectRelative(workspace, stagedMp4);
  const staged = resolveProjectPath(workspace.dir, stagedRelative, {
    label: 'staged preview', fileSystem, mustExist: true, type: 'file',
  });
  const generatedAt = String(metadata?.generatedAt || '');
  if (!Number.isSafeInteger(metadata?.width) || metadata.width <= 0
    || !Number.isSafeInteger(metadata?.height) || metadata.height <= 0
    || !Number.isFinite(metadata?.fps) || metadata.fps <= 0 || !generatedAt) {
    throw new Error('preview metadata is invalid');
  }
  const sha256 = hashFile(fileSystem, staged);
  const currentTemp = `${planned.currentPath}.tmp-preview-${safeTemporaryToken(temporaryId)}`;
  const currentBackup = `${planned.currentPath}.previous-preview-${safeTemporaryToken(temporaryId)}`;
  let revisionIdentity = null;
  let currentTempIdentity = null;
  let currentIdentity = null;
  let currentBackupIdentity = null;
  return withProjectMutation(workspace, (transaction) => {
    if (transaction.manifest.currentBrief !== planned.briefRelativePath) {
      throw new Error('preview brief changed before publication');
    }
    const assertInputs = () => {
      if ((planned.manifestHash && createHash('sha256').update(JSON.stringify(transaction.manifest)).digest('hex') !== planned.manifestHash)
        || (planned.briefSha256 && hashFile(fileSystem, planned.briefPath) !== planned.briefSha256)
        || hashFile(fileSystem, resolveProjectPath(workspace.dir, transaction.manifest.source.localPath, { fileSystem, mustExist: true, type: 'file' })) !== planned.sourceSha256) throw new Error('preview inputs changed before publication');
    };
    assertInputs();
    try {
      revisionIdentity = copyFsync(
        fileSystem,
        staged,
        planned.revisionPath,
        fileSystem.constants.COPYFILE_EXCL,
      );
      currentTempIdentity = copyFsync(fileSystem, staged, currentTemp, fileSystem.constants.COPYFILE_EXCL);
      try {
        const previous = fileSystem.lstatSync(planned.currentPath);
        if (previous.isSymbolicLink() || !previous.isFile()) {
          throw new Error('current preview must be a regular file');
        }
        fileSystem.linkSync(planned.currentPath, currentBackup);
        currentBackupIdentity = fileSystem.lstatSync(currentBackup);
        if (!sameIdentity(previous, currentBackupIdentity)) {
          throw new Error('current preview changed before publication');
        }
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
      currentIdentity = currentTempIdentity;
      fileSystem.renameSync(currentTemp, planned.currentPath);
      currentTempIdentity = null;
      const currentPreview = {
        filePath: projectRelative(workspace, planned.revisionPath),
        briefPath: planned.briefRelativePath,
        kind: planned.range.kind,
        fromSec: planned.range.fromSec,
        toSec: planned.range.toSec,
        width: metadata.width,
        height: metadata.height,
        fps: metadata.fps,
        generatedAt,
        sha256,
        ...(planned.briefSha256 ? { briefSha256: planned.briefSha256, sourceSha256: planned.sourceSha256 } : {}),
      };
      const nextManifest = structuredClone(transaction.manifest);
      nextManifest.currentPreview = currentPreview;
      nextManifest.updatedAt = generatedAt;
      assertInputs();
      workspace.manifest = transaction.commitManifest(nextManifest, { purpose: 'preview-manifest', assertCurrent: assertInputs });
      if (currentBackupIdentity) {
        try {
          removeOwned(fileSystem, currentBackup, currentBackupIdentity);
          currentBackupIdentity = null;
        } catch (_) {
          // The manifest and canonical preview are committed. Keep an owned backup as evidence.
        }
      }
      return {
        revisionPath: planned.revisionPath,
        currentPath: planned.currentPath,
        metadata: currentPreview,
      };
    } catch (error) {
      if (currentTempIdentity) removeOwned(fileSystem, currentTemp, currentTempIdentity);
      if (currentIdentity) {
        if (currentBackupIdentity) {
          try {
            fileSystem.renameSync(currentBackup, planned.currentPath);
            currentBackupIdentity = null;
          } catch (rollbackError) {
            error.rollbackError = rollbackError;
          }
        } else {
          removeOwned(fileSystem, planned.currentPath, currentIdentity);
        }
      }
      if (currentBackupIdentity) removeOwned(fileSystem, currentBackup, currentBackupIdentity);
      if (revisionIdentity) removeOwned(fileSystem, planned.revisionPath, revisionIdentity);
      throw error;
    }
  }, { fileSystem, temporaryId });
}

// Keep file descriptors open across the approval transaction. Recheck names and bytes
// after staging, so replacing either preview copy cannot authorize unseen media.
function verifyApprovalPreview(workspace, draft, draftBytes, { fileSystem = fs, confirmPreviewViewed, expectedPreviewSha256 } = {}) {
  const preview = workspace.manifest.currentPreview;
  const draftSha256 = createHash('sha256').update(draftBytes).digest('hex');
  const output = draft.output;
  if (confirmPreviewViewed !== true || !preview || preview.kind !== 'full'
    || preview.briefPath !== workspace.manifest.currentBrief || preview.briefSha256 !== draftSha256
    || preview.fromSec !== 0 || preview.toSec !== output.durationInFrames / output.fps
    || preview.width !== Math.round(output.width / 2) || preview.height !== Math.round(output.height / 2)
    || preview.fps !== output.fps || !preview.sourceSha256
    || (expectedPreviewSha256 !== undefined && expectedPreviewSha256 !== preview.sha256)) {
    throw new Error('full current preview and explicit preview viewing confirmation required');
  }
  const opened = [];
  const close = () => { for (const item of opened.splice(0)) fileSystem.closeSync(item.fd); };
  try {
    for (const [relative, sha256] of [[preview.filePath, preview.sha256], ['previews/current-preview.mp4', preview.sha256], [workspace.manifest.source.localPath, preview.sourceSha256]]) {
      const filename = resolveProjectPath(workspace.dir, relative, { fileSystem, mustExist: true, type: 'file' });
      if (relative === workspace.manifest.source.localPath && path.resolve(draft.kind === 'motion-reel' ? workspace.dir : '.', draft.source) !== filename) throw new Error('preview source mismatch');
      const fd = fileSystem.openSync(filename, fileSystem.constants.O_RDONLY | (fileSystem.constants.O_NOFOLLOW || 0));
      opened.push({fd, filename, relative, sha256, identity:fileSystem.fstatSync(fd, { bigint: true })});
    }
    const assertIdentity = () => {
      for (const item of opened) {
        resolveProjectPath(workspace.dir, item.relative, { fileSystem, mustExist: true, type: 'file' });
        const stat = fileSystem.lstatSync(item.filename, { bigint: true });
        const descriptorStat = fileSystem.fstatSync(item.fd, { bigint: true });
        for (const current of [stat, descriptorStat]) {
          if (current.isSymbolicLink() || !current.isFile()
            || ['dev','ino','size','mtimeNs','ctimeNs','nlink'].some(key => current[key] !== item.identity[key])) throw new Error('preview identity changed');
        }
      }
    };
    const assertCurrent = () => {
      assertIdentity();
      for (const item of opened) {
        const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(65536); let offset = 0; let size;
        while ((size = fileSystem.readSync(item.fd, buffer, 0, buffer.length, offset)) > 0) { hash.update(buffer.subarray(0,size)); offset += size; }
        if (hash.digest('hex') !== item.sha256) throw new Error('preview bytes changed');
      }
      assertIdentity();
    };
    assertCurrent();
    return { assertCurrent, assertIdentity, close, receipt: { draftSha256, previewSha256:preview.sha256, ...(draft.kind === 'motion-reel' ? { sourceSha256: preview.sourceSha256 } : {}), confirmedAt:new Date().toISOString() } };
  } catch (error) { close(); throw error; }
}
module.exports = { planPreview, publishCurrentPreview, verifyApprovalPreview, hashFile };
