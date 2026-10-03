const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const { makeRoughCutSourceProject } = require('./helpers/rough-cut-project');
const { filterScriptCommand } = require('../scripts/trim-media');
const { buildRoughCut, confirmRoughCut } = require('../scripts/project/rough-cut');
const {
  formatRoughCutConfirmed,
  formatRoughCutSummary,
  main,
  parseRoughCutOptions,
} = require('../scripts/project/rough-cut-cli');
const { readProjectManifest } = require('../scripts/project/workspace');

const COPY_BYTES = 'ROUGH-CUT-COPY';
const REMUX_BYTES = 'ROUGH-CUT-REMUX';
const COPY_MISMATCH = 'черновая нарезка: размер, длительность или FPS копии не совпадают со списком кусков';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Вывод команд собирается через deps, а не в консоль теста: строка в stdout процесса теста
// ломает канал раннера Node 20 (см. tests/layer-new.test.js).
// copyMedia – ответы probeMediaPath по стадиям копии по очереди (последний повторяется);
// по умолчанию копия без флага поворота с размером из copy.
function fakes({
  source = { duration: 8, fps: 25, width: 1080, height: 1920 },
  copy = { duration: 6, fps: 25, width: 720, height: 1280 },
  sourceMedia = { width: 1080, height: 1920, rotation: 0 },
  copyMedia = { width: copy.width, height: copy.height, rotation: 0 },
} = {}) {
  const calls = { trim: [], tool: [], media: [], slots: 0, log: [] };
  const stageMedia = [].concat(copyMedia);
  const deps = {
    runTrimImpl(options) {
      calls.trim.push(options);
      fs.writeFileSync(options.output, COPY_BYTES);
    },
    runToolImpl(command, args, options) {
      calls.tool.push({ command, args, stage: options.stage });
      // Перепаковка без перекодирования пишет новый файл последним аргументом.
      if (args.includes('copy')) fs.writeFileSync(args[args.length - 1], REMUX_BYTES);
    },
    probeVideoImpl(filename) {
      return path.basename(filename).startsWith('.roughcut-') ? copy : source;
    },
    probeMediaPathImpl(filename, options = {}) {
      if (!path.basename(filename).startsWith('.roughcut-')) return sourceMedia;
      calls.media.push({ file: filename, stage: options.stage });
      return stageMedia.length > 1 ? stageMedia.shift() : stageMedia[0];
    },
    acquireSlotSync() {
      calls.slots += 1;
      return { release() {} };
    },
    now: () => new Date('2026-10-03T09:00:00.000Z'),
    temporaryId: () => 'rough-test',
    log: (line) => calls.log.push(String(line)),
  };
  return { calls, deps };
}

function manifestBytes(projectDir) {
  return fs.readFileSync(path.join(projectDir, 'project.json'));
}

function freshWorkspace(projectDir) {
  return { dir: projectDir, manifest: readProjectManifest(projectDir) };
}

function previewEntries(projectDir) {
  return fs.readdirSync(path.join(projectDir, 'previews')).sort();
}

test('proxy encoder swaps only the encoding arguments and keeps the output last', () => {
  const inputs = ['/tmp/in.mp4'];
  const proxy = filterScriptCommand(inputs, '/tmp/out.mp4', '/tmp/f.txt', { encoder: 'proxy' }).args;
  const at = proxy.indexOf('-c:v');
  assert.deepEqual(proxy.slice(at), [
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', path.resolve('/tmp/out.mp4'),
  ]);
  const master = filterScriptCommand(inputs, '/tmp/out.mp4', '/tmp/f.txt').args;
  assert.deepEqual(master.slice(master.indexOf('-c:v')), [
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', path.resolve('/tmp/out.mp4'),
  ]);
  assert.deepEqual(filterScriptCommand(inputs, '/tmp/out.mp4', '/tmp/f.txt', { encoder: 'master' }).args, master);
  assert.throws(
    () => filterScriptCommand(inputs, '/tmp/out.mp4', '/tmp/f.txt', { encoder: 'x' }),
    /неизвестный режим кодирования/,
  );
});

test('runTrim passes the proxy encoder through to ffmpeg', () => {
  const { runTrim } = require('../scripts/trim-media');
  let args = null;
  runTrim({ input: 'in.mp4', output: 'out.mp4', intervals: [[0, 1]], encoder: 'proxy' }, {
    fileSystem: { writeFileSync() {}, existsSync: () => false },
    run(command, commandArgs) { args = commandArgs; },
    filterScriptOption: '-/filter_complex',
  });
  assert.deepEqual(args.slice(args.indexOf('-preset'), args.indexOf('-preset') + 6),
    ['-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p']);
});

test('rough cut builds a 720p copy from the active source and records it without a new revision', (t) => {
  const fixture = makeRoughCutSourceProject(t);
  const editPath = fixture.writeEdit('roughcut-v01.json');
  const editBytes = fs.readFileSync(path.join(fixture.projectDir, editPath));
  const { calls, deps } = fakes();

  const result = buildRoughCut({ projectDir: fixture.projectDir, editPath }, deps);

  assert.deepEqual(result, {
    editPath: 'edit/roughcut-v01.json',
    filePath: 'previews/roughcut-v01.mp4',
    duration: 6,
    removedSec: 2,
    cuts: 1,
    width: 720,
    height: 1280,
    fps: 25,
  });
  assert.equal(calls.trim.length, 1);
  const trim = calls.trim[0];
  assert.equal(trim.input, path.join(fixture.projectDir, 'input', 'source.mp4'));
  assert.equal(trim.encoder, 'proxy');
  assert.equal(trim.audioFadeSec, 0.04);
  assert.equal(trim.precision, 6);
  assert.deepEqual(trim.intervals, [[0, 2], [4, 8]]);
  assert.deepEqual(trim.scale, { width: 720, height: 1280 });
  assert.equal(path.dirname(trim.output), path.join(fixture.projectDir, 'previews'));
  assert.match(path.basename(trim.output), /^\.roughcut-v01-rough-test\.tmp\.mp4$/);
  const decode = calls.tool.find(({ stage }) => stage === 'roughcut decode');
  assert.deepEqual(decode && decode.args, ['-v', 'error', '-i', trim.output, '-f', 'null', '-']);
  // Копия без флага поворота: размер показа проверен по самой стадии, перепаковки нет.
  assert.deepEqual(calls.tool.map(({ stage }) => stage), ['roughcut decode']);
  assert.deepEqual(calls.media.map(({ file }) => file), [trim.output]);

  assert.equal(fs.readFileSync(path.join(fixture.projectDir, 'previews', 'roughcut-v01.mp4'), 'utf8'), COPY_BYTES);
  assert.deepEqual(previewEntries(fixture.projectDir), ['roughcut-v01.mp4']);
  const manifest = readProjectManifest(fixture.projectDir);
  assert.deepEqual(manifest.roughCut, {
    editPath: 'edit/roughcut-v01.json',
    filePath: 'previews/roughcut-v01.mp4',
    sourceRevision: 1,
    sourceDuration: 8,
    editSha256: sha256(editBytes),
    sha256: sha256(COPY_BYTES),
    duration: 6,
    width: 720,
    height: 1280,
    fps: 25,
    createdAt: '2026-10-03T09:00:00.000Z',
    status: 'review',
  });
  assert.equal(manifest.source.revision ?? 1, 1);
  assert.equal(manifest.source.localPath, 'input/source.mp4');
  assert.equal(manifest.transcript.words, fixture.workspace.manifest.transcript.words);
  assert.equal(fs.existsSync(path.join(fixture.projectDir, 'input', 'source-v02.mp4')), false);
  assert.deepEqual(calls.log, []);
});

test('a sub-frame tail of the source is not counted as a cut', (t) => {
  const fixture = makeRoughCutSourceProject(t);
  const editPath = fixture.writeEdit('roughcut-v01.json');
  const { deps } = fakes({ source: { duration: 8.007, fps: 25, width: 1080, height: 1920 } });
  const result = buildRoughCut({ projectDir: fixture.projectDir, editPath }, deps);
  assert.equal(result.cuts, 1);
  assert.equal(result.removedSec, 2);
  assert.match(formatRoughCutSummary(result), /вырезано 2,0 с в 1 месте\./);
});

test('rough cut of a rotated phone recording is portrait and the copy size is checked', (t) => {
  const fixture = makeRoughCutSourceProject(t);
  const editPath = fixture.writeEdit('roughcut-v01.json');
  const before = manifestBytes(fixture.projectDir);
  const { calls, deps } = fakes({
    source: { duration: 8, fps: 25, width: 1920, height: 1080 },
    sourceMedia: { width: 1920, height: 1080, rotation: 90 },
    copy: { duration: 6, fps: 25, width: 1280, height: 720 },
  });

  assert.throws(
    () => buildRoughCut({ projectDir: fixture.projectDir, editPath }, deps),
    /размер/,
  );
  assert.deepEqual(calls.trim[0].scale, { width: 720, height: 1280 });
  assert.deepEqual(manifestBytes(fixture.projectDir), before);
  assert.deepEqual(previewEntries(fixture.projectDir), []);
});

// FFmpeg 7.1.1 поворачивает кадры, но оставляет копии флаг поворота 90° – плеер повернёт её ещё раз.
function rotatedPhoneFakes(copyMedia) {
  return fakes({
    source: { duration: 8, fps: 25, width: 1920, height: 1080 },
    sourceMedia: { width: 1920, height: 1080, rotation: 90 },
    copyMedia,
  });
}

test('a copy that old FFmpeg leaves with a rotation flag is remuxed upright without re-encoding', (t) => {
  const fixture = makeRoughCutSourceProject(t);
  const editPath = fixture.writeEdit('roughcut-v01.json');
  const { calls, deps } = rotatedPhoneFakes([
    { width: 720, height: 1280, rotation: 90 },
    { width: 720, height: 1280, rotation: 0 },
  ]);
  const firstStageAtDecode = [];
  const runToolImpl = deps.runToolImpl;
  deps.runToolImpl = (command, args, options) => {
    if (options.stage === 'roughcut decode') firstStageAtDecode.push(fs.existsSync(calls.trim[0].output));
    return runToolImpl(command, args, options);
  };

  const result = buildRoughCut({ projectDir: fixture.projectDir, editPath }, deps);

  assert.deepEqual({ width: result.width, height: result.height }, { width: 720, height: 1280 });
  const first = calls.trim[0].output;
  const remux = calls.tool.filter(({ args }) => args.includes('-display_rotation'));
  assert.equal(remux.length, 1);
  const second = remux[0].args[remux[0].args.length - 1];
  assert.equal(path.dirname(second), path.dirname(first));
  assert.notEqual(second, first);
  assert.match(path.basename(second), /^\.roughcut-v01-rough-test\.[a-z]+\.tmp\.mp4$/);
  assert.equal(remux[0].command, 'ffmpeg');
  assert.deepEqual(remux[0].args, [
    '-v', 'error', '-y', '-display_rotation', '0', '-i', first,
    '-map', '0', '-c', 'copy', '-movflags', '+faststart', second,
  ]);
  // Перепаковка один раз, затем проверка уже второй стадии; первая убрана до декодирования.
  assert.deepEqual(calls.tool.map(({ args }) => args), [
    remux[0].args,
    ['-v', 'error', '-i', second, '-f', 'null', '-'],
  ]);
  assert.deepEqual(firstStageAtDecode, [false]);
  assert.deepEqual(calls.media.map(({ file }) => file), [first, second]);

  assert.equal(fs.readFileSync(path.join(fixture.projectDir, 'previews', 'roughcut-v01.mp4'), 'utf8'), REMUX_BYTES);
  assert.deepEqual(previewEntries(fixture.projectDir), ['roughcut-v01.mp4']);
  const record = readProjectManifest(fixture.projectDir).roughCut;
  assert.equal(record.width, 720);
  assert.equal(record.height, 1280);
  assert.equal(record.sha256, sha256(REMUX_BYTES));
  assert.equal(record.status, 'review');
});

test('a copy that keeps its rotation flag after the remux is refused and every stage is removed', (t) => {
  const fixture = makeRoughCutSourceProject(t);
  const editPath = fixture.writeEdit('roughcut-v01.json');
  const before = manifestBytes(fixture.projectDir);
  const { calls, deps } = rotatedPhoneFakes({ width: 720, height: 1280, rotation: 90 });

  assert.throws(
    () => buildRoughCut({ projectDir: fixture.projectDir, editPath }, deps),
    { message: COPY_MISMATCH },
  );
  assert.equal(calls.tool.filter(({ args }) => args.includes('-display_rotation')).length, 1);
  assert.deepEqual(manifestBytes(fixture.projectDir), before);
  assert.deepEqual(previewEntries(fixture.projectDir), []);
});

test('a failed remux removes both stage files and leaves the passport untouched', (t) => {
  const fixture = makeRoughCutSourceProject(t);
  const editPath = fixture.writeEdit('roughcut-v01.json');
  const before = manifestBytes(fixture.projectDir);
  const { deps } = rotatedPhoneFakes({ width: 720, height: 1280, rotation: 90 });
  deps.runToolImpl = (command, args) => {
    if (args.includes('copy')) {
      fs.writeFileSync(args[args.length - 1], 'PARTIAL');
      throw new Error('remux failed');
    }
  };

  assert.throws(() => buildRoughCut({ projectDir: fixture.projectDir, editPath }, deps), /remux failed/);
  assert.deepEqual(manifestBytes(fixture.projectDir), before);
  assert.deepEqual(previewEntries(fixture.projectDir), []);
});

test('rough cut rejects a copy whose duration or FPS differs from the cut list', (t) => {
  for (const copy of [
    { duration: 5.5, fps: 25, width: 720, height: 1280 },
    { duration: 6, fps: 30, width: 720, height: 1280 },
  ]) {
    const fixture = makeRoughCutSourceProject(t);
    const editPath = fixture.writeEdit('roughcut-v01.json');
    const before = manifestBytes(fixture.projectDir);
    const { deps } = fakes({ copy });
    assert.throws(
      () => buildRoughCut({ projectDir: fixture.projectDir, editPath }, deps),
      /черновая нарезка: размер, длительность или FPS копии не совпадают со списком кусков/,
    );
    assert.deepEqual(manifestBytes(fixture.projectDir), before);
    assert.deepEqual(previewEntries(fixture.projectDir), []);
  }
});

test('rough cut takes the heavy slot before the project lease and releases it on encode failure', (t) => {
  const fixture = makeRoughCutSourceProject(t);
  const editPath = fixture.writeEdit('roughcut-v01.json');
  const before = manifestBytes(fixture.projectDir);
  const lockPath = path.join(fixture.projectDir, '.project-mutation.lock');
  const events = [];
  let held = false;
  const fileSystem = {
    ...fs,
    linkSync(source, filename) {
      if (path.basename(filename) === '.project-mutation.lock') {
        events.push('project lease');
        assert.equal(held, true);
      }
      return fs.linkSync(source, filename);
    },
  };
  const { deps } = fakes();
  assert.throws(() => buildRoughCut({ projectDir: fixture.projectDir, editPath }, {
    ...deps,
    fileSystem,
    acquireSlotSync({ label, log }) {
      assert.equal(label, 'roughcut project');
      assert.equal(log, deps.log);
      assert.equal(fs.existsSync(lockPath), false);
      events.push('slot');
      held = true;
      return {
        release() {
          assert.equal(fs.existsSync(lockPath), false);
          events.push('release');
          held = false;
        },
      };
    },
    runTrimImpl(options) {
      assert.equal(held, true);
      events.push('encode');
      fs.writeFileSync(options.output, 'PARTIAL');
      throw new Error('encode failed');
    },
  }), /encode failed/);
  assert.equal(held, false);
  assert.deepEqual(events, ['slot', 'project lease', 'encode', 'release']);
  assert.deepEqual(manifestBytes(fixture.projectDir), before);
  assert.deepEqual(previewEntries(fixture.projectDir), []);
});

test('rough cut refuses a bad name, a stale revision, an existing copy and a foreign FPS before the slot', (t) => {
  const cases = [
    ['source edit name', (fixture) => fixture.writeEdit('v02-source.json'), {}, /edit\/roughcut-vNN\.json/],
    ['revision', (fixture) => fixture.writeEdit('roughcut-v01.json', { sourceRevision: 2 }), {}, /source edit revision/],
    ['existing copy', (fixture) => {
      fs.writeFileSync(path.join(fixture.projectDir, 'previews', 'roughcut-v01.mp4'), 'OLD');
      return fixture.writeEdit('roughcut-v01.json');
    }, {}, /edit\/roughcut-v02\.json/],
    ['fps', (fixture) => fixture.writeEdit('roughcut-v01.json'), {
      source: { duration: 8, fps: 30, width: 1080, height: 1920 },
    }, /FPS/],
  ];
  for (const [label, prepare, options, pattern] of cases) {
    const fixture = makeRoughCutSourceProject(t);
    const editPath = prepare(fixture);
    const before = manifestBytes(fixture.projectDir);
    const { calls, deps } = fakes(options);
    assert.throws(() => buildRoughCut({ projectDir: fixture.projectDir, editPath }, deps), pattern, label);
    assert.equal(calls.slots, 0, label);
    assert.equal(calls.trim.length, 0, label);
    assert.deepEqual(manifestBytes(fixture.projectDir), before, label);
  }
});

test('rough cut accepts an absolute edit path inside the project', (t) => {
  const fixture = makeRoughCutSourceProject(t);
  fixture.writeEdit('roughcut-v01.json');
  const { deps } = fakes();
  const result = buildRoughCut({
    projectDir: fixture.projectDir,
    editPath: path.join(fixture.projectDir, 'edit', 'roughcut-v01.json'),
  }, deps);
  assert.equal(result.editPath, 'edit/roughcut-v01.json');
  assert.equal(result.filePath, 'previews/roughcut-v01.mp4');
  assert.equal(readProjectManifest(fixture.projectDir).roughCut.editPath, 'edit/roughcut-v01.json');
});

test('confirm marks the reviewed rough cut and refuses a missing or changed one', (t) => {
  const fixture = makeRoughCutSourceProject(t);
  const at = () => new Date('2026-10-03T09:05:00.000Z');
  assert.throws(
    () => confirmRoughCut(freshWorkspace(fixture.projectDir), { by: 'chat', now: at }),
    (error) => error.code === 'ROUGH_CUT_MISSING',
  );

  buildRoughCut({ projectDir: fixture.projectDir, editPath: fixture.writeEdit('roughcut-v01.json') }, fakes().deps);
  const reviewed = manifestBytes(fixture.projectDir);
  assert.throws(
    () => confirmRoughCut(freshWorkspace(fixture.projectDir), {
      by: 'pult', expectedSha256: 'f'.repeat(64), now: at,
    }),
    (error) => error.code === 'ROUGH_CUT_CHANGED',
  );
  assert.deepEqual(manifestBytes(fixture.projectDir), reviewed);

  const confirmed = confirmRoughCut(freshWorkspace(fixture.projectDir), { by: 'chat', now: at });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.confirmedBy, 'chat');
  assert.equal(confirmed.confirmedAt, '2026-10-03T09:05:00.000Z');
  assert.deepEqual(readProjectManifest(fixture.projectDir).roughCut, confirmed);
  assert.throws(
    () => confirmRoughCut(freshWorkspace(fixture.projectDir), { by: 'chat', now: at }),
    (error) => error.code === 'ROUGH_CUT_MISSING',
  );

  // Новая нарезка после подтверждения снова ждёт автора.
  const second = fixture.writeEdit('roughcut-v02.json', { keep: [{ start: 0, end: 2 }, { start: 3, end: 8 }] });
  buildRoughCut({ projectDir: fixture.projectDir, editPath: second }, fakes({
    copy: { duration: 7, fps: 25, width: 720, height: 1280 },
  }).deps);
  const again = readProjectManifest(fixture.projectDir).roughCut;
  assert.equal(again.editPath, 'edit/roughcut-v02.json');
  assert.equal(again.status, 'review');
  assert.equal('confirmedAt' in again, false);
  assert.equal('confirmedBy' in again, false);

  // Агент поправил список кусков уже после сборки копии.
  fs.appendFileSync(path.join(fixture.projectDir, second), ' ');
  const changedEdit = manifestBytes(fixture.projectDir);
  assert.throws(
    () => confirmRoughCut(freshWorkspace(fixture.projectDir), { by: 'pult', now: at }),
    (error) => error.code === 'ROUGH_CUT_CHANGED' && /список кусков/.test(error.message),
  );
  assert.deepEqual(manifestBytes(fixture.projectDir), changedEdit);

  // Подменены байты самой копии.
  const third = fixture.writeEdit('roughcut-v03.json');
  buildRoughCut({ projectDir: fixture.projectDir, editPath: third }, fakes().deps);
  fs.writeFileSync(path.join(fixture.projectDir, 'previews', 'roughcut-v03.mp4'), 'OTHER');
  assert.throws(
    () => confirmRoughCut(freshWorkspace(fixture.projectDir), { by: 'pult', now: at }),
    (error) => error.code === 'ROUGH_CUT_CHANGED',
  );
  assert.equal(readProjectManifest(fixture.projectDir).roughCut.status, 'review');
});

test('roughcut options: build needs --edit, confirm refuses it', () => {
  assert.deepEqual(parseRoughCutOptions(['--project-dir', 'p', '--edit', 'edit/roughcut-v01.json']), {
    command: 'build', projectDir: 'p', editPath: 'edit/roughcut-v01.json',
  });
  assert.deepEqual(parseRoughCutOptions(['confirm', '--project-dir', 'p']), {
    command: 'confirm', projectDir: 'p', editPath: null,
  });
  assert.throws(() => parseRoughCutOptions(['confirm', '--project-dir', 'p', '--edit', 'edit/roughcut-v01.json']));
  assert.throws(() => parseRoughCutOptions([]));
  assert.throws(() => parseRoughCutOptions(['--project-dir', 'p']));
  assert.throws(() => parseRoughCutOptions(['--project-dir', '--edit', 'edit/roughcut-v01.json']));
});

test('summary line names the duration, the removed seconds and the places in Russian', () => {
  const line = (cuts) => formatRoughCutSummary({
    filePath: 'previews/roughcut-v01.mp4', duration: 6, removedSec: 2, cuts,
  });
  assert.equal(line(1), '✅ черновая нарезка: previews/roughcut-v01.mp4 – 6,0 с, вырезано 2,0 с в 1 месте. Дальше: автор смотрит её в пульте (automontage pult).');
  assert.match(line(2), /в 2 местах\./);
  assert.match(line(5), /в 5 местах\./);
  assert.match(line(11), /в 11 местах\./);
  assert.match(line(21), /в 21 месте\./);
  assert.equal(
    formatRoughCutConfirmed('projects/demo', 'edit/roughcut-v01.json'),
    '✅ нарезка подтверждена по словам автора: edit/roughcut-v01.json. Дальше: automontage master --project-dir "projects/demo" --edit edit/roughcut-v01.json (правки автора к нарезке – в копию списка edit/vNN-source.json, секунды исходника – в automontage inbox)',
  );
});

test('roughcut confirm from the CLI is recorded as the author\'s words in chat', (t) => {
  const fixture = makeRoughCutSourceProject(t);
  const { calls, deps } = fakes();
  main(['--project-dir', fixture.projectDir, '--edit', fixture.writeEdit('roughcut-v01.json')], deps);
  assert.deepEqual(calls.log, [formatRoughCutSummary({
    filePath: 'previews/roughcut-v01.mp4', duration: 6, removedSec: 2, cuts: 1,
  })]);
  const out = [];
  main(['confirm', '--project-dir', fixture.projectDir], {
    log: (line) => out.push(String(line)),
    now: () => new Date('2026-10-03T09:05:00.000Z'),
  });
  assert.deepEqual(out, [formatRoughCutConfirmed(fixture.projectDir, 'edit/roughcut-v01.json')]);
  const record = readProjectManifest(fixture.projectDir).roughCut;
  assert.equal(record.status, 'confirmed');
  assert.equal(record.confirmedBy, 'chat');
  assert.equal(record.confirmedAt, '2026-10-03T09:05:00.000Z');
});
