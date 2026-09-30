// scripts/lead-magnet/check.js
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const Ajv = require('ajv');

const schema = require('../../schema/lead-magnet-check.schema.json');
const { hashFile, writeJsonAtomic } = require('../pult/files');
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

async function checkRevision(projectsDir, id, n, {
  env = process.env,
  now = () => new Date(),
  launch = () => require('playwright').chromium.launch({ headless: true }),
} = {}) {
  const passport = readLeadMagnet(projectsDir, id);
  const dir = revisionDir(projectsDir, id, n);
  const pagePath = path.join(dir, 'page.html');
  const pageUrl = pathToFileURL(pagePath).href;
  const pageSha256 = hashFile(pagePath);
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
          if (url === pageUrl || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
          external.push(url);
          return route.abort();
        });
        const page = await context.newPage();
        await page.goto(pageUrl, { waitUntil: 'load' });
        await page.screenshot({ path: path.join(dir, 'qa', shot), fullPage: true });
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
    const file = path.join(dir, ...TEXT_FILES[kind].split('/'));
    const length = fs.existsSync(file) ? [...fs.readFileSync(file, 'utf8')].length : -1;
    if (length < 0) return [`${kind}: нет файла`];
    return length > TEXT_LIMITS[kind] ? [`${kind}: ${length} из ${TEXT_LIMITS[kind]}`] : [];
  });
  const duplicateBlocks = desktop.blockIds.filter((value, index, all) => all.indexOf(value) !== index);
  const facts = readFacts(dir);

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
    item('blocks', desktop.blockIds.length > 0 && duplicateBlocks.length === 0 && desktop.blockIds.every((value) => /^[a-z0-9][a-z0-9-]{0,60}$/.test(value)),
      duplicateBlocks.length ? `повторяются блоки: ${duplicateBlocks.join(', ')}` : `блоков: ${desktop.blockIds.length}`),
    item('texts', textProblems.length === 0, textProblems.length ? textProblems.join('; ') : 'тексты в лимитах'),
    item('facts', facts.ok, facts.message),
  ];
  const factsSha256 = hashFile(path.join(dir, 'facts.json'));
  const report = { version: 1, checkedAt: now().toISOString(), pageSha256, factsSha256, ok: items.every((entry) => entry.ok), items };
  if (!validateReport(report)) throw new Error('check: отчёт не соответствует схеме');
  writeJsonAtomic(path.join(dir, 'qa', 'check.json'), report);
  return report;
}

module.exports = { PHONE_WIDTH, checkRevision };
