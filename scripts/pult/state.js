const path = require('node:path');

const { readJsonIfExists, writeJsonAtomic } = require('./files');
const { SAFE_NAME } = require('./names');

const CARD_ID = new RegExp(`^(folder|group):${SAFE_NAME}$`, 'u');

function statePath(projectsDir) {
  return path.join(projectsDir, '.pult', 'state.json');
}

// Это собственные флаги пульта, не пользовательские данные: любая порча файла –
// пустой архив, а не отказ всей панели (сервер читает состояние на каждый GET /api/cards).
function readPultState(projectsDir) {
  let value;
  try {
    value = readJsonIfExists(statePath(projectsDir), '.pult/state.json');
  } catch (_) {
    return { version: 1, archived: [] };
  }
  if (value === undefined) return { version: 1, archived: [] };
  if (!value || value.version !== 1 || !Array.isArray(value.archived)) {
    return { version: 1, archived: [] };
  }
  return {
    version: 1,
    archived: value.archived.filter((id) => typeof id === 'string' && CARD_ID.test(id)),
  };
}

// Архив – только пометка «не показывать» в projects/.pult. Папки роликов не меняются.
function setArchived(projectsDir, cardId, archived) {
  if (typeof cardId !== 'string' || !CARD_ID.test(cardId)) throw new Error('неверный id карточки');
  const state = readPultState(projectsDir);
  if (archived && state.archived.includes(cardId)) return state;
  if (!archived && !state.archived.includes(cardId)) return state;
  const next = { version: 1, archived: state.archived.filter((id) => id !== cardId) };
  if (archived) next.archived.push(cardId);
  writeJsonAtomic(statePath(projectsDir), next);
  return next;
}

module.exports = { CARD_ID, readPultState, setArchived };
