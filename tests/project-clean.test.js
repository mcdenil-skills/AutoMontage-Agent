const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { applyCleanup, main, planCleanup, planProjectCleanup } = require('../scripts/project/clean');
const {
  addDraftProject, bumpSourceRevision, makePultRoot, republishRoughCut,
} = require('./helpers/pult-projects');

const NOW = new Date('2026-10-10T12:00:00Z');
const OLD = new Date('2026-10-01T12:00:00Z');
const APPROVED = 'brief/v03-approved.lesson.json';

function put(root, relative, content = 'xx') {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function age(dir, relative, when = OLD) {
  fs.utimesSync(path.join(dir, ...relative.split('/')), when, when);
}

// Готовый проект в состоянии «Готов» пульта: утверждённое ТЗ, рендер по нему, финал. Активна
// ревизия v03, v02 – промежуточная. Слой собран из v03; ТЗ ссылается на b-roll abc, а old – прежний
// импорт слоя, на который уже ничто не ссылается.
function finishedProject(t, { manifest = {}, files = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '2026.09.01_demo');
  fs.mkdirSync(dir);
  const base = {
    version: 1,
    id: '2026.09.01_demo',
    final: 'final/demo.mp4',
    source: {
      originalLocalPath: 'input/source.mp4',
      localPath: 'input/source-v03.mp4',
      revision: 3,
      history: [
        { revision: 2, localPath: 'input/source-v02.mp4', editPath: 'edit/v02-source.json', transcriptPath: 'transcript/words-v02.json' },
        { revision: 3, localPath: 'input/source-v03.mp4', editPath: 'edit/v03-source.json', transcriptPath: 'transcript/words-v03.json' },
      ],
    },
    briefs: [{ kind: 'lesson', revision: 3, jsonPath: APPROVED, status: 'approved' }],
    renders: [{ version: 1, label: 'x', dir: 'renders/v01-x', briefPath: APPROVED, status: 'complete' }],
    currentBrief: APPROVED,
    latestRender: 'renders/v01-x',
    currentPreview: null,
    ...manifest,
  };
  const all = {
    'final/demo.mp4': 'final-bytes',
    [APPROVED]: JSON.stringify({ scenes: [{ scene: 'broll', brollMedia: { reference: 'assets/broll/video/abc/media.mp4' } }] }),
    'transcript/words.json': '[]',
    'edit/v02-source.json': '{}',
    'edit/v03-source.json': '{}',
    'qa/report.json': '{}',
    'input/source.mp4': 'original',
    'input/source-v02.mp4': 'revision-2',
    'input/source-v03.mp4': 'revision-3',
    'renders/v01-x/raw.mp4': 'raw',
    'renders/v01-x/props.json': '{}',
    'previews/v01-draft-full.mp4': 'preview',
    'previews/broll/abc.webm': 'proxy-abc',
    'previews/broll/old.webm': 'proxy-old',
    'tmp/a.wav': 'wav',
    'motion-v01/src/Root.jsx': 'jsx',
    'motion-v01/layer.json': JSON.stringify({ speaker: { src: 'speaker.mp4' }, source: { localPath: 'input/source-v03.mp4' } }),
    'motion-v01/renders/layer-01.mp4': 'layer',
    'motion-v01/public/speaker.mp4': 'revision-3',
    'motion-v01/public/fonts/Onest.ttf': 'font',
    'assets/broll/video/abc/media.mp4': 'broll-abc',
    'assets/broll/video/abc/asset.json': '{}',
    'assets/broll/video/old/media.mp4': 'broll-old',
    'assets/broll/video/old/asset.json': '{}',
    'assets/music/m.wav': 'music',
    ...files,
  };
  for (const [relative, content] of Object.entries(all)) {
    if (content !== null) put(dir, relative, content);
  }
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(base));
  for (const relative of ['project.json', base.final]) {
    if (fs.existsSync(path.join(dir, relative))) age(dir, relative);
  }
  return { root, dir };
}

const paths = (plan) => plan.files.map((file) => file.path).sort();

function comment(status) {
  return {
    id: 'c-5b5e8e9b',
    createdAt: '2026-10-02T10:37:27.349Z',
    timeSec: 3,
    text: 'x',
    video: { kind: 'preview', path: 'previews/v01-draft-full.mp4', sha256: 'a'.repeat(64) },
    frame: null,
    status,
  };
}

test('renders level lists regenerable intermediates of a finished project', (t) => {
  const { dir } = finishedProject(t);
  const plan = planProjectCleanup(dir, { now: NOW });
  assert.equal(plan.status, 'eligible');
  assert.equal(plan.reason, null);
  assert.deepEqual(paths(plan), [
    'motion-v01/public/speaker.mp4',
    'motion-v01/renders/layer-01.mp4',
    'previews/v01-draft-full.mp4',
    'renders/v01-x/raw.mp4',
    'tmp/a.wav',
  ]);
});

test('renders level never lists b-roll preview proxies', (t) => {
  const { dir } = finishedProject(t);
  const listed = paths(planProjectCleanup(dir, { now: NOW }));
  assert.ok(!listed.some((item) => item.startsWith('previews/broll/')));
});

test('speaker copy is kept unless its layer source lies next to it with the same size', (t) => {
  const noLayer = finishedProject(t, { files: { 'motion-v01/layer.json': null } });
  assert.ok(!paths(planProjectCleanup(noLayer.dir, { now: NOW })).includes('motion-v01/public/speaker.mp4'));
  const differs = finishedProject(t, { files: { 'motion-v01/public/speaker.mp4': 'other-bytes-longer' } });
  assert.ok(!paths(planProjectCleanup(differs.dir, { now: NOW })).includes('motion-v01/public/speaker.mp4'));
});

test('archive level adds superseded source revisions and unreferenced b-roll bundles only', (t) => {
  const { dir } = finishedProject(t);
  const listed = paths(planProjectCleanup(dir, { now: NOW, level: 'archive' }));
  assert.ok(listed.includes('input/source-v02.mp4'));
  assert.ok(listed.includes('assets/broll/video/old/media.mp4'));
  assert.ok(listed.includes('assets/broll/video/old/asset.json'));
  assert.ok(listed.includes('previews/broll/old.webm'));
  for (const kept of ['input/source.mp4', 'input/source-v03.mp4', 'assets/broll/video/abc/media.mp4',
    'assets/broll/video/abc/asset.json', 'previews/broll/abc.webm', 'assets/music/m.wav', 'final/demo.mp4']) {
    assert.ok(!listed.includes(kept), kept);
  }
});

test('archive keeps a revision the layer was built from even when it is not the active one', (t) => {
  const { dir } = finishedProject(t, {
    files: { 'motion-v01/layer.json': JSON.stringify({ speaker: { src: 'speaker.mp4' }, source: { localPath: 'input/source-v02.mp4' } }) },
  });
  assert.ok(!paths(planProjectCleanup(dir, { now: NOW, level: 'archive' })).includes('input/source-v02.mp4'));
});

test('archive never deletes source revisions of a legacy manifest without an original', (t) => {
  const { dir } = finishedProject(t, {
    manifest: { source: { localPath: 'input/source-v07.mp4' } },
    files: { 'input/source-v07.mp4': 'only-copy', 'input/source-v05.mp4': 'older' },
  });
  const listed = paths(planProjectCleanup(dir, { now: NOW, level: 'archive' }));
  assert.ok(!listed.some((item) => item.startsWith('input/')));
});

test('current preview and legacy pult-card videos are kept', (t) => {
  const { dir } = finishedProject(t, {
    manifest: { currentPreview: { filePath: 'previews/current-preview.mp4' } },
    files: {
      'previews/current-preview.mp4': 'cp',
      'renders/v01-x/final.mp4': 'rf',
      'pult-card.json': JSON.stringify({ version: 1, legacy: { status: 'ready', variants: [{ label: 'A', video: 'renders/v01-x/final.mp4' }] } }),
    },
  });
  const listed = paths(planProjectCleanup(dir, { now: NOW }));
  assert.ok(!listed.includes('previews/current-preview.mp4'));
  assert.ok(!listed.includes('renders/v01-x/final.mp4'));
  assert.ok(listed.includes('renders/v01-x/raw.mp4'));
});

test('a project with a newer approved brief that is not rendered yet is skipped', (t) => {
  const { dir } = finishedProject(t, {
    manifest: {
      currentBrief: 'brief/v04-approved.lesson.json',
      briefs: [
        { kind: 'lesson', revision: 3, jsonPath: APPROVED, status: 'approved' },
        { kind: 'lesson', revision: 4, jsonPath: 'brief/v04-approved.lesson.json', status: 'approved' },
      ],
    },
    files: { 'brief/v04-approved.lesson.json': '{}' },
  });
  const plan = planProjectCleanup(dir, { now: NOW });
  assert.equal(plan.status, 'skipped');
  assert.match(plan.reason, /^не готов в пульте/);
});

test('a project with pending pult edits or an unreadable edits file is skipped', (t) => {
  const pending = finishedProject(t, { files: { 'pult/comments.json': JSON.stringify({ version: 1, comments: [comment('new')] }) } });
  assert.match(planProjectCleanup(pending.dir, { now: NOW }).reason, /^не готов в пульте/);
  const accepted = finishedProject(t, { files: { 'pult/comments.json': JSON.stringify({ version: 1, comments: [comment('accepted')] }) } });
  assert.equal(planProjectCleanup(accepted.dir, { now: NOW }).status, 'eligible');
  const broken = finishedProject(t, { files: { 'pult/comments.json': '{broken' } });
  assert.equal(planProjectCleanup(broken.dir, { now: NOW }).reason, 'pult/comments.json не читается');
});

// Готовый ролик, к которому агент собрал новую черновую нарезку: идёт новый монтаж, и копия
// нарезки – то, что автор сейчас смотрит. Первый master делает её историей – прежняя чистка.
test('a finished project with an active rough cut is not finished for clean until master', (t) => {
  const { projectsDir } = makePultRoot(t);
  const { projectDir } = addDraftProject(projectsDir, { folder: 'recut', approve: true, final: true });
  assert.equal(planProjectCleanup(projectDir, { minAgeDays: 0 }).status, 'eligible');
  republishRoughCut(projectDir, { version: 1 });
  const copy = path.join(projectDir, 'previews', 'roughcut-v01.mp4');

  const plan = planProjectCleanup(projectDir, { minAgeDays: 0 });
  assert.equal(plan.status, 'skipped');
  assert.equal(plan.reason, 'черновая нарезка ждёт автора');
  assert.deepEqual(plan.files, []);
  const result = applyCleanup(planCleanup(projectsDir, { minAgeDays: 0 }), { minAgeDays: 0 });
  assert.equal(result.removedFiles, 0);
  assert.ok(fs.existsSync(copy));

  bumpSourceRevision(projectDir);
  const after = planProjectCleanup(projectDir, { minAgeDays: 0 });
  assert.equal(after.status, 'eligible');
  assert.ok(after.files.some((file) => file.path === 'previews/roughcut-v01.mp4'));
});

test('a confirmed rough cut waiting for master also keeps the project out of clean', (t) => {
  const { dir } = finishedProject(t, {
    manifest: {
      roughCut: {
        editPath: 'edit/roughcut-v01.json',
        filePath: 'previews/roughcut-v01.mp4',
        sourceRevision: 3,
        status: 'confirmed',
      },
    },
    files: { 'previews/roughcut-v01.mp4': 'rough' },
  });
  const plan = planProjectCleanup(dir, { now: NOW });
  assert.equal(plan.status, 'skipped');
  assert.equal(plan.reason, 'нарезка подтверждена – агент собирает слой');
});

test('projects that are not finished, locked, fresh or unreadable are skipped with a reason', (t) => {
  const missingFinal = finishedProject(t);
  fs.rmSync(path.join(missingFinal.dir, 'final/demo.mp4'));
  assert.deepEqual(
    [planProjectCleanup(missingFinal.dir, { now: NOW }).status, planProjectCleanup(missingFinal.dir, { now: NOW }).reason],
    ['skipped', 'нет финала'],
  );

  const locked = finishedProject(t, { files: { '.project-mutation.lock': '{}' } });
  assert.equal(planProjectCleanup(locked.dir, { now: NOW }).reason, 'идёт работа (lock)');

  const fresh = finishedProject(t);
  const yesterday = new Date(NOW.getTime() - 24 * 3600 * 1000);
  age(fresh.dir, 'project.json', yesterday);
  assert.equal(planProjectCleanup(fresh.dir, { now: NOW }).reason, 'менялся 1 дн. назад');

  const freshFinal = finishedProject(t);
  age(freshFinal.dir, 'final/demo.mp4', yesterday);
  assert.equal(planProjectCleanup(freshFinal.dir, { now: NOW }).reason, 'менялся 1 дн. назад');

  const broken = finishedProject(t);
  fs.writeFileSync(path.join(broken.dir, 'project.json'), '{broken');
  assert.equal(planProjectCleanup(broken.dir, { now: NOW }).reason, 'project.json не читается');

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-empty-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  assert.equal(planProjectCleanup(empty, { now: NOW }).reason, 'нет project.json');

  for (const plan of [planProjectCleanup(locked.dir, { now: NOW }), planProjectCleanup(empty, { now: NOW })]) {
    assert.equal(plan.status, 'skipped');
    assert.deepEqual(plan.files, []);
    assert.equal(plan.bytes, 0);
  }
});

test('symlinks are neither listed nor followed', (t) => {
  const { root, dir } = finishedProject(t);
  const outside = path.join(root, 'outside');
  put(outside, 'keep.mp4', 'precious');
  fs.symlinkSync(outside, path.join(dir, 'tmp', 'out'));
  fs.symlinkSync(path.join(outside, 'keep.mp4'), path.join(dir, 'previews', 'link.mp4'));
  const listed = paths(planProjectCleanup(dir, { now: NOW }));
  assert.ok(!listed.some((item) => item.includes('out') || item.includes('link')));
});

test('bytes is the sum of listed file sizes', (t) => {
  const { dir } = finishedProject(t, { files: { 'tmp/big.bin': 'x'.repeat(1000) } });
  const plan = planProjectCleanup(dir, { now: NOW });
  assert.equal(plan.bytes, plan.files.reduce((sum, file) => sum + file.bytes, 0));
  assert.ok(plan.bytes >= 1000);
});

test('unknown level is rejected', (t) => {
  const { dir } = finishedProject(t);
  assert.throws(() => planProjectCleanup(dir, { now: NOW, level: 'zip' }), /неизвестный уровень/);
});

function projectsWithTwoFinished(t) {
  const first = finishedProject(t);
  const second = finishedProject(t);
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-projects-'));
  t.after(() => fs.rmSync(projects, { recursive: true, force: true }));
  fs.renameSync(first.dir, path.join(projects, 'a'));
  fs.renameSync(second.dir, path.join(projects, 'b'));
  fs.mkdirSync(path.join(projects, '.archive'));
  put(path.join(projects, '.archive'), 'old.mp4', 'old');
  return projects;
}

function capture() {
  const lines = [];
  return { lines, log: (line) => lines.push(String(line)), text: () => lines.join('\n') };
}

test('planCleanup covers project folders and ignores dot folders', (t) => {
  const projects = projectsWithTwoFinished(t);
  const plan = planCleanup(projects, { now: NOW });
  assert.deepEqual(plan.projects.map((item) => path.basename(item.projectDir)).sort(), ['a', 'b']);
  assert.equal(plan.bytes, plan.projects.reduce((sum, item) => sum + item.bytes, 0));
});

test('an unreadable folder skips only its project and the report still completes', (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('chmod 000 does not block this user');
  const projects = projectsWithTwoFinished(t);
  const secret = path.join(projects, 'b', 'tmp', 'secret');
  fs.mkdirSync(secret);
  fs.chmodSync(secret, 0);
  let plan;
  try {
    plan = planCleanup(projects, { now: NOW });
  } finally {
    fs.chmodSync(secret, 0o755);
  }
  const byName = Object.fromEntries(plan.projects.map((item) => [path.basename(item.projectDir), item]));
  assert.equal(byName.a.status, 'eligible');
  assert.equal(byName.b.status, 'skipped');
  assert.equal(byName.b.reason, 'папка не читается');
});

test('clean without --yes only reports', (t) => {
  const projects = projectsWithTwoFinished(t);
  const out = capture();
  const code = main(['--projects-dir', projects], { now: NOW, log: out.log, error: out.log });
  assert.equal(code, 0);
  assert.ok(fs.existsSync(path.join(projects, 'a', 'tmp', 'a.wav')));
  assert.match(out.text(), /Можно освободить:/);
  assert.match(out.text(), /Чтобы удалить, повторите с --yes/);
});

test('applyCleanup removes planned files, keeps deliverables and prunes emptied folders', (t) => {
  const projects = projectsWithTwoFinished(t);
  const plan = planCleanup(projects, { now: NOW });
  const result = applyCleanup(plan, { now: NOW });
  const a = path.join(projects, 'a');
  assert.equal(result.removedFiles, 10);
  assert.ok(result.freedBytes > 0);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.failed, []);
  assert.ok(!fs.existsSync(path.join(a, 'tmp', 'a.wav')));
  assert.ok(fs.existsSync(path.join(a, 'final', 'demo.mp4')));
  assert.ok(fs.existsSync(path.join(a, APPROVED)));
  assert.ok(fs.existsSync(path.join(a, 'previews', 'broll', 'abc.webm')));
  assert.ok(fs.existsSync(path.join(a, 'renders', 'v01-x', 'props.json')));
  assert.ok(!fs.existsSync(path.join(a, 'motion-v01', 'renders')));
  assert.ok(fs.existsSync(path.join(a, 'motion-v01', 'src', 'Root.jsx')));
  assert.ok(fs.existsSync(path.join(projects, '.archive', 'old.mp4')));
});

test('applyCleanup never deletes through a symlink planted after planning', (t) => {
  const projects = projectsWithTwoFinished(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  put(outside, 'a.wav', 'precious');
  const plan = planCleanup(projects, { now: NOW });
  const tmp = path.join(projects, 'a', 'tmp');
  fs.rmSync(tmp, { recursive: true });
  fs.symlinkSync(outside, tmp);
  applyCleanup(plan, { now: NOW });
  assert.equal(fs.readFileSync(path.join(outside, 'a.wav'), 'utf8'), 'precious');
});

test('a file that appears after planning is not deleted', (t) => {
  const projects = projectsWithTwoFinished(t);
  const plan = planCleanup(projects, { now: NOW });
  put(path.join(projects, 'a'), 'tmp/new.wav', 'new');
  applyCleanup(plan, { now: NOW });
  assert.ok(fs.existsSync(path.join(projects, 'a', 'tmp', 'new.wav')));
});

test('a project locked after planning is skipped at apply time', (t) => {
  const projects = projectsWithTwoFinished(t);
  const plan = planCleanup(projects, { now: NOW });
  put(path.join(projects, 'b'), '.project-mutation.lock', '{}');
  const result = applyCleanup(plan, { now: NOW });
  assert.deepEqual(result.skipped.map((item) => [path.basename(item.projectDir), item.reason]), [['b', 'идёт работа (lock)']]);
  assert.ok(fs.existsSync(path.join(projects, 'b', 'tmp', 'a.wav')));
  assert.ok(!fs.existsSync(path.join(projects, 'a', 'tmp', 'a.wav')));
});

test('a failed delete is reported and the run continues with the remaining files', (t) => {
  const projects = projectsWithTwoFinished(t);
  const plan = planCleanup(projects, { now: NOW });
  const failing = path.join(projects, 'a', 'tmp', 'a.wav');
  const fileSystem = new Proxy(fs, {
    get(target, key) {
      if (key === 'unlinkSync') {
        return (file) => {
          if (file === failing) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
          return target.unlinkSync(file);
        };
      }
      return target[key];
    },
  });
  const result = applyCleanup(plan, { now: NOW, fileSystem });
  assert.equal(result.removedFiles, 9);
  assert.deepEqual(result.failed.map((item) => [item.path, item.code]), [[failing, 'EBUSY']]);
  assert.ok(fs.existsSync(failing));
  assert.ok(!fs.existsSync(path.join(projects, 'b', 'tmp', 'a.wav')));
});

test('clean --yes deletes and reports the freed size', (t) => {
  const projects = projectsWithTwoFinished(t);
  const out = capture();
  assert.equal(main(['--projects-dir', projects, '--yes'], { now: NOW, log: out.log, error: out.log }), 0);
  assert.ok(!fs.existsSync(path.join(projects, 'a', 'tmp', 'a.wav')));
  assert.match(out.text(), /Удалено 10 файлов, освобождено/);
});

test('clean with an unknown level exits with code 1', (t) => {
  const projects = projectsWithTwoFinished(t);
  const out = capture();
  assert.equal(main(['--projects-dir', projects, '--level', 'zip'], { now: NOW, log: out.log, error: out.log }), 1);
  assert.match(out.text(), /неизвестный уровень/);
});

test('automontage clean is dispatched by the main CLI and only reports by default', (t) => {
  const projects = projectsWithTwoFinished(t);
  const output = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'cli.js'), 'clean', '--projects-dir', projects, '--min-age-days', '0'], { encoding: 'utf8' });
  assert.match(output, /Можно освободить:/);
  assert.ok(fs.existsSync(path.join(projects, 'a', 'tmp', 'a.wav')));
});
