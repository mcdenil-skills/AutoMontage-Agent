const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const { main } = require('../scripts/lead-magnet/cli');
const library = require('../scripts/lead-magnet/library');
const { storeReference } = require('../scripts/lead-magnet/references');
const { importReference, readProvenance, shootReference } = require('../scripts/lead-magnet/reference-tools');
const { PARAMS, QUOTE, UNITS, makeVideoProject } = require('./helpers/lead-magnet-fixtures');

let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser.close(); });
const launch = async () => ({ newContext: (options) => browser.newContext(options), close: async () => {} });

const HTML_REF = Buffer.from('<!doctype html><html><body><h1 id="title">Карточки шагов</h1><script>document.getElementById("title").textContent = "СКРИПТ ВЫПОЛНИЛСЯ";</script></body></html>');

function magnetWith(t, references) {
  const context = makeVideoProject(t);
  const stored = references.map((bytes) => storeReference(context.projectDir, bytes));
  const id = library.createLeadMagnet(context.projectsDir, {
    codeWord: 'ГАЙД', title: 'Сайт',
    promise: { quote: QUOTE, startSec: 60, endSec: 63.75, sourceFolder: context.folder },
    units: UNITS,
    params: { ...PARAMS, design: { ...PARAMS.design, mode: 'reference', references: stored } },
    videoFolder: context.folder,
  }).id;
  return { ...context, id, stored };
}

test('an uploaded reference is imported with provenance; a foreign file is refused', (t) => {
  const { projectsDir, folder, id, stored } = magnetWith(t, [HTML_REF]);
  const target = importReference(projectsDir, id, { folder, storedPath: stored[0].path });
  assert.equal(path.basename(target), path.basename(stored[0].path));
  assert.deepEqual(readProvenance(projectsDir, id).map((entry) => [entry.source, entry.origin]), [['upload', `${folder}/${stored[0].path}`]]);
  assert.throws(() => importReference(projectsDir, id, { folder, storedPath: `pult/lead-magnet-refs/${'a'.repeat(64)}.png` }), /параметр/);
});

test('project folder traversal is rejected beside a valid import', (t) => {
  const { projectsDir, folder, id, stored } = magnetWith(t, [HTML_REF]);
  assert.throws(() => importReference(projectsDir, id, { folder: `../${folder}`, storedPath: stored[0].path }), /папка ролика|project workspace|canonical relative/);
  assert.ok(fs.existsSync(importReference(projectsDir, id, { folder, storedPath: stored[0].path })));
});

test('changed upload bytes are rejected beside an intact upload', (t) => {
  const { projectsDir, projectDir, folder, id, stored } = magnetWith(t, [HTML_REF]);
  const source = path.join(projectDir, stored[0].path);
  fs.writeFileSync(source, Buffer.from('<!doctype html><html><body>changed</body></html>'));
  assert.throws(() => importReference(projectsDir, id, { folder, storedPath: stored[0].path }), /изменился/);
  fs.writeFileSync(source, HTML_REF);
  assert.ok(fs.existsSync(importReference(projectsDir, id, { folder, storedPath: stored[0].path })));
});

test('reference import is available through the agent CLI', async (t) => {
  const { projectsDir, folder, id, stored } = magnetWith(t, [HTML_REF]);
  const lines = [];
  const code = await main(['reference', 'import', '--projects-dir', projectsDir, '--id', id,
    '--from', folder, '--path', stored[0].path], { write: (line) => lines.push(line) });
  assert.equal(code, 0, lines.join('\n'));
  assert.match(lines.join('\n'), /Референс в библиотеке: references\//);
  assert.equal(readProvenance(projectsDir, id).length, 1);
});

test('an HTML reference is shot offline with scripts off and only from references', async (t) => {
  const { projectsDir, folder, id, stored } = magnetWith(t, [HTML_REF]);
  importReference(projectsDir, id, { folder, storedPath: stored[0].path });
  const result = await shootReference(projectsDir, id, { file: `references/${path.basename(stored[0].path)}`, launch });
  assert.match(result.text, /Карточки шагов/);
  assert.doesNotMatch(result.text, /СКРИПТ ВЫПОЛНИЛСЯ/);
  for (const file of result.files) assert.ok(fs.statSync(path.join(library.leadMagnetDir(projectsDir, id), file)).size > 0);
  assert.equal(readProvenance(projectsDir, id).at(-1).source, 'html');
  const outside = path.join(library.leadMagnetDir(projectsDir, id), 'untrusted.html');
  fs.writeFileSync(outside, HTML_REF);
  await assert.rejects(shootReference(projectsDir, id, { file: 'untrusted.html', launch }), /references/);
});

test('a link is shot at desktop and phone width and recorded', async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><body><h1>Гайд конкурента</h1></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { projectsDir, id } = magnetWith(t, []);
  const url = `http://127.0.0.1:${server.address().port}/guide`;
  const result = await shootReference(projectsDir, id, { url, launch });
  assert.equal(result.files.length, 2);
  assert.match(result.text, /Гайд конкурента/);
  assert.equal(readProvenance(projectsDir, id).at(-1).origin, url);
  await assert.rejects(shootReference(projectsDir, id, { url: 'file:///etc/passwd', launch }), /ссылка/);
});
