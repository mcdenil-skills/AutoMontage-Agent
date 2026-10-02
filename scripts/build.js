#!/usr/bin/env node
// Пайплайн монтажа: видео → транскрипт → субтитры → (черновой лист) → рендер.
// Использование:
//   node scripts/build.js <video> [--theme craft] [--scenario file.json]
//                                 [--id name] [--frames N] [--model base]
//                                 [--template lesson] [--no-transcribe] [--title "..."]
// Опции шаблона/транскрипции:
//   --template lesson : сначала собрать ТЗ из 7 готовых сцен, после утверждения
//                       отрендерить его через ReelScenes. Тема по умолчанию: lesson-neutral.
//   --aspect source|vertical|horizontal : формат lesson; по умолчанию как у исходника.
//   --brief file.json : отрендерить утверждённый монтажный лист lesson.
//   --no-transcribe   : пропустить whisper (не качать модель); транскрипт = пустой.
//                       Осмысленно только с --scenario (блоки берутся из готового листа).
//   --title "текст"   : заголовок видео для шаблона lesson (плашка сверху).
const fs = require('fs');
const { randomUUID } = require('node:crypto');
const path = require('path');
const {
  ROOT,
  tmp,
  python,
  resolveRemotionCommand,
} = require('./env');
const {
  audioExtractionCommand,
  frameAnalysisCommand,
  paletteCommand,
  reframeCommand,
  remotionRenderCommand,
  videoProbeCommand,
} = require('./build-commands');
const { acquireHeavySlotSync, heavyQueueConfig } = require('./heavy-queue');
const { finiteNumber, parseBuildOptions } = require('./build-options');
const { parseVideoProbe } = require('./media-probe');
const { resolveSourceTiming } = require('./source-timing');
const { captureTool, runNodeTool, runTool } = require('./process');
const { loadExtTheme } = require('./load-ext-theme');
const { resolveOutputGeometry } = require('./lesson/aspect');
const { REMOTION_AUDIO_ADVANCE_MS } = require('./finish-audio');
const {
  LESSON_DEFAULT_THEME,
  assertLessonOptions,
  buildGenBriefArgs,
  getLessonAction,
  prepareLessonRender,
} = require('./lesson/workflow');
const {
  copyOutputFile,
  createBuildContext,
} = require('./project/build-context');
const { claimAndRemoveOwnedPath } = require('./project/owned-removal');
const {
  publishBriefRevision,
  runRenderLifecycle,
} = require('./project/workspace');
const { withPublicMediaLease } = require('./public-media');
const { withRenderMediaBundle } = require('./render-media-bundle');
const { verifyBriefBrollMedia } = require('./lesson/broll-media-files');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const inputVideo = args[0];
if (!inputVideo || !fs.existsSync(path.resolve(process.cwd(), inputVideo))) {
  console.error('❌ укажи существующий видеофайл');
  process.exit(1);
}

let buildOptions;
try {
  buildOptions = parseBuildOptions(args);
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exit(1);
}

// шаблон вывода: 'dynamic' (reel по умолчанию) или 'lesson' (урок-презентация)
const template = opt('template', 'dynamic');
const isLesson = template === 'lesson';
const lessonBriefFile = opt('brief', null);
const lessonAction = getLessonAction({ isLesson, briefFile: lessonBriefFile });
const noTranscribe = args.includes('--no-transcribe');
const title = opt('title', 'ВИДЕО');
const aspect = opt('aspect', 'source');
const faceX = opt('face-x', null);
const faceY = opt('face-y', null);
const facePos = faceX != null || faceY != null
  ? { x: Number(faceX ?? 0.5), y: Number(faceY ?? 0.5) }
  : null;
const faceZoom = opt('face-zoom', null) == null ? null : Number(opt('face-zoom', null));
if (facePos && (![facePos.x, facePos.y].every(Number.isFinite)
  || facePos.x < 0 || facePos.x > 1 || facePos.y < 0 || facePos.y > 1)) {
  console.error('❌ --face-x и --face-y должны быть числами от 0 до 1');
  process.exit(1);
}
if (faceZoom != null && (!Number.isFinite(faceZoom) || faceZoom < 1 || faceZoom > 2)) {
  console.error('❌ --face-zoom должен быть числом от 1 до 2');
  process.exit(1);
}
try {
  assertLessonOptions({ isLesson, args });
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exit(1);
}

// тема по умолчанию зависит от шаблона: lesson -> lesson-neutral, иначе craft
const theme = opt('theme', isLesson ? LESSON_DEFAULT_THEME : 'craft');
const id = opt('id', 'out');
const outDir = opt('outdir', null);           // куда положить финал (по умолчанию out/ внутри пакета)
const projectName = opt('project', null);
const projectDir = opt('project-dir', null);
const versionLabel = opt('version-label', 'render');
if (projectName && projectDir) {
  console.error('❌ используй только один флаг: --project или --project-dir');
  process.exit(1);
}
let buildContext;
try {
  buildContext = createBuildContext({
    root: ROOT,
    cwd: process.cwd(),
    video: inputVideo,
    projectName,
    projectDir,
    versionLabel,
    action: lessonAction === 'plan' ? 'plan' : 'render',
    kind: isLesson ? 'lesson' : 'scenario',
    id,
  });
} catch (error) {
  console.error(`❌ проект не подготовлен: ${error.message}`);
  process.exit(1);
}
let video = buildContext.video;
const transcriptPath = buildContext.paths.transcript;
const captionsPath = buildContext.paths.captions;
const PY = lessonAction === 'render' ? null : python();
const audioWav = tmp(`${id}_audio.wav`);
const model = opt('model', 'large-v3-turbo');
const framesOverride = buildOptions.framesOverride;
const scenarioFile = opt('scenario', null);

const log = (m) => console.log('· ' + m);
const runNodeCapture = (script, scriptArgs, stage = script) => captureTool(
  process.execPath,
  [path.join(ROOT, 'scripts', script), ...scriptArgs.map(String)],
  { cwd: ROOT, stage, maxBuffer: 16 * 1024 * 1024 },
).trim();
const remotion = resolveRemotionCommand();

function snapshotGeneratedTemp(filePath) {
  try {
    const before = fs.lstatSync(filePath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) return null;
    const bytes = fs.readFileSync(filePath);
    const stat = fs.lstatSync(filePath, { bigint: true });
    if (stat.dev !== before.dev || stat.ino !== before.ino
      || stat.size !== before.size || stat.mtimeNs !== before.mtimeNs) {
      throw new Error('generated lesson temporary file changed while recording ownership');
    }
    return {
      filePath,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      bytes,
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function cleanupGeneratedTemps(snapshots) {
  let identityError = null;
  for (const snapshot of snapshots.filter(Boolean)) {
    try {
      if (!claimAndRemoveOwnedPath({
        target: snapshot.filePath,
        expected: snapshot,
        fileSystem: fs,
      })) identityError ||= new Error('generated lesson temporary file identity changed');
    } catch (error) {
      identityError ||= error;
    }
  }
  if (identityError) throw identityError;
}

// ── ранние проверки (до тяжёлых шагов: транскрипции, рендера) ──
// Ключ нужен только для нового ТЗ. Утверждённый brief рендерится без LLM.
if (lessonAction === 'plan' && !process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
  console.error('❌ для шаблона lesson нужен ANTHROPIC_API_KEY или OPENAI_API_KEY: '
    + 'gen-brief собирает черновик ТЗ из речи. Задай ключ в окружении и повтори.');
  process.exit(1);
}
// --no-transcribe без готового листа даст пустой ролик (блоки берутся из субтитров).
if (noTranscribe && !scenarioFile && !isLesson) {
  log('⚠️ --no-transcribe без --scenario: транскрипт будет пустым, блоки взять неоткуда – ролик выйдет почти пустым.');
}

// 1. ffprobe
const sourceProbeCommand = videoProbeCommand(video);
const sourceProbe = parseVideoProbe(captureTool(
  sourceProbeCommand.command,
  sourceProbeCommand.args,
  { cwd: ROOT, stage: 'source ffprobe', maxBuffer: 4 * 1024 * 1024 },
), 'source ffprobe');
let FPS = sourceProbe.fps;
let W = sourceProbe.width;
let H = sourceProbe.height;
let DUR2 = sourceProbe.duration;
log(`видео ${W}x${H} @ ${FPS}fps, ${DUR2.toFixed(1)}с (тема: ${theme})`);

// 1b. (опц.) reframe 16:9 → 9:16 по лицу (Фаза 3.1)
let video1 = video;
if (buildOptions.reframeMode) {
  const rmode = buildOptions.reframeMode;
  log(`reframe → вертикаль (${rmode})…`);
  const rOut = tmp(`${id}_reframe.mp4`);
  const command = reframeCommand(PY, ROOT, video, rOut, rmode);
  runTool(command.command, command.args, { cwd: ROOT, stage: 'reframe' });
  video1 = rOut;
  const probeCommand = videoProbeCommand(rOut);
  const reframed = parseVideoProbe(captureTool(
    probeCommand.command,
    probeCommand.args,
    { cwd: ROOT, stage: 'reframe ffprobe', maxBuffer: 4 * 1024 * 1024 },
  ), 'reframe ffprobe');
  W = reframed.width;
  H = reframed.height;
  FPS = reframed.fps;
  DUR2 = reframed.duration;
}

// 2-3. Для утверждённого lesson brief повторная транскрипция не нужна.
if (lessonAction === 'render') {
  log('использую утверждённый brief: транскрипцию пропускаю');
} else {
  log('извлекаю аудио…');
  const command = audioExtractionCommand(video1, audioWav);
  runTool(command.command, command.args, { cwd: ROOT, stage: 'audio extraction' });

  if (noTranscribe) {
    log('транскрипцию пропускаю (--no-transcribe): пишу пустой транскрипт');
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, '[]');
  } else {
    log('транскрибирую (faster-whisper)…');
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    runTool(PY, [
      path.join(ROOT, 'scripts/transcribe.py'),
      audioWav,
      transcriptPath,
      model,
    ], { cwd: ROOT, stage: 'transcription' });
  }
}

// 3b. (опц.) tighten: рез пауз + слов-паразитов
let srcVideo = video1;
if (args.includes('--tighten') && noTranscribe) {
  log('⚠️ --tighten пропущен: транскрипт пуст (--no-transcribe), уплотнять нечего.');
} else if (args.includes('--tighten')) {
  log('уплотняю (паузы + слова-паразиты)…');
  const tOut = tmp(`${id}_tight.mp4`);
  runNodeTool(path.join(ROOT, 'scripts/tighten.js'), [
    video1,
    transcriptPath,
    tOut,
    transcriptPath,
  ], { cwd: ROOT, stage: 'tighten' });
  srcVideo = tOut;
  // пересчитать длительность/кадры по уплотнённому видео
  const probeCommand = videoProbeCommand(tOut);
  const tightened = parseVideoProbe(captureTool(
    probeCommand.command,
    probeCommand.args,
    { cwd: ROOT, stage: 'tighten ffprobe', maxBuffer: 4 * 1024 * 1024 },
  ), 'tighten ffprobe');
  FPS = tightened.fps;
  DUR2 = tightened.duration;
}
const { durationInFrames: durF } = resolveSourceTiming({
  fps: FPS,
  duration: DUR2,
  framesOverride,
});

// ── общий резолвер темы (строка встроенной темы или объект внешнего бренд-пака) ──
function resolveTheme(name) {
  try {
    const ext = loadExtTheme(name);
    if (ext) { log(`внешняя тема "${name}" загружена из THEMES_EXT`); return ext; }
  } catch (e) { console.error('❌ ' + e.message); process.exit(1); }
  return name;
}

// ШАБЛОН lesson, шаг 1: собрать ТЗ и остановиться до утверждения.
if (lessonAction === 'plan') {
  const geometry = resolveOutputGeometry({
    sourceWidth: W,
    sourceHeight: H,
    sourceFps: FPS,
    aspect,
  });
  const generationId = randomUUID();
  const briefPath = buildContext.project
    ? tmp(`automontage-${generationId}.lesson.json`)
    : buildContext.paths.briefJson;
  const markdownPath = buildContext.project
    ? tmp(`automontage-${generationId}.lesson.md`)
    : buildContext.paths.briefMarkdown;
  const publicBrollDir = path.join(ROOT, 'public/broll');
  const availableBroll = fs.existsSync(publicBrollDir)
    ? fs.readdirSync(publicBrollDir)
      .filter((file) => /\.(avif|gif|jpe?g|png|webp)$/i.test(file))
      .map((file) => `broll/${file}`)
    : [];
  const genArgs = buildGenBriefArgs({
    transcriptPath,
    briefPath,
    markdownPath,
    theme,
    title,
    geometry,
    duration: DUR2,
    source: path.resolve(srcVideo),
    maxScenes: buildOptions.maxScenes,
    availableBroll,
    facePos,
    faceZoom,
  });
  fs.mkdirSync(path.dirname(briefPath), { recursive: true });
  log(`собираю черновик ТЗ из 7 готовых сцен (${geometry.width}x${geometry.height})…`);
  let generationError = null;
  let generatedTemps = [];
  try {
    runNodeTool(path.join(ROOT, 'scripts/gen-brief.js'), genArgs.map(String), {
      cwd: ROOT,
      env: process.env,
      stage: 'gen-brief',
    });
  } catch (error) {
    generationError = error;
  } finally {
    if (buildContext.project) {
      generatedTemps = [snapshotGeneratedTemp(briefPath), snapshotGeneratedTemp(markdownPath)];
    }
  }
  let publishedBrief = { jsonPath: briefPath, markdownPath };
  try {
    if (generationError) throw generationError;
    if (buildContext.project) {
      const generatedBrief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
      const generatedMarkdown = fs.readFileSync(markdownPath, 'utf8');
      publishedBrief = publishBriefRevision(buildContext.project, {
        kind: 'lesson',
        brief: generatedBrief,
        markdown: generatedMarkdown,
        status: 'draft',
        theme,
        aspect: geometry.aspect,
      });
    }
  } catch (error) {
    generationError = error;
  } finally {
    if (buildContext.project) {
      try {
        cleanupGeneratedTemps(generatedTemps);
      } catch (cleanupError) {
        generationError ||= cleanupError;
      }
    }
  }
  if (generationError) {
    console.error(`❌ gen-brief не собрал ТЗ: ${generationError.message}`);
    process.exit(1);
  }
  console.log('\n⏸ Черновик готов. Покажи Markdown-ТЗ Дмитрию и дождись явного «утверждаю».');
  console.log(`   ТЗ: ${publishedBrief.markdownPath}`);
  console.log(`   JSON: ${publishedBrief.jsonPath}`);
  console.log('   После утверждения смени status на approved и перезапусти с --brief <JSON>.');
  process.exit(0);
}

// ШАБЛОН lesson, шаг 2: рендер только утверждённого JSON через ReelScenes.
if (lessonAction === 'render') {
  const briefPath = buildContext.resolveBrief(lessonBriefFile);
  if (!fs.existsSync(briefPath)) {
    console.error(`❌ утверждённый brief не найден: ${briefPath}`);
    process.exit(1);
  }
  const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
  if (args.includes('--aspect')) {
    const requested = resolveOutputGeometry({
      sourceWidth: W,
      sourceHeight: H,
      sourceFps: FPS,
      aspect,
    }).aspect;
    if (requested !== brief.output?.aspect) {
      console.error('❌ aspect отличается от утверждённого ТЗ. Собери и утверди новый brief.');
      process.exit(1);
    }
  }
  if (args.includes('--theme') && theme !== brief.theme) {
    console.error('❌ тема отличается от утверждённого ТЗ. Собери и утверди новый brief.');
    process.exit(1);
  }

  let prepared;
  try {
    prepared = prepareLessonRender({
      brief,
      theme: resolveTheme(brief.theme),
      sourceVideo: srcVideo,
      framesOverride,
    });
    const mediaVerification = verifyBriefBrollMedia({
      root: ROOT, workspace: buildContext.project, brief,
    });
    try { mediaVerification.assertCurrent(); } finally { mediaVerification.close(); }
  } catch (error) {
    console.error(`❌ рендер lesson отменён: ${error.message}`);
    process.exit(1);
  }

  if (prepared.music) {
    if (!fs.existsSync(prepared.music.sourcePath)) {
      console.error(`❌ музыка из утверждённого ТЗ не найдена: ${prepared.music.sourcePath}`);
      process.exit(1);
    }
  }

  const lessonPropsPath = buildContext.paths.props;
  const rawMp4L = buildContext.paths.raw;
  const outMp4L = buildContext.paths.final;
  const lessonRender = buildContext.project
    ? {
      version: buildContext.paths.render.version,
      label: buildContext.paths.render.label,
      dir: buildContext.paths.render.dir,
      briefPath,
    }
    : null;
  const lessonSlot = acquireHeavySlotSync({
    label: `final ${buildContext.project ? path.basename(buildContext.project.dir) : id}`,
    config: heavyQueueConfig(), log,
  });
  try {
    let finalL = runRenderLifecycle(buildContext.project, lessonRender, () => (
      withRenderMediaBundle({
        root: ROOT,
        workspace: buildContext.project,
        props: prepared.props,
        approvedBrief: prepared.approvedMedia.brief,
        sourcePath: prepared.approvedMedia.sourcePath,
        sourceAlias: prepared.approvedMedia.sourceAlias,
        namespace: buildContext.project ? buildContext.project.manifest.slug : 'dynamic',
      }, (lease) => {
        fs.mkdirSync(path.dirname(lessonPropsPath), { recursive: true });
        fs.writeFileSync(lessonPropsPath, JSON.stringify(lease.props, null, 2));
        log(`рендер утверждённого ТЗ (${prepared.composition}) → ${rawMp4L} …`);
        const renderCommand = remotionRenderCommand(remotion, {
          entry: 'src/index.js',
          composition: prepared.composition,
          output: rawMp4L,
          props: lessonPropsPath,
          publicDir: lease.publicDirectory,
        });
        runTool(renderCommand.command, renderCommand.args, { cwd: ROOT, stage: 'lesson render' });

        log('финиш (громкость + картинка)…');
        runNodeTool(path.join(ROOT, 'scripts/finish.js'), [
          rawMp4L,
          outMp4L,
          '--hdrfix',
          'auto',
          '--audio-advance-ms',
          String(REMOTION_AUDIO_ADVANCE_MS),
        ], { cwd: ROOT, stage: 'lesson finish' });

        if (prepared.music) {
          log('подмешиваю слышимую музыку с ducking…');
          const mixedMp4L = tmp(`${id}_lesson_music.mp4`);
          runNodeTool(path.join(ROOT, 'scripts/mix-music.js'), [
            outMp4L,
            prepared.music.sourcePath,
            mixedMp4L,
            ...prepared.music.mixArgs,
          ], { cwd: ROOT, stage: 'lesson music mix' });
          fs.copyFileSync(mixedMp4L, outMp4L);
          fs.unlinkSync(mixedMp4L);
        }
        return outMp4L;
      })
    ));
    if (outDir) {
      const outputName = buildContext.project ? buildContext.project.manifest.slug : id;
      finalL = copyOutputFile({
        cwd: process.cwd(),
        outdir: outDir,
        outputName,
        source: finalL,
      });
    }
    console.log(`\n✅ готово по утверждённому ТЗ: ${finalL}  (${prepared.props.width}x${prepared.props.height})`);
    console.log('   отправлять как ДОКУМЕНТ [ФАЙЛ:] иначе Telegram сплющит вертикаль.');
  } finally { lessonSlot.release(); }
  process.exit(0);
}

// 4. субтитры
runNodeCapture('build-captions.js', [transcriptPath, captionsPath]);
const { CAPTIONS } = requireFresh(captionsPath);
log(`субтитров: ${CAPTIONS.length} групп`);

// 5. монтажный лист (+ зум-ритм beatZoom)
// приоритет: флаг --beat → из scenario-файла → выкл по умолчанию
let blocks, beatZoom = false, beatSec = buildOptions.beatSec, stillWindows = [];
let activeScenarioPath = null;
if (scenarioFile) {
  activeScenarioPath = buildContext.resolveBrief(scenarioFile);
  const sc = JSON.parse(fs.readFileSync(activeScenarioPath, 'utf8'));
  blocks = sc.blocks;
  if (sc.beatZoom != null) beatZoom = !!sc.beatZoom;
  if (sc.beatSec != null) {
    beatSec = finiteNumber(sc.beatSec, 'scenario beatSec', { min: 0.1, max: 60 });
  }
  if (sc.stillWindows != null) stillWindows = sc.stillWindows;
  log(`лист из файла: ${blocks.length} блоков`);
} else {
  blocks = draftScenario(CAPTIONS);
  const draftScenarioBrief = { source: 'source.mp4', theme, beatZoom, beatSec, blocks };
  let draftPath = buildContext.paths.scenarioJson;
  if (buildContext.project) {
    const published = publishBriefRevision(buildContext.project, {
      kind: 'scenario',
      brief: draftScenarioBrief,
      status: 'draft',
      theme,
      aspect: 'source',
    });
    draftPath = published.jsonPath;
  } else {
    fs.mkdirSync(path.dirname(draftPath), { recursive: true });
    fs.writeFileSync(draftPath, JSON.stringify(draftScenarioBrief, null, 2));
  }
  activeScenarioPath = draftPath;
  log(`черновой лист → ${draftPath} (${blocks.length} блоков, поправь и перезапусти с --scenario)`);
}
if (args.includes('--beat')) beatZoom = true;   // «ритмичный зум / режь динамику»
if (beatZoom) log(`зум-ритм ВКЛ (каждые ${beatSec}с)`);

// 5c. (опц.) autopos – адаптивные позиции акцентных плашек по кадру (Фаза 4.1)
if (args.includes('--autopos')) {
  const ACC = ['InfoCard', 'CounterCard', 'SubtitleCard', 'CTACard'];
  const acc = blocks.filter((b) => ACC.includes(b.type));
  const slots = acc.map((b) => b.start).join(',');
  if (slots) {
    try {
      const placeJson = tmp(`${id}_place.json`);
      const command = frameAnalysisCommand(PY, ROOT, srcVideo, slots, placeJson);
      runTool(command.command, command.args, { cwd: ROOT, stage: 'frame analysis' });
      const place = JSON.parse(fs.readFileSync(placeJson, 'utf8'));
      acc.forEach((b, i) => { if (place[i] && place[i].pos) b.pos = place[i].pos; });
      log(`autopos: позиции плашек расставлены по кадру (${acc.length})`);
    } catch (e) { log('⚠️ autopos не сработал: ' + e.message.split('\n')[0]); }
  }
}

// 5c. (опц.) внешний бренд-пак – тема из THEMES_EXT/<id>/theme.json (приватный стиль)
let themeVal = resolveTheme(theme);

// 5d. (опц.) autotheme – тема из палитры видео (Фаза 4.4-4.6)
if (args.includes('--autotheme')) {
  try {
    const bl = buildOptions.brandLock;
    const command = paletteCommand(ROOT, srcVideo, bl);
    const out = captureTool(command.command, command.args, {
      cwd: ROOT,
      stage: 'autotheme palette',
      maxBuffer: 16 * 1024 * 1024,
    });
    themeVal = JSON.parse(out.split('// ── diagnostics')[0].trim());
    log(`autotheme: тема сгенерирована из палитры видео (brandLock ${bl})`);
  } catch (e) { log('⚠️ autotheme не сработал: ' + e.message.split('\n')[0]); }
}

// 7. props
const props = { source: 'source.mp4', theme: themeVal, blocks, width: W, height: H, fps: FPS, durationInFrames: durF, beatZoom, beatSec, stillWindows };

// 7b. валидация листа ДО рендера (Фаза 2.1)
const { validate } = require('./validate');
const vr = validate(props);
if (!vr.ok) {
  console.error('❌ монтажный лист невалиден – рендер отменён:');
  vr.errors.forEach((e) => console.error('  · ' + e));
  process.exit(1);
}
log('монтажный лист валиден ✓');

const dynamicSlot = acquireHeavySlotSync({
  label: `final ${buildContext.project ? path.basename(buildContext.project.dir) : id}`,
  config: heavyQueueConfig(), log,
});
let finalPath;
try {
  finalPath = withPublicMediaLease({
    root: ROOT,
    sourcePath: srcVideo,
    namespace: buildContext.project ? buildContext.project.manifest.slug : 'dynamic',
  }, (lease) => {
    props.source = lease.publicPath;
    const propsPath = buildContext.paths.props;
    fs.mkdirSync(path.dirname(propsPath), { recursive: true });
    fs.writeFileSync(propsPath, JSON.stringify(props));

    // 7c. гейт качества листа (Фаза 3.2) – предупреждение, не блокер
    try {
      const g = runNodeCapture('quality-gate.js', [propsPath]);
      const warn = g.split('\n').filter((l) => l.includes('⚠'));
      if (warn.length) { log('гейт качества – замечания:'); warn.forEach((w) => console.log('  ' + w.trim())); }
      else log('гейт качества: чисто ✓');
    } catch (e) { /* FAIL не блокирует, но покажем */ if (e.stdout) console.log(e.stdout.toString()); }

    // 7d. гейт динамики: «динамика или слайд-шоу» (docs/editing-rules.md)
    try {
      const g = runNodeCapture('dynamic-gate.js', [propsPath, transcriptPath]);
      const verdict = g.split('\n').find((l) => l.includes('Динамика листа')) || '';
      const warn = g.split('\n').filter((l) => l.includes('⚠'));
      if (verdict) log(verdict.trim());
      warn.forEach((w) => console.log('  ' + w.trim()));
    } catch (e) { if (e.stdout) { log('⚠️ динамика: похоже на слайд-шоу – стоит добавить событий'); console.log(e.stdout.toString().split('\n').filter((l) => l.includes('⚠')).join('\n')); } }

    // 8. рендер (порциями для длинных – Фаза 3.3)
    const rawMp4 = buildContext.paths.raw;
    const outMp4 = buildContext.paths.final;
    const dynamicRender = buildContext.project
      ? {
        version: buildContext.paths.render.version,
        label: buildContext.paths.render.label,
        dir: buildContext.paths.render.dir,
        briefPath: activeScenarioPath,
      }
      : null;
    let final = runRenderLifecycle(buildContext.project, dynamicRender, () => {
    log(`рендер → ${rawMp4} …`);
    if (durF > 540) {
      log('длинный ролик – рендерю порциями (resume при сбое)');
      runNodeTool(path.join(ROOT, 'scripts/render-chunks.js'), [
        'Dynamic',
        propsPath,
        rawMp4,
        String(durF),
        '--chunk',
        '300',
        '--audio',
        lease.absolutePath,
      ], { cwd: ROOT, stage: 'chunk render' });
    } else {
      const renderCommand = remotionRenderCommand(remotion, {
        entry: 'src/index.js',
        composition: 'Dynamic',
        output: rawMp4,
        props: propsPath,
      });
      runTool(renderCommand.command, renderCommand.args, { cwd: ROOT, stage: 'dynamic render' });
    }

    // 9. финиш-проход: громкость -14 LUFS (+ авто HDR→SDR)
    log('финиш (громкость + картинка)…');
    runNodeTool(path.join(ROOT, 'scripts/finish.js'), [
      rawMp4,
      outMp4,
      '--hdrfix',
      'auto',
    ], { cwd: ROOT, stage: 'dynamic finish' });

    // 10. (опц.) фоновая музыка с ducking (Фаза 2.2)
    if (props.audio && props.audio.music && props.audio.music.file) {
      const m = props.audio.music;
      const d = m.ducking || {};
      const musPath = path.isAbsolute(m.file) ? m.file : path.join(ROOT, m.file);
      if (fs.existsSync(musPath)) {
        log('подмешиваю музыку (ducking)…');
        const flags = [];
        if (m.gain_db != null) flags.push('--gain', String(m.gain_db));
        if (d.threshold_db != null) {
          flags.push('--threshold', Math.pow(10, d.threshold_db / 20).toFixed(4));
        }
        if (d.reduction_db != null) {
          flags.push('--ratio', String(Math.max(2, Math.min(20, Math.abs(d.reduction_db)))));
        }
        if (d.attack_ms != null) flags.push('--attack', String(d.attack_ms));
        if (d.release_ms != null) flags.push('--release', String(d.release_ms));
        const musTmp = tmp(`${id}_mus.mp4`);
        runNodeTool(path.join(ROOT, 'scripts/mix-music.js'), [
          outMp4,
          musPath,
          musTmp,
          ...flags,
        ], { cwd: ROOT, stage: 'dynamic music mix' });
        fs.copyFileSync(musTmp, outMp4);
        fs.unlinkSync(musTmp);
      } else {
        log(`⚠️ музыка не найдена: ${musPath} – пропускаю`);
      }
    }
    return outMp4;
    });
    if (outDir) {   // глобальный запуск: положить результат рядом с пользователем
      const outputName = buildContext.project ? buildContext.project.manifest.slug : id;
      final = copyOutputFile({
        cwd: process.cwd(),
        outdir: outDir,
        outputName,
        source: final,
      });
    }
    return final;
  });
} finally { dynamicSlot.release(); }
console.log(`\n✅ готово: ${finalPath}  (${W}x${H}, аспект исходника сохранён)`);
console.log('   отправлять как ДОКУМЕНТ [ФАЙЛ:] – иначе Telegram сплющит вертикаль.');

// --- helpers ---
function requireFresh(p) { const abs = require.resolve(p); delete require.cache[abs]; return require(abs); }

function draftScenario(caps) {
  const b = [{ type: 'LabelTop', start: 0.3, text: '>_ ВИДЕО' }];
  b.push({ type: 'CaptionsAuto', start: 0, groups: caps, offset: 300 });
  // эвристика CTA: последняя группа со словами-триггерами
  const last = caps[caps.length - 1];
  const txt = (g) => g.words.map((w) => w.w).join(' ').toLowerCase();
  if (last && /ссылк|кнопк|жми|подпис|переход/.test(txt(last))) {
    b.push({ type: 'CTACard', start: Math.max(0, last.start - 0.2), head: 'ЖМИ', btn: 'ССЫЛКА НИЖЕ ↓' });
  }
  return b;
}
