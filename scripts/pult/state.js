const path = require('node:path');

const { readJsonIfExists, writeJsonAtomic } = require('./files');

const CARD_ID = /^(folder|group):[\p{L}\p{N}._ -]{1,120}$/u;

function statePath(projectsDir) {
  return path.join(projectsDir, '.pult', 'state.json');
}

function readPultState(projectsDir) {
  const value = readJsonIfExists(statePath(projectsDir), '.pult/state.json');
  if (value === undefined) return { version: 1, archived: [] };
  if (!value || value.version !== 1 || !Array.isArray(value.archived)) {
    throw new Error('.pult/state.json: неверный формат');
  }
  return {
    version: 1,
    archived: value.archived.filter((id) => typeof id === 'string' && CARD_ID.test(id)),
  };
}

// Архив — только пометка «не показывать» в projects/.pult. Папки роликов не меняются.
function setArchived(projectsDir, cardId, archived) {
  if (typeof cardId !== 'string' || !CARD_ID.test(cardId)) throw new Error('неверный id карточки');
  const state = readPultState(projectsDir);
  if (archived && state.archived.includes(cardId)) return state;
  const next = { version: 1, archived: state.archived.filter((id) => id !== cardId) };
  if (archived) next.archived.push(cardId);
  writeJsonAtomic(statePath(projectsDir), next);
  return next;
}

module.exports = { CARD_ID, readPultState, setArchived };
