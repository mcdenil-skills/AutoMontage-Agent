const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { approveLeadMagnet } = require('../scripts/lead-magnet/approve');
const { addLeadMagnetComment } = require('../scripts/lead-magnet/comments');
const library = require('../scripts/lead-magnet/library');
const { hashFile } = require('../scripts/pult/files');
const { makeLeadMagnet, writeRevision } = require('./helpers/lead-magnet-fixtures');

const CHECK_IDS = ['promise', 'cta', 'phone-width', 'copy-buttons', 'logo', 'header', 'self-contained', 'blocks', 'texts', 'facts'];

// Отчёт проверки пишем вручную: здесь проверяется логика утверждения, а не Chromium.
function publish(projectsDir, id, { ok = true, facts = [] } = {}) {
  const { n, dir } = library.startRevision(projectsDir, id);
  writeRevision(dir, { facts });
  const pageSha256 = hashFile(path.join(dir, 'page.html'));
  const factsSha256 = hashFile(path.join(dir, 'facts.json'));
  fs.writeFileSync(path.join(dir, 'qa', 'check.json'), JSON.stringify({
    version: 1, checkedAt: '2026-09-30T12:00:00.000Z', pageSha256, factsSha256, inputSha256: require('../scripts/lead-magnet/check').inputFingerprint(projectsDir, dir, library.readLeadMagnet(projectsDir, id)), ok,
    items: CHECK_IDS.map((itemId) => ({ id: itemId, ok, message: 'проверено' })),
  }));
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

test('incomplete, duplicate, contradictory and failed check items block approval', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const { n, dir, pageSha256 } = publish(projectsDir, id);
  const reportPath = path.join(dir, 'qa', 'check.json');
  const original = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const approve = () => approveLeadMagnet(projectsDir, id, { revision: n, expectedPageSha256: pageSha256, confirmViewed: true });
  for (const mutate of [
    (report) => { report.items = []; },
    (report) => { report.items.pop(); },
    (report) => { report.items[1] = { ...report.items[0] }; },
    (report) => { report.items[0].ok = false; },
    (report) => { report.ok = false; },
    (report) => { delete report.factsSha256; },
    (report) => { report.factsSha256 = 'f'.repeat(64); },
    (report) => { report.items[0].id = 'unexpected'; },
  ]) {
    const report = structuredClone(original);
    mutate(report);
    fs.writeFileSync(reportPath, JSON.stringify(report));
    assert.equal(codeOf(approve), 'CHECK_FAILED', JSON.stringify(report));
  }
  fs.writeFileSync(reportPath, '{broken');
  assert.equal(codeOf(approve), 'CHECK_FAILED', 'malformed JSON must not approve');
});

test('missing, unverified and changed facts block approval; fresh verified facts pass', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const { n, dir, pageSha256 } = publish(projectsDir, id, { facts: [
    { claim: 'Проверенное утверждение', source: 'Локальный источник', status: 'verified' },
  ] });
  const factsPath = path.join(dir, 'facts.json');
  const original = fs.readFileSync(factsPath);
  const approve = () => approveLeadMagnet(projectsDir, id, { revision: n, expectedPageSha256: pageSha256, confirmViewed: true });
  fs.rmSync(factsPath);
  assert.equal(codeOf(approve), 'CHECK_FAILED');
  fs.writeFileSync(factsPath, JSON.stringify({ version: 1, checkedAt: 'x', items: [{ claim: 'Заявление', source: 'Источник', status: 'failed' }] }));
  const reportPath = path.join(dir, 'qa', 'check.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  report.factsSha256 = hashFile(factsPath);
  fs.writeFileSync(reportPath, JSON.stringify(report));
  assert.equal(codeOf(approve), 'CHECK_FAILED');
  fs.writeFileSync(factsPath, original);
  report.factsSha256 = hashFile(factsPath);
  fs.writeFileSync(reportPath, JSON.stringify(report));
  fs.writeFileSync(factsPath, JSON.stringify({ version: 1, checkedAt: 'x', items: [{ claim: 'Заявление', source: 'Источник', status: 'verified' }] }));
  assert.equal(codeOf(approve), 'CHECK_FAILED', 'verified replacement still invalidates the checked evidence');
  fs.writeFileSync(factsPath, original);
  assert.equal(approve().approved, n);
});

test('approval rejects changed or deleted texts and changed promise, units, or selection', (t) => {
  for (const change of ['text', 'deleted', 'promise', 'units', 'selection']) {
    const { projectsDir, id } = makeLeadMagnet(t);
    const { n, dir, pageSha256 } = publish(projectsDir, id);
    if (change === 'text') fs.writeFileSync(path.join(dir, 'texts/dm.txt'), 'x'.repeat(2001));
    else if (change === 'deleted') fs.unlinkSync(path.join(dir, 'texts/dm.txt'));
    else {
      const p = library.readLeadMagnet(projectsDir, id);
      if (change === 'promise') p.promise.quote = 'другое обещание';
      if (change === 'units') p.units[1].count = 7;
      if (change === 'selection') p.params.texts = ['dm'];
      library.savePassport(projectsDir, p, () => new Date());
    }
    assert.equal(codeOf(() => approveLeadMagnet(projectsDir, id, { revision: n, expectedPageSha256: pageSha256, confirmViewed: true })), 'CHECK_FAILED', change);
  }
});

test('approval rejects symlinked QA, page, facts and selected text paths', (t) => {
  for (const relative of ['qa', 'page.html', 'facts.json', 'texts']) {
    const { base, projectsDir, id } = makeLeadMagnet(t);
    const { n, dir, pageSha256 } = publish(projectsDir, id);
    const outside = path.join(base, 'outside-approval');
    fs.renameSync(path.join(dir, relative), outside);
    fs.symlinkSync(outside, path.join(dir, relative));
    assert.throws(() => approveLeadMagnet(projectsDir, id, { revision: n, expectedPageSha256: pageSha256, confirmViewed: true }));
    assert.equal(library.readLeadMagnet(projectsDir, id).approved, null);
  }
});
