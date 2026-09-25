#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const { scanProjects } = require('./catalog');
const { cardIdFor } = require('./cards');
const { COMMENT_ID, acceptComment, readComments } = require('./comments');
const { isSafeName } = require('./names');
const { readPultState } = require('./state');

const ROOT = path.resolve(__dirname, '../..');

function formatTime(seconds) {
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function readNewComments(projectDir) {
  try {
    return { comments: readComments(projectDir).filter((comment) => comment.status === 'new'), broken: false };
  } catch (_) {
    return { comments: [], broken: true };
  }
}

// Собирает входящие по каждой папке ролика: новые правки и утверждения без финала.
// Битый comments.json нельзя тихо пропускать – правки автора иначе незаметно
// исчезнут из поля зрения агента, поэтому такая папка тоже попадает в результат
// с флагом commentsBroken, даже если утверждений в ней нет.
//
// Утверждённая, но архивная карточка остаётся во входящих, но с пометкой «в архиве»
// (DECISIONS.md D-030): пользователь спрятал ролик осознанно, агент не должен сам браться за
// финал без просьбы. Пульт сам возвращает карточку из архива, когда утверждение проходит через
// его собственную кнопку «Утверждаю» (scripts/pult/server.js, /api/approve) – эта пометка
// появляется, когда утверждение случилось иначе (Review Workbench, CLI в чате) или когда
// пользователь убрал карточку в архив уже после утверждения. Новые правки того же ролика архив
// не трогает – это явная новая работа автора.
function buildInbox({ projectsDir }) {
  const archivedIds = new Set(readPultState(projectsDir).archived);
  const byFolder = new Map();
  const scan = scanProjects({ projectsDir });
  for (const entry of scan.entries) {
    let item = byFolder.get(entry.folder);
    if (!item) {
      const { comments, broken } = readNewComments(path.join(projectsDir, entry.folder));
      item = {
        folder: entry.folder,
        title: entry.title,
        approved: [],
        comments,
        commentsBroken: broken,
        passportError: null,
        currentVideos: new Set(),
      };
      byFolder.set(entry.folder, item);
    }
    if (entry.needsFinal) {
      item.approved.push({ briefPath: entry.briefPath, archived: archivedIds.has(cardIdFor(entry)) });
    }
    if (entry.video) item.currentVideos.add(`${entry.video.path}\0${entry.video.sha256}`);
  }

  // Паспорт ролика может не читаться (`broken`) или отсутствовать вовсе (`unregistered`):
  // такая папка не попадает в scan.entries, но правки на диске в ней никуда не делись.
  // Молча пропускать эти папки значило бы терять текст автора из виду только потому,
  // что паспорт сломан или его ещё не завели.
  const passportProblems = [
    ...scan.broken.map((problem) => ({ folder: problem.folder, passportError: problem.error })),
    ...scan.unregistered.map((problem) => ({
      folder: problem.folder,
      passportError: 'У папки нет паспорта ролика (project.json)',
    })),
  ];
  for (const problem of passportProblems) {
    if (byFolder.has(problem.folder)) continue;
    const { comments, broken } = readNewComments(path.join(projectsDir, problem.folder));
    // Без новых правок и без битого файла правок нечитаемая папка – забота каталога,
    // а не входящие пульта: не добавлять её, чтобы не шуметь.
    if (!comments.length && !broken) continue;
    byFolder.set(problem.folder, {
      folder: problem.folder,
      title: problem.folder.normalize('NFC'),
      approved: [],
      comments,
      commentsBroken: broken,
      passportError: problem.passportError,
      currentVideos: new Set(),
    });
  }

  return [...byFolder.values()]
    .filter((item) => item.comments.length || item.approved.length || item.commentsBroken || item.passportError)
    .map((item) => ({
      folder: item.folder,
      title: item.title,
      approved: item.approved,
      commentsBroken: item.commentsBroken,
      passportError: item.passportError,
      comments: item.comments.map((comment) => ({
        ...comment,
        outdated: !item.currentVideos.has(`${comment.video.path}\0${comment.video.sha256}`),
      })),
    }));
}

// Всё, что входящие подставляют в вывод, попадает прямо в терминал агента: текст правки,
// название ролика, ошибка паспорта, пути папки, brief, видео и кадра, id правки.
// Управляющие байты (ESC, BEL и другие C0/C1) вырезаем из каждого такого значения до
// печати: иначе чужой текст в comments.json или имя папки с C1-символом могли бы вставить
// ANSI-escape или сменить заголовок терминала.
function stripControls(value) {
  return String(value).replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ');
}

// Для свободного текста после этого ещё и схлопываем пробелы, как и раньше. Пути так не
// трогаем: двойной пробел в имени файла – часть пути.
function sanitizeText(value) {
  return stripControls(value).replace(/\s+/g, ' ');
}

function formatInbox(items, { projectsDir, cwd = process.cwd() }) {
  if (!items.length) return 'Во входящих пульта пусто.';
  const display = (absolute) => {
    const relative = path.relative(cwd, absolute);
    return stripControls(relative && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? relative.split(path.sep).join('/')
      : absolute);
  };
  const lines = ['# Входящие пульта', ''];
  for (const item of items) {
    const dir = path.join(projectsDir, item.folder);
    lines.push(`## ${sanitizeText(item.title)} – \`${display(dir)}\``, '');
    if (item.passportError) {
      lines.push(`- Паспорт ролика не читается: ${sanitizeText(item.passportError)}. Почини паспорт, затем выполни правки.`);
    }
    if (item.commentsBroken) {
      lines.push(`- Файл правок повреждён: \`${display(path.join(dir, 'pult', 'comments.json'))}\`. Проверь его и попроси автора повторить правки в пульте.`);
    }
    for (const approval of item.approved) {
      const briefPath = stripControls(approval.briefPath);
      // Архивная строка не должна одной фразой и запрещать, и предписывать действие: сначала
      // запрет («не начинай без просьбы»), а условие для сборки финала – отдельным предложением.
      lines.push(approval.archived
        ? `- Утверждено (в архиве – не начинай без просьбы пользователя): \`${briefPath}\`. По просьбе пользователя – собери финал и проведи полный QA.`
        : `- Утверждено: \`${briefPath}\`. Собери финал и проведи полный QA.`);
    }
    for (const comment of item.comments) {
      const outdated = comment.outdated ? ' (к прежней версии видео)' : '';
      const frame = comment.frame ? ` Кадр: \`${display(path.join(dir, ...comment.frame.split('/')))}\`.` : '';
      const text = sanitizeText(comment.text);
      const id = stripControls(comment.id);
      const video = stripControls(comment.video.path);
      lines.push(`- Правка \`${id}\` на ${formatTime(comment.timeSec)}${outdated}: «${text}». Видео: \`${video}\`.${frame}`);
    }
    lines.push('');
  }
  lines.push('После выполнения правки отметь её: `automontage inbox --accept <папка> <id>`.');
  return lines.join('\n');
}

function parseInboxOptions(argv, { root = ROOT } = {}) {
  const options = { projectsDir: path.join(root, 'projects'), accept: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--projects-dir') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--projects-dir требует путь');
      options.projectsDir = path.resolve(value);
      index += 1;
      continue;
    }
    if (argument === '--accept') {
      const folder = argv[index + 1];
      const id = argv[index + 2];
      if (typeof folder !== 'string' || !isSafeName(folder)) throw new Error('--accept: неверная папка ролика');
      if (typeof id !== 'string' || !COMMENT_ID.test(id)) throw new Error('--accept: неверный id правки');
      options.accept = { folder, id };
      index += 2;
      continue;
    }
    throw new Error(`неизвестная опция ${argument}`);
  }
  return options;
}

function main(argv = process.argv.slice(2), { write = (line) => console.log(line), cwd = process.cwd() } = {}) {
  try {
    const options = parseInboxOptions(argv);
    if (options.accept) {
      const projectDir = path.join(options.projectsDir, options.accept.folder);
      const stat = fs.lstatSync(projectDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('папка ролика не найдена');
      acceptComment(projectDir, options.accept.id);
      write(`Правка ${options.accept.id} отмечена принятой.`);
      return 0;
    }
    write(formatInbox(buildInbox({ projectsDir: options.projectsDir }), { projectsDir: options.projectsDir, cwd }));
    return 0;
  } catch (error) {
    write(`❌ inbox: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  buildInbox, formatInbox, main, parseInboxOptions,
};
