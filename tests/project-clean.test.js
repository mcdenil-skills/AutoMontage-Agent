const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  applyCleanup, cleanupHint, formatSize, main, planCleanup, planProjectCleanup, printCleanupHint,
} = require('../scripts/project/clean');
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

test('renders level lists all moments sets of both kinds with frames and keeps critic reports', (t) => {
  const sets = {
    'qa/moments-0123abcd.jpg': 'sheet',
    'qa/moments-0123abcd-phone.jpg': 'phone',
    'qa/moments-0123abcd.json': '{}',
    'qa/moments-0123abcd/01-0.5.jpg': 'frame',
    'qa/moments-stills-89abcdef.jpg': 'sheet',
    'qa/moments-stills-89abcdef-phone.jpg': 'phone',
    'qa/moments-stills-89abcdef.json': '{}',
    'qa/moments-stills-89abcdef/01-0.5.jpg': 'frame',
  };
  const kept = {
    'qa/critic-01.json': '{}',
    'qa/critic-01.txt': 'report',
    'qa/sheet-abcd1234.jpg': 'sheet',
    'qa/moments-xyz.json': '{}',
    'qa/moments-0123abcd-old.jpg': 'x',
    'qa/notes/moments-0123abcd.json': '{}',
  };
  const { dir } = finishedProject(t, { files: { ...sets, ...kept } });
  const listed = paths(planProjectCleanup(dir, { now: NOW }));
  for (const file of Object.keys(sets)) assert.ok(listed.includes(file), file);
  for (const file of Object.keys(kept)) assert.ok(!listed.includes(file), file);
  assert.ok(!listed.includes('qa/report.json'));
});

test('applyCleanup removes moments frames folders but keeps qa and critic reports', (t) => {
  const { root, dir } = finishedProject(t, { files: { 'qa/moments-stills-89abcdef.json': '{}', 'qa/moments-stills-89abcdef/01-0.5.jpg': 'frame', 'qa/critic-01.json': '{}' } });
  const plan = planCleanup(root, { now: NOW });
  applyCleanup(plan, { now: NOW });
  assert.ok(!fs.existsSync(path.join(dir, 'qa', 'moments-stills-89abcdef')));
  assert.ok(!fs.existsSync(path.join(dir, 'qa', 'moments-stills-89abcdef.json')));
  assert.ok(fs.existsSync(path.join(dir, 'qa', 'critic-01.json')));
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
  const options = { minAgeDays: 0, now: NOW };
  // Проверяем состояние нарезки независимо от дробного mtime и текущих часов CI.
  age(projectDir, 'project.json');
  age(projectDir, 'final/recut.mp4');
  assert.equal(planProjectCleanup(projectDir, options).status, 'eligible');
  republishRoughCut(projectDir, { version: 1 });
  age(projectDir, 'project.json');
  const copy = path.join(projectDir, 'previews', 'roughcut-v01.mp4');

  const plan = planProjectCleanup(projectDir, options);
  assert.equal(plan.status, 'skipped');
  assert.equal(plan.reason, 'черновая нарезка ждёт автора');
  assert.deepEqual(plan.files, []);
  const result = applyCleanup(planCleanup(projectsDir, options), options);
  assert.equal(result.removedFiles, 0);
  assert.ok(fs.existsSync(copy));

  bumpSourceRevision(projectDir);
  age(projectDir, 'project.json');
  const after = planProjectCleanup(projectDir, options);
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

// CI 1.15.0: mtime файла бывает на миллисекунду позже Date.now() (часы ядра и ФС идут с разной
// точностью) – Math.floor давал −1 дн., и при minAgeDays 0 готовый проект считался «свежим».
test('regression: a file timestamp slightly ahead of now is age 0, not negative', (t) => {
  const { dir } = finishedProject(t);
  const changed = fs.statSync(path.join(dir, 'project.json')).mtimeMs;
  const plan = planProjectCleanup(dir, { minAgeDays: 0, now: new Date(changed - 5) });
  assert.equal(plan.status, 'eligible');
});

// #113: чистка одного ролика сразу после финала. --project чистит только эту папку, пауза по
// умолчанию 0 дней; остальные проверки planProjectCleanup – те же.
function freshFinished(t) {
  const projects = projectsWithTwoFinished(t);
  const recent = new Date(Date.now() - 60 * 1000);
  for (const name of ['a', 'b']) {
    age(path.join(projects, name), 'project.json', recent);
    age(path.join(projects, name), 'final/demo.mp4', recent);
  }
  return projects;
}

test('clean --project removes files of that folder only and keeps the others', (t) => {
  const projects = projectsWithTwoFinished(t);
  const out = capture();
  assert.equal(main(['--projects-dir', projects, '--project', 'a', '--yes'], { now: NOW, log: out.log, error: out.log }), 0);
  assert.ok(!fs.existsSync(path.join(projects, 'a', 'tmp', 'a.wav')));
  assert.ok(fs.existsSync(path.join(projects, 'b', 'tmp', 'a.wav')));
  assert.ok(fs.existsSync(path.join(projects, 'b', 'previews', 'v01-draft-full.mp4')));
  assert.doesNotMatch(out.text(), /\bb:/);
});

test('clean --project accepts the projects/<folder> form the inbox prints', (t) => {
  const projects = projectsWithTwoFinished(t);
  const out = capture();
  assert.equal(main(['--projects-dir', projects, '--project', 'projects/a/', '--yes'], { now: NOW, log: out.log, error: out.log }), 0);
  assert.ok(!fs.existsSync(path.join(projects, 'a', 'tmp', 'a.wav')));
  assert.ok(fs.existsSync(path.join(projects, 'b', 'tmp', 'a.wav')));
});

test('a fresh final is cleaned with --project, while the general run skips it as changed 0 days ago', (t) => {
  const projects = freshFinished(t);
  const general = capture();
  assert.equal(main(['--projects-dir', projects, '--yes'], { log: general.log, error: general.log }), 0);
  assert.match(general.text(), /a: пропущен – менялся 0 дн\. назад/);
  assert.ok(fs.existsSync(path.join(projects, 'a', 'tmp', 'a.wav')));

  const single = capture();
  assert.equal(main(['--projects-dir', projects, '--project', 'a', '--yes'], { log: single.log, error: single.log }), 0);
  assert.ok(!fs.existsSync(path.join(projects, 'a', 'tmp', 'a.wav')));
  assert.ok(fs.existsSync(path.join(projects, 'b', 'tmp', 'a.wav')));
});

test('clean --project still honours an explicit --min-age-days', (t) => {
  const projects = freshFinished(t);
  const out = capture();
  assert.equal(main(['--projects-dir', projects, '--project', 'a', '--min-age-days', '3', '--yes'], { log: out.log, error: out.log }), 0);
  assert.match(out.text(), /пропущен – менялся 0 дн\. назад/);
  assert.ok(fs.existsSync(path.join(projects, 'a', 'tmp', 'a.wav')));
});

test('clean --project --level archive keeps final, current brief, layer sources, original and active revision', (t) => {
  const projects = freshFinished(t);
  assert.equal(main(['--projects-dir', projects, '--project', 'a', '--level', 'archive', '--yes'], { log: () => {}, error: () => {} }), 0);
  const a = path.join(projects, 'a');
  for (const kept of ['final/demo.mp4', APPROVED, 'motion-v01/src/Root.jsx', 'motion-v01/layer.json',
    'motion-v01/public/fonts/Onest.ttf', 'input/source.mp4', 'input/source-v03.mp4',
    'assets/broll/video/abc/media.mp4', 'previews/broll/abc.webm', 'transcript/words.json', 'edit/v03-source.json']) {
    assert.ok(fs.existsSync(path.join(a, ...kept.split('/'))), kept);
  }
  for (const removed of ['input/source-v02.mp4', 'assets/broll/video/old/media.mp4', 'tmp/a.wav', 'renders/v01-x/raw.mp4']) {
    assert.ok(!fs.existsSync(path.join(a, ...removed.split('/'))), removed);
  }
});

test('clean --project keeps the other safety checks: lock and pending pult edits', (t) => {
  const projects = projectsWithTwoFinished(t);
  put(path.join(projects, 'a'), '.project-mutation.lock', '{}');
  put(path.join(projects, 'b'), 'pult/comments.json', JSON.stringify({ version: 1, comments: [comment('new')] }));
  for (const [name, reason] of [['a', /идёт работа \(lock\)/], ['b', /не готов в пульте/]]) {
    const out = capture();
    assert.equal(main(['--projects-dir', projects, '--project', name, '--yes'], { now: NOW, log: out.log, error: out.log }), 0);
    assert.match(out.text(), reason);
    assert.ok(fs.existsSync(path.join(projects, name, 'tmp', 'a.wav')));
  }
});

test('clean --project without --yes lists the files of that folder', (t) => {
  const projects = projectsWithTwoFinished(t);
  const out = capture();
  assert.equal(main(['--projects-dir', projects, '--project', 'a'], { now: NOW, log: out.log, error: out.log }), 0);
  assert.match(out.text(), /tmp\/a\.wav/);
  assert.match(out.text(), /renders\/v01-x\/raw\.mp4/);
  assert.ok(fs.existsSync(path.join(projects, 'a', 'tmp', 'a.wav')));
});

test('clean --project rejects names outside projects and missing folders', (t) => {
  const projects = projectsWithTwoFinished(t);
  for (const value of ['..', '../a', 'a/../b', '/etc', '.archive', 'missing']) {
    const out = capture();
    assert.equal(main(['--projects-dir', projects, '--project', value, '--yes'], { now: NOW, log: out.log, error: out.log }), 1, value);
    assert.match(out.text(), /--project/, value);
  }
  assert.ok(fs.existsSync(path.join(projects, '.archive', 'old.mp4')));
});

test('cleanupHint names the archive size and the exact command for a fresh final', (t) => {
  const projects = freshFinished(t);
  const dir = path.join(projects, 'a');
  const plan = planProjectCleanup(dir, { level: 'archive', minAgeDays: 0 });
  assert.equal(cleanupHint(dir), `Можно освободить ${formatSize(plan.bytes)}: automontage clean --projects-dir ${projects} --project a --level archive --yes`);
});

// Ролик вне projects/ движка: строка называет его папку проектов, и её команда чистит именно его.
test('the command from the hint cleans exactly that reel', (t) => {
  const projects = freshFinished(t);
  const command = cleanupHint(path.join(projects, 'a')).split(': automontage clean ')[1].split(' ');
  assert.equal(main(command, { log: () => {}, error: () => {} }), 0);
  assert.ok(!fs.existsSync(path.join(projects, 'a', 'tmp', 'a.wav')));
  assert.ok(fs.existsSync(path.join(projects, 'b', 'tmp', 'a.wav')));
});

test('cleanupHint is null when there is nothing to free, when the project is not finished or unreadable', (t) => {
  const projects = freshFinished(t);
  const dir = path.join(projects, 'a');
  assert.equal(main(['--projects-dir', projects, '--project', 'a', '--level', 'archive', '--yes'], { log: () => {}, error: () => {} }), 0);
  assert.equal(planProjectCleanup(dir, { level: 'archive', minAgeDays: 0 }).bytes, 0);
  assert.equal(cleanupHint(dir), null);
  put(path.join(projects, 'b'), '.project-mutation.lock', '{}');
  assert.equal(cleanupHint(path.join(projects, 'b')), null);
  assert.equal(cleanupHint(path.join(projects, 'missing')), null);
  const broken = new Proxy(fs, { get: (target, key) => (key === 'existsSync' ? () => { throw new Error('io'); } : target[key]) });
  assert.equal(cleanupHint(path.join(projects, 'b'), { fileSystem: broken }), null);
});

test('printCleanupHint prints one line or nothing and never throws', (t) => {
  const projects = freshFinished(t);
  const lines = [];
  printCleanupHint(path.join(projects, 'a'), (line) => lines.push(line));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^Можно освободить .+: automontage clean --projects-dir \S+ --project a --level archive --yes$/);
  const none = [];
  printCleanupHint(path.join(projects, 'missing'), (line) => none.push(line));
  assert.deepEqual(none, []);
  assert.doesNotThrow(() => printCleanupHint(path.join(projects, 'a'), () => { throw new Error('closed stdout'); }));
});

test('a final promoted from the preview gets the hint right away (no 3-day pause)', (t) => {
  const { projectsDir } = makePultRoot(t);
  const { projectDir, workspace, approved } = addDraftProject(projectsDir, { folder: 'promoted', approve: true, cleanPreview: true });
  const { promoteApprovedPreview } = require('../scripts/project/promote-preview');
  assert.equal(promoteApprovedPreview(workspace, approved.jsonPath).promoted, true);
  put(projectDir, 'tmp/scratch.wav', 'x'.repeat(2048));
  assert.match(cleanupHint(projectDir), /: automontage clean --projects-dir \S+ --project promoted --level archive --yes$/);
});

// Подсказка печатается после каждого пути к финалу: lesson-рендер, motion-рендер, продвижение preview.
for (const [file, anchor] of [
  ['scripts/build.js', 'готово по утверждённому ТЗ'],
  ['scripts/motion/build.js', 'Motion final:'],
  ['scripts/project/approve-brief.js', 'копия просмотренного preview'],
]) {
  test(`${file} prints the cleanup hint after the final`, () => {
    const text = fs.readFileSync(path.join(__dirname, '..', ...file.split('/')), 'utf8');
    const finalAt = text.indexOf(anchor);
    const hintAt = text.indexOf('printCleanupHint(', finalAt);
    assert.ok(finalAt > 0 && hintAt > finalAt, file);
  });
}

test('approve-brief.js prints the hint line right after the promoted final', (t) => {
  const { projectsDir } = makePultRoot(t);
  const { projectDir, draft } = addDraftProject(projectsDir, { folder: 'cli-hint', cleanPreview: true });
  put(projectDir, 'tmp/scratch.wav', 'x'.repeat(4096));
  const output = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'project', 'approve-brief.js'),
    projectDir, draft.jsonPath, '--confirm-preview-viewed'], { encoding: 'utf8' });
  const lines = output.trim().split('\n');
  const finalAt = lines.findIndex((line) => line.startsWith('final: '));
  assert.ok(finalAt >= 0, output);
  assert.match(lines.at(-1), /^Можно освободить .+: automontage clean --projects-dir \S+ --project cli-hint --level archive --yes$/);
});
