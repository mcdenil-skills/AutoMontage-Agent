const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { openReadOnlyFlags } = require('../filesystem-capabilities');
const { probeOpenedAudio } = require('../media-probe');
const { runTool } = require('../process');
const { python } = require('../env');
const {
  createOrOpenProject,
  resolveProjectPath,
  writeFilesNoReplace,
} = require('../project/workspace');

function assertMotionWorkspace(workspace) {
  if (!workspace || workspace.manifest?.projectKind !== 'motion-reel'
    || workspace.manifest?.source?.mediaKind !== 'audio') {
    throw new Error('motion source requires a motion-reel project with audio media');
  }
}

function probeAudioPath(sourcePath, { probeOpenedAudioImpl = probeOpenedAudio } = {}) {
  const resolved = path.resolve(sourcePath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('motion narration must be a regular file, not a symbolic link');
  }
  const descriptor = fs.openSync(resolved, openReadOnlyFlags(fs));
  try {
    return probeOpenedAudioImpl({ fileDescriptor: descriptor, stage: 'motion narration probe' });
  } finally {
    fs.closeSync(descriptor);
  }
}

function createMotionProject({
  baseDir,
  name,
  projectDir,
  narrationPath,
  now = new Date(),
  probeOpenedAudioImpl = probeOpenedAudio,
}) {
  if (narrationPath) probeAudioPath(narrationPath, { probeOpenedAudioImpl });
  const workspace = createOrOpenProject({
    baseDir,
    name,
    projectDir,
    sourcePath: narrationPath,
    projectKind: 'motion-reel',
    mediaKind: 'audio',
    now,
  });
  assertMotionWorkspace(workspace);
  const probe = probeAudioPath(workspace.sourcePath, { probeOpenedAudioImpl });
  return { workspace, probe };
}

function validateCanonicalTranscript(value) {
  if (!Array.isArray(value)) throw new Error('motion transcription returned invalid words JSON');
  for (const segment of value) {
    if (!segment || !Number.isFinite(segment.start) || !Number.isFinite(segment.end)
      || segment.start < 0 || segment.end <= segment.start || typeof segment.text !== 'string'
      || !Array.isArray(segment.words)) {
      throw new Error('motion transcription returned invalid segment timing');
    }
    for (const word of segment.words) {
      if (!word || typeof word.w !== 'string' || !word.w.trim()
        || !Number.isFinite(word.s) || !Number.isFinite(word.e)
        || word.s < 0 || word.e <= word.s) {
        throw new Error('motion transcription returned invalid word timing');
      }
    }
  }
  return value;
}

function transcribeMotionNarration({
  root = path.resolve(__dirname, '../..'),
  workspace,
  model = 'large-v3-turbo',
  prompt = null,
  pythonCommand = null,
  runToolImpl = runTool,
  temporaryId = randomUUID,
}) {
  assertMotionWorkspace(workspace);
  const wordsPath = resolveProjectPath(workspace.dir, workspace.manifest.transcript.words, {
    label: 'manifest.transcript.words',
    mustExist: false,
    type: 'file',
  });
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-motion-words-'));
  const generatedPath = path.join(temporaryDirectory, 'words.json');
  try {
    const args = [
      path.join(path.resolve(root), 'scripts', 'transcribe.py'),
      workspace.sourcePath,
      generatedPath,
      model,
    ];
    if (prompt) args.push('--prompt', String(prompt));
    runToolImpl(pythonCommand || python(), args, {
      cwd: path.resolve(root),
      stage: 'motion transcription',
    });
    const generated = validateCanonicalTranscript(JSON.parse(fs.readFileSync(generatedPath, 'utf8')));
    writeFilesNoReplace([{
      destination: wordsPath,
      data: `${JSON.stringify(generated, null, 2)}\n`,
      purpose: 'motion-words',
    }], { temporaryId });
    return { wordsPath, transcript: generated };
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

module.exports = {
  assertMotionWorkspace,
  createMotionProject,
  probeAudioPath,
  transcribeMotionNarration,
};
