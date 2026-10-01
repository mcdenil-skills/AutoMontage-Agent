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
const { PARAMS, QUOTE, UNITS, makeLeadMagnet, makeVideoProject, writeRevision } = require('./helpers/lead-magnet-fixtures');
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
  addDecision(projectDir, { type: 'link', offerId: 'o-gayd', codeWord: 'ГАЙД', leadMagnetId: id });
  addDecision(projectDir, { type: 'promise-keep', offerId: 'o-gayd', leadMagnetId: id });
  const create = addDecision(projectDir, { type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: { ...PARAMS, wishes: 'добавь \u001b[31mошибки' } });
  addLeadMagnetComment(projectsDir, id, { revision: 1, target: { kind: 'block', blockId: 'step-2', view: 'phone', rect: { x: 0, y: 0, w: 1, h: 1 } }, text: 'короче' });
  const inbox = buildLeadMagnetInbox({ projectsDir });
  assert.deepEqual(inbox.decisions.map((item) => [item.folder, item.decision.id]), [[folder, create.id]]);
  assert.deepEqual(readDecisions(projectDir).slice(1, 3).map((decision) => decision.status), ['accepted', 'accepted']);
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

test('inbox rejects a video pult symlink before reading decisions and keeps a regular file visible', (t) => {
  const { base, projectsDir, projectDir, folder } = setup(t);
  const decision = addDecision(projectDir, { type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: PARAMS });
  assert.deepEqual(buildLeadMagnetInbox({ projectsDir }).decisions.map((item) => item.decision.id), [decision.id]);
  const outside = path.join(base, 'outside-pult');
  fs.renameSync(path.join(projectDir, 'pult'), outside);
  fs.symlinkSync(outside, path.join(projectDir, 'pult'));
  const inbox = buildLeadMagnetInbox({ projectsDir });
  assert.equal(inbox.decisions.length, 0);
  assert.match(inbox.broken[0].where, new RegExp(`${folder}/pult/lead-magnet.json`));
  assert.match(inbox.broken[0].error, /symbolic link/);
});

test('inbox reports a dangling decision-file symlink and ignores a truly absent file', (t) => {
  const { base, projectsDir, projectDir } = setup(t);
  assert.equal(buildLeadMagnetInbox({ projectsDir }).broken.length, 0);
  const file = path.join(projectDir, 'pult', 'lead-magnet.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.symlinkSync(path.join(base, 'missing.json'), file);
  const inbox = buildLeadMagnetInbox({ projectsDir });
  assert.equal(inbox.broken.length, 1);
  assert.match(inbox.broken[0].error, /symbolic link/);
});

test('inbox reports pult as a regular file and ignores a truly absent pult directory', (t) => {
  const { projectsDir, projectDir } = makeVideoProject(t);
  assert.deepEqual(buildLeadMagnetInbox({ projectsDir }).broken, []);
  fs.writeFileSync(path.join(projectDir, 'pult'), 'not a directory');
  const inbox = buildLeadMagnetInbox({ projectsDir });
  assert.equal(inbox.broken.length, 1);
  assert.match(inbox.broken[0].where, /pult\/lead-magnet\.json$/);
  assert.match(inbox.broken[0].error, /ENOTDIR/);
});

test('inbox reports a project scan error instead of claiming no work', (t) => {
  const { projectsDir } = setup(t);
  const original = fs.readdirSync;
  fs.readdirSync = function readdirSync(candidate, ...args) {
    if (candidate === projectsDir) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return original.call(this, candidate, ...args);
  };
  t.after(() => { fs.readdirSync = original; });
  const inbox = buildLeadMagnetInbox({ projectsDir });
  assert.equal(inbox.decisions.length, 0);
  assert.match(inbox.broken.map((item) => item.error).join(' '), /permission denied/);
});

test('inbox renders user Markdown as text while keeping ordinary wording', () => {
  const params = {
    ...PARAMS,
    audience: '**новички** [ссылка](https://example.com)',
    wishes: 'добавь `код` <img src=x>',
    design: { ...PARAMS.design, references: [{ kind: 'url', url: 'https://example.com/a`b' }] },
  };
  const inbox = {
    broken: [{ where: 'video`name/pult/lead-magnet.json', error: '<bad> **file**' }],
    decisions: [{ folder: 'video`name', decision: { id: 'r-12345678', type: 'create', codeWord: 'ГАЙД', params } }],
    comments: [{ id: '2026.09.30_gayd', comment: { id: 'c-12345678', revision: 1, target: { kind: 'block', blockId: 'step`2', view: 'phone' }, text: '**сократи** [x](https://example.com)' } }],
  };
  const text = formatLeadMagnetInbox(inbox, { projectsDir: '/tmp/projects' });
  assert.match(text, /формат: гайд по шагам/);
  assert.match(text, /на слово «ГАЙД»/);
  assert.doesNotMatch(text, /(?<!\\)\*\*новички\*\*|(?<!\\)\*\*сократи\*\*|(?<!\\)<img|(?<!\\)<bad>|(?<!\\)\[ссылка\]\(/);
  assert.match(text, /\\\*\\\*новички\\\*\\\*/);
  assert.match(text, /`` video`name\/pult\/lead-magnet\.json ``/);
});

test('inbox describes every closing call mode', (t) => {
  const { projectsDir, projectDir } = setup(t);
  for (const mode of ['brand', 'none', 'link']) {
    addDecision(projectDir, { type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: { ...PARAMS,
      cta: { mode, title: 'Дальше', label: 'Практикум', url: 'https://example.com/p' },
    } });
  }
  const text = formatLeadMagnetInbox(buildLeadMagnetInbox({ projectsDir }), { projectsDir });
  assert.match(text, /призыв: по бренд-паку/);
  assert.match(text, /призыв: без призыва/);
  assert.match(text, /призыв: «Практикум» → `https:\/\/example.com\/p`/);
});
