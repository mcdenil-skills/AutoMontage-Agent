const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { toolAvailable, runTool } = require('./helpers/media-fixtures');
const { makeLayerProject } = require('./helpers/layer-project');
const { sha256File, writeJson } = require('../scripts/layer/common');
const { hashBytes } = require('../scripts/pult/files');
const { buildReport, gate } = require('../scripts/qa/report');
const { inspectImportedAssetBundle } = require('../scripts/review/imported-assets');
const { mediaImportError } = require('../scripts/review/media-import');
const { runMediaProcess } = require('../scripts/review/media-process');
const {
  appendRegistry, findByCanonical, findByReference, findByRender, findRenderReport, readRegistry, renderPassed,
} = require('../scripts/layer/registry');
const layerImport = require('../scripts/layer/import');

const hasFfmpeg = toolAvailable('ffmpeg') && toolAvailable('ffprobe');
const pad = (n) => String(n).padStart(2, '0');
const quiet = { log: () => {} };
const canLink = (() => {
  if (process.platform !== 'win32') return true;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-link-'));
  try {
    fs.symlinkSync(dir, path.join(dir, 'link'), 'dir');
    return true;
  } catch {
    return false; // Windows без прав на ссылки
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

// Нормализованный слой без Remotion: короткий lavfi-ролик на месте motion-v01/renders/layer-NN.mp4.
function renderedLayer(projectDir, { n = 1, frequency = 900, fps = 25, channels = 2 } = {}) {
  const file = path.join(projectDir, 'motion-v01', 'renders', `layer-${pad(n)}.mp4`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=108x192:r=${fps}:d=2`,
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=2`, '-shortest',
    '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-colorspace', 'bt470bg', '-c:v', 'libx264', '-c:a', 'aac', '-ac', String(channels), file]);
  return file;
}

// Отчёт layer render той же формы, что пишет scripts/layer/render.js: гейты G6 и G7, слой первым (role
// 'layer'), затем исходник и манифест; с error гейтов нет. status – итог G6: 'pass' | 'warn' | 'fail'.
// edit – ручная правка готового отчёта (подделки для проверок согласованности).
function renderReport(projectDir, {
  n = 1, layerSha, sourceSha = 's'.repeat(64), status = 'pass', error = null, createdAt = '2026-09-28T10:00:00.000Z', edit = (report) => report,
}) {
  const gates = error ? [] : [gate('G6', 'Длина слоя', { status }), gate('G7', 'Голос в звуке слоя')];
  const inputs = [
    ...(layerSha ? [{ role: 'layer', path: `motion-v01/renders/layer-${pad(n)}.mp4`, sha256: layerSha }] : []),
    { role: 'source', path: 'input/source.mp4', sha256: sourceSha },
    { role: 'manifest', path: 'motion-v01/out/manifest.json', sha256: 'm'.repeat(64) },
  ];
  const report = buildReport({ kind: 'layer-render', layer: 'motion-v01', profile: 'avatar', gates, error, inputs, now: new Date(createdAt) });
  const file = path.join(projectDir, 'qa', `layer-motion-v01-render-${pad(n)}.json`);
  writeJson(file, edit(report));
  return file;
}

// Проект с отрендеренным слоем motion-v01/renders/layer-01.mp4. report(options) пишет его отчёт layer
// render для текущего исходника проекта; checked: false – без отчёта. run(file, deps) – layer import.
function layerProject(t, { checked = true, fps = 25, channels = 2 } = {}) {
  const project = makeLayerProject(t, { seconds: 2, fps });
  const sourcePath = path.join(project.projectDir, project.workspace.manifest.source.localPath);
  const file = renderedLayer(project.projectDir, { fps, channels });
  const report = (options = {}) => renderReport(project.projectDir, { layerSha: sha256File(file), sourceSha: sha256File(sourcePath), ...options });
  if (checked) report();
  const run = (target = file, deps = quiet) => layerImport.run({ 'project-dir': project.projectDir, file: target }, deps);
  return { ...project, sourcePath, file, report, run };
}

const registryPath = (projectDir) => path.join(projectDir, 'qa', 'layer-imports.json');
const videoAssets = (projectDir) => {
  const dir = path.join(projectDir, 'assets', 'broll', 'video');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => !name.startsWith('.')) : [];
};
const bundleOf = (projectDir, reference) => inspectImportedAssetBundle({ projectDir, assetDirectory: path.join(projectDir, path.posix.dirname(reference)) });
const nothingImported = (projectDir) => {
  assert.equal(fs.existsSync(registryPath(projectDir)), false);
  assert.deepEqual(videoAssets(projectDir), []);
};

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-registry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('import refuses a layer that never passed layer render, or failed it', { skip: !hasFfmpeg }, async (t) => {
  const p = layerProject(t, { checked: false });
  await assert.rejects(p.run(), /не проходил layer render/);
  p.report({ status: 'fail' });
  await assert.rejects(p.run(), /не прошёл проверки: qa\/layer-motion-v01-render-01\.json/);
  p.report({ error: 'ffmpeg упал' });
  await assert.rejects(p.run(), /не прошёл проверки: qa\/layer-motion-v01-render-01\.json.*ffmpeg упал/);
  nothingImported(p.projectDir);
});

test('a checked layer is imported through the official path and registered', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, file, run } = layerProject(t);
  assert.equal(await run(), 0);
  const entry = findByReference(projectDir, JSON.parse(fs.readFileSync(registryPath(projectDir), 'utf8')).imports[0].reference);
  assert.equal(entry.layer, 'motion-v01');
  assert.match(entry.reference, /^assets\/broll\/video\/[^/]+\/media\.mp4$/);
  assert.equal(findByCanonical(projectDir, entry.canonicalSha256).renderSha256, sha256File(file));
  // Запись реестра: слой, номер и отчёт рендера, sha256 нормализованного рендера, ассет и его sha256, профиль, время.
  assert.equal(entry.render, 1);
  assert.equal(entry.renderReport, 'qa/layer-motion-v01-render-01.json');
  assert.equal(entry.renderFile, 'motion-v01/renders/layer-01.mp4');
  assert.equal(entry.profile, 'avatar');
  assert.equal(entry.assetId, entry.reference.split('/')[3]);
  assert.equal(entry.canonicalSha256, sha256File(path.join(projectDir, entry.reference)));
  assert.ok(Number.isFinite(Date.parse(entry.createdAt)));
  assert.deepEqual(videoAssets(projectDir), [entry.assetId]);
  const bundle = bundleOf(projectDir, entry.reference);
  assert.deepEqual([bundle.reference, bundle.canonicalSha256], [entry.reference, entry.canonicalSha256]);
});

test('trusted conforming layer remuxes the master and uses a fast proxy without changing video packets', { skip: !hasFfmpeg }, async (t) => {
  const p = layerProject(t, { fps: 30 });
  const calls = [];
  const logs = [];
  await p.run(p.file, {
    log: (line) => logs.push(String(line)),
    runMediaProcessImpl: (call) => { calls.push(call); return runMediaProcess(call); },
  });
  const [entry] = readRegistry(p.projectDir).imports;
  const master = calls.find((call) => call.command === 'ffmpeg' && call.args.at(-1).endsWith('media.mp4'));
  const proxy = calls.find((call) => call.command === 'ffmpeg' && call.args.includes('libvpx'));
  assert.ok(master, 'the injected processor sees the real master invocation');
  assert.equal(master.args[master.args.indexOf('-c') + 1], 'copy');
  assert.ok(!master.args.includes('libx264'));
  assert.equal(proxy.args[proxy.args.indexOf('-threads') + 1], '4');
  assert.equal(proxy.args[proxy.args.indexOf('-cpu-used') + 1], '4');
  const videoMd5 = (file) => {
    const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
      '-map', '0:v:0', '-c:v', 'copy', '-f', 'md5', '-'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  assert.equal(videoMd5(path.join(p.projectDir, entry.reference)), videoMd5(p.file));
  assert.ok(bundleOf(p.projectDir, entry.reference));
  assert.ok(logs.some((line) => line.includes('мастер: переупаковка без перекодирования')), logs.join('\n'));
});

test('trusted mono layer falls back to encoding stereo while keeping the fast proxy', { skip: !hasFfmpeg }, async (t) => {
  const p = layerProject(t, { fps: 30, channels: 1 });
  const calls = [];
  const logs = [];
  await p.run(p.file, {
    log: (line) => logs.push(String(line)),
    runMediaProcessImpl: (call) => { calls.push(call); return runMediaProcess(call); },
  });
  const master = calls.find((call) => call.command === 'ffmpeg' && call.args.includes('libx264'));
  const proxy = calls.find((call) => call.command === 'ffmpeg' && call.args.includes('libvpx'));
  assert.ok(master);
  assert.equal(proxy.args[proxy.args.indexOf('-threads') + 1], '4');
  assert.equal(proxy.args[proxy.args.indexOf('-cpu-used') + 1], '4');
  const [entry] = readRegistry(p.projectDir).imports;
  const probeResult = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=channels', '-of', 'json', path.join(p.projectDir, entry.reference)], { encoding: 'utf8' });
  assert.equal(probeResult.status, 0, probeResult.stderr);
  const probe = JSON.parse(probeResult.stdout);
  assert.equal(probe.streams[0].channels, 2);
  assert.ok(bundleOf(p.projectDir, entry.reference));
  assert.ok(logs.some((line) => line.includes('мастер: перекодирование – ')), logs.join('\n'));
});

test('layer import holds a basename-labelled heavy slot through success and error', { skip: !hasFfmpeg }, async (t) => {
  const p = layerProject(t);
  const events = [];
  const acquireSlot = async ({ label }) => {
    assert.equal(label, `layer import ${path.basename(p.projectDir)}`);
    events.push('acquire');
    return { waited: false, release: () => events.push('release') };
  };
  const importImpl = async (options) => { events.push('import'); return require('../scripts/review/media-import').importReviewMedia(options); };
  await p.run(p.file, { ...quiet, acquireSlot, importImpl });
  assert.deepEqual(events, ['acquire', 'import', 'release']);
  // Reuse remains inside the acquired slot as well.
  events.length = 0;
  await p.run(p.file, { ...quiet, acquireSlot, importImpl });
  assert.deepEqual(events, ['acquire', 'release']);
  const failed = layerProject(t);
  events.length = 0;
  await assert.rejects(failed.run(failed.file, { ...quiet, acquireSlot,
    importImpl: async () => { events.push('import'); throw new Error('injected import failure'); },
  }), /injected import failure/);
  assert.deepEqual(events, ['acquire', 'import', 'release']);
});

test('source manifest switched while waiting rejects the old report before import and releases the slot', { skip: !hasFfmpeg }, async (t) => {
  const p = layerProject(t);
  const replacement = path.join(p.projectDir, 'input', 'replacement.mp4');
  fs.copyFileSync(p.file, replacement);
  let imported = false;
  let released = false;
  await assert.rejects(p.run(p.file, { ...quiet,
    acquireSlot: async () => {
      const manifestPath = path.join(p.projectDir, 'project.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.source.localPath = 'input/replacement.mp4';
      writeJson(manifestPath, manifest);
      return { waited: true, release: () => { released = true; } };
    },
    importImpl: async () => { imported = true; throw new Error('import must not start'); },
  }), /слой собран для другого исходника/);
  assert.equal(imported, false);
  assert.equal(released, true);
  nothingImported(p.projectDir);
});

test('importing the same render twice keeps one asset and one registry entry; warnings are fine', { skip: !hasFfmpeg }, async (t) => {
  const p = layerProject(t, { checked: false });
  p.report({ status: 'warn' });
  const logs = [];
  const log = (line) => logs.push(String(line));
  assert.equal(await p.run(p.file, { log }), 0);
  const [first] = readRegistry(p.projectDir).imports;
  assert.equal(await p.run(p.file, { log }), 0);
  const { imports } = readRegistry(p.projectDir);
  assert.equal(imports.length, 1);
  assert.deepEqual(imports[0], first);
  assert.deepEqual(videoAssets(p.projectDir), [first.assetId]);
  assert.ok(logs.some((line) => /уже импортирован/.test(line)), logs.join('\n'));
});

test('a broken bundle of the earlier import is imported again, not reported as already imported', { skip: !hasFfmpeg }, async (t) => {
  const p = layerProject(t);
  await p.run();
  const [first] = readRegistry(p.projectDir).imports;
  // Проверка целиком, как у preview: без VP8-прокси ассет не годится, хотя media.mp4 цел.
  fs.rmSync(path.join(p.projectDir, 'previews', 'broll', `${first.assetId}.webm`));
  assert.equal(bundleOf(p.projectDir, first.reference), null);
  const logs = [];
  assert.equal(await p.run(p.file, { log: (line) => logs.push(String(line)) }), 0);
  assert.ok(!logs.some((line) => /уже импортирован/.test(line)), logs.join('\n'));
  const { imports } = readRegistry(p.projectDir);
  assert.equal(imports.length, 1);
  assert.notEqual(imports[0].reference, first.reference);
  const bundle = bundleOf(p.projectDir, imports[0].reference);
  assert.deepEqual([bundle.reference, bundle.canonicalSha256], [imports[0].reference, imports[0].canonicalSha256]);
});

test('a registry entry whose reference or sha256 disagrees with the bundle is imported again', { skip: !hasFfmpeg }, async (t) => {
  const p = layerProject(t);
  await p.run();
  const tamper = (fields) => {
    const registry = readRegistry(p.projectDir);
    writeJson(registryPath(p.projectDir), { ...registry, imports: registry.imports.map((e) => ({ ...e, ...fields(e) })) });
  };
  // Ассет цел, но запись о нём разошлась с ним: чужой sha256, затем другая ссылка в той же папке ассета.
  for (const fields of [() => ({ canonicalSha256: '0'.repeat(64) }), (e) => ({ reference: `${path.posix.dirname(e.reference)}/renamed.mp4` })]) {
    tamper(fields);
    const logs = [];
    assert.equal(await p.run(p.file, { log: (line) => logs.push(String(line)) }), 0);
    assert.ok(!logs.some((line) => /уже импортирован/.test(line)), logs.join('\n'));
    const [entry] = readRegistry(p.projectDir).imports;
    const bundle = bundleOf(p.projectDir, entry.reference);
    assert.deepEqual([bundle.reference, bundle.canonicalSha256], [entry.reference, entry.canonicalSha256]);
  }
});

test('regression: the project source is never registered through the source input of a passing report', { skip: !hasFfmpeg }, async (t) => {
  // Настоящий отчёт layer render хранит sha256 исходника во входе role 'source': по нему исходник-аватар
  // выглядел бы «проверенным слоем kit».
  const p = layerProject(t);
  await assert.rejects(p.run(p.sourcePath), /не проходил layer render/);
  nothingImported(p.projectDir);
});

test('regression: a layer rendered for an earlier source is refused after the source bytes change', { skip: !hasFfmpeg }, async (t) => {
  const p = layerProject(t);
  const replacement = `${p.sourcePath}.new.mp4`;
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=540x960:r=25:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2', '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', replacement]);
  fs.renameSync(replacement, p.sourcePath);
  // Перерендер того же слоя всегда упал бы на assertLayerSource: подсказка ведёт к новому слою.
  await assert.rejects(p.run(), (error) => /слой собран для другого исходника .*– создайте новый слой: automontage layer new --project-dir ".+" → layer render → layer import/.test(error.message)
    && !/--layer motion-v01/.test(error.message));
  p.report({ edit: (report) => ({ ...report, inputs: report.inputs.filter((input) => input.role !== 'source') }) });
  await assert.rejects(p.run(), /qa\/layer-motion-v01-render-01\.json: в отчёте нет sha256 исходника/);
  nothingImported(p.projectDir);
});

test('a report that disagrees with its kind, layer or gates is refused with the report named', { skip: !hasFfmpeg }, async (t) => {
  const p = layerProject(t, { checked: false });
  p.report({ edit: (report) => ({ ...report, kind: 'layer-check' }) });
  await assert.rejects(p.run(), /qa\/layer-motion-v01-render-01\.json – не отчёт layer render \(kind «layer-check»\)/);
  p.report({ edit: (report) => ({ ...report, layer: 'motion-v07' }) });
  await assert.rejects(p.run(), /qa\/layer-motion-v01-render-01\.json: отчёт о слое motion-v07, а файл из motion-v01/);
  // Итог «pass», вписанный руками поверх проваленного гейта.
  p.report({ status: 'fail', edit: (report) => ({ ...report, summary: { status: 'pass', fail: 0, warn: 0 } }) });
  await assert.rejects(p.run(), /qa\/layer-motion-v01-render-01\.json: итог «pass» не совпадает с гейтами \(«fail»\)/);
  p.report({ edit: (report) => ({ ...report, gates: report.gates.filter((g) => g.id !== 'G7') }) });
  await assert.rejects(p.run(), /qa\/layer-motion-v01-render-01\.json: в отчёте нет G7/);
  p.report({ edit: (report) => ({ ...report, gates: 'нет' }) });
  await assert.rejects(p.run(), /qa\/layer-motion-v01-render-01\.json: нет списка гейтов/);
  nothingImported(p.projectDir);
});

test('import refuses files outside the project, links, non-regular files and copies of the checked render', { skip: !hasFfmpeg }, async (t) => {
  const { root, projectDir, file, run } = layerProject(t);
  await assert.rejects(layerImport.run({ 'project-dir': projectDir }, quiet), /нужен --file/);
  await assert.rejects(run(path.join(projectDir, 'motion-v01', 'renders', 'layer-09.mp4')), /файл не найден/);
  // Те же байты с проходящим отчётом, но вне папки проекта.
  const outside = path.join(root, 'outside.mp4');
  fs.copyFileSync(file, outside);
  await assert.rejects(run(outside), /вне проекта/);
  await assert.rejects(run(path.join(projectDir, 'motion-v01', 'renders')), /не обычный файл/);
  // Байт-в-байт копия внутри проекта: отчёт проверял другой путь – импортируется только сам рендер.
  for (const copy of [path.join(projectDir, 'motion-v09', 'renders', 'layer-01.mp4'), path.join(projectDir, 'motion-v01', 'renders', 'layer-07.mp4')]) {
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.copyFileSync(file, copy);
    await assert.rejects(run(copy), /это копия слоя motion-v01\/renders\/layer-01\.mp4, проверенного в qa\/layer-motion-v01-render-01\.json/);
  }
  if (canLink) {
    fs.symlinkSync(file, path.join(projectDir, 'motion-v01', 'renders', 'link.mp4'));
    fs.symlinkSync(root, path.join(projectDir, 'escape'), 'dir');
    await assert.rejects(run(path.join(projectDir, 'motion-v01', 'renders', 'link.mp4')), /ссылка/);
    await assert.rejects(run(path.join(projectDir, 'escape', 'outside.mp4')), /вне проекта/);
  }
  nothingImported(projectDir);
});

test('qa/, its reports and the registry are checked before anything is imported', { skip: !hasFfmpeg }, async (t) => {
  const p = layerProject(t);
  const qa = path.join(p.projectDir, 'qa');
  fs.mkdirSync(path.join(qa, 'layer-motion-v04-render-02.json'));
  await assert.rejects(p.run(), /qa\/layer-motion-v04-render-02\.json: это не файл отчёта/);
  fs.rmdirSync(path.join(qa, 'layer-motion-v04-render-02.json'));
  // projects/ не в Git – восстанавливать неоткуда: реестр удаляют и импортируют слои заново.
  const broken = /qa\/layer-imports\.json повреждён .*– удалите qa\/layer-imports\.json и импортируйте слои заново/;
  for (const text of ['{', '{"version":1}']) {
    fs.writeFileSync(registryPath(p.projectDir), text);
    await assert.rejects(p.run(), broken);
  }
  fs.rmSync(registryPath(p.projectDir));
  if (canLink) {
    // qa/ – ссылка на чужую папку отчётов: её отчёты не читаются, а реестр не пишется мимо проекта.
    const foreign = path.join(p.root, 'foreign-qa');
    fs.renameSync(qa, foreign);
    fs.symlinkSync(foreign, qa, 'dir');
    await assert.rejects(p.run(), /qa\/ должна быть папкой проекта, а не ссылкой/);
  }
  assert.deepEqual(videoAssets(p.projectDir), []);
});

test('import errors keep their code and get a Russian hint', { skip: !hasFfmpeg }, async (t) => {
  const p = layerProject(t);
  const cases = {
    MEDIA_IMPORT_BUSY: /идёт другой импорт/,
    MEDIA_IMPORT_TOO_LARGE: /больше 1 ГБ – сократите слой или понизьте качество/,
    MEDIA_IMPORT_DISK_FULL: /не хватает места/,
    MEDIA_IMPORT_DURATION_UNSUPPORTED: /длиннее 30 минут/,
    MEDIA_IMPORT_DECODE_FAILED: /импорт не удался/,
  };
  for (const [code, hint] of Object.entries(cases)) {
    const importImpl = async () => { throw mediaImportError(400, code); };
    await assert.rejects(p.run(p.file, { ...quiet, importImpl }), (error) => hint.test(error.message) && error.message.includes(`(${code})`));
  }
  nothingImported(p.projectDir);
});

test('the checked descriptor itself is hashed and streamed from the start', { skip: !hasFfmpeg }, async (t) => {
  const p = layerProject(t);
  const opened = [];
  const fileSystem = { ...fs, openSync: (file, flags, ...rest) => { opened.push(flags); return fs.openSync(file, flags, ...rest); } };
  let streamed = null;
  const importImpl = async ({ request }) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    streamed = hashBytes(Buffer.concat(chunks));
    throw mediaImportError(409, 'MEDIA_IMPORT_BUSY');
  };
  await assert.rejects(p.run(p.file, { ...quiet, fileSystem, importImpl }), /MEDIA_IMPORT_BUSY/);
  assert.equal(streamed, sha256File(p.file), 'поток идёт с начала файла после хеша');
  assert.equal(opened.length, 1, 'файл открыт один раз: без отдельного открытия по пути');
  if (process.platform !== 'win32') assert.ok(opened[0] & fs.constants.O_NOFOLLOW, 'открыт без прохода по ссылке');

  // fstat дескриптора видит не тот файл, что lstat, – или файл меняется, пока его хешируют.
  const neverImport = async () => { throw new Error('импорт не должен начаться'); };
  const changed = (stat, fields) => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, fields);
  const shiftingOn = (changeOn) => {
    let calls = 0;
    return { ...fs, fstatSync: (...args) => { calls += 1; const stat = fs.fstatSync(...args); return calls === changeOn ? changed(stat, { size: stat.size + 1 }) : stat; } };
  };
  for (const changeOn of [1, 2]) {
    await assert.rejects(p.run(p.file, { ...quiet, fileSystem: shiftingOn(changeOn), importImpl: neverImport }), /файл изменился во время импорта/);
  }
  // Третья сверка – после импорта: файл, изменившийся пока его читал импорт, не попадает в реестр.
  const drained = async ({ request }) => {
    for await (const chunk of request) void chunk;
    return { reference: 'assets/broll/video/x/media.mp4', canonicalSha256: 'c'.repeat(64) };
  };
  await assert.rejects(p.run(p.file, { ...quiet, fileSystem: shiftingOn(3), importImpl: drained }), /файл изменился во время импорта/);
  nothingImported(p.projectDir);
});

test('regression: an error while closing the import stream stays handled', { skip: !hasFfmpeg }, async (t) => {
  const p = layerProject(t);
  // Поток, чьё закрытие дескриптора завершается ошибкой: без слушателя 'error' она стала бы необработанной.
  const fileSystem = { ...fs, createReadStream: (file, options) => {
    const stream = new PassThrough();
    stream._destroy = (error, callback) => { fs.closeSync(options.fd); callback(new Error('close failed')); };
    return stream;
  } };
  const busy = async () => { throw mediaImportError(409, 'MEDIA_IMPORT_BUSY'); };
  await assert.rejects(p.run(p.file, { ...quiet, fileSystem, importImpl: busy }), /MEDIA_IMPORT_BUSY/);
  await new Promise((resolve) => setImmediate(resolve));
  nothingImported(p.projectDir);
});

test('findRenderReport matches only the layer input and takes the newest report', (t) => {
  const dir = tempDir(t);
  const layerSha = 'a'.repeat(64);
  const sourceSha = 'b'.repeat(64);
  assert.equal(findRenderReport(dir, layerSha), null, 'нет папки qa – нет отчёта');
  renderReport(dir, { n: 1, layerSha, sourceSha });
  assert.equal(findRenderReport(dir, sourceSha), null, 'исходник – вход role source, а не слой');
  assert.equal(findRenderReport(dir, 'm'.repeat(64)), null, 'манифест – не слой');
  writeJson(path.join(dir, 'qa', 'layer-motion-v01-render-02.json'), { kind: 'layer-render', layer: 'motion-v01', inputs: [{ sha256: sourceSha }], summary: { status: 'pass' }, error: null });
  assert.equal(findRenderReport(dir, sourceSha), null, 'вход без role не считается слоем');
  assert.equal(findRenderReport(dir, layerSha).fileName, 'layer-motion-v01-render-01.json');
  assert.equal(findRenderReport(dir, layerSha, { path: 'motion-v01/renders/layer-01.mp4' }).layerPath, 'motion-v01/renders/layer-01.mp4');
  assert.equal(findRenderReport(dir, layerSha, { path: 'motion-v09/renders/layer-01.mp4' }), null, 'отчёт проверял другой путь');

  // Номер рендера может быть занят заново после дыры: свежесть решает createdAt, а не номер.
  const other = 'c'.repeat(64);
  renderReport(dir, { n: 3, layerSha: other, status: 'fail', createdAt: '2026-09-28T12:00:00.000Z' });
  renderReport(dir, { n: 4, layerSha: other, status: 'pass', createdAt: '2026-09-28T11:00:00.000Z' });
  const newest = findRenderReport(dir, other);
  assert.deepEqual([newest.fileName, newest.renderNumber, renderPassed(newest)], ['layer-motion-v01-render-03.json', 3, false]);
  assert.equal(findRenderReport(dir, other, { path: 'motion-v01/renders/layer-04.mp4' }).fileName, 'layer-motion-v01-render-04.json');

  // При равном createdAt – больший номер, числом: 100 новее 99, хотя строкой «100» < «99».
  const third = 'd'.repeat(64);
  renderReport(dir, { n: 99, layerSha: third, status: 'fail' });
  renderReport(dir, { n: 100, layerSha: third, status: 'pass' });
  assert.deepEqual([findRenderReport(dir, third).renderNumber, renderPassed(findRenderReport(dir, third))], [100, true]);

  fs.writeFileSync(path.join(dir, 'qa', 'layer-motion-v01-render-05.json'), '{');
  assert.throws(() => findRenderReport(dir, layerSha), /qa\/layer-motion-v01-render-05\.json: неверный JSON/);
});

test('renderPassed accepts only a whole, consistent layer render report that passed or warned', () => {
  const report = ({ g6 = 'pass', g7 = 'pass', error = null } = {}, edit = (r) => r) => ({
    ...edit(buildReport({ kind: 'layer-render', layer: 'motion-v01', profile: 'avatar', error, inputs: [],
      gates: error ? [] : [gate('G6', 'Длина слоя', { status: g6 }), gate('G7', 'Голос в звуке слоя', { status: g7 })] })),
    fileName: 'layer-motion-v01-render-01.json',
  });
  assert.equal(renderPassed(report()), true);
  assert.equal(renderPassed(report({ g7: 'warn' })), true);
  assert.equal(renderPassed(report({ g6: 'fail' })), false);
  assert.equal(renderPassed(report({ error: 'x' })), false);
  assert.equal(renderPassed(report({}, (r) => ({ ...r, error: 'x' }))), false);
  assert.equal(renderPassed(report({ g6: 'fail' }, (r) => ({ ...r, summary: { status: 'pass', fail: 0, warn: 0 } }))), false);
  // Итог сверяется целиком: верный статус с чужими счётчиками fail/warn – тоже правка руками.
  assert.equal(renderPassed(report({}, (r) => ({ ...r, summary: { ...r.summary, fail: 1 } }))), false);
  assert.equal(renderPassed(report({}, (r) => ({ ...r, summary: { ...r.summary, warn: 1 } }))), false);
  assert.equal(renderPassed(report({ g7: 'warn' }, (r) => ({ ...r, summary: { ...r.summary, warn: 2 } }))), false);
  assert.equal(renderPassed(report({}, (r) => ({ ...r, gates: r.gates.slice(1) }))), false);
  assert.equal(renderPassed(report({}, (r) => ({ ...r, kind: 'layer-check' }))), false);
  assert.equal(renderPassed(report(), { layer: 'motion-v02' }), false);
  assert.equal(renderPassed(report(), { layer: 'motion-v01' }), true);
  assert.equal(renderPassed(null), false);
});

test('the registry keeps one entry per render, asset and reference', (t) => {
  const dir = tempDir(t);
  assert.deepEqual(readRegistry(dir), { version: 1, imports: [] });
  const entry = (render, canonical, reference) => ({ layer: 'motion-v01', renderSha256: render, canonicalSha256: canonical, reference });
  const pairs = () => readRegistry(dir).imports.map((e) => [e.renderSha256, e.canonicalSha256, e.reference]);
  appendRegistry(dir, entry('r1', 'c1', 'ref1'));
  appendRegistry(dir, entry('r2', 'c2', 'ref2'));
  appendRegistry(dir, entry('r1', 'c3', 'ref3')); // тот же рендер
  assert.deepEqual(pairs(), [['r2', 'c2', 'ref2'], ['r1', 'c3', 'ref3']]);
  appendRegistry(dir, entry('r4', 'c3', 'ref4')); // тот же ассет по sha256
  assert.deepEqual(pairs(), [['r2', 'c2', 'ref2'], ['r4', 'c3', 'ref4']]);
  appendRegistry(dir, entry('r5', 'c5', 'ref2')); // та же ссылка
  assert.deepEqual(pairs(), [['r4', 'c3', 'ref4'], ['r5', 'c5', 'ref2']]);
  assert.equal(findByRender(dir, 'r4').reference, 'ref4');
  assert.equal(findByCanonical(dir, 'c1'), null);
  assert.equal(findByReference(dir, 'ref2').renderSha256, 'r5');
  fs.writeFileSync(registryPath(dir), '{"version":1}');
  assert.throws(() => readRegistry(dir), /qa\/layer-imports\.json повреждён \(нет списка imports\)/);
});
