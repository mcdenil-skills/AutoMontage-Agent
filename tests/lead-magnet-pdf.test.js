const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const library = require('../scripts/lead-magnet/library');
const { main } = require('../scripts/lead-magnet/cli');
const { renderPdf } = require('../scripts/lead-magnet/pdf');
const { goodPage, makeLeadMagnet, writeRevision } = require('./helpers/lead-magnet-fixtures');

let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser.close(); });
const launch = async () => ({ newContext: (options) => browser.newContext(options), close: async () => {} });

test('the PDF is printed from the page without network and replaces the placeholder', async (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const { n, dir } = library.startRevision(projectsDir, id);
  writeRevision(dir, { page: goodPage({ extra: '<img src="https://example.com/tracker.png" alt="">' }) });
  const out = await renderPdf(projectsDir, id, n, { launch });
  assert.equal(out, path.join(dir, 'page.pdf'));
  const bytes = fs.readFileSync(out);
  assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(bytes.length > 1000);
});

test('the pdf CLI command prints the requested revision', async (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const { n, dir } = library.startRevision(projectsDir, id);
  writeRevision(dir);
  const output = [];
  const code = await main(['pdf', '--projects-dir', projectsDir, '--id', id, '--revision', String(n)], {
    write: (line) => output.push(line),
  });
  assert.equal(code, 0, output.join('\n'));
  assert.match(output.join('\n'), /PDF готов/);
  assert.ok(fs.statSync(path.join(dir, 'page.pdf')).size > 1000);
});
