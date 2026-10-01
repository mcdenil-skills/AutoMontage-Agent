const Ajv = require('ajv');

const checkSchema = require('../../schema/lead-magnet-check.schema.json');
const { createHash } = require('node:crypto');
const { readChecked, inputFingerprint } = require('./check');
const { countNewLeadMagnetComments } = require('./comments');
const { readFacts } = require('./facts');
const { readLeadMagnet, revisionDir, savePassport } = require('./library');

const validateCheck = new Ajv({ allErrors: true }).compile(checkSchema);
const REQUIRED_CHECKS = new Set(['promise', 'cta', 'phone-width', 'copy-buttons', 'logo', 'header',
  'self-contained', 'blocks', 'texts', 'facts']);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Утверждение – решение человека. Эту функцию вызывает только сервер пульта после галочки
// «Я просмотрел страницу и тексты»; у CLI агента команды утверждения нет (tests/lead-magnet-cli.test.js).
function approveLeadMagnet(projectsDir, id, { revision, expectedPageSha256, confirmViewed, now = () => new Date() }) {
  if (confirmViewed !== true) throw fail('CONFIRMATION_REQUIRED', 'Отметьте, что посмотрели страницу и тексты');
  const passport = readLeadMagnet(projectsDir, id);
  const current = passport.revisions.find((item) => item.n === passport.current);
  if (!current || current.n !== revision || current.status !== 'draft') {
    throw fail('REVISION_CHANGED', 'Агент выпустил новую версию – посмотрите её перед утверждением');
  }
  const dir = revisionDir(projectsDir, id, revision);
  const actual = createHash('sha256').update(readChecked(projectsDir, dir, 'page.html')).digest('hex');
  if (actual !== expectedPageSha256 || actual !== current.pageSha256) {
    throw fail('PAGE_CHANGED', 'Страница изменилась – откройте её заново');
  }
  let report;
  let factsSha256;
  let facts;
  try {
    report = JSON.parse(readChecked(projectsDir, dir, 'qa/check.json'));
    const bytes = readChecked(projectsDir, dir, 'facts.json');
    facts = readFacts(dir, bytes);
    if (facts.ok) factsSha256 = createHash('sha256').update(bytes).digest('hex');
    if (report.inputSha256 !== inputFingerprint(projectsDir, dir, passport)) throw new Error('Stale inputs');
  } catch (_) {
    throw fail('CHECK_FAILED', 'Проверка каркаса или фактов не пройдена – агент исправит');
  }
  const checks = report && Array.isArray(report.items) ? report.items : [];
  if (!validateCheck(report) || report.ok !== true || report.pageSha256 !== actual
    || !facts.ok || report.factsSha256 !== factsSha256
    || checks.length !== REQUIRED_CHECKS.size
    || checks.some((item) => item.ok !== true || !REQUIRED_CHECKS.has(item.id))
    || new Set(checks.map((item) => item.id)).size !== REQUIRED_CHECKS.size) {
    throw fail('CHECK_FAILED', 'Проверка каркаса или фактов не пройдена – агент исправит');
  }
  if (countNewLeadMagnetComments(projectsDir, id, revision) > 0) {
    throw fail('PENDING_COMMENTS', 'Есть правки, которые ждут агента');
  }
  const approvedAt = now().toISOString();
  return savePassport(projectsDir, {
    ...passport,
    approved: revision,
    revisions: passport.revisions.map((item) => (item.n === revision ? { ...item, status: 'approved', approvedAt } : item)),
  }, now);
}

module.exports = { approveLeadMagnet };
