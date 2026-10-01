// tests/pult-lead-magnet-ui.spec.js
const fs = require('node:fs');
const path = require('node:path');

const { test, expect } = require('playwright/test');

const { approveLeadMagnet } = require('../scripts/lead-magnet/approve');
const library = require('../scripts/lead-magnet/library');
const { addOffer } = require('../scripts/lead-magnet/offers');
const { readDecisions } = require('../scripts/lead-magnet/requests');
const { startPultServer } = require('../scripts/pult/server');
const { makePultRoot } = require('./helpers/pult-projects');
const {
  PNG_BYTES, QUOTE, UNITS, addLeadMagnetFor, addVideoWithOffer, goodPage, publishCheckedRevision,
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
