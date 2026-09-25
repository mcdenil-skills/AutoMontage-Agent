const fs = require('node:fs');

const { test, expect } = require('playwright/test');

const { startPultServer } = require('../scripts/pult/server');
const { addDraftProject, addLegacyFolder, makePultRoot } = require('./helpers/pult-projects');

let session;
let calls;
let projectsDir;
const cleanups = [];
const registrar = { after: (fn) => cleanups.push(fn) };

function fakeCapture(command, args) {
  if (command === 'ffprobe') {
    return {
      stdout: JSON.stringify({
        streams: [{ codec_type: 'video', width: 1080, height: 1920, r_frame_rate: '25/1' }],
        format: { duration: '118.7' },
      }),
    };
  }
  fs.writeFileSync(args.at(-1), 'jpg');
  return { stdout: '' };
}

// Запускает свежий пульт поверх новой временной projects/ и заменяет им общий session —
// нужен новым тестам (leadKey, NFD-поиск, legacy .mkv), у которых фикстуры отличаются от
// общего набора beforeEach и не должны на него влиять.
async function restartWith(fixtures, captureImpl = fakeCapture) {
  await session.close();
  ({ projectsDir } = makePultRoot(registrar));
  fixtures(projectsDir);
  calls = { reveal: [], windows: [] };
  session = await startPultServer({
    projectsDir,
    idleMs: 0,
    captureImpl,
    revealImpl: async (target) => { calls.reveal.push(target); },
    openWindowImpl: async (url) => { calls.windows.push(url); },
  });
}

test.beforeEach(async () => {
  ({ projectsDir } = makePultRoot(registrar));
  addDraftProject(projectsDir, { folder: 'waiting-clip', name: 'Перфекционизм — тормоз' });
  addDraftProject(projectsDir, { folder: 'ready-clip', name: 'Готовый ролик', approve: true, final: true });
  addLegacyFolder(projectsDir, 'hooks-series', {
    files: { 'out/a.mp4': 'a', 'out/b.mp4': 'b' },
    card: {
      version: 1,
      title: 'Серия хуков',
      legacy: {
        status: 'ready',
        variants: [
          { label: 'Хук 1', video: 'out/a.mp4', final: true },
          { label: 'Хук 2', video: 'out/b.mp4', final: true },
        ],
      },
    },
  });
  addLegacyFolder(projectsDir, 'research', { files: { 'notes.md': '#' } });
  calls = { reveal: [], windows: [] };
  session = await startPultServer({
    projectsDir,
    idleMs: 0,
    captureImpl: fakeCapture,
    revealImpl: async (target) => { calls.reveal.push(target); },
    openWindowImpl: async (url) => { calls.windows.push(url); },
  });
});

test.afterEach(async () => {
  await session.close();
  while (cleanups.length) cleanups.pop()();
});

async function openCard(page, title) {
  await page.goto(session.url);
  await page.locator('.card', { hasText: title }).click();
  await expect(page.locator('[data-view="detail"]')).toBeVisible();
}

test('sections put what waits for the author first', async ({ page }) => {
  await page.goto(session.url);
  await expect(page.locator('[data-section]').first()).toHaveAttribute('data-section', 'waiting');
  await expect(page.locator('[data-section="waiting"]')).toContainText('Перфекционизм — тормоз');
  await expect(page.locator('[data-section="waiting"]')).toContainText('Посмотрите preview и утвердите');
  await expect(page.locator('[data-section="waiting"]')).toContainText('9:16 · 1:59');
  await expect(page.locator('[data-section="ready"]')).toContainText('Готовый ролик');
  await expect(page.locator('[data-section="ready"]')).toContainText('Серия хуков');
  await expect(page.locator('[data-tab="unregistered"]')).toBeVisible();
  await expect(page.locator('[data-count="unregistered"]')).toHaveText('1');
});

test('search narrows the list', async ({ page }) => {
  await page.goto(session.url);
  await page.fill('[data-search]', 'хук');
  await expect(page.locator('.card')).toHaveCount(1);
  await expect(page.locator('.card')).toContainText('Серия хуков');
  await page.fill('[data-search]', 'нет такого');
  await expect(page.locator('.empty')).toHaveText('Ничего не найдено.');
});

test('a card with variants switches between hooks', async ({ page }) => {
  await openCard(page, 'Серия хуков');
  await expect(page.locator('.variant-tab')).toHaveCount(2);
  await page.locator('.variant-tab', { hasText: 'Хук 2' }).click();
  await expect(page.locator('[data-player]')).toHaveAttribute('src', /key=hooks-series%231/);
});

test('an edit is saved at the current second and hands the video to the agent', async ({ page }) => {
  await openCard(page, 'Перфекционизм');
  await page.fill('[data-comment-text]', 'Текст залезает на лицо');
  await page.locator('button', { hasText: 'Добавить правку' }).click();
  await expect(page.locator('[data-comment-list]')).toContainText('Текст залезает на лицо');
  await expect(page.locator('[data-comment-list]')).toContainText('ждёт агента');
  await expect(page.locator('[data-variant-next]')).toHaveText('Ждёт агента: 1 правка');
});

test('approval needs the full-view confirmation', async ({ page }) => {
  await openCard(page, 'Перфекционизм');
  const approve = page.locator('button', { hasText: 'Утверждаю' });
  await expect(approve).toBeDisabled();
  await page.check('[data-viewed]');
  await approve.click();
  await expect(page.locator('[data-notice]')).toContainText('Утверждено');
  await expect(page.locator('[data-variant-next]')).toHaveText('Утверждено — агент собирает финал');
});

test('archive hides a card without deleting it', async ({ page }) => {
  await openCard(page, 'Готовый ролик');
  await page.locator('button', { hasText: 'В архив' }).click();
  await expect(page.locator('[data-section="ready"]')).not.toContainText('Готовый ролик');
  await page.click('[data-tab="archive"]');
  await expect(page.locator('[data-section="archive"]')).toContainText('Готовый ролик');
  expect(fs.existsSync(`${projectsDir}/ready-clip/project.json`)).toBe(true);
});

test('the agent phrase names the video folder and "Показать в папке" goes through the server', async ({ page }) => {
  await openCard(page, 'Перфекционизм');
  await expect(page.locator('[data-agent-phrase]')).toHaveValue(
    'Продолжи ролик «Перфекционизм — тормоз» в projects/waiting-clip: выполни automontage inbox и обработай входящие.',
  );
  await page.locator('button', { hasText: 'Показать в папке' }).click();
  await expect.poll(() => calls.reveal.length).toBe(1);
});

test('no absolute paths or hashes reach the page', async ({ page }) => {
  const bodies = [];
  page.on('response', async (response) => {
    if (response.url().includes('/api/')) bodies.push(await response.text());
  });
  await openCard(page, 'Перфекционизм');
  await expect(page.locator('[data-comment-list]')).toBeVisible();
  const text = bodies.join('\n');
  expect(text).not.toContain(projectsDir);
  expect(text).not.toMatch(/[a-f0-9]{64}/);
});

// --- Task 15, три согласованных изменения поверх плана ---

test('a group card shows the most urgent variant\'s facts and opens on it', async ({ page }) => {
  const group = { id: 'street-report', title: 'Отчёт с улицы' };
  await restartWith((dir) => {
    // Папка готового варианта идёт первой по алфавиту (a-...), а ждущего — второй
    // (b-...): card.variants сохраняет этот порядок, а card.leadKey должен всё равно
    // указывать на вариант, за которым сейчас очередь человека.
    addDraftProject(dir, {
      folder: 'a-ready-report',
      name: 'Отчёт с улицы',
      approve: true,
      final: true,
      card: { version: 1, group, variantLabel: 'Итог' },
    });
    addDraftProject(dir, {
      folder: 'b-waiting-report',
      name: 'Отчёт с улицы',
      card: { version: 1, group, variantLabel: 'Черновик' },
    });
  }, (command, args) => {
    if (command === 'ffprobe') {
      const target = String(args.at(-1));
      const isReadyVariant = target.includes('a-ready-report');
      return {
        stdout: JSON.stringify({
          streams: [{
            codec_type: 'video',
            width: isReadyVariant ? 1920 : 1080,
            height: isReadyVariant ? 1080 : 1920,
            r_frame_rate: '25/1',
          }],
          format: { duration: isReadyVariant ? '30' : '118.7' },
        }),
      };
    }
    fs.writeFileSync(args.at(-1), 'jpg');
    return { stdout: '' };
  });
  await page.goto(session.url);
  const card = page.locator('.card', { hasText: 'Отчёт с улицы' });
  await expect(card).toContainText('9:16 · 1:59');
  await expect(card).not.toContainText('16:9');
  await card.click();
  await expect(page.locator('[data-view="detail"]')).toBeVisible();
  await expect(page.locator('.variant-tab', { hasText: 'Черновик' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.variant-tab', { hasText: 'Итог' })).toHaveAttribute('aria-pressed', 'false');
});

test('search matches an NFC title from an NFD query', async ({ page }) => {
  await restartWith((dir) => {
    addDraftProject(dir, { folder: 'nfd-clip', name: 'Ёлки в лесу' });
  });
  await page.goto(session.url);
  await page.fill('[data-search]', 'Ёлки'.normalize('NFD'));
  await expect(page.locator('.card')).toHaveCount(1);
  await expect(page.locator('.card')).toContainText('Ёлки в лесу');
});

test('a legacy .mkv variant shows the unsupported-format label', async ({ page }) => {
  await restartWith((dir) => {
    addLegacyFolder(dir, 'old-format', {
      files: { 'out/clip.mkv': 'mkv-bytes' },
      card: {
        version: 1,
        title: 'Старый формат',
        legacy: {
          status: 'ready',
          variants: [{ label: 'Единственный', video: 'out/clip.mkv', final: true }],
        },
      },
    });
  });
  await page.goto(session.url);
  await page.locator('.card', { hasText: 'Старый формат' }).click();
  await expect(page.locator('[data-view="detail"]')).toBeVisible();
  await expect(page.locator('.player__label')).toHaveText('Этот формат не проигрывается в пульте — откройте в папке');
  await expect(page.locator('button', { hasText: 'Показать в папке' })).toBeVisible();
});
