const { createHash } = require('node:crypto');
const Ajv = require('ajv');

const checkSchema = require('../../schema/lead-magnet-check.schema.json');
const { inputFingerprint, readChecked } = require('./check');
const { readFacts } = require('./facts');
const { revisionDir } = require('./library');

const validateCheck = new Ajv({ allErrors: true }).compile(checkSchema);
const REQUIRED_CHECKS = new Set(['promise', 'cta', 'phone-width', 'copy-buttons', 'logo', 'header',
  'self-contained', 'blocks', 'texts', 'facts']);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Единое правило «ревизию можно утверждать»: им пользуются и approveLeadMagnet, и пульт.
// Две копии правила рано или поздно разошлись бы – кнопка «Утверждаю» горела бы там,
// где движок откажет.
function revisionReadiness(projectsDir, passport, n) {
  const dir = revisionDir(projectsDir, passport.id, n);
  const pageBytes = readChecked(projectsDir, dir, 'page.html');
  if (pageBytes === null) return { ok: false, pageSha256: null, items: [] };
  const pageSha256 = digest(pageBytes);
  let report = null;
  let facts;
  let factsSha256;
  try {
    report = JSON.parse(readChecked(projectsDir, dir, 'qa/check.json'));
    const factsBytes = readChecked(projectsDir, dir, 'facts.json');
    facts = readFacts(dir, factsBytes);
    if (facts.ok) factsSha256 = digest(factsBytes);
    if (report.inputSha256 !== inputFingerprint(projectsDir, dir, passport)) throw new Error('stale inputs');
  } catch (_) {
    return { ok: false, pageSha256, items: report && Array.isArray(report.items) ? report.items : [] };
  }
  const items = Array.isArray(report.items) ? report.items : [];
  const ok = validateCheck(report) && report.ok === true && report.pageSha256 === pageSha256
    && facts.ok && report.factsSha256 === factsSha256
    && items.length === REQUIRED_CHECKS.size
    && items.every((item) => item.ok === true && REQUIRED_CHECKS.has(item.id))
    && new Set(items.map((item) => item.id)).size === REQUIRED_CHECKS.size;
  return { ok, pageSha256, items };
}

module.exports = { REQUIRED_CHECKS, revisionReadiness };
