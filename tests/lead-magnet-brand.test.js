// tests/lead-magnet-brand.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { defaultTake, resolveBrand } = require('../scripts/lead-magnet/brand');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-brand-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writePack(dir, overrides = {}) {
  const neutral = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', 'lead-magnet', 'neutral', 'brand.json'), 'utf8'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(dir, 'brand.json'), JSON.stringify({ ...neutral, name: 'Мой', logoRequired: true, logo: 'logo.svg', ...overrides }));
}

test('without any pack the neutral brand has no logo', () => {
  const brand = resolveBrand({ env: {} });
  assert.equal(brand.source, 'neutral');
  assert.equal(brand.brand.logoRequired, false);
  assert.deepEqual(defaultTake(brand), { composition: true, colors: true, fonts: true });
});

test('LEAD_MAGNET_BRAND wins; a pack next to THEMES_EXT is found', (t) => {
  const base = tmp(t);
  writePack(path.join(base, 'explicit'));
  writePack(path.join(base, 'pack', 'lead-magnet'), { name: 'Рядом' });
  fs.mkdirSync(path.join(base, 'pack', 'themes'));
  assert.equal(resolveBrand({ env: { LEAD_MAGNET_BRAND: path.join(base, 'explicit') } }).brand.name, 'Мой');
  const sibling = resolveBrand({ env: { THEMES_EXT: path.join(base, 'pack', 'themes') } });
  assert.equal(sibling.source, 'pack');
  assert.equal(sibling.brand.name, 'Рядом');
  assert.equal(sibling.logoPath, path.join(base, 'pack', 'lead-magnet', 'logo.svg'));
  assert.deepEqual(defaultTake(sibling), { composition: true, colors: false, fonts: false });
});

test('an explicit broken pack is an error, a missing sibling falls back to neutral', (t) => {
  const base = tmp(t);
  assert.throws(() => resolveBrand({ env: { LEAD_MAGNET_BRAND: path.join(base, 'nope') } }), /бренд-пак/);
  writePack(path.join(base, 'bad'), { logo: '../../etc/logo.svg' });
  assert.throws(() => resolveBrand({ env: { LEAD_MAGNET_BRAND: path.join(base, 'bad') } }), /бренд-пак/);
  writePack(path.join(base, 'nologo'), { logo: 'missing.svg' });
  assert.throws(() => resolveBrand({ env: { LEAD_MAGNET_BRAND: path.join(base, 'nologo') } }), /логотип/);
  fs.mkdirSync(path.join(base, 'only-themes', 'themes'), { recursive: true });
  assert.equal(resolveBrand({ env: { THEMES_EXT: path.join(base, 'only-themes', 'themes') } }).source, 'neutral');
});

test('social addresses require https; a valid social is accepted', (t) => {
  const dir = tmp(t);
  for (const url of ['http://example.com', 'javascript:alert(1)', 'https://']) {
    writePack(dir, { socials: [{ network: 'telegram', label: 'Telegram', url }] });
    assert.throws(() => resolveBrand({ env: { LEAD_MAGNET_BRAND: dir } }), /бренд-пак/);
  }
  writePack(dir, { socials: [{ network: 'telegram', label: 'Telegram', url: 'https://t.me/example' }] });
  assert.equal(resolveBrand({ env: { LEAD_MAGNET_BRAND: dir } }).brand.socials.length, 1);
});
