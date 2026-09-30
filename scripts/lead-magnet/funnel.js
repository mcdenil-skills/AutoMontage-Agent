const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');

const schema = require('../../schema/lead-magnet-funnel.schema.json');
const { captureProjectDirectoryGuard, resolveProjectPath, stageOwnedSiblingFile } = require('../project/workspace');
const { readJsonIfExists } = require('../pult/files');
const { LIBRARY_DIR, normalizeCodeWord } = require('./constants');
const { leadMagnetDir, readLeadMagnet } = require('./library');

const validateFunnel = new Ajv({ allErrors: true }).compile(schema);
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

function funnelPath(projectsDir, id) {
  leadMagnetDir(projectsDir, id);
  return resolveProjectPath(projectsDir, path.join(LIBRARY_DIR, id, 'funnel.json'),
    { label: 'funnel.json', type: 'file' });
}

// Этап 1 – только чтение: агент проверяет воронку через MCP поставщика и записывает, что увидел.
// Движок сам в сервис не ходит и ключей не читает.
function setFunnelState(projectsDir, id, input, { now = () => new Date() } = {}) {
  const passport = readLeadMagnet(projectsDir, id);
  const state = {
    version: 1,
    provider: input.provider,
    codeWord: normalizeCodeWord(input.codeWord),
    exists: input.exists,
    automationName: input.automationName ?? null,
    checkedAt: now().toISOString(),
  };
  if (!passport.codeWords.includes(state.codeWord) || !validateFunnel(state)
    || (state.automationName && CONTROL_CHARS.test(state.automationName))) {
    throw new Error('состояние воронки: неверные данные');
  }
  const destination = funnelPath(projectsDir, id);
  const guard = captureProjectDirectoryGuard(projectsDir, destination, fs, 'funnel.json');
  const stage = stageOwnedSiblingFile(destination, `${JSON.stringify(state, null, 2)}\n`, {
    purpose: 'funnel', assertParentCurrent: guard.assertCurrent, verifyPublishedIdentity: true,
  });
  try {
    stage.commitReplace();
  } finally {
    stage.cleanupTemp();
  }
  return state;
}

function readFunnelState(projectsDir, id) {
  const source = funnelPath(projectsDir, id);
  const guard = captureProjectDirectoryGuard(projectsDir, source, fs, 'funnel.json');
  const value = readJsonIfExists(source, 'funnel.json');
  guard.assertCurrent();
  if (value === undefined) return null;
  if (!validateFunnel(value) || (value.automationName && CONTROL_CHARS.test(value.automationName))) {
    throw new Error('funnel.json: неверный формат');
  }
  return value;
}

module.exports = { readFunnelState, setFunnelState };
