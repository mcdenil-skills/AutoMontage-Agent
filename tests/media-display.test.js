const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { toolAvailable } = require('./helpers/media-fixtures');
const { displayDimensions, probeMediaPath } = require('../scripts/media-probe');

test('quarter-turn rotation swaps displayed dimensions', () => {
  assert.deepEqual(displayDimensions({ width: 1920, height: 1080, rotation: 90 }), { width: 1080, height: 1920 });
  assert.deepEqual(displayDimensions({ width: 1920, height: 1080, rotation: 270 }), { width: 1080, height: 1920 });
  assert.deepEqual(displayDimensions({ width: 1920, height: 1080, rotation: 180 }), { width: 1920, height: 1080 });
  assert.deepEqual(displayDimensions({ width: 1920, height: 1080 }), { width: 1920, height: 1080 });
});

test('probeMediaPath passes an opened descriptor and closes it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-probe-path-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'clip.mp4');
  fs.writeFileSync(file, 'MEDIA');
  let seen = null;
  const result = probeMediaPath(file, {
    stage: 'take probe',
    probeOpenedMediaImpl({ fileDescriptor, stage }) {
      seen = { fileDescriptor, stage };
      return { width: 1, height: 2, rotation: 0 };
    },
  });
  assert.deepEqual(result, { width: 1, height: 2, rotation: 0 });
  assert.equal(seen.stage, 'take probe');
  assert.throws(() => fs.fstatSync(seen.fileDescriptor), /EBADF/);
  if (process.platform !== 'win32') {
    const link = path.join(dir, 'link.mp4');
    fs.symlinkSync(file, link);
    assert.throws(
      () => probeMediaPath(link, { probeOpenedMediaImpl: () => ({}) }),
      /symbolic link/,
    );
  }
});

test('real rotated clip reports displayed portrait dimensions', { timeout: 60_000 }, (t) => {
  if (!toolAvailable('ffmpeg') || !toolAvailable('ffprobe')) {
    t.skip('rotation probe requires ffmpeg and ffprobe');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-rotation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = path.join(dir, 'base.mp4');
  const rotated = path.join(dir, 'rotated.mp4');
  const encode = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=0.4', '-pix_fmt', 'yuv420p', base], { encoding: 'utf8' });
  assert.equal(encode.status, 0, encode.stderr);
  const rotate = spawnSync('ffmpeg', ['-y', '-v', 'error', '-display_rotation', '90', '-i', base, '-c', 'copy', rotated], { encoding: 'utf8' });
  if (rotate.status !== 0) {
    t.skip('ffmpeg lacks -display_rotation fixture support');
    return;
  }
  const media = probeMediaPath(rotated, { stage: 'rotation probe' });
  assert.equal(media.rotation, 90);
  assert.deepEqual(displayDimensions(media), { width: 90, height: 160 });
});
