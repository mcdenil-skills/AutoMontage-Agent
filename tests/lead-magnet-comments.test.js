// tests/lead-magnet-comments.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const comments = require('../scripts/lead-magnet/comments');
const library = require('../scripts/lead-magnet/library');
const { QUOTE, UNITS, makeVideoProject } = require('./helpers/lead-magnet-fixtures');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('shot')]);
const NOW = () => new Date('2026-09-30T13:00:00.000Z');
const BLOCK = { kind: 'block', blockId: 'step-2', view: 'phone', rect: { x: 10, y: 400, w: 370, h: 180 } };

function setup(t) {
  const { projectsDir, folder } = makeVideoProject(t);
  const { id } = library.createLeadMagnet(projectsDir, {
    codeWord: 'ГАЙД', title: 'Сайт', promise: { quote: QUOTE, startSec: 60, endSec: 63.9, sourceFolder: folder }, units: UNITS,
    params: { format: 'guide', audience: '', design: { mode: 'brand', take: { composition: true, colors: false, fonts: false }, likeId: null, note: '', references: [] }, texts: ['dm'], wishes: '', promiseConfirmed: true },
    videoFolder: folder,
  });
  return { projectsDir, id };
}

test('block comment keeps revision, block, view, rect and a PNG snapshot', (t) => {
  const { projectsDir, id } = setup(t);
  const comment = comments.addLeadMagnetComment(projectsDir, id, { revision: 1, target: BLOCK, text: '  короче  ', snapshotBytes: PNG }, { now: NOW, id: () => 'c-0000000a' });
  assert.equal(comment.text, 'короче');
  assert.equal(comment.snapshot, 'pult/frames/c-0000000a.png');
  assert.deepEqual(fs.readFileSync(path.join(library.leadMagnetDir(projectsDir, id), 'pult', 'frames', 'c-0000000a.png')), PNG);
  assert.deepEqual(comments.readLeadMagnetComments(projectsDir, id), [comment]);
});

test('text comment has no snapshot; a non-PNG snapshot is dropped', (t) => {
  const { projectsDir, id } = setup(t);
  const onText = comments.addLeadMagnetComment(projectsDir, id, { revision: 1, target: { kind: 'text', text: 'dm' }, text: 'убери смайлы' }, { now: NOW });
  assert.equal(onText.snapshot, null);
  const fake = comments.addLeadMagnetComment(projectsDir, id, { revision: 1, target: BLOCK, text: 'x', snapshotBytes: Buffer.from('<svg/>') }, { now: NOW });
  assert.equal(fake.snapshot, null);
});

test('only new comments can be deleted; accept keeps history', (t) => {
  const { projectsDir, id } = setup(t);
  const first = comments.addLeadMagnetComment(projectsDir, id, { revision: 1, target: BLOCK, text: 'a', snapshotBytes: PNG }, { now: NOW, id: () => 'c-00000001' });
  const second = comments.addLeadMagnetComment(projectsDir, id, { revision: 1, target: BLOCK, text: 'b' }, { now: NOW, id: () => 'c-00000002' });
  comments.acceptLeadMagnetComment(projectsDir, id, second.id, { now: NOW });
  assert.throws(() => comments.deleteLeadMagnetComment(projectsDir, id, second.id), /принят/);
  comments.deleteLeadMagnetComment(projectsDir, id, first.id);
  assert.equal(fs.existsSync(path.join(library.leadMagnetDir(projectsDir, id), 'pult', 'frames', 'c-00000001.png')), false);
  assert.deepEqual(comments.readLeadMagnetComments(projectsDir, id).map((item) => item.id), ['c-00000002']);
  assert.equal(comments.countNewLeadMagnetComments(projectsDir, id), 0);
});

test('invalid input is rejected without writing', (t) => {
  const { projectsDir, id } = setup(t);
  for (const input of [
    { revision: 0, target: BLOCK, text: 'x' },
    { revision: 1, target: { ...BLOCK, blockId: '../x' }, text: 'x' },
    { revision: 1, target: BLOCK, text: '   ' },
    { revision: 1, target: BLOCK, text: 'x'.repeat(1001) },
  ]) {
    assert.throws(() => comments.addLeadMagnetComment(projectsDir, id, input), /правк/);
  }
  assert.deepEqual(comments.readLeadMagnetComments(projectsDir, id), []);
});

test('snapshot write rejects a symlinked frames directory and keeps the outside folder untouched', (t) => {
  const { projectsDir, id } = setup(t);
  const outside = path.join(path.dirname(projectsDir), 'outside-frames');
  const pult = path.join(library.leadMagnetDir(projectsDir, id), 'pult');
  fs.mkdirSync(outside);
  fs.mkdirSync(pult);
  fs.symlinkSync(outside, path.join(pult, 'frames'));
  assert.throws(() => comments.addLeadMagnetComment(projectsDir, id,
    { revision: 1, target: BLOCK, text: 'x', snapshotBytes: PNG },
    { now: NOW, id: () => 'c-00000003' }), /symbolic link/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.deepEqual(comments.readLeadMagnetComments(projectsDir, id), []);
});

test('stored snapshot traversal is rejected; a valid snapshot can still be deleted', (t) => {
  const { projectsDir, id } = setup(t);
  const comment = comments.addLeadMagnetComment(projectsDir, id,
    { revision: 1, target: BLOCK, text: 'x', snapshotBytes: PNG },
    { now: NOW, id: () => 'c-00000004' });
  const file = path.join(library.leadMagnetDir(projectsDir, id), 'pult', 'comments.json');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.comments[0].snapshot = '../outside.png';
  fs.writeFileSync(file, JSON.stringify(record));
  assert.throws(() => comments.deleteLeadMagnetComment(projectsDir, id, comment.id), /неверный формат/);
  record.comments[0].snapshot = comment.snapshot;
  fs.writeFileSync(file, JSON.stringify(record));
  comments.deleteLeadMagnetComment(projectsDir, id, comment.id);
  assert.deepEqual(comments.readLeadMagnetComments(projectsDir, id), []);
});

test('deleting a comment rejects a symlinked snapshot without losing the comment', (t) => {
  const { projectsDir, id } = setup(t);
  const comment = comments.addLeadMagnetComment(projectsDir, id,
    { revision: 1, target: BLOCK, text: 'x', snapshotBytes: PNG },
    { now: NOW, id: () => 'c-00000005' });
  const snapshot = path.join(library.leadMagnetDir(projectsDir, id), 'pult', 'frames', `${comment.id}.png`);
  const outside = path.join(path.dirname(projectsDir), 'outside.png');
  fs.writeFileSync(outside, PNG);
  fs.unlinkSync(snapshot);
  fs.symlinkSync(outside, snapshot);
  assert.throws(() => comments.deleteLeadMagnetComment(projectsDir, id, comment.id), /symbolic link/);
  assert.deepEqual(fs.readFileSync(outside), PNG);
  assert.equal(comments.readLeadMagnetComments(projectsDir, id).length, 1);
});
