const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { audioExtractionCommand } = require('../build-commands');
const { python } = require('../env');
const { displayDimensions, probeMediaPath, probeVideo } = require('../media-probe');
const { runTool } = require('../process');
const { collectWords } = require('../tighten');
const { removeOwned } = require('./source-revision');
const {
  copyProjectFileNoReplace,
  readProjectManifest,
  resolveProjectPath,
  withProjectMutation,
  writeFilesNoReplace,
} = require('./workspace');

const ROOT = path.resolve(__dirname, '..', '..');
const MAX_TAKES = 99;
const TAKE_EXTENSION = /^\.[a-z0-9]{1,8}$/;

function takeId(number) {
  return `take-${String(number).padStart(2, '0')}`;
}

function describeTake(id, { filePath, video, media }) {
  if (media.mediaKind !== 'video') throw new Error(`${id} must be a video file`);
  const display = displayDimensions(media);
  const durations = [media.videoDurationSec, media.audioDurationSec].filter(Number.isFinite);
  if (!durations.length) throw new Error(`${id} has no measurable duration`);
  return {
    id,
    filePath,
    fps: video.fps,
    width: display.width,
    height: display.height,
    hasAudio: media.hasAudio,
    audioSampleRate: media.audioSampleRate,
    audioChannels: media.audioChannels,
    // Кусок не может быть длиннее самого короткого потока, иначе звук и видео разъедутся.
    duration: Math.min(...durations),
  };
}

// FFmpeg падает на разном размере кадра и отсутствии звука, а разный FPS молча превращает
// результат в файл с переменной частотой кадров. Поэтому несовместимые дубли отклоняются.
function assertCompatibleTakes(takes) {
  if (!takes.length) throw new Error('at least one take is required');
  const [first] = takes;
  for (const take of takes) {
    if (!take.hasAudio || !take.audioSampleRate || !take.audioChannels) {
      throw new Error(`${take.id} has no usable audio stream`);
    }
    if (Math.abs(take.fps - first.fps) > 1e-6) {
      throw new Error(`${take.id} FPS ${take.fps} differs from ${first.id} FPS ${first.fps}`);
    }
    if (take.width !== first.width || take.height !== first.height) {
      throw new Error(`${take.id} frame size ${take.width}x${take.height} differs from `
        + `${first.id} frame size ${first.width}x${first.height}`);
    }
  }
}

function probeTake(id, filePath, { probeVideoImpl, probeMediaPathImpl }) {
  return describeTake(id, {
    filePath,
    video: probeVideoImpl(filePath, { stage: `${id} probe` }),
    media: probeMediaPathImpl(filePath, { stage: `${id} media probe` }),
  });
}

function transcribeTakeFile({ videoPath, model = 'large-v3-turbo', prompt = null }, {
  fileSystem = fs,
  runToolImpl = runTool,
  pythonCommand = null,
} = {}) {
  const directory = fileSystem.mkdtempSync(path.join(os.tmpdir(), 'automontage-take-words-'));
  try {
    const audioPath = path.join(directory, 'audio.wav');
    const wordsPath = path.join(directory, 'words.json');
    const extraction = audioExtractionCommand(videoPath, audioPath);
    runToolImpl(extraction.command, extraction.args, { stage: 'take audio extraction' });
    const args = [path.join(ROOT, 'scripts', 'transcribe.py'), audioPath, wordsPath, model];
    if (prompt) args.push('--prompt', String(prompt));
    runToolImpl(pythonCommand || python(), args, { cwd: ROOT, stage: 'take transcription' });
    const segments = JSON.parse(fileSystem.readFileSync(wordsPath, 'utf8'));
    collectWords(segments);
    return segments;
  } finally {
    fileSystem.rmSync(directory, { recursive: true, force: true });
  }
}

function ensureProjectDirectory(projectDir, relative, fileSystem) {
  const target = resolveProjectPath(projectDir, relative, {
    label: relative, fileSystem, mustExist: false, type: 'directory',
  });
  fileSystem.mkdirSync(target, { recursive: true });
  return resolveProjectPath(projectDir, relative, {
    label: relative, fileSystem, mustExist: true, type: 'directory',
  });
}

function planTakes(manifest, files, fileSystem = fs) {
  const existing = manifest.takes || [];
  const planned = [];
  if (!existing.length) {
    planned.push({
      id: takeId(1),
      originalPath: manifest.source.originalPath,
      localPath: manifest.source.originalLocalPath || manifest.source.localPath,
      copyFrom: null,
    });
  }
  let number = existing.length + planned.length;
  for (const file of files) {
    number += 1;
    if (number > MAX_TAKES) throw new Error(`a project supports at most ${MAX_TAKES} takes`);
    const originalPath = path.resolve(file);
    if (!fileSystem.existsSync(originalPath)) throw new Error(`take file not found: ${originalPath}`);
    const extension = path.extname(originalPath).toLowerCase() || '.mp4';
    if (!TAKE_EXTENSION.test(extension)) throw new Error(`unsupported take extension: ${extension}`);
    planned.push({
      id: takeId(number),
      originalPath,
      localPath: `input/takes/${takeId(number)}${extension}`,
      copyFrom: originalPath,
    });
  }
  return { existing, planned };
}

function addTakes({
  projectDir,
  files,
  model = 'large-v3-turbo',
  prompt = null,
}, dependencies = {}) {
  const fileSystem = dependencies.fileSystem || fs;
  const probes = {
    probeVideoImpl: dependencies.probeVideoImpl || probeVideo,
    probeMediaPathImpl: dependencies.probeMediaPathImpl || probeMediaPath,
  };
  const transcribeImpl = dependencies.transcribeImpl || transcribeTakeFile;
  const now = dependencies.now || (() => new Date());
  const temporaryId = dependencies.temporaryId || randomUUID;
  if (!projectDir) throw new Error('takes add requires --project-dir');
  if (!Array.isArray(files) || !files.length) throw new Error('takes add requires at least one --file');
  const dir = path.resolve(projectDir);
  const manifest = readProjectManifest(dir);
  if ((manifest.projectKind || 'video') !== 'video' || (manifest.source.mediaKind || 'video') !== 'video') {
    throw new Error('takes are supported only for video projects');
  }
  const { existing, planned } = planTakes(manifest, files, fileSystem);
  const referenceEntry = existing[0] || planned[0];
  const referencePath = resolveProjectPath(dir, referenceEntry.localPath, {
    label: `${referenceEntry.id} path`, fileSystem, mustExist: true, type: 'file',
  });
  const reference = probeTake(referenceEntry.id, referencePath, probes);
  const incoming = planned
    .filter((take) => take.copyFrom)
    .map((take) => probeTake(take.id, take.copyFrom, probes));
  assertCompatibleTakes([reference, ...incoming]);
  ensureProjectDirectory(dir, 'input/takes', fileSystem);
  ensureProjectDirectory(dir, 'transcript/takes', fileSystem);

  const workspace = { dir, manifest };
  const created = [];
  try {
    return withProjectMutation(workspace, (transaction) => {
      const current = transaction.manifest.takes || [];
      if (current.length !== existing.length) throw new Error('takes changed before registration');
      const entries = [];
      for (const take of planned) {
        if (take.copyFrom) {
          const copied = copyProjectFileNoReplace({
            projectDir: dir,
            sourcePath: take.copyFrom,
            storedPath: take.localPath,
            fileSystem,
            temporaryId,
          });
          created.push({ target: copied, identity: fileSystem.lstatSync(copied) });
        }
        const videoPath = resolveProjectPath(dir, take.localPath, {
          label: `${take.id} path`, fileSystem, mustExist: true, type: 'file',
        });
        const transcriptRelative = `transcript/takes/${take.id}.json`;
        const transcriptPath = resolveProjectPath(dir, transcriptRelative, {
          label: `${take.id} transcript path`, fileSystem, mustExist: false, type: 'file',
        });
        const segments = transcribeImpl({ videoPath, model, prompt });
        collectWords(segments);
        writeFilesNoReplace([{
          destination: transcriptPath,
          data: `${JSON.stringify(segments, null, 2)}\n`,
          purpose: 'take-words',
        }], { fileSystem, temporaryId });
        created.push({ target: transcriptPath, identity: fileSystem.lstatSync(transcriptPath) });
        entries.push({
          id: take.id,
          originalPath: take.originalPath,
          localPath: take.localPath,
          transcriptPath: transcriptRelative,
        });
      }
      const nextManifest = structuredClone(transaction.manifest);
      nextManifest.takes = [...current, ...entries];
      nextManifest.updatedAt = now().toISOString();
      workspace.manifest = transaction.commitManifest(nextManifest, { purpose: 'takes-manifest' });
      return { takes: entries };
    }, { fileSystem, temporaryId });
  } catch (error) {
    for (const item of [...created].reverse()) removeOwned(fileSystem, item.target, item.identity);
    throw error;
  }
}

module.exports = {
  MAX_TAKES,
  addTakes,
  assertCompatibleTakes,
  describeTake,
  planTakes,
  probeTake,
  takeId,
  transcribeTakeFile,
};
