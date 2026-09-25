#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Ajv = require('ajv');

const sourceEditSchema = require('../../schema/source-edit.schema.json');
const { configureMediaToolPath } = require('../env');
const { displayDimensions, probeMediaPath, probeVideo } = require('../media-probe');
const { runTool } = require('../process');
const { collectWords } = require('../tighten');
const { runSegmentsTrim, runTrim } = require('../trim-media');
const {
  normalizeSourceMetadata,
  projectRelative,
  publishSourceRevision,
  remapTranscriptWords,
  roundedTime,
} = require('./source-revision');
const { buildTakesMaster } = require('./build-takes-master');
const { isTakesEdit } = require('./takes-edit');
const { readProjectManifest, resolveProjectPath } = require('./workspace');

const validateSchema = new Ajv({ allErrors: true }).compile(sourceEditSchema);

function formatSchemaError(error) {
  const suffix = error.keyword === 'required' ? `.${error.params.missingProperty}` : '';
  return `source edit${error.instancePath || ''}${suffix}: ${error.message}`;
}

function isFrameBoundary(value, fps) {
  return Math.abs((value * fps) - Math.round(value * fps)) <= 1e-6;
}

function validateSourceEdit(edit, { sourceRevision, sourceDuration } = {}) {
  if (!validateSchema(edit)) {
    throw new Error((validateSchema.errors || []).map(formatSchemaError).join('\n'));
  }
  if (!Number.isSafeInteger(sourceRevision) || edit.sourceRevision !== sourceRevision) {
    throw new Error('source edit revision does not match the active source revision');
  }
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) {
    throw new Error('source duration is invalid');
  }
  let previousEnd = -1;
  for (const [index, range] of edit.keep.entries()) {
    if (range.end <= range.start) throw new Error(`keep[${index}] must have end > start`);
    if (range.start < previousEnd) throw new Error(`keep[${index}] overlaps the previous range`);
    if (range.end > sourceDuration + 1e-6) {
      throw new Error(`keep[${index}] exceeds source duration`);
    }
    if (!isFrameBoundary(range.start, edit.fps) || !isFrameBoundary(range.end, edit.fps)) {
      throw new Error(`keep[${index}] must use exact frame boundaries`);
    }
    previousEnd = range.end;
  }
  return structuredClone(edit);
}

function resolveRequestedEdit(workspace, requested, fileSystem) {
  const stored = path.isAbsolute(requested) ? projectRelative(workspace.dir, requested) : requested;
  return resolveProjectPath(workspace.dir, stored, {
    label: 'source edit path', fileSystem, mustExist: true, type: 'file',
  });
}

function buildMaster({ projectDir, editPath }, dependencies = {}) {
  const fileSystem = dependencies.fileSystem || fs;
  const runTrimImpl = dependencies.runTrimImpl || runTrim;
  const probeVideoImpl = dependencies.probeVideoImpl || probeVideo;
  const probeMediaPathImpl = dependencies.probeMediaPathImpl || probeMediaPath;
  const publishDependencies = {
    fileSystem,
    runToolImpl: dependencies.runToolImpl || runTool,
    probeVideoImpl,
    now: dependencies.now || (() => new Date()),
    temporaryId: dependencies.temporaryId || randomUUID,
  };
  const resolvedProjectDir = path.resolve(projectDir || '');
  if (!projectDir || !editPath) throw new Error('master requires --project-dir and --edit');
  const manifest = readProjectManifest(resolvedProjectDir);
  const workspace = { dir: resolvedProjectDir, manifest };
  const editAbsolute = resolveRequestedEdit(workspace, editPath, fileSystem);
  const edit = JSON.parse(fileSystem.readFileSync(editAbsolute, 'utf8'));
  const editRelative = projectRelative(workspace.dir, editAbsolute);
  const source = normalizeSourceMetadata(manifest.source);
  if (isTakesEdit(edit)) {
    return buildTakesMaster({ workspace, edit, editRelative, source }, {
      ...publishDependencies,
      probeMediaPathImpl,
      runSegmentsTrimImpl: dependencies.runSegmentsTrimImpl || runSegmentsTrim,
    });
  }
  const sourcePath = resolveProjectPath(workspace.dir, source.localPath, {
    label: 'active source path', fileSystem, mustExist: true, type: 'file',
  });
  const sourceProbe = probeVideoImpl(sourcePath, { stage: 'master source probe' });
  const normalizedEdit = validateSourceEdit(edit, {
    sourceRevision: source.revision,
    sourceDuration: sourceProbe.duration,
  });
  if (Math.abs(sourceProbe.fps - normalizedEdit.fps) > 1e-6) {
    throw new Error('source edit FPS does not match the active source');
  }
  const transcriptPath = resolveProjectPath(workspace.dir, manifest.transcript.words, {
    label: 'active transcript path', fileSystem, mustExist: true, type: 'file',
  });
  const words = collectWords(JSON.parse(fileSystem.readFileSync(transcriptPath, 'utf8')));
  const remapped = remapTranscriptWords(words, normalizedEdit.keep, normalizedEdit.fps);
  const duration = normalizedEdit.keep.reduce((sum, range) => sum + range.end - range.start, 0);
  // FFmpeg поворачивает кадр до фильтров, поэтому результат хранится в отображаемом размере.
  const sourceMedia = probeMediaPathImpl(sourcePath, {
    stage: 'master source media probe',
    containerDurationFallback: true,
  });
  const result = publishSourceRevision({
    workspace,
    source,
    editRelative,
    words: remapped,
    duration,
    fps: normalizedEdit.fps,
    expected: displayDimensions(sourceMedia),
    encode(output) {
      runTrimImpl({
        input: sourcePath,
        output,
        intervals: normalizedEdit.keep.map(({ start, end }) => [start, end]),
        audioFadeSec: 0.04,
        precision: 6,
      });
    },
  }, publishDependencies);
  return {
    ...result,
    kind: 'source',
    duration: roundedTime(duration, normalizedEdit.fps),
    removedDuration: roundedTime(sourceProbe.duration - duration, normalizedEdit.fps),
  };
}

function parseMasterOptions(argv) {
  const options = { projectDir: null, editPath: null };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    if (key === '--project-dir') options.projectDir = value;
    else if (key === '--edit') options.editPath = value;
    else throw new Error(`unknown master option: ${key}`);
  }
  if (!options.projectDir || !options.editPath) {
    throw new Error('master requires --project-dir and --edit');
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  try {
    configureMediaToolPath();
    const result = buildMaster(parseMasterOptions(argv));
    console.log(`✅ source revision: ${result.revision}`);
    console.log(`   duration: ${result.duration.toFixed(2)} sec`);
    if (result.kind === 'takes') {
      console.log(`   takes: ${result.takes.join(', ')}`);
      console.log(`   ranges: ${result.ranges.length}`);
    } else {
      console.log(`   removed: ${result.removedDuration.toFixed(2)} sec`);
    }
    console.log(`   transcript: ${result.transcriptPath}`);
  } catch (error) {
    console.error(`❌ master отменён: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  buildMaster,
  main,
  parseMasterOptions,
  remapTranscriptWords,
  validateSourceEdit,
};
