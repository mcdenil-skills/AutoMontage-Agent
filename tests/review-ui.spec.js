const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const { test, expect } = require('playwright/test');

const ROOT = path.resolve(__dirname, '..');
const { startReviewServer } = require('../scripts/review/server');
const { runMediaProcess } = require('../scripts/review/media-process');
const { makeReviewProject, registerHigherBrief } = require('./helpers/review-project');
const { ffmpegEncoderAvailable, runTool } = require('./helpers/media-fixtures');

let reviewSession;
let reviewUrl;
let denseReviewSession;
let denseReviewUrl;
let noWaveformSession;
let noWaveformUrl;
let cleanups = [];

async function closeServer(server) {
  if (!server || !server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
}

async function openReview(page, url = reviewUrl) {
  await page.goto(url);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[data-review-ready]')).toBeVisible();
}

async function expectNoPageOverflow(page) {
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual(await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.clientWidth,
  })));
}

async function makeBrowserReviewSession({
  duration = 4,
  dense = false,
  waveform = true,
  editable = false,
  threeScenes = false,
  broll = false,
  briefStatus = 'draft',
  fileSystem,
  logger,
  higherRevision,
  runMediaProcessImpl,
  assetCount = 0,
  preview = null,
} = {}) {
  const fixture = makeReviewProject(
    { after: (cleanup) => cleanups.push(cleanup) },
    { briefStatus },
  );
  if (dense) {
    const brief = JSON.parse(fs.readFileSync(fixture.briefPath, 'utf8'));
    brief.title = 'Плотный производственный таймлайн';
    brief.output.durationInFrames = duration * brief.output.fps;
    brief.scenes = Array.from({ length: 30 }, (_, index) => ({
      scene: 'fullscreen',
      start: index * 3,
      end: (index + 1) * 3,
      caption: `СЦЕНА ${index + 1}`,
    }));
    fs.writeFileSync(fixture.briefPath, `${JSON.stringify(brief, null, 2)}\n`);

    const words = Array.from({ length: 180 }, (_, index) => ({
      w: `слово-${index + 1}`,
      s: index * 0.5,
      e: (index * 0.5) + 0.35,
    }));
    const transcript = [{
      start: 0,
      end: duration,
      text: words.map((word) => word.w).join(' '),
      words,
    }];
    fs.writeFileSync(
      path.join(fixture.workspace.dir, 'transcript', 'words.json'),
      `${JSON.stringify(transcript, null, 2)}\n`,
    );
  } else if (threeScenes) {
    const brief = JSON.parse(fs.readFileSync(fixture.briefPath, 'utf8'));
    brief.output.durationInFrames = 150;
    brief.scenes = [
      { scene: 'fullscreen', start: 0, end: 2, caption: 'ПЕРВАЯ СЦЕНА' },
      broll
        ? {
          scene: 'broll',
          start: 2,
          end: 4,
          brollSrc: 'assets/broll/diagram.png',
          headCream: 'ВТОРАЯ',
          headOrange: 'СХЕМА',
        }
        : { scene: 'fullscreen', start: 2, end: 4, caption: 'ВТОРАЯ СЦЕНА' },
      { scene: 'fullscreen', start: 4, end: 6, caption: 'ТРЕТЬЯ СЦЕНА' },
    ];
    fs.writeFileSync(fixture.briefPath, `${JSON.stringify(brief, null, 2)}\n`);
    const transcript = [{
      start: 0,
      end: 6,
      text: 'Первый точная граница последний',
      words: [
        { w: 'Первый', s: 0, e: 0.4 },
        { w: 'точная', s: 2.05, e: 2.12 },
        { w: 'граница', s: 3.1, e: 3.5 },
        { w: 'последний', s: 5, e: 5.4 },
      ],
    }];
    fs.writeFileSync(
      path.join(fixture.workspace.dir, 'transcript', 'words.json'),
      `${JSON.stringify(transcript, null, 2)}\n`,
    );
  }

  const sourcePath = path.join(fixture.workspace.dir, 'input', 'source.webm');
  runTool('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=#15171a:s=160x90:r=5:d=${duration}`,
    '-c:v', 'libvpx', '-b:v', '30k', '-an', sourcePath,
  ], fixture.workspace.dir);
  const manifestPath = path.join(fixture.workspace.dir, 'project.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.source.localPath = 'input/source.webm';
  if (preview) {
    const previewBytes = fs.readFileSync(sourcePath);
    const revisionPath = path.join(fixture.workspace.dir, 'previews', 'v01-draft-full.mp4');
    const currentPath = path.join(fixture.workspace.dir, 'previews', 'current-preview.mp4');
    fs.writeFileSync(revisionPath, previewBytes);
    fs.writeFileSync(currentPath, previewBytes);
    manifest.currentPreview = {
      filePath: 'previews/v01-draft-full.mp4',
      briefPath: manifest.currentBrief,
      kind: preview.kind || 'full',
      fromSec: preview.fromSec ?? 0,
      toSec: preview.toSec ?? duration,
      width: 80,
      height: 45,
      fps: 5,
      generatedAt: '2026-08-23T17:05:00.000Z',
      sha256: crypto.createHash('sha256').update(previewBytes).digest('hex'),
    };
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.copyFileSync(
    path.join(ROOT, 'docs', 'previews', 'lesson-presentation.png'),
    path.join(fixture.workspace.dir, 'assets', 'broll', 'diagram.png'),
  );
  for (let index = 1; index <= assetCount; index += 1) {
    fs.copyFileSync(
      path.join(ROOT, 'docs', 'previews', 'lesson-presentation.png'),
      path.join(fixture.workspace.dir, 'assets', 'broll', `media-${String(index).padStart(2, '0')}.png`),
    );
  }
  if (broll) {
    fs.copyFileSync(
      path.join(ROOT, 'docs', 'previews', 'lesson-presentation.png'),
      path.join(fixture.workspace.dir, 'assets', 'broll', 'replacement.png'),
    );
    fs.writeFileSync(path.join(fixture.workspace.dir, 'assets', 'broll', 'voice.mp3'), 'audio');
    fs.writeFileSync(path.join(fixture.workspace.dir, 'assets', 'broll', 'clip.mp4'), 'video');
  }
  if (higherRevision) registerHigherBrief(fixture, { revision: higherRevision });
  const session = await startReviewServer({
    root: ROOT,
    projectDir: fixture.projectDir,
    editable,
    open: false,
    fileSystem,
    logger,
    runMediaProcessImpl,
    runToolImpl: waveform
      ? (_command, args) => fs.copyFileSync(
        path.join(ROOT, 'docs', 'previews', 'lesson-presentation.png'),
        args.at(-1),
      )
      : () => { throw new Error('waveform unavailable'); },
  });
  return { ...session, fixture };
}

async function withBrowserReviewSession(options, run) {
  const session = await makeBrowserReviewSession(options);
  try {
    await run(session);
  } finally {
    await closeServer(session.server);
  }
}

async function dragBoundary(page, index, seconds, { duration = 6, release = true } = {}) {
  const handle = page.locator(`[data-boundary="${index}"]`);
  const track = page.locator('[data-scenes-track]');
  await handle.scrollIntoViewIfNeeded();
  const [handleBox, trackBox] = await Promise.all([handle.boundingBox(), track.boundingBox()]);
  if (!handleBox || !trackBox) throw new Error('Boundary is not visible');
  const hit = await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    return {
      boundary: target?.closest('[data-boundary]')?.getAttribute('data-boundary'),
      description: target ? `${target.tagName}.${target.className}` : 'nothing',
    };
  }, { x: handleBox.x + (handleBox.width / 2), y: handleBox.y + (handleBox.height / 2) });
  if (hit.boundary !== String(index)) throw new Error(`Boundary is covered by ${hit.description}`);
  await page.mouse.move(handleBox.x + (handleBox.width / 2), handleBox.y + (handleBox.height / 2));
  await page.mouse.down();
  await page.mouse.move(trackBox.x + ((seconds / duration) * trackBox.width), handleBox.y + 2);
  if (release) await page.mouse.up();
}

async function waitForEditReady(page) {
  await expect(page.locator('[data-edit-status]')).toContainText(/изменени[йя] нет|изменени[ейя]:/i);
}

async function postSessionJson(session, pathname, value) {
  return fetch(`${session.origin}${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.token}`,
      'Content-Type': 'application/json',
      Origin: session.origin,
    },
    body: JSON.stringify(value),
  });
}

async function saveExternalBoundary(session, seconds) {
  const external = await startReviewServer({
    root: ROOT,
    projectDir: session.fixture.projectDir,
    editable: true,
    open: false,
    runToolImpl: () => { throw new Error('waveform unavailable'); },
  });
  try {
    const externalState = await (await fetch(`${external.origin}/api/state`, {
      headers: { Authorization: `Bearer ${external.token}` },
    })).json();
    const response = await postSessionJson(external, '/api/save', {
      baseRevision: externalState.session.baseRevision,
      baseHash: externalState.session.baseHash,
      manifestHash: externalState.session.manifestHash,
      commands: [{ type: 'move-boundary', leftSceneIndex: 0, seconds }],
    });
    expect(response.status).toBe(201);
  } finally {
    await closeServer(external.server);
  }
}

function makeBrowserImportFixtures() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-review-ui-media-'));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = {
    jpeg: path.join(directory, 'browser-image.jpg'),
    mp4: path.join(directory, 'browser-with-audio.mp4'),
    mov: path.join(directory, 'browser-with-audio.mov'),
    webm: path.join(directory, 'browser-silent.webm'),
    slow: path.join(directory, 'browser-processing.mp4'),
  };
  runTool('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=#d86b3c:s=80x60',
    '-frames:v', '1', files.jpeg,
  ], directory);
  runTool('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', files.mp4,
  ], directory);
  runTool('ffmpeg', [
    '-y', '-v', 'error', '-i', files.mp4, '-c', 'copy', files.mov,
  ], directory);
  runTool('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=20:d=4',
    '-c:v', 'libvpx', '-b:v', '100k', '-an', files.webm,
  ], directory);
  runTool('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=8',
    '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:d=8',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', files.slow,
  ], directory);
  return files;
}

async function importFileFromBrowser(page, filePath) {
  const input = page.locator('[data-media-input]');
  const responsePromise = page.waitForResponse((candidate) => (
    candidate.url().endsWith('/api/assets/import') && candidate.request().method() === 'POST'
  ));
  await input.setInputFiles(filePath);
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  await expect(page.locator('[data-media-import-status]')).toContainText(/добавлено/i);
}

async function recordImportPhases(page) {
  await page.evaluate(() => {
    const status = document.querySelector('[data-media-import-status]');
    const progress = document.querySelector('[data-media-progress]');
    window.__importPhaseLog = [];
    const capture = () => window.__importPhaseLog.push({
      phase: status?.dataset.phase || null,
      status: status?.textContent || '',
      hidden: progress?.hidden ?? true,
      hasValue: progress?.hasAttribute('value') ?? false,
      value: progress?.getAttribute('value'),
    });
    new MutationObserver(capture).observe(status, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    new MutationObserver(capture).observe(progress, { attributes: true });
    capture();
  });
}

test.beforeAll(async () => {
  reviewSession = await makeBrowserReviewSession();
  reviewUrl = reviewSession.url;
  denseReviewSession = await makeBrowserReviewSession({ duration: 90, dense: true });
  denseReviewUrl = denseReviewSession.url;
  noWaveformSession = await makeBrowserReviewSession({ waveform: false });
  noWaveformUrl = noWaveformSession.url;
});

test.afterAll(async () => {
  await closeServer(reviewSession && reviewSession.server);
  await closeServer(denseReviewSession && denseReviewSession.server);
  await closeServer(noWaveformSession && noWaveformSession.server);
  cleanups.reverse().forEach((cleanup) => cleanup());
  cleanups = [];
});

test('timeline shows only the token-protected safe waveform URL when available', async ({ page }) => {
  const waveformRequests = [];
  page.on('request', (request) => {
    if (request.url().includes('/media/waveform')) waveformRequests.push(request);
  });

  await openReview(page);

  const waveform = page.locator('img[data-waveform-preview]');
  await expect(waveform).toHaveCount(1);
  await expect.poll(() => waveformRequests.length).toBeGreaterThan(0);
  const url = new URL(waveformRequests[0].url());
  expect(url.pathname).toBe('/media/waveform');
  expect(url.searchParams.get('token')).toBe(reviewSession.token);
});

test('timeline adds no blank waveform element when preview is unavailable', async ({ page }) => {
  await openReview(page, noWaveformUrl);

  await expect(page.locator('img[data-waveform-preview]')).toHaveCount(0);
  await expect(page.locator('[data-lane]')).toHaveCount(4);
});

test('timeline refuses a waveform URL outside the fixed media handle', async ({ page }) => {
  await page.route('**/api/state', async (route) => {
    const response = await route.fetch();
    const state = await response.json();
    state.waveform = { url: 'https://evil.test/private.png' };
    await route.fulfill({ response, json: state });
  });

  await openReview(page);

  await expect(page.locator('img[data-waveform-preview]')).toHaveCount(0);
});

test('read-only review shows semantic source, lanes and diagnostics without edit controls', async ({ page }) => {
  const mutatingRequests = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') mutatingRequests.push(request.url());
  });
  await openReview(page);

  await expect(page.getByRole('heading', { name: /проверка монтажа/i })).toBeVisible();
  await expect(page.locator('video[controls]')).toHaveCount(1);
  await expect(page.getByRole('region', { name: /таймлайн/i })).toBeVisible();
  await expect(page.locator('ol[data-transcript]')).toBeVisible();
  await expect(page.getByRole('region', { name: /диагностика/i })).toBeVisible();
  await expect(page.locator('[data-lane="source"]')).toBeVisible();
  await expect(page.locator('[data-lane="scenes"]')).toBeVisible();
  await expect(page.locator('[data-lane="transcript"]')).toBeVisible();
  await expect(page.locator('[data-lane="assets"]')).toBeVisible();
  await expect(page.locator('[data-scene]')).toHaveCount(2);
  await expect(page.locator('[data-transcript-word]')).toHaveCount(3);
  await expect(page.getByRole('button', { name: /сохранить|изменить|отменить/i })).toHaveCount(0);
  await expect(page.locator('[data-edit-controls], [data-boundary], [data-broll-select]')).toHaveCount(0);

  for (const selector of ['[data-scene]', '[data-transcript-word]', '[data-source-target]']) {
    await expect(page.locator(selector)).not.toHaveCount(0);
    await expect(page.locator(`${selector}:not(button)`)).toHaveCount(0);
  }
  await expect(page.locator('video')).toHaveJSProperty('autoplay', false);
  expect(mutatingRequests).toEqual([]);
});

test('rendered preview stays visibly separate from the source player and refreshes exact range metadata', async ({ page }) => {
  await withBrowserReviewSession({
    preview: { kind: 'excerpt', fromSec: 0.5, toSec: 3.5 },
  }, async (session) => {
    await openReview(page, session.url);

    await expect(page.getByRole('heading', { name: 'ИСХОДНИК', exact: true })).toBeVisible();
    await expect(page.getByText('Видео для правок речи и границ', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'СМОНТИРОВАННЫЙ ПРЕДПРОСМОТР', exact: true })).toBeVisible();
    await expect(page.getByText('Настоящий Remotion-результат', { exact: true })).toBeVisible();
    await expect(page.getByText('ФРАГМЕНТ 00:00.50–00:03.50', { exact: true })).toBeVisible();
    await expect(page.locator('video[data-source-video]')).toHaveCount(1);
    await expect(page.locator('video[data-preview-video]')).toHaveCount(1);
    await page.locator('video[data-source-video]').evaluate((video) => { video.currentTime = 1; });
    await page.locator('video[data-preview-video]').evaluate((video) => { video.currentTime = 2; });
    await expect.poll(() => page.locator('video[data-source-video]').evaluate((video) => video.currentTime)).toBeCloseTo(1, 1);
    await expect.poll(() => page.locator('video[data-preview-video]').evaluate((video) => video.currentTime)).toBeCloseTo(2, 1);

    await page.setViewportSize({ width: 360, height: 800 });
    await expectNoPageOverflow(page);
    await expect(page.locator('[data-source-player]')).toBeVisible();
    await expect(page.locator('[data-preview-player]')).toBeVisible();

    const manifestPath = path.join(session.fixture.workspace.dir, 'project.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.currentPreview.kind = 'full';
    manifest.currentPreview.fromSec = 0;
    manifest.currentPreview.toSec = 4;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await openReview(page, `${session.origin}/?preview-refresh=1#token=${session.token}`);
    await expect(page.getByText('ПОЛНЫЙ РОЛИК', { exact: true })).toBeVisible();
  });
});

test('rendered preview empty state is explicit while the source player remains available', async ({ page }) => {
  await withBrowserReviewSession({}, async (session) => {
    await openReview(page, session.url);
    await expect(page.getByText('Предпросмотр ещё не собран', { exact: true })).toBeVisible();
    await expect(page.locator('video[data-source-video]')).toHaveCount(1);
    await expect(page.locator('video[data-preview-video]')).toHaveCount(0);
  });
});

test('browser diagnostics identify a nearby word-boundary suggestion from canonical state', async ({ page }) => {
  await withBrowserReviewSession({ threeScenes: true }, async (session) => {
    await openReview(page, session.url);
    const state = await (await fetch(`${session.origin}/api/state`, {
      headers: { Authorization: `Bearer ${session.token}` },
    })).json();

    expect(state.timing.suggestions).toContainEqual(expect.objectContaining({
      reason: 'word',
      seconds: 2,
      suggestedSeconds: 2.05,
    }));
    await expect(page.locator('[data-diagnostics]')).toContainText(/границ.*слов/i);
  });
});

test('scene and transcript buttons seek the source and update one synchronized playhead', async ({ page }) => {
  await openReview(page);
  const video = page.locator('video');
  await video.evaluate((element) => (
    element.readyState > 0
      ? undefined
      : new Promise((resolve) => element.addEventListener('loadedmetadata', resolve, { once: true }))
  ));

  await page.locator('[data-scene="1"]').click();
  await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeCloseTo(2, 1);
  await expect(page.locator('[data-scene="1"]')).toHaveAttribute('aria-current', 'true');

  await page.getByRole('button', { name: /^фрагмент/i }).click();
  await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeCloseTo(0.5, 1);
  await expect(page.getByRole('button', { name: /^фрагмент/i })).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('[data-playhead]')).toHaveCount(1);
  await expect.poll(async () => Number(
    await page.locator('[data-playhead]').getAttribute('data-time'),
  ))
    .toBeCloseTo(0.5, 1);
});

test('dense production timeline keeps every target reachable inside its own mobile scroll', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await openReview(page, denseReviewUrl);
  await expect(page.locator('[data-scene]')).toHaveCount(30);
  await expect(page.locator('[data-transcript-word]')).toHaveCount(180);

  const geometry = await page.evaluate(() => {
    const rectangles = (selector) => [...document.querySelectorAll(selector)].map((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width };
    });
    const words = rectangles('[data-transcript-word]');
    const scenes = rectangles('[data-scene]');
    const timeline = document.querySelector('[data-timeline-root]');
    return {
      pageClientWidth: document.documentElement.clientWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
      timelineClientWidth: timeline.clientWidth,
      timelineScrollWidth: timeline.scrollWidth,
      minimumSceneWidth: Math.min(...scenes.map((scene) => scene.width)),
      wordOverlapCount: words.slice(1).filter((word, index) => (
        word.left < words[index].right - 0.5
      )).length,
    };
  });

  expect(geometry.pageClientWidth).toBe(360);
  expect(geometry.pageScrollWidth).toBe(360);
  expect(geometry.timelineScrollWidth).toBeGreaterThan(geometry.timelineClientWidth);
  expect(geometry.wordOverlapCount).toBe(0);
  expect(geometry.minimumSceneWidth).toBeGreaterThanOrEqual(40);

  const middleWord = page.locator('[data-transcript-word="100"]');
  await middleWord.scrollIntoViewIfNeeded();
  expect(await middleWord.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return document.elementFromPoint(box.left + (box.width / 2), box.top + (box.height / 2)) === element;
  })).toBe(true);
  await middleWord.click();
  await expect.poll(() => page.locator('video').evaluate((video) => video.currentTime))
    .toBeCloseTo(50, 1);
  await expectNoPageOverflow(page);
});

test('session token leaves the fragment and stays out of storage, DOM and API query strings', async ({ page }) => {
  const apiRequests = [];
  const mediaRequests = [];
  const assetRequests = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/state')) apiRequests.push(request);
    if (request.url().includes('/media/source')) mediaRequests.push(request);
    if (request.url().includes('/media/assets/')) assetRequests.push(request);
  });

  await openReview(page);

  await expect.poll(() => apiRequests.length).toBe(1);
  expect(new URL(apiRequests[0].url()).search).toBe('');
  expect(apiRequests[0].headers().authorization).toBe(`Bearer ${reviewSession.token}`);
  await expect.poll(() => mediaRequests.length).toBeGreaterThan(0);
  expect(new URL(mediaRequests[0].url()).searchParams.get('token')).toBe(reviewSession.token);
  await expect.poll(() => assetRequests.length).toBeGreaterThan(0);
  expect(new URL(assetRequests[0].url()).searchParams.get('token')).toBe(reviewSession.token);
  expect(await page.evaluate(() => location.hash)).toBe('');
  expect(await page.evaluate(() => ({ ...localStorage }))).toEqual({});
  await expect(page.locator('body')).not.toContainText(reviewSession.token);
  await expect(page.locator(`[value="${reviewSession.token}"]`)).toHaveCount(0);
});

for (const width of [736, 360]) {
  test(`timeline has no page overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openReview(page);
    await expectNoPageOverflow(page);
  });
}

test('keyboard reaches timeline buttons while Space remains native to the video', async ({ page }) => {
  await openReview(page);
  const video = page.locator('video');
  await video.focus();
  await expect(video).toBeFocused();
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(true);
  await page.keyboard.press('Space');
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(false);
  await page.keyboard.press('Space');
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(true);

  const secondScene = page.locator('[data-scene="1"]');
  await secondScene.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeCloseTo(2, 1);
});

test('edit mode moves only one shared boundary with word priority and can undo it', async ({ page }) => {
  await withBrowserReviewSession({ editable: true, threeScenes: true }, async (session) => {
    await openReview(page, session.url);
    await waitForEditReady(page);
    await expect(page.locator('[data-boundary]')).toHaveCount(2);
    await expect(page.locator('[data-boundary]:not(button)')).toHaveCount(0);
    const thirdBefore = await page.locator('[data-scene="2"]').getAttribute('data-start');

    const validationResponse = page.waitForResponse((response) => response.url().endsWith('/api/validate'));
    await dragBoundary(page, 0, 2.1);
    expect((await validationResponse).status()).toBe(200);

    await expect(page.locator('[data-scene="0"]')).toHaveAttribute('data-end', '2.12');
    await expect(page.locator('[data-scene="1"]')).toHaveAttribute('data-start', '2.12');
    await expect(page.locator('[data-scene="2"]')).toHaveAttribute('data-start', thirdBefore);
    await expect(page.locator('[data-boundary="0"]')).toHaveAttribute('data-snap-reason', 'word');
    await expect(page.locator('[data-boundary="0"]')).toContainText('слово');
    await expect(page.locator('[data-server-diff]')).toContainText('Граница сцен 1–2');
    await expect(page.locator('[data-server-diff]')).toContainText('00:02.000 → 00:02.120');

    const undo = page.getByRole('button', { name: /^отменить$/i });
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect(page.locator('[data-scene="0"]')).toHaveAttribute('data-end', '2');
    await expect(page.locator('[data-scene="1"]')).toHaveAttribute('data-start', '2');
    await expect(page.getByRole('button', { name: /^повторить$/i })).toBeEnabled();
  });
});

test('frame snap, Escape cancellation and keyboard undo/redo keep native video Space', async ({ page }) => {
  await withBrowserReviewSession({ editable: true, threeScenes: true }, async (session) => {
    const validateRequests = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/validate')) validateRequests.push(request);
    });
    await openReview(page, session.url);
    await waitForEditReady(page);
    await expect(page.getByRole('button', { name: /^отменить$/i })).toBeDisabled();
    await expect(page.getByRole('button', { name: /^повторить$/i })).toBeDisabled();
    await expect(page.getByRole('button', { name: /^сохранить$/i })).toBeDisabled();

    await dragBoundary(page, 0, 2.31);
    await expect(page.locator('[data-scene="0"]')).toHaveAttribute('data-end', '2.32');
    await expect(page.locator('[data-boundary="0"]')).toHaveAttribute('data-snap-reason', 'frame');
    await expect(page.locator('[data-boundary="0"]')).toContainText('кадр');

    const undo = page.getByRole('button', { name: /^отменить$/i });
    await undo.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-scene="0"]')).toHaveAttribute('data-end', '2');
    const redo = page.getByRole('button', { name: /^повторить$/i });
    await redo.focus();
    await page.keyboard.press('Space');
    await expect(page.locator('[data-scene="0"]')).toHaveAttribute('data-end', '2.32');

    const beforeCancelRequests = validateRequests.length;
    await dragBoundary(page, 0, 2.6, { release: false });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(page.locator('[data-scene="0"]')).toHaveAttribute('data-end', '2.32');
    expect(validateRequests).toHaveLength(beforeCancelRequests);

    const video = page.locator('video');
    await video.focus();
    await page.keyboard.press('Space');
    await expect.poll(() => video.evaluate((element) => element.paused)).toBe(false);
    await page.keyboard.press('Space');
    await expect.poll(() => video.evaluate((element) => element.paused)).toBe(true);
  });
});

test('b-roll controls expose only eligible scenes and send an opaque asset id', async ({ page }) => {
  await withBrowserReviewSession({ editable: true, threeScenes: true, broll: true }, async (session) => {
    let validationBody;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/validate')) validationBody = request.postDataJSON();
    });
    await page.setViewportSize({ width: 360, height: 900 });
    await openReview(page, session.url);
    await waitForEditReady(page);

    const selects = page.locator('[data-broll-select]');
    await expect(selects).toHaveCount(1);
    await expect(selects).toHaveAttribute('data-scene-index', '1');
    await expect(page.locator('[data-assets]')).toContainText('voice.mp3');
    await expect(page.locator('[data-assets]')).toContainText('clip.mp4');
    await expect(selects.locator('option', { hasText: 'voice.mp3' })).toHaveCount(0);
    await expect(selects.locator('option', { hasText: 'clip.mp4' })).toHaveCount(0);
    await selects.selectOption({ label: 'replacement.png' });
    await expect(page.locator('[data-server-diff]')).toContainText('Медиа сцены 2');
    const imageControls = page.locator('[data-broll-scene="1"]');
    await expect(imageControls.locator('[data-broll-fit]')).toHaveValue('cover');
    await expect(imageControls.locator('[data-broll-video], [data-broll-start], [data-broll-audio]')).toHaveCount(0);
    await expect.poll(() => validationBody).toBeTruthy();

    expect(validationBody.commands.at(-1)).toEqual({
      type: 'replace-broll',
      sceneIndex: 1,
      assetId: expect.stringMatching(/^asset-[1-9]\d*$/),
    });
    expect(JSON.stringify(validationBody.commands)).not.toMatch(/https?:|\/media\/|assets\/broll|Users/);
    expect(await page.evaluate(() => ({ ...localStorage }))).toEqual({});
    await expectNoPageOverflow(page);
  });
});

test('server-invalid non-timing edit leaves boundaries neutral, disables save and reports a safe accessible error', async ({ page }) => {
  await withBrowserReviewSession({ editable: true, threeScenes: true, broll: true }, async (session) => {
    await openReview(page, session.url);
    await waitForEditReady(page);
    const select = page.locator('[data-broll-select]');
    const replacementId = await select.locator('option', { hasText: 'replacement.png' }).getAttribute('value');
    fs.renameSync(
      path.join(session.fixture.workspace.dir, 'assets', 'broll', 'replacement.png'),
      path.join(session.fixture.workspace.dir, 'assets', 'broll', 'replacement.unavailable'),
    );

    const validationResponse = page.waitForResponse((response) => (
      response.url().endsWith('/api/validate') && response.status() === 422
    ));
    await select.selectOption(replacementId);
    await validationResponse;

    await expect(page.locator('[data-boundary="0"]')).not.toHaveAttribute('data-invalid', 'true');
    await expect(page.locator('[data-boundary="1"]')).not.toHaveAttribute('data-invalid', 'true');
    await expect(page.getByRole('button', { name: /^сохранить$/i })).toBeDisabled();
    const error = page.getByRole('alert');
    await expect(error).toContainText(/не удалось проверить/i);
    await expect(error).not.toContainText(session.token);
    await expect(error).not.toContainText(session.fixture.projectDir);
  });
});

test('save confirms server diff, creates a new draft and leaves approved bytes unchanged', async ({ page }) => {
  await withBrowserReviewSession({
    editable: true,
    threeScenes: true,
    broll: true,
    briefStatus: 'approved',
    higherRevision: 5,
  }, async (session) => {
    const approvedBytes = fs.readFileSync(session.fixture.briefPath);
    const approvedHash = crypto.createHash('sha256').update(approvedBytes).digest('hex');
    const requestBodies = { validate: [], save: [] };
    page.on('request', (request) => {
      if (request.url().endsWith('/api/validate')) requestBodies.validate.push(request.postDataJSON());
      if (request.url().endsWith('/api/save')) requestBodies.save.push(request.postDataJSON());
    });
    await openReview(page, session.url);
    await waitForEditReady(page);
    await expect(page.locator('[data-revision]')).toContainText('v01');

    await page.locator('[data-broll-select]').selectOption({ label: 'replacement.png' });
    await expect(page.locator('[data-server-diff]')).toContainText('Медиа сцены 2');
    await dragBoundary(page, 0, 2.1);
    await expect(page.getByRole('button', { name: /^сохранить$/i })).toBeEnabled();
    page.once('dialog', async (dialog) => {
      expect(dialog.type()).toBe('confirm');
      expect(dialog.message()).toMatch(/Граница сцен 1–2.*00:02\.000.*00:02\.120/s);
      expect(dialog.message()).toMatch(/Медиа сцены 2.*diagram\.png.*replacement\.png/s);
      expect(dialog.message()).toMatch(/ревизи.*v06/i);
      await dialog.accept();
    });
    const savedResponse = page.waitForResponse((response) => (
      response.url().endsWith('/api/save') && response.status() === 201
    ));
    await page.getByRole('button', { name: /^сохранить$/i }).click();
    await savedResponse;

    await expect(page.locator('[data-revision]')).toContainText('v06');
    await expect(page.locator('[data-brief-status]')).toContainText('Черновик');
    await expect(page.getByRole('button', { name: /^отменить$/i })).toBeDisabled();
    await expect(page.getByRole('button', { name: /^повторить$/i })).toBeDisabled();
    await expect(page.getByRole('button', { name: /^сохранить$/i })).toBeDisabled();
    await expect(page.getByRole('button', { name: /утвердить/i })).toBeDisabled();

    expect(requestBodies.save).toHaveLength(1);
    expect(requestBodies.save[0]).toEqual(requestBodies.validate.at(-1));
    expect(crypto.createHash('sha256').update(fs.readFileSync(session.fixture.briefPath)).digest('hex'))
      .toBe(approvedHash);
    expect(fs.readFileSync(session.fixture.briefPath)).toEqual(approvedBytes);
    const manifest = JSON.parse(fs.readFileSync(
      path.join(session.fixture.workspace.dir, 'project.json'),
      'utf8',
    ));
    expect(manifest.currentBrief).toBe('brief/v06-draft.lesson.json');
  });
});

test('save locks every mutation handler until the real 201 advances state', async ({ page }) => {
  await withBrowserReviewSession({ editable: true, threeScenes: true, broll: true }, async (session) => {
    let releaseSave;
    const saveGate = new Promise((resolve) => { releaseSave = resolve; });
    let reportRealSave;
    const realSave = new Promise((resolve) => { reportRealSave = resolve; });
    const validationBodies = [];
    const saveBodies = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/validate')) validationBodies.push(request.postDataJSON());
      if (request.url().endsWith('/api/save')) saveBodies.push(request.postDataJSON());
    });
    await page.route('**/api/save', async (route) => {
      const response = await route.fetch();
      reportRealSave(response.status());
      await saveGate;
      await route.fulfill({ response });
    });

    try {
      await openReview(page, session.url);
      await waitForEditReady(page);
      await dragBoundary(page, 0, 2.31);
      await expect(page.getByRole('button', { name: /^сохранить$/i })).toBeEnabled();
      const validationCount = validationBodies.length;
      page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: /^сохранить$/i }).click();
      expect(await realSave).toBe(201);

      const handle = page.locator('[data-boundary="0"]');
      const select = page.locator('[data-broll-select]');
      await expect(handle).toBeDisabled();
      await expect(select).toBeDisabled();
      await handle.dispatchEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight' });
      await select.evaluate((element) => {
        element.disabled = false;
        const option = [...element.options].find((candidate) => candidate.textContent === 'diagram.png');
        element.value = option.value;
        element.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(validationBodies).toHaveLength(validationCount);
      expect(saveBodies).toHaveLength(1);

      releaseSave();
      await expect(page.locator('[data-revision]')).toContainText('v02');
      await expect(page.locator('[data-scene="0"]')).toHaveAttribute('data-end', '2.32');
      await expect(page.getByRole('button', { name: /^отменить$/i })).toBeDisabled();
      await expect(page.getByRole('button', { name: /^повторить$/i })).toBeDisabled();
      await expect(page.getByRole('button', { name: /^сохранить$/i })).toBeDisabled();
    } finally {
      releaseSave();
    }
  });
});

test('Arrow keys accumulate frame commands, restore boundary focus and undo one step', async ({ page }) => {
  await withBrowserReviewSession({ editable: true, threeScenes: true }, async (session) => {
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    let reportFirst;
    const firstValidated = new Promise((resolve) => { reportFirst = resolve; });
    let validationNumber = 0;
    const validationBodies = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/validate')) validationBodies.push(request.postDataJSON());
    });
    await page.route('**/api/validate', async (route) => {
      const response = await route.fetch();
      validationNumber += 1;
      if (validationNumber === 1) {
        reportFirst(response.status());
        await firstGate;
      }
      await route.fulfill({ response });
    });

    try {
      await openReview(page, session.url);
      await waitForEditReady(page);
      const handle = page.locator('[data-boundary="1"]');
      await handle.focus();
      await page.keyboard.press('ArrowRight');
      expect(await firstValidated).toBe(200);
      await expect(page.locator('[data-boundary="1"]')).toBeDisabled();
      await page.locator('[data-boundary="1"]').dispatchEvent('keydown', { key: 'ArrowRight' });
      expect(validationBodies).toHaveLength(1);

      const firstComplete = page.waitForResponse((response) => (
        response.url().endsWith('/api/validate') && response.status() === 200
      ));
      releaseFirst();
      await firstComplete;
      await expect(page.locator('[data-boundary="1"]')).toBeFocused();
      const secondComplete = page.waitForResponse((response) => (
        response.url().endsWith('/api/validate') && response.status() === 200
      ));
      await page.keyboard.press('ArrowRight');
      await secondComplete;

      await expect(page.locator('[data-scene="1"]')).toHaveAttribute('data-end', '4.08');
      await expect(page.locator('[data-scene="2"]')).toHaveAttribute('data-start', '4.08');
      await expect(page.locator('[data-boundary="1"]')).toBeFocused();
      await expect.poll(() => validationBodies.length).toBe(2);
      expect(validationBodies[1].commands).toEqual([
        { type: 'move-boundary', leftSceneIndex: 1, seconds: 4.04 },
        { type: 'move-boundary', leftSceneIndex: 1, seconds: 4.08 },
      ]);

      await page.getByRole('button', { name: /^отменить$/i }).click();
      await expect(page.locator('[data-scene="1"]')).toHaveAttribute('data-end', '4.04');
      await expect(page.locator('[data-scene="2"]')).toHaveAttribute('data-start', '4.04');
    } finally {
      releaseFirst();
    }
  });
});

test('ArrowRight leaves an existing word snap and advances cumulatively by frames', async ({ page }) => {
  await withBrowserReviewSession({ editable: true, threeScenes: true }, async (session) => {
    await openReview(page, session.url);
    await waitForEditReady(page);
    const dragValidation = page.waitForResponse((response) => (
      response.url().endsWith('/api/validate') && response.status() === 200
    ));
    await dragBoundary(page, 0, 2.1);
    await dragValidation;
    await expect(page.locator('[data-scene="0"]')).toHaveAttribute('data-end', '2.12');
    await expect(page.locator('[data-boundary="0"]')).toHaveAttribute('data-snap-reason', 'word');

    const handle = page.locator('[data-boundary="0"]');
    await handle.focus();
    const firstValidation = page.waitForResponse((response) => (
      response.url().endsWith('/api/validate') && response.status() === 200
    ));
    await page.keyboard.press('ArrowRight');
    await firstValidation;
    await expect(page.locator('[data-scene="0"]')).toHaveAttribute('data-end', '2.16');
    await expect(handle).toBeFocused();

    const secondValidation = page.waitForResponse((response) => (
      response.url().endsWith('/api/validate') && response.status() === 200
    ));
    await page.keyboard.press('ArrowRight');
    await secondValidation;
    await expect(page.locator('[data-scene="0"]')).toHaveAttribute('data-end', '2.2');
    await expect(handle).toBeFocused();

    await page.getByRole('button', { name: /^отменить$/i }).click();
    await expect(page.locator('[data-scene="0"]')).toHaveAttribute('data-end', '2.16');
  });
});

test('save failure keeps commands in memory and exposes no server detail', async ({ page }) => {
  const privateTarget = '/private/review/save-target.json';
  const failingFileSystem = {
    ...fs,
    renameSync(source, target) {
      if (source.includes('.tmp-review-draft-manifest-')) {
        throw new Error(`simulated save failure at ${privateTarget}`);
      }
      return fs.renameSync(source, target);
    },
  };
  await withBrowserReviewSession({
    editable: true,
    threeScenes: true,
    fileSystem: failingFileSystem,
    logger: { error() {} },
  }, async (session) => {
    await openReview(page, session.url);
    await waitForEditReady(page);
    await dragBoundary(page, 0, 2.1);
    await expect(page.getByRole('button', { name: /^сохранить$/i })).toBeEnabled();
    page.once('dialog', (dialog) => dialog.accept());
    const failure = page.waitForResponse((response) => (
      response.url().endsWith('/api/save') && response.status() === 500
    ));
    await page.getByRole('button', { name: /^сохранить$/i }).click();
    await failure;

    const error = page.getByRole('alert');
    await expect(error).toContainText(/не удалось сохранить/i);
    await expect(error).not.toContainText(/simulated|private|save-target|Users/i);
    await expect(page.locator('[data-edit-status]')).toContainText(/изменени[йя]: 1/i);
    await expect(page.locator('[data-revision]')).toContainText('v01');
    await expect(page.getByRole('button', { name: /^отменить$/i })).toBeEnabled();
  });
});

test('stale conflict never replays an earlier command in the next validation', async ({ page }) => {
  await withBrowserReviewSession({
    editable: true,
    threeScenes: true,
    broll: true,
  }, async (session) => {
    const browserSaves = [];
    const browserValidations = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/save')) browserSaves.push(request);
      if (request.url().endsWith('/api/validate')) browserValidations.push(request);
    });
    await openReview(page, session.url);
    await waitForEditReady(page);

    await dragBoundary(page, 0, 2.1);
    await expect(page.getByRole('button', { name: /^сохранить$/i })).toBeEnabled();
    await saveExternalBoundary(session, 2.4);

    page.once('dialog', (dialog) => dialog.accept());
    const conflictResponse = page.waitForResponse((response) => (
      response.url().endsWith('/api/save') && response.status() === 409
    ));
    await page.getByRole('button', { name: /^сохранить$/i }).click();
    await conflictResponse;

    await expect(page.locator('[data-conflict]')).toContainText(/конфликт/i);
    await expect(page.locator('[data-conflict]')).toContainText(/устаревш.*не.*примен/i);
    await expect(page.locator('[data-revision]')).toContainText('v02');
    await expect(page.locator('[data-scene="0"]')).toHaveAttribute('data-end', '2.4');
    await expect(page.getByRole('button', { name: /^сохранить$/i })).toBeDisabled();
    await expect(page.getByRole('button', { name: /^отменить$/i })).toBeDisabled();
    await expect(page.getByRole('button', { name: /^повторить$/i })).toBeDisabled();
    const handle = page.locator('[data-boundary="0"]');
    const brollSelect = page.locator('[data-broll-select]').first();
    await expect(handle).toBeDisabled();
    await expect(brollSelect).toBeDisabled();
    const discard = page.getByRole('button', {
      name: /отбросить устаревшие правки и продолжить/i,
    });
    await expect(discard).toBeVisible();
    await expect(discard).toBeEnabled();
    expect(browserSaves).toHaveLength(1);
    expect(browserValidations).toHaveLength(1);
    await page.waitForTimeout(150);
    expect(browserSaves).toHaveLength(1);
    expect(browserValidations).toHaveLength(1);

    await discard.click();
    await expect(page.locator('[data-conflict]')).toBeHidden();
    await expect(page.locator('[data-edit-status]')).toHaveText('Изменений нет');
    await expect(handle).toBeEnabled();
    await expect(brollSelect).toBeEnabled();
    await expect(page.locator('[data-scene="0"]')).toHaveAttribute('data-end', '2.4');

    const nextValidation = page.waitForResponse((response) => (
      response.url().endsWith('/api/validate') && response.status() === 200
    ));
    await handle.focus();
    await handle.press('ArrowRight');
    await nextValidation;

    expect(browserValidations).toHaveLength(2);
    expect(browserValidations[1].postDataJSON().commands).toEqual([{
      type: 'move-boundary',
      leftSceneIndex: 0,
      seconds: 2.44,
    }]);
  });
});

test('failed state reload quarantines stale commands and keeps discard unavailable', async ({ page }) => {
  await withBrowserReviewSession({
    editable: true,
    threeScenes: true,
    broll: true,
  }, async (session) => {
    const browserValidations = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/validate')) browserValidations.push(request);
    });
    await openReview(page, session.url);
    await waitForEditReady(page);
    await dragBoundary(page, 0, 2.1);
    await expect(page.getByRole('button', { name: /^сохранить$/i })).toBeEnabled();
    expect(browserValidations).toHaveLength(1);
    await saveExternalBoundary(session, 2.4);

    await page.route('**/api/state', (route) => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'temporarily unavailable' }),
    }));
    page.once('dialog', (dialog) => dialog.accept());
    const conflictResponse = page.waitForResponse((response) => (
      response.url().endsWith('/api/save') && response.status() === 409
    ));
    const reloadFailure = page.waitForResponse((response) => (
      response.url().endsWith('/api/state') && response.status() === 503
    ));
    await page.getByRole('button', { name: /^сохранить$/i }).click();
    await conflictResponse;
    await reloadFailure;

    await expect(page.locator('[data-conflict]')).toContainText(/устаревш.*не.*примен/i);
    await expect(page.locator('[data-edit-status]')).toContainText(/устаревш.*1/i);
    await expect(page.locator('[data-server-diff]')).toContainText('Граница сцен 1–2');
    await expect(page.locator('[data-revision]')).toContainText('v01');
    await expect(page.getByRole('button', { name: /^сохранить$/i })).toBeDisabled();
    await expect(page.getByRole('button', { name: /^отменить$/i })).toBeDisabled();
    await expect(page.getByRole('button', { name: /^повторить$/i })).toBeDisabled();
    const handle = page.locator('[data-boundary="0"]');
    const brollSelect = page.locator('[data-broll-select]').first();
    await expect(handle).toBeDisabled();
    await expect(brollSelect).toBeDisabled();
    const discard = page.getByRole('button', {
      name: /отбросить устаревшие правки и продолжить/i,
    });
    await expect(discard).toBeVisible();
    await expect(discard).toBeDisabled();
    await expect(page.getByRole('alert')).toContainText(/не удалось загрузить/i);

    await brollSelect.evaluate((select) => {
      select.disabled = false;
      select.value = Array.from(select.options).find((option) => option.value)?.value || '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(150);
    expect(browserValidations).toHaveLength(1);
  });
});

test('validate conflict locks immediately and resumes only from the loaded fresh state', async ({ page }) => {
  await withBrowserReviewSession({
    editable: true,
    threeScenes: true,
    broll: true,
  }, async (session) => {
    const browserValidations = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/validate')) browserValidations.push(request);
    });
    await openReview(page, session.url);
    await waitForEditReady(page);
    await saveExternalBoundary(session, 2.4);

    let reportReload;
    const reloadRequested = new Promise((resolve) => { reportReload = resolve; });
    let releaseReload;
    const allowReload = new Promise((resolve) => { releaseReload = resolve; });
    await page.route('**/api/state', async (route) => {
      reportReload();
      await allowReload;
      await route.continue();
    });

    const conflictResponse = page.waitForResponse((response) => (
      response.url().endsWith('/api/validate') && response.status() === 409
    ));
    const initialHandle = page.locator('[data-boundary="0"]');
    await initialHandle.focus();
    await initialHandle.press('ArrowRight');
    await conflictResponse;
    await reloadRequested;

    const reloadSuccess = page.waitForResponse((response) => (
      response.url().endsWith('/api/state') && response.status() === 200
    ));
    try {
      await expect(page.locator('[data-conflict]')).toContainText(/устаревш.*не.*примен/i);
      await expect(page.locator('[data-edit-status]')).toContainText(/устаревш.*1/i);
      await expect(page.getByRole('button', { name: /^сохранить$/i })).toBeDisabled();
      await expect(page.getByRole('button', { name: /^отменить$/i })).toBeDisabled();
      await expect(page.getByRole('button', { name: /^повторить$/i })).toBeDisabled();
      const lockedHandle = page.locator('[data-boundary="0"]');
      const lockedBroll = page.locator('[data-broll-select]').first();
      await expect(lockedHandle).toBeDisabled();
      await expect(lockedBroll).toBeDisabled();
      const discard = page.getByRole('button', {
        name: /отбросить устаревшие правки и продолжить/i,
      });
      await expect(discard).toBeVisible();
      await expect(discard).toBeDisabled();
      expect(browserValidations).toHaveLength(1);

      await lockedHandle.evaluate((handle) => {
        handle.disabled = false;
        handle.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          bubbles: true,
        }));
      });
      await page.waitForTimeout(150);
      expect(browserValidations).toHaveLength(1);
    } finally {
      releaseReload();
    }
    await reloadSuccess;

    await expect(page.locator('[data-revision]')).toContainText('v02');
    const discard = page.getByRole('button', {
      name: /отбросить устаревшие правки и продолжить/i,
    });
    await expect(discard).toBeEnabled();
    await discard.click();
    const freshHandle = page.locator('[data-boundary="0"]');
    await expect(freshHandle).toBeEnabled();

    const freshValidation = page.waitForResponse((response) => (
      response.url().endsWith('/api/validate') && response.status() === 200
    ));
    await freshHandle.focus();
    await freshHandle.press('ArrowRight');
    await freshValidation;

    expect(browserValidations).toHaveLength(2);
    expect(browserValidations[1].postDataJSON().commands).toEqual([{
      type: 'move-boundary',
      leftSceneIndex: 0,
      seconds: 2.44,
    }]);
  });
});

test('boundary slider exposes frame-snapped accessible values and marks only the reported scene edge invalid', async ({ page }) => {
  await withBrowserReviewSession({ editable: true, threeScenes: true }, async (session) => {
    await page.route('**/api/validate', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.timing.errors = [{ sceneIndex: 0, message: 'Первая сцена содержит ошибку тайминга' }];
      await route.fulfill({ response, json: body });
    });
    await openReview(page, session.url);
    await waitForEditReady(page);

    const first = page.locator('[data-boundary="0"]');
    const second = page.locator('[data-boundary="1"]');
    await expect(first).toHaveAttribute('role', 'slider');
    await expect(first).toHaveAttribute('aria-valuemin', '0.04');
    await expect(first).toHaveAttribute('aria-valuemax', '3.96');
    await expect(first).toHaveAttribute('aria-valuenow', '2');
    await expect(first).toHaveAttribute('aria-valuetext', '00:02.000');

    const validated = page.waitForResponse((response) => (
      response.url().endsWith('/api/validate') && response.status() === 200
    ));
    await first.focus();
    await first.press('ArrowRight');
    await validated;
    await expect(first).toBeFocused();
    await expect(first).toHaveAttribute('aria-valuenow', '2.04');
    await expect(first).toHaveAttribute('aria-valuetext', '00:02.040');
    await expect(first).toHaveAttribute('data-invalid', 'true');
    await expect(first).toHaveAttribute('aria-invalid', 'true');
    await expect(second).not.toHaveAttribute('data-invalid', 'true');
    await expect(second).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('button', { name: /^сохранить$/i })).toBeDisabled();
  });
});

test('boundary slider keyboard exposes attainable frame limits and preserves cumulative validated state', async ({ page }) => {
  await withBrowserReviewSession({ editable: true, threeScenes: true }, async (session) => {
    const validationBodies = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/validate')) validationBodies.push(request.postDataJSON());
    });
    await openReview(page, session.url);
    await waitForEditReady(page);

    const first = page.locator('[data-boundary="0"]');
    const second = page.locator('[data-boundary="1"]');
    const pressAndValidate = async (key) => {
      const validated = page.waitForResponse((response) => (
        response.url().endsWith('/api/validate') && response.status() === 200
      ));
      await first.press(key);
      await validated;
      await expect(first).toBeFocused();
    };

    await first.focus();
    await pressAndValidate('ArrowUp');
    await expect(first).toHaveAttribute('aria-valuenow', '2.04');
    await expect(first).toHaveAttribute('aria-valuetext', '00:02.040');

    await pressAndValidate('ArrowDown');
    await expect(first).toHaveAttribute('aria-valuenow', '2');
    await expect(first).toHaveAttribute('aria-valuetext', '00:02.000');
    await expect(first).toHaveAttribute('aria-valuemin', '0.04');
    await expect(first).toHaveAttribute('aria-valuemax', '3.96');
    await expect(second).toHaveAttribute('aria-valuemin', '2.04');
    await expect(second).toHaveAttribute('aria-valuemax', '5.96');

    await pressAndValidate('Home');
    await expect(first).toHaveAttribute('aria-valuenow', '0.04');
    await expect(first).toHaveAttribute('aria-valuetext', '00:00.040');
    await expect(page.locator('[data-scene="0"]')).toHaveAttribute('data-end', '0.04');
    await expect(page.locator('[data-scene="1"]')).toHaveAttribute('data-start', '0.04');

    const undone = page.waitForResponse((response) => (
      response.url().endsWith('/api/validate') && response.status() === 200
    ));
    await page.getByRole('button', { name: /^отменить$/i }).click();
    await undone;
    await expect(first).toHaveAttribute('aria-valuemin', '0.04');
    await expect(first).toHaveAttribute('aria-valuemax', '3.96');
    await expect(first).toHaveAttribute('aria-valuenow', '2');
    await expect(first).toHaveAttribute('aria-valuetext', '00:02.000');
    await expect(second).toHaveAttribute('aria-valuemin', '2.04');
    await expect(second).toHaveAttribute('aria-valuemax', '5.96');

    const redone = page.waitForResponse((response) => (
      response.url().endsWith('/api/validate') && response.status() === 200
    ));
    await page.getByRole('button', { name: /^повторить$/i }).click();
    await redone;
    await expect(first).toHaveAttribute('aria-valuemin', '0.04');
    await expect(first).toHaveAttribute('aria-valuemax', '3.96');
    await expect(first).toHaveAttribute('aria-valuenow', '0.04');
    await expect(first).toHaveAttribute('aria-valuetext', '00:00.040');
    await expect(second).toHaveAttribute('aria-valuemin', '0.08');
    await expect(second).toHaveAttribute('aria-valuemax', '5.96');

    await first.focus();
    await pressAndValidate('End');
    await expect(first).toHaveAttribute('aria-valuenow', '3.96');
    await expect(first).toHaveAttribute('aria-valuetext', '00:03.960');
    await expect(second).toHaveAttribute('aria-valuemin', '4');
    await expect(second).toHaveAttribute('aria-valuemax', '5.96');
    await expect(page.locator('[data-scene="0"]')).toHaveAttribute('data-end', '3.96');
    await expect(page.locator('[data-scene="1"]')).toHaveAttribute('data-start', '3.96');

    expect(validationBodies.at(-1).commands).toEqual([
      { type: 'move-boundary', leftSceneIndex: 0, seconds: 2.04 },
      { type: 'move-boundary', leftSceneIndex: 0, seconds: 2 },
      { type: 'move-boundary', leftSceneIndex: 0, seconds: 0.04 },
      { type: 'move-boundary', leftSceneIndex: 0, seconds: 3.96 },
    ]);
  });
});

test('pending validation announces busy state and locks every mutation control', async ({ page }) => {
  await withBrowserReviewSession({ editable: true, threeScenes: true, broll: true }, async (session) => {
    await page.route('**/api/validate', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    });
    await openReview(page, session.url);
    await waitForEditReady(page);
    const request = page.waitForRequest((candidate) => candidate.url().endsWith('/api/validate'));
    await page.locator('[data-boundary="0"]').press('ArrowRight');
    await request;

    await expect(page.locator('[data-edit-controls]')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('[data-edit-status]')).toContainText(/проверяем изменения/i);
    await expect(page.locator('[data-boundary="0"]')).toBeDisabled();
    await expect(page.locator('[data-broll-select]')).toBeDisabled();
    await expect(page.getByRole('button', { name: /^отменить$/i })).toBeDisabled();
    await expect(page.getByRole('button', { name: /^повторить$/i })).toBeDisabled();
    await expect(page.getByRole('button', { name: /^сохранить$/i })).toBeDisabled();
    await expect(page.getByRole('button', { name: /добавить медиа/i })).toBeDisabled();
    await expect(page.locator('[data-media-input]')).toBeDisabled();
    await expect(page.locator('[data-media-input]')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('[data-edit-controls]')).toHaveAttribute('aria-busy', 'false');
  });
});

test('video preview position survives validation settings undo and redo rerenders', async ({ page }) => {
  test.setTimeout(120_000);
  const media = makeBrowserImportFixtures();
  await withBrowserReviewSession({ editable: true, threeScenes: true, broll: true }, async (session) => {
    await openReview(page, session.url);
    await waitForEditReady(page);
    await importFileFromBrowser(page, media.mp4);
    const scene = page.locator('[data-broll-scene="1"]');
    await scene.locator('[data-broll-select]').selectOption({ label: 'browser-with-audio.mp4' });
    let preview = scene.locator('video[data-broll-video]');
    await expect.poll(() => preview.evaluate((video) => video.readyState)).toBeGreaterThan(0);
    await preview.evaluate((video) => { video.currentTime = 0.419; });
    await expect.poll(() => preview.evaluate((video) => video.currentTime)).toBeCloseTo(0.419, 2);

    const startValidated = page.waitForResponse((response) => response.url().endsWith('/api/validate'));
    await scene.getByRole('button', { name: /начать с текущего места/i }).click();
    await startValidated;
    preview = scene.locator('video[data-broll-video]');
    await expect.poll(() => preview.evaluate((video) => video.currentTime)).toBeCloseTo(0.419, 2);

    const fitValidated = page.waitForResponse((response) => response.url().endsWith('/api/validate'));
    await scene.locator('[data-broll-fit]').selectOption('cover');
    await fitValidated;
    await expect.poll(() => scene.locator('video[data-broll-video]').evaluate((video) => video.currentTime))
      .toBeCloseTo(0.419, 2);
    await page.getByRole('button', { name: /^отменить$/i }).click();
    await expect.poll(() => scene.locator('video[data-broll-video]').evaluate((video) => video.currentTime))
      .toBeCloseTo(0.419, 2);
    await page.getByRole('button', { name: /^повторить$/i }).click();
    await expect.poll(() => scene.locator('video[data-broll-video]').evaluate((video) => video.currentTime))
      .toBeCloseTo(0.419, 2);
  });
});

test('video b-roll shows the server-confirmed used interval and updates it after boundary undo redo', async ({ page }) => {
  test.setTimeout(120_000);
  const media = makeBrowserImportFixtures();
  await withBrowserReviewSession({ editable: true, threeScenes: true, broll: true }, async (session) => {
    await openReview(page, session.url);
    await waitForEditReady(page);
    await importFileFromBrowser(page, media.mp4);
    const scene = page.locator('[data-broll-scene="1"]');
    await scene.locator('[data-broll-select]').selectOption({ label: 'browser-with-audio.mp4' });
    const preview = scene.locator('video[data-broll-video]');
    await expect.poll(() => preview.evaluate((video) => video.readyState)).toBeGreaterThan(0);
    await preview.evaluate((video) => { video.currentTime = 0.419; });
    await scene.getByRole('button', { name: /начать с текущего места/i }).click();
    await expect(scene.locator('[data-broll-used-interval]')).toHaveText(
      'Используется: 00:00.400–00:02.400',
    );

    await dragBoundary(page, 1, 4.4);
    await expect(scene.locator('[data-broll-used-interval]')).toHaveText(
      'Используется: 00:00.400–00:02.800',
    );
    await page.getByRole('button', { name: /^отменить$/i }).click();
    await expect(scene.locator('[data-broll-used-interval]')).toHaveText(
      'Используется: 00:00.400–00:02.400',
    );
    await page.getByRole('button', { name: /^повторить$/i }).click();
    await expect(scene.locator('[data-broll-used-interval]')).toHaveText(
      'Используется: 00:00.400–00:02.800',
    );
  });
});

test('committed import refresh failure reports the commit truth and preserves local edits', async ({ page }) => {
  test.setTimeout(120_000);
  const media = makeBrowserImportFixtures();
  await withBrowserReviewSession({ editable: true, threeScenes: true, broll: true }, async (session) => {
    await openReview(page, session.url);
    await waitForEditReady(page);
    await dragBoundary(page, 0, 2.1);
    await expect(page.locator('[data-server-diff]')).toContainText('Граница сцен 1–2');
    await expect(page.getByRole('button', { name: /^отменить$/i })).toBeEnabled();
    const selectedBefore = await page.locator('[data-broll-select]').inputValue();
    await page.route('**/api/state', (route) => route.abort('failed'));
    const committed = page.waitForResponse((response) => response.url().endsWith('/api/assets/import'));
    await page.locator('[data-media-input]').setInputFiles(media.webm);
    expect((await committed).status()).toBe(201);

    const status = page.locator('[data-media-import-status]');
    await expect(status).toHaveAttribute('data-phase', 'committed-refresh-error');
    await expect(status).toContainText(/файл добавлен.*экран не обновился.*перезагрузите/i);
    await expect(status).not.toContainText(/не удалось добавить|импорт не удался/i);
    await expect(page.locator('[data-media-progress]')).toBeHidden();
    await expect(page.locator('[data-broll-select]')).toHaveValue(selectedBefore);
    await expect(page.locator('[data-server-diff]')).toContainText('Граница сцен 1–2');
    await expect(page.getByRole('button', { name: /^отменить$/i })).toBeEnabled();
    await expect(page.getByRole('button', { name: /добавить медиа/i })).toBeEnabled();
    await page.unroute('**/api/state');
  });
});

test('large media collection stays horizontally contained and the last asset is reachable at 360px', async ({ page }) => {
  await withBrowserReviewSession({ editable: true, threeScenes: true, broll: true, assetCount: 20 }, async (session) => {
    await page.setViewportSize({ width: 360, height: 900 });
    await openReview(page, session.url);
    await waitForEditReady(page);
    await expectNoPageOverflow(page);
    await expect.poll(() => page.locator('[data-assets] .asset-chip').count()).toBeGreaterThanOrEqual(20);
    const list = page.locator('[data-assets]');
    const layout = await list.evaluate((element) => {
      const style = getComputedStyle(element);
      return { overflowX: style.overflowX, flexWrap: style.flexWrap };
    });
    expect(layout.overflowX === 'auto' || layout.overflowX === 'scroll' || layout.flexWrap === 'wrap').toBe(true);
    const last = page.locator('[data-asset-label]', { hasText: 'media-20.png' });
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeVisible();
    const reachable = await last.evaluate((element) => {
      const item = element.closest('.asset-chip').getBoundingClientRect();
      const lane = element.closest('[data-lane="assets"]').getBoundingClientRect();
      return item.width >= 120 && item.left >= lane.left && item.right <= lane.right;
    });
    expect(reachable).toBe(true);
  });
});

test('m4v browser file uses the server contract MIME and succeeds through the real route', async ({ page }) => {
  test.setTimeout(120_000);
  const media = makeBrowserImportFixtures();
  await withBrowserReviewSession({ editable: true, threeScenes: true, broll: true }, async (session) => {
    let uploadType = null;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/assets/import')) uploadType = request.headers()['content-type'];
    });
    await openReview(page, session.url);
    await waitForEditReady(page);
    const response = page.waitForResponse((candidate) => (
      candidate.url().endsWith('/api/assets/import') && candidate.request().method() === 'POST'
    ));
    await page.locator('[data-media-input]').setInputFiles({
      name: 'browser-copy.m4v',
      mimeType: 'video/mp4',
      buffer: fs.readFileSync(media.mp4),
    });
    expect((await response).status()).toBe(201);
    expect(uploadType).toBe('video/x-m4v');
    await expect(page.locator('[data-media-import-status]')).toHaveAttribute('data-phase', 'success');
  });
});

test('media import control is edit-only and keeps the read-only surface inert', async ({ page }) => {
  await openReview(page);
  await expect(page.getByRole('button', { name: /добавить медиа/i })).toHaveCount(0);
  await expect(page.locator('[data-media-input], [data-media-import]')).toHaveCount(0);

  await withBrowserReviewSession({ editable: true, threeScenes: true, broll: true }, async (session) => {
    await openReview(page, session.url);
    await waitForEditReady(page);
    await expect(page.getByRole('button', { name: /добавить медиа/i })).toBeVisible();
    await expect(page.locator('[data-media-input]')).toHaveAttribute(
      'accept',
      '.avif,.gif,.jpeg,.jpg,.png,.webp,.mp4,.mov,.m4v,.webm',
    );
  });
});

test('keyboard tab order skips the hidden media input and reaches the next named visible control', async ({ page }) => {
  await withBrowserReviewSession({ editable: true, threeScenes: true, broll: true }, async (session) => {
    await openReview(page, session.url);
    await waitForEditReady(page);

    const addMedia = page.getByRole('button', { name: /добавить медиа/i });
    const mediaInput = page.locator('[data-media-input]');
    const sceneMedia = page.getByRole('combobox', { name: 'Сцена 2' });
    await addMedia.focus();
    await page.keyboard.press('Tab');

    await expect(mediaInput).not.toBeFocused();
    await expect(sceneMedia).toBeFocused();
    await expect(mediaInput).toHaveAttribute('tabindex', '-1');
    await expect(mediaInput).toHaveAttribute('aria-hidden', 'true');
    expect(await mediaInput.ariaSnapshot()).toBe('');
  });
});

test('Enter and Space on the named Add media button complete real browser imports', async ({ page }) => {
  test.setTimeout(120_000);
  const media = makeBrowserImportFixtures();
  await withBrowserReviewSession({ editable: true, threeScenes: true, broll: true }, async (session) => {
    await openReview(page, session.url);
    await waitForEditReady(page);
    const addMedia = page.getByRole('button', { name: /добавить медиа/i });

    const importWithKey = async (key, filePath) => {
      await addMedia.focus();
      const chooserPromise = page.waitForEvent('filechooser');
      await addMedia.press(key);
      const chooser = await chooserPromise;
      const responsePromise = page.waitForResponse((response) => (
        response.url().endsWith('/api/assets/import')
        && response.request().method() === 'POST'
      ));
      await chooser.setFiles(filePath);
      expect((await responsePromise).status()).toBe(201);
      await expect(page.locator('[data-media-import-status]')).toHaveAttribute('data-phase', 'success');
      await expect(page.locator('[data-asset-label]', { hasText: path.basename(filePath) })).toBeVisible();
    };

    await importWithKey('Enter', media.mp4);
    await importWithKey('Space', media.webm);
  });
});

test('real JPEG media import shows bytes then processing and never auto-selects the thumbnail', async ({ page }) => {
  test.setTimeout(120_000);
  test.skip(!ffmpegEncoderAvailable('libwebp'), 'local ffmpeg lacks required libwebp image normalization');
  const media = makeBrowserImportFixtures();
  await withBrowserReviewSession({ editable: true, threeScenes: true, broll: true }, async (session) => {
    await openReview(page, session.url);
    await waitForEditReady(page);
    const selectedBefore = await page.locator('[data-broll-select]').inputValue();
    await importFileFromBrowser(page, media.jpeg);
    const imported = page.locator('[data-asset-label]', { hasText: 'browser-image.jpg' });
    await expect(imported).toHaveCount(1);
    await expect(imported.locator('xpath=ancestor::li[1]').locator('img[data-asset-image]')).toBeVisible();
    await expect(page.locator('[data-broll-select]')).toHaveValue(selectedBefore);
    await expect(page.locator('[data-edit-status]')).toHaveText('Изменений нет');
  });
});

test('real MP4 MOV and VP8 WebM media import use only playable authenticated proxies', async ({ page }) => {
  test.setTimeout(180_000);
  const media = makeBrowserImportFixtures();
  await withBrowserReviewSession({ editable: true, threeScenes: true, broll: true }, async (session) => {
    await openReview(page, session.url);
    await waitForEditReady(page);
    const selectedBefore = await page.locator('[data-broll-select]').inputValue();
    await recordImportPhases(page);
    for (const filePath of [media.slow, media.mov, media.webm]) {
      await importFileFromBrowser(page, filePath);
      await expect(page.locator('[data-broll-select]')).toHaveValue(selectedBefore);
      await expect(page.locator('[data-edit-status]')).toHaveText('Изменений нет');
    }

    const phases = await page.evaluate(() => window.__importPhaseLog);
    const positiveUpload = phases.findIndex((phase) => (
      phase.phase === 'uploading'
      && phase.hidden === false
      && phase.hasValue === true
      && Number(phase.value) > 0
    ));
    const processing = phases.findIndex((phase, index) => (
      index > positiveUpload
      && phase.phase === 'processing'
      && phase.hidden === false
      && phase.hasValue === false
    ));
    const terminal = phases.findIndex((phase, index) => (
      index > processing
      && phase.phase === 'success'
      && phase.hidden === true
      && phase.hasValue === false
    ));
    expect(positiveUpload).toBeGreaterThanOrEqual(0);
    expect(processing).toBeGreaterThan(positiveUpload);
    expect(terminal).toBeGreaterThan(processing);
    await expect(page.locator('[data-media-progress]')).toBeHidden();
    await expect(page.locator('[data-media-progress]')).not.toHaveAttribute('value');
    await expect(page.locator('[data-media-import-status]')).toHaveAttribute('data-phase', 'success');

    const importedVideos = page.locator('video[data-asset-video]');
    await expect(importedVideos).toHaveCount(3);
    for (let index = 0; index < 3; index += 1) {
      const source = new URL(await importedVideos.nth(index).getAttribute('src'), session.origin);
      expect(source.pathname).toMatch(/^\/media\/assets\/asset-[1-9]\d*\/preview$/);
      expect(source.searchParams.get('token')).toBe(session.token);
      await expect.poll(() => importedVideos.nth(index).evaluate((video) => video.readyState))
        .toBeGreaterThan(0);
    }
    await expect(page.locator('[data-assets]')).toContainText('со звуком');
    await expect(page.locator('[data-assets]')).toContainText('без звука');
    const browserSurface = await page.locator('body').innerHTML();
    expect(browserSurface).not.toContain('assets/broll/video');
    expect(browserSurface).not.toMatch(/[a-f0-9]{64}/);
    expect(browserSurface).not.toMatch(/(?:\/Users\/|[A-Za-z]:\\)/);
  });
});

test('video b-roll defaults and fit start audio commands round-trip through validation undo and redo', async ({ page }) => {
  test.setTimeout(120_000);
  const media = makeBrowserImportFixtures();
  await withBrowserReviewSession({ editable: true, threeScenes: true, broll: true }, async (session) => {
    const validationBodies = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/validate')) validationBodies.push(request.postDataJSON());
    });
    await openReview(page, session.url);
    await waitForEditReady(page);
    await importFileFromBrowser(page, media.mp4);
    const select = page.locator('[data-broll-select]');
    const selected = page.waitForResponse((response) => (
      response.url().endsWith('/api/validate') && response.status() === 200
    ));
    await select.selectOption({ label: 'browser-with-audio.mp4' });
    await selected;
    await expect(select).toBeFocused();

    const sceneControls = page.locator('[data-broll-scene="1"]');
    const preview = sceneControls.locator('video[data-broll-video]');
    await expect(preview).toBeVisible();
    await expect(sceneControls.locator('[data-broll-fit]')).toHaveValue('contain');
    await expect(sceneControls.locator('[data-broll-start]')).toHaveText(/00:00\.000/);
    await expect(sceneControls.locator('[data-broll-audio]')).toHaveValue('mute');
    await expect(sceneControls.locator('[data-broll-audio] option')).toHaveText([
      'Без звука',
      'Тихо поверх голоса',
      'Вместо голоса',
    ]);
    await expect(page.locator('[data-server-diff]')).toContainText(/вписать целиком/i);

    await preview.evaluate((video) => { video.currentTime = 0.419; });
    const startValidated = page.waitForResponse((response) => (
      response.url().endsWith('/api/validate') && response.status() === 200
    ));
    await sceneControls.getByRole('button', { name: /начать с текущего места/i }).click();
    await startValidated;
    expect(validationBodies.at(-1).commands.at(-1)).toEqual({
      type: 'set-broll-video-start', sceneIndex: 1, trimStartSec: expect.closeTo(0.419, 3),
    });
    await expect(sceneControls.locator('[data-broll-start]')).toHaveText('00:00.400');

    const fitValidated = page.waitForResponse((response) => response.url().endsWith('/api/validate'));
    await sceneControls.locator('[data-broll-fit]').selectOption('cover');
    await fitValidated;
    expect(validationBodies.at(-1).commands.at(-1)).toEqual({
      type: 'set-broll-fit', sceneIndex: 1, fit: 'cover',
    });
    await expect(sceneControls.locator('[data-broll-fit]')).toHaveValue('cover');
    await expect(sceneControls.locator('[data-broll-fit]')).toBeFocused();
    const audioValidated = page.waitForResponse((response) => response.url().endsWith('/api/validate'));
    await sceneControls.locator('[data-broll-audio]').selectOption('mix');
    await audioValidated;
    await expect(sceneControls.locator('[data-broll-audio]')).toBeFocused();
    await expect(page.locator('[data-server-diff]')).toContainText(/тихо поверх голоса/i);
    await expect(page.locator('[data-server-diff]')).toContainText('00:00.400');

    await page.getByRole('button', { name: /^отменить$/i }).click();
    await expect(sceneControls.locator('[data-broll-audio]')).toHaveValue('mute');
    await page.getByRole('button', { name: /^отменить$/i }).click();
    await expect(sceneControls.locator('[data-broll-fit]')).toHaveValue('contain');
    await page.getByRole('button', { name: /^повторить$/i }).click();
    await expect(sceneControls.locator('[data-broll-fit]')).toHaveValue('cover');
    await page.getByRole('button', { name: /^отменить$/i }).click();
    await expect(sceneControls.locator('[data-broll-fit]')).toHaveValue('contain');
    await page.getByRole('button', { name: /^отменить$/i }).click();
    await expect(sceneControls.locator('[data-broll-start]')).toHaveText('00:00.000');
    await page.getByRole('button', { name: /^повторить$/i }).click();
    await expect(sceneControls.locator('[data-broll-start]')).toHaveText('00:00.400');
    await page.getByRole('button', { name: /^повторить$/i }).click();
    await expect(sceneControls.locator('[data-broll-fit]')).toHaveValue('cover');
    await page.getByRole('button', { name: /^повторить$/i }).click();
    await expect(sceneControls.locator('[data-broll-audio]')).toHaveValue('mix');
  });
});

test('silent video b-roll disables ineligible audio and renders hostile labels as text only', async ({ page }) => {
  test.setTimeout(120_000);
  const media = makeBrowserImportFixtures();
  const hostile = path.join(path.dirname(media.webm), '<img onerror=alert(1)>.webm');
  fs.copyFileSync(media.webm, hostile);
  await withBrowserReviewSession({ editable: true, threeScenes: true, broll: true }, async (session) => {
    await page.setViewportSize({ width: 360, height: 900 });
    await page.addInitScript(() => {
      window.__assetXss = 0;
      window.alert = () => { window.__assetXss += 1; };
    });
    await openReview(page, session.url);
    await waitForEditReady(page);
    await importFileFromBrowser(page, hostile);
    await page.locator('[data-broll-select]').selectOption({ label: path.basename(hostile) });
    const controls = page.locator('[data-broll-scene="1"]');
    await expect(controls.locator('[data-broll-audio] option[value="mix"]')).toHaveAttribute('disabled', '');
    await expect(controls.locator('[data-broll-audio] option[value="replace"]')).toHaveAttribute('disabled', '');
    await expect(controls.locator('[data-broll-audio]')).toHaveValue('mute');
    await expect(page.locator('[data-assets] img[onerror]')).toHaveCount(0);
    expect(await page.evaluate(() => window.__assetXss)).toBe(0);
    await expect(page.locator('[data-asset-label]', { hasText: '<img onerror=alert(1)>.webm' })).toHaveCount(1);
    await expectNoPageOverflow(page);
  });
});

test('media import owns the mutation lock, blocks a second import and abort restores the existing diff', async ({ page }) => {
  test.setTimeout(120_000);
  const media = makeBrowserImportFixtures();
  await withBrowserReviewSession({ editable: true, threeScenes: true, broll: true }, async (session) => {
    const importRequests = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/assets/import')) importRequests.push(request);
    });
    await openReview(page, session.url);
    await waitForEditReady(page);
    await dragBoundary(page, 0, 2.1);
    await expect(page.locator('[data-server-diff]')).toContainText('Граница сцен 1–2');

    await page.locator('[data-media-input]').setInputFiles(media.slow);
    await expect(page.locator('[data-media-import-status]')).toContainText(/проверяем/i);
    await expect(page.locator('[data-boundary="0"]')).toBeDisabled();
    await expect(page.locator('[data-broll-select]')).toBeDisabled();
    await expect(page.getByRole('button', { name: /^отменить$/i })).toBeDisabled();
    await expect(page.getByRole('button', { name: /^повторить$/i })).toBeDisabled();
    await expect(page.getByRole('button', { name: /^сохранить$/i })).toBeDisabled();
    await expect(page.getByRole('button', { name: /добавить медиа/i })).toBeDisabled();
    await expect(page.locator('[data-media-input]')).toBeDisabled();
    await page.locator('[data-media-input]').evaluate((input) => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(100);
    expect(importRequests).toHaveLength(1);

    await page.getByRole('button', { name: /отменить загрузку/i }).click();
    await expect(page.locator('[data-media-import-status]')).toContainText(/отменена/i);
    await expect(page.locator('[data-media-import-status]')).toHaveAttribute('data-phase', 'aborted');
    await expect(page.locator('[data-media-progress]')).toBeHidden();
    await expect(page.locator('[data-media-progress]')).not.toHaveAttribute('value');
    await expect(page.locator('[data-boundary="0"]')).toBeEnabled();
    await expect(page.locator('[data-broll-select]')).toBeEnabled();
    await expect(page.getByRole('button', { name: /^отменить$/i })).toBeEnabled();
    await expect(page.locator('[data-server-diff]')).toContainText('Граница сцен 1–2');
    await expect(page.locator('[data-edit-status]')).toContainText(/изменени[йя]: 1/i);
  });
});

test('concurrent tab busy import preserves unsaved commands diff and redo', async ({ page, context }) => {
  test.setTimeout(120_000);
  const media = makeBrowserImportFixtures();
  await withBrowserReviewSession({ editable: true, threeScenes: true, broll: true }, async (session) => {
    await openReview(page, session.url);
    await waitForEditReady(page);
    await dragBoundary(page, 0, 2.1);
    await expect(page.locator('[data-edit-status]')).toContainText(/изменени[йя]: 1/i);
    await dragBoundary(page, 0, 2.2);
    await expect(page.locator('[data-edit-status]')).toContainText(/изменени[йя]: 2/i);
    await page.getByRole('button', { name: /^отменить$/i }).click();
    await expect(page.locator('[data-edit-status]')).toContainText(/изменени[йя]: 1/i);
    await expect(page.locator('[data-server-diff]')).toContainText('Граница сцен 1–2');
    await expect(page.getByRole('button', { name: /^повторить$/i })).toBeEnabled();

    const other = await context.newPage();
    try {
      await openReview(other, session.url);
      await waitForEditReady(other);
      await other.locator('[data-media-input]').setInputFiles(media.slow);
      await expect(other.locator('[data-media-import-status]')).toContainText(/проверяем/i);

      const busyResponse = page.waitForResponse((response) => (
        response.url().endsWith('/api/assets/import') && response.status() === 409
      ));
      await page.locator('[data-media-input]').setInputFiles(media.webm);
      await busyResponse;

      await expect(page.locator('[data-media-import-status]')).toHaveAttribute('data-phase', 'error');
      await expect(page.locator('[data-media-import-status]')).toContainText(/другой файл|повторите/i);
      await expect(page.locator('[data-media-progress]')).toBeHidden();
      await expect(page.locator('[data-media-progress]')).not.toHaveAttribute('value');
      await expect(page.locator('[data-conflict]')).toBeHidden();
      await expect(page.locator('[data-edit-status]')).toContainText(/изменени[йя]: 1/i);
      await expect(page.locator('[data-server-diff]')).toContainText('Граница сцен 1–2');
      await expect(page.locator('[data-transient-busy]')).toBeVisible();
      await expect(page.getByRole('button', { name: /^отменить$/i })).toBeDisabled();
      await expect(page.getByRole('button', { name: /^повторить$/i })).toBeDisabled();
      await expect(page.locator('[data-boundary="0"]')).toBeDisabled();
      await expect(page.getByRole('button', { name: /^сохранить$/i })).toBeDisabled();
      await expect(page.getByRole('button', { name: /добавить медиа/i })).toBeDisabled();

      const blockedRequests = [];
      page.on('request', (request) => {
        if (/\/api\/(?:validate|save)$/.test(new URL(request.url()).pathname)) blockedRequests.push(request);
      });
      await page.getByRole('button', { name: /^отменить$/i }).dispatchEvent('click');
      await page.getByRole('button', { name: /^повторить$/i }).dispatchEvent('click');
      await page.locator('[data-boundary="0"]').dispatchEvent('keydown', { key: 'ArrowRight' });
      await page.getByRole('button', { name: /^сохранить$/i }).dispatchEvent('click');
      await page.waitForTimeout(100);
      expect(blockedRequests).toHaveLength(0);

      const stillBusy = page.waitForResponse((response) => (
        response.url().endsWith('/api/validate') && response.status() === 409
      ));
      await page.getByRole('button', { name: /повторить проверку/i }).click();
      await stillBusy;
      await expect(page.locator('[data-transient-busy]')).toBeVisible();
      await expect(page.locator('[data-edit-status]')).toContainText(/изменени[йя]: 1/i);
      await expect(page.locator('[data-server-diff]')).toContainText('Граница сцен 1–2');

      await other.getByRole('button', { name: /отменить загрузку/i }).click();
      await expect(other.locator('[data-media-import-status]')).toHaveAttribute('data-phase', 'aborted');
      await page.waitForTimeout(500);
      const recovered = page.waitForResponse((response) => (
        response.url().endsWith('/api/validate') && response.status() === 200
      ));
      await page.getByRole('button', { name: /повторить проверку/i }).click();
      await recovered;
      await expect(page.locator('[data-transient-busy]')).toBeHidden();
      await expect(page.locator('[data-media-import-status]')).toHaveAttribute('data-phase', 'idle');
      await expect(page.getByRole('button', { name: /^отменить$/i })).toBeEnabled();
      await expect(page.getByRole('button', { name: /^повторить$/i })).toBeEnabled();
      await expect(page.locator('[data-boundary="0"]')).toBeEnabled();
    } finally {
      const abort = other.getByRole('button', { name: /отменить загрузку/i });
      if (await abort.isVisible()) await abort.click();
      await other.close();
    }
  });
});

test('busy validation rolls back undo redo and boundary attempts to the last verified edit', async ({ page, context }) => {
  test.setTimeout(180_000);
  const media = makeBrowserImportFixtures();
  await withBrowserReviewSession({ editable: true, threeScenes: true, broll: true }, async (session) => {
    await openReview(page, session.url);
    await waitForEditReady(page);
    await dragBoundary(page, 0, 2.1);
    await expect(page.locator('[data-edit-status]')).toContainText(/изменени[йя]: 1/i);
    await dragBoundary(page, 0, 2.2);
    await expect(page.locator('[data-edit-status]')).toContainText(/изменени[йя]: 2/i);
    await page.getByRole('button', { name: /^отменить$/i }).click();
    await expect(page.locator('[data-edit-status]')).toContainText(/изменени[йя]: 1/i);
    await expect(page.getByRole('button', { name: /^повторить$/i })).toBeEnabled();

    const other = await context.newPage();
    const expectQueuePreserved = async () => {
      await expect(page.locator('[data-edit-status]')).toContainText(/изменени[йя]: 1/i);
      await expect(page.locator('[data-server-diff]')).toContainText('Граница сцен 1–2');
      await expect(page.locator('[data-server-diff]')).toContainText('00:02.000 → 00:02.120');
      await expect(page.locator('[data-conflict]')).toBeHidden();
    };
    const beginOtherImport = async () => {
      await other.locator('[data-media-input]').setInputFiles(media.slow);
      await expect(other.locator('[data-media-import-status]')).toContainText(/проверяем/i);
    };
    const finishOtherImportAndRecover = async () => {
      await other.getByRole('button', { name: /отменить загрузку/i }).click();
      await expect(other.locator('[data-media-import-status]')).toHaveAttribute('data-phase', 'aborted');
      await page.waitForTimeout(500);
      const recovered = page.waitForResponse((response) => (
        response.url().endsWith('/api/validate') && response.status() === 200
      ));
      await page.getByRole('button', { name: /повторить проверку/i }).click();
      await recovered;
      await expect(page.locator('[data-transient-busy]')).toBeHidden();
      await expectQueuePreserved();
    };
    const exerciseBusyMutation = async (mutate) => {
      await beginOtherImport();
      const busy = page.waitForResponse((response) => (
        response.url().endsWith('/api/validate') && response.status() === 409
      ));
      await mutate();
      await busy;
      await expect(page.locator('[data-transient-busy]')).toBeVisible();
      await expectQueuePreserved();
      await finishOtherImportAndRecover();
    };

    try {
      await openReview(other, session.url);
      await waitForEditReady(other);
      await exerciseBusyMutation(() => page.getByRole('button', { name: /^отменить$/i }).click());
      await exerciseBusyMutation(() => page.getByRole('button', { name: /^повторить$/i }).click());
      await exerciseBusyMutation(() => dragBoundary(page, 0, 2.3));
      await expect(page.getByRole('button', { name: /^отменить$/i })).toBeEnabled();
      await expect(page.getByRole('button', { name: /^повторить$/i })).toBeEnabled();
    } finally {
      const abort = other.getByRole('button', { name: /отменить загрузку/i });
      if (await abort.isVisible()) await abort.click();
      await other.close();
    }
  });
});

test('busy save preserves verified edits and disk until the user explicitly retries save', async ({ page, context }) => {
  test.setTimeout(120_000);
  const media = makeBrowserImportFixtures();
  await withBrowserReviewSession({ editable: true, threeScenes: true, broll: true }, async (session) => {
    await openReview(page, session.url);
    await waitForEditReady(page);
    await dragBoundary(page, 0, 2.1);
    await expect(page.locator('[data-edit-status]')).toContainText(/изменени[йя]: 1/i);
    const briefBefore = fs.readFileSync(session.fixture.briefPath);
    const manifestBefore = fs.readFileSync(path.join(session.fixture.workspace.dir, 'project.json'));

    const other = await context.newPage();
    try {
      await openReview(other, session.url);
      await waitForEditReady(other);
      await other.locator('[data-media-input]').setInputFiles(media.slow);
      await expect(other.locator('[data-media-import-status]')).toContainText(/проверяем/i);

      const busySave = page.waitForResponse((response) => (
        response.url().endsWith('/api/save') && response.status() === 409
      ));
      page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: /^сохранить$/i }).click();
      await busySave;

      expect(fs.readFileSync(session.fixture.briefPath)).toEqual(briefBefore);
      expect(fs.readFileSync(path.join(session.fixture.workspace.dir, 'project.json'))).toEqual(manifestBefore);
      await expect(page.locator('[data-transient-busy]')).toBeVisible();
      await expect(page.locator('[data-conflict]')).toBeHidden();
      await expect(page.locator('[data-edit-status]')).toContainText(/изменени[йя]: 1/i);
      await expect(page.locator('[data-server-diff]')).toContainText('Граница сцен 1–2');

      await other.getByRole('button', { name: /отменить загрузку/i }).click();
      await expect(other.locator('[data-media-import-status]')).toHaveAttribute('data-phase', 'aborted');
      await page.waitForTimeout(500);
      const recovered = page.waitForResponse((response) => (
        response.url().endsWith('/api/validate') && response.status() === 200
      ));
      await page.getByRole('button', { name: /повторить проверку/i }).click();
      await recovered;

      await expect(page.locator('[data-transient-busy]')).toBeHidden();
      await expect(page.getByRole('button', { name: /^сохранить$/i })).toBeEnabled();
      expect(fs.readFileSync(session.fixture.briefPath)).toEqual(briefBefore);
      expect(fs.readFileSync(path.join(session.fixture.workspace.dir, 'project.json'))).toEqual(manifestBefore);
    } finally {
      const abort = other.getByRole('button', { name: /отменить загрузку/i });
      if (await abort.isVisible()) await abort.click();
      await other.close();
    }
  });
});

test('abort then immediate busy retry preserves unsaved commands diff and redo', async ({ page }) => {
  test.setTimeout(120_000);
  const media = makeBrowserImportFixtures();
  const delayedAbortProcess = async (options) => {
    try {
      return await runMediaProcess(options);
    } catch (error) {
      if (options.signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
      throw error;
    }
  };
  await withBrowserReviewSession({
    editable: true,
    threeScenes: true,
    broll: true,
    runMediaProcessImpl: delayedAbortProcess,
  }, async (session) => {
    await openReview(page, session.url);
    await waitForEditReady(page);
    await dragBoundary(page, 0, 2.1);
    await expect(page.locator('[data-edit-status]')).toContainText(/изменени[йя]: 1/i);
    await dragBoundary(page, 0, 2.2);
    await expect(page.locator('[data-edit-status]')).toContainText(/изменени[йя]: 2/i);
    await page.getByRole('button', { name: /^отменить$/i }).click();
    await expect(page.locator('[data-edit-status]')).toContainText(/изменени[йя]: 1/i);
    await expect(page.locator('[data-server-diff]')).toContainText('Граница сцен 1–2');
    await expect(page.getByRole('button', { name: /^повторить$/i })).toBeEnabled();

    await page.locator('[data-media-input]').setInputFiles(media.slow);
    await expect(page.locator('[data-media-import-status]')).toContainText(/проверяем/i);
    await page.getByRole('button', { name: /отменить загрузку/i }).click();
    await expect(page.locator('[data-media-import-status]')).toHaveAttribute('data-phase', 'aborted');
    await expect(page.locator('[data-media-progress]')).toBeHidden();
    await expect(page.locator('[data-media-progress]')).not.toHaveAttribute('value');

    const busyResponse = page.waitForResponse((response) => (
      response.url().endsWith('/api/assets/import') && response.status() === 409
    ));
    await page.locator('[data-media-input]').setInputFiles(media.webm);
    await busyResponse;

    await expect(page.locator('[data-media-import-status]')).toHaveAttribute('data-phase', 'error');
    await expect(page.locator('[data-media-import-status]')).toContainText(/другой файл|повторите/i);
    await expect(page.locator('[data-media-progress]')).toBeHidden();
    await expect(page.locator('[data-media-progress]')).not.toHaveAttribute('value');
    await expect(page.locator('[data-conflict]')).toBeHidden();
    await expect(page.locator('[data-edit-status]')).toContainText(/изменени[йя]: 1/i);
    await expect(page.locator('[data-server-diff]')).toContainText('Граница сцен 1–2');
    await expect(page.locator('[data-transient-busy]')).toBeVisible();
    await expect(page.getByRole('button', { name: /^отменить$/i })).toBeDisabled();
    await expect(page.getByRole('button', { name: /^повторить$/i })).toBeDisabled();

    await page.waitForTimeout(1_000);
    const recovered = page.waitForResponse((response) => (
      response.url().endsWith('/api/validate') && response.status() === 200
    ));
    await page.getByRole('button', { name: /повторить проверку/i }).click();
    await recovered;
    await expect(page.locator('[data-transient-busy]')).toBeHidden();
    await expect(page.getByRole('button', { name: /^отменить$/i })).toBeEnabled();
    await expect(page.getByRole('button', { name: /^повторить$/i })).toBeEnabled();
  });
});

test('busy import state refresh failure quarantines without erasing unsaved diff', async ({ page, context }) => {
  test.setTimeout(120_000);
  const media = makeBrowserImportFixtures();
  await withBrowserReviewSession({ editable: true, threeScenes: true, broll: true }, async (session) => {
    await openReview(page, session.url);
    await waitForEditReady(page);
    await dragBoundary(page, 0, 2.1);
    await expect(page.locator('[data-edit-status]')).toContainText(/изменени[йя]: 1/i);
    await expect(page.locator('[data-server-diff]')).toContainText('Граница сцен 1–2');

    const other = await context.newPage();
    try {
      await openReview(other, session.url);
      await waitForEditReady(other);
      await other.locator('[data-media-input]').setInputFiles(media.slow);
      await expect(other.locator('[data-media-import-status]')).toContainText(/проверяем/i);
      await page.route('**/api/state', (route) => route.abort('failed'));

      const busyResponse = page.waitForResponse((response) => (
        response.url().endsWith('/api/assets/import') && response.status() === 409
      ));
      await page.locator('[data-media-input]').setInputFiles(media.webm);
      await busyResponse;

      await expect(page.locator('[data-conflict]')).toContainText(/актуальность|карантин/i);
      await expect(page.getByRole('button', {
        name: /отбросить устаревшие правки и продолжить/i,
      })).toBeDisabled();
      await expect(page.locator('[data-edit-status]')).toContainText(/правки: 1/i);
      await expect(page.locator('[data-server-diff]')).toContainText('Граница сцен 1–2');
      await expect(page.locator('[data-boundary="0"]')).toBeDisabled();
      await expect(page.locator('[data-media-progress]')).toBeHidden();
      await expect(page.locator('[data-media-progress]')).not.toHaveAttribute('value');
    } finally {
      await page.unroute('**/api/state');
      const abort = other.getByRole('button', { name: /отменить загрузку/i });
      if (await abort.isVisible()) await abort.click();
      await other.close();
    }
  });
});

test('failed media import restores controls while committed import refresh enters explicit stale conflict quarantine', async ({ page }) => {
  test.setTimeout(120_000);
  const media = makeBrowserImportFixtures();
  const invalid = path.join(path.dirname(media.mp4), 'broken.mp4');
  fs.writeFileSync(invalid, 'not a video');
  await withBrowserReviewSession({ editable: true, threeScenes: true, broll: true }, async (session) => {
    await openReview(page, session.url);
    await waitForEditReady(page);
    await dragBoundary(page, 0, 2.1);
    await expect(page.locator('[data-server-diff]')).toContainText('Граница сцен 1–2');
    await expect(page.locator('[data-edit-status]')).toContainText(/изменени[йя]: 1/i);
    await page.locator('[data-media-input]').setInputFiles(invalid);
    await expect(page.locator('[data-media-import-status]')).toContainText(/не удалось/i);
    await expect(page.locator('[data-media-import-status]')).toHaveAttribute('data-phase', 'error');
    await expect(page.locator('[data-media-progress]')).toBeHidden();
    await expect(page.locator('[data-media-progress]')).not.toHaveAttribute('value');
    await expect(page.locator('[data-boundary="0"]')).toBeEnabled();
    await expect(page.locator('[data-broll-select]')).toBeEnabled();
    await expect(page.locator('[data-server-diff]')).toContainText('Граница сцен 1–2');
    await expect(page.locator('[data-edit-status]')).toContainText(/изменени[йя]: 1/i);
    await expect(page.getByRole('button', { name: /^отменить$/i })).toBeEnabled();
    await expect(page.getByRole('alert')).not.toContainText(/ffmpeg|Users|private/i);

    const diagram = path.join(session.fixture.workspace.dir, 'assets', 'broll', 'diagram.png');
    const original = path.join(session.fixture.workspace.dir, 'assets', 'broll', 'diagram.original');
    const changed = path.join(session.fixture.workspace.dir, 'assets', 'broll', 'diagram.changed');
    const fixtureBackup = path.join(
      session.fixture.workspace.dir,
      'assets',
      'broll',
      'diagram.fixture-backup',
    );
    fs.copyFileSync(diagram, original, fs.constants.COPYFILE_EXCL);
    const fixtureBackupIdentity = fs.lstatSync(original, { bigint: true });
    await saveExternalBoundary(session, 2.3);
    let changedIdentity = null;
    let restored = false;
    await page.route('**/api/state', async (route) => {
      if (!restored) {
        fs.renameSync(original, fixtureBackup);
        fs.renameSync(diagram, original);
        fs.writeFileSync(diagram, 'changed during intercepted state refresh');
        changedIdentity = fs.lstatSync(diagram, { bigint: true });
        fs.renameSync(diagram, changed);
        fs.renameSync(original, diagram);
        const backup = fs.lstatSync(fixtureBackup, { bigint: true });
        expect({ dev: backup.dev, ino: backup.ino }).toEqual({
          dev: fixtureBackupIdentity.dev,
          ino: fixtureBackupIdentity.ino,
        });
        fs.unlinkSync(fixtureBackup);
        restored = true;
      }
      await route.continue();
    });
    const committedResponse = page.waitForResponse((response) => (
      response.url().endsWith('/api/assets/import') && response.status() === 201
    ));
    await page.locator('[data-media-input]').setInputFiles(media.slow);
    await expect(page.locator('[data-media-import-status]')).toContainText(/проверяем/i);
    await committedResponse;
    await expect(page.locator('[data-conflict]')).toContainText(/конфликт/i);
    await expect(page.locator('[data-media-import-status]')).toHaveAttribute('data-phase', 'error');
    await expect(page.locator('[data-media-progress]')).toBeHidden();
    await expect(page.locator('[data-media-progress]')).not.toHaveAttribute('value');
    const discard = page.getByRole('button', {
      name: /отбросить устаревшие правки и продолжить/i,
    });
    await expect(discard).toBeVisible();
    await expect(discard).toBeEnabled();
    await expect(page.locator('[data-boundary="0"]')).toBeDisabled();
    await discard.click();
    await expect(page.locator('[data-conflict]')).toBeHidden();
    await expect(page.locator('[data-boundary="0"]')).toBeEnabled();
    const leftover = fs.lstatSync(changed, { bigint: true });
    expect(changedIdentity).not.toBeNull();
    expect({ dev: leftover.dev, ino: leftover.ino }).toEqual({
      dev: changedIdentity.dev,
      ino: changedIdentity.ino,
    });
    fs.unlinkSync(changed);
  });
});
