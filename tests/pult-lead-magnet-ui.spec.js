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
