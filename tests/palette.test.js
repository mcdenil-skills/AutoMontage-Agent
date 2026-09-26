'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { toolAvailable, ffmpegEncoderAvailable } = require('./helpers/media-fixtures');
const SKIP = !(toolAvailable('ffmpeg') && ffmpegEncoderAvailable('libx264'))
  && 'ffmpeg with libx264 is not installed';
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-palette-'));
after(() => fs.rmSync(WORK, { recursive: true, force: true }));

const THEME_KEYS = ['name', 'colors', 'fonts', 'radius', 'cardShadow', 'cardBorder', 'motion'];
const COLOR_KEYS = ['bg', 'cardBg', 'cardBg2', 'milk', 'accent', 'accentDark', 'text', 'textSoft'];

function solidVideo(hex, size = '320x240') {
  const file = path.join(WORK, `solid-${hex}-${size}.mp4`);
  if (fs.existsSync(file)) return file;
  const result = spawnSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x${hex}:s=${size}:d=1:r=5`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return file;
}

function runPalette(video, extra = []) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/palette.js'), video, ...extra], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(result.status, 0, String(result.error || result.stderr));
  const [json, diagnostics = ''] = result.stdout.split('// ── diagnostics');
  const seedHex = /seed\(video\):.*hex=(#[0-9a-f]{6})/i.exec(diagnostics)?.[1];
  return { theme: JSON.parse(json.trim()), seedHex, diagnostics };
}

function channels(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = channels(hex).map((c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('autotheme palette keeps the theme token format and the exact brand accent at brandLock 1', { skip: SKIP }, () => {
  const { theme } = runPalette(solidVideo('2255cc'));
  assert.deepEqual(Object.keys(theme), THEME_KEYS);
  assert.deepEqual(Object.keys(theme.colors), COLOR_KEYS);
  for (const key of COLOR_KEYS) assert.match(theme.colors[key], /^#[0-9a-f]{6}$/i, key);
  assert.equal(theme.name, 'craft');
  assert.equal(theme.colors.accent, '#CC785C');
});

test('autotheme palette uses a custom brand accent', { skip: SKIP }, () => {
  const { theme } = runPalette(solidVideo('2255cc'), ['--brandLock', '1', '--brandAccent', '#3366FF']);
  assert.equal(theme.colors.accent, '#3366FF');
});

test('autotheme palette seed follows a known solid frame color', { skip: SKIP }, () => {
  for (const hex of ['2255cc', 'd2691e', '2e8b57']) {
    const { seedHex } = runPalette(solidVideo(hex), ['--brandLock', '0']);
    assert.ok(seedHex, `seed is printed for ${hex}`);
    const distance = Math.max(...channels(seedHex).map((c, i) => Math.abs(c - channels(hex)[i])));
    assert.ok(distance <= 16, `seed ${seedHex} is far from #${hex} (${distance})`);
  }
});

test('autotheme palette keeps WCAG 4.5:1 text contrast for light, dark and gray sources', { skip: SKIP }, () => {
  for (const hex of ['f0e8d0', '101010', '808080']) {
    for (const brandLock of ['0', '0.5']) {
      const { theme } = runPalette(solidVideo(hex), ['--brandLock', brandLock]);
      const { text, textSoft, cardBg } = theme.colors;
      assert.ok(contrast(text, cardBg) >= 4.5, `text on cardBg for #${hex} at ${brandLock}`);
      assert.ok(contrast(textSoft, cardBg) >= 4.5, `textSoft on cardBg for #${hex} at ${brandLock}`);
    }
  }
});

function splitVideo(major, minor) {
  const file = path.join(WORK, `split-${major}-${minor}.mp4`);
  if (fs.existsSync(file)) return file;
  // Три четверти кадра – major, четверть – minor; граница на 240 px совпадает с блоками yuv420 и x264.
  const result = spawnSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=0x${major}:s=240x240:d=1:r=5`,
    '-f', 'lavfi', '-i', `color=c=0x${minor}:s=80x240:d=1:r=5`,
    '-filter_complex', '[0:v][1:v]hstack=inputs=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return file;
}

function seedOf(video) {
  const { diagnostics } = runPalette(video, ['--brandLock', '0']);
  const match = /seed\(video\): hue=([\d.]+) chroma=([\d.]+)/.exec(diagnostics);
  assert.ok(match, `seed is printed\n${diagnostics}`);
  return { hue: Number(match[1]), chroma: Number(match[2]) };
}

const hueDistance = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

test('autotheme palette seed blends two colors by their share of the frame', { skip: SKIP }, () => {
  const blue = seedOf(solidVideo('2255cc')).hue;
  const green = seedOf(solidVideo('2e8b57')).hue;
  for (const [major, minor, majorHue, minorHue] of [
    ['2255cc', '2e8b57', blue, green],
    ['2e8b57', '2255cc', green, blue],
  ]) {
    const mixed = seedOf(splitVideo(major, minor)).hue;
    const toMajor = hueDistance(mixed, majorHue);
    const toMinor = hueDistance(mixed, minorHue);
    // 3:1 по площади даёт около 19° от major; равные веса дали бы около 58°, один цвет – 0°.
    assert.ok(toMajor >= 10 && toMajor <= 30, `seed hue ${mixed} is ${toMajor} deg from #${major}`);
    assert.ok(toMajor + toMinor - hueDistance(majorHue, minorHue) < 2, `seed hue ${mixed} is not between #${major} and #${minor}`);
  }
});

test('autotheme palette seed discounts near-gray colors', { skip: SKIP }, () => {
  // Три четверти серого, четверть синего: серый приглушён весом 0.3, chroma seed около 33.
  // Без приглушения было бы около 17, без учёта площади – около 50, по одному цвету – 2 или 64.
  const { chroma } = seedOf(splitVideo('808080', '2255cc'));
  assert.ok(chroma >= 25 && chroma <= 42, `seed chroma ${chroma}`);
});
