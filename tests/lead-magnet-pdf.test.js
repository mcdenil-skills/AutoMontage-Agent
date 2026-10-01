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

function launchWithBeforePdf(callback) {
  return async () => ({
    newContext: async (options) => {
      const context = await browser.newContext(options);
      const newPage = context.newPage.bind(context);
      context.newPage = async () => {
        const page = await newPage();
        const emulateMedia = page.emulateMedia.bind(page);
        page.emulateMedia = async (...args) => {
          const result = await emulateMedia(...args);
          callback();
          return result;
        };
        return page;
      };
      return context;
    },
    close: async () => {},
  });
}

test('printing creates a PDF from the page without network and replaces the placeholder', async (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const { n, dir } = library.startRevision(projectsDir, id);
  writeRevision(dir, { page: goodPage({ extra: '<img src="https://example.com/tracker.png" alt="">' }) });
  const out = await renderPdf(projectsDir, id, n, { launch });
  assert.equal(out, path.join(dir, 'page.pdf'));
  const bytes = fs.readFileSync(out);
  assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(bytes.length > 1000);
});

test('a revision directory swapped to an outside symlink during Chromium cannot receive the PDF', async (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const { n, dir } = library.startRevision(projectsDir, id);
  writeRevision(dir);
  const movedDir = path.join(path.dirname(projectsDir), `${id}-revision-outside`);
  let swapped = false;
  const launchDuringPrint = launchWithBeforePdf(() => {
    fs.renameSync(dir, movedDir);
    fs.symlinkSync(movedDir, dir);
    swapped = true;
  });

  await assert.rejects(renderPdf(projectsDir, id, n, { launch: launchDuringPrint }), /identity changed|symbolic link/);
  assert.equal(swapped, true);
  assert.equal(fs.readFileSync(path.join(movedDir, 'page.pdf'), 'utf8'), '%PDF-1.7');
});

test('a page.pdf replaced by an outside symlink during Chromium is replaced without writing through it', async (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const { n, dir } = library.startRevision(projectsDir, id);
  writeRevision(dir);
  const outsidePdf = path.join(path.dirname(projectsDir), `${id}-outside.pdf`);
  fs.writeFileSync(outsidePdf, 'outside sentinel');
  let swapped = false;
  const launchDuringPrint = launchWithBeforePdf(() => {
    fs.unlinkSync(path.join(dir, 'page.pdf'));
    fs.symlinkSync(outsidePdf, path.join(dir, 'page.pdf'));
    swapped = true;
  });

  const out = await renderPdf(projectsDir, id, n, { launch: launchDuringPrint });
  assert.equal(swapped, true);
  assert.equal(fs.readFileSync(outsidePdf, 'utf8'), 'outside sentinel');
  assert.equal(fs.lstatSync(out).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(out).subarray(0, 5).toString('latin1'), '%PDF-');
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
