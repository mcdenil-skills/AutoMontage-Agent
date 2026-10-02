// automontage layer render – рендер слоя kit и гейты по готовому файлу: layer check (план, секунды) →
// слот очереди тяжёлых задач → Remotion защищённой командой → нормализация ffmpeg → G6 (длина и размер
// к исходнику) и G7 (голос в звуке слоя) → qa/layer-<слой>-render-NN.{json,txt}.
// Код: 0 – пройдено или только предупреждения, 1 – стоп (в том числе стоп layer check), 2 – оценить нельзя.
//
// --public-dir не копируется в каждый рендер: Remotion 4.0.504 для рендера из CLI собирает временный
// бандл (outDir null) и на macOS/Linux кладёт в него симлинк на папку public (symlinkPublicDir в
// @remotion/cli/dist/setup-cache.js), копирует её только на Windows. Отдельный флаг для этого не нужен.
//
// Обрыв (Ctrl+C, SIGKILL) уборку не даёт: во время Remotion остаётся заявка layer-NN.raw.mp4 (в неё
// же Remotion пишет сырой рендер, там может быть недописанное видео), следующий рендер возьмёт NN+1.
// Во время нормализации остаётся ещё и недописанный layer-NN.mp4 без отчёта: его sha256 нет ни в
// одном отчёте layer render, и layer import такой файл не примет. Оба файла можно удалить.
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, resolveRemotionCommand } = require('../env');
const { remotionLayerRenderCommand } = require('../build-commands');
const { probeMediaPath, probeVideo } = require('../media-probe');
const { hashBytes } = require('../pult/files');
const { runTool, captureTool } = require('../process');
const { LIMITED_RANGE_ENV } = require('../remotion-ffmpeg-override');
const { acquireHeavySlot, heavyQueueConfig } = require('../heavy-queue');
const { decodeAudio, envelopeDb } = require('../qa/audio');
const { gateLayerDuration, gateVoiceLeak } = require('../qa/media-gates');
const { getProfile } = require('../qa/profiles');
const { buildReport, exitCodeFor, formatReport, writeReport } = require('../qa/report');
const check = require('./check');
const { readLayerJson, relative, resolveLayer, sha256File } = require('./common');

const FLAGS = { 'project-dir': 'value', layer: 'value', profile: 'value', 'no-wait': 'bool' };
const pad = (n) => String(n).padStart(2, '0');

// Номер рендера занимается атомарно: заявка – пустой layer-NN.raw.mp4, созданный с 'wx' (O_EXCL, по
// ссылке не идёт). Второй layer render того же слоя получит EEXIST и возьмёт следующий номер. Готовый
// layer-NN.mp4 появляется раньше, чем снимается заявка, поэтому после заявки он проверяется ещё раз:
// чужой рендер мог закончить между проверкой и заявкой. Номер с уже записанным отчётом (reportFile(n))
// тоже занят, даже если сам слой удалили после импорта: пока жив его файл, заявка или отчёт, номер не
// переиспользуется – на отчёт опираются layer import и барьер preview. Заявку, оставшуюся после обрыва
// процесса, никто не снимет – её номер просто пропускается. lstat, а не existsSync: битая ссылка на
// месте слоя – тоже занято.
function claimRender(rendersDir, fileSystem = fs, { reportFile = () => null } = {}) {
  const exists = (file) => Boolean(file && fileSystem.lstatSync(file, { throwIfNoEntry: false }));
  for (let n = 1; ; n += 1) {
    const raw = path.join(rendersDir, `layer-${pad(n)}.raw.mp4`);
    const out = path.join(rendersDir, `layer-${pad(n)}.mp4`);
    const taken = () => exists(out) || exists(reportFile(n));
    if (taken()) continue;
    let descriptor;
    try {
      descriptor = fileSystem.openSync(raw, 'wx');
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      throw error;
    }
    fileSystem.closeSync(descriptor);
    if (taken()) {
      fileSystem.rmSync(raw, { force: true });
      continue;
    }
    return { n, raw, out, release: () => fileSystem.rmSync(raw, { force: true }) };
  }
}

// Манифест, который только что записал layer check этого запуска, – сразу в память: за минуты рендера
// параллельный layer check (после правки plan.js) переписал бы out/manifest.json, и G7 судил бы звук по
// чужим окнам эффектов. sha256 – от тех же байтов, что разобраны.
function readCheckedManifest(projectDir, layerDir) {
  const file = path.join(layerDir, 'out', 'manifest.json');
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    throw new Error('out/manifest.json пропал сразу после layer check (параллельный layer check этого слоя?) – запустите layer render ещё раз', { cause: error });
  }
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`out/manifest.json: неверный JSON (${error.message})`, { cause: error });
  }
  return { manifest, input: { role: 'manifest', path: relative(projectDir, file), sha256: hashBytes(bytes) } };
}

const AUDIO_RATE = 48000;

// Remotion слоя сразу пишет ограниченный yuv420p; у такого файла видео копируется. Для старого или
// неожиданного диапазона оставлена полная нормализация: диапазон входа ffmpeg берёт из его метки.
// Звук эффектов сохраняется
// (audioMode mix), но только на длину кадров: Remotion дописывает хвост AAC на 43–64 мс, правило владельца –
// резать его до длительности кадров. aresample async/first_pts кладёт звук на таймкод с 0 (поздний старт –
// тишина), apad + atrim дополняют и режут ровно до durationInFrames/fps. Режется только звук: -t или
// -shortest обрезали бы и видео и спрятали бы слишком длинный рендер от G6. Без звуковой дорожки -af не
// применяется.
function normalizeArgs(raw, out, samples) {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw,
    '-vf', 'scale=out_range=tv,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '14',
    '-af', `aresample=${AUDIO_RATE}:async=1:first_pts=0,apad,atrim=end_sample=${samples}`,
    '-c:a', 'aac', '-b:a', '192k', '-ar', String(AUDIO_RATE), '-ac', '2', out];
}

function normalizeAudioArgs(raw, out, samples) {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-c:v', 'copy',
    '-af', `aresample=${AUDIO_RATE}:async=1:first_pts=0,apad,atrim=end_sample=${samples}`,
    '-c:a', 'aac', '-b:a', '192k', '-ar', String(AUDIO_RATE), '-ac', '2', out];
}

// deps: log/warn – вывод; runToolImpl – запуск Remotion и ffmpeg (подмена рендера в тестах); checkImpl –
// layer check; acquireSlot – занятие слота общей очереди (контракт acquireHeavySlot).
async function run(options, deps = {}) {
  const log = deps.log || console.log;
  const warn = deps.warn || console.error;
  const runToolImpl = deps.runToolImpl || runTool;
  const checkImpl = deps.checkImpl || check.run;
  const { projectDir, layerDir, layerName, sourcePath } = resolveLayer(options);

  const checkOptions = { 'project-dir': projectDir, layer: layerName, ...(options.profile ? { profile: options.profile } : {}) };
  const runCheck = async () => {
    const code = await checkImpl(checkOptions, { log });
    if (code !== 0) warn('❌ рендер не запущен: сначала исправьте план слоя (отчёт layer check выше)');
    return code;
  };
  let code = await runCheck();
  if (code !== 0) return code;
  const config = heavyQueueConfig();
  if (options['no-wait']) config.waitMs = 0;
  const slot = await (deps.acquireSlot || acquireHeavySlot)({
    label: `layer render ${path.basename(projectDir)}/${layerName}`, config, log,
  });
  // Слот держится и во время нормализации/QA, до записи отчёта или отказа подготовки рендера.
  try {
    if (slot.waited) {
      log('Очередь освободилась – проверяю план слоя ещё раз: за время ожидания его могли поправить');
      code = await runCheck();
      if (code !== 0) return code;
    }
    const held = readCheckedManifest(projectDir, layerDir);

    const layer = readLayerJson(layerDir);
    const profileName = options.profile || layer.profile || 'avatar';
    const profile = getProfile(profileName);
    const samples = Math.round(layer.durationInFrames * AUDIO_RATE / layer.fps);
    if (!(Number.isSafeInteger(samples) && samples > 0)) throw new Error('layer.json: durationInFrames и fps должны быть числами больше 0');
    const remotion = resolveRemotionCommand(ROOT);
    const rendersDir = path.join(layerDir, 'renders');
    fs.mkdirSync(rendersDir, { recursive: true });
    if (!fs.lstatSync(rendersDir).isDirectory()) throw new Error(`${relative(projectDir, rendersDir)} должна быть папкой, а не ссылкой`);
    const reportName = (n) => `layer-${layerName}-render-${pad(n)}`;
    const claim = claimRender(rendersDir, fs, { reportFile: (n) => path.join(projectDir, 'qa', `${reportName(n)}.json`) });
    // Заявка снимается только после записи отчёта: иначе после сбоя без готового слоя второй рендер успел
    // бы занять этот номер до записи отчёта и потом перезаписать его.
    try {
      return renderClaimed({ projectDir, layerName, sourcePath, profile, profileName, held, claim, samples,
        reportName: reportName(claim.n), command: remotionLayerRenderCommand(remotion, {
          entry: path.join(layerDir, 'src', 'index.jsx'), composition: layer.composition, output: claim.raw, publicDir: path.join(layerDir, 'public'),
        }), runToolImpl, log, warn });
    } finally {
      claim.release();
    }
  } finally {
    slot.release();
  }
}

// Рендер под уже занятым номером: Remotion → нормализация → G6 и G7 → отчёт. Код выхода по отчёту.
function renderClaimed({ projectDir, layerName, sourcePath, profile, profileName, held, claim, samples, reportName, command, runToolImpl, log, warn }) {
  // С запуска Remotion любой отказ (сам рендер, нормализация, probe, декодирование, гейт, испорченный
  // манифест) – отчёт с error и код 2, а не «layer render отменён» без отчёта.
  let gates = [];
  let error = null;
  try {
    runToolImpl(command.command, command.args, { cwd: ROOT, stage: 'layer Remotion render',
      env: { ...process.env, [LIMITED_RANGE_ENV]: '1' } });
    const rawProbe = JSON.parse(captureTool('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=pix_fmt,color_range', '-of', 'json', claim.raw],
    { cwd: ROOT, stage: 'layer raw probe', maxBuffer: 64 * 1024 }));
    const video = rawProbe.streams?.[0];
    const conforming = video?.pix_fmt === 'yuv420p' && video?.color_range === 'tv';
    if (!conforming) warn('Remotion отдал full range – перекодирую видео');
    try {
      const args = (conforming ? normalizeAudioArgs : normalizeArgs)(claim.raw, claim.out, samples);
      runToolImpl('ffmpeg', args, { cwd: ROOT, stage: 'layer normalize' });
    } catch (caught) {
      fs.rmSync(claim.out, { force: true }); // недописанный слой этого номера – наш, после отказа он не нужен
      throw caught;
    }
    // G6 меряет видеопоток слоя, а не контейнер: звук теперь дополнен до полной длины и не должен прятать
    // короткое видео. Размер и fps – тем же probeVideo, что у исходника и у layer new.
    const layerMedia = probeMediaPath(claim.out, { stage: 'layer probe' });
    const layerProbe = { ...probeVideo(claim.out, { stage: 'layer probe' }), duration: layerMedia.videoDurationSec };
    const sourceProbe = probeVideo(sourcePath, { stage: 'layer source probe' });
    const sourceMedia = probeMediaPath(sourcePath, { stage: 'layer source probe' });
    const layerEnv = layerMedia.hasAudio ? envelopeDb(decodeAudio(claim.out)) : null;
    const sourceEnv = sourceMedia.hasAudio ? envelopeDb(decodeAudio(sourcePath)) : null;
    const { manifest } = held;
    gates = [
      gateLayerDuration({ layer: layerProbe, source: sourceProbe }, profile),
      gateVoiceLeak({ layerEnv, sourceEnv, audioMode: 'mix', cues: manifest?.cues?.kept, fps: manifest?.fps }, profile),
    ];
  } catch (caught) {
    gates = [];
    error = caught?.message ?? String(caught);
  }

  // inputs пишутся и при ошибке: слой первым (по его sha256 layer import находит этот отчёт), исходник и
  // манифест, по которому судил G7: sha256 байтов, прочитанных сразу после layer check этого запуска.
  // С отчётом layer check он не сверяется – рядом стоит вход того же вида, сравнить можно по ним.
  const inputs = [];
  try {
    if (fs.lstatSync(claim.out, { throwIfNoEntry: false })?.isFile()) {
      inputs.push({ role: 'layer', path: relative(projectDir, claim.out), sha256: sha256File(claim.out) });
    }
    inputs.push({ role: 'source', path: relative(projectDir, sourcePath), sha256: sha256File(sourcePath) });
  } catch (caught) {
    error ??= caught?.message ?? String(caught);
  }
  inputs.push(held.input);

  const report = buildReport({ kind: 'layer-render', layer: layerName, profile: profileName, gates, error, inputs });
  const paths = writeReport(projectDir, reportName, report);
  log(formatReport(report));
  log(`Отчёт: ${paths.textPath}`);
  const exitCode = exitCodeFor(report);
  if (exitCode === 0) log(`Дальше: automontage layer import --project-dir "${projectDir}" --file "${claim.out}"`);
  return exitCode;
}

module.exports = { FLAGS, claimRender, run };
