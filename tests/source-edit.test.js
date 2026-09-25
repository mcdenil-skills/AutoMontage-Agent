const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildMaster,
  remapTranscriptWords,
  validateSourceEdit,
} = require('../scripts/project/build-master');
const {
  createOrOpenProject,
  readProjectManifest,
  writeProjectManifest,
} = require('../scripts/project/workspace');

function validEdit(overrides = {}) {
  return {
    version: 1,
    sourceRevision: 1,
    fps: 25,
    keep: [
      { start: 0, end: 2, note: 'хук' },
      { start: 4, end: 8, note: 'объяснение' },
    ],
    ...overrides,
  };
}

function makeProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-source-edit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, 'camera.mp4');
  fs.writeFileSync(original, 'ORIGINAL-SOURCE');
  const workspace = createOrOpenProject({
    projectDir: path.join(root, 'project'),
    name: 'Source edit',
    sourcePath: original,
    now: new Date('2026-08-23T12:00:00.000Z'),
  });
  fs.writeFileSync(path.join(workspace.dir, 'transcript', 'words.json'), `${JSON.stringify([{
    start: 0,
    end: 8,
    text: 'один вырезать два три',
    words: [
      { w: 'один', s: 0.5, e: 0.9 },
      { w: 'вырезать', s: 2.5, e: 3.2 },
      { w: 'два', s: 4.2, e: 4.6 },
      { w: 'три', s: 7.5, e: 7.9 },
    ],
  }], null, 2)}\n`);
  fs.mkdirSync(path.join(workspace.dir, 'edit'), { recursive: true });
  const editPath = path.join(workspace.dir, 'edit', 'v02-source.json');
  fs.writeFileSync(editPath, `${JSON.stringify(validEdit(), null, 2)}\n`);
  return { root, original, workspace, editPath };
}

test('source edit accepts only ordered frame-aligned ranges for the active revision', () => {
  assert.deepEqual(validateSourceEdit(validEdit(), {
    sourceRevision: 1,
    sourceDuration: 8,
  }).keep, validEdit().keep);

  for (const [label, edit, options, pattern] of [
    ['overlap', validEdit({ keep: [{ start: 0, end: 3 }, { start: 2, end: 4 }] }), {}, /overlap|пересек/i],
    ['outside', validEdit({ keep: [{ start: 0, end: 9 }] }), {}, /duration|длитель/i],
    ['non-frame', validEdit({ keep: [{ start: 0, end: 1.01 }] }), {}, /frame|кадр/i],
    ['empty', validEdit({ keep: [] }), {}, /keep/i],
    ['revision', validEdit({ sourceRevision: 2 }), {}, /revision|ревизи/i],
    ['bad version', validEdit({ version: 2 }), {}, /version|схем/i],
  ]) {
    assert.throws(
      () => validateSourceEdit(edit, { sourceRevision: 1, sourceDuration: 8, ...options }),
      pattern,
      label,
    );
  }
});

test('transcript words outside cuts disappear and retained timestamps close the removed gaps', () => {
  const words = [
    { w: 'до', s: 0.5, e: 0.8 },
    { w: 'край', s: 1.96, e: 2.04 },
    { w: 'вырезать', s: 2.4, e: 3.2 },
    { w: 'через', s: 1.9, e: 4.1 },
    { w: 'после', s: 4.2, e: 4.6 },
  ];
  assert.deepEqual(remapTranscriptWords(words, [
    { start: 0, end: 2 },
    { start: 4, end: 6 },
  ], 25), [
    { w: 'до', s: 0.5, e: 0.8 },
    { w: 'через', s: 1.9, e: 2.1 },
    { w: 'край', s: 1.96, e: 2 },
    { w: 'после', s: 2.2, e: 2.6 },
  ]);
});

test('master publication preserves the original and selects immutable source and transcript revisions', (t) => {
  const fixture = makeProject(t);
  const draftPath = path.join(fixture.workspace.dir, 'brief', 'v01-draft.lesson.json');
  fs.writeFileSync(draftPath, '{"status":"draft","sentinel":"UNCHANGED"}\n');
  const nextManifest = structuredClone(fixture.workspace.manifest);
  nextManifest.briefs.push({
    revision: 1,
    jsonPath: 'brief/v01-draft.lesson.json',
    markdownPath: null,
    status: 'draft',
    theme: 'lesson-neutral',
    aspect: 'source',
  });
  nextManifest.currentBrief = 'brief/v01-draft.lesson.json';
  nextManifest.currentPreview = {
    filePath: 'previews/v01-draft-full.mp4',
    briefPath: 'brief/v01-draft.lesson.json',
    kind: 'full',
    fromSec: 0,
    toSec: 8,
    width: 960,
    height: 540,
    fps: 25,
    generatedAt: '2026-08-23T12:00:00.000Z',
    sha256: 'a'.repeat(64),
  };
  writeProjectManifest(fixture.workspace.dir, nextManifest, {
    expectedManifest: fixture.workspace.manifest,
  });

  const calls = [];
  const result = buildMaster({
    projectDir: fixture.workspace.dir,
    editPath: fixture.editPath,
  }, {
    runTrimImpl(options) {
      calls.push(['trim', options.intervals]);
      fs.writeFileSync(options.output, 'NEW-MASTER');
    },
    runToolImpl(command, args, options) {
      calls.push([options.stage, command, args]);
    },
    probeVideoImpl(filename) {
      return filename.endsWith('source.mp4')
        ? { duration: 8, fps: 25, width: 1920, height: 1080 }
        : { duration: 6, fps: 25, width: 1920, height: 1080 };
    },
    probeMediaPathImpl() {
      return { width: 1920, height: 1080, rotation: 0 };
    },
    now: () => new Date('2026-08-23T13:00:00.000Z'),
    temporaryId: () => 'master-test',
  });

  const manifest = readProjectManifest(fixture.workspace.dir);
  assert.equal(fs.readFileSync(fixture.original, 'utf8'), 'ORIGINAL-SOURCE');
  assert.equal(fs.readFileSync(path.join(fixture.workspace.dir, 'input', 'source.mp4'), 'utf8'), 'ORIGINAL-SOURCE');
  assert.equal(fs.readFileSync(path.join(fixture.workspace.dir, 'input', 'source-v02.mp4'), 'utf8'), 'NEW-MASTER');
  assert.equal(fs.readFileSync(draftPath, 'utf8'), '{"status":"draft","sentinel":"UNCHANGED"}\n');
  assert.equal(manifest.source.originalLocalPath, 'input/source.mp4');
  assert.equal(manifest.source.localPath, 'input/source-v02.mp4');
  assert.equal(manifest.source.revision, 2);
  assert.deepEqual(manifest.source.history, [{
    revision: 2,
    localPath: 'input/source-v02.mp4',
    editPath: 'edit/v02-source.json',
    transcriptPath: 'transcript/words-v02.json',
  }]);
  assert.equal(manifest.transcript.words, 'transcript/words-v02.json');
  assert.equal(manifest.currentPreview, null);
  assert.equal(manifest.currentBrief, 'brief/v01-draft.lesson.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(
    fixture.workspace.dir, 'transcript', 'words-v02.json',
  ), 'utf8'))[0].words, [
    { w: 'один', s: 0.5, e: 0.9 },
    { w: 'два', s: 2.2, e: 2.6 },
    { w: 'три', s: 5.5, e: 5.9 },
  ]);
  assert.equal(result.revision, 2);
  assert.equal(result.duration, 6);
  assert.equal(result.removedDuration, 2);
  assert.equal(result.transcriptPath, path.join(fixture.workspace.dir, 'transcript', 'words-v02.json'));
  assert.deepEqual(calls[0], ['trim', [[0, 2], [4, 8]]]);
  assert.equal(calls.some(([stage]) => stage === 'master decode'), true);
});

test('failed master encode leaves active source transcript preview and draft unchanged', (t) => {
  const fixture = makeProject(t);
  const before = fs.readFileSync(path.join(fixture.workspace.dir, 'project.json'));
  const transcriptBefore = fs.readFileSync(path.join(fixture.workspace.dir, 'transcript', 'words.json'));

  assert.throws(() => buildMaster({
    projectDir: fixture.workspace.dir,
    editPath: fixture.editPath,
  }, {
    runTrimImpl() { throw new Error('encode failed'); },
    probeVideoImpl() { return { duration: 8, fps: 25, width: 1920, height: 1080 }; },
    probeMediaPathImpl() {
      return { width: 1920, height: 1080, rotation: 0 };
    },
    temporaryId: () => 'failed-master',
  }), /encode failed/);

  assert.deepEqual(fs.readFileSync(path.join(fixture.workspace.dir, 'project.json')), before);
  assert.deepEqual(fs.readFileSync(path.join(fixture.workspace.dir, 'transcript', 'words.json')), transcriptBefore);
  assert.equal(fs.existsSync(path.join(fixture.workspace.dir, 'input', 'source-v02.mp4')), false);
  assert.equal(fs.existsSync(path.join(fixture.workspace.dir, 'transcript', 'words-v02.json')), false);
});

test('a partial master stage file left by a crashed encode is removed', (t) => {
  const fixture = makeProject(t);
  const before = fs.readFileSync(path.join(fixture.workspace.dir, 'project.json'));

  assert.throws(() => buildMaster({
    projectDir: fixture.workspace.dir,
    editPath: fixture.editPath,
  }, {
    runTrimImpl(options) {
      // Simulates ffmpeg writing output before crashing partway through the encode: the stage
      // file exists on disk, but encode() never returns, so fsyncFile() never runs either.
      fs.writeFileSync(options.output, 'PARTIAL');
      throw new Error('encode crashed');
    },
    probeVideoImpl() { return { duration: 8, fps: 25, width: 1920, height: 1080 }; },
    probeMediaPathImpl() {
      return { width: 1920, height: 1080, rotation: 0 };
    },
    temporaryId: () => 'partial-stage',
  }), /encode crashed/);

  assert.deepEqual(fs.readFileSync(path.join(fixture.workspace.dir, 'project.json')), before);
  const inputEntries = fs.readdirSync(path.join(fixture.workspace.dir, 'input'));
  assert.equal(inputEntries.some((name) => name.startsWith('.source-v')), false);
});

test('master keeps committed revision files when releasing the project lock fails', (t) => {
  const fixture = makeProject(t);
  const failingFileSystem = {
    ...fs,
    unlinkSync(target) {
      if (path.basename(target) === '.project-mutation.lock') {
        throw Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' });
      }
      return fs.unlinkSync(target);
    },
  };

  assert.throws(() => buildMaster({
    projectDir: fixture.workspace.dir,
    editPath: fixture.editPath,
  }, {
    fileSystem: failingFileSystem,
    runTrimImpl(options) {
      fs.writeFileSync(options.output, 'NEW-MASTER');
    },
    runToolImpl() {},
    probeVideoImpl(filename) {
      return filename.endsWith('source.mp4')
        ? { duration: 8, fps: 25, width: 1920, height: 1080 }
        : { duration: 6, fps: 25, width: 1920, height: 1080 };
    },
    probeMediaPathImpl() {
      return { width: 1920, height: 1080, rotation: 0 };
    },
    now: () => new Date('2026-08-23T13:00:00.000Z'),
    temporaryId: () => 'lock-release-fail',
  }), /EPERM/);

  const manifest = readProjectManifest(fixture.workspace.dir);
  assert.equal(manifest.source.localPath, 'input/source-v02.mp4');
  assert.equal(fs.existsSync(path.join(fixture.workspace.dir, 'input', 'source-v02.mp4')), true);
  assert.equal(fs.existsSync(path.join(fixture.workspace.dir, 'transcript', 'words-v02.json')), true);
});

test('master accepts an auto-rotated portrait source whose output is stored upright', (t) => {
  const fixture = makeProject(t);
  const probeMediaPathCalls = [];
  const result = buildMaster({
    projectDir: fixture.workspace.dir,
    editPath: fixture.editPath,
  }, {
    runTrimImpl(options) {
      fs.writeFileSync(options.output, 'ROTATED-MASTER');
    },
    runToolImpl() {},
    probeVideoImpl(filename) {
      return filename.endsWith('source.mp4')
        ? { duration: 8, fps: 25, width: 1920, height: 1080 }
        : { duration: 6, fps: 25, width: 1080, height: 1920 };
    },
    probeMediaPathImpl(filename, options) {
      probeMediaPathCalls.push({ filename, options });
      return { width: 1920, height: 1080, rotation: 90 };
    },
    now: () => new Date('2026-08-23T13:00:00.000Z'),
    temporaryId: () => 'rotated-master',
  });
  assert.equal(result.revision, 2);
  assert.equal(readProjectManifest(fixture.workspace.dir).source.localPath, 'input/source-v02.mp4');
  assert.equal(probeMediaPathCalls.length, 1);
  assert.equal(probeMediaPathCalls[0].filename, path.join(fixture.workspace.dir, 'input', 'source.mp4'));
  assert.equal(probeMediaPathCalls[0].options.stage, 'master source media probe');
  assert.equal(probeMediaPathCalls[0].options.containerDurationFallback, true);
});

test('master rejects an output stored in the encoded size of a rotated source', (t) => {
  const fixture = makeProject(t);
  assert.throws(() => buildMaster({
    projectDir: fixture.workspace.dir,
    editPath: fixture.editPath,
  }, {
    runTrimImpl(options) {
      fs.writeFileSync(options.output, 'UNROTATED-MASTER');
    },
    runToolImpl() {},
    probeVideoImpl(filename) {
      return filename.endsWith('source.mp4')
        ? { duration: 8, fps: 25, width: 1920, height: 1080 }
        : { duration: 6, fps: 25, width: 1920, height: 1080 };
    },
    probeMediaPathImpl() {
      return { width: 1920, height: 1080, rotation: 90 };
    },
    now: () => new Date('2026-08-23T13:00:00.000Z'),
    temporaryId: () => 'rotated-master-rejected',
  }), /master output does not match the source edit/);
  assert.equal(readProjectManifest(fixture.workspace.dir).source.localPath, 'input/source.mp4');
  assert.equal(fs.existsSync(path.join(fixture.workspace.dir, 'input', 'source-v02.mp4')), false);
});

test('master rejects a portrait output from an unrotated landscape source', (t) => {
  const fixture = makeProject(t);
  assert.throws(() => buildMaster({
    projectDir: fixture.workspace.dir,
    editPath: fixture.editPath,
  }, {
    runTrimImpl(options) {
      fs.writeFileSync(options.output, 'PORTRAIT-MASTER');
    },
    runToolImpl() {},
    probeVideoImpl(filename) {
      return filename.endsWith('source.mp4')
        ? { duration: 8, fps: 25, width: 1920, height: 1080 }
        : { duration: 6, fps: 25, width: 1080, height: 1920 };
    },
    probeMediaPathImpl() {
      return { width: 1920, height: 1080, rotation: 0 };
    },
    now: () => new Date('2026-08-23T13:00:00.000Z'),
    temporaryId: () => 'landscape-master-rejected',
  }), /master output does not match the source edit/);
  assert.equal(readProjectManifest(fixture.workspace.dir).source.localPath, 'input/source.mp4');
  assert.equal(fs.existsSync(path.join(fixture.workspace.dir, 'input', 'source-v02.mp4')), false);
});
