'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { toolAvailable, ffmpegEncoderAvailable } = require('./helpers/media-fixtures');

const ROOT = path.resolve(__dirname, '..');
const SKIP = !(toolAvailable('ffmpeg') && ffmpegEncoderAvailable('libx264'))
  && 'ffmpeg with libx264 is not installed';
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-palette-security-'));
after(() => fs.rmSync(WORK, { recursive: true, force: true }));

// GHSA-5v7r-6r5c-r473: file-type 13.0.0 – 21.3.0 зависает на испорченном ASF.
const FIXED_FILE_TYPE = [21, 3, 1];
const MAX_PALETTE_PIXELS = 20 * 320 * 320;

function versionBelow(version, minimum) {
  const parts = String(version).split(/[.+-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((parts[i] || 0) !== minimum[i]) return (parts[i] || 0) < minimum[i];
  }
  return false;
}

function vulnerableLockEntries(lock) {
  return Object.entries(lock.packages || {})
    .filter(([name, meta]) => (
      /(^|\/)node_modules\/(node-vibrant|@vibrant\/[^/]+)$/.test(name)
      || (/(^|\/)node_modules\/file-type$/.test(name) && versionBelow(meta.version, FIXED_FILE_TYPE))
    ))
    .map(([name, meta]) => `${name}@${meta.version}`);
}

function video(name, source) {
  const file = path.join(WORK, name);
  const result = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', source,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return file;
}

function runPalette(input) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts/palette.js'), input, '--brandLock', '0'], {
    cwd: ROOT, encoding: 'utf8', timeout: 60_000,
  });
}

test('lockfile check flags the vulnerable node-vibrant chain and accepts the fixed file-type', () => {
  const payload = { packages: {
    '': { dependencies: { 'node-vibrant': '^4.0.4' } },
    'node_modules/node-vibrant': { version: '4.0.4' },
    'node_modules/@vibrant/image-node': { version: '4.0.4' },
    'node_modules/@jimp/core/node_modules/file-type': { version: '16.5.4' },
  } };
  assert.deepEqual(vulnerableLockEntries(payload), [
    'node_modules/node-vibrant@4.0.4',
    'node_modules/@vibrant/image-node@4.0.4',
    'node_modules/@jimp/core/node_modules/file-type@16.5.4',
  ]);
  const legitimate = { packages: {
    '': {},
    'node_modules/file-type': { version: '21.3.1' },
    'node_modules/vibrant-colors-docs': { version: '1.0.0' },
  } };
  assert.deepEqual(vulnerableLockEntries(legitimate), []);
});

test('installed dependencies carry no node-vibrant chain or vulnerable file-type', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    assert.equal(Object.hasOwn(pkg[field] || {}, 'node-vibrant'), false, field);
  }
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.deepEqual(vulnerableLockEntries(lock), []);
});

test('autotheme palette never loads a JavaScript image decoder', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/palette.js'), 'utf8');
  assert.doesNotMatch(source, /node-vibrant|jimp|file-type/i);
});

test('autotheme palette fails fast on a malformed ASF payload and still reads a real video', { skip: SKIP }, () => {
  const asfHeader = Buffer.from('3026b2758e66cf11a6d900aa0062ce6c', 'hex');
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const payload = path.join(WORK, 'malformed.asf');
  // Заголовок ASF с одним вложенным объектом нулевой длины – форма, на которой зависал file-type.
  fs.writeFileSync(payload, Buffer.concat([
    asfHeader, u64(54), Buffer.from([1, 0, 0, 0, 1, 2]), Buffer.alloc(16, 0x41), u64(0),
  ]));
  const hostile = runPalette(payload);
  assert.equal(hostile.error, undefined, String(hostile.error));
  assert.notEqual(hostile.status, 0);
  assert.doesNotMatch(hostile.stdout, /"colors"/);

  const legitimate = runPalette(video('legit.mp4', 'color=c=0x2255cc:s=320x240:d=1:r=5'));
  assert.equal(legitimate.status, 0, String(legitimate.error || legitimate.stderr));
});

test('autotheme palette bounds the pixels it reads for extreme aspect ratios', { skip: SKIP }, () => {
  const result = runPalette(video('tall.mp4', 'color=c=0x2e8b57:s=16x4096:d=1:r=5'));
  assert.equal(result.status, 0, String(result.error || result.stderr));
  const pixels = Number(/pixels: (\d+)/.exec(result.stdout)?.[1]);
  assert.ok(pixels > 0 && pixels <= MAX_PALETTE_PIXELS, `pixels=${pixels}`);
});

test('autotheme palette passes a hostile file name to ffmpeg as one literal argument', { skip: SKIP }, () => {
  const hostile = path.join(WORK, `- clip ' " $(touch pwned) ;.mp4`);
  fs.copyFileSync(video('plain.mp4', 'color=c=0xd2691e:s=320x240:d=1:r=5'), hostile);
  const result = runPalette(hostile);
  assert.equal(result.status, 0, String(result.error || result.stderr));
  assert.equal(fs.existsSync(path.join(ROOT, 'pwned')), false);
});
