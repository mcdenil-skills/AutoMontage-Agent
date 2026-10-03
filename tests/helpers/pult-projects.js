const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const {
  approveBrief,
  createOrOpenProject,
  nextRenderPaths,
  publishBriefRevision,
  publishFinal,
  readProjectManifest,
  recordRender,
  writeProjectManifest,
} = require('../../scripts/project/workspace');
const { planPreview, publishCurrentPreview } = require('../../scripts/project/preview-workspace');

const ROOT = path.resolve(__dirname, '../..');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// registrar – объект с методом after(fn): node:test `t` или обёртка в Playwright.
function makePultRoot(registrar) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-pult-'));
  // after() выполняются в порядке регистрации (FIFO): сервер, поднятый тестом уже внутри base,
  // регистрирует своё закрытие позже этого rmSync, то есть на момент удаления сервер ещё не
  // закрыт – maxRetries/retryDelay тут не ждут его закрытия (синхронный rmSync блокирует event
  // loop, так что закрытие сервера всё равно не могло бы произойти за это время), они переживают
  // только внешних держателей хендлов (антивирус, дочерние процессы). Если сервер и правда мешает
  // удалению, порядок cleanup нужно менять отдельной задачей.
  registrar.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const projectsDir = path.join(base, 'projects');
  fs.mkdirSync(projectsDir);
  return { base, projectsDir };
}

function reopen(projectDir) {
  return createOrOpenProject({ projectDir });
}

function addDraftProject(projectsDir, {
  folder,
  name = folder,
  preview = true,
  previewKind = 'full',
  // По умолчанию – текстовая заглушка (её достаточно большинству тестов, которые не
  // перематывают плеер). Тесту, которому нужен настоящий плеер (перемотка, метаданные),
  // передать сюда реальные байты видео – как playableVideoBytes в pult-ui.spec.js.
  previewBytes = null,
  approve = false,
  final = false,
  card = null,
  scenes = null,
} = {}) {
  const sourcePath = path.join(path.dirname(projectsDir), `${folder}-source.mp4`);
  fs.writeFileSync(sourcePath, `source ${folder}`);
  let workspace = createOrOpenProject({
    projectDir: path.join(projectsDir, folder),
    name,
    sourcePath,
    now: new Date('2026-09-20T10:00:00.000Z'),
  });
  const brief = {
    version: 1,
    status: 'draft',
    source: workspace.sourcePath,
    theme: 'lesson-neutral',
    title: name,
    output: { aspect: 'horizontal', width: 320, height: 180, fps: 25, durationInFrames: 100 },
    corrections: [],
    scenes: scenes || [{ scene: 'fullscreen', start: 0, end: 4, caption: 'ПУЛЬТ' }],
  };
  const draft = publishBriefRevision(workspace, { brief, markdown: `# ${name}` });
  workspace = reopen(workspace.dir);
  let previewResult = null;
  if (preview) {
    const plan = planPreview(workspace, {
      briefPath: draft.jsonPath,
      briefSha256: sha256(fs.readFileSync(draft.jsonPath)),
      range: { kind: previewKind, fromSec: 0, toSec: previewKind === 'full' ? 4 : 2 },
    });
    const staged = path.join(workspace.dir, 'previews', 'stage.mp4');
    fs.writeFileSync(staged, previewBytes || `preview ${folder}`);
    previewResult = publishCurrentPreview(workspace, plan, staged, {
      width: 160,
      height: 90,
      fps: 25,
      generatedAt: '2026-09-20T10:05:00.000Z',
    });
    workspace = reopen(workspace.dir);
  }
  let approved = null;
  if (approve) {
    approved = approveBrief(workspace, draft.jsonPath, { confirmPreviewViewed: true });
    workspace = reopen(workspace.dir);
  }
  if (final) {
    const render = nextRenderPaths(workspace, 'final');
    fs.writeFileSync(render.finalPath, `final ${folder}`);
    recordRender(workspace, {
      version: render.version,
      label: render.label,
      dir: render.dir,
      briefPath: approved ? approved.jsonPath : null,
      status: 'complete',
    });
    workspace = reopen(workspace.dir);
    publishFinal(workspace, render.finalPath);
    workspace = reopen(workspace.dir);
  }
  if (card) {
    fs.writeFileSync(path.join(workspace.dir, 'pult-card.json'), `${JSON.stringify(card, null, 2)}\n`);
  }
  return { projectDir: workspace.dir, workspace, draft, preview: previewResult, approved };
}

// Публикует ВТОРОЙ черновик и полный preview поверх уже утверждённого и отрендеренного
// проекта: ролик возвращается в «Ждёт меня», а рендер v01 и его финал остаются на диске.
// previewBytes – содержимое нового preview: по умолчанию текст, а там, где тесту нужно
// реально перематывать плеер, – настоящее видео.
function addSecondRevision(projectDir, name, previewBytes = 'preview v2') {
  let workspace = reopen(projectDir);
  const brief = {
    version: 1,
    status: 'draft',
    source: workspace.sourcePath,
    theme: 'lesson-neutral',
    title: name,
    output: { aspect: 'horizontal', width: 320, height: 180, fps: 25, durationInFrames: 100 },
    corrections: [],
    scenes: [{ scene: 'fullscreen', start: 0, end: 4, caption: 'СНОВА' }],
  };
  const draft = publishBriefRevision(workspace, { brief, markdown: `# ${name} v2` });
  workspace = reopen(projectDir);
  const plan = planPreview(workspace, {
    briefPath: draft.jsonPath,
    briefSha256: sha256(fs.readFileSync(draft.jsonPath)),
    range: { kind: 'full', fromSec: 0, toSec: 4 },
  });
  const staged = path.join(workspace.dir, 'previews', 'stage-v2.mp4');
  fs.writeFileSync(staged, previewBytes);
  publishCurrentPreview(workspace, plan, staged, {
    width: 160, height: 90, fps: 25, generatedAt: '2026-09-21T10:05:00.000Z',
  });
  return { draft };
}

// Черновик с b-roll, для которого человек ещё не выбрал материал: обычное состояние
// (выбор делается в Review), но движок такой brief утвердить не даст.
function unresolvedBrollScenes() {
  return [
    { scene: 'fullscreen', start: 0, end: 2, caption: 'ПУЛЬТ' },
    {
      scene: 'broll',
      start: 2,
      end: 4,
      headCream: 'ЭКРАН',
      headOrange: 'ТУТ',
      sub: 'вот экран',
      brollIntent: { goal: 'показать экран', sourceText: 'вот экран', queryOriginal: 'экран', queryEnglish: 'screen' },
    },
  ];
}

// Утверждает уже опубликованный черновик прямо через движок – той же функцией approveBrief,
// что и фикстура addDraftProject({ approve: true }), но для проекта, который тест уже открыл
// в пульте (карточку в браузере). workspace всегда перечитываем заново: approveBrief сверяет
// его manifest с тем, что реально лежит на диске, а объект, который вернул addDraftProject,
// к этому моменту мог устареть.
function approveDraft(projectDir, draftJsonPath) {
  return approveBrief(reopen(projectDir), draftJsonPath, { confirmPreviewViewed: true });
}

// Публикует новую ревизию brief БЕЗ нового preview – ровно та ситуация, из-за которой видео
// устаревает («Preview устарел – агент готовит новый»): движок ещё не отдал файл под новую
// версию, а preview на диске остался от прежнего brief.
function publishDraftWithoutPreview(projectDir, name) {
  const workspace = reopen(projectDir);
  const brief = {
    version: 1,
    status: 'draft',
    source: workspace.sourcePath,
    theme: 'lesson-neutral',
    title: name,
    output: { aspect: 'horizontal', width: 320, height: 180, fps: 25, durationInFrames: 100 },
    corrections: [],
    scenes: [{ scene: 'fullscreen', start: 0, end: 4, caption: 'ЕЩЁ' }],
  };
  return publishBriefRevision(workspace, { brief, markdown: `# ${name} v.next` });
}

const ROUGH_CUT_KEEP = Object.freeze([
  Object.freeze({ start: 0, end: 2, note: 'хук' }),
  Object.freeze({ start: 3, end: 5, note: 'вырезан повтор «Первое»' }),
]);
const ROUGH_CUT_FPS = 25;
const ROUGH_CUT_AT = '2026-10-03T08:00:00.000Z';

// Черновая нарезка без ffmpeg: список кусков edit/roughcut-vNN.json, копия previews/roughcut-vNN.mp4
// (байты videoBytes или текстовая заглушка) и project.json.roughCut с настоящими SHA-256 этих байт –
// как после `automontage roughcut`. Паспорт пишется той же записью с expectedManifest, что и у движка.
function writeRoughCut(projectDir, { version, keep, videoBytes, status, sourceDuration, confirmedAt = ROUGH_CUT_AT }) {
  const current = readProjectManifest(projectDir);
  const label = String(version).padStart(2, '0');
  const editPath = `edit/roughcut-v${label}.json`;
  const filePath = `previews/roughcut-v${label}.mp4`;
  const sourceRevision = current.source.revision;
  const editBytes = Buffer.from(`${JSON.stringify({
    version: 1,
    sourceRevision,
    fps: ROUGH_CUT_FPS,
    keep,
  }, null, 2)}\n`);
  const video = videoBytes || `roughcut ${path.basename(projectDir)} v${label}`;
  fs.mkdirSync(path.join(projectDir, 'edit'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'previews'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, ...editPath.split('/')), editBytes);
  fs.writeFileSync(path.join(projectDir, ...filePath.split('/')), video);
  const next = structuredClone(current);
  next.roughCut = {
    editPath,
    filePath,
    sourceRevision,
    sourceDuration,
    editSha256: sha256(editBytes),
    sha256: sha256(fs.readFileSync(path.join(projectDir, ...filePath.split('/')))),
    duration: Number(keep.reduce((sum, piece) => sum + piece.end - piece.start, 0).toFixed(3)),
    width: 1280,
    height: 720,
    fps: ROUGH_CUT_FPS,
    createdAt: ROUGH_CUT_AT,
    status,
    ...(status === 'confirmed' ? { confirmedAt, confirmedBy: 'chat' } : {}),
  };
  next.updatedAt = ROUGH_CUT_AT;
  writeProjectManifest(projectDir, next, { expectedManifest: current });
}

// Ролик на этапе черновой нарезки: паспорт без brief, нарезка v01 (fps 25, ревизия исходника 1).
// status 'confirmed' – нарезку уже подтвердили словами в чате, master ещё не собран;
// confirmedAt – ISO-время этого подтверждения (по умолчанию то же, что у createdAt).
function addRoughCutProject(projectsDir, {
  folder,
  name = folder,
  status = 'review',
  videoBytes = null,
  keep = ROUGH_CUT_KEEP,
  sourceDuration = 6,
  confirmedAt = ROUGH_CUT_AT,
} = {}) {
  const sourcePath = path.join(path.dirname(projectsDir), `${folder}-source.mp4`);
  fs.writeFileSync(sourcePath, `source ${folder}`);
  const workspace = createOrOpenProject({
    projectDir: path.join(projectsDir, folder),
    name,
    sourcePath,
    now: new Date('2026-10-03T07:00:00.000Z'),
  });
  writeRoughCut(workspace.dir, { version: 1, keep, videoBytes, status, sourceDuration, confirmedAt });
  return { projectDir: workspace.dir };
}

// Агент собрал следующую нарезку: новый список и копия с номером version, запись снова в review.
// Подходит и для первой нарезки уже существующего ролика (version: 1).
function republishRoughCut(projectDir, { version = 2, keep = ROUGH_CUT_KEEP, videoBytes = null } = {}) {
  const previous = readProjectManifest(projectDir).roughCut;
  writeRoughCut(projectDir, {
    version,
    keep,
    videoBytes,
    status: 'review',
    sourceDuration: previous ? previous.sourceDuration : 6,
  });
}

// Как будто прошёл master по текущей нарезке: новая ревизия исходника (файл-заглушка), запись в
// source.history со списком кусков нарезки. Нарезка остаётся в паспорте, но уже как история.
function bumpSourceRevision(projectDir) {
  const current = readProjectManifest(projectDir);
  if (!current.roughCut) throw new Error('bumpSourceRevision: в паспорте нет черновой нарезки');
  const revision = current.source.revision + 1;
  const label = String(revision).padStart(2, '0');
  const localPath = `input/source-v${label}.mp4`;
  fs.writeFileSync(path.join(projectDir, ...localPath.split('/')), `source revision ${revision}`);
  const next = structuredClone(current);
  next.source.revision = revision;
  next.source.localPath = localPath;
  next.source.history = [...next.source.history, {
    revision,
    localPath,
    editPath: current.roughCut.editPath,
    transcriptPath: `transcript/words-v${label}.json`,
  }];
  next.updatedAt = '2026-10-03T09:00:00.000Z';
  writeProjectManifest(projectDir, next, { expectedManifest: current });
}

function addLegacyFolder(projectsDir, folder, { card = null, files = {} } = {}) {
  const dir = path.join(projectsDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  if (card) fs.writeFileSync(path.join(dir, 'pult-card.json'), `${JSON.stringify(card, null, 2)}\n`);
  return dir;
}

module.exports = {
  ROOT,
  addDraftProject,
  addLegacyFolder,
  addRoughCutProject,
  addSecondRevision,
  approveDraft,
  bumpSourceRevision,
  makePultRoot,
  publishDraftWithoutPreview,
  republishRoughCut,
  sha256,
  unresolvedBrollScenes,
};
