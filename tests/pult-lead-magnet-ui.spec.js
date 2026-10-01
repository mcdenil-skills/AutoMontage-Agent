// tests/pult-lead-magnet-ui.spec.js
const fs = require('node:fs');
const path = require('node:path');

const { test, expect } = require('playwright/test');

const { approveLeadMagnet } = require('../scripts/lead-magnet/approve');
const { resolveBrand } = require('../scripts/lead-magnet/brand');
const library = require('../scripts/lead-magnet/library');
const { addOffer } = require('../scripts/lead-magnet/offers');
const { readDecisions } = require('../scripts/lead-magnet/requests');
const { scaffoldPage } = require('../scripts/lead-magnet/scaffold');
const { startPultServer } = require('../scripts/pult/server');
const { addLegacyFolder, makePultRoot } = require('./helpers/pult-projects');
const {
  PARAMS, PNG_BYTES, QUOTE, UNITS, addLeadMagnetFor, addVideoWithOffer, goodPage, publishCheckedRevision,
} = require('./helpers/lead-magnet-fixtures');

let session = null;
let calls;
let projectsDir;
const cleanups = [];
const registrar = { after: (fn) => cleanups.push(fn) };

function fakeCapture(command, args) {
  if (command === 'ffprobe') {
    return { stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 1080, height: 1920, r_frame_rate: '25/1' }], format: { duration: '60' } }) };
  }
  fs.writeFileSync(args.at(-1), args.at(-1).endsWith('.png') ? PNG_BYTES : 'jpg');
  return { stdout: '' };
}

// Каждый тест получает свежую projects/ с роликом «Сайт за вечер» (preview ждёт автора,
// в сценарии – обещание «ГАЙД») и при необходимости – свои добавки.
async function startWith(extra = () => ({})) {
  ({ projectsDir } = makePultRoot(registrar));
  addVideoWithOffer(projectsDir, { folder: 'clip', name: 'Сайт за вечер' });
  const context = extra(projectsDir);
  calls = { reveal: [] };
  session = await startPultServer({
    projectsDir,
    idleMs: 0,
    env: {},
    captureImpl: fakeCapture,
    revealImpl: async (target) => { calls.reveal.push(target); },
    openWindowImpl: async () => {},
  });
  return context;
}

test.afterEach(async () => {
  if (session) await session.close();
  session = null;
  while (cleanups.length) cleanups.pop()();
});

function approvedIn(dir, folder) {
  const id = addLeadMagnetFor(dir, folder);
  const { n, pageSha256 } = publishCheckedRevision(dir, id);
  approveLeadMagnet(dir, id, { revision: n, expectedPageSha256: pageSha256, confirmViewed: true });
  return id;
}

function withLibrary(dir) {
  addVideoWithOffer(dir, { folder: 'other', name: 'Другой ролик' });
  return { libraryId: approvedIn(dir, 'other') };
}

async function openClip(page) {
  await page.goto(session.url);
  await page.locator('.card', { hasText: 'Сайт за вечер' }).click();
  await expect(page.locator('[data-view="detail"]')).toBeVisible();
}

test('a promise puts a tag on the card without moving it to another section', async ({ page }) => {
  await startWith();
  await page.goto(session.url);
  const card = page.locator('[data-section="waiting"] .card', { hasText: 'Сайт за вечер' });
  await expect(card.locator('[data-lm-tag]')).toHaveText('🎁 Лид-магнит?');
});

test('the offer banner quotes the promise and suggests the approved one with the same word', async ({ page }) => {
  await startWith(withLibrary);
  await openClip(page);
  const banner = page.locator('[data-lm-offer="ГАЙД"]');
  await expect(banner).toContainText(QUOTE);
  await expect(banner).toContainText('уже есть готовый');
  await expect(page.locator('[data-variant-status]')).toHaveText('Ждёт меня');
});

test('«Нет» hides the question and «🎁 Лид-магнит» brings it back', async ({ page }) => {
  await startWith();
  await openClip(page);
  await page.locator('[data-lm-offer] button', { hasText: 'Нет' }).click();
  await expect(page.locator('[data-lm-offer]')).toHaveCount(0);
  await page.locator('.actions button', { hasText: '🎁 Лид-магнит' }).click();
  await expect(page.locator('[data-lm-offer="ГАЙД"]')).toBeVisible();
});

test('«Уже есть готовый» links the approved lead magnet in one click', async ({ page }) => {
  const { libraryId } = await startWith(withLibrary);
  await openClip(page);
  await page.locator('[data-lm-offer] button', { hasText: 'Уже есть готовый' }).click();
  const pick = page.locator('[data-lm-picker] .lm-pick').first();
  await expect(pick).toHaveClass(/lm-pick--match/);
  await pick.click();
  await expect(page.locator('[data-lm-offer]')).toHaveCount(0);
  expect(library.readLeadMagnet(projectsDir, libraryId).videos).toEqual(['other', 'clip']);
});

test('the wizard needs the promise checkbox and sends parameters with an uploaded reference', async ({ page }) => {
  await startWith();
  await openClip(page);
  await page.locator('[data-lm-offer] button', { hasText: 'Разработать новый' }).click();
  const wizard = page.locator('[data-lm-wizard]');
  await expect(wizard).toBeVisible();
  await expect(wizard.locator('[data-lm-code-word]')).toHaveValue('ГАЙД');
  const send = wizard.locator('[data-lm-send]');
  await expect(send).toBeDisabled();
  await wizard.locator('[data-lm-promise]').check();
  await expect(send).toBeEnabled();
  await expect(wizard.locator('[data-lm-reference]')).toBeHidden();
  await wizard.locator('.lm-choice', { hasText: 'По референсу' }).click();
  await expect(wizard.locator('[data-lm-reference]')).toBeVisible();
  await expect(send).toBeDisabled();
  await wizard.locator('[data-lm-file]').setInputFiles({ name: 'ref.png', mimeType: 'image/png', buffer: PNG_BYTES });
  await expect(wizard.locator('[data-lm-chips]')).toContainText('ref.png');
  await expect(send).toBeEnabled();
  await wizard.locator('[data-lm-wishes]').fill('Добавь блок «частые ошибки»');
  await send.click();
  await expect(wizard).toHaveCount(0);
  const create = readDecisions(path.join(projectsDir, 'clip')).find((decision) => decision.type === 'create');
  expect(create.params.design.mode).toBe('reference');
  expect(create.params.design.references[0].path).toMatch(/^pult\/lead-magnet-refs\/[a-f0-9]{64}\.png$/);
  expect(create.params.wishes).toBe('Добавь блок «частые ошибки»');
  expect(create.params.promiseConfirmed).toBe(true);
});

test('the wizard send action stays in the viewport at 700px height', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await startWith();
  await openClip(page);
  await page.locator('[data-lm-offer] button', { hasText: 'Разработать новый' }).click();
  const wizard = page.locator('[data-lm-wizard]');
  await expect(wizard).toBeVisible();
  await expect(wizard.locator('[data-lm-send]')).toBeInViewport();
});

test('a broken upload is explained inside the wizard', async ({ page }) => {
  await startWith();
  await openClip(page);
  await page.locator('[data-lm-offer] button', { hasText: 'Разработать новый' }).click();
  const wizard = page.locator('[data-lm-wizard]');
  await wizard.locator('.lm-choice', { hasText: 'По референсу' }).click();
  await wizard.locator('[data-lm-file]').setInputFiles({ name: 'virus.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ not an image') });
  await expect(wizard.locator('[data-lm-wizard-error]')).toContainText('не поддерживается');
});

test('the wizard waits for every selected reference before sending', async ({ page }) => {
  await startWith();
  await openClip(page);
  await page.locator('[data-lm-offer] button', { hasText: 'Разработать новый' }).click();
  const wizard = page.locator('[data-lm-wizard]');
  await wizard.locator('[data-lm-promise]').check();
  await wizard.locator('.lm-choice', { hasText: 'По референсу' }).click();
  const file = { name: 'ref.png', mimeType: 'image/png', buffer: PNG_BYTES };
  await wizard.locator('[data-lm-file]').setInputFiles(file);
  await expect(wizard.locator('[data-lm-chips]')).toContainText('ref.png');
  let release;
  let requested;
  const pending = new Promise((resolve) => { requested = resolve; });
  await page.route('**/api/lead-magnet/reference?**', async (route) => {
    requested();
    await new Promise((resolve) => { release = resolve; });
    await route.continue();
  });
  await wizard.locator('[data-lm-file]').setInputFiles({ ...file, name: 'second.png' });
  await pending;
  await expect(wizard.locator('[data-lm-send]')).toBeDisabled();
  release();
  await expect(wizard.locator('[data-lm-chips]')).toContainText('second.png');
  await expect(wizard.locator('[data-lm-send]')).toBeEnabled();
});

test('editing while a create decision is pending cannot send it twice', async ({ page }) => {
  await startWith();
  await openClip(page);
  await page.locator('[data-lm-offer] button', { hasText: 'Разработать новый' }).click();
  const wizard = page.locator('[data-lm-wizard]');
  await wizard.locator('[data-lm-promise]').check();
  let posts = 0;
  let release;
  let requested;
  const pending = new Promise((resolve) => { requested = resolve; });
  await page.route('**/api/lead-magnet/decision', async (route) => {
    posts += 1;
    requested();
    await new Promise((resolve) => { release = resolve; });
    await route.continue();
  });
  await wizard.locator('[data-lm-send]').click();
  await pending;
  await wizard.locator('[data-lm-wishes]').fill('Проверить текст');
  await expect(wizard.locator('[data-lm-send]')).toBeDisabled();
  expect(posts).toBe(1);
  release();
  await expect(wizard).toHaveCount(0);
  expect(readDecisions(path.join(projectsDir, 'clip')).filter((item) => item.type === 'create')).toHaveLength(1);
});

test('pending uploads reserve a reference slot and earlier upload errors remain visible', async ({ page }) => {
  await startWith();
  await openClip(page);
  await page.locator('[data-lm-offer] button', { hasText: 'Разработать новый' }).click();
  const wizard = page.locator('[data-lm-wizard]');
  await wizard.locator('.lm-choice', { hasText: 'По референсу' }).click();
  const url = wizard.getByRole('textbox', { name: 'Ссылка на референс' });
  const addUrl = wizard.getByRole('button', { name: 'Добавить ссылку' });
  for (let n = 0; n < 4; n += 1) {
    await url.fill(`https://example.com/${n}`);
    await addUrl.click();
  }
  let release;
  let requested;
  const pending = new Promise((resolve) => { requested = resolve; });
  await page.route('**/api/lead-magnet/reference?**', async (route) => {
    requested();
    await new Promise((resolve) => { release = resolve; });
    await route.continue();
  });
  await wizard.locator('[data-lm-file]').setInputFiles({ name: 'fifth.png', mimeType: 'image/png', buffer: PNG_BYTES });
  await pending;
  await url.fill('https://example.com/sixth');
  await addUrl.click();
  release();
  await expect(wizard.locator('[data-lm-chips] li')).toHaveCount(5);
  await expect(wizard.locator('[data-lm-wizard-error]')).toContainText('до 5');
});

test('a later successful upload does not erase an earlier error', async ({ page }) => {
  await startWith();
  await openClip(page);
  await page.locator('[data-lm-offer] button', { hasText: 'Разработать новый' }).click();
  const wizard = page.locator('[data-lm-wizard]');
  await wizard.locator('.lm-choice', { hasText: 'По референсу' }).click();
  await wizard.locator('[data-lm-file]').setInputFiles({ name: 'virus.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ not an image') });
  await expect(wizard.locator('[data-lm-wizard-error]')).toContainText('virus.exe');
  await wizard.locator('[data-lm-file]').setInputFiles({ name: 'ref.png', mimeType: 'image/png', buffer: PNG_BYTES });
  await expect(wizard.locator('[data-lm-chips]')).toContainText('ref.png');
  await expect(wizard.locator('[data-lm-wizard-error]')).toContainText('virus.exe');
});

function withDraft(dir, options = {}) {
  const id = addLeadMagnetFor(dir, 'clip');
  publishCheckedRevision(dir, id, options);
  return { id };
}

async function openLeadTab(page) {
  await openClip(page);
  await page.locator('[data-detail-tabs] button', { hasText: 'Лид-магнит' }).click();
}

test('copy buttons of a scaffolded page work inside the sandbox', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await startWith((dir) => {
    const id = addLeadMagnetFor(dir, 'clip');
    const html = scaffoldPage(library.readLeadMagnet(dir, id), resolveBrand({ env: {} }))
      .replace(/ data-lm-todo/g, '')
      .replace('Промпт или команда', 'Сделай мне сайт за вечер');
    publishCheckedRevision(dir, id, { page: html });
    return { id };
  });
  await openLeadTab(page);
  const frame = page.frameLocator('[data-lm-frame]');
  await frame.locator('[data-lm-copy]').first().click();
  await expect(frame.locator('[data-lm-copy]').first()).toHaveText('Скопировано ✓');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Сделай мне сайт за вечер');
  await frame.locator('[data-lm-step="step-1"]').check();
  await expect(frame.locator('[data-lm-step="step-1"]')).toBeChecked();
});

test('a changed promise shows both quotes and «Оставить как есть» settles it', async ({ page }) => {
  await startWith((dir) => {
    const id = approvedIn(dir, 'clip');
    const clipDir = path.join(dir, 'clip');
    fs.writeFileSync(path.join(clipDir, 'script.txt'), 'Финал. и я пришлю пошаговую инструкцию и семь промптов.');
    addOffer(clipDir, {
      codeWord: 'ГАЙД', kind: 'comment-keyword', quote: 'и я пришлю пошаговую инструкцию и семь промптов',
      units: UNITS, sourceKind: 'script', scriptPath: 'script.txt',
    });
    return { id };
  });
  await openLeadTab(page);
  const warning = page.locator('[data-lm-promise-changed]');
  await expect(warning).toContainText(`Было: «${QUOTE}»`);
  await expect(warning).toContainText('Стало: «и я пришлю пошаговую инструкцию и семь промптов»');
  await warning.locator('button', { hasText: 'Оставить как есть' }).click();
  await expect(page.locator('[data-lm-status]')).toHaveText('Лид-магнит утверждён');
  await expect(page.locator('[data-lm-promise-changed]')).toHaveCount(0);
});

test('a missing source offer keeps the old promise and offers only Keep', async ({ page }) => {
  await startWith((dir) => {
    approvedIn(dir, 'clip');
    fs.writeFileSync(path.join(dir, 'clip', 'lead-magnet', 'offers.json'), JSON.stringify({ version: 1, offers: [] }));
  });
  await openLeadTab(page);
  const warning = page.locator('[data-lm-promise-changed]');
  await expect(warning).toContainText(`Было: «${QUOTE}»`);
  await expect(warning).toContainText('Стало: обещания в ролике больше нет');
  await expect(warning.getByRole('button', { name: 'Обновить под новое' })).toBeDisabled();
  await expect(warning).toContainText('Сначала в ролике должно появиться новое обещание');
  await warning.getByRole('button', { name: 'Оставить как есть' }).click();
  await expect(page.locator('[data-lm-promise-changed]')).toHaveCount(0);
  await expect(page.locator('[data-lm-status]')).toHaveText('Лид-магнит утверждён');
  expect(readDecisions(path.join(projectsDir, 'clip')).at(-1).offerId).toBeNull();
});

test('a linked video shows its source promise and writes the decision to the source', async ({ page }) => {
  await startWith((dir) => {
    addVideoWithOffer(dir, { folder: 'source', name: 'Ролик-источник' });
    const id = approvedIn(dir, 'source');
    library.linkVideo(dir, id, { folder: 'clip', codeWord: 'ГАЙД' });
    const source = path.join(dir, 'source');
    fs.writeFileSync(path.join(source, 'script.txt'), 'Финал. и я пришлю пошаговую инструкцию и семь промптов.');
    addOffer(source, { codeWord: 'ГАЙД', kind: 'comment-keyword', quote: 'и я пришлю пошаговую инструкцию и семь промптов',
      units: UNITS, sourceKind: 'script', scriptPath: 'script.txt' });
  });
  await openLeadTab(page);
  const warning = page.locator('[data-lm-promise-changed]');
  await expect(warning).toContainText('Обещание из ролика „source“');
  await expect(warning).toContainText('Стало: «и я пришлю пошаговую инструкцию и семь промптов»');
  await warning.getByRole('button', { name: 'Оставить как есть' }).click();
  await expect(warning).toHaveCount(0);
  expect(readDecisions(path.join(projectsDir, 'source')).at(-1).type).toBe('promise-keep');
  expect(fs.existsSync(path.join(projectsDir, 'clip', 'pult', 'lead-magnet.json'))).toBe(false);
});

test('a linked video settles a promise from a legacy source variant key', async ({ page }) => {
  await startWith((dir) => {
    addVideoWithOffer(dir, { folder: 'source' });
    const id = approvedIn(dir, 'source');
    library.linkVideo(dir, id, { folder: 'clip', codeWord: 'ГАЙД' });
    const source = path.join(dir, 'source');
    fs.writeFileSync(path.join(source, 'script.txt'), 'Финал. и я пришлю пошаговую инструкцию и семь промптов.');
    addOffer(source, { codeWord: 'ГАЙД', kind: 'comment-keyword', quote: 'и я пришлю пошаговую инструкцию и семь промптов',
      units: UNITS, sourceKind: 'script', scriptPath: 'script.txt' });
    fs.renameSync(path.join(source, 'project.json'), path.join(source, 'project.hidden'));
    addLegacyFolder(dir, 'source', { files: { 'out/old.mp4': 'video' }, card: {
      version: 1, title: 'Архивный источник',
      legacy: { status: 'ready', variants: [{ label: 'Первый', video: 'out/old.mp4', final: true }] },
    } });
  });
  await openLeadTab(page);
  const warning = page.locator('[data-lm-promise-changed]');
  await expect(warning).toContainText('Стало: «и я пришлю пошаговую инструкцию и семь промптов»');
  await warning.getByRole('button', { name: 'Оставить как есть' }).click();
  await expect(warning).toHaveCount(0);
  expect(readDecisions(path.join(projectsDir, 'source')).at(-1).type).toBe('promise-keep');
});

test('a legacy source uses its own variant key to settle its promise', async ({ page }) => {
  await startWith((dir) => {
    addVideoWithOffer(dir, { folder: 'source' });
    approvedIn(dir, 'source');
    const source = path.join(dir, 'source');
    fs.writeFileSync(path.join(source, 'script.txt'), 'Финал. и я пришлю пошаговую инструкцию и семь промптов.');
    addOffer(source, { codeWord: 'ГАЙД', kind: 'comment-keyword', quote: 'и я пришлю пошаговую инструкцию и семь промптов',
      units: UNITS, sourceKind: 'script', scriptPath: 'script.txt' });
    fs.renameSync(path.join(source, 'project.json'), path.join(source, 'project.hidden'));
    addLegacyFolder(dir, 'source', { files: { 'out/old.mp4': 'video' }, card: {
      version: 1, title: 'Архивный источник',
      legacy: { status: 'ready', variants: [{ label: 'Первый', video: 'out/old.mp4', final: true }] },
    } });
  });
  await page.goto(session.url);
  await page.locator('.card', { hasText: 'Архивный источник' }).click();
  await page.locator('[data-detail-tabs] button', { hasText: 'Лид-магнит' }).click();
  const warning = page.locator('[data-lm-promise-changed]');
  await expect(warning).toContainText('Стало: «и я пришлю пошаговую инструкцию и семь промптов»');
  await warning.getByRole('button', { name: 'Оставить как есть' }).click();
  await expect(warning).toHaveCount(0);
  expect(readDecisions(path.join(projectsDir, 'source')).at(-1).type).toBe('promise-keep');
});

test('an unavailable source explains the issue and offers no decision buttons', async ({ page }) => {
  await startWith((dir) => {
    addVideoWithOffer(dir, { folder: 'source' });
    const id = approvedIn(dir, 'source');
    library.linkVideo(dir, id, { folder: 'clip', codeWord: 'ГАЙД' });
    fs.renameSync(path.join(dir, 'source'), path.join(dir, 'source-hidden'));
  });
  await openLeadTab(page);
  const warning = page.locator('[data-lm-promise-changed]');
  await expect(warning).toContainText('ролик-источник не найден');
  await expect(warning.locator('button')).toHaveCount(0);
});

test('the lead tab shows the sandboxed page on desktop and phone width', async ({ page }) => {
  await startWith(withDraft);
  await openLeadTab(page);
  const frame = page.frameLocator('[data-lm-frame]');
  await expect(frame.locator('h1')).toHaveText('Сайт без кода');
  await expect(page.locator('[data-lm-frame]')).toHaveAttribute('data-view', 'desktop');
  await page.locator('[data-lm-view="phone"]').click();
  await expect(page.locator('[data-lm-frame]')).toHaveAttribute('data-view', 'phone');
  expect(await page.locator('[data-lm-frame]').evaluate((node) => node.style.width)).toBe('390px');
  await expect(page.locator('[data-lm-status]')).toHaveText('Лид-магнит: посмотрите и утвердите');
  await expect(page.locator('[data-lm-text="dm"]')).toContainText('6 / 1000');
});

test('a click on a block in review mode becomes a comment with a snapshot', async ({ page }) => {
  await startWith(withDraft);
  await openLeadTab(page);
  await page.locator('[data-lm-view="phone"]').click();
  await page.locator('[data-lm-review-mode]').check();
  await page.frameLocator('[data-lm-frame]').locator('[data-lm-block="steps"] h2').click();
  await expect(page.locator('[data-lm-target]')).toHaveText('К блоку «steps» · телефон');
  await page.locator('[data-lm-comment-text]').fill('Промпт не помещается в строку');
  await page.locator('.lm-comments button', { hasText: 'Добавить правку' }).click();
  const item = page.locator('[data-lm-comments] .comment').first();
  await expect(item).toContainText('Промпт не помещается в строку');
  await expect(item).toContainText('блок «steps» · телефон');
  await expect(item.locator('img.comment__frame')).toBeVisible();
  await expect(page.locator('[data-lm-status]')).toHaveText('Лид-магнит: ждёт агента, правок: 1');
});

test('a text gets its own comment, and a waiting comment can be deleted', async ({ page }) => {
  await startWith(withDraft);
  await openLeadTab(page);
  await page.locator('[data-lm-text="telegram"] button', { hasText: 'Правка к тексту' }).click();
  await expect(page.locator('[data-lm-target]')).toHaveText('К тексту «Пост в Telegram»');
  await page.locator('[data-lm-comment-text]').fill('Короче на треть');
  await page.locator('.lm-comments button', { hasText: 'Добавить правку' }).click();
  await expect(page.locator('[data-lm-comments] .comment')).toHaveCount(1);
  await page.locator('[data-lm-comments] .comment button', { hasText: 'Удалить' }).click();
  await expect(page.locator('[data-lm-comments] .comment')).toHaveCount(0);
});

test('editing during a pending comment request cannot submit it twice, and failure allows retry', async ({ page }) => {
  await startWith(withDraft);
  await openLeadTab(page);
  await page.locator('[data-lm-text="telegram"] button', { hasText: 'Правка к тексту' }).click();
  const field = page.locator('[data-lm-comment-text]');
  const save = page.locator('.lm-comments button', { hasText: 'Добавить правку' });
  await field.fill('Первая формулировка');
  let release;
  let requested;
  const pending = new Promise((resolve) => { requested = resolve; });
  let posts = 0;
  await page.route('**/api/lead-magnet/comment', async (route) => {
    posts += 1;
    if (posts === 1) {
      requested();
      await new Promise((resolve) => { release = resolve; });
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Временная ошибка' }) });
      return;
    }
    await route.continue();
  });
  await save.click();
  await pending;
  await field.fill('Новая формулировка');
  const disabledDuringRequest = await save.isDisabled();
  if (!disabledDuringRequest) await save.click();
  release();
  await expect(page.locator('[data-notice]')).toContainText('Временная ошибка');
  expect(disabledDuringRequest).toBe(true);
  expect(posts).toBe(1);
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.locator('[data-lm-comments] .comment')).toHaveCount(1);
  await expect(page.locator('[data-lm-comments] .comment')).toContainText('Новая формулировка');
  expect(posts).toBe(2);
});

test('only a valid block message from the active sandboxed frame selects a target', async ({ page }) => {
  await startWith(withDraft);
  await openLeadTab(page);
  const target = page.locator('[data-lm-target]');
  const valid = { type: 'lm-block', blockId: 'steps', rect: { x: 0, y: 10, w: 300, h: 200 } };
  await page.evaluate((data) => window.postMessage(data, '*'), valid);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  await expect(target).toContainText('Включите «Режим правок»');
  await page.evaluate((data) => {
    const other = document.createElement('iframe');
    other.srcdoc = `<script>parent.postMessage(${JSON.stringify(data)}, '*')</script>`;
    document.body.append(other);
  }, valid);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  await expect(target).toContainText('Включите «Режим правок»');
  await page.frameLocator('[data-lm-frame]').locator('body').evaluate((_, data) => {
    parent.postMessage({ ...data, blockId: '../bad' }, '*');
    parent.postMessage({ ...data, rect: { x: 0, y: -1, w: 300, h: 200 } }, '*');
    parent.postMessage({ ...data, rect: { x: 0, y: 0, w: Infinity, h: 200 } }, '*');
  }, valid);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  await expect(target).toContainText('Включите «Режим правок»');
  await page.frameLocator('[data-lm-frame]').locator('body').evaluate((_, data) => parent.postMessage(data, '*'), valid);
  await expect(target).toHaveText('К блоку «steps» · компьютер');
  await expect(page.locator('[data-lm-frame]')).toHaveAttribute('sandbox', 'allow-scripts');
});

test('outside review mode a click on the page does not start a comment, links are announced', async ({ page }) => {
  const link = '<p><a data-lm-link href="https://example.com/practicum">Практикум</a></p>';
  await startWith((dir) => withDraft(dir, { page: goodPage({ extra: link }) }));
  await openLeadTab(page);
  await page.frameLocator('[data-lm-frame]').locator('[data-lm-block="steps"] h2').click();
  await expect(page.locator('[data-lm-target]')).toContainText('Включите «Режим правок»');
  await page.frameLocator('[data-lm-frame]').locator('[data-lm-link]').click();
  await expect(page.locator('[data-notice]')).toContainText('https://example.com/practicum');
  await expect(page.frameLocator('[data-lm-frame]').locator('h1')).toHaveText('Сайт без кода');
});

test('approval needs the checkbox and then shows the files', async ({ page }) => {
  await startWith(withDraft);
  await openLeadTab(page);
  const approveBox = page.locator('[data-lm-approve]');
  const approve = approveBox.locator('button', { hasText: 'Утверждаю лид-магнит' });
  await expect(approve).toBeDisabled();
  await approveBox.locator('input[type="checkbox"]').check();
  await approve.click();
  await expect(page.locator('[data-lm-status]')).toHaveText('Лид-магнит утверждён');
  const pdf = page.locator('[data-lm-files] li', { hasText: 'PDF' });
  await pdf.locator('button').click();
  await expect.poll(() => calls.reveal.at(-1) || '').toMatch(/v01[\\/]page\.pdf$/);
});

test('a new lead revision appears while the waiting card summary stays the same', async ({ page }) => {
  const { id } = await startWith(withDraft);
  await openLeadTab(page);
  await expect(page.frameLocator('[data-lm-frame]').locator('h1')).toHaveText('Сайт без кода');
  await expect(page.locator('[data-lm-status]')).toHaveText('Лид-магнит: посмотрите и утвердите');
  publishCheckedRevision(projectsDir, id, { page: goodPage({ title: 'Новая версия' }) });
  await page.evaluate(() => refresh({ keepDetail: true }));
  await expect(page.frameLocator('[data-lm-frame]').locator('h1')).toHaveText('Новая версия');
  await expect(page.locator('.lm-viewer')).toContainText('Версия v02');
  await expect(page.locator('[data-lm-status]')).toHaveText('Лид-магнит: посмотрите и утвердите');
});

test('an older initial response cannot replace a newer revision in the same open tab', async ({ page }) => {
  const { id } = await startWith(withDraft);
  await openClip(page);
  let releaseOld;
  let oldFetched;
  const oldPending = new Promise((resolve) => { oldFetched = resolve; });
  let requests = 0;
  await page.route('**/api/lead-magnet?**', async (route) => {
    requests += 1;
    if (requests === 1) {
      const oldResponse = await route.fetch();
      oldFetched();
      await new Promise((resolve) => { releaseOld = resolve; });
      await route.fulfill({ response: oldResponse });
      return;
    }
    await route.continue();
  });
  await page.locator('[data-detail-tabs] button', { hasText: 'Лид-магнит' }).click();
  await oldPending;
  publishCheckedRevision(projectsDir, id, { page: goodPage({ title: 'Новая версия' }) });
  await page.evaluate(() => refresh({ keepDetail: true }));
  await expect(page.frameLocator('[data-lm-frame]').locator('h1')).toHaveText('Новая версия');
  await expect(page.locator('.lm-viewer')).toContainText('Версия v02');
  const oldResponse = page.waitForResponse('**/api/lead-magnet?**');
  releaseOld();
  await oldResponse;
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  await expect(page.frameLocator('[data-lm-frame]').locator('h1')).toHaveText('Новая версия');
  await expect(page.locator('.lm-viewer')).toContainText('Версия v02');
});

test('a poll renders the chosen magnet when it overtakes the selector request', async ({ page }) => {
  await startWith((dir) => {
    withDraft(dir);
    const other = library.createLeadMagnet(dir, {
      codeWord: 'ЧЕКЛИСТ', title: 'Другой сайт',
      promise: { quote: QUOTE, startSec: null, endSec: null, sourceFolder: 'clip' },
      units: UNITS, params: PARAMS, videoFolder: 'clip',
    });
    publishCheckedRevision(dir, other.id, { page: goodPage({ title: 'Другой сайт' }) });
  });
  await openLeadTab(page);
  await expect(page.locator('.lm-tab .variant-tab')).toHaveCount(2);
  const otherPill = page.locator('.lm-tab .variant-tab[aria-pressed="false"]');
  const expectedTitle = (await otherPill.textContent()).includes('ЧЕКЛИСТ') ? 'Другой сайт' : 'Сайт без кода';
  let releaseSelector;
  let selectorRequested;
  const pendingSelector = new Promise((resolve) => { selectorRequested = resolve; });
  let requests = 0;
  await page.route('**/api/lead-magnet?**', async (route) => {
    requests += 1;
    if (requests === 1) {
      selectorRequested();
      await new Promise((resolve) => { releaseSelector = resolve; });
    }
    await route.continue();
  });
  await otherPill.click();
  await pendingSelector;
  await expect(page.locator('.lm-tab')).toContainText('Загружаю лид-магнит…');
  const pollResponse = page.waitForResponse('**/api/lead-magnet?**');
  await page.evaluate(() => refresh({ keepDetail: true }));
  await pollResponse;
  await expect(page.frameLocator('[data-lm-frame]').locator('h1')).toHaveText(expectedTitle);
  const selectorResponse = page.waitForResponse('**/api/lead-magnet?**');
  releaseSelector();
  await selectorResponse;
  await expect(page.frameLocator('[data-lm-frame]').locator('h1')).toHaveText(expectedTitle);
});

test('a late lead state response cannot update a tab that was closed', async ({ page }) => {
  const { id } = await startWith(withDraft);
  await openLeadTab(page);
  await expect(page.frameLocator('[data-lm-frame]').locator('h1')).toHaveText('Сайт без кода');
  publishCheckedRevision(projectsDir, id, { page: goodPage({ title: 'Новая версия' }) });
  let release;
  let requested;
  const pending = new Promise((resolve) => { requested = resolve; });
  await page.route('**/api/lead-magnet?**', async (route) => {
    requested();
    await new Promise((resolve) => { release = resolve; });
    await route.continue();
  });
  await page.evaluate(() => refresh({ keepDetail: true }));
  await pending;
  await page.locator('[data-detail-tabs] button', { hasText: 'Видео' }).click();
  const response = page.waitForResponse('**/api/lead-magnet?**');
  release();
  await response;
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  await expect(page.locator('.lm-tab')).toHaveCount(0);
  await expect(page.locator('[data-notice]')).not.toContainText('Лид-магнит обновился');
});

test('clicking the active video tab keeps an unfinished video comment', async ({ page }) => {
  await startWith(withDraft);
  await openClip(page);
  const draft = page.locator('[data-comment-text]');
  await draft.fill('Не потерять правку');
  await page.locator('[data-detail-tabs] button', { hasText: 'Видео' }).click();
  await expect(draft).toHaveValue('Не потерять правку');
});

test('an unfinished video comment survives a trip to the lead tab', async ({ page }) => {
  await startWith(withDraft);
  await openClip(page);
  await page.locator('[data-comment-text]').fill('Не потерять правку');
  await page.locator('[data-detail-tabs] button', { hasText: 'Лид-магнит' }).click();
  await expect(page.locator('[data-lm-status]')).toBeVisible();
  await page.locator('[data-detail-tabs] button', { hasText: 'Видео' }).click();
  await expect(page.locator('[data-comment-text]')).toHaveValue('Не потерять правку');
});

test('approval stays locked if its checkbox changes during the pending request', async ({ page }) => {
  await startWith(withDraft);
  await openLeadTab(page);
  const box = page.locator('[data-lm-approve]');
  const viewed = box.locator('input[type="checkbox"]');
  const approve = box.locator('button', { hasText: 'Утверждаю лид-магнит' });
  await viewed.check();
  let posts = 0;
  let release;
  let requested;
  const pending = new Promise((resolve) => { requested = resolve; });
  await page.route('**/api/lead-magnet/approve', async (route) => {
    posts += 1;
    requested();
    await new Promise((resolve) => { release = resolve; });
    await route.continue();
  });
  await approve.click();
  await pending;
  await viewed.uncheck();
  await viewed.check();
  await expect(approve).toBeDisabled();
  expect(posts).toBe(1);
  release();
  await expect(page.locator('[data-lm-status]')).toHaveText('Лид-магнит утверждён');
});

test('a red check shows its items and offers no approval', async ({ page }) => {
  await startWith((dir) => withDraft(dir, { ok: false }));
  await openLeadTab(page);
  await expect(page.locator('[data-lm-checks] [data-ok="false"]').first()).toBeVisible();
  await expect(page.locator('[data-lm-approve] button', { hasText: 'Утверждаю' })).toHaveCount(0);
});

test('the sandboxed page reaches neither the pult, nor its parent, nor storage', async ({ page }) => {
  const probe = '<p id="probe">…</p><script>(async () => { const out = [];'
    + "try { await fetch('/api/cards'); out.push('fetch-open'); } catch (e) { out.push('fetch-blocked'); }"
    + "try { void parent.document.title; out.push('parent-open'); } catch (e) { out.push('parent-blocked'); }"
    + "try { void localStorage.length; out.push('storage-open'); } catch (e) { out.push('storage-blocked'); }"
    + "document.getElementById('probe').textContent = out.join(' '); })();</script>";
  await startWith((dir) => withDraft(dir, { page: goodPage({ extra: probe }) }));
  await openLeadTab(page);
  await expect(page.frameLocator('[data-lm-frame]').locator('#probe')).toHaveText('fetch-blocked parent-blocked storage-blocked');
});

test('the promise quote in the wizard can seek the current video', async ({ page }) => {
  await page.addInitScript(() => { HTMLMediaElement.prototype.play = () => Promise.resolve(); });
  await startWith();
  const offersFile = path.join(projectsDir, 'clip', 'lead-magnet', 'offers.json');
  const offers = JSON.parse(fs.readFileSync(offersFile, 'utf8'));
  offers.offers[0].startSec = 60;
  offers.offers[0].endSec = 63.9;
  fs.writeFileSync(offersFile, JSON.stringify(offers));
  await openClip(page);
  await page.locator('[data-lm-offer] button', { hasText: 'Разработать новый' }).click();
  const wizard = page.locator('[data-lm-wizard]');
  await expect(wizard).toContainText('1:00');
  await wizard.getByRole('button', { name: '▶ послушать' }).click();
  await expect(page.locator('[data-player]')).toHaveJSProperty('currentTime', 60);
});

test('wizard playback failure is explained inside the dialog', async ({ page }) => {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = () => Promise.reject(new Error('NotAllowedError: browser internals'));
  });
  await startWith();
  const offersFile = path.join(projectsDir, 'clip', 'lead-magnet', 'offers.json');
  const offers = JSON.parse(fs.readFileSync(offersFile, 'utf8'));
  offers.offers[0].startSec = 60;
  offers.offers[0].endSec = 63.9;
  fs.writeFileSync(offersFile, JSON.stringify(offers));
  await openClip(page);
  await page.locator('[data-lm-offer] button', { hasText: 'Разработать новый' }).click();
  const wizard = page.locator('[data-lm-wizard]');
  await wizard.getByRole('button', { name: '▶ послушать' }).click();
  await expect(wizard.locator('[data-lm-wizard-error]')).toContainText('Не удалось воспроизвести видео');
  await expect(wizard.locator('[data-lm-wizard-error]')).not.toContainText('NotAllowedError');
});

test('the wizard sends the chosen closing call and prefills the last custom link', async ({ page }) => {
  await startWith((dir) => {
    const id = addLeadMagnetFor(dir, 'clip');
    const passport = library.readLeadMagnet(dir, id);
    library.savePassport(dir, { ...passport, params: { ...passport.params, cta: { mode: 'link', title: 'Глубже?', label: 'Практикум', url: 'https://example.com/p' } } }, () => new Date());
    return { id };
  });
  await openClip(page);
  await page.locator('.actions button', { hasText: '🎁 Лид-магнит' }).click();
  const wizard = page.locator('[data-lm-wizard]');
  await wizard.locator('[data-lm-code-word]').fill('ГАЙД');
  await wizard.locator('.lm-choice', { hasText: 'Своя ссылка' }).click();
  await expect(wizard.locator('[data-lm-cta-url]')).toHaveValue('https://example.com/p');
  await wizard.locator('[data-lm-cta-url]').fill('http://bad');
  await expect(wizard.locator('[data-lm-send]')).toBeDisabled();
  await wizard.locator('[data-lm-cta-url]').fill('https://user:password@example.com');
  await expect(wizard.locator('[data-lm-send]')).toBeDisabled();
  await wizard.locator('[data-lm-cta-url]').fill('https://example.com/new');
  await wizard.locator('[data-lm-send]').click();
  await expect(wizard).toHaveCount(0);
  const create = readDecisions(path.join(projectsDir, 'clip')).find((decision) => decision.type === 'create');
  expect(create.params.cta).toEqual({ mode: 'link', title: 'Глубже?', label: 'Практикум', url: 'https://example.com/new' });
});

for (const mode of ['brand', 'none']) {
  test(`the wizard sends the ${mode} closing call without custom fields`, async ({ page }) => {
    await startWith();
    await openClip(page);
    await page.locator('.actions button', { hasText: '🎁 Лид-магнит' }).click();
    const wizard = page.locator('[data-lm-wizard]');
    await wizard.locator('[data-lm-code-word]').fill('ГАЙД');
    if (mode === 'none') await wizard.locator('.lm-choice', { hasText: 'Без призыва' }).click();
    await expect(wizard.locator('[data-lm-cta-url]')).toBeHidden();
    await wizard.locator('[data-lm-send]').click();
    await expect(wizard).toHaveCount(0);
    const create = readDecisions(path.join(projectsDir, 'clip')).find((decision) => decision.type === 'create');
    expect(create.params.cta).toEqual({ mode, title: '', label: '', url: '' });
  });
}
