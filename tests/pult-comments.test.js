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

// project(t) always returns <base>/projects/clip, so two levels up is the tmp root
// that makePultRoot(t) will clean up — a safe place to plant "outside the project" fixtures.
function outsideBase(dir) {
  return path.dirname(path.dirname(dir));
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

// C1: a tampered frame field must never let deleteComment remove an arbitrary file.
// With the I1 read-validation fix, a comment whose frame does not equal
// "pult/frames/<id>.jpg" makes the whole comments.json unreadable, so deleteComment
// fails closed (throws) before it ever computes a path to remove.
test('deleteComment never touches files outside the frame cache, even with a tampered record', (t) => {
  const dir = project(t);
  const outside = path.join(outsideBase(dir), 'outside.txt');
  fs.writeFileSync(outside, 'victim');
  const previewPath = path.join(dir, 'previews', 'v01-draft-full.mp4');

  for (const frame of ['../../outside.txt', 'previews/v01-draft-full.mp4']) {
    fs.mkdirSync(path.join(dir, 'pult'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pult', 'comments.json'), JSON.stringify({
      version: 1,
      comments: [{
        id: 'c-deadbeef',
        createdAt: '2026-09-24T12:00:00.000Z',
        timeSec: 1,
        text: 'x',
        video: VIDEO,
        frame,
        status: 'new',
      }],
    }));
    assert.throws(() => deleteComment(dir, 'c-deadbeef'), /comments\.json/);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'victim');
    assert.equal(fs.readFileSync(previewPath, 'utf8'), 'video');
  }
});

// C1: even when the recorded frame path is well-formed, deleteComment must resolve it
// through the engine's symlink-aware guard rather than a raw path.join — a symlinked
// pult/frames must not let deletion reach outside the project.
test('deleteComment does not follow a symlinked frame cache to delete outside files', { skip: process.platform === 'win32' }, (t) => {
  const dir = project(t);
  const options = {
    id: () => 'c-cafebabe',
    captureFrame: (videoPath, timeSec, outPath) => { fs.writeFileSync(outPath, 'jpg'); return true; },
  };
  const comment = addComment(dir, { timeSec: 1, text: 'x', video: VIDEO }, options);
  assert.equal(comment.frame, 'pult/frames/c-cafebabe.jpg');

  fs.rmSync(path.join(dir, 'pult', 'frames'), { recursive: true, force: true });
  const outsideFrames = path.join(outsideBase(dir), 'outside-frames');
  fs.mkdirSync(outsideFrames, { recursive: true });
  const victim = path.join(outsideFrames, 'c-cafebabe.jpg');
  fs.writeFileSync(victim, 'victim');
  fs.symlinkSync(outsideFrames, path.join(dir, 'pult', 'frames'), 'dir');

  assert.equal(deleteComment(dir, comment.id), true);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'victim');
  assert.deepEqual(readComments(dir), []);
});

// C1 positive case: deleting a comment with a real, legitimately captured frame must
// still remove that frame from the cache.
test('deleteComment removes a real frame file from the cache', (t) => {
  const dir = project(t);
  const options = { captureFrame: (videoPath, timeSec, outPath) => { fs.writeFileSync(outPath, 'jpg'); return true; } };
  const comment = addComment(dir, { timeSec: 1, text: 'x', video: VIDEO }, options);
  const framePath = path.join(dir, 'pult', 'frames', `${comment.id}.jpg`);
  assert.equal(fs.existsSync(framePath), true);
  assert.equal(deleteComment(dir, comment.id), true);
  assert.equal(fs.existsSync(framePath), false);
});

// I1: readComments must validate every entry (type, id shape, status, timeSec range,
// video shape, frame identity) and reject duplicate ids, without ever rewriting the file.
test('readComments rejects tampered or duplicate entries without touching the file', (t) => {
  const dir = project(t);
  fs.mkdirSync(path.join(dir, 'pult'), { recursive: true });
  const commentsFile = path.join(dir, 'pult', 'comments.json');

  const validEntry = (overrides = {}) => ({
    id: 'c-deadbeef',
    createdAt: '2026-09-24T12:00:00.000Z',
    timeSec: 1,
    text: 'x',
    video: VIDEO,
    frame: null,
    status: 'new',
    ...overrides,
  });

  const payloads = [
    { version: 1, comments: [validEntry({ frame: 'project.json' })] },
    { version: 1, comments: [null] },
    { version: 1, comments: [validEntry({ id: 'c-aaaaaaaa' }), validEntry({ id: 'c-aaaaaaaa' })] },
  ];

  for (const payload of payloads) {
    const raw = `${JSON.stringify(payload, null, 2)}\n`;
    fs.writeFileSync(commentsFile, raw);
    assert.throws(() => readComments(dir), /comments\.json/);
    assert.equal(fs.readFileSync(commentsFile, 'utf8'), raw);
  }
});

// I1 positive: an accepted comment carries an extra acceptedAt field, which read
// validation must keep allowing.
test('readComments accepts the extra acceptedAt field written by acceptComment', (t) => {
  const dir = project(t);
  const comment = addComment(dir, { timeSec: 1, text: 'x', video: VIDEO }, { captureFrame: () => false });
  acceptComment(dir, comment.id);
  const stored = readComments(dir);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, 'accepted');
  assert.equal(typeof stored[0].acceptedAt, 'string');
});

// I2: a symlinked pult folder must be rejected before any frame capture runs, not
// silently followed by a recursive mkdir into whatever it points at.
test('addComment refuses a symlinked pult folder before capturing a frame', { skip: process.platform === 'win32' }, (t) => {
  const dir = project(t);
  const outside = path.join(outsideBase(dir), 'outside-pult');
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(dir, 'pult'), 'dir');

  let called = false;
  const options = {
    captureFrame: (videoPath, timeSec, outPath) => { called = true; fs.writeFileSync(outPath, 'jpg'); return true; },
  };
  assert.throws(
    () => addComment(dir, { timeSec: 1, text: 'x', video: VIDEO }, options),
    /небезопасная/,
  );
  assert.equal(called, false);
  assert.deepEqual(fs.readdirSync(outside), []);
});

// I3: frame capture can take seconds; addComment must re-read comments.json right
// before writing so a concurrent acceptComment (e.g. from an "inbox --accept" run by
// the agent process) during that window is not silently overwritten.
test('addComment re-reads before writing so a concurrent accept during capture is not lost', (t) => {
  const dir = project(t);
  const a = addComment(dir, { timeSec: 1, text: 'A', video: VIDEO }, {
    id: () => 'c-aaaaaaaa',
    captureFrame: () => false,
  });
  const b = addComment(dir, { timeSec: 2, text: 'B', video: VIDEO }, {
    id: () => 'c-bbbbbbbb',
    captureFrame: () => { acceptComment(dir, a.id); return false; },
  });
  const stored = readComments(dir);
  assert.equal(stored.find((comment) => comment.id === a.id).status, 'accepted');
  assert.ok(stored.find((comment) => comment.id === b.id));
});

// Minor: a symlinked comments.json must be rejected, not silently read through.
test('a symlinked comments.json is rejected, not silently followed', { skip: process.platform === 'win32' }, (t) => {
  const dir = project(t);
  const outside = path.join(outsideBase(dir), 'outside-comments.json');
  fs.writeFileSync(outside, JSON.stringify({ version: 1, comments: [] }));
  fs.mkdirSync(path.join(dir, 'pult'), { recursive: true });
  fs.symlinkSync(outside, path.join(dir, 'pult', 'comments.json'));
  assert.throws(() => readComments(dir), /comments\.json/);
});
