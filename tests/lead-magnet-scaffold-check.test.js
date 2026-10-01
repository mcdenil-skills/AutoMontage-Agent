const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const { checkRevision } = require('../scripts/lead-magnet/check');
const library = require('../scripts/lead-magnet/library');
const { writeScaffold } = require('../scripts/lead-magnet/scaffold');
const { makeLeadMagnet, writeRevision } = require('./helpers/lead-magnet-fixtures');

let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser.close(); });
const launch = async () => ({ newContext: (options) => browser.newContext(options), close: async () => {} });

test('an unfilled scaffold is red only on blocks and promise; a filled one passes every rule', async (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const { n, dir } = library.startRevision(projectsDir, id);
  writeScaffold(projectsDir, id, n, { env: {} });
  const scaffold = fs.readFileSync(path.join(dir, 'page.html'), 'utf8');
  writeRevision(dir, { page: scaffold });
  let report = await checkRevision(projectsDir, id, n, { env: {}, launch });
  const red = report.items.filter((item) => !item.ok).map((item) => item.id).sort();
  assert.deepEqual(red, ['blocks', 'promise']);

  const prompts = Array.from({ length: 5 }, (_, index) => `<div class="lm-code" data-lm-code data-lm-item="prompt"><pre>Промпт ${index + 1}</pre><button type="button" data-lm-copy>Скопировать</button></div>`).join('');
  const filled = scaffold
    .replace(/ data-lm-todo/g, '')
    .replace('<ol>', '<ol><li data-lm-item="step">Открыть сайт конструктора</li>')
    .replace('</section>', `${prompts}</section>`);
  fs.writeFileSync(path.join(dir, 'page.html'), filled);
  report = await checkRevision(projectsDir, id, n, { env: {}, launch });
  assert.equal(report.ok, true, JSON.stringify(report.items.filter((item) => !item.ok)));
});
