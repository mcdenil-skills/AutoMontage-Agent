const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  LESSON_DEFAULT_THEME,
  assertLessonOptions,
  buildGenBriefArgs,
  getLessonAction,
  prepareLessonRender,
} = require('../scripts/lesson/workflow');
const { prepareLessonPreview } = require('../scripts/lesson/preview');
const { createOrOpenProject } = require('../scripts/project/workspace');

const ROOT = path.resolve(__dirname, '..');

function runLessonBuildWithIntercept(t, args, {
  failRender = false,
  materializeFinish = false,
  materializePlan = false,
  failPlan = false,
  replacePlanJson = false,
  racePlanJsonRemoval = false,
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-lesson-intercept-'));
  const hook = path.join(directory, 'hook.js');
  const calls = path.join(directory, 'calls.jsonl');
  // build.js кладёт временный план в os.tmpdir(); держим его внутри directory,
  // чтобы надгробия защищённого удаления исчезали вместе с ней.
  const temporary = path.join(directory, 'tmp');
  fs.mkdirSync(temporary);
  fs.writeFileSync(hook, [
    "const childProcess = require('node:child_process');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const calls = process.env.AUTOMONTAGE_LESSON_CAPTURE;",
    `const materializeFinish = ${JSON.stringify(materializeFinish)};`,
    `const materializePlan = ${JSON.stringify(materializePlan)};`,
    `const failPlan = ${JSON.stringify(failPlan)};`,
    `const replacePlanJson = ${JSON.stringify(replacePlanJson)};`,
    `const racePlanJsonRemoval = ${JSON.stringify(racePlanJsonRemoval)};`,
    'let generatedPlanJson = null;',
    'let removalRaced = false;',
    'const nativeUnlinkSync = fs.unlinkSync.bind(fs);',
    'const nativeRenameSync = fs.renameSync.bind(fs);',
    'childProcess.spawnSync = (command, args) => {',
    "  fs.appendFileSync(calls, JSON.stringify({ command, args }) + '\\n');",
    "  if (args.length === 1 && args[0] === '--version') return { status: 0, stdout: 'Python 3.12.0', stderr: '' };",
    "  if (command === 'ffprobe') return { status: 0, stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 1080, height: 1920, r_frame_rate: '25/1' }], format: { duration: '20' } }) };",
    "  if (materializePlan && command === process.execPath && path.basename(args[0]) === 'gen-brief.js') {",
    "    const jsonPath = args[2];",
    '    generatedPlanJson = jsonPath;',
    "    const markdownPath = args[args.indexOf('--markdown') + 1];",
    "    fs.writeFileSync(jsonPath, JSON.stringify({ version: 1, status: 'draft', title: 'PLAN', theme: 'lesson-neutral', output: { aspect: 'vertical' } }) + '\\n');",
    "    fs.writeFileSync(markdownPath, '# PLAN\\n');",
    "    return { status: failPlan ? 1 : 0, stdout: '', stderr: failPlan ? 'gen failed' : '' };",
    '  }',
    "  if (process.env.AUTOMONTAGE_LESSON_FAIL_RENDER && args.includes('render')) return { status: 1, stdout: '', stderr: 'render failed' };",
    "  if (materializeFinish && command === process.execPath && path.basename(args[0]) === 'finish.js') {",
    "    fs.mkdirSync(path.dirname(args[2]), { recursive: true });",
    "    fs.writeFileSync(args[2], 'finished-lesson');",
    "    return { status: 0, stdout: '' };",
    '  }',
    "  return { status: 0, stdout: '' };",
    '};',
    'if (racePlanJsonRemoval) {',
    '  const swapRemovalTarget = (reportedTarget) => {',
    '    if (removalRaced) return;',
    '    removalRaced = true;',
    "    nativeRenameSync(generatedPlanJson, generatedPlanJson + '.owned-race');",
    "    fs.writeFileSync(generatedPlanJson, 'foreign-plan-at-removal');",
    "    fs.appendFileSync(calls, JSON.stringify({ raceTarget: reportedTarget }) + '\\n');",
    '  };',
    '  fs.unlinkSync = (target) => {',
    '    if (target === generatedPlanJson) swapRemovalTarget(target);',
    '    return nativeUnlinkSync(target);',
    '  };',
    '  fs.renameSync = (from, to) => {',
    '    if (from === generatedPlanJson) swapRemovalTarget(to);',
    '    return nativeRenameSync(from, to);',
    '  };',
    '}',
    "if (replacePlanJson) {",
    "  const workspace = require(path.join(process.cwd(), 'scripts/project/workspace'));",
    '  const publish = workspace.publishBriefRevision;',
    '  workspace.publishBriefRevision = (...publishArgs) => {',
    '    const result = publish(...publishArgs);',
    "    fs.renameSync(generatedPlanJson, generatedPlanJson + '.original');",
    "    fs.writeFileSync(generatedPlanJson, 'foreign replacement');",
    '    return result;',
    '  };',
    '}',
    '',
  ].join('\n'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/build.js'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      TMPDIR: temporary,
      TEMP: temporary,
      TMP: temporary,
      AUTOMONTAGE_LESSON_CAPTURE: calls,
      AUTOMONTAGE_LESSON_FAIL_RENDER: failRender ? '1' : '',
      ...(materializePlan ? { OPENAI_API_KEY: 'test-only-placeholder' } : {}),
      NODE_OPTIONS: `--require=${hook}`,
    },
  });
  const invocations = fs.existsSync(calls)
    ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
  return { result, invocations };
}

function makePlanProject(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-plan-project-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return createOrOpenProject({
    projectDir: path.join(parent, 'project'),
    name: 'Plan cleanup',
    sourcePath: path.join(ROOT, 'examples', 'demo-source.mp4'),
    now: new Date('2026-08-22T10:00:00.000Z'),
  });
}

function findRegularFileWithBytes(root, expected) {
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const nested = findRegularFileWithBytes(candidate, expected);
      if (nested) return nested;
    } else if (entry.isFile() && fs.readFileSync(candidate, 'utf8') === expected) {
      return candidate;
    }
  }
  return null;
}

test('lesson workflow exposes one public default theme', () => {
  assert.equal(LESSON_DEFAULT_THEME, 'lesson-neutral');
});

function makeBrief(status = 'approved') {
  return {
    version: 1,
    status,
    source: '/videos/source.mp4',
    theme: 'lesson-neutral',
    title: 'УРОК',
    output: {
      aspect: 'vertical',
      width: 1080,
      height: 1920,
      fps: 30,
      durationInFrames: 300,
    },
    corrections: [],
    scenes: [
      { scene: 'fullscreen', start: 0, end: 10, caption: 'ГЛАВНАЯ МЫСЛЬ' },
    ],
  };
}

test('lesson without a brief stops at planning', () => {
  assert.equal(getLessonAction({ isLesson: true, briefFile: null }), 'plan');
});

test('lesson with a brief enters approved render flow', () => {
  assert.equal(getLessonAction({ isLesson: true, briefFile: 'lesson.json' }), 'render');
  assert.equal(getLessonAction({ isLesson: false, briefFile: null }), null);
});

test('draft brief is rejected before Remotion', () => {
  assert.throws(
    () => prepareLessonRender({
      brief: makeBrief('draft'),
      theme: 'lesson-neutral',
      sourceVideo: '/videos/source.mp4',
    }),
    /не утверждён/,
  );
});

test('approved brief cannot be rendered against another source', () => {
  assert.throws(
    () => prepareLessonRender({
      brief: makeBrief(),
      theme: 'lesson-neutral',
      sourceVideo: '/videos/another.mp4',
    }),
    /другого исходника/,
  );
});

test('approved brief prepares ReelScenes with frozen geometry', () => {
  const brief = makeBrief();
  const prepared = prepareLessonRender({
    brief,
    theme: { colors: { bg: '#16120E' } },
    sourceVideo: '/videos/source.mp4',
  });

  assert.equal(prepared.composition, 'ReelScenes');
  assert.equal(prepared.props.width, 1080);
  assert.equal(prepared.props.height, 1920);
  assert.equal(prepared.props.fps, 30);
  assert.equal(prepared.props.durationInFrames, 300);
  assert.equal(prepared.props.audioSrc, 'source.mp4');
  assert.deepEqual(prepared.approvedMedia, {
    brief,
    sourcePath: '/videos/source.mp4',
    sourceAlias: 'source.mp4',
  });
});

test('draft preview prepares the same ReelScenes contract and frame-snapped range', () => {
  const draft = makeBrief('draft');
  draft.music = {
    file: '/videos/music/track.mp3',
    gainDb: -22,
    startSec: 0,
  };
  const approved = structuredClone(draft);
  approved.status = 'approved';
  const theme = { colors: { bg: '#16120E' } };

  const preview = prepareLessonPreview({
    brief: draft,
    theme,
    sourceVideo: '/videos/source.mp4',
    fromSec: 1.011,
    toSec: 4.019,
  });
  const final = prepareLessonRender({
    brief: approved,
    theme,
    sourceVideo: '/videos/source.mp4',
  });
  const { draftPreview, ...previewProps } = preview.props;

  assert.equal(preview.composition, 'ReelScenes');
  assert.equal(draftPreview, true);
  assert.deepEqual(previewProps, final.props);
  assert.equal(preview.music.sourcePath, final.music.sourcePath);
  assert.deepEqual(preview.music.mixArgs, [
    '--gain', '-22',
    '--start', '1',
    '--rate', '1',
    '--fade-in', '0',
    '--fade-out', '0',
    '--duration', '3.033333333333333',
    '--threshold', '0.0398',
    '--ratio', '8',
    '--attack', '5',
    '--release', '300',
  ]);
  assert.deepEqual(preview.range, {
    kind: 'excerpt',
    fromSec: 1,
    toSec: 4.033333333333333,
    fromFrame: 30,
    toFrameExclusive: 121,
  });
  assert.deepEqual(preview.previewMedia, {
    brief: draft,
    sourcePath: '/videos/source.mp4',
    sourceAlias: 'source.mp4',
  });
});

test('draft preview rejects approved, mismatched source, and incomplete or invalid ranges', () => {
  assert.throws(
    () => prepareLessonPreview({
      brief: makeBrief('approved'),
      theme: 'lesson-neutral',
      sourceVideo: '/videos/source.mp4',
    }),
    /draft/,
  );
  assert.throws(
    () => prepareLessonPreview({
      brief: makeBrief('draft'),
      theme: 'lesson-neutral',
      sourceVideo: '/videos/another.mp4',
    }),
    /другого исходника/,
  );
  for (const range of [
    { fromSec: 1 },
    { toSec: 2 },
    { fromSec: -1, toSec: 2 },
    { fromSec: 3, toSec: 2 },
    { fromSec: 0, toSec: 11 },
  ]) {
    assert.throws(
      () => prepareLessonPreview({
        brief: makeBrief('draft'),
        theme: 'lesson-neutral',
        sourceVideo: '/videos/source.mp4',
        ...range,
      }),
      /диапазон|границ|длительност/,
    );
  }
});

test('approved lesson keeps music out of Remotion and prepares post-render ducking', () => {
  const brief = makeBrief();
  brief.music = {
    file: '/videos/music/track.mp3',
    gainDb: -22,
    fadeInSec: 0.15,
    fadeOutSec: 0.8,
    startSec: 24,
    playbackRate: 1,
    ducking: {
      thresholdDb: -28,
      ratio: 8,
      attackMs: 5,
      releaseMs: 300,
    },
  };

  const prepared = prepareLessonRender({
    brief,
    theme: 'lesson-neutral',
    sourceVideo: '/videos/source.mp4',
  });

  assert.deepEqual(prepared.music, {
    sourcePath: '/videos/music/track.mp3',
    mixArgs: [
      '--gain', '-22',
      '--start', '24',
      '--rate', '1',
      '--fade-in', '0.15',
      '--fade-out', '0.8',
      '--duration', '10',
      '--threshold', '0.0398',
      '--ratio', '8',
      '--attack', '5',
      '--release', '300',
    ],
  });
  assert.equal(prepared.props.musicSrc, undefined);
});

test('frames override only shortens a local test render', () => {
  const prepared = prepareLessonRender({
    brief: makeBrief(),
    theme: 'lesson-neutral',
    sourceVideo: '/videos/source.mp4',
    framesOverride: 60,
  });

  assert.equal(prepared.props.durationInFrames, 60);
  assert.equal(prepared.props.width, 1080);
  assert.equal(prepared.props.height, 1920);
});

test('gen-brief arguments preserve paths and titles with spaces', () => {
  const args = buildGenBriefArgs({
    transcriptPath: 'src/data/transcript.json',
    briefPath: 'out/my lesson.json',
    markdownPath: 'out/my lesson.md',
    theme: 'lesson-neutral',
    title: 'МОЙ НОВЫЙ УРОК',
    geometry: { aspect: 'horizontal', width: 1920, height: 1080, fps: 25 },
    duration: 42.5,
    source: '/videos/source file.mp4',
    maxScenes: 9,
    availableBroll: ['broll/demo one.jpg'],
  });

  assert.deepEqual(args, [
    'src/data/transcript.json',
    'out/my lesson.json',
    '--markdown', 'out/my lesson.md',
    '--theme', 'lesson-neutral',
    '--title', 'МОЙ НОВЫЙ УРОК',
    '--aspect', 'horizontal',
    '--width', '1920',
    '--height', '1080',
    '--fps', '25',
    '--duration', '42.5',
    '--source', '/videos/source file.mp4',
    '--max', '9',
    '--available-broll', 'broll/demo one.jpg',
  ]);
});

test('gen-brief arguments freeze an optional speaker position', () => {
  const args = buildGenBriefArgs({
    transcriptPath: 'transcript.json',
    briefPath: 'brief.json',
    markdownPath: 'brief.md',
    theme: 'lesson-neutral',
    title: 'УРОК',
    geometry: { aspect: 'vertical', width: 1080, height: 1920, fps: 25 },
    duration: 10,
    source: '/videos/source.mp4',
    maxScenes: 7,
    facePos: { x: 0.25, y: 0.45 },
  });

  assert.deepEqual(args.slice(-4), ['--face-x', '0.25', '--face-y', '0.45']);
});

test('gen-brief arguments freeze an optional speaker zoom', () => {
  const args = buildGenBriefArgs({
    transcriptPath: 'transcript.json',
    briefPath: 'brief.json',
    markdownPath: 'brief.md',
    theme: 'lesson-neutral',
    title: 'УРОК',
    geometry: { aspect: 'vertical', width: 1080, height: 1920, fps: 25 },
    duration: 10,
    source: '/videos/source.mp4',
    maxScenes: 7,
    faceZoom: 1.08,
  });

  assert.deepEqual(args.slice(-2), ['--face-zoom', '1.08']);
});

test('project lesson planning removes its exact generated temporary pair after success and failure', async (t) => {
  for (const failPlan of [false, true]) {
    await t.test(failPlan ? 'failure' : 'success', (subtest) => {
      const workspace = makePlanProject(subtest);
      const { result, invocations } = runLessonBuildWithIntercept(subtest, [
        'examples/demo-source.mp4',
        '--template', 'lesson',
        '--no-transcribe',
        '--project-dir', workspace.dir,
      ], { materializePlan: true, failPlan });
      assert.equal(result.status, failPlan ? 1 : 0, result.stderr);
      const generated = invocations.find((entry) => (
        entry.command === process.execPath && path.basename(entry.args[0]) === 'gen-brief.js'
      ));
      assert.ok(generated);
      const jsonPath = generated.args[2];
      const markdownPath = generated.args[generated.args.indexOf('--markdown') + 1];
      assert.equal(fs.existsSync(jsonPath), false);
      assert.equal(fs.existsSync(markdownPath), false);
    });
  }
});

test('project lesson planning preserves a foreign replacement of its generated temp file and fails closed', (t) => {
  const workspace = makePlanProject(t);
  const { result, invocations } = runLessonBuildWithIntercept(t, [
    'examples/demo-source.mp4',
    '--template', 'lesson',
    '--no-transcribe',
    '--project-dir', workspace.dir,
  ], { materializePlan: true, replacePlanJson: true });
  assert.equal(result.status, 1);
  const generated = invocations.find((entry) => (
    entry.command === process.execPath && path.basename(entry.args[0]) === 'gen-brief.js'
  ));
  assert.ok(generated, result.stderr);
  const jsonPath = generated.args[2];
  const markdownPath = generated.args[generated.args.indexOf('--markdown') + 1];
  assert.ok(findRegularFileWithBytes(path.dirname(jsonPath), 'foreign replacement'));
  assert.equal(fs.existsSync(markdownPath), false);
});

test('project lesson cleanup preserves foreign bytes swapped at the final removal syscall', (t) => {
  const workspace = makePlanProject(t);
  const { result, invocations } = runLessonBuildWithIntercept(t, [
    'examples/demo-source.mp4',
    '--template', 'lesson',
    '--no-transcribe',
    '--project-dir', workspace.dir,
  ], { materializePlan: true, racePlanJsonRemoval: true });
  assert.equal(result.status, 1);
  const race = invocations.find((entry) => entry.raceTarget);
  assert.ok(race, result.stderr);
  assert.equal(fs.readFileSync(race.raceTarget, 'utf8'), 'foreign-plan-at-removal');
});

test('lesson rejects source-changing flags that invalidate approved timings', () => {
  assert.throws(
    () => assertLessonOptions({ isLesson: true, args: ['--tighten'] }),
    /до создания ТЗ/,
  );
  assert.throws(
    () => assertLessonOptions({ isLesson: true, args: ['--reframe'] }),
    /--aspect vertical/,
  );
  assert.doesNotThrow(() => assertLessonOptions({
    isLesson: true,
    args: ['--aspect', 'vertical'],
  }));
  assert.doesNotThrow(() => assertLessonOptions({
    isLesson: false,
    args: ['--tighten'],
  }));
});

test('approved lesson props use one temporary media bundle and remove it after render', (t) => {
  const id = `lease-lesson-${process.pid}-${Date.now()}`;
  const propsPath = path.join(ROOT, 'out', `${id}.lesson.props.json`);
  t.after(() => fs.rmSync(propsPath, { force: true }));

  const { result, invocations } = runLessonBuildWithIntercept(t, [
    'examples/demo-source.mp4',
    '--template', 'lesson',
    '--brief', 'examples/lesson-neutral-approved.json',
    '--frames', '25',
    '--id', id,
  ]);

  assert.equal(result.status, 0, result.stderr);
  const props = JSON.parse(fs.readFileSync(propsPath, 'utf8'));
  assert.match(props.faceSrc, /^\.automontage\/dynamic-[0-9a-f-]+\/media-1\.mp4$/);
  assert.equal(props.audioSrc, props.faceSrc);
  const render = invocations.find((entry) => entry.args.includes('ReelScenes'));
  assert.ok(render);
  const publicDirIndex = render.args.indexOf('--public-dir');
  assert.ok(publicDirIndex > 0);
  const publicDirectory = render.args[publicDirIndex + 1];
  assert.equal(path.isAbsolute(publicDirectory), true);
  assert.equal(publicDirectory.startsWith(`${ROOT}${path.sep}`), false);
  assert.equal(fs.existsSync(publicDirectory), false);
  assert.equal(JSON.stringify(props).includes(publicDirectory), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'public', props.faceSrc)), false);
});

test('approved lesson rebinds legacy scene faceSrc to the same temporary source lease', (t) => {
  const id = `lease-scene-${process.pid}-${Date.now()}`;
  const propsPath = path.join(ROOT, 'out', `${id}.lesson.props.json`);
  const briefPath = path.join(ROOT, 'out', `${id}.approved.lesson.json`);
  const brief = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'examples/lesson-neutral-approved.json'),
    'utf8',
  ));
  brief.scenes[0].faceSrc = 'source.mp4';
  fs.writeFileSync(briefPath, `${JSON.stringify(brief, null, 2)}\n`);
  t.after(() => {
    fs.rmSync(propsPath, { force: true });
    fs.rmSync(briefPath, { force: true });
  });

  const { result } = runLessonBuildWithIntercept(t, [
    'examples/demo-source.mp4',
    '--template', 'lesson',
    '--brief', briefPath,
    '--frames', '25',
    '--id', id,
  ]);

  assert.equal(result.status, 0, result.stderr);
  const props = JSON.parse(fs.readFileSync(propsPath, 'utf8'));
  assert.equal(props.scenes[0].faceSrc, props.faceSrc);
  assert.equal(props.audioSrc, props.faceSrc);
  assert.match(props.faceSrc, /^\.automontage\/dynamic-[0-9a-f-]+\/media-1\.mp4$/);
  assert.equal(fs.existsSync(path.join(ROOT, 'public', props.faceSrc)), false);
});

test('failed lesson render still removes its temporary public lease', (t) => {
  const id = `lease-lesson-failed-${process.pid}-${Date.now()}`;
  const propsPath = path.join(ROOT, 'out', `${id}.lesson.props.json`);
  t.after(() => fs.rmSync(propsPath, { force: true }));

  const { result } = runLessonBuildWithIntercept(t, [
    'examples/demo-source.mp4',
    '--template', 'lesson',
    '--brief', 'examples/lesson-neutral-approved.json',
    '--frames', '25',
    '--id', id,
  ], { failRender: true });

  assert.equal(result.status, 1);
  const props = JSON.parse(fs.readFileSync(propsPath, 'utf8'));
  assert.equal(fs.existsSync(path.join(ROOT, 'public', props.faceSrc)), false);
});

test('lesson export rejects a pre-existing final symlink without overwriting its target', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-lesson-export-'));
  const id = `lesson-export-${process.pid}-${Date.now()}`;
  const propsPath = path.join(ROOT, 'out', `${id}.lesson.props.json`);
  const builtPath = path.join(ROOT, 'out', `${id}.mp4`);
  const sentinel = path.join(fixture, 'outside.mp4');
  const destination = path.join(fixture, `${id}.mp4`);
  fs.writeFileSync(sentinel, 'outside-must-survive');
  fs.symlinkSync(sentinel, destination, 'file');
  t.after(() => {
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.rmSync(propsPath, { force: true });
    fs.rmSync(builtPath, { force: true });
  });

  const { result } = runLessonBuildWithIntercept(t, [
    'examples/demo-source.mp4',
    '--template', 'lesson',
    '--brief', 'examples/lesson-neutral-approved.json',
    '--frames', '25',
    '--id', id,
    '--outdir', fixture,
  ], { materializeFinish: true });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /symbolic link/i);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside-must-survive');
  assert.equal(fs.lstatSync(destination).isSymbolicLink(), true);
});
