const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { toolAvailable, runTool } = require('./helpers/media-fixtures');
const { makeLayerProject, makeSfxLibrary } = require('./helpers/layer-project');
const { hashFile } = require('../scripts/pult/files');
const { runTool: runProcessTool } = require('../scripts/process');
const newLayer = require('../scripts/layer/new');
const check = require('../scripts/layer/check');
const render = require('../scripts/layer/render');

const hasFfmpeg = toolAvailable('ffmpeg') && toolAvailable('ffprobe');
const STATIC_PLAN = "export default function buildPlan({ face }) { return { camera: { face, shots: [{ at: 0, preset: 'W', drift: 'none' }] }, items: [] }; }\n";

// Подмена Remotion: ролик lavfi нужной длины и fps в полном диапазоне с теми же метками, что у настоящего
// Remotion 4.0.504 (yuvj420p, color_range pc, colorspace bt470bg); limitedRange включает новый диапазон tv.
// audio – lavfi-строка со своей длиной d, функция, которая строит её уже во время «рендера» (манифест слоя к
// этому моменту записан), или null – ролик без звуковой дорожки. Без -shortest: звук может быть длиннее
// видео – настоящий Remotion дописывает хвост AAC на 43–64 мс. after – что сделать после записи файла.
// Остальная цепочка (нормализация ffmpeg, probe, PCM, гейты, отчёт) – настоящая.
function fakeRemotion(seconds, audio, { after, fps = 25, limitedRange = false } = {}) {
  const calls = [];
  const environments = [];
  const runToolImpl = (command, args, options) => {
    if (options.stage !== 'layer Remotion render') return runProcessTool(command, args, options);
    calls.push(args);
    environments.push(options.env);
    const output = args[args.indexOf('render') + 3];
    const audioInput = typeof audio === 'function' ? audio() : audio;
    runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=540x960:r=${fps}:d=${seconds}`,
      ...(audioInput ? ['-f', 'lavfi', '-i', audioInput, '-c:a', 'aac'] : []),
      '-pix_fmt', limitedRange ? 'yuv420p' : 'yuvj420p', ...(limitedRange ? ['-color_range', 'tv'] : []),
      '-colorspace', 'bt470bg', '-c:v', 'libx264', output]);
    if (after) after(output);
    return null;
  };
  return { calls, environments, runToolImpl };
}

async function scaffold(t, projectOptions) {
  const project = makeLayerProject(t, projectOptions);
  process.env.AUTOMONTAGE_SFX_DIR = makeSfxLibrary(project.root);
  t.after(() => { delete process.env.AUTOMONTAGE_SFX_DIR; });
  await newLayer.run({ 'project-dir': project.projectDir }, { log: () => {}, warn: () => {} });
  const layerDir = path.join(project.projectDir, 'motion-v01');
  const logs = [];
  const quiet = { log: (line) => logs.push(String(line)), warn: (line) => logs.push(String(line)) };
  const run = (deps = {}, options = {}) => render.run({ 'project-dir': project.projectDir, layer: 'motion-v01', 'no-wait': true, ...options },
    { ...quiet, acquireSlot: async () => ({ index: 0, waited: false, release() {} }), ...deps });
  const report = (n = '01') => JSON.parse(fs.readFileSync(path.join(project.projectDir, 'qa', `layer-motion-v01-render-${n}.json`), 'utf8'));
  const sourcePath = path.join(project.projectDir, project.workspace.manifest.source.localPath);
  return { ...project, layerDir, logs, quiet, run, report, sourcePath };
}

const manifestPath = (projectDir) => path.join(projectDir, 'motion-v01', 'out', 'manifest.json');
function editManifest(projectDir, edit) {
  const m = JSON.parse(fs.readFileSync(manifestPath(projectDir), 'utf8'));
  edit(m);
  fs.writeFileSync(manifestPath(projectDir), JSON.stringify(m));
}
// Звук настоящего слоя kit – только эффекты: писк внутри окна каждого оставленного звука манифеста.
function effectsOf(projectDir, seconds) {
  const m = JSON.parse(fs.readFileSync(manifestPath(projectDir), 'utf8'));
  assert.ok(m.cues.kept.length > 0, 'у шаблона с библиотекой звуков есть эффекты');
  const beeps = m.cues.kept.map((c) => `0.8*sin(2*PI*1000*t)*between(t,${c.startFrame / m.fps},${(c.startFrame + c.durationFrames) / m.fps - 1e-6})`);
  return `aevalsrc='${beeps.join('+')}':s=48000:d=${seconds}`;
}
// Голос исходника makeLayerProject на −18 дБ – утечка аватара в звук слоя.
const LEAK = "aevalsrc='0.05*sin(2*PI*220*t)*gt(sin(2*PI*1.3*t),0)':s=48000:d=6";

function videoStream(file) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt,color_range',
    '-of', 'json', file], { encoding: 'utf8' })).streams[0];
}
// Длины потоков и контейнера готового слоя.
function streams(file) {
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,duration,nb_frames,channels:format=duration',
    '-of', 'json', file], { encoding: 'utf8' }));
  const [video, audio] = ['video', 'audio'].map((kind) => probe.streams.find((st) => st.codec_type === kind));
  return { video, audio, container: Number(probe.format.duration) };
}
// Самая тёмная яркость первого кадра: у testsrc2 есть чёрное, в полном диапазоне это 0, в ограниченном – 16.
function minLuma(file) {
  const out = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YMIN:file=-',
    '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8' });
  return Number(/YMIN=(\d+)/u.exec(out)[1]);
}

test('a good layer renders, normalises to limited-range yuv420p and passes G6 and G7', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, layerDir, logs, run, report, sourcePath } = await scaffold(t);
  const fake = fakeRemotion(6, () => effectsOf(projectDir, 6));
  assert.equal(await run({ runToolImpl: fake.runToolImpl }), 0);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.environments[0]?.AUTOMONTAGE_LAYER_LIMITED_RANGE, '1');
  assert.equal(fake.environments[0]?.PATH, process.env.PATH);
  assert.ok(logs.includes('Remotion отдал full range – перекодирую видео'));
  const args = fake.calls[0];
  assert.ok(args.some((a) => String(a).startsWith('--env-file=')));
  assert.equal(args[args.indexOf('--public-dir') + 1], path.join(layerDir, 'public'));
  const out = path.join(layerDir, 'renders', 'layer-01.mp4');
  // Заявка на номер (layer-01.raw.mp4) и сырой рендер убраны: в renders только нормализованный слой.
  assert.deepEqual(fs.readdirSync(path.join(layerDir, 'renders')), ['layer-01.mp4']);
  assert.deepEqual(videoStream(out), { pix_fmt: 'yuv420p', color_range: 'tv' });
  assert.ok(minLuma(out) >= 16, 'пиксели переведены в ограниченный диапазон, а не только помечены');
  const json = report();
  assert.equal(json.kind, 'layer-render');
  assert.equal(json.layer, 'motion-v01');
  assert.equal(json.profile, 'avatar');
  assert.equal(json.error, null);
  assert.deepEqual(json.gates.map((g) => [g.id, g.status]), [['G6', 'pass'], ['G7', 'pass']]);
  assert.equal(json.gates[1].value, 0);
  // Слой первым: по его sha256 layer import находит этот отчёт; рядом исходник и манифест, по которому судил G7.
  assert.deepEqual(json.inputs, [
    { role: 'layer', path: 'motion-v01/renders/layer-01.mp4', sha256: hashFile(out) },
    { role: 'source', path: path.relative(projectDir, sourcePath).split(path.sep).join('/'), sha256: hashFile(sourcePath) },
    { role: 'manifest', path: 'motion-v01/out/manifest.json', sha256: hashFile(manifestPath(projectDir)) },
  ]);
  assert.ok(logs.some((line) => line.includes('automontage layer import') && line.includes(out)), logs.join('\n'));
});

// Оркестратор, п.1: манифест читается сразу после layer check этого запуска и держится в памяти. Параллельный
// layer check после правки plan.js переписал бы out/manifest.json за минуты рендера – G7 не должен судить по
// чужим окнам эффектов. Здесь «чужой» манифест без единого звука: по нему все писки были бы «вне эффектов».
test('G7 judges by the manifest of this run\'s layer check, not by one rewritten during the render', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, run, report } = await scaffold(t);
  const fake = fakeRemotion(6, () => effectsOf(projectDir, 6), { after: () => editManifest(projectDir, (m) => { m.cues.kept = []; }) });
  assert.equal(await run({ runToolImpl: fake.runToolImpl }), 0);
  const json = report();
  assert.deepEqual(json.gates.map((g) => [g.id, g.status]), [['G6', 'pass'], ['G7', 'pass']]);
  assert.notEqual(json.inputs[2].sha256, hashFile(manifestPath(projectDir)), 'в отчёте – sha256 манифеста, по которому судили');
});

// Ревью с настоящим Remotion 4.0.504: звук AAC в рендере на 43–64 мс длиннее видео, нормализация его сохраняла –
// G6 мерил контейнер и ложно останавливал слой на 29,97/30/50/60 fps. Правило владельца: хвост AAC режется до
// длительности кадров. Теперь звук обрезается (и дополняется тишиной) ровно до durationInFrames/fps.
test('the Remotion AAC tail (+60 ms) is trimmed to the frames: video, audio and container are 6,0 s, G6 passes at 60 fps', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, layerDir, run, report } = await scaffold(t, { fps: 60 });
  assert.equal(await run({ runToolImpl: fakeRemotion(6, () => effectsOf(projectDir, 6.06), { fps: 60 }).runToolImpl }), 0);
  assert.deepEqual(report().gates.map((g) => [g.id, g.status, g.value]), [['G6', 'pass', 0], ['G7', 'pass', 0]]);
  const { video, audio, container } = streams(path.join(layerDir, 'renders', 'layer-01.mp4'));
  assert.equal(Number(video.nb_frames), 360);
  assert.equal(Number(audio.duration), 6);
  assert.equal(container, 6);
});

// Мутант «убрали apad»: звук исходника (5,5 с) короче видео (6 с) – нормализация дополняет его тишиной
// ровно до длительности кадров, а не оставляет коротким внутри контейнера полной длины.
test('normalisation pads audio shorter than the video with silence to the full length', { skip: !hasFfmpeg }, async (t) => {
  const { layerDir, run } = await scaffold(t);
  assert.equal(await run({ runToolImpl: fakeRemotion(6, 'anullsrc=r=48000:cl=mono:d=5.5').runToolImpl }), 0);
  const { audio } = streams(path.join(layerDir, 'renders', 'layer-01.mp4'));
  assert.equal(Number(audio.duration), 6);
  assert.equal(audio.channels, 2);
});

function videoMd5(file) {
  return execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v', '-c', 'copy', '-f', 'md5', '-'], { encoding: 'utf8' }).trim();
}

test('limited-range video is copied intact while mono audio is trimmed exactly and becomes stereo at 60 fps', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, layerDir, logs, run, report } = await scaffold(t, { fps: 60 });
  let rawMd5;
  const fake = fakeRemotion(6, () => effectsOf(projectDir, 6.06), {
    fps: 60, limitedRange: true, after: (raw) => { rawMd5 = videoMd5(raw); },
  });
  assert.equal(await run({ runToolImpl: fake.runToolImpl }), 0);
  const out = path.join(layerDir, 'renders', 'layer-01.mp4');
  assert.equal(videoMd5(out), rawMd5, 'видеопоток сохраняется побитно');
  assert.deepEqual(videoStream(out), { pix_fmt: 'yuv420p', color_range: 'tv' });
  const { video, audio, container } = streams(out);
  assert.equal(Number(video.nb_frames), 360);
  assert.equal(Number(audio.duration), 6);
  assert.equal(audio.channels, 2);
  assert.equal(container, 6);
  assert.deepEqual(report().gates.map((g) => [g.id, g.status, g.value]), [['G6', 'pass', 0], ['G7', 'pass', 0]]);
  assert.ok(!logs.includes('Remotion отдал full range – перекодирую видео'));
});

// Мутант «убрали first_pts=0»: звук исходника начинается на 0,1 с позже видео (буфер энкодера, как у
// настоящего Remotion) – нормализация кладёт его на 0 и обрезает ровно по длине кадров, а не оставляет
// сдвиг и лишний хвост.
test('normalisation starts audio that begins late at 0 and ends exactly at the video length', { skip: !hasFfmpeg }, async (t) => {
  const { layerDir, run } = await scaffold(t);
  const runToolImpl = (command, args, options) => {
    if (options.stage !== 'layer Remotion render') return runProcessTool(command, args, options);
    const output = args[args.indexOf('render') + 3];
    runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=540x960:r=25:d=6',
      '-itsoffset', '0.1', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=6', '-c:a', 'aac',
      '-pix_fmt', 'yuvj420p', '-colorspace', 'bt470bg', '-c:v', 'libx264', output]);
    return null;
  };
  assert.equal(await run({ runToolImpl }), 0);
  const out = path.join(layerDir, 'renders', 'layer-01.mp4');
  const { audio, container } = streams(out);
  assert.equal(Number(audio.duration), 6);
  assert.equal(container, 6);
  const startTime = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=start_time', '-of', 'json', out], { encoding: 'utf8' })).streams[0].start_time;
  assert.equal(Number(startTime), 0);
});

// G6 меряет видеопоток слоя, а не контейнер: звук дополнен тишиной до полной длины и не прячет короткое видео.
test('BAD CASE: a video shorter than the composition fails G6 even though its audio is padded to full length', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, run, report } = await scaffold(t);
  assert.equal(await run({ runToolImpl: fakeRemotion(5, () => effectsOf(projectDir, 6.06)).runToolImpl }), 1);
  const g6 = report().gates[0];
  assert.deepEqual([g6.id, g6.status, g6.value], ['G6', 'fail', -25]);
});

test('BAD CASE: a layer longer than the source is rendered but stopped by G6', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, run, report } = await scaffold(t);
  assert.equal(await run({ runToolImpl: fakeRemotion(6.4, () => effectsOf(projectDir, 6.4)).runToolImpl }), 1);
  const g6 = report().gates[0];
  assert.equal(g6.id, 'G6');
  assert.equal(g6.status, 'fail');
  assert.equal(g6.value, 10);
});

test('BAD CASE: the avatar voice in the layer audio is stopped by G7 through the real render chain', { skip: !hasFfmpeg }, async (t) => {
  const { run, report } = await scaffold(t);
  assert.equal(await run({ runToolImpl: fakeRemotion(6, LEAK).runToolImpl }), 1);
  const json = report();
  assert.deepEqual(json.gates.map((g) => [g.id, g.status]), [['G6', 'pass'], ['G7', 'fail']]);
  assert.match(json.gates[1].hint, /muted/);
});

// Манифест, который держит рендер, испорчен (кто-то переписал его между layer check и чтением): G7 бросает
// «манифест повреждён» уже после рендера – отчёт с error и код 2, sha256 слоя и исходника в inputs всё равно.
test('a broken manifest found after the render gives an error report with exit 2 and the file hashes', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, layerDir, run, report, sourcePath } = await scaffold(t);
  const checkImpl = async (options, deps) => {
    const code = await check.run(options, deps);
    editManifest(projectDir, (m) => { m.cues.kept[0].durationFrames = 0; });
    return code;
  };
  const fake = fakeRemotion(6, () => effectsOf(projectDir, 6));
  assert.equal(await run({ runToolImpl: fake.runToolImpl, checkImpl }), 2);
  assert.equal(fake.calls.length, 1);
  const json = report();
  assert.equal(json.summary.status, 'error');
  assert.match(json.error, /манифест повреждён/);
  assert.deepEqual(json.gates, []);
  const out = path.join(layerDir, 'renders', 'layer-01.mp4');
  assert.deepEqual(json.inputs.slice(0, 2), [
    { role: 'layer', path: 'motion-v01/renders/layer-01.mp4', sha256: hashFile(out) },
    { role: 'source', path: path.relative(projectDir, sourcePath).split(path.sep).join('/'), sha256: hashFile(sourcePath) },
  ]);
});

// Сбой самого Remotion – тоже «оценить нельзя» с отчётом: слоя нет, но исходник и манифест записаны, заявка
// на номер снята.
test('a crashed Remotion render gives an error report and releases the render number', { skip: !hasFfmpeg }, async (t) => {
  const { layerDir, run, report } = await scaffold(t);
  const runToolImpl = (command, args, options) => {
    if (options.stage === 'layer Remotion render') throw new Error('layer Remotion render: node завершился со status 1');
    return runProcessTool(command, args, options);
  };
  assert.equal(await run({ runToolImpl }), 2);
  const json = report();
  assert.match(json.error, /Remotion render/);
  assert.deepEqual(json.inputs.map((i) => i.role), ['source', 'manifest']);
  assert.deepEqual(fs.readdirSync(path.join(layerDir, 'renders')), []);
});

// Отказ нормализации: недописанный layer-NN.mp4 этого номера удаляется, отчёт с error и код 2.
test('a failed normalisation removes the partial layer file and gives an error report with exit 2', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, layerDir, run, report } = await scaffold(t);
  const fake = fakeRemotion(6, () => effectsOf(projectDir, 6));
  const runToolImpl = (command, args, options) => {
    if (options.stage !== 'layer normalize') return fake.runToolImpl(command, args, options);
    fs.writeFileSync(args[args.length - 1], 'половина слоя');
    throw new Error('layer normalize: ffmpeg завершился со status 1');
  };
  assert.equal(await run({ runToolImpl }), 2);
  const json = report();
  assert.equal(json.summary.status, 'error');
  assert.match(json.error, /layer normalize/);
  assert.deepEqual(json.inputs.map((i) => i.role), ['source', 'manifest']);
  assert.deepEqual(fs.readdirSync(path.join(layerDir, 'renders')), []);
});

test('a failing layer check blocks the render before Remotion starts', { skip: !hasFfmpeg }, async (t) => {
  const { layerDir, projectDir, run } = await scaffold(t);
  fs.writeFileSync(path.join(layerDir, 'src', 'plan.js'), STATIC_PLAN);
  const fake = fakeRemotion(6, 'anullsrc=r=48000:cl=stereo:d=6');
  assert.equal(await run({ runToolImpl: fake.runToolImpl }), 1);
  assert.equal(fake.calls.length, 0);
  assert.ok(!fs.existsSync(path.join(layerDir, 'renders')));
  assert.ok(!fs.existsSync(path.join(projectDir, 'qa', 'layer-motion-v01-render-01.json')));
});

// Оркестратор, п.3: слой без звуковой дорожки – layerEnv null (G7 предупреждает), исходник без звука –
// sourceEnv null (судит один сигнал A – звук вне эффектов).
test('a layer without an audio track warns in G7; a source without audio is judged by the effects windows alone', { skip: !hasFfmpeg }, async (t) => {
  const silentLayer = await scaffold(t);
  assert.equal(await silentLayer.run({ runToolImpl: fakeRemotion(6, null).runToolImpl }), 0);
  const warned = silentLayer.report().gates[1];
  assert.equal(warned.status, 'warn');
  assert.match(warned.hint, /нет звуковой дорожки/);

  const silentSource = await scaffold(t, { audio: false });
  assert.equal(await silentSource.run({ runToolImpl: fakeRemotion(6, () => effectsOf(silentSource.projectDir, 6)).runToolImpl }), 0);
  const judged = silentSource.report().gates[1];
  assert.equal(judged.status, 'pass');
  assert.match(judged.hint, /в исходнике нет звука/);
});

// Оркестратор, п.2: номер рендера занимается атомарно. Чужая заявка layer-01.raw.mp4 (второй layer render
// того же слоя ещё идёт) – этот рендер берёт layer-02 и не трогает чужой файл.
test('a render number claimed by another run is skipped: the render goes to layer-02', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, layerDir, run, report } = await scaffold(t);
  fs.mkdirSync(path.join(layerDir, 'renders'));
  const foreign = path.join(layerDir, 'renders', 'layer-01.raw.mp4');
  fs.writeFileSync(foreign, 'другой рендер ещё пишет сюда');
  assert.equal(await run({ runToolImpl: fakeRemotion(6, () => effectsOf(projectDir, 6)).runToolImpl }), 0);
  assert.deepEqual(fs.readdirSync(path.join(layerDir, 'renders')).sort(), ['layer-01.raw.mp4', 'layer-02.mp4']);
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'другой рендер ещё пишет сюда');
  assert.equal(report('02').inputs[0].path, 'motion-v01/renders/layer-02.mp4');
  assert.ok(!fs.existsSync(path.join(projectDir, 'qa', 'layer-motion-v01-render-01.json')));
});

// Номера рендеров не переиспользуются: на отчёт layer-motion-v01-render-01.json опираются layer import и барьер
// preview (по sha256 слоя). Слой layer-01.mp4 импортировали и удалили – следующий рендер берёт layer-02 и не
// перезаписывает отчёт 01.
test('a render number whose qa report still exists is never reused, even after its layer file is deleted', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, layerDir, run, report } = await scaffold(t);
  assert.equal(await run({ runToolImpl: fakeRemotion(6, () => effectsOf(projectDir, 6)).runToolImpl }), 0);
  const first = fs.readFileSync(path.join(projectDir, 'qa', 'layer-motion-v01-render-01.json'), 'utf8');
  fs.rmSync(path.join(layerDir, 'renders', 'layer-01.mp4'));
  assert.equal(await run({ runToolImpl: fakeRemotion(6, () => effectsOf(projectDir, 6)).runToolImpl }), 0);
  assert.deepEqual(fs.readdirSync(path.join(layerDir, 'renders')), ['layer-02.mp4']);
  assert.equal(fs.readFileSync(path.join(projectDir, 'qa', 'layer-motion-v01-render-01.json'), 'utf8'), first);
  assert.equal(report('02').inputs[0].path, 'motion-v01/renders/layer-02.mp4');
});

// Заявка на номер держится, пока не записан отчёт: иначе после сбоя без готового слоя второй рендер успел бы
// занять тот же номер до записи отчёта и потом перезаписать его.
test('the render number stays claimed until its report is written', { skip: !hasFfmpeg }, async (t) => {
  const { layerDir, projectDir, run } = await scaffold(t);
  const raw = path.join(layerDir, 'renders', 'layer-01.raw.mp4');
  const seen = [];
  const log = (line) => {
    if (String(line).startsWith('Отчёт:') && String(line).includes('render-01')) seen.push([fs.existsSync(path.join(projectDir, 'qa', 'layer-motion-v01-render-01.json')), fs.existsSync(raw)]);
  };
  const runToolImpl = (command, args, options) => {
    if (options.stage === 'layer Remotion render') throw new Error('layer Remotion render: node завершился со status 1');
    return runProcessTool(command, args, options);
  };
  assert.equal(await run({ runToolImpl, log }), 2);
  assert.deepEqual(seen, [[true, true]]);
  assert.ok(!fs.existsSync(raw));
});

test('claimRender skips a number whose qa report exists', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-claim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reports = path.join(dir, 'qa');
  fs.mkdirSync(reports);
  fs.writeFileSync(path.join(reports, 'render-01.json'), '{}');
  const claim = render.claimRender(dir, fs, { reportFile: (n) => path.join(reports, `render-${String(n).padStart(2, '0')}.json`) });
  assert.equal(claim.n, 2);
});

test('claimRender takes the first free number atomically and skips finished and claimed ones', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-claim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'layer-01.mp4'), '');
  fs.writeFileSync(path.join(dir, 'layer-02.raw.mp4'), '');
  const first = render.claimRender(dir);
  assert.equal(first.n, 3);
  assert.equal(first.raw, path.join(dir, 'layer-03.raw.mp4'));
  assert.equal(first.out, path.join(dir, 'layer-03.mp4'));
  // Второй запуск, пока первый держит заявку, – следующий номер, а не тот же.
  assert.equal(render.claimRender(dir).n, 4);
  first.release();
  assert.equal(render.claimRender(dir).n, 3);
});

// Гонка: между проверкой «layer-01.mp4 нет» и созданием заявки чужой рендер дописал layer-01.mp4 и снял свою
// заявку. Заявка на уже занятый номер снимается, берётся следующий.
test('claimRender re-checks the finished file after claiming and moves on if another run just finished it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-claim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const racing = {
    ...fs,
    openSync(file, flags) {
      const fd = fs.openSync(file, flags);
      if (path.basename(file) === 'layer-01.raw.mp4') fs.writeFileSync(path.join(dir, 'layer-01.mp4'), 'чужой готовый слой');
      return fd;
    },
  };
  const claim = render.claimRender(dir, racing);
  assert.equal(claim.n, 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['layer-01.mp4', 'layer-02.raw.mp4']);
  assert.equal(fs.readFileSync(path.join(dir, 'layer-01.mp4'), 'utf8'), 'чужой готовый слой');
});

// После ожидания очереди layer check запускается ещё раз. Ожидание длится до
// 3 ч; план, поправленный за это время, рендерится уже новым, и G7 должен судить по его манифесту, а не по
// манифесту проверки трёхчасовой давности. Без ожидания – одна проверка.
test('a plan edited while waiting in the queue is checked again before the render', { skip: !hasFfmpeg }, async (t) => {
  const { layerDir, run, logs } = await scaffold(t);
  let checks = 0;
  const checkImpl = (options, deps) => { checks += 1; return check.run(options, deps); };
  let releases = 0;
  const acquireSlot = async () => {
    assert.equal(checks, 1, 'первая проверка проходит до занятия слота');
    fs.writeFileSync(path.join(layerDir, 'src', 'plan.js'), STATIC_PLAN);
    return { index: 0, waited: true, release() { releases += 1; } };
  };
  const fake = fakeRemotion(6, 'anullsrc=r=48000:cl=stereo:d=6');
  assert.equal(await run({ runToolImpl: fake.runToolImpl, checkImpl, acquireSlot }, { 'no-wait': false }), 1);
  assert.equal(checks, 2);
  assert.equal(fake.calls.length, 0);
  assert.equal(releases, 1);
  assert.ok(logs.includes('Очередь освободилась – проверяю план слоя ещё раз: за время ожидания его могли поправить'));
});

test('a free queue means one layer check', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, run } = await scaffold(t);
  let checks = 0;
  const checkImpl = (options, deps) => { checks += 1; return check.run(options, deps); };
  const fake = fakeRemotion(6, () => effectsOf(projectDir, 6));
  let acquired = 0;
  const acquireSlot = async () => {
    assert.equal(checks, 1);
    acquired += 1;
    return { index: 0, waited: false, release() {} };
  };
  assert.equal(await run({ runToolImpl: fake.runToolImpl, checkImpl, acquireSlot }, { 'no-wait': false }), 0);
  assert.equal(acquired, 1);
  assert.equal(checks, 1);
  assert.equal(fake.calls.length, 1);
});

test('the slot is held until the report is written, also when Remotion throws', { skip: !hasFfmpeg }, async (t) => {
  for (const fails of [false, true]) {
    const { projectDir, run, report } = await scaffold(t);
    let held = false;
    let releases = 0;
    const acquireSlot = async () => {
      held = true;
      return { index: 0, waited: false, release() {
        assert.ok(fs.existsSync(path.join(projectDir, 'qa', 'layer-motion-v01-render-01.json')));
        held = false;
        releases += 1;
      } };
    };
    const fake = fakeRemotion(6, () => effectsOf(projectDir, 6));
    const runToolImpl = (command, args, options) => {
      assert.ok(held, `${options.stage} должен выполняться внутри слота`);
      if (fails && options.stage === 'layer Remotion render') throw new Error('Remotion failed');
      return fake.runToolImpl(command, args, options);
    };
    const log = (line) => {
      if (String(line).startsWith('Отчёт:') && String(line).includes('render-01')) assert.ok(held);
    };
    assert.equal(await run({ acquireSlot, runToolImpl, log }), fails ? 2 : 0);
    assert.equal(held, false);
    assert.equal(releases, 1);
    assert.equal(report().error, fails ? 'Remotion failed' : null);
  }
});

test('--no-wait does not wait in the queue and the label only contains the project basename', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, run } = await scaffold(t);
  let acquired = 0;
  const busy = Object.assign(new Error('машина занята: другая задача'), { code: 'HEAVY_QUEUE_BUSY' });
  const acquireSlot = async ({ config, label }) => {
    acquired += 1;
    assert.equal(config.waitMs, 0);
    assert.equal(label, `layer render ${path.basename(projectDir)}/motion-v01`);
    throw busy;
  };
  let renders = 0;
  await assert.rejects(run({ acquireSlot, runToolImpl() { renders += 1; } }), (error) => error === busy);
  assert.equal(acquired, 1);
  assert.equal(renders, 0);
});
