const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildInbox, formatInbox, main, parseInboxOptions } = require('../scripts/pult/inbox');
const { scanProjects } = require('../scripts/pult/catalog');
const { addComment } = require('../scripts/pult/comments');
const { cardIdFor } = require('../scripts/pult/cards');
const { setArchived } = require('../scripts/pult/state');
const { addDraftProject, addLegacyFolder, makePultRoot } = require('./helpers/pult-projects');

function withComment(t) {
  const { projectsDir } = makePultRoot(t);
  const waiting = addDraftProject(projectsDir, { folder: 'waiting', name: 'Ролик с правкой' });
  const entry = scanProjects({ projectsDir }).entries.find((item) => item.key === 'waiting');
  addComment(waiting.projectDir, { timeSec: 14.4, text: 'Текст\nзалезает на лицо', video: entry.video }, {
    id: () => 'c-0001',
    captureFrame: (videoPath, timeSec, outPath) => {
      fs.writeFileSync(outPath, 'jpg');
      return true;
    },
  });
  return { projectsDir, waiting };
}

test('an empty inbox says so', (t) => {
  const { projectsDir } = makePultRoot(t);
  addDraftProject(projectsDir, { folder: 'clip' });
  assert.equal(formatInbox(buildInbox({ projectsDir }), { projectsDir }), 'Во входящих пульта пусто.');
});

test('the inbox lists edits with time and frame, and approved videos without a final', (t) => {
  const { projectsDir } = withComment(t);
  addDraftProject(projectsDir, { folder: 'approved', name: 'Утверждённый', approve: true });
  const text = formatInbox(buildInbox({ projectsDir }), { projectsDir, cwd: path.dirname(projectsDir) });
  assert.match(text, /## Ролик с правкой – `projects\/waiting`/);
  assert.match(text, /- Правка `c-0001` на 0:14: «Текст залезает на лицо»\. Видео: `previews\//);
  assert.match(text, /Кадр: `projects\/waiting\/pult\/frames\/c-0001\.jpg`/);
  assert.match(text, /## Утверждённый – `projects\/approved`/);
  assert.match(text, /- Утверждено: `brief\/v\d{2}-approved\.lesson\.json`\. Собери финал и проведи полный QA\./);
  assert.match(text, /automontage inbox --accept <папка> <id>/);
});

// Архивная карточка без финала не должна выглядеть как обычное «начни собирать финал» –
// пользователь спрятал её осознанно (Task A1, вариант А из плана доводки пульта).
test('an approved video without a final that is archived is marked in the inbox', (t) => {
  const { projectsDir } = makePultRoot(t);
  addDraftProject(projectsDir, { folder: 'archived-approved', name: 'Утверждённый в архиве', approve: true });
  const entry = scanProjects({ projectsDir }).entries.find((item) => item.key === 'archived-approved');
  setArchived(projectsDir, cardIdFor(entry), true);
  const text = formatInbox(buildInbox({ projectsDir }), { projectsDir, cwd: path.dirname(projectsDir) });
  assert.match(
    text,
    /- Утверждено \(в архиве – не начинай без просьбы пользователя\): `brief\/v\d{2}-approved\.lesson\.json`\. Собери финал и проведи полный QA\./,
  );
});

// Тот же случай без архивации – строка остаётся ровно такой, как была раньше.
test('the same approved video, not archived, keeps the plain approval line', (t) => {
  const { projectsDir } = makePultRoot(t);
  addDraftProject(projectsDir, { folder: 'plain-approved', name: 'Утверждённый', approve: true });
  const text = formatInbox(buildInbox({ projectsDir }), { projectsDir, cwd: path.dirname(projectsDir) });
  assert.match(
    text,
    /- Утверждено: `brief\/v\d{2}-approved\.lesson\.json`\. Собери финал и проведи полный QA\./,
  );
  assert.doesNotMatch(text, /в архиве/);
});

// Новая правка в архивном ролике – явная новая работа автора, её агент должен увидеть как обычно.
test('a new edit on an archived video is listed the same as usual', (t) => {
  const { projectsDir, waiting } = withComment(t);
  const entry = scanProjects({ projectsDir }).entries.find((item) => item.key === 'waiting');
  setArchived(projectsDir, cardIdFor(entry), true);
  const text = formatInbox(buildInbox({ projectsDir }), { projectsDir, cwd: path.dirname(projectsDir) });
  assert.match(text, /- Правка `c-0001` на 0:14: «Текст залезает на лицо»\. Видео: `previews\//);
  assert.doesNotMatch(text, /в архиве/);
});

// Битый projects/.pult/state.json не должен ронять входящие – архив просто считается пустым
// (readPultState уже гасит порчу файла; здесь проверяем интеграцию с inbox).
test('a corrupted state.json does not break the inbox, the archive counts as empty', (t) => {
  const { projectsDir } = makePultRoot(t);
  addDraftProject(projectsDir, { folder: 'approved', name: 'Утверждённый', approve: true });
  fs.mkdirSync(path.join(projectsDir, '.pult'), { recursive: true });
  fs.writeFileSync(path.join(projectsDir, '.pult', 'state.json'), '{ broken');
  const text = formatInbox(buildInbox({ projectsDir }), { projectsDir, cwd: path.dirname(projectsDir) });
  assert.match(
    text,
    /- Утверждено: `brief\/v\d{2}-approved\.lesson\.json`\. Собери финал и проведи полный QA\./,
  );
  assert.doesNotMatch(text, /в архиве/);
});

test('edits to an older video are marked', (t) => {
  const { projectsDir, waiting } = withComment(t);
  const file = path.join(waiting.projectDir, 'pult', 'comments.json');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  value.comments[0].video.sha256 = 'f'.repeat(64);
  fs.writeFileSync(file, JSON.stringify(value));
  const text = formatInbox(buildInbox({ projectsDir }), { projectsDir, cwd: path.dirname(projectsDir) });
  assert.match(text, /на 0:14 \(к прежней версии видео\)/);
});

test('accepting an edit removes it from the inbox', (t) => {
  const { projectsDir } = withComment(t);
  const output = [];
  const code = main(['--projects-dir', projectsDir, '--accept', 'waiting', 'c-0001'], { write: (line) => output.push(line) });
  assert.equal(code, 0);
  assert.match(output.join('\n'), /c-0001/);
  assert.deepEqual(buildInbox({ projectsDir }), []);
});

test('options reject unsafe folders and ids', () => {
  assert.throws(() => parseInboxOptions(['--accept', '../x', 'c-1']), /папк/);
  assert.throws(() => parseInboxOptions(['--accept', 'clip', '../c']), /правк/);
  assert.throws(() => parseInboxOptions(['--bogus']), /опци/);
  assert.equal(parseInboxOptions(['--projects-dir', 'x']).projectsDir, path.resolve('x'));
});

test('a corrupted comments.json is reported instead of silently dropped', (t) => {
  const { projectsDir } = withComment(t);
  const broken = addDraftProject(projectsDir, { folder: 'broken', name: 'Сломанный' });
  fs.mkdirSync(path.join(broken.projectDir, 'pult'), { recursive: true });
  fs.writeFileSync(path.join(broken.projectDir, 'pult', 'comments.json'), '{ broken');
  const text = formatInbox(buildInbox({ projectsDir }), { projectsDir, cwd: path.dirname(projectsDir) });
  assert.match(text, /## Сломанный – `projects\/broken`/);
  assert.match(
    text,
    /- Файл правок повреждён: `projects\/broken\/pult\/comments\.json`\. Проверь его и попроси автора повторить правки в пульте\./,
  );
  // Остальная часть входящих не должна пострадать из-за одной сломанной папки.
  assert.match(text, /## Ролик с правкой – `projects\/waiting`/);
  assert.match(text, /- Правка `c-0001` на 0:14/);
});

test('a folder with an unreadable project.json still shows its pending edits', (t) => {
  const { projectsDir, waiting } = withComment(t);
  // Паспорт битый, но правка на диске никуда не делась – её нельзя терять из виду.
  fs.writeFileSync(path.join(waiting.projectDir, 'project.json'), '{ not valid json');
  const text = formatInbox(buildInbox({ projectsDir }), { projectsDir, cwd: path.dirname(projectsDir) });
  assert.match(text, /## waiting – `projects\/waiting`/);
  assert.match(
    text,
    /- Паспорт ролика не читается: Паспорт ролика не читается\. Почини паспорт, затем выполни правки\./,
  );
  assert.match(text, /- Правка `c-0001` на 0:14/);
});

test('a folder without a project.json at all still shows its pending edits', (t) => {
  const { projectsDir, waiting } = withComment(t);
  fs.rmSync(path.join(waiting.projectDir, 'project.json'));
  const text = formatInbox(buildInbox({ projectsDir }), { projectsDir, cwd: path.dirname(projectsDir) });
  assert.match(text, /## waiting – `projects\/waiting`/);
  assert.match(
    text,
    /- Паспорт ролика не читается: У папки нет паспорта ролика \(project\.json\)\. Почини паспорт, затем выполни правки\./,
  );
  assert.match(text, /- Правка `c-0001` на 0:14/);
});

test('a passport-broken folder without any comments file is not inbox noise', (t) => {
  const { projectsDir } = makePultRoot(t);
  const dir = path.join(projectsDir, 'silent');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'project.json'), '{ not valid json');
  const text = formatInbox(buildInbox({ projectsDir }), { projectsDir, cwd: path.dirname(projectsDir) });
  assert.equal(text, 'Во входящих пульта пусто.');
});

// Подменённый comments.json с escape-последовательностью в пути видео: раньше она уходила
// в терминал агента как есть (смена заголовка окна, очистка экрана). Теперь такой файл
// правок считается повреждённым, а в выводе нет ни одного управляющего байта.
test('a tampered video path with terminal escapes marks the edits file broken instead of printing it', (t) => {
  const { projectsDir } = makePultRoot(t);
  const dir = addLegacyFolder(projectsDir, 'legacy', {
    card: { version: 1, legacy: { status: 'ready', variants: [{ label: 'A', video: 'a.mp4' }] } },
    files: { 'a.mp4': 'x' },
  });
  fs.mkdirSync(path.join(dir, 'pult'));
  fs.writeFileSync(path.join(dir, 'pult', 'comments.json'), JSON.stringify({
    version: 1,
    comments: [{
      id: 'c-1',
      createdAt: 'x',
      timeSec: 1,
      text: 'ok',
      status: 'new',
      frame: null,
      video: { kind: 'final', path: 'a.mp4\u001b]0;PWNED\u0007\u001b[2J', sha256: null },
    }],
  }));
  const text = formatInbox(buildInbox({ projectsDir }), { projectsDir, cwd: path.dirname(projectsDir) });
  assert.match(text, /- Файл правок повреждён: `projects\/legacy\/pult\/comments\.json`/);
  assert.doesNotMatch(text, /PWNED/);
  assert.doesNotMatch(text, /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/);
});

// Имя папки на диске может содержать C1-символ (CSI \u009b): isSafeName отсекает только
// C0 и DEL. Каждое подставляемое в вывод значение – путь папки, brief, видео, кадра и id –
// проходит ту же очистку, что и текст правки, а обычные значения печатаются без изменений.
test('every value printed by the inbox is stripped of control characters', () => {
  const projectsDir = path.join(path.sep, 'tmp', 'pult-inbox', 'projects');
  const cwd = path.dirname(projectsDir);
  const item = (folder, { briefPath, videoPath, id }) => ({
    folder,
    title: 'Ролик',
    approved: [{ briefPath, archived: false }],
    commentsBroken: true,
    passportError: null,
    comments: [{
      id,
      timeSec: 1,
      text: 'ok',
      video: { kind: 'preview', path: videoPath, sha256: null },
      frame: `pult/frames/${id}.jpg`,
      outdated: false,
    }],
  });
  const dirty = formatInbox([item('clip\u009b2J', {
    briefPath: 'brief/v01\u001b[2J-approved.lesson.json',
    videoPath: 'previews/a\u009b.mp4',
    id: 'c-1\u0007',
  })], { projectsDir, cwd });
  assert.doesNotMatch(dirty, /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/);
  assert.match(dirty, /## Ролик – `projects\/clip 2J`/);
  assert.match(dirty, /Утверждено: `brief\/v01 \[2J-approved\.lesson\.json`/);

  const clean = formatInbox([item('clip', {
    briefPath: 'brief/v01-approved.lesson.json',
    videoPath: 'Мой ролик/финал  v2.mp4',
    id: 'c-0001',
  })], { projectsDir, cwd });
  assert.match(clean, /## Ролик – `projects\/clip`/);
  assert.match(clean, /- Файл правок повреждён: `projects\/clip\/pult\/comments\.json`/);
  assert.match(clean, /- Утверждено: `brief\/v01-approved\.lesson\.json`\./);
  // Путь – не свободный текст: двойной пробел в имени файла остаётся как есть.
  assert.match(clean, /- Правка `c-0001` на 0:01: «ok»\. Видео: `Мой ролик\/финал {2}v2\.mp4`\. Кадр: `projects\/clip\/pult\/frames\/c-0001\.jpg`\./);
});

test('comment text is stripped of terminal control characters, plain text stays intact', (t) => {
  const { projectsDir } = makePultRoot(t);
  const project = addDraftProject(projectsDir, { folder: 'esc', name: 'Эскейп' });
  const entry = scanProjects({ projectsDir }).entries.find((item) => item.key === 'esc');
  addComment(project.projectDir, {
    timeSec: 1,
    text: 'Текст \u001b[31mRED\u001b[0m \u0007 \u001b]0;title\u0007 конец',
    video: entry.video,
  }, { id: () => 'c-0002' });
  addComment(project.projectDir, {
    timeSec: 2,
    text: 'Обычный текст без сюрпризов',
    video: entry.video,
  }, { id: () => 'c-0003' });
  const text = formatInbox(buildInbox({ projectsDir }), { projectsDir, cwd: path.dirname(projectsDir) });
  assert.ok(!text.includes('\u001b'), 'escape-последовательности не должны попадать в терминал');
  assert.ok(!text.includes('\u0007'), 'символ BEL не должен попадать в терминал');
  assert.match(text, /Текст/);
  assert.match(text, /RED/);
  assert.match(text, /конец/);
  assert.match(text, /Обычный текст без сюрпризов/);
});
