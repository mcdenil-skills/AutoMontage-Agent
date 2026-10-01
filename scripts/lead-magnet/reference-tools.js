// Agent-only tools for bringing approved reference uploads into the library and
// capturing reference pages. HTML uploads are treated as inert data.
const fs = require('node:fs');
const path = require('node:path');

const { captureProjectDirectoryGuard, resolveProjectPath, stageOwnedSiblingFile } = require('../project/workspace');
const { ensureDirectory, hashBytes, readJsonIfExists, writeJsonAtomic } = require('../pult/files');
const { leadMagnetDir, readLeadMagnet } = require('./library');
const { normalizeReferenceUrl, REFS_DIR } = require('./references');

const MAX_SHOT_HEIGHT = 8000;
const TEXT_LIMIT = 4000;
const REF_NAME = /^[a-f0-9]{64}\.(?:png|jpg|webp|pdf|html)$/;

function referencesDir(projectsDir, id) {
  const root = leadMagnetDir(projectsDir, id);
  const dir = resolveProjectPath(root, 'references', { label: 'references', type: 'directory' });
  ensureDirectory(dir);
  return resolveProjectPath(root, 'references', { label: 'references', mustExist: true, type: 'directory' });
}

function readProvenance(projectsDir, id) {
  const dir = referencesDir(projectsDir, id);
  const file = resolveProjectPath(dir, 'provenance.json', { label: 'references/provenance.json', type: 'file' });
  const value = readJsonIfExists(file, 'references/provenance.json');
  return Array.isArray(value) ? value : [];
}

function addProvenance(projectsDir, id, entry) {
  const dir = referencesDir(projectsDir, id);
  const file = resolveProjectPath(dir, 'provenance.json', { label: 'references/provenance.json', type: 'file' });
  writeJsonAtomic(file, [...readProvenance(projectsDir, id), entry]);
}

function importReference(projectsDir, id, { folder, storedPath, now = () => new Date() }) {
  const passport = readLeadMagnet(projectsDir, id);
  const listed = passport.params.design.references.some((reference) => reference.kind === 'file' && reference.path === storedPath);
  if (!listed) throw new Error('референс не из параметров этого лид-магнита');
  if (typeof storedPath !== 'string' || !storedPath.startsWith(`${REFS_DIR}/`)
    || !REF_NAME.test(storedPath.slice(REFS_DIR.length + 1))) throw new Error('референс: неверный путь');
  if (!passport.videos.includes(folder)) throw new Error('референс: неверная папка ролика');
  const projectDir = resolveProjectPath(projectsDir, folder, { label: 'папка ролика', mustExist: true, type: 'directory' });
  const source = resolveProjectPath(projectDir, storedPath, { label: 'reference', mustExist: true, type: 'file' });
  const bytes = fs.readFileSync(source);
  const sha256 = hashBytes(bytes);
  if (path.basename(storedPath) !== `${sha256}${path.extname(storedPath)}`) throw new Error('референс изменился после загрузки');
  const dir = referencesDir(projectsDir, id);
  const name = path.basename(storedPath);
  const target = resolveProjectPath(dir, name, { label: 'reference', type: 'file' });
  try {
    fs.writeFileSync(target, bytes, { flag: 'wx' });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
    if (hashBytes(fs.readFileSync(target)) !== sha256) throw new Error('референс: конфликт в библиотеке');
  }
  addProvenance(projectsDir, id, {
    file: name, source: 'upload', origin: `${folder}/${storedPath}`, sha256, at: now().toISOString(),
  });
  return target;
}

async function shoot(context, url, projectsDir, dir, prefix, guard) {
  const files = [];
  let text = '';
  for (const [view, width] of [['desktop', 1280], ['phone', 390]]) {
    const page = await context.newPage();
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      const height = Math.max(1, Math.min(MAX_SHOT_HEIGHT, await page.evaluate(() => document.documentElement.scrollHeight)));
      const name = `${prefix}-${view}.png`;
      guard.assertCurrent();
      const relative = path.relative(projectsDir, path.join(dir, name));
      const destination = resolveProjectPath(projectsDir, relative, { label: 'reference screenshot', type: 'file' });
      const bytes = await page.screenshot({ clip: { x: 0, y: 0, width, height } });
      guard.assertCurrent();
      resolveProjectPath(projectsDir, relative, { label: 'reference screenshot', type: 'file' });
      const stage = stageOwnedSiblingFile(destination, bytes, {
        purpose: 'lead-reference-shot', assertParentCurrent: guard.assertCurrent, verifyPublishedIdentity: true,
      });
      try {
        stage.commitReplace();
      } finally {
        stage.cleanupTemp();
      }
      files.push(name);
      if (!text) text = (await page.evaluate(() => document.body ? document.body.innerText : '')).slice(0, TEXT_LIMIT);
    } finally {
      await page.close();
    }
  }
  return { files, text };
}

async function shootReference(projectsDir, id, {
  url = null, file = null, now = () => new Date(),
  launch = () => require('playwright').chromium.launch({ headless: true }),
}) {
  readLeadMagnet(projectsDir, id);
  if (Boolean(url) === Boolean(file)) throw new Error('нужна одна ссылка или HTML-референс');
  const dir = referencesDir(projectsDir, id);
  let target;
  let options;
  let origin;
  let htmlBytes = null;
  if (url) {
    target = normalizeReferenceUrl(url);
    options = { acceptDownloads: false, serviceWorkers: 'block' };
    origin = target;
  } else {
    if (typeof file !== 'string' || !/^references\/[a-f0-9]{64}\.html$/.test(file)) {
      throw new Error('HTML-референс должен лежать в references/');
    }
    const local = resolveProjectPath(dir, path.basename(file), { label: 'reference', mustExist: true, type: 'file' });
    htmlBytes = fs.readFileSync(local);
    if (hashBytes(htmlBytes) !== path.basename(file, '.html')) throw new Error('HTML-референс изменился');
    target = 'https://lead-magnet.invalid/reference.html';
    options = { offline: true, javaScriptEnabled: false, acceptDownloads: false, serviceWorkers: 'block' };
    origin = file;
  }
  const prefix = `shot-${hashBytes(Buffer.from(origin)).slice(0, 12)}`;
  // Snapshot every ancestor before browser work can yield to a directory swap.
  const guard = captureProjectDirectoryGuard(projectsDir, path.join(dir, `${prefix}-desktop.png`), fs, 'reference screenshot');
  const browser = await launch();
  let result;
  try {
    const context = await browser.newContext(options);
    try {
      if (htmlBytes) await context.route('**/*', (route) => (route.request().url() === target
        ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: htmlBytes }) : route.abort()));
      result = await shoot(context, target, projectsDir, dir, prefix, guard);
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
  guard.assertCurrent();
  const files = result.files.map((name) => `references/${name}`);
  addProvenance(projectsDir, id, { file: files.join(', '), source: url ? 'url' : 'html', origin, sha256: null, at: now().toISOString() });
  return { files, text: result.text };
}

module.exports = { importReference, readProvenance, shootReference };
