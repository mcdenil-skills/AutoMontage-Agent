#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const { scanProjects } = require('./catalog');
const { COMMENT_ID, acceptComment, readComments } = require('./comments');
const { isSafeName } = require('./names');

const ROOT = path.resolve(__dirname, '../..');

function formatTime(seconds) {
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// Собирает входящие по каждой папке ролика: новые правки и утверждения без финала.
// Битый comments.json нельзя тихо пропускать — правки автора иначе незаметно
// исчезнут из поля зрения агента, поэтому такая папка тоже попадает в результат
// с флагом commentsBroken, даже если утверждений в ней нет.
function buildInbox({ projectsDir }) {
  const byFolder = new Map();
  for (const entry of scanProjects({ projectsDir }).entries) {
    let item = byFolder.get(entry.folder);
    if (!item) {
      let comments = [];
      let commentsBroken = false;
      try {
        comments = readComments(path.join(projectsDir, entry.folder)).filter((comment) => comment.status === 'new');
      } catch (_) {
        commentsBroken = true;
      }
      item = {
        folder: entry.folder, title: entry.title, approved: [], comments, commentsBroken, currentVideos: new Set(),
      };
      byFolder.set(entry.folder, item);
    }
    if (entry.needsFinal) item.approved.push(entry.briefPath);
    if (entry.video) item.currentVideos.add(`${entry.video.path}\0${entry.video.sha256}`);
  }
  return [...byFolder.values()]
    .filter((item) => item.comments.length || item.approved.length || item.commentsBroken)
    .map((item) => ({
      folder: item.folder,
      title: item.title,
      approved: item.approved,
      commentsBroken: item.commentsBroken,
      comments: item.comments.map((comment) => ({
        ...comment,
        outdated: !item.currentVideos.has(`${comment.video.path}\0${comment.video.sha256}`),
      })),
    }));
}

function formatInbox(items, { projectsDir, cwd = process.cwd() }) {
  if (!items.length) return 'Во входящих пульта пусто.';
  const display = (absolute) => {
    const relative = path.relative(cwd, absolute);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? relative.split(path.sep).join('/')
      : absolute;
  };
  const lines = ['# Входящие пульта', ''];
  for (const item of items) {
    const dir = path.join(projectsDir, item.folder);
    lines.push(`## ${item.title} — \`${display(dir)}\``, '');
    if (item.commentsBroken) {
      lines.push(`- Файл правок повреждён: \`${display(path.join(dir, 'pult', 'comments.json'))}\`. Проверь его и попроси автора повторить правки в пульте.`);
    }
    for (const briefPath of item.approved) {
      lines.push(`- Утверждено: \`${briefPath}\`. Собери финал и проведи полный QA.`);
    }
    for (const comment of item.comments) {
      const outdated = comment.outdated ? ' (к прежней версии видео)' : '';
      const frame = comment.frame ? ` Кадр: \`${display(path.join(dir, ...comment.frame.split('/')))}\`.` : '';
      const text = comment.text.replace(/\s+/g, ' ');
      lines.push(`- Правка \`${comment.id}\` на ${formatTime(comment.timeSec)}${outdated}: «${text}». Видео: \`${comment.video.path}\`.${frame}`);
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
