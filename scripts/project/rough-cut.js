// Черновая нарезка: лёгкая 720p-копия прямо из активного исходника по списку кусков
// `edit/roughcut-vNN.json` (тот же граф фильтров, что у master) и запись `project.json.roughCut`.
// Новой ревизии исходника нарезка не создаёт – это делает только master после подтверждения.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const { acquireHeavySlotSync, heavyQueueConfig } = require('../heavy-queue');
const { displayDimensions, probeMediaPath, probeVideo } = require('../media-probe');
const { runTool } = require('../process');
const { hashFile } = require('../pult/files');
const { runTrim } = require('../trim-media');
const { orientedSampleAspectRatio, workingSize } = require('../working-quality');
const { validateSourceEdit } = require('./build-master');
const { activeRoughCut, removedRanges, roughCutPaths, roughCutSize } = require('./rough-cut-model');
const {
  fsyncFile,
  normalizeSourceMetadata,
  projectRelative,
  removeOwned,
  roundedTime,
  safeToken,
  statRegular,
} = require('./source-revision');
const { readProjectManifest, resolveProjectPath, withProjectMutation } = require('./workspace');

const COPY_MISMATCH = 'черновая нарезка: размер, длительность или FPS копии не совпадают со списком кусков';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function versionLabel(version) {
  return String(version).padStart(2, '0');
}

// ffmpeg упал до fsync: у стадии ещё нет identity, но имя содержит случайный токен этого
// вызова, поэтому частичный файл можно удалить по пути (как publishSourceRevision).
function removeStage(fileSystem, stage, identity) {
  if (identity) {
    removeOwned(fileSystem, stage, identity);
    return;
  }
  try {
    const stat = fileSystem.lstatSync(stage);
    if (!stat.isSymbolicLink() && stat.isFile()) fileSystem.unlinkSync(stage);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

function buildRoughCut({ projectDir, editPath }, deps = {}) {
  const fileSystem = deps.fileSystem || fs;
  const runTrimImpl = deps.runTrimImpl || runTrim;
  const runToolImpl = deps.runToolImpl || runTool;
  const probeVideoImpl = deps.probeVideoImpl || probeVideo;
  const probeMediaPathImpl = deps.probeMediaPathImpl || probeMediaPath;
  const acquireSlotSync = deps.acquireSlotSync || acquireHeavySlotSync;
  const now = deps.now || (() => new Date());
  const temporaryId = deps.temporaryId || randomUUID;
  const log = deps.log || console.log;
  if (!projectDir || !editPath) throw new Error('roughcut requires --project-dir and --edit');

  // 1. Имя, список кусков той же проверкой, что у master, и FPS исходника.
  const resolvedProjectDir = path.resolve(projectDir);
  const manifest = readProjectManifest(resolvedProjectDir);
  const workspace = { dir: resolvedProjectDir, manifest };
  const editRelative = path.isAbsolute(editPath) ? projectRelative(workspace.dir, editPath) : editPath;
  const { filePath, version } = roughCutPaths(editRelative);
  const editAbsolute = resolveProjectPath(workspace.dir, editRelative, {
    label: 'rough cut edit path', fileSystem, mustExist: true, type: 'file',
  });
  const editBytes = fileSystem.readFileSync(editAbsolute);
  const editSha256 = sha256(editBytes);
  const source = normalizeSourceMetadata(manifest.source);
  const sourcePath = resolveProjectPath(workspace.dir, source.localPath, {
    label: 'active source path', fileSystem, mustExist: true, type: 'file',
  });
  const sourceProbe = probeVideoImpl(sourcePath, { stage: 'roughcut source probe' });
  const edit = validateSourceEdit(JSON.parse(editBytes.toString('utf8')), {
    sourceRevision: source.revision,
    sourceDuration: sourceProbe.duration,
  });
  if (Math.abs(sourceProbe.fps - edit.fps) > 1e-6) {
    throw new Error('source edit FPS does not match the active source');
  }

  // 2. Копия с этим номером уже есть – правки идут в следующий список.
  const destination = resolveProjectPath(workspace.dir, filePath, {
    label: 'rough cut video path', fileSystem, mustExist: false, type: 'file',
  });
  if (fileSystem.existsSync(destination)) {
    throw new Error(`черновая нарезка ${filePath} уже есть: создайте edit/roughcut-v${versionLabel(version + 1)}.json`);
  }

  // Размер показа – как у master (поворот и пиксели), затем короткая сторона 720.
  const sourceMedia = probeMediaPathImpl(sourcePath, {
    stage: 'roughcut source media probe',
    containerDurationFallback: true,
  });
  const size = roughCutSize(workingSize({
    ...displayDimensions(sourceMedia),
    sampleAspectRatio: orientedSampleAspectRatio(sourceMedia),
  }, '1080p'));
  const { fps } = edit;
  const duration = edit.keep.reduce((sum, range) => sum + range.end - range.start, 0);
  const sourceDuration = roundedTime(sourceProbe.duration, fps);
  const removed = removedRanges(edit.keep, sourceDuration, { fps });
  const removedSec = Number(removed.reduce((sum, range) => sum + range.removedSec, 0).toFixed(3));

  // 3. Слот очереди – до блокировки проекта: ожидание не держит проект (D-044).
  const slot = acquireSlotSync({
    label: `roughcut ${path.basename(resolvedProjectDir)}`, config: heavyQueueConfig(), log,
  });
  try {
    const record = publishRoughCut({
      workspace,
      source,
      sourcePath,
      editRelative,
      editAbsolute,
      editSha256,
      filePath,
      destination,
      version,
      intervals: edit.keep.map(({ start, end }) => [start, end]),
      size,
      fps,
      duration: roundedTime(duration, fps),
      sourceDuration,
    }, { fileSystem, runTrimImpl, runToolImpl, probeVideoImpl, probeMediaPathImpl, now, temporaryId });
    return {
      editPath: record.editPath,
      filePath: record.filePath,
      duration: record.duration,
      removedSec,
      cuts: removed.length,
      width: record.width,
      height: record.height,
      fps: record.fps,
    };
  } finally {
    slot.release();
  }
}

// 4–6. Под блокировкой проекта: кодирование во временный файл, полная проверка копии,
// публикация под итоговым именем и запись паспорта последней.
function publishRoughCut({
  workspace, source, sourcePath, editRelative, editAbsolute, editSha256, filePath, destination,
  version, intervals, size, fps, duration, sourceDuration,
}, { fileSystem, runTrimImpl, runToolImpl, probeVideoImpl, probeMediaPathImpl, now, temporaryId }) {
  const token = safeToken(temporaryId);
  const stagePath = (suffix) => resolveProjectPath(
    workspace.dir,
    `previews/.roughcut-v${versionLabel(version)}-${token}${suffix}.tmp.mp4`,
    { label: 'rough cut stage', fileSystem, mustExist: false, type: 'file' },
  );
  const stage = stagePath('');
  const uprightStage = stagePath('.upright');
  const probeStage = (file) => probeMediaPathImpl(file, {
    stage: 'roughcut output media probe',
    containerDurationFallback: true,
  });
  const assertEditUnchanged = () => {
    if (sha256(fileSystem.readFileSync(editAbsolute)) !== editSha256) {
      throw new Error(`черновая нарезка: список кусков ${editRelative} изменился во время сборки`);
    }
  };
  let stageIdentity = null;
  let uprightStarted = false;
  let uprightIdentity = null;
  let committedIdentity = null;
  let manifestCommitted = false;
  let caughtError = null;
  try {
    return withProjectMutation(workspace, (transaction) => {
      const active = normalizeSourceMetadata(transaction.manifest.source);
      if (active.revision !== source.revision || active.localPath !== source.localPath) {
        throw new Error('черновая нарезка: активный исходник сменился до публикации копии');
      }
      assertEditUnchanged();
      runTrimImpl({
        input: sourcePath,
        output: stage,
        intervals,
        scale: size,
        audioFadeSec: 0.04,
        precision: 6,
        encoder: 'proxy',
      });
      stageIdentity = fsyncFile(fileSystem, stage);
      // FFmpeg 7.1.0/7.1.1 поворачивает кадры телефонной записи, но оставляет копии флаг
      // поворота исходника – плеер повернул бы её ещё раз. Флаг снимает одна перепаковка
      // без перекодирования; moov остаётся перед mdat.
      let finalStage = stage;
      let media = probeStage(stage);
      if (media.rotation !== 0) {
        uprightStarted = true;
        runToolImpl('ffmpeg', [
          '-v', 'error', '-y', '-display_rotation', '0', '-i', stage,
          '-map', '0', '-c', 'copy', '-movflags', '+faststart', uprightStage,
        ], { stage: 'roughcut remux' });
        uprightIdentity = fsyncFile(fileSystem, uprightStage);
        removeStage(fileSystem, stage, stageIdentity);
        finalStage = uprightStage;
        media = probeStage(uprightStage);
      }
      runToolImpl('ffmpeg', ['-v', 'error', '-i', finalStage, '-f', 'null', '-'], { stage: 'roughcut decode' });
      const output = probeVideoImpl(finalStage, { stage: 'roughcut output probe' });
      const shown = displayDimensions(media);
      if (Math.abs(output.duration - duration) > Math.max(0.08, 1 / fps)
        || Math.abs(output.fps - fps) > 1e-6
        || output.width !== size.width || output.height !== size.height
        || media.rotation !== 0 || shown.width !== size.width || shown.height !== size.height) {
        throw new Error(COPY_MISMATCH);
      }
      const copySha256 = hashFile(finalStage);
      assertEditUnchanged();
      fileSystem.linkSync(finalStage, destination);
      committedIdentity = statRegular(fileSystem, destination);

      const createdAt = now().toISOString();
      const next = structuredClone(transaction.manifest);
      next.roughCut = {
        editPath: editRelative,
        filePath,
        sourceRevision: source.revision,
        sourceDuration,
        editSha256,
        sha256: copySha256,
        duration,
        width: size.width,
        height: size.height,
        fps,
        createdAt,
        status: 'review',
      };
      next.updatedAt = createdAt;
      workspace.manifest = transaction.commitManifest(next, { purpose: 'rough-cut-manifest' });
      manifestCommitted = true;
      return workspace.manifest.roughCut;
    }, { fileSystem, temporaryId });
  } catch (error) {
    caughtError = error;
    if (!manifestCommitted && committedIdentity) removeOwned(fileSystem, destination, committedIdentity);
    throw error;
  } finally {
    const stages = [[stage, stageIdentity]];
    if (uprightStarted) stages.push([uprightStage, uprightIdentity]);
    for (const [file, identity] of stages) {
      try {
        removeStage(fileSystem, file, identity);
      } catch (cleanupError) {
        // Ошибка сборки важнее уборки; после записи паспорта уборка стадии уже ничего не решает.
        if (caughtError && !caughtError.cleanupError) caughtError.cleanupError = cleanupError;
      }
    }
  }
}

// «Нарезка готова» – только по явному решению автора: кнопкой в пульте или его словами в чате.
// Подтверждается ровно та копия и тот список кусков, что записаны в паспорте.
function confirmRoughCut(workspace, {
  expectedSha256 = null,
  by,
  now = () => new Date(),
  fileSystem = fs,
  temporaryId = randomUUID,
} = {}) {
  if (by !== 'pult' && by !== 'chat') throw new Error('подтверждение нарезки: by – pult или chat');
  return withProjectMutation(workspace, (transaction) => {
    const record = activeRoughCut(transaction.manifest);
    if (!record || record.status !== 'review') {
      throw codedError('ROUGH_CUT_MISSING', 'нет черновой нарезки, которая ждёт автора');
    }
    if (expectedSha256 !== null && expectedSha256 !== record.sha256) {
      throw codedError('ROUGH_CUT_CHANGED', 'черновая нарезка сменилась – посмотрите новую');
    }
    const fileSha256 = (relative, label) => {
      const target = resolveProjectPath(workspace.dir, relative, {
        label, fileSystem, mustExist: false, type: 'file',
      });
      return fileSystem.existsSync(target) ? hashFile(target) : null;
    };
    if (fileSha256(record.filePath, 'manifest.roughCut.filePath') !== record.sha256) {
      throw codedError('ROUGH_CUT_CHANGED', `файл черновой нарезки ${record.filePath} не совпадает с паспортом: соберите нарезку заново`);
    }
    if (fileSha256(record.editPath, 'manifest.roughCut.editPath') !== record.editSha256) {
      throw codedError('ROUGH_CUT_CHANGED', `список кусков ${record.editPath} изменился после сборки нарезки: соберите новую нарезку`);
    }
    const confirmedAt = now().toISOString();
    const next = structuredClone(transaction.manifest);
    next.roughCut = { ...record, status: 'confirmed', confirmedAt, confirmedBy: by };
    next.updatedAt = confirmedAt;
    workspace.manifest = transaction.commitManifest(next, { purpose: 'rough-cut-confirm-manifest' });
    return workspace.manifest.roughCut;
  }, { fileSystem, temporaryId });
}

module.exports = { buildRoughCut, confirmRoughCut };
