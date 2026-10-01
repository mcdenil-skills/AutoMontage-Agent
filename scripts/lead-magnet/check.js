// scripts/lead-magnet/check.js
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');

const schema = require('../../schema/lead-magnet-check.schema.json');
const { createHash } = require('node:crypto');
const { captureProjectDirectoryGuard, resolveProjectPath, stageOwnedSiblingFile } = require('../project/workspace');
const { resolveBrand } = require('./brand');
const { TEXT_FILES, TEXT_LIMITS } = require('./constants');
const { readFacts } = require('./facts');
const { readLeadMagnet, revisionDir } = require('./library');
const { normalizeText } = require('./text');

const validateReport = new Ajv({ allErrors: true }).compile(schema);
const PHONE_WIDTH = 390;

// Выполняется внутри страницы: только чтение DOM, без изменений.
function inspectPage() {
  const isVisible = (element) => element.checkVisibility({
    opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true,
  });
  const items = {};
  for (const element of document.querySelectorAll('[data-lm-item]')) {
    if (!isVisible(element)) continue;
    const key = element.getAttribute('data-lm-item');
    items[key] = (items[key] || 0) + 1;
  }
  const ctas = [...document.querySelectorAll('[data-lm="cta"]')];
  const blocks = [...document.querySelectorAll('[data-lm-block]')];
  const ctaIsLast = ctas.length === 1 && blocks.every((block) => block === ctas[0] || block.contains(ctas[0])
    || Boolean(block.compareDocumentPosition(ctas[0]) & Node.DOCUMENT_POSITION_FOLLOWING));
  const pres = [...document.querySelectorAll('pre')];
  const withoutCopy = pres.filter((pre) => {
    const holder = pre.closest('[data-lm-code]');
    return !holder || !holder.querySelector('[data-lm-copy]');
  }).length;
  const heading = document.querySelector('[data-lm-block="hero"], header, h1');
  // Общая ширина документа не замечает текст, обрезанный внутри overflow:hidden.
  const clippedText = [...document.body.querySelectorAll('*')].filter((element) => {
    if (!element.innerText?.trim() || !isVisible(element)) return false;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden') return false;
    const clips = (overflow) => ['hidden', 'clip', 'auto', 'scroll'].includes(overflow);
    return (clips(style.overflowX) && element.scrollWidth > element.clientWidth + 1)
      || (clips(style.overflowY) && element.scrollHeight > element.clientHeight + 1);
  }).length;
  // Отрицательный left не увеличивает scrollWidth: проверяем сами строки текста.
  let outsideText = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent.trim() || !isVisible(node.parentElement)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    if ([...range.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0
      && (rect.left < -1 || rect.right > window.innerWidth + 1))) outsideText += 1;
  }
  return {
    text: document.body.innerText,
    items,
    ctaCount: ctas.length,
    ctaIsLast,
    blockIds: blocks.map((block) => block.getAttribute('data-lm-block')),
    todo: document.querySelectorAll('[data-lm-todo]').length,
    pres: pres.length,
    withoutCopy,
    clippedText: clippedText + outsideText,
    hasLogo: Boolean(document.querySelector('[data-lm="logo"] svg, [data-lm="logo"] img, svg[data-lm="logo"], img[data-lm="logo"]')),
    headerText: `${document.title} ${heading ? heading.textContent : ''}`,
  };
}

function item(id, ok, message) {
  // Полные факты остаются в facts.json; краткая диагностика обязана влезать в схему.
  const characters = [...message];
  return { id, ok, message: characters.length > 400 ? `${characters.slice(0, 399).join('')}…` : message };
}

// Every descendant is confined before access; identity guards span asynchronous browser work.
function checkedFile(projectsDir, dir, relative) {
  return resolveProjectPath(projectsDir, path.relative(projectsDir, path.join(dir, relative)), { label: relative, type: 'file' });
}
function readChecked(projectsDir, dir, relative) {
  const file = checkedFile(projectsDir, dir, relative);
  const guard = captureProjectDirectoryGuard(projectsDir, file, fs, relative);
  guard.assertCurrent();
  let handle;
  try {
    handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    guard.assertCurrent();
    if (!fs.fstatSync(handle).isFile()) throw new Error('Expected regular file');
    const bytes = fs.readFileSync(handle);
    guard.assertCurrent();
    return bytes;
  } catch (error) {
    if (error.code === 'ENOENT') { guard.assertCurrent(); return null; }
    throw error;
  } finally { if (handle !== undefined) fs.closeSync(handle); }
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function inputFingerprint(projectsDir, dir, passport) {
  const texts = passport.params.texts.map((kind) => {
    const bytes = readChecked(projectsDir, dir, TEXT_FILES[kind]);
    return [kind, bytes === null ? null : digest(bytes)];
  });
  return digest(JSON.stringify({ promise: passport.promise, units: passport.units, texts }));
}
function guardedWrite(file, bytes, guard) {
  guard.assertCurrent();
  const stage = stageOwnedSiblingFile(file, bytes, { purpose: 'lead-check', assertParentCurrent: guard.assertCurrent, verifyPublishedIdentity: true });
  try { stage.commitReplace(); } finally { stage.cleanupTemp(); }
}

async function checkRevision(projectsDir, id, n, {
  env = process.env,
  now = () => new Date(),
  launch = () => require('playwright').chromium.launch({ headless: true }),
} = {}) {
  const passport = readLeadMagnet(projectsDir, id);
  const dir = revisionDir(projectsDir, id, n);
  const pageBytes = readChecked(projectsDir, dir, 'page.html');
  const inputSha256 = inputFingerprint(projectsDir, dir, passport);
  const outputs = Object.fromEntries(['desktop.png', 'phone-390.png', 'check.json'].map((name) => {
    const file = checkedFile(projectsDir, dir, `qa/${name}`);
    return [name, { file, guard: captureProjectDirectoryGuard(projectsDir, file, fs, 'QA') }];
  }));
  // Serve the already-read bytes: Chromium must never reopen a mutable filesystem path.
  const pageUrl = 'https://lead-magnet.invalid/page.html';
  const pageSha256 = digest(pageBytes);
  const { brand } = resolveBrand({ env });
  const external = [];
  const browser = await launch();
  let desktop;
  let phoneWidth;
  let phoneClippedText;
  try {
    const open = async (viewport, shot) => {
      const context = await browser.newContext({ viewport, serviceWorkers: 'block', offline: true });
      try {
        // route() не перехватывает WebSocket: отдельный маршрут не подключается к серверу.
        await context.routeWebSocket('**/*', (socket) => {
          external.push(socket.url());
          return socket.close({ code: 1008, reason: 'Self-contained page required' });
        });
        // Самодостаточность: страница не должна тянуть ничего, кроме себя самой и data:/blob:.
        await context.route('**/*', (route) => {
          const url = route.request().url();
          if (url === pageUrl) return route.fulfill({ contentType: 'text/html', body: pageBytes });
          if (url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
          external.push(url);
          return route.abort();
        });
        const page = await context.newPage();
        await page.goto(pageUrl, { waitUntil: 'load' });
        const bytes = await page.screenshot({ fullPage: true });
        guardedWrite(outputs[shot].file, bytes, outputs[shot].guard);
        return { info: await page.evaluate(inspectPage), width: await page.evaluate(() => document.documentElement.scrollWidth) };
      } finally {
        await context.close();
      }
    };
    desktop = (await open({ width: 1280, height: 900 }, 'desktop.png')).info;
    const phone = await open({ width: PHONE_WIDTH, height: 844 }, 'phone-390.png');
    phoneWidth = phone.width;
    phoneClippedText = phone.info.clippedText;
  } finally {
    await browser.close();
  }

  const pageText = ` ${normalizeText(desktop.text)} `;
  const quoteOk = !passport.promise.quote || pageText.includes(` ${normalizeText(passport.promise.quote)} `);
  const missingUnits = passport.units.filter((unit) => (desktop.items[unit.key] || 0) < (unit.count || 1));
  const textProblems = passport.params.texts.flatMap((kind) => {
    const bytes = readChecked(projectsDir, dir, TEXT_FILES[kind]);
    const length = bytes === null ? -1 : [...bytes.toString('utf8')].length;
    if (length < 0) return [`${kind}: нет файла`];
    return length > TEXT_LIMITS[kind] ? [`${kind}: ${length} из ${TEXT_LIMITS[kind]}`] : [];
  });
  const duplicateBlocks = desktop.blockIds.filter((value, index, all) => all.indexOf(value) !== index);
  const factsBytes = readChecked(projectsDir, dir, 'facts.json');
  const facts = readFacts(dir, factsBytes);

  const items = [
    item('promise', quoteOk && missingUnits.length === 0, quoteOk
      ? (missingUnits.length ? `не хватает: ${missingUnits.map((unit) => `${unit.label} (${desktop.items[unit.key] || 0} из ${unit.count || 1})`).join(', ')}` : 'обещание выполнено')
      : 'на странице нет цитаты обещания'),
    item('cta', desktop.ctaCount === 1 && desktop.ctaIsLast, desktop.ctaCount === 1
      ? (desktop.ctaIsLast ? 'блок призыва в конце' : 'блок призыва не последний')
      : `блоков призыва: ${desktop.ctaCount}, нужен ровно один`),
    item('phone-width', phoneWidth <= PHONE_WIDTH && phoneClippedText === 0,
      `ширина на телефоне ${phoneWidth} из ${PHONE_WIDTH} px; обрезанных текстовых блоков: ${phoneClippedText}`),
    item('copy-buttons', desktop.withoutCopy === 0, desktop.withoutCopy ? `без кнопки «Скопировать»: ${desktop.withoutCopy}` : `кнопки у всех ${desktop.pres} блоков`),
    item('logo', !brand.logoRequired || desktop.hasLogo, brand.logoRequired ? (desktop.hasLogo ? 'логотип есть' : 'бренд-пак требует логотип') : 'логотип не требуется'),
    item('header', !/лид[\s-]?магнит/i.test(desktop.headerText), 'в шапке нельзя писать «лид-магнит»'),
    item('self-contained', external.length === 0, external.length ? `внешние запросы: ${external.slice(0, 3).join(', ')}` : 'страница самодостаточна'),
    item('blocks', desktop.blockIds.length > 0 && duplicateBlocks.length === 0 && desktop.todo === 0
      && desktop.blockIds.every((value) => /^[a-z0-9][a-z0-9-]{0,60}$/.test(value)),
    desktop.todo
      ? `незаполненные заготовки: ${desktop.todo}`
      : (duplicateBlocks.length ? `повторяются блоки: ${duplicateBlocks.join(', ')}` : `блоков: ${desktop.blockIds.length}`)),
    item('texts', textProblems.length === 0, textProblems.length ? textProblems.join('; ') : 'тексты в лимитах'),
    item('facts', facts.ok, facts.message),
  ];
  const factsSha256 = facts.valid && factsBytes !== null ? digest(factsBytes) : null;
  if (digest(readChecked(projectsDir, dir, 'page.html')) !== pageSha256
    || inputFingerprint(projectsDir, dir, readLeadMagnet(projectsDir, id)) !== inputSha256) {
    throw new Error('Check inputs changed during browser validation');
  }
  const report = { version: 1, checkedAt: now().toISOString(), pageSha256, factsSha256, inputSha256, ok: items.every((entry) => entry.ok), items };
  if (!validateReport(report)) throw new Error('check: отчёт не соответствует схеме');
  guardedWrite(outputs['check.json'].file, `${JSON.stringify(report, null, 2)}\n`, outputs['check.json'].guard);
  return report;
}

module.exports = { PHONE_WIDTH, checkRevision, checkedFile, readChecked, inputFingerprint };
