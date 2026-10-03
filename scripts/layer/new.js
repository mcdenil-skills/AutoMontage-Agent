const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { probeMediaPath, probeVideo } = require('../media-probe');
const { captureTool, runTool } = require('../process');
const { assertRoughCutSettled } = require('../project/rough-cut-model');
const { LAYER_NAME, formatNumber, nextLayerName, projectFrom, sha256File, writeJson } = require('./common');
const { copySfxLibrary, sfxLibraryDir } = require('./sfx-library');
const { transcriptPath, writeLayerWords } = require('./words');

const FLAGS = { 'project-dir': 'value', dir: 'value', profile: 'value' };
const PROFILES = ['avatar', 'live'];
const ENGINE_ROOT = path.join(__dirname, '..', '..');
const TEMPLATE = path.join(ENGINE_ROOT, 'templates', 'motion-layer');
const TEMPLATE_FILES = ['src/index.jsx', 'src/Root.jsx', 'src/plan.js', 'src/scenes.jsx', 'README.md'];
// Шрифты, которые выбирает scenes.jsx шаблона (FONTS), и их лицензии OFL.
const FONTS = ['Onest.ttf', 'OFL-Onest.txt', 'Oswald.ttf', 'OFL-Oswald.txt'];
// Папка слоя свежая: копия поверх уже лежащего файла – ошибка, а не тихая перезапись.
const { COPYFILE_EXCL, COPYFILE_FICLONE } = fs.constants;
// SIGHUP – закрытое окно терминала: без обработчика процесс умер бы с недостроенной папкой.
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const NO_VIDEO = 'в исходнике нет видеодорожки – layer new работает с видео-исходником';

// Есть ли в файле настоящая видеодорожка (обложка аудиофайла – attached_pic – не в счёт). Вызывается
// только когда probe уже отказал, чтобы назвать причину по-русски; сбой самого ffprobe – «не знаю».
function hasVideoTrack(file) {
  try {
    const { streams = [] } = JSON.parse(captureTool('ffprobe', ['-v', 'error', '-show_entries',
      'stream=codec_type:stream_disposition=attached_pic', '-of', 'json', file], { maxBuffer: 1024 * 1024, stage: 'layer source streams' }));
    return streams.some((stream) => stream.codec_type === 'video' && Number(stream.disposition?.attached_pic || 0) !== 1);
  } catch {
    return true;
  }
}

// Всё о исходнике – до захвата папки. Повёрнутый (телефонный) исходник отказывает: его кадр хранится
// в другой геометрии, чем показывается, и G6 с тем же probe разошёлся бы со слоем. Длина и частота –
// probeVideo (им же G6 меряет рендер): длина по контейнеру, Math.round. Последний кадр спикера –
// последний настоящий кадр видеодорожки: если звук длиннее видео, дальше SpeakerLayer держит его.
function inspectSource(sourcePath, manifest, { probeVideoImpl, probeMediaImpl }) {
  if (manifest.source?.mediaKind === 'audio') throw new Error(NO_VIDEO);
  let media;
  try {
    media = probeMediaImpl(sourcePath, { stage: 'layer source probe' });
  } catch (error) {
    if (!hasVideoTrack(sourcePath)) throw new Error(NO_VIDEO, { cause: error });
    throw error;
  }
  if (media.mediaKind !== 'video') throw new Error('исходник – картинка, а не видео: layer new работает с видео-исходником');
  if (media.rotation === 90 || media.rotation === 270) {
    throw new Error(`исходник повёрнут на ${media.rotation}° – сначала соберите мастер (automontage master --project-dir <папка> --edit edit/vNN-source.json) или перекодируйте его с поворотом в самих кадрах`);
  }
  const probe = probeVideoImpl(sourcePath);
  const durationInFrames = Math.round(probe.duration * probe.fps);
  if (!(durationInFrames >= 1)) throw new Error(`исходник короче одного кадра (${probe.duration} с при ${probe.fps} fps)`);
  const videoFrames = Math.round(media.videoDurationSec * probe.fps);
  const lastFrame = Math.max(0, Math.min(durationInFrames, videoFrames) - 1);
  return { fps: probe.fps, width: probe.width, height: probe.height, durationInFrames, lastFrame };
}

// Папка слоя занимается одним mkdir без recursive (родитель – папка проекта – уже есть): из двух
// одновременных `layer new` её получает ровно один, второй видит EEXIST. Автоматическое имя при
// гонке пересчитывается один раз (max+1 уже учтёт чужую папку); явное --dir другим не подменяется.
// Имя – motion-vNN без разделителей, поэтому mkdir не выходит за папку проекта.
function claimLayerDir(projectDir, requested) {
  const attempts = requested ? 1 : 2;
  for (let attempt = 1; ; attempt += 1) {
    const name = requested || nextLayerName(projectDir);
    const layerDir = path.join(projectDir, name);
    try {
      fs.mkdirSync(layerDir);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (attempt >= attempts) throw new Error(`папка ${name} уже существует – выберите другую через --dir`);
      continue;
    }
    const { dev, ino } = fs.lstatSync(layerDir);
    return { name, layerDir, identity: { dev, ino } };
  }
}

// Уборка после отказа или сигнала: удаляется только папка, которую занял этот запуск (та же dev/ino),
// вместе с тем, что он в неё успел положить. Если на её месте уже другая папка – не трогаем ничего.
// Никогда не бросает (зовётся и из обработчика сигнала): 'removed' | 'gone' | 'swapped' | {error}.
function releaseLayerDir({ layerDir, identity }) {
  try {
    const current = fs.lstatSync(layerDir, { throwIfNoEntry: false });
    if (!current) return 'gone';
    if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) return 'swapped';
    fs.rmSync(layerDir, { recursive: true, force: true });
    return 'removed';
  } catch (error) {
    return { error };
  }
}

function releaseNote({ name }, status) {
  if (status === 'swapped') return `папку ${name} подменили во время layer new – не удаляю её`;
  if (status?.error) return `не удалось убрать недостроенную папку ${name}: ${status.error.message}`;
  return null;
}

function interruptNote(signal, claim, status) {
  const cleanup = !claim ? 'папка слоя ещё не занята' : releaseNote(claim, status) || `недостроенная папка ${claim.name} удалена`;
  return `layer new прерван сигналом ${signal} – ${cleanup}`;
}

function withReleaseNote(error, claim, status) {
  const note = releaseNote(claim, status);
  return note ? new Error(`${error?.message ?? String(error)} (${note})`, { cause: error }) : error;
}

// Ctrl+C, SIGTERM или SIGHUP, пока слой собирается: обработчик убирает занятую папку (та же проверка
// dev/ino) и повторяет сигнал уже со стандартным действием – процесс завершается как прерванный, а не
// оставляет готовый с виду слой. Сборка синхронная, поэтому сигнал доходит до обработчика на первом
// обороте цикла событий после неё; settle() даёт этот оборот, пока обработчики ещё стоят.
// Обработчики снимаются только после уборки: Ctrl+C приходит дважды (от терминала и копией от внешнего
// automontage), и снятый заранее обработчик отдал бы вторую копию стандартному действию посреди rmSync.
// Строка в stderr – до повторного сигнала: он завершает процесс сразу, и throw в run() уже никто не
// напечатает. report не должен помешать уборке и сигналу, поэтому его сбой глотаем.
function interruptGuard({ signals, kill, exit, report }) {
  const state = { claim: null, interrupted: null, released: null };
  const handlers = SIGNALS.map((signal) => [signal, () => {
    if (state.interrupted) return;
    state.interrupted = signal;
    if (state.claim) state.released = releaseLayerDir(state.claim);
    try {
      report(interruptNote(signal, state.claim, state.released));
    } catch {
      // stderr закрыт (например, вместе с терминалом) – сигнал всё равно повторяем
    }
    stop();
    // На Windows повторить можно только SIGINT/SIGTERM/SIGKILL: SIGHUP (закрыли окно консоли) даёт
    // ENOSYS. Уборка уже сделана – выходим с тем кодом, что дал бы сам сигнал: 128 + его номер.
    try {
      kill(signal);
    } catch {
      exit(128 + (os.constants.signals[signal] || 1));
    }
  }]);
  function stop() {
    for (const [signal, handler] of handlers) signals.removeListener(signal, handler);
  }
  for (const [signal, handler] of handlers) signals.on(signal, handler);
  return { state, stop, settle: () => new Promise((resolve) => { setImmediate(resolve); }) };
}

function copyTemplate(layerDir) {
  for (const file of TEMPLATE_FILES) {
    fs.mkdirSync(path.dirname(path.join(layerDir, file)), { recursive: true });
    fs.copyFileSync(path.join(TEMPLATE, file), path.join(layerDir, file), COPYFILE_EXCL);
  }
}

function placeholders(layerDir, { width, height, fps }, runToolImpl) {
  const quiet = ['-hide_banner', '-loglevel', 'error', '-y'];
  fs.mkdirSync(path.join(layerDir, 'public', 'stock'), { recursive: true });
  fs.mkdirSync(path.join(layerDir, 'public', 'shots'), { recursive: true });
  runToolImpl('ffmpeg', [...quiet, '-f', 'lavfi', '-i', `gradients=s=${width}x${height}:r=${fps}:d=4:speed=0.03`,
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(layerDir, 'public', 'stock', 'placeholder.mp4')], { stage: 'layer placeholder stock' });
  runToolImpl('ffmpeg', [...quiet, '-f', 'lavfi', '-i', 'color=c=0xF4F6FA:s=1080x2400',
    '-vf', 'drawbox=x=60:y=60:w=960:h=140:color=0xDDE3EC:t=fill,drawbox=x=60:y=260:w=640:h=60:color=0xC7D0DC:t=fill,drawbox=x=60:y=380:w=960:h=900:color=0xE7ECF3:t=fill',
    '-frames:v', '1', path.join(layerDir, 'public', 'shots', 'placeholder.png')], { stage: 'layer placeholder screenshot' });
}

// Всё содержимое свежей папки слоя. Любой отказ здесь – и run() убирает папку целиком.
function scaffold({ projectDir, manifest, sourcePath, layerDir, source, profile, libraryDir, runToolImpl, notes }) {
  fs.mkdirSync(path.join(layerDir, 'public', 'fonts'), { recursive: true });
  copyTemplate(layerDir);
  writeJson(path.join(layerDir, 'spelling.json'), {});
  writeLayerWords(projectDir, manifest, layerDir, { durationSec: source.durationInFrames / source.fps, warn: (line) => notes.push(line) });
  const speaker = path.join(layerDir, 'public', 'speaker.mp4');
  // Размер и mtime исходника – до копии: если файл меняют во время копирования, его mtime уйдёт вперёд
  // записанного, и следующая команда пересчитает sha256, а не поверит устаревшим числам.
  const { size, mtimeMs } = fs.statSync(sourcePath);
  fs.copyFileSync(sourcePath, speaker, COPYFILE_EXCL | COPYFILE_FICLONE);
  const speakerSha = sha256File(speaker);
  const { localPath, revision } = manifest.source;
  for (const font of FONTS) {
    fs.copyFileSync(path.join(ENGINE_ROOT, 'public', 'fonts', font), path.join(layerDir, 'public', 'fonts', font), COPYFILE_EXCL);
  }
  const sfx = copySfxLibrary(libraryDir, path.join(layerDir, 'public', 'sfx'));
  fs.writeFileSync(path.join(layerDir, 'src', 'sfx-library.js'), `// Сгенерировано automontage layer new.\nexport default ${JSON.stringify(sfx.library)};\n`);
  placeholders(layerDir, source, runToolImpl);
  fs.writeFileSync(path.join(layerDir, 'public', 'SOURCE.md'), [
    '# Источники материалов слоя', '',
    '| Файл | Лицензия / автор | Источник | SHA-256 или команда |', '|---|---|---|---|',
    `| \`speaker.mp4\` | исходник проекта | \`${localPath}\`${Number.isInteger(revision) ? `, ревизия ${revision}` : ''} | ${speakerSha} |`,
    '| `fonts/Onest.ttf`, `fonts/Oswald.ttf` | SIL OFL 1.1 (`fonts/OFL-*.txt`) | Google Fonts | копия из движка |',
    ...sfx.sourceRows,
    '| `stock/placeholder.mp4`, `shots/placeholder.png` | заглушки, заменить | ffmpeg lavfi | automontage layer new |', '',
  ].join('\n'));
  // layer.json – последним: по нему папка считается собранным слоем (layer check/render/words без него
  // отказывают), поэтому оборванная сборка никогда не выглядит готовой.
  writeJson(path.join(layerDir, 'layer.json'), {
    version: 1, composition: 'Layer', fps: source.fps, width: source.width, height: source.height,
    durationInFrames: source.durationInFrames,
    // В project.json точки лица нет – стартовая точка по умолчанию, агент уточняет её в layer.json.
    face: { x: Math.round(source.width * 0.5), y: Math.round(source.height * 0.41) },
    profile, sfxMasterDb: -5, speaker: { src: 'speaker.mp4', lastFrame: source.lastFrame },
    // Один исходник на слой: layer words и layer check сверяют с ним текущий исходник проекта
    // (assertLayerSource); size и mtimeMs избавляют от sha256 неизменившегося файла.
    source: { localPath, sha256: speakerSha, size, mtimeMs, ...(Number.isInteger(revision) ? { revision } : {}) },
  });
  return sfx;
}

async function run(options, deps = {}) {
  const log = deps.log || console.log;
  const warn = deps.warn || console.warn;
  const reportError = deps.error || console.error;
  const runToolImpl = deps.runToolImpl || runTool;
  const { projectDir, manifest, sourcePath } = projectFrom(options);
  // Слой строят на подтверждённых таймингах: до папки слоя, звуков и пробы исходника.
  assertRoughCutSettled(manifest, 'layer new', { projectDir });
  if (options.dir !== undefined && !LAYER_NAME.test(options.dir)) throw new Error('--dir должен быть вида motion-v01');
  const profile = options.profile || 'avatar';
  if (!PROFILES.includes(profile)) throw new Error('--profile: avatar или live');
  // Всё, что может отказать без записи, – до захвата папки: путь к звукам, транскрипт, исходник.
  const libraryDir = sfxLibraryDir(deps.env || process.env, deps.defaultSfxDir);
  transcriptPath(projectDir, manifest);
  const source = inspectSource(sourcePath, manifest, { probeVideoImpl: deps.probeVideo || probeVideo, probeMediaImpl: deps.probeMedia || probeMediaPath });

  if (Math.min(source.width, source.height) > 1080) {
    warn(`⚠️ исходник ${source.width}×${source.height} больше рабочего 1080p – слой будет рендериться в родном размере и в разы дольше. Соберите master (automontage master --project-dir "${projectDir}" --edit edit/vNN-source.json); если правок нарезки нет – edit с одним keep на весь ролик`);
  }

  const guard = interruptGuard({
    signals: deps.signals || process,
    kill: deps.kill || ((signal) => process.kill(process.pid, signal)),
    exit: deps.exit || ((code) => process.exit(code)),
    report: reportError,
  });
  const notes = [];
  let claim;
  let sfx;
  let failure = null;
  try {
    claim = claimLayerDir(projectDir, options.dir);
    guard.state.claim = claim;
    try {
      sfx = scaffold({ projectDir, manifest, sourcePath, layerDir: claim.layerDir, source, profile, libraryDir, runToolImpl, notes });
    } catch (error) {
      failure = withReleaseNote(error, claim, releaseLayerDir(claim));
    }
    await guard.settle();
  } finally {
    guard.stop();
  }
  const { interrupted, released } = guard.state;
  if (interrupted) throw new Error(interruptNote(interrupted, claim, released));
  if (failure) throw failure;
  const { name } = claim;
  for (const note of notes) warn(note);
  // Папки звуков нет (свежий клон, worktree): слой без эффектов допустим, но не молча.
  if (sfx.missing) {
    warn(`⚠️ библиотеки звуков нет: ${libraryDir} – слой ${name} собран без звуковых эффектов. Положите звуки <имя>.wav в эту папку или укажите папку библиотеки в AUTOMONTAGE_SFX_DIR, затем создайте новый слой`);
  }
  if (sfx.skipped.length) {
    warn(`⚠️ не скопированы из библиотеки звуков (имя не вида pop-soft.wav): ${sfx.skipped.join(', ')}`);
  }
  if (sfx.unknownMeta.length) {
    warn(`⚠️ library.json описывает звуки без файла в библиотеке: ${sfx.unknownMeta.join(', ')}`);
  }
  log(`✅ слой ${name}: ${source.durationInFrames} кадров ${source.width}×${source.height}@${formatNumber(source.fps)}, звуков в библиотеке: ${Object.keys(sfx.library.sounds).length}`);
  log(`Дальше: правка ${name}/src/plan.js → automontage layer check --project-dir "${projectDir}" --layer ${name}`);
  return 0;
}

module.exports = { FLAGS, run };
