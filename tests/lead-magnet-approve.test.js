const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { approveLeadMagnet } = require('../scripts/lead-magnet/approve');
const { addLeadMagnetComment } = require('../scripts/lead-magnet/comments');
const library = require('../scripts/lead-magnet/library');
const { hashFile } = require('../scripts/pult/files');
const { makeLeadMagnet, writeRevision } = require('./helpers/lead-magnet-fixtures');

// Отчёт проверки пишем вручную: здесь проверяется логика утверждения, а не Chromium.
function publish(projectsDir, id, { ok = true } = {}) {
  const { n, dir } = library.startRevision(projectsDir, id);
  writeRevision(dir);
  const pageSha256 = hashFile(path.join(dir, 'page.html'));
  fs.writeFileSync(path.join(dir, 'qa', 'check.json'), JSON.stringify({ version: 1, checkedAt: 'x', pageSha256, ok, items: [] }));
  library.publishRevision(projectsDir, id, n);
  return { n, dir, pageSha256 };
}

function codeOf(fn) {
  try { fn(); } catch (error) { return error.code; }
  return null;
}

test('approval marks the viewed revision approved', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const { n, pageSha256 } = publish(projectsDir, id);
  const passport = approveLeadMagnet(projectsDir, id, { revision: n, expectedPageSha256: pageSha256, confirmViewed: true, now: () => new Date('2026-09-30T15:00:00.000Z') });
  assert.equal(passport.approved, 1);
  assert.equal(passport.revisions[0].status, 'approved');
  assert.equal(passport.revisions[0].approvedAt, '2026-09-30T15:00:00.000Z');
});

test('guards: confirmation, current revision, unchanged page, green check, no pending comments', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const { n, dir, pageSha256 } = publish(projectsDir, id);
  const approve = (overrides = {}) => approveLeadMagnet(projectsDir, id, { revision: n, expectedPageSha256: pageSha256, confirmViewed: true, ...overrides });
  assert.equal(codeOf(() => approve({ confirmViewed: false })), 'CONFIRMATION_REQUIRED');
  assert.equal(codeOf(() => approve({ revision: 2 })), 'REVISION_CHANGED');
  assert.equal(codeOf(() => approve({ expectedPageSha256: 'f'.repeat(64) })), 'PAGE_CHANGED');
  addLeadMagnetComment(projectsDir, id, { revision: n, target: { kind: 'text', text: 'dm' }, text: 'короче' });
  assert.equal(codeOf(() => approve()), 'PENDING_COMMENTS');
  fs.appendFileSync(path.join(dir, 'page.html'), '<!-- changed -->');
  assert.equal(codeOf(() => approve()), 'PAGE_CHANGED');
});

test('a red check blocks approval', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const { n, pageSha256 } = publish(projectsDir, id, { ok: false });
  assert.equal(codeOf(() => approveLeadMagnet(projectsDir, id, { revision: n, expectedPageSha256: pageSha256, confirmViewed: true })), 'CHECK_FAILED');
});
