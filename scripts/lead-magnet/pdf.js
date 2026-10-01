// scripts/lead-magnet/pdf.js
const fs = require('node:fs');
const { captureProjectDirectoryGuard, stageOwnedSiblingFile } = require('../project/workspace');

const { checkedFile } = require('./check');
const { readLeadMagnet, revisionDir } = require('./library');

function readPage(pagePath, guard) {
  guard.assertCurrent();
  let handle;
  try {
    handle = fs.openSync(pagePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    guard.assertCurrent();
    if (!fs.fstatSync(handle).isFile()) throw new Error('page.html must be a regular file');
    const bytes = fs.readFileSync(handle);
    guard.assertCurrent();
    return bytes;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function publishPdf(out, bytes, guard) {
  guard.assertCurrent();
  const stage = stageOwnedSiblingFile(out, bytes, {
    purpose: 'lead-pdf',
    assertParentCurrent: guard.assertCurrent,
    verifyPublishedIdentity: true,
  });
  try {
    stage.commitReplace();
  } finally {
    stage.cleanupTemp();
  }
}

// PDF печатается из той же страницы, без сети: кнопки «Скопировать» скрывает @media print заготовки.
async function renderPdf(projectsDir, id, n, {
  launch = () => require('playwright').chromium.launch({ headless: true }),
} = {}) {
  readLeadMagnet(projectsDir, id);
  const dir = revisionDir(projectsDir, id, n);
  const pagePath = checkedFile(projectsDir, dir, 'page.html');
  const out = checkedFile(projectsDir, dir, 'page.pdf');
  const pageGuard = captureProjectDirectoryGuard(projectsDir, pagePath, fs, 'page.html');
  const outputGuard = captureProjectDirectoryGuard(projectsDir, out, fs, 'page.pdf');
  const pageBytes = readPage(pagePath, pageGuard);
  // Serve captured bytes: Chromium never reopens mutable project paths.
  const pageUrl = 'https://lead-magnet.invalid/page.html';
  const browser = await launch();
  let pdfBytes;
  try {
    const context = await browser.newContext({ offline: true, serviceWorkers: 'block' });
    try {
      await context.route('**/*', (route) => {
        const url = route.request().url();
        if (url === pageUrl) return route.fulfill({ contentType: 'text/html', body: pageBytes });
        return url.startsWith('data:') || url.startsWith('blob:') ? route.continue() : route.abort();
      });
      const page = await context.newPage();
      await page.goto(pageUrl, { waitUntil: 'load' });
      await page.emulateMedia({ media: 'print' });
      pdfBytes = await page.pdf({
        format: 'A4', printBackground: true, margin: { top: '16mm', bottom: '16mm', left: '12mm', right: '12mm' },
      });
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
  pageGuard.assertCurrent();
  publishPdf(out, pdfBytes, outputGuard);
  return out;
}

module.exports = { renderPdf };
