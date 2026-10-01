// scripts/lead-magnet/pdf.js
const { pathToFileURL } = require('node:url');

const { checkedFile } = require('./check');
const { readLeadMagnet, revisionDir } = require('./library');

// PDF печатается из той же страницы, без сети: кнопки «Скопировать» скрывает @media print заготовки.
async function renderPdf(projectsDir, id, n, {
  launch = () => require('playwright').chromium.launch({ headless: true }),
} = {}) {
  readLeadMagnet(projectsDir, id);
  const dir = revisionDir(projectsDir, id, n);
  const pagePath = checkedFile(projectsDir, dir, 'page.html');
  const out = checkedFile(projectsDir, dir, 'page.pdf');
  const pageUrl = pathToFileURL(pagePath).href;
  const browser = await launch();
  try {
    const context = await browser.newContext({ offline: true, serviceWorkers: 'block' });
    try {
      await context.route('**/*', (route) => {
        const url = route.request().url();
        return url === pageUrl || url.startsWith('data:') || url.startsWith('blob:') ? route.continue() : route.abort();
      });
      const page = await context.newPage();
      await page.goto(pageUrl, { waitUntil: 'load' });
      await page.emulateMedia({ media: 'print' });
      await page.pdf({
        path: out, format: 'A4', printBackground: true, margin: { top: '16mm', bottom: '16mm', left: '12mm', right: '12mm' },
      });
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return out;
}

module.exports = { renderPdf };
