// tests/lead-magnet-inbox.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { addLeadMagnetComment } = require('../scripts/lead-magnet/comments');
const { buildLeadMagnetInbox, formatLeadMagnetInbox } = require('../scripts/lead-magnet/inbox');
const library = require('../scripts/lead-magnet/library');
const { addOffer } = require('../scripts/lead-magnet/offers');
const { addDecision, readDecisions } = require('../scripts/lead-magnet/requests');
const { main } = require('../scripts/pult/inbox');
const { PARAMS, QUOTE, UNITS, makeLeadMagnet, writeRevision } = require('./helpers/lead-magnet-fixtures');
const { hashFile } = require('../scripts/pult/files');

function setup(t) {
  const context = makeLeadMagnet(t);
  addOffer(context.projectDir, { codeWord: 'ГАЙД', kind: 'comment-keyword', quote: QUOTE, units: UNITS });
  const revision = library.startRevision(context.projectsDir, context.id);
  writeRevision(revision.dir);
  const pageSha256 = hashFile(path.join(revision.dir, 'page.html'));
  fs.writeFileSync(path.join(revision.dir, 'qa', 'check.json'), JSON.stringify({ version: 1, checkedAt: '2026-09-30T12:00:00.000Z', pageSha256, ok: true, items: [] }));
  library.publishRevision(context.projectsDir, context.id, revision.n);
  return context;
}

test('agent work appears in the inbox, automatic decisions do not', (t) => {
  const { projectsDir, projectDir, folder, id } = setup(t);
  addDecision(projectDir, { type: 'decline', offerId: 'o-gayd', codeWord: 'ГАЙД' });
  const create = addDecision(projectDir, { type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: { ...PARAMS, wishes: 'добавь \u001b[31mошибки' } });
  addLeadMagnetComment(projectsDir, id, { revision: 1, target: { kind: 'block', blockId: 'step-2', view: 'phone', rect: { x: 0, y: 0, w: 1, h: 1 } }, text: 'короче' });
  const inbox = buildLeadMagnetInbox({ projectsDir });
  assert.deepEqual(inbox.decisions.map((item) => [item.folder, item.decision.id]), [[folder, create.id]]);
  assert.equal(inbox.comments.length, 1);
  const text = formatLeadMagnetInbox(inbox, { projectsDir, cwd: path.dirname(projectsDir) });
  assert.match(text, /Лид-магнит: запрос `r-[a-f0-9]{8}` на слово «ГАЙД»/);
  assert.match(text, /формат: гайд по шагам/);
  assert.match(text, /к блоку «step-2» \(телефон\): «короче»/);
  assert.doesNotMatch(text, /\u001b/);
});

test('inbox --accept-lead accepts a decision by folder and a comment by lead magnet id', (t) => {
  const { projectsDir, projectDir, folder, id } = setup(t);
  const create = addDecision(projectDir, { type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: PARAMS });
  const comment = addLeadMagnetComment(projectsDir, id, { revision: 1, target: { kind: 'text', text: 'dm' }, text: 'x' });
  const lines = [];
  assert.equal(main(['--projects-dir', projectsDir, '--accept-lead', folder, create.id], { write: (line) => lines.push(line) }), 0);
  assert.equal(readDecisions(projectDir)[0].status, 'accepted');
  assert.equal(main(['--projects-dir', projectsDir, '--accept-lead', id, comment.id], { write: (line) => lines.push(line) }), 0);
  assert.equal(main(['--projects-dir', projectsDir, '--accept-lead', '../x', create.id], { write: (line) => lines.push(line) }), 1);
  assert.equal(buildLeadMagnetInbox({ projectsDir }).comments.length, 0);
});

test('a broken lead-magnet.json of a video is reported, not skipped', (t) => {
  const { projectsDir, projectDir } = setup(t);
  fs.mkdirSync(path.join(projectDir, 'pult'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'pult', 'lead-magnet.json'), '{');
  const inbox = buildLeadMagnetInbox({ projectsDir });
  assert.equal(inbox.broken.length, 1);
  assert.match(formatLeadMagnetInbox(inbox, { projectsDir }), /повреждён/);
});
