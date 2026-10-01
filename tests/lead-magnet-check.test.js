// tests/lead-magnet-check.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const { checkRevision } = require('../scripts/lead-magnet/check');
const library = require('../scripts/lead-magnet/library');
const { hashFile } = require('../scripts/pult/files');
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
  assert.equal(report.factsSha256, hashFile(path.join(dir, 'facts.json')));
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

test('a leftover scaffold marker fails the blocks rule', async (t) => {
  const { report, byId } = await run(t, { page: goodPage({ extra: '<p data-lm-todo>Шаг 1. Название шага</p>' }) });
  assert.equal(report.ok, false);
  assert.equal(byId.blocks.ok, false);
  assert.match(byId.blocks.message, /незаполненные заготовки: 1/);
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

test('phone text must stay inside the viewport, including its left edge', async (t) => {
  const paragraph = (left) => `<p style="position:relative;left:${left}px;width:300px">Текст должен быть виден целиком</p>`;
  const clipped = await run(t, { page: goodPage({ extra: paragraph(-80) }) });
  assert.equal(clipped.byId['phone-width'].ok, false);
  const visible = await run(t, { page: goodPage({ extra: paragraph(10) }) });
  assert.equal(visible.report.ok, true);
});

test('hidden promised items do not count as delivered content', async (t) => {
  const hidden = await run(t, { page: goodPage({ prompts: 4,
    extra: '<p data-lm-item="prompt" style="display:none">Невидимый пятый промпт</p>' }) });
  assert.equal(hidden.byId.promise.ok, false);
  const visible = await run(t, { page: goodPage({ prompts: 5 }) });
  assert.equal(visible.report.ok, true);
});

test('WebSocket attempts fail self-containment without reaching even a local server', async (t) => {
  let connections = 0;
  const server = http.createServer();
  server.on('connection', () => { connections += 1; });
  server.on('upgrade', (_request, socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `ws://127.0.0.1:${server.address().port}/probe`;
  const attack = await run(t, { page: goodPage({ extra: `<script>new WebSocket(${JSON.stringify(url)})</script>` }) });
  assert.equal(connections, 0, 'a WebSocket must never reach the local listener');
  assert.equal(attack.byId['self-contained'].ok, false);
  assert.ok(attack.byId['self-contained'].message.includes(url));
  const offline = await run(t, { page: goodPage({ extra: '<script>document.querySelector("h1").textContent = "Сайт без кода";</script>' }) });
  assert.equal(offline.report.ok, true, JSON.stringify(offline.report.items.filter((item) => !item.ok)));
  assert.equal(connections, 0);
});

test('a maximum-length failed fact produces a saved failed report without losing the claim', async (t) => {
  const fact = { claim: 'я'.repeat(400), source: 'Локальный источник', status: 'failed' };
  const failed = await run(t, { facts: [fact] });
  assert.equal(failed.report.ok, false);
  assert.equal(failed.byId.facts.ok, false);
  assert.ok([...failed.byId.facts.message].length <= 400);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(failed.dir, 'qa', 'check.json'), 'utf8')), failed.report);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(failed.dir, 'facts.json'), 'utf8')).items, [fact]);
  const verified = await run(t, { facts: [{ ...fact, status: 'verified' }] });
  assert.equal(verified.report.ok, true);
});

test('QA descendants reject symlinks and directory swaps without outside writes', async (t) => {
  for (const swap of [false, true]) {
    const { base, projectsDir, id } = makeLeadMagnet(t);
    const { n, dir } = library.startRevision(projectsDir, id);
    writeRevision(dir);
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside);
    const replace = () => { fs.renameSync(path.join(dir, 'qa'), path.join(dir, 'old-qa')); fs.symlinkSync(outside, path.join(dir, 'qa')); };
    if (!swap) replace();
    await assert.rejects(checkRevision(projectsDir, id, n, { env: {}, launch: async () => {
      if (swap) replace();
      return launch();
    } }));
    assert.deepEqual(fs.readdirSync(outside), []);
  }
});

test('missing and malformed facts replace green reports and recover', async (t) => {
  for (const initial of [true, false]) {
    const { projectsDir, id } = makeLeadMagnet(t);
    const { n, dir } = library.startRevision(projectsDir, id);
    writeRevision(dir);
    if (!initial) assert.equal((await checkRevision(projectsDir, id, n, { env: {}, launch })).ok, true);
    for (const malformed of [false, true]) {
      if (malformed) fs.writeFileSync(path.join(dir, 'facts.json'), '{broken');
      else fs.unlinkSync(path.join(dir, 'facts.json'));
      const report = await checkRevision(projectsDir, id, n, { env: {}, launch });
      assert.equal(report.ok, false);
      assert.equal(report.items.find((x) => x.id === 'facts').ok, false);
      assert.equal(report.factsSha256, null);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'qa/check.json'))), report);
    }
    writeRevision(dir);
    assert.equal((await checkRevision(projectsDir, id, n, { env: {}, launch })).ok, true);
  }
});

test('check rejects symlinked page, facts and selected text descendants before reading', async (t) => {
  for (const relative of ['page.html', 'facts.json', 'texts']) {
    const { base, projectsDir, id } = makeLeadMagnet(t);
    const { n, dir } = library.startRevision(projectsDir, id);
    writeRevision(dir);
    const outside = path.join(base, 'outside-input');
    fs.renameSync(path.join(dir, relative), outside);
    fs.symlinkSync(outside, path.join(dir, relative));
    await assert.rejects(checkRevision(projectsDir, id, n, { env: {}, launch }));
  }
});

test('Chromium reads captured page bytes and rejects page replacement during launch', async (t) => {
  const { base, projectsDir, id } = makeLeadMagnet(t);
  const { n, dir } = library.startRevision(projectsDir, id);
  writeRevision(dir);
  const outside = path.join(base, 'outside.html');
  fs.writeFileSync(outside, '<h1>Outside secret must not be rendered</h1>');
  await assert.rejects(checkRevision(projectsDir, id, n, { env: {}, launch: async () => {
    fs.renameSync(path.join(dir, 'page.html'), path.join(dir, 'original.html'));
    fs.symlinkSync(outside, path.join(dir, 'page.html'));
    return launch();
  } }));
  assert.equal(fs.existsSync(path.join(dir, 'qa/check.json')), false);
});
