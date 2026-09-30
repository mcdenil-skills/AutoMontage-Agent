// tests/lead-magnet-check.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const { checkRevision } = require('../scripts/lead-magnet/check');
const library = require('../scripts/lead-magnet/library');
const { goodPage, makeLeadMagnet, writeRevision } = require('./helpers/lead-magnet-fixtures');

let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser.close(); });
const launch = async () => ({ newContext: (options) => browser.newContext(options), close: async () => {} });

async function run(t, revisionOptions = {}, env = {}) {
  const { projectsDir, id } = makeLeadMagnet(t);
  const { n, dir } = library.startRevision(projectsDir, id);
  writeRevision(dir, revisionOptions);
  const report = await checkRevision(projectsDir, id, n, { env, launch });
  const byId = Object.fromEntries(report.items.map((item) => [item.id, item]));
  return { report, byId, dir };
}

test('a good page passes every item and gets screenshots', async (t) => {
  const { report, dir } = await run(t);
  assert.equal(report.ok, true, JSON.stringify(report.items.filter((item) => !item.ok)));
  assert.ok(fs.statSync(path.join(dir, 'qa', 'desktop.png')).size > 0);
  assert.ok(fs.statSync(path.join(dir, 'qa', 'phone-390.png')).size > 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'qa', 'check.json'), 'utf8')), report);
});

test('each carcass rule fails on its own defect', async (t) => {
  const cases = [
    [{ page: goodPage({ quote: 'другие слова совсем' }) }, 'promise'],
    [{ page: goodPage({ prompts: 4 }) }, 'promise'],
    [{ page: goodPage({ cta: false }) }, 'cta'],
    [{ page: goodPage({ extra: '<section data-lm="cta"><h2>Второй</h2></section>' }) }, 'cta'],
    [{ page: goodPage({ wide: true }) }, 'phone-width'],
    [{ page: goodPage({ extra: '<p style="width:80px;white-space:nowrap;overflow:hidden">Текст обрезается внутри узкого блока</p>' }) }, 'phone-width'],
    [{ page: goodPage({ extra: '<p style="height:10px;overflow:hidden">Текст обрезается по высоте</p>' }) }, 'phone-width'],
    [{ page: goodPage({ copy: false }) }, 'copy-buttons'],
    [{ page: goodPage({ title: 'Лид-магнит: сайт' }) }, 'header'],
    [{ page: goodPage({ extra: '<img src="https://example.com/x.png">' }) }, 'self-contained'],
    [{ texts: { dm: 'я'.repeat(1001), telegram: 'x', instagram: 'x' } }, 'texts'],
    [{ facts: [{ claim: 'Ссылка работает', source: 'https://example.com', status: 'failed' }] }, 'facts'],
  ];
  for (const [options, id] of cases) {
    const { report, byId } = await run(t, options);
    assert.equal(report.ok, false, id);
    assert.equal(byId[id].ok, false, `${id}: ${JSON.stringify(byId[id])}`);
  }
});

test('the logo is required only when the brand pack says so', async (t) => {
  const packDir = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lm-pack-')), 'lead-magnet');
  t.after(() => fs.rmSync(path.dirname(packDir), { recursive: true, force: true }));
  fs.mkdirSync(packDir);
  const neutral = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', 'lead-magnet', 'neutral', 'brand.json'), 'utf8'));
  fs.writeFileSync(path.join(packDir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(packDir, 'brand.json'), JSON.stringify({ ...neutral, logoRequired: true, logo: 'logo.svg' }));
  const without = await run(t, {}, { LEAD_MAGNET_BRAND: packDir });
  assert.equal(without.byId.logo.ok, false);
  const withLogo = await run(t, { page: goodPage({ logo: true }) }, { LEAD_MAGNET_BRAND: packDir });
  assert.equal(withLogo.byId.logo.ok, true);
});
