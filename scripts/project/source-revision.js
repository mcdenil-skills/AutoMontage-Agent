const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { probeVideo } = require('../media-probe');
const { runTool } = require('../process');
const { resolveProjectPath, withProjectMutation } = require('./workspace');

const SAFE_TOKEN = /^[A-Za-z0-9_-]+$/;

function roundedTime(value, fps) {
  const precision = Math.max(3, Math.ceil(Math.log10(fps || 1)) + 2);
  return Number(value.toFixed(precision));
}

function remapTranscriptWords(words, keepRanges, fps) {
  if (!Array.isArray(words) || !Array.isArray(keepRanges) || !keepRanges.length) {
    throw new Error('transcript remap requires words and keep ranges');
  }
  const ranges = keepRanges.map(({ start, end }) => ({ start: Number(start), end: Number(end) }));
  const prefix = [];
  let kept = 0;
  for (const range of ranges) {
    prefix.push(kept);
    kept += range.end - range.start;
  }
  const mapped = [];
  for (const word of words) {
    const start = Number(word.s);
    const end = Number(word.e);
    const overlaps = ranges
      .map((range, index) => ({
        index,
        start: Math.max(start, range.start),
        end: Math.min(end, range.end),
      }))
      .filter((overlap) => overlap.end > overlap.start);
    if (!overlaps.length) continue;
    const first = overlaps[0];
    const last = overlaps.at(-1);
    const mappedStart = prefix[first.index] + first.start - ranges[first.index].start;
    const mappedEnd = prefix[last.index] + last.end - ranges[last.index].start;
    mapped.push({
      ...word,
      s: roundedTime(mappedStart, fps),
      e: roundedTime(mappedEnd, fps),
    });
  }
  return mapped.sort((left, right) => left.s - right.s || left.e - right.e);
}

function projectRelative(projectDir, target) {
  const relative = path.relative(projectDir, path.resolve(target));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw new Error('master path must stay inside the project workspace');
  }
  return relative.split(path.sep).join('/');
}

function safeToken(temporaryId) {
  const value = String(temporaryId());
  if (!SAFE_TOKEN.test(value)) throw new Error('master temporary id is unsafe');
  return value;
}

function statRegular(fileSystem, target) {
  const stat = fileSystem.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('master stage must be a regular file');
  return stat;
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function removeOwned(fileSystem, target, expected) {
  try {
    const current = fileSystem.lstatSync(target);
    if (!current.isSymbolicLink() && current.isFile() && sameIdentity(current, expected)) {
      fileSystem.unlinkSync(target);
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

function fsyncFile(fileSystem, target) {
  const descriptor = fileSystem.openSync(target, 'r+');
  try {
    const stat = fileSystem.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('master stage must be a regular file');
    fileSystem.fsyncSync(descriptor);
    return stat;
  } finally {
    fileSystem.closeSync(descriptor);
  }
}

function writeExclusiveStage(fileSystem, target, bytes) {
  const descriptor = fileSystem.openSync(target, 'wx', 0o600);
  try {
    fileSystem.writeFileSync(descriptor, bytes);
    fileSystem.fsyncSync(descriptor);
    return fileSystem.fstatSync(descriptor);
  } finally {
    fileSystem.closeSync(descriptor);
  }
}

function normalizeSourceMetadata(source) {
  return {
    ...source,
    originalLocalPath: source.originalLocalPath || source.localPath,
    revision: Number.isSafeInteger(source.revision) ? source.revision : 1,
    history: Array.isArray(source.history) ? source.history : [],
  };
}

function publishSourceRevision({
  workspace,
  source,
  editRelative,
  words,
  duration,
  fps,
  expected,
  encode,
}, {
  fileSystem = fs,
  runToolImpl = runTool,
  probeVideoImpl = probeVideo,
  now = () => new Date(),
  temporaryId = randomUUID,
} = {}) {
  const nextRevision = source.revision + 1;
  const suffix = `v${String(nextRevision).padStart(2, '0')}`;
  const sourceRelative = `input/source-${suffix}.mp4`;
  const transcriptRelative = `transcript/words-${suffix}.json`;
  const destination = resolveProjectPath(workspace.dir, sourceRelative, {
    label: 'master revision path', fileSystem, mustExist: false, type: 'file',
  });
  const transcriptDestination = resolveProjectPath(workspace.dir, transcriptRelative, {
    label: 'master transcript path', fileSystem, mustExist: false, type: 'file',
  });
  if (fileSystem.existsSync(destination) || fileSystem.existsSync(transcriptDestination)) {
    throw new Error('master revision already exists');
  }
  const transcriptBytes = Buffer.from(`${JSON.stringify([{
    start: 0,
    end: roundedTime(duration, fps),
    text: words.map((word) => word.w).join(' '),
    words,
  }], null, 2)}\n`);
  const token = safeToken(temporaryId);
  const sourceStage = resolveProjectPath(workspace.dir, `input/.source-${suffix}-${token}.tmp.mp4`, {
    label: 'master source stage', fileSystem, mustExist: false, type: 'file',
  });
  const transcriptStage = resolveProjectPath(
    workspace.dir,
    `transcript/.words-${suffix}-${token}.tmp.json`,
    { label: 'master transcript stage', fileSystem, mustExist: false, type: 'file' },
  );
  let sourceStageIdentity = null;
  let transcriptStageIdentity = null;
  let sourceCommittedIdentity = null;
  let transcriptCommittedIdentity = null;
  let manifestCommitted = false;
  let caughtError = null;
  try {
    return withProjectMutation(workspace, (transaction) => {
      const active = normalizeSourceMetadata(transaction.manifest.source);
      if (active.revision !== source.revision || active.localPath !== source.localPath) {
        throw new Error('source revision changed before master publication');
      }
      encode(sourceStage);
      sourceStageIdentity = fsyncFile(fileSystem, sourceStage);
      runToolImpl('ffmpeg', ['-v', 'error', '-i', sourceStage, '-f', 'null', '-'], {
        stage: 'master decode',
      });
      const outputProbe = probeVideoImpl(sourceStage, { stage: 'master output probe' });
      if (Math.abs(outputProbe.duration - duration) > Math.max(0.08, 1 / fps)
        || Math.abs(outputProbe.fps - fps) > 1e-6
        || outputProbe.width !== expected.width || outputProbe.height !== expected.height) {
        throw new Error('master output does not match the source edit');
      }
      transcriptStageIdentity = writeExclusiveStage(fileSystem, transcriptStage, transcriptBytes);
      fileSystem.linkSync(sourceStage, destination);
      sourceCommittedIdentity = statRegular(fileSystem, destination);
      fileSystem.linkSync(transcriptStage, transcriptDestination);
      transcriptCommittedIdentity = statRegular(fileSystem, transcriptDestination);

      const entry = {
        revision: nextRevision,
        localPath: sourceRelative,
        editPath: editRelative,
        transcriptPath: transcriptRelative,
      };
      const nextManifest = structuredClone(transaction.manifest);
      nextManifest.source = {
        ...active,
        localPath: sourceRelative,
        revision: nextRevision,
        history: [...active.history, entry],
      };
      nextManifest.transcript.words = transcriptRelative;
      nextManifest.currentPreview = null;
      nextManifest.updatedAt = now().toISOString();
      workspace.manifest = transaction.commitManifest(nextManifest, { purpose: 'master-manifest' });
      manifestCommitted = true;
      return {
        revision: nextRevision,
        sourcePath: destination,
        transcriptPath: transcriptDestination,
      };
    }, { fileSystem, temporaryId });
  } catch (error) {
    caughtError = error;
    if (!manifestCommitted) {
      if (transcriptCommittedIdentity) removeOwned(fileSystem, transcriptDestination, transcriptCommittedIdentity);
      if (sourceCommittedIdentity) removeOwned(fileSystem, destination, sourceCommittedIdentity);
    }
    throw error;
  } finally {
    if (manifestCommitted) {
      // The manifest commit point is already durable: neither stage cleanup may skip the other.
      try {
        if (transcriptStageIdentity) removeOwned(fileSystem, transcriptStage, transcriptStageIdentity);
      } catch (_) {
        // ignored
      }
      try {
        if (sourceStageIdentity) removeOwned(fileSystem, sourceStage, sourceStageIdentity);
      } catch (_) {
        // ignored
      }
    } else {
      if (transcriptStageIdentity) removeOwned(fileSystem, transcriptStage, transcriptStageIdentity);
      if (sourceStageIdentity) {
        removeOwned(fileSystem, sourceStage, sourceStageIdentity);
      } else {
        // encode() упал или fsync не подтвердил стадию до получения identity, но имя стадии
        // содержит случайный токен этого вызова: удалить обычный файл по одному пути безопасно,
        // если ffmpeg успел записать в него частичный (возможно, большой) результат перед падением.
        try {
          const stat = fileSystem.lstatSync(sourceStage);
          if (!stat.isSymbolicLink() && stat.isFile()) fileSystem.unlinkSync(sourceStage);
        } catch (cleanupError) {
          // Ошибка сборки master важнее ошибки уборки: не даём finally её заменить. Если это не
          // ENOENT, прикладываем к исходной ошибке для диагностики и не бросаем повторно.
          if (cleanupError && cleanupError.code !== 'ENOENT' && caughtError) {
            caughtError.cleanupError = cleanupError;
          }
        }
      }
    }
  }
}

module.exports = {
  fsyncFile,
  normalizeSourceMetadata,
  projectRelative,
  publishSourceRevision,
  remapTranscriptWords,
  removeOwned,
  roundedTime,
  safeToken,
  sameIdentity,
  statRegular,
  writeExclusiveStage,
};
