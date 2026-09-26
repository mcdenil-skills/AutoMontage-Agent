'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;
const SKIP = !HAS_FFMPEG && 'ffmpeg is not installed';
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
  assert.equal(result.status, 0, result.stderr);
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
