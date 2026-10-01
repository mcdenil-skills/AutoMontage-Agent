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

function setup(t, { publish = true } = {}) {
  const { projectsDir, folder } = makeVideoProject(t);
  const { id } = library.createLeadMagnet(projectsDir, {
    codeWord: 'ГАЙД', title: 'Сайт', promise: { quote: QUOTE, startSec: 60, endSec: 63.9, sourceFolder: folder }, units: UNITS,
    params: { format: 'guide', audience: '', design: { mode: 'brand', take: { composition: true, colors: false, fonts: false }, likeId: null, note: '', references: [] }, texts: ['dm'], wishes: '', promiseConfirmed: true },
    videoFolder: folder,
  });
  if (publish) publishDraft(projectsDir, id);
  return { projectsDir, id };
}

function publishDraft(projectsDir, id, { started = false } = {}) {
  const dir = started ? library.revisionDir(projectsDir, id, 1)
    : library.startRevision(projectsDir, id, { now: NOW }).dir;
  fs.writeFileSync(path.join(dir, 'page.html'), '<!doctype html><html><body>ok</body></html>');
  fs.writeFileSync(path.join(dir, 'page.pdf'), '%PDF-1.7');
  fs.writeFileSync(path.join(dir, 'content.md'), '# ok');
  fs.writeFileSync(path.join(dir, 'facts.json'), JSON.stringify({ version: 1, checkedAt: 'x', items: [] }));
  fs.writeFileSync(path.join(dir, 'texts', 'dm.txt'), 'Привет');
  const pageSha256 = require('../scripts/pult/files').hashFile(path.join(dir, 'page.html'));
  fs.writeFileSync(path.join(dir, 'qa', 'check.json'), JSON.stringify({ version: 1, checkedAt: 'x', pageSha256, ok: true, items: [] }));
  library.publishRevision(projectsDir, id, 1, { now: NOW });
}

function swapAtWrite(t, destination, ancestor, outside) {
  const originalOpen = fs.openSync;
  const originalWrite = fs.writeFileSync;
  let swapped = false;
  const swap = (candidate) => {
    if (swapped || typeof candidate !== 'string' || !candidate.startsWith(destination)) return;
    if (candidate === destination && destination.endsWith('.json')) return;
    fs.renameSync(ancestor, outside);
    fs.symlinkSync(outside, ancestor);
    swapped = true;
  };
  fs.openSync = (candidate, ...args) => { swap(candidate); return originalOpen(candidate, ...args); };
  fs.writeFileSync = (candidate, ...args) => { swap(candidate); return originalWrite(candidate, ...args); };
  t.after(() => { fs.openSync = originalOpen; fs.writeFileSync = originalWrite; });
  return () => swapped;
}

test('comments require a published revision; a draft is reviewable', (t) => {
  const { projectsDir, id } = setup(t, { publish: false });
  const input = { revision: 1, target: BLOCK, text: 'поправь' };
  assert.throws(() => comments.addLeadMagnetComment(projectsDir, id, input), /ревизи/);
  library.startRevision(projectsDir, id, { now: NOW });
  assert.throws(() => comments.addLeadMagnetComment(projectsDir, id, input), /ревизи/);
  assert.throws(() => comments.addLeadMagnetComment(projectsDir, id, { ...input, revision: 2 }), /ревизи/);
  assert.deepEqual(comments.readLeadMagnetComments(projectsDir, id), []);
  publishDraft(projectsDir, id, { started: true });
  assert.equal(comments.addLeadMagnetComment(projectsDir, id, input).revision, 1);
});

test('block comment keeps revision, block, view, rect and a PNG snapshot', (t) => {
  const { projectsDir, id } = setup(t);
  const comment = comments.addLeadMagnetComment(projectsDir, id, { revision: 1, target: BLOCK, text: '  короче  ', snapshotBytes: PNG }, { now: NOW, id: () => 'c-0000000a' });
  assert.equal(comment.text, 'короче');
  assert.equal(comment.snapshot, 'pult/frames/c-0000000a.png');
  assert.deepEqual(fs.readFileSync(path.join(library.leadMagnetDir(projectsDir, id), 'pult', 'frames', 'c-0000000a.png')), PNG);
  assert.deepEqual(fs.readdirSync(path.join(library.leadMagnetDir(projectsDir, id), 'pult', 'frames')), ['c-0000000a.png']);
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

test('snapshot bytes cannot escape when frames is swapped at the write boundary', (t) => {
  const { projectsDir, id } = setup(t);
  const magnet = library.leadMagnetDir(projectsDir, id);
  const frames = path.join(magnet, 'pult', 'frames');
  fs.mkdirSync(path.dirname(frames));
  fs.mkdirSync(frames);
  const outside = path.join(path.dirname(projectsDir), 'moved-frames');
  const swapped = swapAtWrite(t, path.join(frames, 'c-00000006.png'), frames, outside);
  assert.throws(() => comments.addLeadMagnetComment(projectsDir, id,
    { revision: 1, target: BLOCK, text: 'x', snapshotBytes: PNG },
    { now: NOW, id: () => 'c-00000006' }), /identity changed|symbolic link/);
  assert.equal(swapped(), true);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('JSON bytes cannot escape when pult is swapped at the write boundary', (t) => {
  const { projectsDir, id } = setup(t);
  const magnet = library.leadMagnetDir(projectsDir, id);
  const pult = path.join(magnet, 'pult');
  fs.mkdirSync(pult);
  const outside = path.join(path.dirname(projectsDir), 'moved-pult');
  const swapped = swapAtWrite(t, path.join(pult, 'comments.json'), pult, outside);
  assert.throws(() => comments.addLeadMagnetComment(projectsDir, id,
    { revision: 1, target: { kind: 'text', text: 'dm' }, text: 'x' },
    { now: NOW, id: () => 'c-00000007' }), /identity changed|symbolic link/);
  assert.equal(swapped(), true);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('failed JSON persistence removes its owned PNG; foreign replacement survives', (t) => {
  const { projectsDir, id } = setup(t);
  const magnet = library.leadMagnetDir(projectsDir, id);
  const snapshot = path.join(magnet, 'pult', 'frames', 'c-00000008.png');
  const originalRename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (destination === path.join(magnet, 'pult', 'comments.json')) {
      assert.deepEqual(fs.readFileSync(snapshot), PNG);
      throw new Error('injected JSON persistence failure');
    }
    return originalRename(source, destination);
  };
  t.after(() => { fs.renameSync = originalRename; });
  assert.throws(() => comments.addLeadMagnetComment(projectsDir, id,
    { revision: 1, target: BLOCK, text: 'x', snapshotBytes: PNG },
    { now: NOW, id: () => 'c-00000008' }), /injected JSON persistence failure/);
  assert.equal(fs.existsSync(snapshot), false);
  assert.deepEqual(comments.readLeadMagnetComments(projectsDir, id), []);

  fs.renameSync = (source, destination) => {
    if (destination === path.join(magnet, 'pult', 'comments.json')) {
      fs.unlinkSync(snapshot);
      fs.writeFileSync(snapshot, 'foreign');
      throw new Error('injected JSON persistence failure');
    }
    return originalRename(source, destination);
  };
  assert.throws(() => comments.addLeadMagnetComment(projectsDir, id,
    { revision: 1, target: BLOCK, text: 'x', snapshotBytes: PNG },
    { now: NOW, id: () => 'c-00000008' }), /injected JSON persistence failure/);
  assert.equal(fs.readFileSync(snapshot, 'utf8'), 'foreign');
  assert.deepEqual(comments.readLeadMagnetComments(projectsDir, id), []);
});

test('snapshot identity stays pinned until JSON persistence finishes', (t) => {
  const { projectsDir, id } = setup(t);
  const magnet = library.leadMagnetDir(projectsDir, id);
  const frames = path.join(magnet, 'pult', 'frames');
  const snapshot = path.join(frames, 'c-00000009.png');
  const originalRename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (destination === path.join(magnet, 'pult', 'comments.json')) {
      // A live second link prevents Linux from recycling the snapshot inode
      // after a concurrent unlink and replacement at the same path.
      assert.equal(fs.statSync(snapshot).nlink, 2);
      fs.unlinkSync(snapshot);
      fs.writeFileSync(snapshot, 'foreign');
      throw new Error('injected JSON persistence failure');
    }
    return originalRename(source, destination);
  };
  t.after(() => { fs.renameSync = originalRename; });
  assert.throws(() => comments.addLeadMagnetComment(projectsDir, id,
    { revision: 1, target: BLOCK, text: 'x', snapshotBytes: PNG },
    { now: NOW, id: () => 'c-00000009' }), /injected JSON persistence failure/);
  assert.equal(fs.readFileSync(snapshot, 'utf8'), 'foreign');
  assert.deepEqual(fs.readdirSync(frames), ['c-00000009.png']);
  assert.deepEqual(comments.readLeadMagnetComments(projectsDir, id), []);
});

test('failed snapshot rollback still clears its temporary link', (t) => {
  const { projectsDir, id } = setup(t);
  const magnet = library.leadMagnetDir(projectsDir, id);
  const frames = path.join(magnet, 'pult', 'frames');
  const snapshot = path.join(frames, 'c-0000000b.png');
  const originalRename = fs.renameSync;
  const originalUnlink = fs.unlinkSync;
  fs.renameSync = (source, destination) => {
    if (destination === path.join(magnet, 'pult', 'comments.json')) {
      throw new Error('injected JSON persistence failure');
    }
    return originalRename(source, destination);
  };
  fs.unlinkSync = (candidate) => {
    if (candidate === snapshot) throw new Error('injected snapshot rollback failure');
    return originalUnlink(candidate);
  };
  t.after(() => { fs.renameSync = originalRename; fs.unlinkSync = originalUnlink; });
  assert.throws(() => comments.addLeadMagnetComment(projectsDir, id,
    { revision: 1, target: BLOCK, text: 'x', snapshotBytes: PNG },
    { now: NOW, id: () => 'c-0000000b' }), /injected JSON persistence failure/);
  assert.deepEqual(fs.readdirSync(frames), ['c-0000000b.png']);
  assert.deepEqual(comments.readLeadMagnetComments(projectsDir, id), []);
});

test('snapshot cleanup never follows a swapped frames directory', (t) => {
  const { projectsDir, id } = setup(t);
  const magnet = library.leadMagnetDir(projectsDir, id);
  const frames = path.join(magnet, 'pult', 'frames');
  const moved = path.join(path.dirname(projectsDir), 'moved-comment-frames');
  const outside = path.join(path.dirname(projectsDir), 'outside-comment-frames');
  const originalRename = fs.renameSync;
  let foreignLink;
  fs.renameSync = (source, destination) => {
    if (destination === path.join(magnet, 'pult', 'comments.json')) {
      const temporary = fs.readdirSync(frames).find((name) => name.includes('.tmp-snapshot-'));
      assert.ok(temporary);
      originalRename(frames, moved);
      fs.mkdirSync(outside);
      foreignLink = path.join(outside, temporary);
      fs.linkSync(path.join(moved, temporary), foreignLink);
      fs.symlinkSync(outside, frames);
    }
    return originalRename(source, destination);
  };
  t.after(() => { fs.renameSync = originalRename; });
  assert.throws(() => comments.addLeadMagnetComment(projectsDir, id,
    { revision: 1, target: BLOCK, text: 'x', snapshotBytes: PNG },
    { now: NOW, id: () => 'c-0000000c' }), /directory identity changed/);
  const stored = comments.readLeadMagnetComments(projectsDir, id);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, 'c-0000000c');
  assert.throws(() => comments.deleteLeadMagnetComment(projectsDir, id, stored[0].id), /symbolic link/);
  assert.deepEqual(fs.readFileSync(foreignLink), PNG);
});
