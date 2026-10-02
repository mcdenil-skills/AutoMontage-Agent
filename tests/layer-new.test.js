const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { toolAvailable, runTool } = require('./helpers/media-fixtures');
const { makeLayerProject } = require('./helpers/layer-project');
const { main } = require('../scripts/layer/cli');
const { probeMediaPath, probeVideo } = require('../scripts/media-probe');
const { buildLayerManifest } = require('../scripts/motion-kit-node');
const { runTool: runRealTool } = require('../scripts/process');
const { hashFile } = require('../scripts/pult/files');
const { getProfile } = require('../scripts/qa/profiles');
const { runTimelineGates } = require('../scripts/qa/timeline-gates');
const newLayer = require('../scripts/layer/new');
const layerWords = require('../scripts/layer/words');

const hasFfmpeg = toolAvailable('ffmpeg') && toolAvailable('ffprobe');
const TEMPLATE = path.join(__dirname, '..', 'templates', 'motion-layer');

// Вывод команд собирается через deps, а не в консоль теста. Строка в stdout процесса теста
// попадает в канал раннера между сериализованными сообщениями; раннер Node 20 читает её байты как
// длину следующего сообщения и падает (Unable to deserialize cloned data) – так упал CI.
function quiet() {
  const out = { log: [], warn: [] };
  return { out, deps: { log: (line) => out.log.push(String(line)), warn: (line) => out.warn.push(String(line)) } };
}

// Ловит любой вывод команды мимо внедрённого логгера.
function forbidConsole(t) {
  const calls = [];
  for (const method of ['log', 'info', 'warn', 'error']) {
    t.mock.method(console, method, (...args) => calls.push(`${method}: ${args.join(' ')}`));
  }
  return calls;
}

test('layer new scaffolds a renderable layer that matches the source geometry', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir } = makeLayerProject(t);
  process.env.AUTOMONTAGE_SFX_DIR = path.join(projectDir, 'no-library');
  t.after(() => { delete process.env.AUTOMONTAGE_SFX_DIR; });
  const consoleCalls = forbidConsole(t);
  const { deps, out } = quiet();
  assert.equal(await newLayer.run({ 'project-dir': projectDir }, deps), 0);
  const dir = path.join(projectDir, 'motion-v01');
  const layer = JSON.parse(fs.readFileSync(path.join(dir, 'layer.json'), 'utf8'));
  assert.deepEqual([layer.fps, layer.width, layer.height, layer.durationInFrames, layer.profile], [25, 540, 960, 150, 'avatar']);
  assert.deepEqual(layer.face, { x: 270, y: 394 });
  assert.equal(layer.speaker.lastFrame, 149);
  for (const file of ['src/index.jsx', 'src/Root.jsx', 'src/plan.js', 'src/scenes.jsx', 'src/words.js', 'src/sfx-library.js',
    'spelling.json', 'README.md', 'public/speaker.mp4', 'public/fonts/Onest.ttf', 'public/fonts/OFL-Onest.txt',
    'public/stock/placeholder.mp4', 'public/shots/placeholder.png', 'public/SOURCE.md']) {
    assert.ok(fs.existsSync(path.join(dir, file)), file);
  }
  assert.match(fs.readFileSync(path.join(dir, 'src/words.js'), 'utf8'), /"t":"Привет,"/);
  assert.equal(await newLayer.run({ 'project-dir': projectDir }, deps), 0);
  assert.ok(fs.existsSync(path.join(projectDir, 'motion-v02')));
  await assert.rejects(newLayer.run({ 'project-dir': projectDir, dir: 'motion-v01' }, deps), /уже существует/);
  // Весь вывод – через deps: в консоль теста ничего, отчёт – в log, пустая библиотека – без предупреждений.
  assert.deepEqual(consoleCalls, []);
  assert.match(out.log.join('\n'), /слой motion-v01: .*\n.*\n.*слой motion-v02: /);
  assert.deepEqual(out.warn, []);
});

test('layer words re-applies spelling.json', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir } = makeLayerProject(t);
  process.env.AUTOMONTAGE_SFX_DIR = path.join(projectDir, 'no-library');
  t.after(() => { delete process.env.AUTOMONTAGE_SFX_DIR; });
  const consoleCalls = forbidConsole(t);
  const { deps, out } = quiet();
  await newLayer.run({ 'project-dir': projectDir }, deps);
  const dir = path.join(projectDir, 'motion-v01');
  fs.writeFileSync(path.join(dir, 'spelling.json'), JSON.stringify({ 'привет': 'Здравствуйте' }));
  assert.equal(await layerWords.run({ 'project-dir': projectDir, layer: 'motion-v01' }, deps), 0);
  assert.match(fs.readFileSync(path.join(dir, 'src/words.js'), 'utf8'), /"t":"Здравствуйте,"/);
  assert.deepEqual(consoleCalls, []);
  assert.match(out.log.at(-1), /слов: \d+/);
});

// --- Контракт слоя подробнее ---

function useSfxDir(t, dir) {
  process.env.AUTOMONTAGE_SFX_DIR = dir;
  t.after(() => { delete process.env.AUTOMONTAGE_SFX_DIR; });
}

const motionDirs = (projectDir) => fs.readdirSync(projectDir).filter((name) => name.startsWith('motion-')).sort();

test('the scaffolded layer follows the contract: layer.json, template copies, speaker copy, template fonts, provenance', { skip: !hasFfmpeg }, async (t) => {
  const { root, projectDir, workspace, sfxDir } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  const { deps, out } = quiet();
  assert.equal(await newLayer.run({ 'project-dir': projectDir, profile: 'live' }, deps), 0);
  const dir = path.join(projectDir, 'motion-v01');
  // source – какой исходник проекта лежит в слое: слой живёт с одним исходником (layer words сверяет).
  const sourceSha = hashFile(workspace.sourcePath);
  // size и mtimeMs – чтобы следующие команды не хешировали неизменившийся исходник заново.
  const { size, mtimeMs } = fs.statSync(workspace.sourcePath);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'layer.json'), 'utf8')), {
    version: 1, composition: 'Layer', fps: 25, width: 540, height: 960, durationInFrames: 150,
    face: { x: 270, y: 394 }, profile: 'live', sfxMasterDb: -5, speaker: { src: 'speaker.mp4', lastFrame: 149 },
    source: { localPath: 'input/source.mp4', sha256: sourceSha, size, mtimeMs, revision: 1 },
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'spelling.json'), 'utf8')), {});
  // Стартовые файлы – побайтовые копии шаблона.
  for (const file of ['src/index.jsx', 'src/Root.jsx', 'src/plan.js', 'src/scenes.jsx', 'README.md']) {
    assert.ok(fs.readFileSync(path.join(dir, file)).equals(fs.readFileSync(path.join(TEMPLATE, file))), file);
  }
  // speaker.mp4 – копия исходника проекта.
  assert.equal(hashFile(path.join(dir, 'public', 'speaker.mp4')), hashFile(workspace.sourcePath));
  // Каждый шрифт, который выбирает scenes.jsx шаблона (FONTS), лежит в public/ слоя, с лицензией OFL.
  const fonts = [...fs.readFileSync(path.join(TEMPLATE, 'src', 'scenes.jsx'), 'utf8').matchAll(/file: '(fonts\/[^']+)'/g)].map((m) => m[1]);
  assert.ok(fonts.length >= 1);
  for (const font of fonts) {
    assert.ok(fs.existsSync(path.join(dir, 'public', font)), font);
    assert.ok(fs.existsSync(path.join(dir, 'public', 'fonts', `OFL-${path.basename(font, '.ttf')}.txt`)), `лицензия ${font}`);
  }
  // Пустая библиотека: пустая public/sfx и пустой набор звуков, без предупреждений.
  assert.deepEqual(fs.readdirSync(path.join(dir, 'public', 'sfx')), []);
  assert.match(fs.readFileSync(path.join(dir, 'src', 'sfx-library.js'), 'utf8'), /export default \{"sounds":\{\}\};/);
  assert.deepEqual(out.warn, []);
  assert.match(out.log.join('\n'), /слой motion-v01: 150 кадров 540×960@25/);
  // SOURCE.md: исходник назван путём внутри проекта, личного абсолютного пути в нём нет.
  const source = fs.readFileSync(path.join(dir, 'public', 'SOURCE.md'), 'utf8');
  assert.ok(source.includes(`| \`speaker.mp4\` | исходник проекта | \`input/source.mp4\`, ревизия 1 | ${sourceSha} |`), source);
  assert.match(source, /`stock\/placeholder\.mp4`, `shots\/placeholder\.png`/);
  assert.ok(!source.includes(root), 'в SOURCE.md нет абсолютного пути машины');
});

test('the fresh layer builds its manifest and fails no timeline gate on the fixture', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  assert.equal(await newLayer.run({ 'project-dir': projectDir }, quiet().deps), 0);
  const manifest = buildLayerManifest(path.join(projectDir, 'motion-v01'));
  assert.deepEqual([manifest.fps, manifest.width, manifest.height, manifest.durationInFrames], [25, 540, 960, 150]);
  assert.equal(manifest.camera.s.length, 150);
  const gates = runTimelineGates(manifest, getProfile('avatar'));
  assert.deepEqual(gates.filter((g) => g.status === 'fail').map((g) => `${g.id}: ${g.hint}`), []);
});

test('the sound library is copied into public/sfx with provenance, and skipped files and unknown meta each print one warning', { skip: !hasFfmpeg }, async (t) => {
  const { root, projectDir } = makeLayerProject(t);
  const library = path.join(root, 'sfx-library');
  fs.mkdirSync(library);
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    "aevalsrc='0.8*sin(2*PI*900*t)*exp(-8*t)':s=48000:d=0.15", path.join(library, 'pop.wav')]);
  fs.writeFileSync(path.join(library, 'UPPER.WAV'), 'x');
  fs.writeFileSync(path.join(library, 'library.json'), JSON.stringify({ license: 'Test license', sourceUrl: 'https://example.com/sfx',
    sounds: { pop: { role: 'pop' }, popp: { role: 'pop' } } }));
  useSfxDir(t, library);
  const { deps, out } = quiet();
  assert.equal(await newLayer.run({ 'project-dir': projectDir }, deps), 0);
  const dir = path.join(projectDir, 'motion-v01');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'public', 'sfx')), ['pop.wav']);
  const sfxModule = fs.readFileSync(path.join(dir, 'src', 'sfx-library.js'), 'utf8');
  assert.match(sfxModule, /"pop":\{"file":"sfx\/pop\.wav"/);
  assert.match(sfxModule, /"sha256":"[a-f0-9]{64}"/);
  assert.match(fs.readFileSync(path.join(dir, 'public', 'SOURCE.md'), 'utf8'), /\| `sfx\/pop\.wav` \| Test license \| https:\/\/example\.com\/sfx \| [a-f0-9]{64} \|/);
  assert.equal(out.warn.length, 2, out.warn.join('\n'));
  assert.equal(out.warn.filter((line) => line.includes('UPPER.WAV')).length, 1);
  assert.equal(out.warn.filter((line) => line.includes('popp')).length, 1);
  assert.match(out.log.join('\n'), /звуков в библиотеке: 1/);
});

// Проба Task 49: в worktree (и в любом клоне без приватного пакета звуков) папки по умолчанию нет, и
// layer new молча собирал слой без эффектов. Это не ошибка – слой без звуков допустим, – но молчать
// нельзя: предупреждение называет ожидаемую папку и переменную AUTOMONTAGE_SFX_DIR.
test('without the sound library at the default path layer new warns in Russian, names the path and AUTOMONTAGE_SFX_DIR, and still builds the layer', { skip: !hasFfmpeg }, async (t) => {
  const { root, projectDir } = makeLayerProject(t);
  const missing = path.join(root, 'engine', 'projects', '.library', 'sfx');
  const { deps, out } = quiet();
  assert.equal(await newLayer.run({ 'project-dir': projectDir }, { ...deps, env: {}, defaultSfxDir: missing }), 0);
  assert.equal(out.warn.length, 1, out.warn.join('\n'));
  assert.match(out.warn[0], /^⚠️ библиотеки звуков нет/);
  assert.ok(out.warn[0].includes(missing), out.warn[0]);
  assert.match(out.warn[0], /AUTOMONTAGE_SFX_DIR/);
  assert.match(out.warn[0], /без звуковых эффектов/);
  const dir = path.join(projectDir, 'motion-v01');
  assert.ok(fs.existsSync(path.join(dir, 'layer.json')));
  assert.match(fs.readFileSync(path.join(dir, 'src', 'sfx-library.js'), 'utf8'), /export default \{"sounds":\{\}\};/);
  assert.match(out.log.join('\n'), /звуков в библиотеке: 0/);
});

test('the default sound library path is projects/.library/sfx of the engine', () => {
  const { sfxLibraryDir } = require('../scripts/layer/sfx-library');
  assert.equal(sfxLibraryDir({}), path.join(__dirname, '..', 'projects', '.library', 'sfx'));
});

// --- Папка слоя занимается атомарно, отказ не оставляет половины слоя ---

// Одновременный второй `layer new`: подменённый fs.mkdirSync создаёт ту же папку слоя «чужим»
// процессом прямо перед нашим mkdir – ровно окно между выбором имени и захватом папки.
function raceOnClaim(t, projectDir, names) {
  const original = fs.mkdirSync;
  const pending = new Set(names.map((name) => path.join(projectDir, name)));
  t.mock.method(fs, 'mkdirSync', (target, ...rest) => {
    const key = path.resolve(String(target));
    if (!rest[0]?.recursive && pending.has(key)) {
      pending.delete(key);
      original.call(fs, key);
    }
    return original.call(fs, target, ...rest);
  });
  return () => pending.size;
}

test('a concurrent run that takes the auto name first makes layer new retry once with the next name', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  const left = raceOnClaim(t, projectDir, ['motion-v01']);
  assert.equal(await newLayer.run({ 'project-dir': projectDir }, quiet().deps), 0);
  assert.equal(left(), 0, 'гонка сработала');
  assert.deepEqual(motionDirs(projectDir), ['motion-v01', 'motion-v02']);
  // Чужая папка не тронута (пуста, как её создал «другой процесс»), слой собран в следующей.
  assert.deepEqual(fs.readdirSync(path.join(projectDir, 'motion-v01')), []);
  assert.ok(fs.existsSync(path.join(projectDir, 'motion-v02', 'layer.json')));
});

test('losing the claim twice, or losing an explicit --dir, is a clear error and leaves the other runs\' folders alone', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  raceOnClaim(t, projectDir, ['motion-v01', 'motion-v02', 'motion-v07']);
  await assert.rejects(newLayer.run({ 'project-dir': projectDir }, quiet().deps), /папка motion-v02 уже существует/);
  await assert.rejects(newLayer.run({ 'project-dir': projectDir, dir: 'motion-v07' }, quiet().deps), /папка motion-v07 уже существует/);
  assert.deepEqual(motionDirs(projectDir), ['motion-v01', 'motion-v02', 'motion-v07']);
  for (const name of motionDirs(projectDir)) assert.deepEqual(fs.readdirSync(path.join(projectDir, name)), [], name);
});

test('a failure after the claim removes only the half-built folder of this run', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  assert.equal(await newLayer.run({ 'project-dir': projectDir }, quiet().deps), 0);
  const before = fs.readdirSync(path.join(projectDir, 'motion-v01'), { recursive: true }).sort();
  // Битый library.json читается уже после захвата motion-v02 – посередине сборки слоя.
  fs.writeFileSync(path.join(sfxDir, 'library.json'), '{ not json');
  await assert.rejects(newLayer.run({ 'project-dir': projectDir }, quiet().deps), /library\.json: неверный JSON/);
  assert.deepEqual(motionDirs(projectDir), ['motion-v01']);
  assert.deepEqual(fs.readdirSync(path.join(projectDir, 'motion-v01'), { recursive: true }).sort(), before);
  assert.equal(fs.readFileSync(path.join(sfxDir, 'library.json'), 'utf8'), '{ not json');
  assert.ok(fs.existsSync(path.join(projectDir, 'project.json')));
  assert.ok(fs.existsSync(path.join(projectDir, 'input', 'source.mp4')));
});

test('a folder swapped in place of the claimed one during the run is never deleted', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  const layerDir = path.join(projectDir, 'motion-v01');
  const deps = { ...quiet().deps, runToolImpl: () => {
    fs.renameSync(layerDir, `${layerDir}-moved`);
    fs.mkdirSync(layerDir);
    fs.writeFileSync(path.join(layerDir, 'user.txt'), 'чужое');
    throw new Error('ffmpeg упал');
  } };
  await assert.rejects(newLayer.run({ 'project-dir': projectDir }, deps), /ffmpeg упал \(папку motion-v01 подменили во время layer new – не удаляю её\)/);
  assert.equal(fs.readFileSync(path.join(layerDir, 'user.txt'), 'utf8'), 'чужое');
});

test('bad flags, a missing transcript or a mistyped sound folder are refused before any layer folder appears', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir, workspace } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  await assert.rejects(newLayer.run({ 'project-dir': projectDir, dir: 'layer-1' }, quiet().deps), /--dir должен быть вида motion-v01/);
  await assert.rejects(newLayer.run({ 'project-dir': projectDir, profile: 'studio' }, quiet().deps), /--profile: avatar или live/);
  process.env.AUTOMONTAGE_SFX_DIR = path.join(projectDir, 'no-such-library');
  await assert.rejects(newLayer.run({ 'project-dir': projectDir }, quiet().deps), /AUTOMONTAGE_SFX_DIR указывает на несуществующую папку/);
  process.env.AUTOMONTAGE_SFX_DIR = sfxDir;
  fs.rmSync(path.join(projectDir, workspace.manifest.transcript.words));
  await assert.rejects(newLayer.run({ 'project-dir': projectDir }, quiet().deps), /нет транскрипта transcript\/words\.json/);
  assert.deepEqual(motionDirs(projectDir), []);
});

test('layer words names a broken spelling.json and keeps the previous words.js', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  await newLayer.run({ 'project-dir': projectDir }, quiet().deps);
  const words = path.join(projectDir, 'motion-v01', 'src', 'words.js');
  const before = fs.readFileSync(words, 'utf8');
  const spelling = path.join(projectDir, 'motion-v01', 'spelling.json');
  for (const [text, message] of [['{ nope', /spelling\.json: неверный JSON/], ['null', /spelling\.json должен быть объектом/],
    ['["Claude"]', /spelling\.json должен быть объектом/], ['{"клод": 5}', /spelling\.json → «клод» должно быть строкой/]]) {
    fs.writeFileSync(spelling, text);
    await assert.rejects(layerWords.run({ 'project-dir': projectDir, layer: 'motion-v01' }, quiet().deps), message);
    assert.equal(fs.readFileSync(words, 'utf8'), before);
  }
});

// --- Слой становится «готовым» только целиком: layer.json – последний шаг, сигнал убирает папку ---

test('layer.json is written last: it does not exist yet while the placeholder ffmpeg runs', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  const layerJson = path.join(projectDir, 'motion-v01', 'layer.json');
  const stages = [];
  const runToolImpl = (command, args, options) => {
    stages.push(options.stage);
    assert.ok(!fs.existsSync(layerJson), `layer.json уже есть на шаге ${options.stage}`);
    return runRealTool(command, args, options);
  };
  assert.equal(await newLayer.run({ 'project-dir': projectDir }, { ...quiet().deps, runToolImpl }), 0);
  assert.deepEqual(stages, ['layer placeholder stock', 'layer placeholder screenshot']);
  assert.ok(fs.existsSync(layerJson));
});

// Настоящий Ctrl+C во время синхронной сборки доходит до обработчика на первом же обороте цикла
// событий после неё – тест воспроизводит ровно это: сигнал ставится в очередь (setImmediate) изнутри
// сборки, обработчик получает его через подменный emitter, а повторная отправка сигнала – через kill.
// events – порядок строки в stderr (deps.error) и повторного сигнала (deps.kill): со стандартным
// действием сигнал завершает процесс сразу, поэтому строка обязана быть раньше.
function signalDeps() {
  const signals = new EventEmitter();
  const killed = [];
  const events = [];
  return { signals, killed, events, deps: { ...quiet().deps, signals,
    error: (line) => events.push(`error: ${line}`),
    kill: (signal) => { killed.push(signal); events.push(`kill: ${signal}`); } } };
}

const GUARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const guardListeners = (emitter) => GUARDED.reduce((sum, signal) => sum + emitter.listenerCount(signal), 0);

test('Ctrl+C that lands during the scaffold removes the whole claimed folder and re-raises the signal', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  const { signals, killed, events, deps } = signalDeps();
  const runToolImpl = (command, args, options) => {
    if (options.stage === 'layer placeholder screenshot') setImmediate(() => signals.emit('SIGINT'));
    return runRealTool(command, args, options);
  };
  await assert.rejects(newLayer.run({ 'project-dir': projectDir }, { ...deps, runToolImpl }), /layer new прерван сигналом SIGINT/);
  assert.deepEqual(motionDirs(projectDir), []);
  assert.deepEqual(killed, ['SIGINT']);
  assert.deepEqual(events, ['error: layer new прерван сигналом SIGINT – недостроенная папка motion-v01 удалена', 'kill: SIGINT']);
  assert.equal(guardListeners(signals), 0);
});

test('SIGTERM that kills the placeholder ffmpeg removes the folder and is re-raised after the cleanup', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  const { signals, killed, events, deps } = signalDeps();
  const runToolImpl = () => {
    setImmediate(() => signals.emit('SIGTERM'));
    throw Object.assign(new Error('layer placeholder stock: ffmpeg завершён сигналом SIGTERM'), { signal: 'SIGTERM' });
  };
  await assert.rejects(newLayer.run({ 'project-dir': projectDir }, { ...deps, runToolImpl }), /layer new прерван сигналом SIGTERM/);
  assert.deepEqual(motionDirs(projectDir), []);
  assert.deepEqual(killed, ['SIGTERM']);
  assert.deepEqual(events, ['error: layer new прерван сигналом SIGTERM – недостроенная папка motion-v01 удалена', 'kill: SIGTERM']);
});

test('SIGHUP (the terminal was closed) is handled like Ctrl+C: folder removed, one stderr line, then the signal again', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  const { signals, killed, events, deps } = signalDeps();
  const runToolImpl = (command, args, options) => {
    if (options.stage === 'layer placeholder stock') setImmediate(() => signals.emit('SIGHUP'));
    return runRealTool(command, args, options);
  };
  await assert.rejects(newLayer.run({ 'project-dir': projectDir }, { ...deps, runToolImpl }), /layer new прерван сигналом SIGHUP/);
  assert.deepEqual(motionDirs(projectDir), []);
  assert.deepEqual(killed, ['SIGHUP']);
  assert.deepEqual(events, ['error: layer new прерван сигналом SIGHUP – недостроенная папка motion-v01 удалена', 'kill: SIGHUP']);
  assert.equal(guardListeners(signals), 0);
});

test('a second signal during the cleanup is ignored: one line and one re-raise', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  const { signals, killed, events, deps } = signalDeps();
  const runToolImpl = (command, args, options) => {
    if (options.stage === 'layer placeholder stock') {
      setImmediate(() => {
        // Первый обработчик снимает все три – поэтому второй сигнал слушателей уже не находит.
        signals.emit('SIGINT');
        signals.emit('SIGHUP');
      });
    }
    return runRealTool(command, args, options);
  };
  await assert.rejects(newLayer.run({ 'project-dir': projectDir }, { ...deps, runToolImpl }), /layer new прерван сигналом SIGINT/);
  assert.deepEqual(killed, ['SIGINT']);
  assert.equal(events.filter((line) => line.startsWith('error: ')).length, 1);
});

test('where the signal cannot be re-raised (SIGHUP on Windows: ENOSYS), layer new exits with 128 + its number after the cleanup', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  const { signals, events, deps } = signalDeps();
  const runToolImpl = (command, args, options) => {
    if (options.stage === 'layer placeholder stock') setImmediate(() => signals.emit('SIGHUP'));
    return runRealTool(command, args, options);
  };
  const noReraise = { ...deps, runToolImpl,
    kill: (signal) => { events.push(`kill: ${signal}`); throw Object.assign(new Error('kill ENOSYS'), { code: 'ENOSYS' }); },
    exit: (code) => events.push(`exit: ${code}`) };
  await assert.rejects(newLayer.run({ 'project-dir': projectDir }, noReraise), /layer new прерван сигналом SIGHUP/);
  assert.deepEqual(motionDirs(projectDir), []);
  assert.deepEqual(events, ['error: layer new прерван сигналом SIGHUP – недостроенная папка motion-v01 удалена', 'kill: SIGHUP', 'exit: 129']);
  assert.equal(guardListeners(signals), 0);
});

test('the handlers stay armed until the cleanup is done: a second copy of the signal cannot cut the cleanup short', { skip: !hasFfmpeg }, async (t) => {
  // Ctrl+C в терминале доходит до слоя дважды: от терминала и копией от внешнего automontage. Сними
  // обработчик до уборки – вторая копия сработала бы со стандартным действием посреди rmSync.
  const { projectDir, sfxDir } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  const { signals, killed, events, deps } = signalDeps();
  let armed = null;
  const runToolImpl = (command, args, options) => {
    if (options.stage === 'layer placeholder stock') setImmediate(() => signals.emit('SIGINT'));
    return runRealTool(command, args, options);
  };
  const error = (line) => {
    armed = guardListeners(signals);
    signals.emit('SIGINT');
    events.push(`error: ${line}`);
  };
  await assert.rejects(newLayer.run({ 'project-dir': projectDir }, { ...deps, runToolImpl, error }), /layer new прерван сигналом SIGINT/);
  assert.equal(armed, 3);
  assert.deepEqual(killed, ['SIGINT']);
  assert.equal(events.filter((line) => line.startsWith('error: ')).length, 1);
  assert.equal(guardListeners(signals), 0);
  assert.deepEqual(motionDirs(projectDir), []);
});

test('a half-built folder that cannot be removed is named with the same «недостроенная» wording', {
  skip: !hasFfmpeg || process.platform === 'win32' || process.getuid?.() === 0 ? 'нужны POSIX-права без root' : false,
}, async (t) => {
  const { projectDir, sfxDir } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  const locked = path.join(projectDir, 'motion-v01', 'public');
  const runToolImpl = () => {
    fs.chmodSync(locked, 0o555);
    throw new Error('ffmpeg упал');
  };
  try {
    await assert.rejects(newLayer.run({ 'project-dir': projectDir }, { ...quiet().deps, runToolImpl }),
      /ffmpeg упал \(не удалось убрать недостроенную папку motion-v01: /);
  } finally {
    // Права – обратно до уборки временной папки (её t.after зарегистрирован раньше и идёт первым).
    if (fs.existsSync(locked)) fs.chmodSync(locked, 0o755);
  }
});

test('signal handlers live only while the folder is being built', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  const { signals, killed, events, deps } = signalDeps();
  let during = 0;
  const runToolImpl = (command, args, options) => {
    during = guardListeners(signals);
    return runRealTool(command, args, options);
  };
  assert.equal(await newLayer.run({ 'project-dir': projectDir }, { ...deps, runToolImpl }), 0);
  assert.equal(during, 3);
  assert.equal(guardListeners(signals), 0);
  assert.deepEqual(killed, []);
  assert.deepEqual(events, []);
  // Настоящий process: обработчики тоже снимаются.
  const before = GUARDED.map((signal) => process.listenerCount(signal));
  assert.equal(await newLayer.run({ 'project-dir': projectDir }, quiet().deps), 0);
  assert.deepEqual(GUARDED.map((signal) => process.listenerCount(signal)), before);
});

// --- Исходник: поворот, видео без дорожки, длина по контейнеру, последний кадр видео ---

test('a phone source rotated by 90° is refused before the claim: its frame does not match the stored geometry', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir } = makeLayerProject(t, { size: '960x540', rotation: 90 });
  useSfxDir(t, sfxDir);
  await assert.rejects(newLayer.run({ 'project-dir': projectDir }, quiet().deps), /исходник повёрнут на 90° – сначала соберите мастер \(automontage master/);
  assert.deepEqual(motionDirs(projectDir), []);
});

test('an audio-only source is refused with a Russian message, no folder is claimed', { skip: !hasFfmpeg }, async (t) => {
  const { root, projectDir: videoProject } = makeLayerProject(t);
  const audio = path.join(root, 'voice.m4a');
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:d=2', '-c:a', 'aac', audio]);
  const projectDir = path.join(path.dirname(videoProject), 'audio-only');
  const { createOrOpenProject } = require('../scripts/project/workspace');
  createOrOpenProject({ projectDir, name: 'audio only', sourcePath: audio });
  fs.mkdirSync(path.join(projectDir, 'transcript'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'transcript', 'words.json'), '[]');
  useSfxDir(t, path.join(videoProject, 'no-library'));
  await assert.rejects(newLayer.run({ 'project-dir': projectDir }, quiet().deps), /в исходнике нет видеодорожки – layer new работает с видео-исходником/);
  assert.deepEqual(motionDirs(projectDir), []);
});

test('an image source is refused with a Russian message, no folder is claimed', { skip: !hasFfmpeg }, async (t) => {
  const { root, projectDir: videoProject } = makeLayerProject(t);
  const image = path.join(root, 'still.png');
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x336699:s=540x960', '-frames:v', '1', image]);
  const projectDir = path.join(path.dirname(videoProject), 'image-source');
  const { createOrOpenProject } = require('../scripts/project/workspace');
  createOrOpenProject({ projectDir, name: 'image source', sourcePath: image });
  fs.mkdirSync(path.join(projectDir, 'transcript'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'transcript', 'words.json'), '[]');
  useSfxDir(t, path.join(videoProject, 'no-library'));
  await assert.rejects(newLayer.run({ 'project-dir': projectDir }, quiet().deps), /исходник – картинка, а не видео: layer new работает с видео-исходником/);
  assert.deepEqual(motionDirs(projectDir), []);
});

test('NTSC: durationInFrames rounds the container duration (not the shorter video stream), the log shows 29,97', { skip: !hasFfmpeg }, async (t) => {
  // Видео 5,97 с, звук и контейнер 6,0 с при 30000/1001: round(6,0 × 29,97) = 180 (floor дал бы 179),
  // последний настоящий кадр видео – round(5,97 × 29,97) − 1 = 178.
  const { projectDir, sfxDir } = makeLayerProject(t, { fps: '30000/1001' });
  useSfxDir(t, sfxDir);
  const { deps, out } = quiet();
  assert.equal(await newLayer.run({ 'project-dir': projectDir }, deps), 0);
  const layer = JSON.parse(fs.readFileSync(path.join(projectDir, 'motion-v01', 'layer.json'), 'utf8'));
  assert.equal(layer.fps, 30000 / 1001);
  assert.deepEqual([layer.durationInFrames, layer.speaker.lastFrame], [180, 178]);
  assert.match(out.log.join('\n'), /180 кадров 540×960@29,97,/);
});

test('audio longer than video: the layer spans the container, the speaker freezes after the last real video frame', { skip: !hasFfmpeg }, async (t) => {
  // Видео 6 с при 24 fps (144 кадра), звук 6,3 с: round(6,3 × 24 = 151,2) = 151 (ceil дал бы 152).
  const { projectDir, sfxDir } = makeLayerProject(t, { fps: 24, audioSeconds: 6.3 });
  useSfxDir(t, sfxDir);
  assert.equal(await newLayer.run({ 'project-dir': projectDir }, quiet().deps), 0);
  const layer = JSON.parse(fs.readFileSync(path.join(projectDir, 'motion-v01', 'layer.json'), 'utf8'));
  assert.deepEqual([layer.fps, layer.durationInFrames, layer.speaker.lastFrame], [24, 151, 143]);
});

test('the transcript, the sound folder and both source probes are checked before the layer folder is claimed', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir, workspace } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  const layerDir = path.join(projectDir, 'motion-v01');
  const transcript = path.join(projectDir, workspace.manifest.transcript.words);
  const events = [];
  const spy = (method, match, name) => {
    const original = fs[method];
    t.mock.method(fs, method, (target, ...rest) => {
      if (match(path.resolve(String(target)), rest)) events.push(name);
      return original.call(fs, target, ...rest);
    });
  };
  spy('statSync', (p) => p === sfxDir, 'sfx');
  spy('existsSync', (p) => p === transcript, 'transcript');
  spy('mkdirSync', (p, rest) => p === layerDir && !rest[0]?.recursive, 'claim');
  const deps = { ...quiet().deps,
    probeVideo: (...args) => { events.push('probeVideo'); return probeVideo(...args); },
    probeMedia: (...args) => { events.push('probeMedia'); return probeMediaPath(...args); } };
  assert.equal(await newLayer.run({ 'project-dir': projectDir }, deps), 0);
  const claimAt = events.indexOf('claim');
  assert.ok(claimAt > 0, events.join(' '));
  for (const name of ['sfx', 'transcript', 'probeMedia', 'probeVideo']) {
    assert.ok(events.includes(name) && events.indexOf(name) < claimAt, `${name} до захвата: ${events.join(' ')}`);
  }
});

test('an explicit --dir motion-v05 is used as asked, and the next auto name continues after it', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  assert.equal(await newLayer.run({ 'project-dir': projectDir, dir: 'motion-v05' }, quiet().deps), 0);
  assert.ok(fs.existsSync(path.join(projectDir, 'motion-v05', 'layer.json')));
  assert.equal(await newLayer.run({ 'project-dir': projectDir }, quiet().deps), 0);
  assert.deepEqual(motionDirs(projectDir), ['motion-v05', 'motion-v06']);
});

// --- layer words: один исходник на слой, предупреждения о написании и хвосте, атомарная запись ---

test('layer words refuses when the project source is no longer the one the layer was built from', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir, workspace } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  await newLayer.run({ 'project-dir': projectDir }, quiet().deps);
  const words = path.join(projectDir, 'motion-v01', 'src', 'words.js');
  const before = fs.readFileSync(words, 'utf8');
  fs.appendFileSync(workspace.sourcePath, Buffer.from([0]));
  await assert.rejects(layerWords.run({ 'project-dir': projectDir, layer: 'motion-v01' }, quiet().deps),
    /исходник проекта сменился после создания слоя motion-v01.*automontage layer new/s);
  assert.equal(fs.readFileSync(words, 'utf8'), before);
  // Через роутер – отказ с кодом 1 (у layer words нет qa-отчёта).
  t.mock.method(console, 'error', () => {});
  assert.equal(await main(['words', '--project-dir', projectDir, '--layer', 'motion-v01']), 1);
});

test('layer words refuses a layer.json without the source record', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  await newLayer.run({ 'project-dir': projectDir }, quiet().deps);
  const file = path.join(projectDir, 'motion-v01', 'layer.json');
  const layer = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete layer.source;
  fs.writeFileSync(file, JSON.stringify(layer));
  await assert.rejects(layerWords.run({ 'project-dir': projectDir, layer: 'motion-v01' }, quiet().deps), /layer\.json: нет source/);
});

test('layer words warns once about spelling keys that match nothing, once about multi-word keys and once about words past the end', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir, workspace } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  await newLayer.run({ 'project-dir': projectDir }, quiet().deps);
  const dir = path.join(projectDir, 'motion-v01');
  fs.writeFileSync(path.join(dir, 'spelling.json'), JSON.stringify({ 'клод код': 'Claude Code', привт: 'опечатка', Привет: 'Здравствуйте' }));
  const transcript = path.join(projectDir, workspace.manifest.transcript.words);
  const segments = JSON.parse(fs.readFileSync(transcript, 'utf8'));
  segments[0].words.push({ w: ' хвост', s: 6.4, e: 6.8 });
  fs.writeFileSync(transcript, JSON.stringify(segments));
  const { deps, out } = quiet();
  assert.equal(await layerWords.run({ 'project-dir': projectDir, layer: 'motion-v01' }, deps), 0);
  assert.equal(out.warn.length, 3, out.warn.join('\n'));
  assert.match(out.warn.find((line) => line.includes('«клод код»')), /из нескольких слов/);
  assert.match(out.warn.find((line) => line.includes('«привт»')), /нет в транскрипте/);
  assert.ok(!out.warn.some((line) => line.includes('Привет')), 'совпавший ключ не упоминается');
  assert.match(out.warn.find((line) => line.includes('«хвост»')), /после конца исходника \(6 с\)/);
  assert.match(fs.readFileSync(path.join(dir, 'src', 'words.js'), 'utf8'), /"t":"Здравствуйте,"/);
});

test('layer words replaces a symlinked src/words.js instead of writing through it', { skip: !hasFfmpeg }, async (t) => {
  const { root, projectDir, sfxDir } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  await newLayer.run({ 'project-dir': projectDir }, quiet().deps);
  const outside = path.join(root, 'outside.js');
  fs.writeFileSync(outside, 'чужой файл');
  const words = path.join(projectDir, 'motion-v01', 'src', 'words.js');
  fs.rmSync(words);
  fs.symlinkSync(outside, words);
  assert.equal(await layerWords.run({ 'project-dir': projectDir, layer: 'motion-v01' }, quiet().deps), 0);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'чужой файл');
  assert.ok(fs.lstatSync(words).isFile() && !fs.lstatSync(words).isSymbolicLink());
  assert.match(fs.readFileSync(words, 'utf8'), /"t":"Привет,"/);
  assert.deepEqual(fs.readdirSync(path.dirname(words)).filter((name) => name.includes('.tmp')), []);
});

test('layer words: a word past the end is one that STARTS at or after the source end – a word crossing the end stays', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir, workspace } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  await newLayer.run({ 'project-dir': projectDir }, quiet().deps);
  const transcript = path.join(projectDir, workspace.manifest.transcript.words);
  const segments = JSON.parse(fs.readFileSync(transcript, 'utf8'));
  // Исходник – ровно 6 с (150 кадров при 25 fps). «через» начинается до конца и кончается после (s < 6 < e),
  // «ровно» начинается точно на конце (s = 6): судит word.s, а не word.e.
  segments[0].words.push({ w: ' через', s: 5.8, e: 6.2 }, { w: ' ровно', s: 6, e: 6.3 });
  fs.writeFileSync(transcript, JSON.stringify(segments));
  const { deps, out } = quiet();
  assert.equal(await layerWords.run({ 'project-dir': projectDir, layer: 'motion-v01' }, deps), 0);
  assert.equal(out.warn.length, 1, out.warn.join('\n'));
  assert.match(out.warn[0], /после конца исходника \(6 с\) – в слое их не будет: «ровно»$/);
  assert.doesNotMatch(out.warn[0], /через/);
});

// Слой, у которого исходник проекта записан с целой секундой mtime: utimesSync с Date переносит
// только миллисекунды, а mtimeMs файловой системы бывает дробным – так «вернуть прежнее время» точно.
async function layerWithPinnedSource(t) {
  const project = makeLayerProject(t);
  useSfxDir(t, project.sfxDir);
  const pinned = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(project.workspace.sourcePath, pinned, pinned);
  await newLayer.run({ 'project-dir': project.projectDir }, quiet().deps);
  const words = (options = {}) => layerWords.run({ 'project-dir': project.projectDir, layer: 'motion-v01', ...options }, quiet().deps);
  // Та же длина, другой байт в середине – и при желании прежнее время изменения.
  const flipByte = (time) => {
    const file = project.workspace.sourcePath;
    const bytes = fs.readFileSync(file);
    const middle = Math.floor(bytes.length / 2);
    bytes[middle] ^= 0xff;
    fs.writeFileSync(file, bytes);
    if (time) fs.utimesSync(file, time, time);
  };
  return { ...project, pinned, words, flipByte, layerFile: path.join(project.projectDir, 'motion-v01', 'layer.json') };
}

test('layer new records the size and mtime of the project source next to its sha256', { skip: !hasFfmpeg }, async (t) => {
  const { workspace, pinned, layerFile } = await layerWithPinnedSource(t);
  const { source } = JSON.parse(fs.readFileSync(layerFile, 'utf8'));
  assert.equal(source.size, fs.statSync(workspace.sourcePath).size);
  assert.equal(source.mtimeMs, pinned.getTime());
  assert.equal(source.sha256, hashFile(workspace.sourcePath));
});

test('layer words trusts an unchanged size and mtime without hashing, and hashes when either differs', { skip: !hasFfmpeg }, async (t) => {
  const { pinned, words, flipByte } = await layerWithPinnedSource(t);
  // Длина и время прежние – sha256 не считается (как make и rsync): даже подменённый байт не заметен.
  flipByte(pinned);
  assert.equal(await words(), 0);
  // Вернули байт, но время новое (touch): считается sha256, он совпадает с записанным – слой тот же.
  flipByte(new Date('2026-02-01T00:00:00Z'));
  assert.equal(await words(), 0);
  // Та же длина, новое время и другие байты – sha256 не совпал, отказ.
  flipByte(new Date('2026-03-01T00:00:00Z'));
  await assert.rejects(words(), /исходник проекта сменился после создания слоя motion-v01/);
});

test('layer words on an older layer.json without size and mtime always hashes the source', { skip: !hasFfmpeg }, async (t) => {
  const { pinned, words, flipByte, layerFile } = await layerWithPinnedSource(t);
  const layer = JSON.parse(fs.readFileSync(layerFile, 'utf8'));
  delete layer.source.size;
  delete layer.source.mtimeMs;
  fs.writeFileSync(layerFile, JSON.stringify(layer));
  assert.equal(await words(), 0);
  flipByte(pinned);
  await assert.rejects(words(), /исходник проекта сменился после создания слоя motion-v01/);
});

test('layer words names a layer folder that a killed layer new left without layer.json', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, sfxDir } = makeLayerProject(t);
  useSfxDir(t, sfxDir);
  await newLayer.run({ 'project-dir': projectDir }, quiet().deps);
  fs.rmSync(path.join(projectDir, 'motion-v01', 'layer.json'));
  await assert.rejects(layerWords.run({ 'project-dir': projectDir, layer: 'motion-v01' }, quiet().deps), (error) => {
    assert.match(error.message, /^motion-v01 собран не до конца \(нет layer\.json\) – удалите папку или создайте новый слой: automontage layer new --project-dir "/);
    assert.doesNotMatch(error.message, /ENOENT/);
    return true;
  });
});

for (const [width, height, warns] of [[2160, 3840, true], [1080, 1920, false]]) {
  test(`layer new creates ${width}x${height} and warns only above working 1080p`, { skip: !hasFfmpeg }, async (t) => {
    const { projectDir, sfxDir } = makeLayerProject(t);
    useSfxDir(t, sfxDir);
    const { deps, out } = quiet();
    const result = await newLayer.run({ 'project-dir': projectDir }, {
      ...deps,
      probeVideo: () => ({ width, height, fps: 25, duration: 6 }),
      probeMedia: () => ({ mediaKind: 'video', width, height, rotation: 0, videoDurationSec: 6 }),
      // The warning/manifest contract does not depend on encoding a four-second 4K placeholder.
      runToolImpl(command, args, options) {
        assert.equal(command, 'ffmpeg');
        assert.match(options.stage, /^layer placeholder (stock|screenshot)$/);
        fs.writeFileSync(args.at(-1), 'placeholder');
      },
    });
    assert.equal(result, 0);
    const layer = JSON.parse(fs.readFileSync(path.join(projectDir, 'motion-v01', 'layer.json')));
    assert.deepEqual([layer.width, layer.height], [width, height]);
    const warning = out.warn.join('\n');
    if (warns) { assert.match(warning, /рабочего 1080p/); assert.match(warning, /automontage master/); }
    else assert.doesNotMatch(warning, /рабочего 1080p/);
  });
}
