const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const library = require('../scripts/lead-magnet/library');
const { revisionReadiness } = require('../scripts/lead-magnet/readiness');
const { makeLeadMagnet, publishCheckedRevision } = require('./helpers/lead-magnet-fixtures');

test('a fresh green report of the shown page is ready', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const { n, pageSha256 } = publishCheckedRevision(projectsDir, id);
  const readiness = revisionReadiness(projectsDir, library.readLeadMagnet(projectsDir, id), n);
  assert.equal(readiness.ok, true);
  assert.equal(readiness.pageSha256, pageSha256);
  assert.equal(readiness.items.length, 10);
});

test('changed texts after the check, a red report and a missing page are not ready', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const { n, dir } = publishCheckedRevision(projectsDir, id);
  fs.writeFileSync(path.join(dir, 'texts', 'dm.txt'), 'Текст поменяли после проверки');
  assert.equal(revisionReadiness(projectsDir, library.readLeadMagnet(projectsDir, id), n).ok, false);

  const red = makeLeadMagnet(t);
  const redRevision = publishCheckedRevision(red.projectsDir, red.id, { ok: false });
  const redReadiness = revisionReadiness(red.projectsDir, library.readLeadMagnet(red.projectsDir, red.id), redRevision.n);
  assert.equal(redReadiness.ok, false);
  assert.equal(redReadiness.items.every((item) => item.ok === false), true);

  fs.rmSync(path.join(redRevision.dir, 'page.html'));
  const missing = revisionReadiness(red.projectsDir, library.readLeadMagnet(red.projectsDir, red.id), redRevision.n);
  assert.deepEqual([missing.ok, missing.pageSha256], [false, null]);
});
