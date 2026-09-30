// scripts/lead-magnet/inbox.js
const fs = require('node:fs');
const path = require('node:path');

const { isSafeName } = require('../pult/names');
const { readLeadMagnetComments } = require('./comments');
const { listLeadMagnets } = require('./library');
const { readDecisions } = require('./requests');

const FORMAT_NAMES = { guide: 'гайд по шагам', prompts: 'набор промптов', checklist: 'чек-лист', cheatsheet: 'шпаргалка' };
const DESIGN_NAMES = { brand: 'мой стиль', reference: 'по референсу', new: 'новый под тему', like: 'как прошлый' };
const TEXT_NAMES = { dm: 'личка', telegram: 'Telegram', instagram: 'Instagram' };

function strip(value) {
  return String(value).replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ').trim();
}

function videoFolders(projectsDir) {
  let dirents;
  try {
    dirents = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  return dirents.filter((dirent) => dirent.isDirectory() && !dirent.name.startsWith('.') && isSafeName(dirent.name)).map((dirent) => dirent.name);
}

function buildLeadMagnetInbox({ projectsDir }) {
  const decisions = [];
  const broken = [];
  for (const folder of videoFolders(projectsDir)) {
    const file = path.join(projectsDir, folder, 'pult', 'lead-magnet.json');
    if (!fs.existsSync(file)) continue;
    try {
      for (const decision of readDecisions(path.join(projectsDir, folder))) {
        if (decision.status === 'new') decisions.push({ folder, decision });
      }
    } catch (error) {
      broken.push({ where: `${folder}/pult/lead-magnet.json`, error: error.message });
    }
  }
  const comments = [];
  const library = listLeadMagnets(projectsDir);
  for (const problem of library.broken) broken.push({ where: `.lead-magnets/${problem.id}/lead-magnet.json`, error: problem.error });
  for (const passport of library.entries) {
    try {
      for (const comment of readLeadMagnetComments(projectsDir, passport.id)) {
        if (comment.status === 'new') comments.push({ id: passport.id, title: passport.title, comment });
      }
    } catch (error) {
      broken.push({ where: `.lead-magnets/${passport.id}/pult/comments.json`, error: error.message });
    }
  }
  return { decisions, comments, broken };
}

function describeParams(params) {
  const references = params.design.references.map((reference) => (reference.kind === 'url' ? reference.url : reference.path));
  return [
    `формат: ${FORMAT_NAMES[params.format]}`,
    `для кого: «${strip(params.audience) || 'не указано'}»`,
    `дизайн: ${DESIGN_NAMES[params.design.mode]}${params.design.likeId ? ` (${params.design.likeId})` : ''}`,
    references.length ? `референсы: ${references.map((item) => `\`${strip(item)}\``).join(', ')}` : null,
    params.design.mode === 'reference' ? `взять: ${Object.entries(params.design.take).filter(([, on]) => on).map(([key]) => key).join(', ')}` : null,
    params.design.note ? `что нравится: «${strip(params.design.note)}»` : null,
    `тексты: ${params.texts.map((kind) => TEXT_NAMES[kind]).join(', ') || 'нет'}`,
    params.wishes ? `пожелания: «${strip(params.wishes)}»` : null,
  ].filter(Boolean).join('; ');
}

function formatLeadMagnetInbox(inbox, { projectsDir }) {
  const lines = [];
  if (!inbox.decisions.length && !inbox.comments.length && !inbox.broken.length) return '';
  lines.push('## Лид-магниты', '');
  for (const problem of inbox.broken) {
    lines.push(`- Файл лид-магнита повреждён: \`${strip(problem.where)}\` (${strip(problem.error)}). Почини его, затем продолжай.`);
  }
  for (const { folder, decision } of inbox.decisions) {
    const where = `\`${strip(path.join(path.basename(projectsDir), folder))}\``;
    if (decision.type === 'create') {
      const word = decision.codeWord ? `на слово «${strip(decision.codeWord)}»` : 'без обещания в ролике';
      lines.push(`- Лид-магнит: запрос \`${decision.id}\` ${word} из ${where}. ${describeParams(decision.params)}. Собери черновик по навыку lead-magnet.`);
    } else if (decision.type === 'promise-refresh') {
      lines.push(`- Лид-магнит \`${decision.leadMagnetId}\`: обнови под новое обещание из ${where} (\`${decision.id}\`).`);
    } else if (decision.type === 'funnel-check') {
      lines.push(`- Лид-магнит \`${decision.leadMagnetId}\`: проверь воронку автоответа у поставщика (\`${decision.id}\`).`);
    }
  }
  for (const { id, comment } of inbox.comments) {
    const target = comment.target.kind === 'block'
      ? `к блоку «${strip(comment.target.blockId)}» (${comment.target.view === 'phone' ? 'телефон' : 'компьютер'})`
      : `к тексту «${TEXT_NAMES[comment.target.text]}»`;
    const snapshot = comment.snapshot ? ` Снимок: \`${strip(path.join(path.basename(projectsDir), '.lead-magnets', id, comment.snapshot))}\`.` : '';
    lines.push(`- Лид-магнит \`${id}\` v${String(comment.revision).padStart(2, '0')}: правка \`${comment.id}\` ${target}: «${strip(comment.text)}».${snapshot}`);
  }
  lines.push('', 'Запрос или правку лид-магнита после выполнения отметь: `automontage inbox --accept-lead <папка ролика или id лид-магнита> <id>`.');
  return lines.join('\n');
}

module.exports = { buildLeadMagnetInbox, formatLeadMagnetInbox };
