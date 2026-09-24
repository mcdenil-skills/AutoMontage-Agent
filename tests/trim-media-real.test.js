const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  ffmpegEncoderAvailable,
  runTool: runFixture,
  toolAvailable,
} = require('./helpers/media-fixtures');
const { runTrim } = require('../scripts/trim-media');

test('real runTrim encodes with the installed ffmpeg major version', { timeout: 120_000 }, (t) => {
  if (!toolAvailable('ffmpeg') || !toolAvailable('ffprobe') || !ffmpegEncoderAvailable('libx264')) {
    t.skip('real trim requires ffmpeg, ffprobe and libx264');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-trim-real-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'input.mp4');
  const output = path.join(dir, 'output.mp4');
  runFixture('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', input,
  ], dir);

  runTrim({ input, output, intervals: [[0.2, 1], [1.6, 2.4]], audioFadeSec: 0.04, precision: 6 });

  const probe = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', output,
  ], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  assert.ok(Math.abs(Number(probe.stdout) - 1.6) < 0.1, probe.stdout);
});
