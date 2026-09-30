const path = require('node:path');

const { hashFile, readJsonIfExists } = require('../pult/files');
const { countNewLeadMagnetComments } = require('./comments');
const { readLeadMagnet, revisionDir, savePassport } = require('./library');

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
  const actual = hashFile(path.join(dir, 'page.html'));
  if (actual !== expectedPageSha256 || actual !== current.pageSha256) {
    throw fail('PAGE_CHANGED', 'Страница изменилась – откройте её заново');
  }
  const report = readJsonIfExists(path.join(dir, 'qa', 'check.json'), 'qa/check.json');
  if (!report || report.ok !== true || report.pageSha256 !== actual) {
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
