const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { planPreview, publishCurrentPreview } = require('../scripts/project/preview-workspace');
const { createOrOpenProject, readProjectManifest } = require('../scripts/project/workspace');
const { acceptComment } = require('../scripts/pult/comments');
const { startPultServer } = require('../scripts/pult/server');
const {
  addDraftProject, addLegacyFolder, makePultRoot, sha256, unresolvedBrollScenes,
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
      const server = http.createServer((incoming, outgoing) => outgoing.end('review'));
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return {
        server,
        url: `http://127.0.0.1:${server.address().port}/#token=review`,
        // Запоминаем, слушал ли Review в момент вызова: так видно порядок abort → close → wait.
        abortActiveImports() { calls.shutdown.push(['abort', server.listening]); },
        async waitForActiveImports() { calls.shutdown.push(['wait', server.listening]); },
      };
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

// Новый полный preview того же черновика — как это делает агент после правки.
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
  assert.match(variant.video.url, /^\/media\/video\?key=waiting-clip$/);
  assert.deepEqual(variant.meta, { width: 1080, height: 1920, durationSec: 4 });
  assert.equal(typeof variant.approvalTicket, 'string');
  const text = JSON.stringify(cards);
  assert.ok(!text.includes(projectsDir));
  assert.doesNotMatch(text, /[a-f0-9]{64}/);
  assert.doesNotMatch(text, /brief\//);
  assert.equal(cards.ready[0].variants[0].approvalTicket, null);
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
  // 'Ready-Clip' — другое написание папки: на APFS/NTFS оно не должно найти ролик.
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
  assert.equal(variant.nextStep, 'Утверждено — агент собирает финал');
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
  assert.ok(!blocked.body.toString('utf8').includes(projectsDir));
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

test('approval checks the preview bytes the page was shown', async (t) => {
  const projectsDir = await standardRoot(t);
  const { session } = await startTest(t, projectsDir);
  const ticket = (await variantOf(session, 'waiting-clip')).approvalTicket;
  const previewFile = previewFileOf(projectsDir, 'waiting-clip');
  const original = fs.readFileSync(previewFile);
  fs.chmodSync(previewFile, 0o644);

  fs.writeFileSync(previewFile, 'bytes the author never saw');
  const swapped = await approve(session, 'waiting-clip', ticket);
  assert.equal(swapped.status, 409);
  assert.equal(swapped.json.code, 'PREVIEW_CHANGED');
  fs.rmSync(previewFile);
  const missing = await approve(session, 'waiting-clip', ticket);
  assert.equal(missing.status, 409);
  assert.equal(missing.json.code, 'PREVIEW_CHANGED');
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
  assert.ok(!failed.body.toString('utf8').includes(projectsDir));
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

function reviewGet(review) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: review.server.address().port, path: '/' }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    }).on('error', reject);
  });
}

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
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(session.server.listening, true);
  assert.equal(review.server.listening, true);
  clock = 1901;
  await idleReached;
  assert.equal(session.server.listening, false);
  assert.equal(review.server.listening, false);
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

test('an idle pult shuts itself down', async (t) => {
  const { projectsDir } = makePultRoot(t);
  let idle;
  const idleReached = new Promise((resolve) => { idle = resolve; });
  const { session } = await startTest(t, projectsDir, { idleMs: 60, idleCheckMs: 20, onIdle: idle });
  await idleReached;
  assert.equal(session.server.listening, false);
});
