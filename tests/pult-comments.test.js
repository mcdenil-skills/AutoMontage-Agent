const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  acceptComment,
  addComment,
  countNewComments,
  deleteComment,
  readComments,
} = require('../scripts/pult/comments');
const { addLegacyFolder, makePultRoot } = require('./helpers/pult-projects');

const VIDEO = { kind: 'preview', path: 'previews/v01-draft-full.mp4', sha256: 'b'.repeat(64) };

function project(t) {
  const { projectsDir } = makePultRoot(t);
  return addLegacyFolder(projectsDir, 'clip', { files: { 'previews/v01-draft-full.mp4': 'video' } });
}

test('comments are stored with time, text and video identity', (t) => {
  const dir = project(t);
  const frames = [];
  const comment = addComment(dir, { timeSec: 14.24, text: '  Текст залезает на лицо  ', video: VIDEO }, {
    now: () => new Date('2026-09-24T12:00:00.000Z'),
    id: () => 'c-0001',
    captureFrame: (videoPath, timeSec, outPath) => {
      frames.push({ videoPath, timeSec, outPath });
      fs.writeFileSync(outPath, 'jpg');
      return true;
    },
  });
  assert.deepEqual(comment, {
    id: 'c-0001',
    createdAt: '2026-09-24T12:00:00.000Z',
    timeSec: 14.24,
    text: 'Текст залезает на лицо',
    video: VIDEO,
    frame: 'pult/frames/c-0001.jpg',
    status: 'new',
  });
  assert.equal(frames[0].videoPath, path.join(dir, 'previews', 'v01-draft-full.mp4'));
  assert.equal(frames[0].timeSec, 14.24);
  assert.deepEqual(readComments(dir), [comment]);
  assert.equal(countNewComments(dir), 1);
  assert.equal(countNewComments(dir, 'previews/v01-draft-full.mp4'), 1);
  assert.equal(countNewComments(dir, 'final/other.mp4'), 0);
});

test('frame capture failure keeps the comment without a frame', (t) => {
  const dir = project(t);
  const comment = addComment(dir, { timeSec: 1, text: 'Тише музыку', video: VIDEO }, { captureFrame: () => false });
  assert.equal(comment.frame, null);
  assert.match(comment.id, /^c-[a-f0-9]{8}$/);
});

test('invalid comments are rejected without writing anything', (t) => {
  const dir = project(t);
  const inputs = [
    { timeSec: -1, text: 'x', video: VIDEO },
    { timeSec: Number.NaN, text: 'x', video: VIDEO },
    { timeSec: 1, text: '   ', video: VIDEO },
    { timeSec: 1, text: 'x'.repeat(1001), video: VIDEO },
    { timeSec: 1, text: 'x', video: { ...VIDEO, path: '../escape.mp4' } },
    { timeSec: 1, text: 'x', video: { ...VIDEO, kind: 'other' } },
  ];
  for (const input of inputs) {
    assert.throws(() => addComment(dir, input, { captureFrame: () => false }), /правк/);
  }
  assert.deepEqual(readComments(dir), []);
});

test('only new comments can be deleted; accepted ones stay as history', (t) => {
  const dir = project(t);
  const options = { captureFrame: () => false };
  const first = addComment(dir, { timeSec: 1, text: 'Первая', video: VIDEO }, options);
  const second = addComment(dir, { timeSec: 2, text: 'Вторая', video: VIDEO }, options);
  assert.equal(deleteComment(dir, first.id), true);
  assert.equal(acceptComment(dir, second.id).status, 'accepted');
  assert.throws(() => deleteComment(dir, second.id), /принят/);
  assert.equal(deleteComment(dir, 'c-ffffffff'), false);
  assert.throws(() => acceptComment(dir, 'c-ffffffff'), /не найдена/);
  assert.equal(countNewComments(dir), 0);
  assert.deepEqual(readComments(dir).map((comment) => comment.id), [second.id]);
});

test('a corrupted comments file is reported, not silently replaced', (t) => {
  const dir = project(t);
  fs.mkdirSync(path.join(dir, 'pult'));
  fs.writeFileSync(path.join(dir, 'pult', 'comments.json'), '{ broken');
  assert.throws(() => readComments(dir), /comments\.json/);
  assert.throws(
    () => addComment(dir, { timeSec: 1, text: 'x', video: VIDEO }, { captureFrame: () => false }),
    /comments\.json/,
  );
  assert.equal(fs.readFileSync(path.join(dir, 'pult', 'comments.json'), 'utf8'), '{ broken');
});
