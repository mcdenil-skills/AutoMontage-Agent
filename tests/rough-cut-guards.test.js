// Охрана motion-слоя: пока черновая нарезка ждёт автора, `master` и `layer new` отказывают, а
// `layer new` отказывает и после подтверждения, но до сборки master по нарезке. Ночная сессия
// не должна строить слой на таймингах, которых автор ещё не видел.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { toolAvailable } = require('./helpers/media-fixtures');
const { makeLayerProject } = require('./helpers/layer-project');
const { makeRoughCutSourceProject } = require('./helpers/rough-cut-project');
const newLayer = require('../scripts/layer/new');
const { buildMaster } = require('../scripts/project/build-master');
const { captureToolResult } = require('../scripts/process');
const { buildRoughCut, confirmRoughCut } = require('../scripts/project/rough-cut');
const { activeRoughCut, assertRoughCutSettled } = require('../scripts/project/rough-cut-model');
const { readProjectManifest } = require('../scripts/project/workspace');
const { runTrim } = require('../scripts/trim-media');

const hasFfmpeg = toolAvailable('ffmpeg') && toolAvailable('ffprobe');
const CONFIRMED_AT = new Date('2026-10-03T09:05:00.000Z');

// Вывод команд собирается через deps, а не в консоль теста: строка в stdout процесса теста
// ломает канал раннера Node 20 (см. tests/layer-new.test.js).
function quiet() {
  const out = { log: [], warn: [] };
  return { out, deps: { log: (line) => out.log.push(String(line)), warn: (line) => out.warn.push(String(line)) } };
}

function useSfxDir(t, dir) {
  process.env.AUTOMONTAGE_SFX_DIR = dir;
  t.after(() => { delete process.env.AUTOMONTAGE_SFX_DIR; });
}

// Настоящее кодирование, но поток ffmpeg собирается, а не наследуется stderr теста.
const quietTrim = (options) => runTrim(options, {
  run: (command, args, runOptions) => captureToolResult(command, args, { ...runOptions, maxBuffer: 64 * 1024 * 1024 }),
});

const motionDirs = (projectDir) => fs.readdirSync(projectDir).filter((name) => name.startsWith('motion-')).sort();

const freshWorkspace = (projectDir) => ({ dir: projectDir, manifest: readProjectManifest(projectDir) });

const projectJson = (projectDir) => fs.readFileSync(path.join(projectDir, 'project.json'));

// Фейки ffmpeg и ffprobe для проекта-заглушки (исходник 1920×1080, 8 с, 25 fps).
function roughCutFakes() {
  return {
    runTrimImpl(options) { fs.writeFileSync(options.output, 'ROUGH-CUT-COPY'); },
    runToolImpl() {},
    probeVideoImpl: (filename) => (path.basename(filename).startsWith('.roughcut-')
      ? { duration: 6, fps: 25, width: 1280, height: 720 }
      : { duration: 8, fps: 25, width: 1920, height: 1080 }),
    probeMediaPathImpl: (filename) => (path.basename(filename).startsWith('.roughcut-')
      ? { width: 1280, height: 720, rotation: 0 }
      : { width: 1920, height: 1080, rotation: 0 }),
    acquireSlotSync: () => ({ release() {} }),
    now: () => new Date('2026-10-03T09:00:00.000Z'),
    temporaryId: () => 'rough-test',
    log() {},
  };
}

// Как в tests/source-edit.test.js; счётчики показывают, что отказ случился до слота и до кодирования.
function masterFakes() {
  const calls = { slots: 0, trims: 0 };
  return {
    calls,
    deps: {
      acquireSlotSync() { calls.slots += 1; return { release() {} }; },
      runTrimImpl(options) { calls.trims += 1; fs.writeFileSync(options.output, 'NEW-MASTER'); },
      runToolImpl() {},
      probeVideoImpl: (filename) => (filename.endsWith('source.mp4')
        ? { duration: 8, fps: 25, width: 1920, height: 1080 }
        : { duration: 6, fps: 25, width: 1920, height: 1080 }),
      probeMediaPathImpl: () => ({ width: 1920, height: 1080, rotation: 0 }),
      now: () => new Date('2026-10-03T09:10:00.000Z'),
      temporaryId: () => 'master-test',
      log() {},
    },
  };
}

// Проект-заглушка с готовой нарезкой, которая ждёт автора.
function stubProjectInReview(t) {
  const fixture = makeRoughCutSourceProject(t);
  const roughCutEdit = fixture.writeEdit('roughcut-v01.json');
  buildRoughCut({ projectDir: fixture.projectDir, editPath: roughCutEdit }, roughCutFakes());
  return { ...fixture, roughCutEdit };
}

// Настоящий проект с настоящей нарезкой «весь ролик одним куском»: ждёт автора или подтверждена.
function realProjectWithRoughCut(t, { confirm }) {
  const fixture = makeLayerProject(t);
  useSfxDir(t, fixture.sfxDir);
  fs.mkdirSync(path.join(fixture.projectDir, 'edit'), { recursive: true });
  fs.writeFileSync(path.join(fixture.projectDir, 'edit', 'roughcut-v01.json'), `${JSON.stringify({
    version: 1, sourceRevision: 1, fps: 25, keep: [{ start: 0, end: 6, note: 'весь ролик' }],
  }, null, 2)}\n`);
  buildRoughCut({ projectDir: fixture.projectDir, editPath: 'edit/roughcut-v01.json' }, { log() {}, runTrimImpl: quietTrim });
  if (confirm) confirmRoughCut(freshWorkspace(fixture.projectDir), { by: 'chat', now: () => CONFIRMED_AT });
  return fixture;
}

test('master refuses before the queue slot while the rough cut waits for the author', (t) => {
  const fixture = stubProjectInReview(t);
  const editPath = fixture.writeEdit('v02-source.json');
  const manifestBefore = projectJson(fixture.projectDir);
  const inputBefore = fs.readdirSync(path.join(fixture.projectDir, 'input'));
  const { calls, deps } = masterFakes();

  assert.throws(
    () => buildMaster({ projectDir: fixture.projectDir, editPath }, deps),
    (error) => {
      assert.equal(error.code, 'ROUGH_CUT_PENDING');
      assert.match(error.message, /ждёт автора/);
      assert.match(error.message, /previews\/roughcut-v01\.mp4/);
      return true;
    },
  );

  assert.deepEqual(calls, { slots: 0, trims: 0 });
  assert.deepEqual(projectJson(fixture.projectDir), manifestBefore);
  assert.deepEqual(fs.readdirSync(path.join(fixture.projectDir, 'input')), inputBefore);
});

test('master builds from the confirmed rough cut and ends the stage with a new source revision', (t) => {
  const fixture = stubProjectInReview(t);
  confirmRoughCut(freshWorkspace(fixture.projectDir), { by: 'chat', now: () => CONFIRMED_AT });
  assert.equal(activeRoughCut(readProjectManifest(fixture.projectDir)).status, 'confirmed');
  const { calls, deps } = masterFakes();

  const result = buildMaster({ projectDir: fixture.projectDir, editPath: fixture.roughCutEdit }, deps);

  assert.deepEqual(calls, { slots: 1, trims: 1 });
  assert.equal(result.revision, 2);
  const manifest = readProjectManifest(fixture.projectDir);
  assert.equal(manifest.source.revision, 2);
  assert.equal(manifest.roughCut.sourceRevision, 1);
  assert.equal(activeRoughCut(manifest), null);
});

test('layer new refuses while the rough cut waits for the author and creates no layer folder', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir } = realProjectWithRoughCut(t, { confirm: false });
  const entriesBefore = fs.readdirSync(projectDir).sort();
  const { deps } = quiet();

  await assert.rejects(newLayer.run({ 'project-dir': projectDir }, deps), (error) => {
    assert.equal(error.code, 'ROUGH_CUT_PENDING');
    assert.match(error.message, /ждёт автора/);
    return true;
  });

  assert.deepEqual(motionDirs(projectDir), []);
  assert.deepEqual(fs.readdirSync(projectDir).sort(), entriesBefore);
});

test('layer new after confirmation asks for the master built from the rough cut', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir } = realProjectWithRoughCut(t, { confirm: true });
  const { deps } = quiet();

  await assert.rejects(newLayer.run({ 'project-dir': projectDir }, deps), (error) => {
    assert.equal(error.code, 'ROUGH_CUT_PENDING');
    assert.match(error.message, /master по ней ещё не собран: automontage master --project-dir .* --edit edit\/roughcut-v01\.json/);
    return true;
  });

  assert.deepEqual(motionDirs(projectDir), []);
});

test('layer new builds the layer once the master of the confirmed rough cut exists', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir } = realProjectWithRoughCut(t, { confirm: true });
  const { deps } = quiet();

  buildMaster({ projectDir, editPath: 'edit/roughcut-v01.json' }, { log() {}, runTrimImpl: quietTrim });

  const manifest = readProjectManifest(projectDir);
  assert.equal(manifest.source.revision, 2);
  assert.equal(manifest.roughCut.sourceRevision, 1);
  assert.equal(activeRoughCut(manifest), null);
  assert.equal(await newLayer.run({ 'project-dir': projectDir }, deps), 0);
  assert.deepEqual(motionDirs(projectDir), ['motion-v01']);
  assert.ok(fs.existsSync(path.join(projectDir, 'motion-v01', 'layer.json')));
});

test('a project without a rough cut passes the guard for both actions', (t) => {
  const { projectDir } = makeRoughCutSourceProject(t);
  const manifest = readProjectManifest(projectDir);
  assert.equal('roughCut' in manifest, false);
  for (const action of ['master', 'layer new']) {
    assert.doesNotThrow(() => assertRoughCutSettled(manifest, action, { projectDir }));
  }
});
