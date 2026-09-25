const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const { planPreview, publishCurrentPreview } = require('../scripts/project/preview-workspace');
const { createOrOpenProject, readProjectManifest } = require('../scripts/project/workspace');
const { acceptComment, readComments } = require('../scripts/pult/comments');
const { buildInbox, formatInbox } = require('../scripts/pult/inbox');
const { startPultServer } = require('../scripts/pult/server');
const { readPultState } = require('../scripts/pult/state');
const {
  ROOT, addDraftProject, addLegacyFolder, addSecondRevision, makePultRoot, sha256, unresolvedBrollScenes,
} = require('./helpers/pult-projects');

function fakeCapture(command, args) {
  if (command === 'ffprobe') {
    return {
      stdout: JSON.stringify({
        streams: [{ codec_type: 'video', width: 1080, height: 1920, r_frame_rate: '25/1' }],
        format: { duration: '4' },
      }),
    };
  }
  fs.writeFileSync(args.at(-1), 'jpg');
  return { stdout: '' };
}

// Двойник startReviewServer с той же формой ответа: server, token, origin, url и методы уборки.
async function fakeReview(calls, handler = (incoming, outgoing) => outgoing.end('review')) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const token = 'r'.repeat(43);
  return {
    server,
    token,
    origin,
    url: `${origin}/#token=${token}`,
    // Запоминаем, слушал ли Review в момент вызова: так видно порядок abort → close → wait.
    abortActiveImports() { calls.shutdown.push(['abort', server.listening]); },
    async waitForActiveImports() { calls.shutdown.push(['wait', server.listening]); },
  };
}

async function startTest(t, projectsDir, overrides = {}) {
  const calls = { reveal: [], windows: [], reviews: [], shutdown: [], logs: [] };
  const session = await startPultServer({
    projectsDir,
    idleMs: 0,
    captureImpl: fakeCapture,
    logger: { error: (message) => { calls.logs.push(String(message)); } },
    revealImpl: async (target) => { calls.reveal.push(target); },
    openWindowImpl: async (url) => { calls.windows.push(url); },
    startReviewServerImpl: async (options) => {
      calls.reviews.push(options);
      return fakeReview(calls);
    },
    ...overrides,
  });
  t.after(() => session.close());
  return { session, calls };
}

function request(session, pathname, {
  token, queryToken = false, method = 'GET', origin, body, rawBody, contentType = 'application/json', host, headers = {},
} = {}) {
  const suffix = queryToken && token ? `${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : '';
  const allHeaders = { ...headers };
  if (token && !queryToken) allHeaders.authorization = `Bearer ${token}`;
  if (origin) allHeaders.origin = origin;
  if (host) allHeaders.host = host;
  let payload = null;
  if (body !== undefined || rawBody !== undefined) {
    payload = rawBody !== undefined ? Buffer.from(rawBody) : Buffer.from(JSON.stringify(body));
    allHeaders['content-type'] = contentType;
    allHeaders['content-length'] = payload.length;
  }
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: '127.0.0.1',
      port: session.server.address().port,
      path: `${pathname}${suffix}`,
      method,
      headers: allHeaders,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buffer.toString('utf8')); } catch (_) { json = null; }
        resolve({ status: response.statusCode, headers: response.headers, body: buffer, json });
      });
    });
    outgoing.on('error', reject);
    if (payload) outgoing.write(payload);
    outgoing.end();
  });
}

const get = (session, pathname) => request(session, pathname, { token: session.token });
const post = (session, pathname, body) => request(session, pathname, {
  method: 'POST', token: session.token, origin: session.origin, body,
});

async function standardRoot(t) {
  const { projectsDir } = makePultRoot(t);
  addDraftProject(projectsDir, { folder: 'waiting-clip', name: 'Ждёт меня' });
  addDraftProject(projectsDir, { folder: 'ready-clip', name: 'Готовый', approve: true, final: true });
  addLegacyFolder(projectsDir, 'research', { files: { 'notes.md': '# notes' } });
  return projectsDir;
}

function waitingVariant(cards) {
  return cards.waiting[0].variants[0];
}

async function variantOf(session, key) {
  const cards = (await get(session, '/api/cards')).json;
  return [...cards.waiting, ...cards.working, ...cards.ready, ...cards.archive]
    .flatMap((card) => card.variants)
    .find((variant) => variant.key === key);
}

const approve = (session, key, ticket) => post(session, '/api/approve', { key, ticket, confirmPreviewViewed: true });

function approvedBriefs(projectsDir, folder) {
  return fs.readdirSync(path.join(projectsDir, folder, 'brief')).filter((name) => /-approved\./.test(name));
}

function previewFileOf(projectsDir, folder) {
  const manifest = readProjectManifest(path.join(projectsDir, folder));
  return path.join(projectsDir, folder, ...manifest.currentPreview.filePath.split('/'));
}

// JSON.stringify экранирует обратный слэш: на Windows «сырой» projectsDir (одиночные \)
// никогда не найдётся внутри уже сериализованного JSON-текста, даже если путь реально
// утёк – ищем и экранированную форму, как она выглядела бы внутри JSON-строки.
function assertNoPathLeak(text, projectsDir) {
  assert.ok(!text.includes(projectsDir), 'сырой путь утёк в ответ');
  assert.ok(!text.includes(JSON.stringify(projectsDir).slice(1, -1)), 'экранированный JSON-путь утёк в ответ');
}

// Новый полный preview того же черновика – как это делает агент после правки.
function republishFullPreview(projectsDir, folder, bytes) {
  const projectDir = path.join(projectsDir, folder);
  const workspace = createOrOpenProject({ projectDir });
  const manifest = readProjectManifest(projectDir);
  const briefFile = path.join(projectDir, ...manifest.currentBrief.split('/'));
  const plan = planPreview(workspace, {
    briefPath: briefFile,
    briefSha256: sha256(fs.readFileSync(briefFile)),
    range: { kind: 'full', fromSec: 0, toSec: 4 },
  });
  const staged = path.join(projectDir, 'previews', 'stage-next.mp4');
  fs.writeFileSync(staged, bytes);
  publishCurrentPreview(workspace, plan, staged, {
    width: 160, height: 90, fps: 25, generatedAt: '2026-09-20T11:00:00.000Z',
  });
}

test('health is public, minimal and host-checked', async (t) => {
  const { projectsDir } = makePultRoot(t);
  const { session } = await startTest(t, projectsDir);
  const health = await request(session, '/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { app: 'automontage-pult', version: 1 });
  assert.equal((await request(session, '/api/health', { host: 'evil.test' })).status, 403);
  assert.equal((await request(session, '/', { host: 'evil.test' })).status, 403);
});

test('the page loads without a token and carries a strict CSP', async (t) => {
  const { projectsDir } = makePultRoot(t);
  const { session } = await startTest(t, projectsDir);
  const page = await request(session, '/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);
});

test('the pult serves its own Onest font without a token, and only that exact path', async (t) => {
  const { projectsDir } = makePultRoot(t);
  const { session } = await startTest(t, projectsDir);
  const fontPath = path.join(ROOT, 'public', 'fonts', 'Onest.ttf');
  const font = await request(session, '/fonts/Onest.ttf');
  assert.equal(font.status, 200);
  assert.equal(font.headers['content-type'], 'font/ttf');
  assert.match(font.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(font.headers['x-content-type-options'], 'nosniff');
  assert.ok(font.body.equals(fs.readFileSync(fontPath)));
  // Похожие, но не совпадающие в точности пути не должны отдавать ничего лишнего:
  // другое имя, обход каталога, другой регистр, конечный слеш и настоящие соседние
  // файлы public/fonts/ (лицензия и другой шрифт) – белый список пропускает только
  // ровно один путь, а не всю папку.
  for (const pathname of [
    '/fonts/Other.ttf', '/fonts/../package.json', '/fonts/onest.ttf', '/fonts/Onest.ttf/',
    '/fonts/OFL-Onest.txt', '/fonts/JetBrainsMono.ttf',
  ]) {
    assert.equal((await request(session, pathname)).status, 404, pathname);
  }
});

test('API and media require the session token', async (t) => {
  const projectsDir = await standardRoot(t);
  const { session } = await startTest(t, projectsDir);
  assert.equal((await request(session, '/api/cards')).status, 401);
  assert.equal((await request(session, '/api/cards', { token: 'x'.repeat(43) })).status, 401);
  assert.equal((await request(session, '/api/cards?token=' + session.token)).status, 401);
  assert.equal((await get(session, '/api/cards')).status, 200);
  assert.equal((await request(session, '/media/video?key=waiting-clip')).status, 401);
});

test('mutations require the page origin', async (t) => {
  const projectsDir = await standardRoot(t);
  const { session } = await startTest(t, projectsDir);
  const body = { cardId: 'folder:ready-clip', archived: true };
  assert.equal((await request(session, '/api/archive', { method: 'POST', token: session.token, body })).status, 403);
  assert.equal((await request(session, '/api/archive', { method: 'POST', token: session.token, origin: 'http://evil.test', body })).status, 403);
  assert.equal((await post(session, '/api/archive', body)).status, 200);
});

test('cards list waiting videos first and never expose paths or hashes', async (t) => {
  const projectsDir = await standardRoot(t);
  const { session } = await startTest(t, projectsDir);
  const cards = (await get(session, '/api/cards')).json;
  assert.equal(cards.waiting[0].title, 'Ждёт меня');
  assert.equal(cards.ready[0].title, 'Готовый');
  assert.deepEqual(cards.unregistered, [{ folder: 'research' }]);
  assert.equal(cards.projectsLabel, 'projects');
  const variant = waitingVariant(cards);
  assert.match(variant.video.url, /^\/media\/video\?key=waiting-clip&v=[A-Za-z0-9_-]{16}$/);
  assert.deepEqual(variant.meta, { width: 1080, height: 1920, durationSec: 4 });
  assert.equal(typeof variant.approvalTicket, 'string');
  const text = JSON.stringify(cards);
  assertNoPathLeak(text, projectsDir);
  assert.doesNotMatch(text, /[a-f0-9]{64}/);
  assert.doesNotMatch(text, /brief\//);
  assert.equal(cards.ready[0].variants[0].approvalTicket, null);
});

// Адрес видео раньше состоял только из ключа: новый preview приходил по тому же URL, и
// открытая страница продолжала показывать старый файл. Метка v меняется вместе с файлом.
test('media urls carry a version that changes only when the video file changes', async (t) => {
  const projectsDir = await standardRoot(t);
  const { session } = await startTest(t, projectsDir);
  const versionOf = (url) => new URL(url, 'http://127.0.0.1').searchParams.get('v');

  const first = await variantOf(session, 'waiting-clip');
  const v1 = versionOf(first.video.url);
  assert.match(v1, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(versionOf(first.thumbUrl), v1);
  // Файл не менялся – метка та же, иначе фоновое обновление перерисовывало бы плеер зря.
  assert.equal(versionOf((await variantOf(session, 'waiting-clip')).video.url), v1);
  // Маршрут медиа выбирает файл только по ключу: метку он не проверяет.
  const served = await request(session, first.video.url, { token: session.token, queryToken: true });
  assert.equal(served.status, 200);
  assert.equal(served.body.toString('utf8'), 'preview waiting-clip');

  republishFullPreview(projectsDir, 'waiting-clip', 'preview после правки');
  const republished = await variantOf(session, 'waiting-clip');
  const v2 = versionOf(republished.video.url);
  assert.match(v2, /^[A-Za-z0-9_-]{16}$/);
  assert.notEqual(v2, v1);
  assert.equal(versionOf(republished.thumbUrl), v2);

  // У финала в паспорте нет SHA-256 – версию даёт сам файл (размер и время изменения).
  const readyBefore = versionOf((await variantOf(session, 'ready-clip')).video.url);
  assert.equal(versionOf((await variantOf(session, 'ready-clip')).video.url), readyBefore);
  const manifest = readProjectManifest(path.join(projectsDir, 'ready-clip'));
  fs.writeFileSync(path.join(projectsDir, 'ready-clip', ...manifest.final.split('/')), 'final ready-clip, пересобран');
  assert.notEqual(versionOf((await variantOf(session, 'ready-clip')).video.url), readyBefore);

  const text = JSON.stringify((await get(session, '/api/cards')).json);
  assert.doesNotMatch(text, /[a-f0-9]{64}/);
  assertNoPathLeak(text, projectsDir);
});

// Подпись «Утверждённый preview – агент собирает финал» опирается на флаг сервера, а не
// на разбор текста следующего шага.
test('cards say whether a variant still waits for its final', async (t) => {
  const projectsDir = await standardRoot(t);
  addDraftProject(projectsDir, { folder: 'approved-clip', name: 'Утверждён', approve: true });
  const { session } = await startTest(t, projectsDir);
  assert.equal((await variantOf(session, 'approved-clip')).needsFinal, true);
  assert.equal((await variantOf(session, 'waiting-clip')).needsFinal, false);
  assert.equal((await variantOf(session, 'ready-clip')).needsFinal, false);
});

// Второй круг: v1 утверждён и собран в финал, агент выпустил v2, человек утвердил v2.
// Финал v1 – уже не утверждённая версия: пока агент собирает новый финал, пульт показывает
// утверждённый preview v2, и правка после утверждения цепляется к нему, а не к старому финалу.
test('after a second approval the pult shows the approved preview, not the previous final', async (t) => {
  const { projectsDir } = makePultRoot(t);
  const built = addDraftProject(projectsDir, { folder: 'clip', name: 'Второй круг', approve: true, final: true });
  addSecondRevision(built.projectDir, 'Второй круг');
  const { session } = await startTest(t, projectsDir);
  const waiting = await variantOf(session, 'clip');
  assert.equal(waiting.status, 'waiting');
  assert.equal((await approve(session, 'clip', waiting.approvalTicket)).status, 201);

  const approved = await variantOf(session, 'clip');
  assert.equal(approved.status, 'working');
  assert.equal(approved.nextStep, 'Утверждено – агент собирает финал');
  assert.equal(approved.needsFinal, true);
  assert.equal(approved.video.kind, 'preview');
  const served = await request(session, approved.video.url, { token: session.token, queryToken: true });
  assert.equal(served.body.toString('utf8'), 'preview v2');

  assert.equal((await post(session, '/api/comments', { key: 'clip', timeSec: 1, text: 'После утверждения' })).status, 201);
  const [comment] = readComments(built.projectDir);
  assert.equal(comment.video.kind, 'preview');
  assert.equal(comment.video.path, readProjectManifest(built.projectDir).currentPreview.filePath);
});

test('media streams the current video with byte ranges', async (t) => {
  const projectsDir = await standardRoot(t);
  const { session } = await startTest(t, projectsDir);
  const full = await request(session, '/media/video?key=ready-clip', { token: session.token, queryToken: true });
  assert.equal(full.status, 200);
  assert.equal(full.body.toString('utf8'), 'final ready-clip');
  const ranged = await request(session, '/media/video?key=ready-clip', {
    token: session.token, queryToken: true, headers: { range: 'bytes=0-4' },
  });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.body.toString('utf8'), 'final');
  const history = await request(session, '/media/history?key=ready-clip&index=0', { token: session.token, queryToken: true });
  assert.equal(history.status, 200);
  const thumb = await request(session, '/media/thumb?key=ready-clip', { token: session.token, queryToken: true });
  assert.equal(thumb.status, 200);
  assert.match(thumb.headers['content-type'], /image\/jpeg/);
});

test('media rejects unknown keys and traversal attempts', async (t) => {
  const projectsDir = await standardRoot(t);
  const { session } = await startTest(t, projectsDir);
  // '#' в ключе кодируется как %23: сырой '#' начал бы фрагмент URL и отрезал бы токен.
  // 'Ready-Clip' – другое написание папки: на APFS/NTFS оно не должно найти ролик.
  for (const key of ['../ready-clip', '..%2Fready-clip', 'missing', 'ready-clip%23999', 'Ready-Clip', '']) {
    const response = await request(session, `/media/video?key=${key}`, { token: session.token, queryToken: true });
    assert.equal(response.status, 404, key);
  }
  assert.equal((await request(session, '/media/../project.json', { token: session.token, queryToken: true })).status, 404);
  assert.equal((await request(session, '/media/history?key=ready-clip&index=-1', { token: session.token, queryToken: true })).status, 404);
});

test('comments are added, listed and deleted through the API', async (t) => {
  const projectsDir = await standardRoot(t);
  const { session } = await startTest(t, projectsDir);
  const created = await post(session, '/api/comments', { key: 'waiting-clip', timeSec: 1.5, text: 'Текст залезает на лицо' });
  assert.equal(created.status, 201);
  const { comment } = created.json;
  assert.equal(comment.text, 'Текст залезает на лицо');
  assert.match(comment.frameUrl, /^\/media\/frame\?key=waiting-clip&comment=c-[a-f0-9]{8}$/);
  const frame = await request(session, comment.frameUrl, { token: session.token, queryToken: true });
  assert.equal(frame.status, 200);
  const listed = (await get(session, '/api/comments?key=waiting-clip')).json.comments;
  assert.deepEqual(listed.map((item) => item.id), [comment.id]);
  assert.equal((await get(session, '/api/cards')).json.working[0].variants[0].nextStep, 'Ждёт агента: 1 правка');
  assert.equal((await post(session, '/api/comments/delete', { key: 'waiting-clip', id: comment.id })).json.deleted, true);
  assert.deepEqual((await get(session, '/api/comments?key=waiting-clip')).json.comments, []);
  assert.equal((await post(session, '/api/comments', { key: 'waiting-clip', timeSec: 1, text: 'x', extra: 1 })).status, 400);
  assert.equal((await post(session, '/api/comments', { key: 'waiting-clip', timeSec: -5, text: 'x' })).status, 400);
});

test('deleting an accepted comment or from a broken comments file is refused distinctly', async (t) => {
  const projectsDir = await standardRoot(t);
  const { session } = await startTest(t, projectsDir);
  const { comment } = (await post(session, '/api/comments', { key: 'waiting-clip', timeSec: 1, text: 'Сдвинуть титр' })).json;
  acceptComment(path.join(projectsDir, 'waiting-clip'), comment.id);
  const accepted = await post(session, '/api/comments/delete', { key: 'waiting-clip', id: comment.id });
  assert.equal(accepted.status, 409);
  assert.equal(accepted.json.code, 'COMMENT_ACCEPTED');
  assert.equal(accepted.json.message, 'Правка уже принята агентом');

  const commentsFile = path.join(projectsDir, 'waiting-clip', 'pult', 'comments.json');
  fs.writeFileSync(commentsFile, '{"version":1,"comments":[{"id":"../../project.json"}]}\n');
  const broken = await post(session, '/api/comments/delete', { key: 'waiting-clip', id: comment.id });
  assert.equal(broken.status, 409);
  assert.equal(broken.json.code, 'COMMENTS_BROKEN');
  assert.match(broken.json.message, /повреждён/);
  assert.equal((await get(session, '/api/comments?key=waiting-clip')).json.code, 'COMMENTS_BROKEN');
  assert.ok(fs.existsSync(path.join(projectsDir, 'waiting-clip', 'project.json')));
});

test('adding a comment to a broken comments file is refused as broken, not as invalid', async (t) => {
  const projectsDir = await standardRoot(t);
  const { session } = await startTest(t, projectsDir);
  fs.mkdirSync(path.join(projectsDir, 'waiting-clip', 'pult'), { recursive: true });
  fs.writeFileSync(path.join(projectsDir, 'waiting-clip', 'pult', 'comments.json'), '{broken');
  const refused = await post(session, '/api/comments', { key: 'waiting-clip', timeSec: 1, text: 'Сдвинуть титр' });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.json, {
    code: 'COMMENTS_BROKEN',
    message: 'Файл правок повреждён – попросите агента проверить pult/comments.json',
  });
  assert.equal(fs.readFileSync(path.join(projectsDir, 'waiting-clip', 'pult', 'comments.json'), 'utf8'), '{broken');
});

test('an unexpected comment failure is an internal error without details', { skip: process.platform === 'win32' }, async (t) => {
  const projectsDir = await standardRoot(t);
  const outside = path.join(path.dirname(projectsDir), 'outside-pult');
  fs.mkdirSync(outside);
  // pult – ссылка наружу: сохранять правку туда нельзя, и это не «битый файл правок».
  fs.symlinkSync(outside, path.join(projectsDir, 'waiting-clip', 'pult'));
  const { session, calls } = await startTest(t, projectsDir);
  const failed = await post(session, '/api/comments', { key: 'waiting-clip', timeSec: 1, text: 'Сдвинуть титр' });
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.json, { code: 'INTERNAL', message: 'Внутренняя ошибка пульта' });
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.ok(calls.logs.length > 0);
  assert.ok(calls.logs.every((line) => !line.includes(projectsDir)));
});

test('a legacy video in a format the pult cannot play is marked unsupported but keeps its cover', async (t) => {
  const { projectsDir } = makePultRoot(t);
  addLegacyFolder(projectsDir, 'archive-cut', {
    files: { 'out/a.mkv': 'mkv bytes' },
    card: { version: 1, legacy: { status: 'ready', variants: [{ label: 'MKV', video: 'out/a.mkv', final: true }] } },
  });
  const { session } = await startTest(t, projectsDir);
  const variant = await variantOf(session, 'archive-cut#0');
  assert.equal(variant.video, null);
  assert.equal(variant.meta, null);
  assert.equal(variant.videoUnsupported, true);
  assert.match(variant.thumbUrl, /^\/media\/thumb\?key=archive-cut%230&v=[A-Za-z0-9_-]{16}$/);
  const thumb = await request(session, variant.thumbUrl, { token: session.token, queryToken: true });
  assert.equal(thumb.status, 200);
  assert.match(thumb.headers['content-type'], /image\/jpeg/);
});

test('a legacy card pointing at a non-media file never serves it', async (t) => {
  const { projectsDir } = makePultRoot(t);
  addLegacyFolder(projectsDir, 'old', {
    files: { 'notes.txt': 'private notes', 'clip.mp4': 'mp4' },
    card: {
      version: 1,
      legacy: { status: 'ready', variants: [{ label: 'Текст', video: 'notes.txt' }, { label: 'Видео', video: 'clip.mp4' }] },
    },
  });
  const { session } = await startTest(t, projectsDir);
  const notes = await request(session, '/media/video?key=old%230', { token: session.token, queryToken: true });
  assert.equal(notes.status, 404);
  assert.ok(!notes.body.toString('utf8').includes('private notes'));
  const clip = await request(session, '/media/video?key=old%231', { token: session.token, queryToken: true });
  assert.equal(clip.status, 200);
  assert.equal(clip.body.toString('utf8'), 'mp4');
});

test('approve requires confirmation and the exact previewed video', async (t) => {
  const projectsDir = await standardRoot(t);
  const { session } = await startTest(t, projectsDir);
  const ticket = waitingVariant((await get(session, '/api/cards')).json).approvalTicket;
  assert.equal((await post(session, '/api/approve', { key: 'waiting-clip', ticket, confirmPreviewViewed: false })).status, 400);
  const wrong = await post(session, '/api/approve', { key: 'waiting-clip', ticket: 'x'.repeat(43), confirmPreviewViewed: true });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.json.code, 'PREVIEW_CHANGED');
  const approved = await post(session, '/api/approve', { key: 'waiting-clip', ticket, confirmPreviewViewed: true });
  assert.equal(approved.status, 201);
  const cards = (await get(session, '/api/cards')).json;
  const variant = cards.working.flatMap((card) => card.variants).find((item) => item.key === 'waiting-clip');
  assert.equal(variant.nextStep, 'Утверждено – агент собирает финал');
  const briefs = fs.readdirSync(path.join(projectsDir, 'waiting-clip', 'brief'));
  assert.ok(briefs.some((name) => /-approved\.lesson\.json$/.test(name)));
  assert.equal((await post(session, '/api/approve', { key: 'waiting-clip', ticket, confirmPreviewViewed: true })).status, 409);
});

test('a draft waiting for the author to pick b-roll gets no approval ticket', async (t) => {
  const { projectsDir } = makePultRoot(t);
  addDraftProject(projectsDir, { folder: 'intent-clip', name: 'Нужен B-roll', scenes: unresolvedBrollScenes() });
  const { session } = await startTest(t, projectsDir);
  const variant = await variantOf(session, 'intent-clip');
  assert.equal(variant.status, 'waiting');
  assert.equal(variant.nextStep, 'Выберите B-roll в проверке монтажа');
  assert.equal(variant.approvable, false);
  assert.equal(variant.approvalTicket, null);
  assert.equal(variant.reviewable, true);
  assert.equal(variant.video.kind, 'preview');
  const refused = await approve(session, 'intent-clip', 'x'.repeat(43));
  assert.equal(refused.status, 409);
  assert.deepEqual(approvedBriefs(projectsDir, 'intent-clip'), []);
});

test('an engine refusal of a still-current ticket is reported as blocked and leaks no path', async (t) => {
  const projectsDir = await standardRoot(t);
  const secret = path.join(projectsDir, 'waiting-clip', 'brief', 'v01-draft.lesson.json');
  const { session, calls } = await startTest(t, projectsDir, {
    approveBriefImpl: () => { throw new TypeError(`scenes[1].brollSrc: ${secret}`); },
  });
  const manifestFile = path.join(projectsDir, 'waiting-clip', 'project.json');
  const manifestBefore = fs.readFileSync(manifestFile);
  const ticket = (await variantOf(session, 'waiting-clip')).approvalTicket;
  const blocked = await approve(session, 'waiting-clip', ticket);
  assert.equal(blocked.status, 422);
  assert.deepEqual(blocked.json, {
    code: 'APPROVAL_BLOCKED',
    message: 'Движок не принял утверждение: черновик ещё не готов. Откройте проверку монтажа или передайте ролик агенту.',
  });
  assert.deepEqual(approvedBriefs(projectsDir, 'waiting-clip'), []);
  assert.deepEqual(fs.readFileSync(manifestFile), manifestBefore);
  assert.equal((await variantOf(session, 'waiting-clip')).approvalTicket, ticket);
  assert.ok(calls.logs.length > 0);
  assert.ok(calls.logs.every((line) => !line.includes(projectsDir) && !line.includes('brollSrc')));
  assertNoPathLeak(blocked.body.toString('utf8'), projectsDir);
});

test('an engine failure after the draft changed reports a changed preview', async (t) => {
  const projectsDir = await standardRoot(t);
  const { session } = await startTest(t, projectsDir, {
    approveBriefImpl: (workspace, briefFile) => {
      // Агент успел переписать черновик, пока шло утверждение.
      fs.appendFileSync(briefFile, '\n');
      throw new Error('manifest changed');
    },
  });
  const ticket = (await variantOf(session, 'waiting-clip')).approvalTicket;
  const changed = await approve(session, 'waiting-clip', ticket);
  assert.equal(changed.status, 409);
  assert.equal(changed.json.code, 'PREVIEW_CHANGED');
});

test('an engine lock conflict on a current ticket asks to retry later', async (t) => {
  const projectsDir = await standardRoot(t);
  const { session } = await startTest(t, projectsDir, {
    approveBriefImpl: () => {
      const error = new Error('project manifest changed concurrently; stale snapshot');
      error.code = 'PROJECT_MANIFEST_CONFLICT';
      throw error;
    },
  });
  const ticket = (await variantOf(session, 'waiting-clip')).approvalTicket;
  const busy = await approve(session, 'waiting-clip', ticket);
  assert.equal(busy.status, 409);
  assert.deepEqual(busy.json, { code: 'PROJECT_BUSY', message: 'Агент сейчас меняет этот ролик – попробуйте через минуту' });
  assert.deepEqual(approvedBriefs(projectsDir, 'waiting-clip'), []);
});

test('approval checks the preview bytes the page was shown', async (t) => {
  const projectsDir = await standardRoot(t);
  const { session } = await startTest(t, projectsDir);
  const ticket = (await variantOf(session, 'waiting-clip')).approvalTicket;
  const previewFile = previewFileOf(projectsDir, 'waiting-clip');
  const original = fs.readFileSync(previewFile);
  fs.chmodSync(previewFile, 0o644);

  // Билет актуален, но файл не тот, что в паспорте: обновление страницы не поможет,
  // нужен новый preview от агента – поэтому другой код, чем у устаревшего билета.
  fs.writeFileSync(previewFile, 'bytes the author never saw');
  const swapped = await approve(session, 'waiting-clip', ticket);
  assert.equal(swapped.status, 409);
  assert.deepEqual(swapped.json, {
    code: 'PREVIEW_DAMAGED',
    message: 'Файл preview не совпадает с паспортом ролика – попросите агента пересобрать preview',
  });
  fs.rmSync(previewFile);
  const missing = await approve(session, 'waiting-clip', ticket);
  assert.equal(missing.status, 409);
  assert.equal(missing.json.code, 'PREVIEW_DAMAGED');
  // Без файла preview страница не может его показать – и не предлагает утвердить.
  const unplayable = await variantOf(session, 'waiting-clip');
  assert.equal(unplayable.video, null);
  assert.equal(unplayable.approvable, false);
  assert.equal(unplayable.approvalTicket, null);
  assert.deepEqual(approvedBriefs(projectsDir, 'waiting-clip'), []);

  fs.writeFileSync(previewFile, original);
  assert.equal((await approve(session, 'waiting-clip', ticket)).status, 201);
  assert.equal(approvedBriefs(projectsDir, 'waiting-clip').length > 0, true);
});

test('a ticket for an older preview, an excerpt or another video is refused', async (t) => {
  const projectsDir = await standardRoot(t);
  addDraftProject(projectsDir, { folder: 'other-clip', name: 'Другой' });
  addDraftProject(projectsDir, { folder: 'excerpt-clip', name: 'Отрывок', previewKind: 'excerpt' });
  const { session } = await startTest(t, projectsDir);
  const ticket = (await variantOf(session, 'waiting-clip')).approvalTicket;
  const excerpt = await variantOf(session, 'excerpt-clip');
  assert.equal(excerpt.status, 'working');
  assert.equal(excerpt.approvalTicket, null);

  for (const key of ['excerpt-clip', 'other-clip']) {
    const refused = await approve(session, key, ticket);
    assert.equal(refused.status, 409, key);
    assert.equal(refused.json.code, 'PREVIEW_CHANGED', key);
    assert.deepEqual(approvedBriefs(projectsDir, key), [], key);
  }

  republishFullPreview(projectsDir, 'waiting-clip', 'preview v2');
  const stale = await approve(session, 'waiting-clip', ticket);
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'PREVIEW_CHANGED');
  assert.deepEqual(approvedBriefs(projectsDir, 'waiting-clip'), []);
  const fresh = (await variantOf(session, 'waiting-clip')).approvalTicket;
  assert.notEqual(fresh, ticket);
  assert.equal((await approve(session, 'waiting-clip', fresh)).status, 201);
});

test('a valid token does not help a request with a foreign Host', async (t) => {
  const projectsDir = await standardRoot(t);
  const { session } = await startTest(t, projectsDir);
  const port = session.server.address().port;
  for (const host of ['evil.test', `localhost:${port}`]) {
    assert.equal((await request(session, '/api/cards', { token: session.token, host })).status, 403, host);
    const media = await request(session, '/media/video?key=ready-clip', { token: session.token, queryToken: true, host });
    assert.equal(media.status, 403, host);
  }
});

test('internal errors never leak absolute paths to the page or the log', async (t) => {
  const projectsDir = await standardRoot(t);
  const secret = path.join(projectsDir, 'waiting-clip', 'previews', 'secret.mp4');
  let broken = false;
  const { session, calls } = await startTest(t, projectsDir, {
    // Любая неожиданная ошибка внутри маршрута доходит до общего обработчика 500.
    now: () => {
      if (broken) throw new Error(`EACCES: permission denied, open '${secret}'`);
      return 0;
    },
  });
  broken = true;
  const failed = await get(session, '/api/cards');
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.json, { code: 'INTERNAL', message: 'Внутренняя ошибка пульта' });
  assertNoPathLeak(failed.body.toString('utf8'), projectsDir);
  assert.ok(calls.logs.length > 0);
  assert.ok(calls.logs.every((line) => !line.includes(projectsDir) && !line.includes('EACCES')));
});

test('archive hides a card without touching its folder', async (t) => {
  const projectsDir = await standardRoot(t);
  const { session } = await startTest(t, projectsDir);
  await post(session, '/api/archive', { cardId: 'folder:ready-clip', archived: true });
  const cards = (await get(session, '/api/cards')).json;
  assert.deepEqual(cards.archive.map((card) => card.id), ['folder:ready-clip']);
  assert.equal(cards.ready.length, 0);
  assert.ok(fs.existsSync(path.join(projectsDir, 'ready-clip', 'project.json')));
  assert.equal((await post(session, '/api/archive', { cardId: '../x', archived: true })).status, 400);
});

// DECISIONS.md D-030: нажатие «Утверждаю» на архивной карточке – это и есть просьба
// пользователя собрать финал, поэтому само утверждение возвращает карточку из архива, а не
// оставляет пометку «в архиве» в входящих агента.
test('approving an archived waiting card returns it from the archive', async (t) => {
  const projectsDir = await standardRoot(t);
  const { session } = await startTest(t, projectsDir);
  await post(session, '/api/archive', { cardId: 'folder:waiting-clip', archived: true });
  assert.deepEqual((await get(session, '/api/cards')).json.archive.map((card) => card.id), ['folder:waiting-clip']);
  const ticket = (await variantOf(session, 'waiting-clip')).approvalTicket;
  const approved = await approve(session, 'waiting-clip', ticket);
  assert.equal(approved.status, 201);
  const cards = (await get(session, '/api/cards')).json;
  assert.deepEqual(cards.archive, []);
  assert.deepEqual(readPultState(projectsDir).archived, []);
  const text = formatInbox(buildInbox({ projectsDir }), { projectsDir });
  assert.match(text, /- Утверждено: `brief\/v\d{2}-approved\.lesson\.json`\. Собери финал и проведи полный QA\./);
  assert.doesNotMatch(text, /в архиве/);
});

// Отказ утверждения (например, протухший билет) не должен тихо вернуть карточку из архива –
// пользователь её туда убрал сознательно, а утверждения не случилось.
test('a refused approval leaves the archived card archived', async (t) => {
  const projectsDir = await standardRoot(t);
  const { session } = await startTest(t, projectsDir);
  await post(session, '/api/archive', { cardId: 'folder:waiting-clip', archived: true });
  const stale = await approve(session, 'waiting-clip', 'x'.repeat(43));
  assert.equal(stale.status, 409);
  assert.deepEqual((await get(session, '/api/cards')).json.archive.map((card) => card.id), ['folder:waiting-clip']);
  assert.deepEqual(readPultState(projectsDir).archived, ['folder:waiting-clip']);
});

// Варианты одной темы делят id карточки group:<id> (см. cardIdFor) – утверждение любого
// варианта должно вернуть из архива всю карточку темы, а не только утверждённый вариант.
test('approving one variant of an archived group card returns the whole card from the archive', async (t) => {
  const { projectsDir } = makePultRoot(t);
  const group = { id: 'tema-y', title: 'Тема Y' };
  addDraftProject(projectsDir, {
    folder: 'tema-y-original',
    name: 'Тема Y – оригинал',
    card: { version: 1, group, variantLabel: 'Оригинал' },
  });
  addDraftProject(projectsDir, {
    folder: 'tema-y-hook1',
    name: 'Тема Y – хук 1',
    card: { version: 1, group, variantLabel: 'Хук 1' },
  });
  const { session } = await startTest(t, projectsDir);
  await post(session, '/api/archive', { cardId: 'group:tema-y', archived: true });
  assert.deepEqual((await get(session, '/api/cards')).json.archive.map((card) => card.id), ['group:tema-y']);
  const ticket = (await variantOf(session, 'tema-y-original')).approvalTicket;
  const approved = await approve(session, 'tema-y-original', ticket);
  assert.equal(approved.status, 201);
  const cards = (await get(session, '/api/cards')).json;
  assert.deepEqual(cards.archive, []);
  assert.deepEqual(readPultState(projectsDir).archived, []);
});

// Обратный порядок действий – утвердили, потом убрали в архив: карточка получает честную
// надпись, флаг для подписи плеера и попадает во входящих с пометкой «в архиве»
// (scripts/pult/inbox.js). Удаление поля archivedNeedsFinal из browserVariant (server.js)
// должно ронять этот и следующий тест; ветку videoLabelFor в app.js ловит Playwright-тест.
test('approving then archiving a card shows the honest next step, the flag and the inbox marker', async (t) => {
  const projectsDir = await standardRoot(t);
  const { session } = await startTest(t, projectsDir);
  const ticket = (await variantOf(session, 'waiting-clip')).approvalTicket;
  assert.equal((await approve(session, 'waiting-clip', ticket)).status, 201);
  await post(session, '/api/archive', { cardId: 'folder:waiting-clip', archived: true });
  const cards = (await get(session, '/api/cards')).json;
  const card = cards.archive.find((item) => item.id === 'folder:waiting-clip');
  assert.equal(card.nextStep, 'Утверждено, в архиве – агент соберёт финал по вашей просьбе');
  assert.equal(card.variants[0].archivedNeedsFinal, true);
  const text = formatInbox(buildInbox({ projectsDir }), { projectsDir });
  assert.match(
    text,
    /- Утверждено \(в архиве – не начинай без просьбы пользователя\): `brief\/v\d{2}-approved\.lesson\.json`\. По просьбе пользователя – собери финал и проведи полный QA\./,
  );
});

// Новая правка после утверждения и архивации – nextStep остаётся «Ждёт агента: …» (это новая
// работа автора), но флаг для подписи плеера всё равно честный: automontage inbox метит
// утверждение «в архиве» независимо от новых правок, и подпись должна соответствовать этому.
test('the same card with a pending edit after archiving keeps "waiting for the agent" but stays flagged', async (t) => {
  const projectsDir = await standardRoot(t);
  const { session } = await startTest(t, projectsDir);
  const ticket = (await variantOf(session, 'waiting-clip')).approvalTicket;
  assert.equal((await approve(session, 'waiting-clip', ticket)).status, 201);
  await post(session, '/api/comments', { key: 'waiting-clip', timeSec: 1, text: 'Поправь титр' });
  await post(session, '/api/archive', { cardId: 'folder:waiting-clip', archived: true });
  const cards = (await get(session, '/api/cards')).json;
  const card = cards.archive.find((item) => item.id === 'folder:waiting-clip');
  assert.equal(card.nextStep, 'Ждёт агента: 1 правка');
  assert.equal(card.variants[0].archivedNeedsFinal, true);
});

// Отказ движка вернуть карточку из архива не должен испортить уже случившееся утверждение
// (порядок: сначала approve, потом un-archive) – только лог, без пути в сообщении.
// chmod на права не действует под root (root игнорирует биты доступа файловой системы), а
// Windows chmod не эмулирует Unix-права вовсе – тест пропускается в обоих случаях.
test('a failing un-archive after a successful approval still returns success and only logs the error', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async (t) => {
  const projectsDir = await standardRoot(t);
  const { session, calls } = await startTest(t, projectsDir);
  await post(session, '/api/archive', { cardId: 'folder:waiting-clip', archived: true });
  const ticket = (await variantOf(session, 'waiting-clip')).approvalTicket;
  const pultDir = path.join(projectsDir, '.pult');
  fs.chmodSync(pultDir, 0o500);
  let approved;
  try {
    approved = await approve(session, 'waiting-clip', ticket);
  } finally {
    fs.chmodSync(pultDir, 0o700);
  }
  assert.equal(approved.status, 201);
  assert.ok(approvedBriefs(projectsDir, 'waiting-clip').length > 0);
  assert.ok(calls.logs.some((line) => line.includes('не удалось вернуть карточку из архива')));
  assert.ok(calls.logs.every((line) => !line.includes(projectsDir)));
  const cards = (await get(session, '/api/cards')).json;
  assert.deepEqual(cards.archive.map((card) => card.id), ['folder:waiting-clip']);
});

test('reveal opens the file manager at the video or folder', async (t) => {
  const projectsDir = await standardRoot(t);
  const { session, calls } = await startTest(t, projectsDir);
  const finalPath = readProjectManifest(path.join(projectsDir, 'ready-clip')).final;
  assert.equal((await post(session, '/api/reveal', { key: 'ready-clip' })).status, 200);
  assert.equal(calls.reveal[0], path.join(projectsDir, 'ready-clip', ...finalPath.split('/')));
  assert.equal((await post(session, '/api/reveal', { folder: 'research' })).status, 200);
  assert.equal(calls.reveal[1], path.join(projectsDir, 'research'));
  for (const folder of ['../x', '.pult', 'missing']) {
    assert.equal((await post(session, '/api/reveal', { folder })).status, 400, folder);
  }
});

test('review opens once per project and closes with the pult', async (t) => {
  const projectsDir = await standardRoot(t);
  const { session, calls } = await startTest(t, projectsDir);
  assert.equal((await post(session, '/api/review', { key: 'waiting-clip' })).status, 200);
  assert.equal((await post(session, '/api/review', { key: 'waiting-clip' })).status, 200);
  assert.equal(calls.reviews.length, 1);
  assert.equal(calls.reviews[0].open, false);
  assert.equal(calls.reviews[0].editable, true);
  assert.equal(calls.windows.length, 2);
  const [review] = session.reviewSessions.values();
  await session.close();
  assert.equal(session.reviewSessions.size, 0);
  assert.equal(review.server.listening, false);
});

test('closing the pult shuts review down like the review cli: abort, close, wait', async (t) => {
  const projectsDir = await standardRoot(t);
  const { session, calls } = await startTest(t, projectsDir);
  assert.equal((await post(session, '/api/review', { key: 'waiting-clip' })).status, 200);
  const [review] = session.reviewSessions.values();
  await session.close();
  assert.deepEqual(calls.shutdown, [['abort', true], ['wait', false]]);
  assert.equal(review.server.listening, false);
  assert.equal(session.server.listening, false);
});

// По умолчанию – запрос самой страницы Review: с её токеном и её Host.
function reviewGet(review, { pathname = '/api/state', headers = { authorization: `Bearer ${review.token}` } } = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: review.server.address().port, path: pathname, headers }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    }).on('error', reject);
  });
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

test('work in the review window keeps the pult alive', async (t) => {
  const projectsDir = await standardRoot(t);
  let clock = 0;
  let idle;
  const idleReached = new Promise((resolve) => { idle = resolve; });
  const { session } = await startTest(t, projectsDir, {
    now: () => clock, idleMs: 1000, idleCheckMs: 5, onIdle: idle,
  });
  assert.equal((await post(session, '/api/review', { key: 'waiting-clip' })).status, 200);
  const [review] = session.reviewSessions.values();
  clock = 900;
  assert.equal(await reviewGet(review), 200);
  // 1800 после последнего запроса к пульту, но только 900 после запроса к Review.
  clock = 1800;
  await delay(50);
  assert.equal(session.server.listening, true);
  assert.equal(review.server.listening, true);
  // Медиа Review передаёт токен в адресе – это тоже работа человека в окне.
  assert.equal(await reviewGet(review, { pathname: `/media/source?token=${review.token}`, headers: {} }), 200);
  clock = 2700;
  await delay(50);
  assert.equal(session.server.listening, true);
  clock = 2801;
  await idleReached;
  assert.equal(session.server.listening, false);
  assert.equal(review.server.listening, false);
});

test('foreign or unauthenticated requests to review do not keep the pult alive', async (t) => {
  const projectsDir = await standardRoot(t);
  let clock = 0;
  let idle;
  const idleReached = new Promise((resolve) => { idle = resolve; });
  const { session } = await startTest(t, projectsDir, {
    now: () => clock, idleMs: 1000, idleCheckMs: 5, onIdle: idle,
  });
  assert.equal((await post(session, '/api/review', { key: 'waiting-clip' })).status, 200);
  const [review] = session.reviewSessions.values();
  clock = 900;
  const bearer = { authorization: `Bearer ${review.token}` };
  for (const headers of [
    {},
    { authorization: `Bearer ${'x'.repeat(43)}` },
    { ...bearer, host: 'evil.test' },
    { ...bearer, host: `localhost:${review.server.address().port}` },
  ]) {
    assert.equal(await reviewGet(review, { headers }), 200);
  }
  // Токен в адресе засчитывается только для медиа, как и в самом Review.
  assert.equal(await reviewGet(review, { pathname: `/api/state?token=${review.token}`, headers: {} }), 200);
  clock = 1001;
  const outcome = await Promise.race([idleReached.then(() => 'idle'), delay(1000).then(() => 'alive')]);
  assert.equal(outcome, 'idle');
  assert.equal(session.server.listening, false);
});

// Закрывает все двойники Review, созданные тестом: даже если пульт «потерял» сервер,
// тестовый процесс не должен зависнуть.
function closeFakes(reviews) {
  for (const review of reviews) {
    if (review.server.listening) review.server.close();
    review.server.closeAllConnections();
  }
}

test('parallel review requests for one project start one review', async (t) => {
  const projectsDir = await standardRoot(t);
  const reviews = [];
  t.after(() => closeFakes(reviews));
  const { session, calls } = await startTest(t, projectsDir, {
    startReviewServerImpl: async (options) => {
      calls.reviews.push(options);
      await delay(30);
      const review = await fakeReview(calls);
      reviews.push(review);
      return review;
    },
  });
  const results = await Promise.all([
    post(session, '/api/review', { key: 'waiting-clip' }),
    post(session, '/api/review', { key: 'waiting-clip' }),
  ]);
  assert.deepEqual(results.map((result) => result.status), [200, 200]);
  assert.equal(calls.reviews.length, 1);
  assert.equal(calls.windows.length, 2);
  assert.equal(session.reviewSessions.size, 1);
});

test('a review request whose body arrives after closing began starts no review', async (t) => {
  const projectsDir = await standardRoot(t);
  const reviews = [];
  t.after(() => closeFakes(reviews));
  const { session, calls } = await startTest(t, projectsDir, {
    startReviewServerImpl: async (options) => {
      calls.reviews.push(options);
      const review = await fakeReview(calls);
      // Уборка открытого Review занимает время – в эту паузу и приходит тело запроса.
      review.waitForActiveImports = () => delay(150);
      reviews.push(review);
      return review;
    },
  });
  assert.equal((await post(session, '/api/review', { key: 'waiting-clip' })).status, 200);
  const port = session.server.address().port;
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await new Promise((resolve) => { socket.once('connect', resolve); });
  const body = JSON.stringify({ key: 'ready-clip' });
  // Заголовки приходят до закрытия, тело – уже после: проверка в начале маршрута пройдена.
  socket.write([
    'POST /api/review HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    `Authorization: Bearer ${session.token}`,
    `Origin: ${session.origin}`,
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    '',
  ].join('\r\n'));
  await delay(20);
  const closing = session.close();
  socket.write(body);
  await closing;
  assert.equal(calls.reviews.length, 1);
  assert.ok(reviews.every((review) => !review.server.listening));
});

test('a review that finishes starting while the pult closes is shut down, and the pult answers 503', async (t) => {
  const projectsDir = await standardRoot(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const reviews = [];
  let created;
  const createdPromise = new Promise((resolve) => { created = resolve; });
  t.after(async () => {
    release();
    await createdPromise;
    closeFakes(reviews);
  });
  const { session, calls } = await startTest(t, projectsDir, {
    startReviewServerImpl: async () => {
      started();
      await gate;
      const review = await fakeReview({ shutdown: [] });
      reviews.push(review);
      created();
      return review;
    },
  });
  const pending = post(session, '/api/review', { key: 'waiting-clip' }).catch(() => ({ status: 'reset' }));
  await startedPromise;
  const closing = session.close();
  // Пока пульт закрывается, API и медиа уже не работают.
  assert.equal((await get(session, '/api/cards')).status, 503);
  assert.equal((await get(session, '/api/health')).status, 503);
  const media = await request(session, '/media/video?key=ready-clip', { token: session.token, queryToken: true });
  assert.equal(media.status, 503);
  release();
  await closing;
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].server.listening, false);
  assert.equal(session.reviewSessions.size, 0);
  assert.equal(calls.windows.length, 0);
  assert.ok([503, 'reset'].includes((await pending).status));
});

test('review, window and reveal failures are reported without details', async (t) => {
  const projectsDir = await standardRoot(t);
  const secret = path.join(projectsDir, 'waiting-clip');
  const failing = (label) => async () => { throw new TypeError(`${label}: ${secret}`); };
  const { session: reviewSession, calls: reviewCalls } = await startTest(t, projectsDir, {
    startReviewServerImpl: failing('review'),
  });
  const reviewFailed = await post(reviewSession, '/api/review', { key: 'waiting-clip' });
  assert.equal(reviewFailed.status, 409);
  assert.deepEqual(reviewFailed.json, { code: 'REVIEW_FAILED', message: 'Проверку монтажа открыть не удалось' });
  assert.ok(reviewCalls.logs.some((line) => line.includes('TypeError')));

  const { session, calls } = await startTest(t, projectsDir, {
    openWindowImpl: failing('window'),
    revealImpl: failing('reveal'),
  });
  const windowFailed = await post(session, '/api/review', { key: 'waiting-clip' });
  assert.equal(windowFailed.status, 409);
  assert.deepEqual(windowFailed.json, { code: 'WINDOW_FAILED', message: 'Не удалось открыть окно проверки монтажа' });
  for (const body of [{ key: 'ready-clip' }, { folder: 'research' }]) {
    const revealFailed = await post(session, '/api/reveal', body);
    assert.equal(revealFailed.status, 409);
    assert.deepEqual(revealFailed.json, { code: 'REVEAL_FAILED', message: 'Не удалось открыть папку' });
  }
  const lines = [...reviewCalls.logs, ...calls.logs];
  assert.ok(lines.length >= 4);
  assert.ok(lines.every((line) => !line.includes(projectsDir)));
});

test('an open streaming review connection does not block closing the pult', async (t) => {
  const projectsDir = await standardRoot(t);
  const sockets = [];
  const { session } = await startTest(t, projectsDir, {
    startReviewServerImpl: async () => {
      // Review-видео, которое никогда не дописывается: ответ открыт, пока его не оборвут.
      const server = http.createServer((incoming, outgoing) => {
        outgoing.writeHead(200, { 'content-type': 'video/mp4' });
        outgoing.write('chunk');
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return { server, url: `http://127.0.0.1:${server.address().port}/#token=review` };
    },
  });
  assert.equal((await post(session, '/api/review', { key: 'waiting-clip' })).status, 200);
  const [review] = session.reviewSessions.values();
  await new Promise((resolve, reject) => {
    const outgoing = http.get({ host: '127.0.0.1', port: review.server.address().port, path: '/' }, (response) => {
      response.once('data', () => resolve());
      response.on('error', () => {});
    });
    outgoing.on('error', () => {});
    outgoing.on('socket', (socket) => sockets.push(socket));
    outgoing.once('error', reject);
  });
  let timer;
  const outcome = await Promise.race([
    session.close().then(() => 'closed'),
    new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), 1000); }),
  ]);
  clearTimeout(timer);
  // Даже при провале теста обрываем соединение сами, чтобы зависший close() не держал процесс.
  sockets.forEach((socket) => socket.destroy());
  assert.equal(outcome, 'closed');
  assert.equal(review.server.listening, false);
});

test('request bodies must be small JSON', async (t) => {
  const projectsDir = await standardRoot(t);
  const { session } = await startTest(t, projectsDir);
  const plain = await request(session, '/api/archive', {
    method: 'POST', token: session.token, origin: session.origin, rawBody: 'x', contentType: 'text/plain',
  });
  assert.equal(plain.status, 415);
  const huge = await request(session, '/api/comments', {
    method: 'POST', token: session.token, origin: session.origin, rawBody: JSON.stringify({ text: 'x'.repeat(70 * 1024) }),
  });
  assert.equal(huge.status, 413);
});

test('a throwing onIdle does not become an unhandled rejection', async (t) => {
  const { projectsDir } = makePultRoot(t);
  const rejections = [];
  const onRejection = (reason) => { rejections.push(reason); };
  process.on('unhandledRejection', onRejection);
  t.after(() => process.off('unhandledRejection', onRejection));
  let called;
  const idleCalled = new Promise((resolve) => { called = resolve; });
  const { session } = await startTest(t, projectsDir, {
    idleMs: 30,
    idleCheckMs: 10,
    onIdle: () => {
      called();
      throw new Error('onIdle failed');
    },
  });
  await idleCalled;
  await delay(50);
  assert.deepEqual(rejections, []);
  assert.equal(session.server.listening, false);
});

test('an idle pult shuts itself down', async (t) => {
  const { projectsDir } = makePultRoot(t);
  let idle;
  const idleReached = new Promise((resolve) => { idle = resolve; });
  const { session } = await startTest(t, projectsDir, { idleMs: 60, idleCheckMs: 20, onIdle: idle });
  await idleReached;
  assert.equal(session.server.listening, false);
});
