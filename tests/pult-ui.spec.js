const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { test, expect } = require('playwright/test');

const { createHash } = require('node:crypto');

const { acceptComment, readComments } = require('../scripts/pult/comments');
const { startPultServer } = require('../scripts/pult/server');
const ws = require('../scripts/project/workspace');
const pw = require('../scripts/project/preview-workspace');
const { addDraftProject, addLegacyFolder, makePultRoot } = require('./helpers/pult-projects');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// Публикует ВТОРОЙ черновик и preview поверх уже утверждённого и отрендеренного проекта:
// ролик возвращается в «Ждёт меня», а рендер v01 остаётся в Истории как прошлая версия —
// нужен тесту A4 (просмотр Истории на карточке, которую всё ещё можно утвердить и править).
// previewBytes — содержимое нового preview: по умолчанию текст, а там, где тесту нужно
// реально перематывать плеер, — настоящее видео.
function addSecondRevision(projectDir, name, previewBytes = 'preview v2') {
  let workspace = ws.createOrOpenProject({ projectDir });
  const brief = {
    version: 1,
    status: 'draft',
    source: workspace.sourcePath,
    theme: 'lesson-neutral',
    title: name,
    output: { aspect: 'horizontal', width: 320, height: 180, fps: 25, durationInFrames: 100 },
    corrections: [],
    scenes: [{ scene: 'fullscreen', start: 0, end: 4, caption: 'СНОВА' }],
  };
  const draft = ws.publishBriefRevision(workspace, { brief, markdown: `# ${name} v2` });
  workspace = ws.createOrOpenProject({ projectDir });
  const plan = pw.planPreview(workspace, {
    briefPath: draft.jsonPath,
    briefSha256: sha256(fs.readFileSync(draft.jsonPath)),
    range: { kind: 'full', fromSec: 0, toSec: 4 },
  });
  const staged = path.join(workspace.dir, 'previews', 'stage-v2.mp4');
  fs.writeFileSync(staged, previewBytes);
  pw.publishCurrentPreview(workspace, plan, staged, {
    width: 160, height: 90, fps: 25, generatedAt: '2026-09-21T10:05:00.000Z',
  });
}

let session;
let calls;
let projectsDir;
const cleanups = [];
const registrar = { after: (fn) => cleanups.push(fn) };

// Настоящий маленький вертикальный JPEG (не 3 байта текста «jpg»): у него есть
// собственные ширина/высота, и только с ними браузер способен воспроизвести баг A1
// (растянутая карточка) и проверить его исправление.
let verticalThumbBytes;
// Настоящий 15-секундный ролик (VP8, как в review-ui.spec.js): его можно перемотать на
// 12-ю секунду и проверить, на какой секунде сохранилась правка.
let playableVideoBytes;

test.beforeAll(() => {
  const tmp = path.join(os.tmpdir(), `pult-ui-thumb-${process.pid}.jpg`);
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=gray:s=180x320', '-frames:v', '1', tmp], { stdio: 'ignore' });
  verticalThumbBytes = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true });
  const clip = path.join(os.tmpdir(), `pult-ui-clip-${process.pid}.webm`);
  execFileSync('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=160x90:r=5:d=15',
    '-c:v', 'libvpx', '-b:v', '30k', '-an', clip,
  ], { stdio: 'ignore' });
  playableVideoBytes = fs.readFileSync(clip);
  fs.rmSync(clip, { force: true });
});

function fakeCapture(command, args) {
  if (command === 'ffprobe') {
    return {
      stdout: JSON.stringify({
        streams: [{ codec_type: 'video', width: 1080, height: 1920, r_frame_rate: '25/1' }],
        format: { duration: '118.7' },
      }),
    };
  }
  fs.writeFileSync(args.at(-1), verticalThumbBytes);
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
  // toBeVisible() смотрит только на разметку — <ul data-comment-list> уже в DOM до того,
  // как ответ /api/comments придёт, поэтому раньше проверка тела ответов могла случиться
  // до его загрузки. Дожидаемся самого GET-запроса правок, чтобы тело точно попало в bodies.
  const commentsLoaded = page.waitForResponse((response) => response.url().includes('/api/comments')
    && response.request().method() === 'GET');
  await page.goto(session.url);
  await page.locator('.card', { hasText: 'Перфекционизм' }).click();
  await expect(page.locator('[data-view="detail"]')).toBeVisible();
  await commentsLoaded;
  await expect(page.locator('[data-comment-list]')).toContainText('Правок пока нет.');
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
  // Мёртвый <video> без источника выглядел рабочим плеером, но ничего не проигрывал —
  // вместо него теперь пустая заглушка, а не элемент [data-player].
  await expect(page.locator('[data-player]')).toHaveCount(0);
  await expect(page.locator('.player--empty')).toBeVisible();
  // Подпись живёт внутри пустой заглушки, а не висит под чёрным прямоугольником.
  await expect(page.locator('.player--empty .player__label')).toHaveText(
    'Этот формат не проигрывается в пульте — откройте в папке',
  );
  await expect(page.locator('button', { hasText: 'Показать в папке' })).toBeVisible();
  await expect(page.locator('.comments')).toContainText(
    'Этот формат не проигрывается в пульте — правку можно описать словами агенту.',
  );
});

// --- Commit A: список читаем, утверждение честное ---

test('a vertical thumbnail is letterboxed and never stretches the card row', async ({ page }) => {
  await page.goto(session.url);
  const box = await page.locator('.card', { hasText: 'Перфекционизм' }).locator('.card__thumb').boundingBox();
  expect(box.height).toBeLessThanOrEqual(200);
});

test('the approve block for a ready card is fully hidden, not an empty bordered box', async ({ page }) => {
  await openCard(page, 'Готовый ролик');
  await expect(page.locator('.approve')).toBeHidden();
});

test('adding an edit hides the approve block; deleting it brings the block back', async ({ page }) => {
  await openCard(page, 'Перфекционизм');
  await expect(page.locator('.approve')).toBeVisible();
  await page.fill('[data-comment-text]', 'Текст залезает на лицо');
  await page.locator('button', { hasText: 'Добавить правку' }).click();
  await expect(page.locator('[data-comment-list]')).toContainText('Текст залезает на лицо');
  await expect(page.locator('.approve')).toBeHidden();
  await page.locator('[data-comment-list] button', { hasText: 'Удалить' }).click();
  await expect(page.locator('[data-comment-list]')).toContainText('Правок пока нет.');
  await expect(page.locator('.approve')).toBeVisible();
});

test('watching a past render disables edits and approval until returning to the current version', async ({ page }) => {
  await restartWith((dir) => {
    const built = addDraftProject(dir, { folder: 'history-then-waiting', name: 'Снова на проверке', approve: true, final: true });
    addSecondRevision(built.projectDir, 'Снова на проверке');
  });
  await openCard(page, 'Снова на проверке');
  await expect(page.locator('[data-variant-status]')).toHaveText('Ждёт меня');
  await page.locator('button', { hasText: 'История' }).click();
  await page.locator('.history button').first().click();
  await expect(page.locator('.history-bar')).toBeVisible();
  await expect(page.locator('.history-bar')).toContainText('Вы смотрите прежнюю версию');
  await expect(page.locator('button', { hasText: 'Добавить правку' })).toBeDisabled();
  await expect(page.locator('button', { hasText: 'Утверждаю' })).toBeDisabled();
  await page.locator('button', { hasText: 'Вернуться к текущей' }).click();
  await expect(page.locator('.history-bar')).toBeHidden();
  await expect(page.locator('button', { hasText: 'Добавить правку' })).toBeEnabled();
  await expect(page.locator('button', { hasText: 'Утверждаю' })).toBeDisabled();
  await page.check('[data-viewed]');
  await expect(page.locator('button', { hasText: 'Утверждаю' })).toBeEnabled();
});

test('a dead server shows a Russian message, never the raw fetch error', async ({ page }) => {
  await page.goto(session.url);
  await session.close();
  await page.evaluate(() => refresh());
  await expect(page.locator('[data-notice]')).toHaveText(
    'Пульт не отвечает — откройте его снова значком «Пульт роликов».',
  );
});

// --- Commit B: полировка интерфейса ---

test('copy for agent puts the phrase on the real clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openCard(page, 'Перфекционизм');
  await page.locator('button', { hasText: 'Скопировать для агента' }).click();
  await expect(page.locator('[data-copy-status]')).toHaveText('Скопировано — вставьте в чат с агентом');
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toBe(
    'Продолжи ролик «Перфекционизм — тормоз» в projects/waiting-clip: выполни automontage inbox и обработай входящие.',
  );
});

test('the agent handoff box holds only the phrase, not the plain actions', async ({ page }) => {
  await openCard(page, 'Перфекционизм');
  const handoff = page.locator('.agent-handoff', { has: page.locator('h3', { hasText: 'Передать агенту' }) });
  await expect(handoff.locator('[data-agent-phrase]')).toBeVisible();
  await expect(handoff.locator('button', { hasText: 'В архив' })).toHaveCount(0);
  await expect(handoff.locator('button', { hasText: 'Показать в папке' })).toHaveCount(0);
  const actions = page.locator('.actions', { has: page.locator('h3', { hasText: 'Действия' }) });
  await expect(actions.locator('button', { hasText: 'Показать в папке' })).toBeVisible();
  await expect(actions.locator('button', { hasText: 'В архив' })).toBeVisible();
});

test('archiving keeps the success notice visible after closing the card', async ({ page }) => {
  await openCard(page, 'Готовый ролик');
  await page.locator('button', { hasText: 'В архив' }).click();
  await expect(page.locator('[data-notice]')).toContainText('Папка не тронута');
});

// --- Карточка остаётся в синхроне с агентом ---

// Фоновое обновление — ровно тот вызов, который пульт делает по 20-секундному таймеру.
// page.evaluate дожидается его конца, поэтому проверки «ничего не изменилось» не гадают
// по времени. Там, где важен сам таймер, тест крутит его через page.clock.
const backgroundRefresh = (page) => page.evaluate(() => refresh({ keepDetail: true }));

async function waitForPlayerMetadata(page) {
  await page.locator('[data-player]').evaluate((video) => new Promise((resolve) => {
    if (video.readyState >= 1) {
      resolve();
      return;
    }
    video.addEventListener('loadedmetadata', () => resolve(), { once: true });
  }));
}

async function seekPlayer(page, seconds) {
  await page.locator('[data-player]').evaluate((video, time) => new Promise((resolve) => {
    video.addEventListener('seeked', () => resolve(), { once: true });
    video.currentTime = time;
  }), seconds);
}

async function addEdit(page, text) {
  await page.fill('[data-comment-text]', text);
  await page.locator('button', { hasText: 'Добавить правку' }).click();
  await expect(page.locator('[data-comment-list]')).toContainText(text);
}

function historyFixture(folder, name, previewBytes) {
  return (dir) => {
    const built = addDraftProject(dir, { folder, name, approve: true, final: true });
    addSecondRevision(built.projectDir, name, previewBytes);
  };
}

test('after returning from History an edit is saved at the second on screen', async ({ page }) => {
  await restartWith(historyFixture('history-seek', 'Правка после старой версии', playableVideoBytes));
  await openCard(page, 'Правка после старой версии');
  const player = page.locator('[data-player]');
  await waitForPlayerMetadata(page);
  await seekPlayer(page, 5);
  await player.evaluate((video) => { video.pultMarker = 'first'; });
  await page.locator('button', { hasText: 'История' }).click();
  await page.locator('.history button').first().click();
  await expect(page.locator('.history-bar')).toBeVisible();
  await page.locator('button', { hasText: 'Вернуться к текущей' }).click();
  await expect(page.locator('.history-bar')).toBeHidden();
  // Один <video> на всю карточку: правки, переходы к таймкоду и пауза при вводе
  // привязаны к нему, поэтому История меняет только src, а не сам элемент.
  await expect(player).toHaveCount(1);
  expect(await player.evaluate((video) => video.pultMarker)).toBe('first');
  await waitForPlayerMetadata(page);
  await seekPlayer(page, 12.3);
  await expect(page.locator('.comment-time')).toHaveText('на 0:12');
  await addEdit(page, 'Титр на двенадцатой секунде');
  await expect(page.locator('[data-comment-list] .comment').first().locator('button').first()).toHaveText('0:12');
  const saved = await page.evaluate(() => api('/api/comments?key=history-seek')
    .then((body) => body.comments.map((comment) => comment.timeSec)));
  expect(saved).toHaveLength(1);
  expect(saved[0]).toBeCloseTo(12.3, 0);
});

test('a new preview after the agent takes an edit reloads the player and says so', async ({ page }) => {
  const projectDir = path.join(projectsDir, 'waiting-clip');
  await page.clock.install();
  await openCard(page, 'Перфекционизм');
  const player = page.locator('[data-player]');
  const oldSrc = await player.getAttribute('src');
  await addEdit(page, 'Сделай титр крупнее');
  await expect(page.locator('.approve')).toBeHidden();
  await page.fill('[data-comment-text]', 'ещё пишу…');
  await player.evaluate((video) => { video.pultMarker = 'old'; });
  // Пока на сервере ничего не менялось, фоновое обновление не трогает ни плеер, ни черновик.
  await backgroundRefresh(page);
  expect(await player.evaluate((video) => video.pultMarker)).toBe('old');
  await expect(page.locator('[data-comment-text]')).toHaveValue('ещё пишу…');

  // Агент принял правку и опубликовал новый preview.
  for (const comment of readComments(projectDir)) acceptComment(projectDir, comment.id);
  addSecondRevision(projectDir, 'Перфекционизм — тормоз');
  // Срабатывает настоящий 20-секундный таймер пульта, а не прямой вызов refresh.
  await page.clock.fastForward(20_000);

  await expect(page.locator('[data-notice]')).toHaveText('Появилась новая версия видео — посмотрите её перед утверждением.');
  const freshUrl = await page.evaluate(() => api('/api/cards').then((cards) => [...cards.waiting, ...cards.working]
    .flatMap((card) => card.variants)
    .find((variant) => variant.key === 'waiting-clip').video.url));
  const freshVersion = new URL(freshUrl, 'http://127.0.0.1').searchParams.get('v');
  expect(freshVersion).toMatch(/^[A-Za-z0-9_-]{16}$/);
  await expect(player).toHaveAttribute('src', new RegExp(`[?&]v=${freshVersion}(&|$)`));
  expect(await player.getAttribute('src')).not.toBe(oldSrc);
  await expect(page.locator('[data-comment-text]')).toHaveValue('ещё пишу…');
  await expect(page.locator('[data-variant-status]')).toHaveText('Ждёт меня');
  await expect(page.locator('.approve')).toBeVisible();
  await expect(page.locator('[data-viewed]')).not.toBeChecked();
  await expect(page.locator('button', { hasText: 'Утверждаю' })).toBeDisabled();
});

test('a card drawn without an approval ticket announces when one appears', async ({ page }) => {
  const projectDir = path.join(projectsDir, 'waiting-clip');
  await openCard(page, 'Перфекционизм');
  await addEdit(page, 'Правка до повторного открытия');
  // Открываем карточку заново: теперь она нарисована, пока утверждать было нельзя.
  await page.locator('button', { hasText: '← Все ролики' }).click();
  await page.locator('.card', { hasText: 'Перфекционизм' }).click();
  await expect(page.locator('[data-variant-next]')).toHaveText('Ждёт агента: 1 правка');
  await expect(page.locator('.approve')).toBeHidden();
  // Агент принял правку, не пересобирая preview: тот же файл снова можно утвердить —
  // но блок не должен появиться молча.
  for (const comment of readComments(projectDir)) acceptComment(projectDir, comment.id);
  await backgroundRefresh(page);
  await expect(page.locator('[data-notice]')).toHaveText('Preview теперь можно утвердить — посмотрите его целиком перед утверждением.');
  await expect(page.locator('[data-variant-status]')).toHaveText('Ждёт меня');
  await expect(page.locator('.approve')).toBeVisible();
  await expect(page.locator('[data-viewed]')).not.toBeChecked();
});

test('deleting an edit while watching History keeps approval locked', async ({ page }) => {
  await restartWith(historyFixture('history-delete', 'Удаляю правку в Истории'));
  await openCard(page, 'Удаляю правку в Истории');
  await addEdit(page, 'Правка при просмотре старой версии');
  await expect(page.locator('.approve')).toBeHidden();
  await page.locator('button', { hasText: 'История' }).click();
  await page.locator('.history button').first().click();
  await expect(page.locator('.history-bar')).toBeVisible();
  await page.locator('[data-comment-list] button', { hasText: 'Удалить' }).click();
  await expect(page.locator('[data-comment-list]')).toContainText('Правок пока нет.');
  // Блок утверждения вернулся — но человек всё ещё смотрит старую версию.
  await expect(page.locator('.approve')).toBeVisible();
  await page.check('[data-viewed]');
  await expect(page.locator('.history-bar')).toBeVisible();
  await expect(page.locator('button', { hasText: 'Утверждаю' })).toBeDisabled();
  await expect(page.locator('button', { hasText: 'Добавить правку' })).toBeDisabled();
  await page.locator('button', { hasText: 'Вернуться к текущей' }).click();
  await expect(page.locator('button', { hasText: 'Утверждаю' })).toBeEnabled();
  await expect(page.locator('button', { hasText: 'Добавить правку' })).toBeEnabled();
});

test('the list redraws when the server returns to an earlier state', async ({ page }) => {
  const projectDir = path.join(projectsDir, 'waiting-clip');
  await openCard(page, 'Перфекционизм');
  await addEdit(page, 'Правка для списка');
  await expect(page.locator('[data-variant-next]')).toHaveText('Ждёт агента: 1 правка');
  await page.locator('button', { hasText: '← Все ролики' }).click();
  const card = page.locator('.card', { hasText: 'Перфекционизм' });
  await expect(card.locator('.card__next')).toHaveText('Ждёт агента: 1 правка');
  // Агент принял правку, не пересобирая preview: данные сервера снова те же, что при
  // первой отрисовке списка, — но на экране сейчас другой список, и его нужно обновить.
  for (const comment of readComments(projectDir)) acceptComment(projectDir, comment.id);
  await backgroundRefresh(page);
  await expect(card.locator('.card__next')).toHaveText('Посмотрите preview и утвердите');
});

test('a background refresh clears only its own error, never the author\'s', async ({ page }) => {
  await openCard(page, 'Перфекционизм');
  const notice = page.locator('[data-notice]');
  await page.route('**/api/cards', (route) => route.abort());
  await backgroundRefresh(page);
  await expect(notice).toHaveText('Пульт не отвечает — откройте его снова значком «Пульт роликов».');
  await page.unroute('**/api/cards');
  await backgroundRefresh(page);
  await expect(notice).toBeHidden();
  await page.locator('button', { hasText: 'Добавить правку' }).click();
  await expect(notice).toHaveText('Напишите, что поправить.');
  await backgroundRefresh(page);
  await expect(notice).toHaveText('Напишите, что поправить.');
});

test('an approved preview keeps its label even while an edit waits for the agent', async ({ page }) => {
  await openCard(page, 'Перфекционизм');
  await page.check('[data-viewed]');
  await page.locator('button', { hasText: 'Утверждаю' }).click();
  await expect(page.locator('[data-variant-next]')).toHaveText('Утверждено — агент собирает финал');
  await expect(page.locator('.player__label')).toHaveText('Утверждённый preview — агент собирает финал');
  await addEdit(page, 'Ещё одна мысль после утверждения');
  await page.locator('button', { hasText: '← Все ролики' }).click();
  await page.locator('.card', { hasText: 'Перфекционизм' }).click();
  await expect(page.locator('[data-variant-next]')).toHaveText('Ждёт агента: 1 правка');
  await expect(page.locator('.player__label')).toHaveText('Утверждённый preview — агент собирает финал');
});

test('a video that is not there yet is announced inside the empty player', async ({ page }) => {
  await restartWith((dir) => {
    addDraftProject(dir, { folder: 'no-preview', name: 'Ещё без видео', preview: false });
  });
  await openCard(page, 'Ещё без видео');
  await expect(page.locator('[data-player]')).toHaveCount(0);
  await expect(page.locator('.player--empty .player__label')).toHaveText('Видео пока нет');
});

test('card titles stay bold and the handoff hint sits flush', async ({ page }) => {
  await page.goto(session.url);
  const weight = await page.locator('.card__title').first().evaluate((node) => getComputedStyle(node).fontWeight);
  expect(weight).toBe('600');
  await page.locator('.card', { hasText: 'Перфекционизм' }).click();
  const margins = await page.locator('.agent-handoff .hint')
    .evaluate((node) => [getComputedStyle(node).marginTop, getComputedStyle(node).marginBottom]);
  expect(margins).toEqual(['0px', '0px']);
});
