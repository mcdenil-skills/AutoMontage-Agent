const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { extractFrame, probeMedia, thumbnailFor } = require('../scripts/pult/media-cache');
const { makePultRoot } = require('./helpers/pult-projects');

const PROBE = JSON.stringify({
  streams: [{ codec_type: 'video', width: 1080, height: 1920, r_frame_rate: '25/1', duration: '27.48' }],
  format: { duration: '27.48' },
});

test('probe results are cached by file identity', (t) => {
  const { projectsDir } = makePultRoot(t);
  const video = path.join(projectsDir, 'clip.mp4');
  fs.writeFileSync(video, 'video');
  let calls = 0;
  const captureImpl = (command) => {
    calls += 1;
    assert.equal(command, 'ffprobe');
    return { stdout: PROBE };
  };
  const expected = { width: 1080, height: 1920, durationSec: 27.48 };
  assert.deepEqual(probeMedia(projectsDir, video, { captureImpl }), expected);
  assert.deepEqual(probeMedia(projectsDir, video, { captureImpl }), expected);
  assert.equal(calls, 1);
  fs.writeFileSync(video, 'changed video bytes');
  probeMedia(projectsDir, video, { captureImpl });
  assert.equal(calls, 2);
});

test('probe failure returns null instead of breaking the list', (t) => {
  const { projectsDir } = makePultRoot(t);
  const video = path.join(projectsDir, 'clip.mp4');
  fs.writeFileSync(video, 'video');
  assert.equal(probeMedia(projectsDir, video, { captureImpl: () => { throw new Error('no ffprobe'); } }), null);
});

test('thumbnail is rendered once into the pult cache', (t) => {
  const { projectsDir } = makePultRoot(t);
  const video = path.join(projectsDir, 'clip.mp4');
  fs.writeFileSync(video, 'video');
  let calls = 0;
  const captureImpl = (command, args) => {
    calls += 1;
    assert.equal(command, 'ffmpeg');
    fs.writeFileSync(args.at(-1), 'jpg');
    return { stdout: '' };
  };
  const first = thumbnailFor(projectsDir, video, { captureImpl });
  assert.ok(first.startsWith(path.join(projectsDir, '.pult', 'cache')));
  assert.equal(thumbnailFor(projectsDir, video, { captureImpl }), first);
  assert.equal(calls, 1);
});

test('frame extraction passes arguments without a shell and reports failure', (t) => {
  const { projectsDir } = makePultRoot(t);
  const video = path.join(projectsDir, 'clip.mp4');
  const out = path.join(projectsDir, 'frame.jpg');
  let seen;
  const ok = extractFrame(video, 14.24, out, {
    captureImpl: (command, args) => {
      seen = { command, args };
      fs.writeFileSync(out, 'jpg');
      return { stdout: '' };
    },
  });
  assert.equal(ok, true);
  assert.equal(seen.command, 'ffmpeg');
  assert.deepEqual(seen.args.slice(seen.args.indexOf('-ss'), seen.args.indexOf('-ss') + 4), ['-ss', '14.24', '-i', video]);
  assert.equal(seen.args.at(-1), out);
  assert.equal(extractFrame(video, 1, path.join(projectsDir, 'none.jpg'), { captureImpl: () => ({ stdout: '' }) }), false);
});

// Symlink-hardening: mkdir -p follows a symlinked .pult if only .pult/cache is
// lstat-checked. A hostile .pult must not let the cache escape projects/.
test('a symlinked .pult must not redirect the cache outside projects/', { skip: process.platform === 'win32' }, (t) => {
  const { base, projectsDir } = makePultRoot(t);
  const video = path.join(projectsDir, 'clip.mp4');
  fs.writeFileSync(video, 'video');
  const outside = path.join(base, 'outside-pult');
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(projectsDir, '.pult'), 'dir');

  assert.equal(probeMedia(projectsDir, video, { captureImpl: () => ({ stdout: PROBE }) }), null);
  assert.equal(thumbnailFor(projectsDir, video, {
    captureImpl: (command, args) => {
      fs.writeFileSync(args.at(-1), 'jpg');
      return { stdout: '' };
    },
  }), null);

  assert.deepEqual(fs.readdirSync(outside), []);
});

// A hand-edited probe cache is sent to the browser as `meta`: extra/garbage fields
// must never leak through, and a cache with the wrong shape must trigger a re-probe
// instead of being trusted blindly.
test('a tampered probe cache is trimmed to three keys, or ignored and re-probed', (t) => {
  const { projectsDir } = makePultRoot(t);
  const video = path.join(projectsDir, 'clip.mp4');
  fs.writeFileSync(video, 'video');
  let calls = 0;
  const captureImpl = () => {
    calls += 1;
    return { stdout: PROBE };
  };

  const first = probeMedia(projectsDir, video, { captureImpl });
  assert.deepEqual(first, { width: 1080, height: 1920, durationSec: 27.48 });
  assert.equal(calls, 1);

  const cacheDirPath = path.join(projectsDir, '.pult', 'cache');
  const [cacheFile] = fs.readdirSync(cacheDirPath).filter((name) => name.endsWith('.json'));
  const cachePath = path.join(cacheDirPath, cacheFile);

  fs.writeFileSync(cachePath, `${JSON.stringify({
    width: 1, height: 1, durationSec: 1, path: '/secret',
  }, null, 2)}\n`);
  const withExtraFields = probeMedia(projectsDir, video, { captureImpl });
  assert.deepEqual(withExtraFields, { width: 1, height: 1, durationSec: 1 });
  assert.equal(calls, 1);

  fs.writeFileSync(cachePath, `${JSON.stringify({ width: 'x' }, null, 2)}\n`);
  const reprobed = probeMedia(projectsDir, video, { captureImpl });
  assert.deepEqual(reprobed, { width: 1080, height: 1920, durationSec: 27.48 });
  assert.equal(calls, 2);
});
