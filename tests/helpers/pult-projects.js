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
  recordRender,
} = require('../../scripts/project/workspace');
const { planPreview, publishCurrentPreview } = require('../../scripts/project/preview-workspace');

const ROOT = path.resolve(__dirname, '../..');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// registrar – объект с методом after(fn): node:test `t` или обёртка в Playwright.
function makePultRoot(registrar) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-pult-'));
  registrar.after(() => fs.rmSync(base, { recursive: true, force: true }));
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
// к этому моменту устарел.
function approveDraft(projectDir, draftJsonPath) {
  return approveBrief(reopen(projectDir), draftJsonPath, { confirmPreviewViewed: true });
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
  addSecondRevision,
  approveDraft,
  makePultRoot,
  sha256,
  unresolvedBrollScenes,
};
