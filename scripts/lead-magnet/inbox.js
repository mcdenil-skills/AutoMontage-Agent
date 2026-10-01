// scripts/lead-magnet/inbox.js
const fs = require('node:fs');
const path = require('node:path');

const { resolveProjectPath } = require('../project/workspace');
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

function prose(value) {
  return strip(value).replace(/[\\`*_\[\]<>]/g, '\\$&');
}

function code(value) {
  const clean = strip(value);
  const longest = Math.max(0, ...[...clean.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = '`'.repeat(longest + 1);
  return longest ? `${fence} ${clean} ${fence}` : `${fence}${clean}${fence}`;
}

function videoFolders(projectsDir) {
  let dirents;
  try {
    dirents = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch (error) {
    return { folders: [], error: error.code === 'ENOENT' ? null : error };
  }
  return {
    folders: dirents.filter((dirent) => dirent.isDirectory() && !dirent.name.startsWith('.') && isSafeName(dirent.name)).map((dirent) => dirent.name),
    error: null,
  };
}

function buildLeadMagnetInbox({ projectsDir }) {
  const decisions = [];
  const broken = [];
  const scan = videoFolders(projectsDir);
  if (scan.error) broken.push({ where: path.basename(projectsDir), error: scan.error.message });
  for (const folder of scan.folders) {
    try {
      const projectDir = path.join(projectsDir, folder);
      const file = resolveProjectPath(projectDir, 'pult/lead-magnet.json', { label: 'pult/lead-magnet.json', type: 'file' });
      try {
        fs.lstatSync(file);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      for (const decision of readDecisions(path.join(projectsDir, folder))) {
        if (decision.status === 'new') decisions.push({ folder, decision });
      }
    } catch (error) {
      broken.push({ where: `${folder}/pult/lead-magnet.json`, error: error.message });
    }
  }
  const comments = [];
  let library;
  try {
    library = listLeadMagnets(projectsDir);
  } catch (error) {
    broken.push({ where: '.lead-magnets', error: error.message });
    library = { entries: [], broken: [] };
  }
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
    `для кого: «${prose(params.audience) || 'не указано'}»`,
    `дизайн: ${DESIGN_NAMES[params.design.mode]}${params.design.likeId ? ` (${prose(params.design.likeId)})` : ''}`,
    references.length ? `референсы: ${references.map(code).join(', ')}` : null,
    params.design.mode === 'reference' ? `взять: ${Object.entries(params.design.take).filter(([, on]) => on).map(([key]) => key).join(', ')}` : null,
    params.design.note ? `что нравится: «${prose(params.design.note)}»` : null,
    `тексты: ${params.texts.map((kind) => TEXT_NAMES[kind]).join(', ') || 'нет'}`,
    params.cta ? `призыв: ${params.cta.mode === 'link' ? `«${prose(params.cta.label)}» → ${code(params.cta.url)}` : params.cta.mode === 'none' ? 'без призыва' : 'по бренд-паку'}` : null,
    params.wishes ? `пожелания: «${prose(params.wishes)}»` : null,
  ].filter(Boolean).join('; ');
}

function formatLeadMagnetInbox(inbox, { projectsDir }) {
  const lines = [];
  if (!inbox.decisions.length && !inbox.comments.length && !inbox.broken.length) return '';
  lines.push('## Лид-магниты', '');
  for (const problem of inbox.broken) {
    lines.push(`- Файл лид-магнита повреждён: ${code(problem.where)} (${prose(problem.error)}). Почини его, затем продолжай.`);
  }
  for (const { folder, decision } of inbox.decisions) {
    const where = code(path.join(path.basename(projectsDir), folder));
    if (decision.type === 'create') {
      const word = decision.codeWord ? `на слово «${prose(decision.codeWord)}»` : 'без обещания в ролике';
      lines.push(`- Лид-магнит: запрос \`${decision.id}\` ${word} из ${where}. ${describeParams(decision.params)}. Собери черновик по навыку lead-magnet.`);
    } else if (decision.type === 'promise-refresh') {
      lines.push(`- Лид-магнит \`${decision.leadMagnetId}\`: обнови под новое обещание из ${where} (\`${decision.id}\`).`);
    } else if (decision.type === 'funnel-check') {
      lines.push(`- Лид-магнит \`${decision.leadMagnetId}\`: проверь воронку автоответа у поставщика (\`${decision.id}\`).`);
    }
  }
  for (const { id, comment } of inbox.comments) {
    const target = comment.target.kind === 'block'
      ? `к блоку «${prose(comment.target.blockId)}» (${comment.target.view === 'phone' ? 'телефон' : 'компьютер'})`
      : `к тексту «${TEXT_NAMES[comment.target.text]}»`;
    const snapshot = comment.snapshot ? ` Снимок: ${code(path.join(path.basename(projectsDir), '.lead-magnets', id, comment.snapshot))}.` : '';
    lines.push(`- Лид-магнит \`${id}\` v${String(comment.revision).padStart(2, '0')}: правка \`${comment.id}\` ${target}: «${prose(comment.text)}».${snapshot}`);
  }
  lines.push('', 'Запрос или правку лид-магнита после выполнения отметь: `automontage inbox --accept-lead <папка ролика или id лид-магнита> <id>`.');
  return lines.join('\n');
}

module.exports = { buildLeadMagnetInbox, formatLeadMagnetInbox };
