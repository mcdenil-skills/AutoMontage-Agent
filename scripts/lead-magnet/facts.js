// scripts/lead-magnet/facts.js
const path = require('node:path');
const Ajv = require('ajv');

const schema = require('../../schema/lead-magnet-facts.schema.json');
const { readJsonIfExists } = require('../pult/files');

const validateFacts = new Ajv({ allErrors: true }).compile(schema);

// Стоп-кран: любой статус, кроме verified, блокирует утверждение.
function readFacts(revisionPath, bytes) {
  let value;
  try { value = bytes === undefined ? readJsonIfExists(path.join(revisionPath, 'facts.json'), 'facts.json')
    : bytes === null ? undefined : JSON.parse(bytes.toString('utf8')); }
  catch (_) { return { ok: false, valid: false, message: 'facts.json: некорректный JSON', items: [] }; }
  if (value === undefined) return { ok: false, message: 'нет отчёта проверки фактов facts.json', items: [] };
  if (!validateFacts(value)) return { ok: false, message: 'facts.json не соответствует схеме', items: [] };
  const bad = value.items.filter((item) => item.status !== 'verified');
  return {
    valid: true,
    ok: bad.length === 0,
    message: bad.length ? `не подтверждено: ${bad.map((item) => item.claim).join('; ')}` : `проверено утверждений: ${value.items.length}`,
    items: value.items,
  };
}

module.exports = { readFacts };
