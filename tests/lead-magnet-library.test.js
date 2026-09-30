// tests/lead-magnet-library.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const library = require('../scripts/lead-magnet/library');
const { deriveLeadMagnetStatus } = require('../scripts/lead-magnet/status');
const { QUOTE, UNITS, makeVideoProject } = require('./helpers/lead-magnet-fixtures');

const NOW = () => new Date('2026-09-30T12:00:00.000Z');
const PARAMS = {
  format: 'guide', audience: 'новички',
  design: { mode: 'brand', take: { composition: true, colors: false, fonts: false }, likeId: null, note: '', references: [] },
  texts: ['dm'], wishes: '', promiseConfirmed: true,
};

function create(projectsDir, folder, codeWord = 'ГАЙД') {
  return library.createLeadMagnet(projectsDir, {
    codeWord, title: 'Сайт без кода', promise: { quote: QUOTE, startSec: 60, endSec: 63.9, sourceFolder: folder },
    units: UNITS, params: PARAMS, videoFolder: folder,
  }, { now: NOW });
}

function writeRevisionFiles(dir, { withCheck = true } = {}) {
  fs.writeFileSync(path.join(dir, 'page.html'), '<!doctype html><html><body>ok</body></html>');
  fs.writeFileSync(path.join(dir, 'page.pdf'), '%PDF-1.7');
  fs.writeFileSync(path.join(dir, 'content.md'), '# ok');
  fs.writeFileSync(path.join(dir, 'texts', 'dm.txt'), 'Привет');
  fs.writeFileSync(path.join(dir, 'facts.json'), JSON.stringify({ version: 1, checkedAt: 'x', items: [] }));
  if (withCheck) {
    const pageSha256 = require('../scripts/pult/files').hashFile(path.join(dir, 'page.html'));
    fs.writeFileSync(path.join(dir, 'qa', 'check.json'), JSON.stringify({ version: 1, checkedAt: 'x', pageSha256, ok: true, items: [] }));
  }
}

test('lead magnet gets a dated id, a passport and a link to its video', (t) => {
  const { projectsDir, folder } = makeVideoProject(t);
  const passport = create(projectsDir, folder);
  assert.equal(passport.id, '2026.09.30_gayd');
  assert.deepEqual(passport.codeWords, ['ГАЙД']);
  assert.deepEqual(passport.videos, [folder]);
  assert.equal(passport.request, null);
  assert.equal(passport.current, null);
  assert.deepEqual(library.readLeadMagnet(projectsDir, passport.id), passport);
  const second = create(projectsDir, 'second-video');
  assert.equal(second.id, '2026.09.30_gayd-2');
  assert.deepEqual(second.videos, ['second-video']);
  assert.deepEqual(library.readLeadMagnet(projectsDir, passport.id).videos, [folder]);
});

test('a passport preserves the request that created it', (t) => {
  const { projectsDir, folder } = makeVideoProject(t);
  const passport = library.createLeadMagnet(projectsDir, {
    codeWord: 'ГАЙД', title: 'Сайт без кода',
    promise: { quote: QUOTE, startSec: 60, endSec: 63.9, sourceFolder: folder },
    units: UNITS, params: PARAMS, videoFolder: folder,
    request: { folder, decisionId: 'r-1234abcd' },
  }, { now: NOW });
  assert.deepEqual(library.readLeadMagnet(projectsDir, passport.id).request,
    { folder, decisionId: 'r-1234abcd' });
});

test('a request cannot name a different video folder or create a library entry', (t) => {
  const { projectsDir, folder } = makeVideoProject(t);
  assert.throws(() => library.createLeadMagnet(projectsDir, {
    codeWord: 'ГАЙД', title: 'Сайт без кода',
    promise: { quote: QUOTE, startSec: 60, endSec: 63.9, sourceFolder: folder },
    units: UNITS, params: PARAMS, videoFolder: folder,
    request: { folder: 'другой-ролик', decisionId: 'r-1234abcd' },
  }, { now: NOW }), /неверный запрос/);
  assert.equal(fs.existsSync(path.join(projectsDir, '.lead-magnets')), false);
});

test('a passport created before request tracking remains readable', (t) => {
  const { projectsDir, folder } = makeVideoProject(t);
  const passport = create(projectsDir, folder);
  const file = path.join(projectsDir, '.lead-magnets', passport.id, 'lead-magnet.json');
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete legacy.request;
  fs.writeFileSync(file, JSON.stringify(legacy));
  assert.equal(library.readLeadMagnet(projectsDir, passport.id).request, null);
});

test('creating three magnets with the same word gives each an independent passport', (t) => {
  const { projectsDir, folder } = makeVideoProject(t);
  const magnets = [create(projectsDir, folder), create(projectsDir, 'second-video'), create(projectsDir, 'third-video')];
  assert.deepEqual(magnets.map((item) => item.id), [
    '2026.09.30_gayd', '2026.09.30_gayd-2', '2026.09.30_gayd-3',
  ]);
  assert.deepEqual(magnets.map((item) => item.videos), [[folder], ['second-video'], ['third-video']]);
  assert.deepEqual(new Set(library.findByCodeWord(projectsDir, 'гайд').map((item) => item.id)),
    new Set(magnets.map((item) => item.id)));
});

test('a repeated long word gets a suffix within the safe ID length', (t) => {
  const { projectsDir, folder } = makeVideoProject(t);
  const word = 'Ю'.repeat(40);
  const first = create(projectsDir, folder, word);
  const second = create(projectsDir, 'second-video', word);
  assert.match(first.id, /^2026\.09\.30_[a-z0-9-]{1,80}$/);
  assert.match(second.id, /^2026\.09\.30_[a-z0-9-]{1,80}$/);
  assert.notEqual(first.id, second.id);
  assert.ok(second.id.endsWith('-2'));
});

test('a maximum-length transliterated word creates three valid distinct IDs', (t) => {
  const { projectsDir, folder } = makeVideoProject(t);
  const word = 'Щ'.repeat(40);
  const magnets = [create(projectsDir, folder, word), create(projectsDir, 'second-video', word),
    create(projectsDir, 'third-video', word)];
  for (const magnet of magnets) {
    assert.match(magnet.id, /^2026\.09\.30_[a-z0-9-]{1,80}$/);
    assert.deepEqual(library.readLeadMagnet(projectsDir, magnet.id), magnet);
  }
  assert.equal(new Set(magnets.map((magnet) => magnet.id)).size, 3);
  assert.ok(magnets[1].id.endsWith('-2'));
  assert.ok(magnets[2].id.endsWith('-3'));
});

test('find by code word puts an approved magnet before new magnets sharing the word', (t) => {
  const { projectsDir, folder } = makeVideoProject(t);
  const first = create(projectsDir, folder);
  const approved = create(projectsDir, 'approved-video');
  const third = create(projectsDir, 'third-video');
  library.savePassport(projectsDir, {
    ...approved, approved: 1,
    revisions: [{ n: 1, dir: 'v01', status: 'approved', pageSha256: 'a'.repeat(64), createdAt: NOW().toISOString() }],
  }, NOW);
  const matches = library.findByCodeWord(projectsDir, 'гайд');
  assert.deepEqual(matches.map((item) => item.id), [approved.id, third.id, first.id]);
});

test('find by code word and link another video', (t) => {
  const { projectsDir, folder } = makeVideoProject(t);
  const { id } = create(projectsDir, folder);
  const other = create(projectsDir, folder, 'ПРОМПТЫ');
  assert.deepEqual(library.findByCodeWord(projectsDir, 'гайд').map((item) => item.id), [id]);
  const linked = library.linkVideo(projectsDir, id, { folder: 'другой-ролик', codeWord: 'ГАЙД 2' }, { now: NOW });
  assert.deepEqual(linked.videos, [folder, 'другой-ролик']);
  assert.deepEqual(linked.codeWords, ['ГАЙД', 'ГАЙД 2']);
  assert.throws(() => library.linkVideo(projectsDir, id, { folder: '../x', codeWord: 'ГАЙД' }), /папк/);
  const shared = library.linkVideo(projectsDir, other.id, { folder: 'another', codeWord: 'гайд' }, { now: NOW });
  assert.deepEqual(shared.codeWords, ['ПРОМПТЫ', 'ГАЙД']);
  assert.deepEqual(shared.videos, [folder, 'another']);
  assert.deepEqual(new Set(library.findByCodeWord(projectsDir, 'ГАЙД').map((item) => item.id)), new Set([id, other.id]));
});

test('revision numbers must be integers from 1 through 99', (t) => {
  const { projectsDir, folder } = makeVideoProject(t);
  const { id } = create(projectsDir, folder);
  assert.equal(path.basename(library.revisionDir(projectsDir, id, 1)), 'v01');
  assert.equal(path.basename(library.revisionDir(projectsDir, id, 99)), 'v99');
  for (const n of ['/../../../../outside', 0, 100, 1.5, NaN]) {
    assert.throws(() => library.revisionDir(projectsDir, id, n), /ревизи/);
  }
});

test('library, passport and revision symlinks cannot redirect reads or writes', (t) => {
  const { base, projectsDir, folder } = makeVideoProject(t);
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  const root = path.join(projectsDir, '.lead-magnets');
  fs.symlinkSync(outside, root);
  assert.throws(() => create(projectsDir, folder), /symbolic link|небезопасн/);
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(root);

  const { id } = create(projectsDir, folder);
  const magnet = path.join(root, id);
  const movedMagnet = path.join(outside, id);
  fs.renameSync(magnet, movedMagnet);
  fs.symlinkSync(movedMagnet, magnet);
  assert.throws(() => library.readLeadMagnet(projectsDir, id), /symbolic link|небезопасн/);
  assert.throws(() => library.startRevision(projectsDir, id, { now: NOW }), /symbolic link|небезопасн/);
  assert.equal(fs.existsSync(path.join(movedMagnet, 'v01')), false);
  fs.unlinkSync(magnet);
  fs.renameSync(movedMagnet, magnet);

  const { dir } = library.startRevision(projectsDir, id, { now: NOW });
  const movedRevision = path.join(outside, 'v01');
  fs.renameSync(dir, movedRevision);
  fs.symlinkSync(movedRevision, dir);
  assert.throws(() => library.publishRevision(projectsDir, id, 1, { now: NOW }), /symbolic link|небезопасн/);
  assert.equal(library.readLeadMagnet(projectsDir, id).revisions[0].status, 'building');
});

test('artifact parent symlink is rejected while a normal neighboring revision publishes', (t) => {
  const { base, projectsDir, folder } = makeVideoProject(t);
  const { id } = create(projectsDir, folder);
  const { dir } = library.startRevision(projectsDir, id, { now: NOW });
  writeRevisionFiles(dir);
  const outsideTexts = path.join(base, 'outside-texts');
  fs.renameSync(path.join(dir, 'texts'), outsideTexts);
  fs.symlinkSync(outsideTexts, path.join(dir, 'texts'));
  assert.throws(() => library.publishRevision(projectsDir, id, 1, { now: NOW }), /symbolic link|небезопасн/);
  fs.unlinkSync(path.join(dir, 'texts'));
  fs.renameSync(outsideTexts, path.join(dir, 'texts'));
  assert.equal(library.publishRevision(projectsDir, id, 1, { now: NOW }).revisions[0].status, 'draft');
});

test('revision goes building → draft only with all files and a matching check report', (t) => {
  const { projectsDir, folder } = makeVideoProject(t);
  const { id } = create(projectsDir, folder);
  const { n, dir } = library.startRevision(projectsDir, id, { now: NOW });
  assert.equal(n, 1);
  assert.equal(path.basename(dir), 'v01');
  assert.throws(() => library.publishRevision(projectsDir, id, 1, { now: NOW }), /не хватает файла/);
  writeRevisionFiles(dir, { withCheck: false });
  assert.throws(() => library.publishRevision(projectsDir, id, 1, { now: NOW }), /проверку/);
  writeRevisionFiles(dir);
  const passport = library.publishRevision(projectsDir, id, 1, { now: NOW });
  assert.equal(passport.current, 1);
  assert.equal(passport.revisions[0].status, 'draft');
  assert.match(passport.revisions[0].pageSha256, /^[a-f0-9]{64}$/);
  assert.equal(library.startRevision(projectsDir, id, { now: NOW }).n, 2);
});

test('broken passports are listed separately and a promise can be acknowledged or updated', (t) => {
  const { projectsDir, folder } = makeVideoProject(t);
  const { id } = create(projectsDir, folder);
  fs.mkdirSync(path.join(projectsDir, '.lead-magnets', '2026.09.01_bad'));
  fs.writeFileSync(path.join(projectsDir, '.lead-magnets', '2026.09.01_bad', 'lead-magnet.json'), '{');
  const list = library.listLeadMagnets(projectsDir);
  assert.deepEqual(list.entries.map((item) => item.id), [id]);
  assert.equal(list.broken[0].id, '2026.09.01_bad');
  const acknowledged = library.acknowledgePromise(projectsDir, id, 'Новая цитата из ролика', { now: NOW });
  assert.deepEqual(acknowledged.promise.acknowledged, ['новая цитата из ролика']);
  const updated = library.updatePromise(projectsDir, id, { quote: 'и я пришлю семь промптов', startSec: 61, endSec: 63, sourceFolder: folder }, { now: NOW });
  assert.equal(updated.promise.quote, 'и я пришлю семь промптов');
  assert.deepEqual(updated.promise.acknowledged, []);
});

test('acknowledging a disappeared promise clears the card warning without accepting a different quote', (t) => {
  const { projectsDir, folder } = makeVideoProject(t);
  const { id } = create(projectsDir, folder);
  const { dir } = library.startRevision(projectsDir, id, { now: NOW });
  writeRevisionFiles(dir);
  library.publishRevision(projectsDir, id, 1, { now: NOW });

  const draft = library.readLeadMagnet(projectsDir, id);
  const input = { passport: draft, newComments: 0, checkOk: true, currentQuote: null };
  assert.equal(deriveLeadMagnetStatus(input).promiseChanged, true);

  const acknowledged = library.acknowledgePromise(projectsDir, id, null, { now: NOW });
  assert.deepEqual(acknowledged.promise.acknowledged, ['']);
  assert.deepEqual(deriveLeadMagnetStatus({ ...input, passport: acknowledged }), {
    status: 'waiting', nextStep: 'Лид-магнит: посмотрите и утвердите', approvable: true,
  });
  assert.equal(deriveLeadMagnetStatus({ ...input, passport: acknowledged, currentQuote: 'и я пришлю семь промптов' }).promiseChanged, true);
});
