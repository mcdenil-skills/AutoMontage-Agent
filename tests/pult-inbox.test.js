const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildInbox, formatInbox, formatSourceTime, main, parseInboxOptions,
} = require('../scripts/pult/inbox');
const { scanProjects } = require('../scripts/pult/catalog');
const { addComment } = require('../scripts/pult/comments');
const { cardIdFor } = require('../scripts/pult/cards');
const { setArchived } = require('../scripts/pult/state');
const {
  addDraftProject, addLegacyFolder, addRoughCutProject, bumpSourceRevision, makePultRoot, republishRoughCut,
} = require('./helpers/pult-projects');

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
// пользователь спрятал её осознанно (Task A1, вариант А из плана доводки пульта). Окончание
// строки для архивного случая – «По просьбе пользователя – …», а не «Собери финал» без
// условия: одна строка не должна одновременно запрещать и предписывать действие.
test('an approved video without a final that is archived is marked in the inbox', (t) => {
  const { projectsDir } = makePultRoot(t);
  addDraftProject(projectsDir, { folder: 'archived-approved', name: 'Утверждённый в архиве', approve: true });
  const entry = scanProjects({ projectsDir }).entries.find((item) => item.key === 'archived-approved');
  setArchived(projectsDir, cardIdFor(entry), true);
  const text = formatInbox(buildInbox({ projectsDir }), { projectsDir, cwd: path.dirname(projectsDir) });
  assert.match(
    text,
    /- Утверждено \(в архиве – не начинай без просьбы пользователя\): `brief\/v\d{2}-approved\.lesson\.json`\. По просьбе пользователя – собери финал и проведи полный QA\./,
  );
});

// Одна и та же папка может одновременно ждать финала архивной версии и содержать новую
// правку – архив должен пометить только строку утверждения, правка остаётся обычной.
test('an archived video with an unfinaled approval and a new edit marks only the approval line', (t) => {
  const { projectsDir } = makePultRoot(t);
  const project = addDraftProject(projectsDir, { folder: 'archived-mixed', name: 'Архивный смешанный', approve: true });
  const entry = scanProjects({ projectsDir }).entries.find((item) => item.key === 'archived-mixed');
  setArchived(projectsDir, cardIdFor(entry), true);
  addComment(project.projectDir, { timeSec: 3.2, text: 'Поправь титр', video: entry.video }, { id: () => 'c-9001' });
  const text = formatInbox(buildInbox({ projectsDir }), { projectsDir, cwd: path.dirname(projectsDir) });
  assert.match(
    text,
    /- Утверждено \(в архиве – не начинай без просьбы пользователя\): `brief\/v\d{2}-approved\.lesson\.json`\. По просьбе пользователя – собери финал и проведи полный QA\./,
  );
  assert.match(text, /- Правка `c-9001` на 0:03: «Поправь титр»/);
  assert.doesNotMatch(text, /Правка `c-9001`[^\n]*в архиве/);
});

// Варианты одной темы делят один id карточки (`group:<id>`, см. cardIdFor) – архивация
// карточки темы должна пометить утверждение каждого варианта, а не только первого.
test('archiving a group marks the unfinaled approval of every variant in that group', (t) => {
  const { projectsDir } = makePultRoot(t);
  const group = { id: 'tema-x', title: 'Тема X' };
  addDraftProject(projectsDir, {
    folder: 'tema-x-original',
    name: 'Тема X – оригинал',
    approve: true,
    card: { version: 1, group, variantLabel: 'Оригинал' },
  });
  addDraftProject(projectsDir, {
    folder: 'tema-x-hook1',
    name: 'Тема X – хук 1',
    approve: true,
    card: { version: 1, group, variantLabel: 'Хук 1' },
  });
  const original = scanProjects({ projectsDir }).entries.find((item) => item.key === 'tema-x-original');
  setArchived(projectsDir, cardIdFor(original), true);
  const text = formatInbox(buildInbox({ projectsDir }), { projectsDir, cwd: path.dirname(projectsDir) });
  const markedApprovals = text.match(/- Утверждено \(в архиве – не начинай без просьбы пользователя\)/g) || [];
  assert.equal(markedApprovals.length, 2);
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

// Черновая нарезка: автор смотрит копию, а не исходник, поэтому секунду правки переводим в секунду
// исходника по списку кусков этой копии – агент режет нужное место в оригинале.
const captureStub = (videoPath, timeSec, outPath) => {
  fs.writeFileSync(outPath, 'jpg');
  return true;
};

function addRoughCutEdit(projectsDir, folder, { timeSec = 2.5, text = 'Оговорка', id = 'c-0001' } = {}) {
  const entry = scanProjects({ projectsDir }).entries.find((item) => item.key === folder);
  addComment(path.join(projectsDir, folder), { timeSec, text, video: entry.video }, {
    id: () => id,
    captureFrame: captureStub,
  });
}

function inboxText(projectsDir) {
  return formatInbox(buildInbox({ projectsDir }), { projectsDir, cwd: path.dirname(projectsDir) });
}

test('formatSourceTime shows minutes and hundredths of a second', () => {
  assert.equal(formatSourceTime(31.2), '0:31.20');
  assert.equal(formatSourceTime(75.5), '1:15.50');
  assert.equal(formatSourceTime(0), '0:00.00');
  assert.equal(formatSourceTime(3.5), '0:03.50');
  // Округление до сотых не должно давать «0:59.100» или «0:60.00».
  assert.equal(formatSourceTime(59.999), '1:00.00');
  assert.equal(formatSourceTime(3599.994), '59:59.99');
});

test('an edit to the rough cut gets the source second from the cut list', (t) => {
  const { projectsDir } = makePultRoot(t);
  addRoughCutProject(projectsDir, { folder: 'rough', name: 'Нарезка' });
  addRoughCutEdit(projectsDir, 'rough');
  const text = inboxText(projectsDir);
  assert.match(
    text,
    /^- Правка `c-0001` к черновой нарезке на 0:02 \(в исходнике ревизии 1: 0:03\.50\): «Оговорка»\. Видео: `previews\/roughcut-v01\.mp4`\. Кадр: `projects\/rough\/pult\/frames\/c-0001\.jpg`\.$/m,
  );
  const [item] = buildInbox({ projectsDir });
  assert.equal(item.roughCutConfirmed, null);
  assert.equal(item.comments[0].sourceTimeSec, 3.5);
  assert.equal(item.comments[0].sourceRevision, 1);
  // Нарезка в review строки «подтверждена» не даёт: ход за автором.
  assert.doesNotMatch(text, /Нарезка подтверждена/);
});

test('a second inside the first piece maps one to one, the end of the cut maps to the end of the last piece', (t) => {
  const { projectsDir } = makePultRoot(t);
  addRoughCutProject(projectsDir, { folder: 'rough' });
  addRoughCutEdit(projectsDir, 'rough', { timeSec: 1.2, text: 'Начало', id: 'c-0001' });
  addRoughCutEdit(projectsDir, 'rough', { timeSec: 4, text: 'Конец', id: 'c-0002' });
  const text = inboxText(projectsDir);
  assert.match(text, /на 0:01 \(в исходнике ревизии 1: 0:01\.20\): «Начало»/);
  // Нарезка длится 4 с (2 + 2): секунда 4 – конец последнего куска исходника, 5 с.
  assert.match(text, /на 0:04 \(в исходнике ревизии 1: 0:05\.00\): «Конец»/);
});

// Review Focus 5: правка осталась от нарезки v01, агент уже собрал v02. Секунда исходника
// считается по списку v01, иначе место выреза уехало бы на длину кусков новой нарезки.
test('an edit left on an older rough cut is marked and still maps through its own cut list', (t) => {
  const { projectsDir } = makePultRoot(t);
  const { projectDir } = addRoughCutProject(projectsDir, { folder: 'rough' });
  addRoughCutEdit(projectsDir, 'rough');
  republishRoughCut(projectDir, { version: 2, keep: [{ start: 0, end: 4 }] });
  const text = inboxText(projectsDir);
  const line = text.split('\n').find((row) => row.startsWith('- Правка `c-0001`'));
  assert.match(line, /к черновой нарезке на 0:02 \(к прежней версии видео\)/);
  assert.match(line, /в исходнике ревизии 1: 0:03\.50/);
  assert.match(line, /Видео: `previews\/roughcut-v01\.mp4`/);
  // По списку v02 (0–4) та же секунда была бы 0:02.50: сверяем, что взят именно список v01.
  assert.doesNotMatch(line, /0:02\.50/);
});

test('an unreadable or broken cut list gives the plain edit line without the source second', (t) => {
  const { projectsDir } = makePultRoot(t);
  const { projectDir } = addRoughCutProject(projectsDir, { folder: 'rough' });
  addRoughCutEdit(projectsDir, 'rough');
  const editFile = path.join(projectDir, 'edit', 'roughcut-v01.json');
  const brokenLists = [
    '{ not json',
    JSON.stringify({ version: 1, sourceRevision: 1, fps: 25, keep: [] }),
    JSON.stringify({ version: 1, sourceRevision: 1, fps: 25, keep: [{ start: 2, end: 1 }] }),
    JSON.stringify({ version: 1, sourceRevision: 1, fps: 25, keep: [{ start: 0, end: 2 }, { start: 1, end: 3 }] }),
    JSON.stringify({ version: 1, sourceRevision: 1, fps: 25 }),
    JSON.stringify({ version: 1, fps: 25, keep: [{ start: 0, end: 2 }] }),
    JSON.stringify({ version: 1, sourceRevision: 0, fps: 25, keep: [{ start: 0, end: 2 }] }),
    'null',
  ];
  for (const body of brokenLists) {
    fs.writeFileSync(editFile, body);
    const text = inboxText(projectsDir);
    assert.match(
      text,
      /^- Правка `c-0001` к черновой нарезке на 0:02: «Оговорка»\. Видео: `previews\/roughcut-v01\.mp4`\./m,
      body,
    );
    assert.doesNotMatch(text, /в исходнике/, body);
    const [item] = buildInbox({ projectsDir });
    assert.equal(item.comments[0].sourceTimeSec, null, body);
    assert.equal(item.comments[0].sourceRevision, null, body);
  }
  // Списка нет вовсе – то же самое.
  fs.rmSync(editFile);
  const missing = inboxText(projectsDir);
  assert.match(missing, /^- Правка `c-0001` к черновой нарезке на 0:02: «Оговорка»\. Видео:/m);
  assert.doesNotMatch(missing, /в исходнике/);
});

test('a cut list that is a symbolic link out of the project is not read', (t) => {
  const { projectsDir } = makePultRoot(t);
  const { projectDir } = addRoughCutProject(projectsDir, { folder: 'rough' });
  addRoughCutEdit(projectsDir, 'rough');
  const outside = path.join(path.dirname(projectsDir), 'outside-list.json');
  fs.writeFileSync(outside, JSON.stringify({ version: 1, sourceRevision: 1, fps: 25, keep: [{ start: 10, end: 20 }] }));
  const editFile = path.join(projectDir, 'edit', 'roughcut-v01.json');
  fs.rmSync(editFile);
  try {
    fs.symlinkSync(outside, editFile);
  } catch (error) {
    t.skip(`symlink недоступен: ${error.code}`);
    return;
  }
  const text = inboxText(projectsDir);
  // Паспорт с такой ссылкой каталог не читает (папка идёт как «не читается»), но правка автора
  // остаётся видна, а чужой файл не читается: секунды 10–20 из него в выводе нет.
  assert.doesNotMatch(text, /в исходнике/);
  assert.doesNotMatch(text, /0:1\d/);
  assert.match(text, /к черновой нарезке на 0:02[^\n]*: «Оговорка»/);
  const [item] = buildInbox({ projectsDir });
  assert.equal(item.comments[0].sourceTimeSec, null);
  assert.equal(item.comments[0].sourceRevision, null);
});

test('a confirmed rough cut without a master is listed once, with the list path', (t) => {
  const { projectsDir } = makePultRoot(t);
  addRoughCutProject(projectsDir, { folder: 'rough', name: 'Нарезка', status: 'confirmed' });
  const text = inboxText(projectsDir);
  assert.match(text, /## Нарезка – `projects\/rough`/);
  assert.match(
    text,
    /^- Нарезка подтверждена: `edit\/roughcut-v01\.json`\. Если к ней есть правки – скопируй список в edit\/vNN-source\.json и внеси их по секундам исходника; затем собери master и переходи к слою\.$/m,
  );
  assert.equal((text.match(/Нарезка подтверждена/g) || []).length, 1);
  assert.equal(buildInbox({ projectsDir })[0].roughCutConfirmed, 'edit/roughcut-v01.json');
});

test('a confirmed rough cut with edits lists the line and the edits together', (t) => {
  const { projectsDir } = makePultRoot(t);
  addRoughCutProject(projectsDir, { folder: 'rough', status: 'confirmed' });
  addRoughCutEdit(projectsDir, 'rough');
  const text = inboxText(projectsDir);
  assert.match(text, /^- Нарезка подтверждена: `edit\/roughcut-v01\.json`\./m);
  assert.match(text, /^- Правка `c-0001` к черновой нарезке на 0:02 \(в исходнике ревизии 1: 0:03\.50\)/m);
});

// Ruling R11: нажатие «Нарезка готова» – само явное решение автора, архив его не отменяет
// (как и правки). Пометки «в архиве» у этой строки нет.
test('a confirmed rough cut on an archived card is still listed, without an archive mark', (t) => {
  const { projectsDir } = makePultRoot(t);
  addRoughCutProject(projectsDir, { folder: 'rough', name: 'Нарезка', status: 'confirmed' });
  const entry = scanProjects({ projectsDir }).entries.find((item) => item.key === 'rough');
  setArchived(projectsDir, cardIdFor(entry), true);
  const text = inboxText(projectsDir);
  assert.match(text, /^- Нарезка подтверждена: `edit\/roughcut-v01\.json`\./m);
  assert.doesNotMatch(text, /в архиве/);
});

test('the confirmed line disappears once master moves the source to a new revision', (t) => {
  const { projectsDir } = makePultRoot(t);
  const { projectDir } = addRoughCutProject(projectsDir, { folder: 'rough', status: 'confirmed' });
  assert.match(inboxText(projectsDir), /Нарезка подтверждена/);
  bumpSourceRevision(projectDir);
  assert.equal(inboxText(projectsDir), 'Во входящих пульта пусто.');
});

test('a rough cut waiting for the author without edits leaves the inbox empty', (t) => {
  const { projectsDir } = makePultRoot(t);
  addRoughCutProject(projectsDir, { folder: 'rough', status: 'review' });
  assert.deepEqual(buildInbox({ projectsDir }), []);
  assert.equal(inboxText(projectsDir), 'Во входящих пульта пусто.');
});

test('terminal control characters in rough cut edits and paths never reach the output', () => {
  const projectsDir = path.join(path.sep, 'tmp', 'pult-inbox', 'projects');
  const text = formatInbox([{
    folder: 'clip',
    title: 'Ролик',
    approved: [],
    commentsBroken: false,
    passportError: null,
    roughCutConfirmed: 'edit/roughcut-v01\u001b[2J.json',
    comments: [{
      id: 'c-1',
      timeSec: 2.5,
      text: 'Оговорка \u001b]0;PWNED\u0007 конец',
      video: { kind: 'roughcut', path: 'previews/roughcut-v01\u009b.mp4', sha256: null },
      frame: null,
      outdated: false,
      sourceTimeSec: 3.5,
      sourceRevision: 1,
    }],
  }], { projectsDir, cwd: path.dirname(projectsDir) });
  assert.doesNotMatch(text, /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/);
  assert.match(text, /Нарезка подтверждена: `edit\/roughcut-v01 \[2J\.json`/);
  assert.match(text, /к черновой нарезке на 0:02 \(в исходнике ревизии 1: 0:03\.50\): «Оговорка {1,2}\]0;PWNED {1,2}конец»/);
});

test('a plain edit to a preview keeps its old line without the rough cut wording', (t) => {
  const { projectsDir } = withComment(t);
  const text = inboxText(projectsDir);
  assert.match(text, /^- Правка `c-0001` на 0:14: «Текст залезает на лицо»\. Видео: `previews\//m);
  assert.doesNotMatch(text, /черновой нарезке/);
  assert.doesNotMatch(text, /в исходнике/);
});
