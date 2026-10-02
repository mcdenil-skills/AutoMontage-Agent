const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runPreview } = require('../scripts/preview');
const { acquireHeavySlotSync, heavyQueueConfig, HEAVY_QUEUE_BUSY } = require('../scripts/heavy-queue');
const {
  planPreview,
  publishCurrentPreview,
} = require('../scripts/project/preview-workspace');
const {
  createOrOpenProject,
  publishBriefRevision,
  readProjectManifest,
} = require('../scripts/project/workspace');

const IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
];

function makeProject(t, { music = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-preview-test-'));
  const source = path.join(root, 'speaker.mp4');
  fs.writeFileSync(source, 'source-video');
  const workspace = createOrOpenProject({
    projectDir: path.join(root, 'project'),
    name: 'Preview test',
    sourcePath: source,
    now: new Date('2026-08-23T17:00:00.000Z'),
  });
  const brief = {
    version: 1,
    status: 'draft',
    source: workspace.sourcePath,
    theme: 'lesson-neutral',
    title: 'ПРЕДПРОСМОТР',
    output: {
      aspect: 'horizontal', width: 320, height: 180, fps: 25, durationInFrames: 100,
    },
    corrections: [],
    scenes: [{ scene: 'fullscreen', start: 0, end: 4, caption: 'СМОНТИРОВАНО' }],
  };
  if (music) {
    const musicPath = path.join(workspace.dir, 'assets', 'music', 'track.mp3');
    fs.writeFileSync(musicPath, 'music');
    brief.music = { file: musicPath, gainDb: -20, startSec: 2 };
  }
  const published = publishBriefRevision(workspace, {
    brief,
    markdown: '# Preview test\n',
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workspace, brief, published };
}

function idSequence() {
  let index = 0;
  return () => IDS[index++] || `preview-${index}`;
}

test('preview publication writes immutable revision, canonical current file, and manifest metadata', (t) => {
  const fixture = makeProject(t);
  const range = {
    kind: 'full', fromSec: 0, toSec: 4, fromFrame: 0, toFrameExclusive: 100,
  };
  const planned = planPreview(fixture.workspace, {
    briefPath: fixture.published.jsonPath,
    range,
    temporaryId: () => IDS[0],
  });
  const staged = path.join(fixture.workspace.dir, 'previews', 'finished.mp4');
  fs.writeFileSync(staged, 'rendered-preview');

  const result = publishCurrentPreview(fixture.workspace, planned, staged, {
    width: 160,
    height: 90,
    fps: 25,
    generatedAt: '2026-08-23T17:05:00.000Z',
  }, { temporaryId: idSequence() });
  const manifest = readProjectManifest(fixture.workspace.dir);

  assert.equal(fs.readFileSync(result.revisionPath, 'utf8'), 'rendered-preview');
  assert.equal(fs.readFileSync(result.currentPath, 'utf8'), 'rendered-preview');
  assert.deepEqual(manifest.currentPreview, {
    filePath: 'previews/v01-draft-full.mp4',
    briefPath: 'brief/v01-draft.lesson.json',
    kind: 'full',
    fromSec: 0,
    toSec: 4,
    width: 160,
    height: 90,
    fps: 25,
    generatedAt: '2026-08-23T17:05:00.000Z',
    sha256: '8df0992f9b4bd17ed44646e739f71e1212ebed6e21d068a9d31a50b4e6846b4e',
  });
  assert.equal(manifest.renders.length, 0);
  assert.equal(manifest.latestRender, null);
});

test('preview manifest staging failure restores the previous canonical preview byte-for-byte', (t) => {
  const fixture = makeProject(t);
  const current = path.join(fixture.workspace.dir, 'previews', 'current-preview.mp4');
  fs.writeFileSync(current, 'previous-preview');
  const beforeManifest = fs.readFileSync(path.join(fixture.workspace.dir, 'project.json'));
  const planned = planPreview(fixture.workspace, {
    briefPath: fixture.published.jsonPath,
    range: { kind: 'full', fromSec: 0, toSec: 4, fromFrame: 0, toFrameExclusive: 100 },
    temporaryId: () => IDS[0],
  });
  const staged = path.join(fixture.workspace.dir, 'previews', 'finished.mp4');
  fs.writeFileSync(staged, 'new-preview');
  const fileSystem = new Proxy(fs, {
    get(target, property) {
      if (property !== 'openSync') return Reflect.get(target, property);
      return (filename, ...args) => {
        if (typeof filename === 'string' && filename.includes('.tmp-preview-manifest-')) {
          const error = new Error('simulated preview manifest stage failure');
          error.code = 'EIO';
          throw error;
        }
        return target.openSync(filename, ...args);
      };
    },
  });

  assert.throws(() => publishCurrentPreview(fixture.workspace, planned, staged, {
    width: 160, height: 90, fps: 25, generatedAt: '2026-08-23T17:05:00.000Z',
  }, { fileSystem, temporaryId: idSequence() }), /simulated preview manifest/);
  assert.equal(fs.readFileSync(current, 'utf8'), 'previous-preview');
  assert.deepEqual(fs.readFileSync(path.join(fixture.workspace.dir, 'project.json')), beforeManifest);
});

function fakePreviewTools({ calls, failStage = null }) {
  return {
    resolveRemotionCommandImpl: () => ({ command: process.execPath, argsPrefix: ['remotion.js'] }),
    runToolImpl(command, args, options) {
      calls.push(options.stage);
      if (options.stage === 'preview Remotion') {
        if (failStage === 'render') throw new Error('render failed');
        fs.writeFileSync(args[4], 'raw-preview');
      }
      if (options.stage === 'preview decode' && failStage === 'decode') {
        throw new Error('decode failed');
      }
    },
    runNodeToolImpl(script, args, options) {
      calls.push(options.stage);
      if (options.stage === 'preview finish') {
        if (failStage === 'finish') throw new Error('finish failed');
        fs.writeFileSync(args[1], 'finished-preview');
      } else if (options.stage === 'preview music mix') {
        if (failStage === 'music') throw new Error('music failed');
        fs.writeFileSync(args[2], 'mixed-preview');
      }
    },
    probeVideoImpl: () => ({ width: 320, height: 180, fps: 25, duration: 4 }),
    openMediaFileImpl: () => { throw new Error('must not open with open=false'); },
    now: () => new Date('2026-08-23T17:05:00.000Z'),
    temporaryId: idSequence(),
    log: () => {},
  };
}

test('a busy heavy slot blocks preview without touching the current preview', (t) => {
  const fixture = makeProject(t);
  const current = path.join(fixture.workspace.dir, 'previews', 'current-preview.mp4');
  fs.writeFileSync(current, 'previous-preview');
  const before = fs.readFileSync(path.join(fixture.workspace.dir, 'project.json'));
  const config = { ...heavyQueueConfig(), waitMs: 0 };
  const slot = acquireHeavySlotSync({ label: 'layer render demo', config });
  t.after(() => slot.release());
  const calls = [];
  assert.throws(() => runPreview({ projectDir: fixture.workspace.dir,
    briefPath: fixture.published.relativePath, open: false }, {
    ...fakePreviewTools({ calls }),
    acquireSlotSync: (options) => acquireHeavySlotSync({ ...options, config }),
  }), { code: HEAVY_QUEUE_BUSY });
  assert.deepEqual(calls, []);
  assert.deepEqual(fs.readFileSync(path.join(fixture.workspace.dir, 'project.json')), before);
  assert.equal(fs.readFileSync(current, 'utf8'), 'previous-preview');
});

test('preview CLI reports the heavy queue barrier in stderr and exits with code 1', (t) => {
  const fixture = makeProject(t);
  const slot = acquireHeavySlotSync({ label: 'layer render demo', config: { ...heavyQueueConfig(), waitMs: 0 } });
  t.after(() => slot.release());
  const cli = require('node:child_process').spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'preview.js'), '--project-dir', fixture.workspace.dir,
    '--brief', fixture.published.relativePath, '--no-open',
  ], { encoding: 'utf8', timeout: 10000, env: { ...process.env, AUTOMONTAGE_HEAVY_WAIT_MS: '0' } });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /preview не опубликован: машина занята: layer render demo/u);
});

for (const failStage of [null, 'decode']) {
  test(`preview holds its heavy slot through decode and releases after ${failStage || 'publication'}`, (t) => {
    const fixture = makeProject(t);
    let held = false;
    const tools = fakePreviewTools({ calls: [], failStage });
    const runToolImpl = tools.runToolImpl;
    const options = { projectDir: fixture.workspace.dir, briefPath: fixture.published.relativePath, open: false };
    const dependencies = { ...tools,
      acquireSlotSync({ label }) {
        assert.equal(label, `preview ${path.basename(fixture.workspace.dir)}`);
        held = true;
        return { release() { held = false; } };
      },
      runToolImpl(...args) { assert.equal(held, true); return runToolImpl(...args); },
      publishCurrentPreviewImpl(...args) { assert.equal(held, true); return publishCurrentPreview(...args); },
    };
    if (failStage) assert.throws(() => runPreview(options, dependencies), /decode failed/);
    else runPreview(options, dependencies);
    assert.equal(held, false);
  });
}

test('preview command runs the real composition stages in order without final history', (t) => {
  const fixture = makeProject(t, { music: true });
  const calls = [];

  const result = runPreview({
    projectDir: fixture.workspace.dir,
    briefPath: fixture.published.relativePath,
    open: false,
  }, fakePreviewTools({ calls }));
  const manifest = readProjectManifest(fixture.workspace.dir);

  assert.deepEqual(calls, [
    'preview Remotion', 'preview finish', 'preview music mix', 'preview decode',
  ]);
  assert.equal(fs.readFileSync(result.currentPath, 'utf8'), 'mixed-preview');
  assert.equal(result.metadata.kind, 'full');
  assert.equal(manifest.renders.length, 0);
  assert.equal(manifest.latestRender, null);
  assert.equal(fs.existsSync(path.join(fixture.workspace.dir, 'final', 'preview-test.mp4')), false);
});

test('blocking preview gates stop publication and keep the previous preview', (t) => {
  const fixture = makeProject(t, { music: true });
  const current = path.join(fixture.workspace.dir, 'previews', 'current-preview.mp4');
  fs.writeFileSync(current, 'previous-preview');
  const beforeManifest = fs.readFileSync(path.join(fixture.workspace.dir, 'project.json'));
  const calls = [];
  let seen = null;
  const blocked = { block: true, paths: { textPath: 'qa/preview-1.txt' },
    report: { kind: 'preview', summary: { status: 'fail', fail: 1, warn: 0 }, gates: [] } };
  const runPreviewGatesImpl = (input) => {
    seen = { ...input, finishedExists: fs.existsSync(input.finishedPath), musicExists: fs.existsSync(input.musicPath) };
    return blocked;
  };
  assert.throws(() => runPreview({ projectDir: fixture.workspace.dir, briefPath: fixture.published.relativePath, open: false },
    { ...fakePreviewTools({ calls }), runPreviewGatesImpl }),
  /preview не опубликован: проверки не пройдены \(qa\/preview-1\.txt\)/);
  assert.deepEqual(calls, ['preview Remotion', 'preview finish', 'preview music mix']);
  assert.equal(fs.readFileSync(current, 'utf8'), 'previous-preview');
  assert.deepEqual(fs.readFileSync(path.join(fixture.workspace.dir, 'project.json')), beforeManifest);
  assert.ok(!readProjectManifest(fixture.workspace.dir).currentPreview);
  // Гейты видели настоящие дорожки preview после микса, промежуточные файлы потом убрал finally.
  assert.equal(seen.projectDir, fixture.workspace.dir);
  assert.equal(seen.hasMusic, true);
  assert.equal(seen.finishedExists, true);
  assert.equal(seen.musicExists, true);
  assert.ok(seen.mixArgs.includes('--gain'));
  assert.deepEqual([seen.range.fromSec, seen.range.toSec], [0, 4]);
  assert.match(seen.sourceSha256, /^[a-f0-9]{64}$/u);
  assert.equal(seen.brief.title, 'ПРЕДПРОСМОТР');
  assert.equal(fs.existsSync(seen.finishedPath), false);
  // Входы отчёта: brief и исходник проекта с sha256, которые preview уже посчитал.
  const briefFile = path.join(fixture.workspace.dir, fixture.published.relativePath);
  assert.equal(seen.briefPath, briefFile);
  assert.equal(seen.briefSha256, require('node:crypto').createHash('sha256').update(fs.readFileSync(briefFile)).digest('hex'));
  assert.equal(path.relative(fixture.workspace.dir, seen.sourcePath).startsWith('..'), false);
  assert.ok(fs.statSync(seen.sourcePath).isFile());
});

test('an unwritten gate report stops a kit preview after printing the verdict; other previews publish', (t) => {
  const report = { kind: 'preview', summary: { status: 'pass', fail: 0, warn: 0 }, gates: [] };
  const unwritten = (enforced) => () => ({ report, block: false, enforced, paths: null, writeError: 'не удалось записать в qa/ (EEXIST)' });

  const kit = makeProject(t, { music: true });
  const current = path.join(kit.workspace.dir, 'previews', 'current-preview.mp4');
  fs.writeFileSync(current, 'previous-preview');
  const printed = [];
  assert.throws(() => runPreview({ projectDir: kit.workspace.dir, briefPath: kit.published.relativePath, open: false },
    { ...fakePreviewTools({ calls: [] }), log: (line) => printed.push(line), runPreviewGatesImpl: unwritten(true) }),
  /^Error: preview не опубликован: отчёт проверок не записан \(не удалось записать в qa\/ \(EEXIST\)\)$/u);
  assert.match(printed.join('\n'), /Проверки \(preview\): всё хорошо/u);
  assert.equal(fs.readFileSync(current, 'utf8'), 'previous-preview');

  const other = makeProject(t, { music: true });
  const notes = [];
  const result = runPreview({ projectDir: other.workspace.dir, briefPath: other.published.relativePath, open: false },
    { ...fakePreviewTools({ calls: [] }), log: (line) => notes.push(line), runPreviewGatesImpl: unwritten(false) });
  assert.equal(fs.readFileSync(result.currentPath, 'utf8'), 'mixed-preview');
  assert.match(notes.join('\n'), /отчёт проверок не записан: не удалось записать в qa\/ \(EEXIST\)/u);
});

test('the real gates publish a project without kit layers and record a reference-only report', (t) => {
  const fixture = makeProject(t, { music: true });
  const printed = [];
  const result = runPreview({ projectDir: fixture.workspace.dir, briefPath: fixture.published.relativePath, open: false },
    { ...fakePreviewTools({ calls: [] }), log: (line) => printed.push(line) });
  assert.equal(fs.readFileSync(result.currentPath, 'utf8'), 'mixed-preview');
  assert.match(printed.join('\n'), /G8 Голос и музыка/u);
  const reports = fs.readdirSync(path.join(fixture.workspace.dir, 'qa')).filter((name) => /^preview-.*\.json$/u.test(name));
  assert.equal(reports.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(fixture.workspace.dir, 'qa', reports[0]), 'utf8'));
  assert.deepEqual(saved.gates.map((g) => [g.id, g.status]), [['G8', 'skipped']]);
  assert.doesNotMatch(saved.gates[0].hint, /music\.gainDb|увеличьте|уменьшите/u);
});

test('render, finish, and music failures preserve the previous current preview byte-for-byte', async (t) => {
  for (const failStage of ['render', 'finish', 'music']) {
    await t.test(failStage, () => {
      const fixture = makeProject(t, { music: true });
      const current = path.join(fixture.workspace.dir, 'previews', 'current-preview.mp4');
      fs.writeFileSync(current, 'previous-preview');
      const beforeManifest = fs.readFileSync(path.join(fixture.workspace.dir, 'project.json'));

      assert.throws(() => runPreview({
        projectDir: fixture.workspace.dir,
        briefPath: fixture.published.relativePath,
        open: false,
      }, fakePreviewTools({ calls: [], failStage })), new RegExp(`${failStage} failed`));

      assert.equal(fs.readFileSync(current, 'utf8'), 'previous-preview');
      assert.deepEqual(
        fs.readFileSync(path.join(fixture.workspace.dir, 'project.json')),
        beforeManifest,
      );
    });
  }
});

test('runPreview binds the exact bytes parsed before preparation, not a later same-path draft', (t) => {
  const fixture = makeProject(t);
  const beforeManifest = fs.readFileSync(path.join(fixture.workspace.dir, 'project.json'));
  const { prepareLessonPreview } = require('../scripts/lesson/preview');
  assert.throws(() => runPreview({ projectDir: fixture.workspace.dir, briefPath: fixture.published.jsonPath, open: false }, {
    ...fakePreviewTools({ calls: [] }),
    prepareLessonPreviewImpl(options) {
      const prepared = prepareLessonPreview(options);
      fs.appendFileSync(fixture.published.jsonPath, ' ');
      return prepared;
    },
  }), /preview inputs changed/);
  assert.deepEqual(fs.readFileSync(path.join(fixture.workspace.dir, 'project.json')), beforeManifest);
  assert.equal(fs.existsSync(path.join(fixture.workspace.dir, 'previews/current-preview.mp4')), false);
});

for (const [width, height, scale, expectedWidth, expectedHeight] of [[2160, 3840, 0.5, 1080, 1920], [1080, 1920, 1, 1080, 1920], [2048, 1080, 0.9375, 1920, 1012], [1080, 2048, 0.9375, 1012, 1920]]) {
  test(`preview ${width}x${height} renders even H264 dimensions with scale ${scale}`, (t) => {
    const fixture = makeProject(t);
    const { prepareLessonPreview } = require('../scripts/lesson/preview');
    let renderArgs;
    const tools = fakePreviewTools({ calls: [] });
    const result = runPreview({ projectDir: fixture.workspace.dir, briefPath: fixture.published.jsonPath, open: false }, {
      ...tools,
      prepareLessonPreviewImpl(options) {
        const prepared = prepareLessonPreview(options);
        prepared.props.width = width; prepared.props.height = height;
        return prepared;
      },
      runToolImpl(command, args, options) {
        if (options.stage === 'preview Remotion') renderArgs = args;
        tools.runToolImpl(command, args, options);
      },
      probeVideoImpl: () => ({ width: expectedWidth, height: expectedHeight, fps: 25, duration: 4 }),
    });
    assert.ok(renderArgs.includes(`--scale=${scale}`), renderArgs.join(' '));
    assert.deepEqual([result.metadata.width, result.metadata.height], [expectedWidth, expectedHeight]);
  });
}
