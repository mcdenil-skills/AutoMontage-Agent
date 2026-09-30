const path = require('node:path');
const Ajv = require('ajv');

const schema = require('../../schema/lead-magnet-funnel.schema.json');
const { readJsonIfExists, writeJsonAtomic } = require('../pult/files');
const { normalizeCodeWord } = require('./constants');
const { leadMagnetDir, readLeadMagnet } = require('./library');

const validateFunnel = new Ajv({ allErrors: true }).compile(schema);
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

function funnelPath(projectsDir, id) {
  return path.join(leadMagnetDir(projectsDir, id), 'funnel.json');
}

// Этап 1 – только чтение: агент проверяет воронку через MCP поставщика и записывает, что увидел.
// Движок сам в сервис не ходит и ключей не читает.
function setFunnelState(projectsDir, id, input, { now = () => new Date() } = {}) {
  readLeadMagnet(projectsDir, id);
  const state = {
    version: 1,
    provider: input.provider,
    codeWord: normalizeCodeWord(input.codeWord),
    exists: input.exists,
    automationName: input.automationName ?? null,
    checkedAt: now().toISOString(),
  };
  if (!validateFunnel(state) || (state.automationName && CONTROL_CHARS.test(state.automationName))) {
    throw new Error('состояние воронки: неверные данные');
  }
  writeJsonAtomic(funnelPath(projectsDir, id), state);
  return state;
}

function readFunnelState(projectsDir, id) {
  const value = readJsonIfExists(funnelPath(projectsDir, id), 'funnel.json');
  if (value === undefined) return null;
  if (!validateFunnel(value)) throw new Error('funnel.json: неверный формат');
  return value;
}

module.exports = { readFunnelState, setFunnelState };
