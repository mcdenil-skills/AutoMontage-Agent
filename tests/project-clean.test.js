const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { applyCleanup, main, planCleanup, planProjectCleanup } = require('../scripts/project/clean');

const NOW = new Date('2026-10-10T12:00:00Z');
const OLD = new Date('2026-10-01T12:00:00Z');

function put(root, relative, content = 'xx') {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

// Готовый проект: финал, ТЗ, исходники, промежуточные рендеры. Все отметки времени – «давно».
function finishedProject(t, { manifest = {}, files = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '2026.09.01_demo');
  fs.mkdirSync(dir);
  const base = {
    version: 1,
    id: '2026.09.01_demo',
    final: 'final/demo.mp4',
    source: { originalLocalPath: 'input/source.mp4', localPath: 'input/source-v02.mp4' },
    currentPreview: null,
    ...manifest,
  };
  const all = {
    'final/demo.mp4': 'final-bytes',
    'brief/v02-approved.lesson.json': '{}',
    'transcript/words.json': '[]',
    'edit/v02-source.json': '{}',
    'qa/report.json': '{}',
    'input/source.mp4': 'original',
    'input/source-v02.mp4': 'revision',
    'renders/v01-x/raw.mp4': 'raw',
    'renders/v01-x/props.json': '{}',
    'previews/v01-draft-full.mp4': 'preview',
    'tmp/a.wav': 'wav',
    'motion-v01/src/Root.jsx': 'jsx',
    'motion-v01/layer.json': '{}',
    'motion-v01/renders/layer-01.mp4': 'layer',
    'motion-v01/public/speaker.mp4': 'speaker',
    'motion-v01/public/fonts/Onest.ttf': 'font',
    'assets/broll/video/abc/media.mp4': 'broll',
    'assets/music/m.wav': 'music',
    ...files,
  };
  for (const [relative, content] of Object.entries(all)) put(dir, relative, content);
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(base));
  for (const relative of ['project.json', base.final]) {
    if (fs.existsSync(path.join(dir, relative))) fs.utimesSync(path.join(dir, relative), OLD, OLD);
  }
  return { root, dir };
}

const paths = (plan) => plan.files.map((file) => file.path).sort();

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

test('archive level adds source revisions and imported b-roll but keeps the original and music', (t) => {
  const { dir } = finishedProject(t);
  const listed = paths(planProjectCleanup(dir, { now: NOW, level: 'archive' }));
  assert.ok(listed.includes('input/source-v02.mp4'));
  assert.ok(listed.includes('assets/broll/video/abc/media.mp4'));
  assert.ok(!listed.includes('input/source.mp4'));
  assert.ok(!listed.includes('assets/music/m.wav'));
  assert.ok(!listed.includes('final/demo.mp4'));
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
  fs.utimesSync(path.join(fresh.dir, 'project.json'), yesterday, yesterday);
  assert.equal(planProjectCleanup(fresh.dir, { now: NOW }).reason, 'менялся 1 дн. назад');

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
  assert.ok(!fs.existsSync(path.join(a, 'tmp', 'a.wav')));
  assert.ok(fs.existsSync(path.join(a, 'final', 'demo.mp4')));
  assert.ok(fs.existsSync(path.join(a, 'brief', 'v02-approved.lesson.json')));
  assert.ok(fs.existsSync(path.join(a, 'renders', 'v01-x', 'props.json')));
  assert.ok(!fs.existsSync(path.join(a, 'motion-v01', 'renders')));
  assert.ok(fs.existsSync(path.join(a, 'motion-v01', 'src', 'Root.jsx')));
  assert.ok(fs.existsSync(path.join(projects, '.archive', 'old.mp4')));
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
