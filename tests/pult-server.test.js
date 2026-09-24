const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { readProjectManifest } = require('../scripts/project/workspace');
const { acceptComment } = require('../scripts/pult/comments');
const { startPultServer } = require('../scripts/pult/server');
const { addDraftProject, addLegacyFolder, makePultRoot } = require('./helpers/pult-projects');

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
  const calls = { reveal: [], windows: [], reviews: [] };
  const session = await startPultServer({
    projectsDir,
    idleMs: 0,
    captureImpl: fakeCapture,
    revealImpl: async (target) => { calls.reveal.push(target); },
    openWindowImpl: async (url) => { calls.windows.push(url); },
    startReviewServerImpl: async (options) => {
      calls.reviews.push(options);
      const server = http.createServer((incoming, outgoing) => outgoing.end('review'));
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return { server, url: `http://127.0.0.1:${server.address().port}/#token=review` };
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
  await session.close();
  assert.equal(session.reviewSessions.size, 0);
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
