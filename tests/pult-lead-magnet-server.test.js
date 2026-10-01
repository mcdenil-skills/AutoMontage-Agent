const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const library = require('../scripts/lead-magnet/library');
const { approveLeadMagnet } = require('../scripts/lead-magnet/approve');
const { buildLeadMagnetInbox } = require('../scripts/lead-magnet/inbox');
const { addDecision, readDecisions } = require('../scripts/lead-magnet/requests');
const { startPultServer } = require('../scripts/pult/server');
const { makePultRoot } = require('./helpers/pult-projects');
const { PARAMS, PNG_BYTES, QUOTE, addLeadMagnetFor, addVideoWithOffer, publishCheckedRevision } = require('./helpers/lead-magnet-fixtures');

function fakeCapture(command, args) {
  if (command === 'ffprobe') {
    return { stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 1080, height: 1920, r_frame_rate: '25/1' }], format: { duration: '4' } }) };
  }
  fs.writeFileSync(args.at(-1), args.at(-1).endsWith('.png') ? PNG_BYTES : 'jpg');
  return { stdout: '' };
}

async function start(t, projectsDir, overrides = {}) {
  const calls = { reveal: [], logs: [] };
  const session = await startPultServer({
    projectsDir,
    idleMs: 0,
    env: {},
    captureImpl: fakeCapture,
    logger: { error: (message) => { calls.logs.push(String(message)); } },
    revealImpl: async (target) => { calls.reveal.push(target); },
    openWindowImpl: async () => {},
    ...overrides,
  });
  t.after(() => session.close());
  return { session, calls };
}

function request(session, pathname, { method = 'GET', token = session.token, origin, json, raw, contentType, headers = {} } = {}) {
  const allHeaders = { ...headers };
  if (token) allHeaders.authorization = `Bearer ${token}`;
  if (origin) allHeaders.origin = origin;
  let payload = null;
  if (json !== undefined || raw !== undefined) {
    payload = raw !== undefined ? Buffer.from(raw) : Buffer.from(JSON.stringify(json));
    allHeaders['content-type'] = contentType || (raw !== undefined ? 'application/octet-stream' : 'application/json');
    allHeaders['content-length'] = payload.length;
  }
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: '127.0.0.1', port: session.server.address().port, path: pathname, method, headers: allHeaders,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        let parsed = null;
        try { parsed = JSON.parse(body.toString('utf8')); } catch (_) { parsed = null; }
        resolve({ status: response.statusCode, headers: response.headers, body, json: parsed });
      });
    });
    outgoing.on('error', reject);
    if (payload) outgoing.write(payload);
    outgoing.end();
  });
}

const get = (session, pathname) => request(session, pathname);
const post = (session, pathname, json) => request(session, pathname, { method: 'POST', origin: session.origin, json });

function root(t, options = {}) {
  const { projectsDir } = makePultRoot(t);
  addVideoWithOffer(projectsDir, { folder: 'clip', name: 'Сайт за вечер', ...options });
  return projectsDir;
}

test('cards carry a light lead magnet summary without paths', async (t) => {
  const projectsDir = root(t, { approve: true, final: true });
  const { session } = await start(t, projectsDir);
  let cards = (await get(session, '/api/cards')).json;
  const ready = cards.ready.find((card) => card.id === 'folder:clip');
  assert.equal(ready.leadMagnetAsk, true);
  assert.deepEqual(ready.variants[0].leadMagnet, { ask: true, status: null, nextStep: null });
  addDecision(path.join(projectsDir, 'clip'), { type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: PARAMS });
  cards = (await get(session, '/api/cards')).json;
  const working = cards.working.find((card) => card.id === 'folder:clip');
  assert.equal(working.nextStep, 'Агент готовит лид-магнит');
  assert.equal(working.variants[0].status, 'ready');
  assert.equal(JSON.stringify(cards).includes(projectsDir), false);
});

function approvedMagnet(projectsDir, folder) {
  addVideoWithOffer(projectsDir, { folder });
  const id = addLeadMagnetFor(projectsDir, folder);
  const { n, pageSha256 } = publishCheckedRevision(projectsDir, id);
  approveLeadMagnet(projectsDir, id, { revision: n, expectedPageSha256: pageSha256, confirmViewed: true });
  return id;
}

test('the video state lists the offer, brand defaults and the approved library, without paths', async (t) => {
  const projectsDir = root(t);
  const libraryId = approvedMagnet(projectsDir, 'other');
  const { session } = await start(t, projectsDir);
  const response = await get(session, '/api/lead-magnet?key=clip');
  assert.equal(response.status, 200);
  const state = response.json;
  assert.deepEqual(state.offers.map((offer) => [offer.codeWord, offer.state, offer.quote]), [['ГАЙД', 'ask', QUOTE]]);
  assert.deepEqual(state.brand, { call: { title: 'Понравилось?', buttons: [] }, socials: [], source: 'neutral', name: 'Нейтральный', logoRequired: false, defaultTake: { composition: true, colors: true, fonts: true } });
  assert.deepEqual(state.library.map((item) => item.id), [libraryId]);
  assert.deepEqual(state.magnets, []);
  assert.equal(JSON.stringify(state).includes(projectsDir), false);
  assert.equal((await get(session, '/api/lead-magnet?key=nope')).status, 404);
});

test('promise current distinguishes same, changed, missing and unavailable source without paths', async (t) => {
  const projectsDir = root(t);
  const id = approvedMagnet(projectsDir, 'other');
  const source = path.join(projectsDir, 'other');
  const { session } = await start(t, projectsDir);
  const current = async () => (await get(session, '/api/lead-magnet?key=other')).json.magnets[0].promise;
  assert.deepEqual(await current(), { quote: QUOTE, startSec: null, sourceFolder: 'other',
    current: { state: 'same', quote: QUOTE, offerId: 'o-gayd' } });
  fs.writeFileSync(path.join(source, 'script.txt'), 'Финал. и я пришлю пошаговую инструкцию и семь промптов.');
  require('../scripts/lead-magnet/offers').addOffer(source, {
    codeWord: 'ГАЙД', kind: 'comment-keyword', quote: 'и я пришлю пошаговую инструкцию и семь промптов',
    units: require('./helpers/lead-magnet-fixtures').UNITS, sourceKind: 'script', scriptPath: 'script.txt',
  });
  assert.deepEqual((await current()).current, { state: 'changed', quote: 'и я пришлю пошаговую инструкцию и семь промптов', offerId: 'o-gayd' });
  fs.writeFileSync(path.join(source, 'lead-magnet', 'offers.json'), JSON.stringify({ version: 1, offers: [] }));
  assert.deepEqual((await current()).current, { state: 'missing', quote: null, offerId: null });
  fs.renameSync(path.join(source, 'lead-magnet', 'offers.json'), path.join(source, 'lead-magnet', 'offers.hidden'));
  assert.deepEqual((await current()).current, { state: 'unknown', quote: null, offerId: null });
  const state = (await get(session, '/api/lead-magnet?key=other')).json;
  assert.equal(JSON.stringify(state).includes(projectsDir), false);
  assert.equal(state.magnets[0].promiseChanged, true);
  assert.equal(id, state.magnets[0].id);
});

test('the browser response never exposes an unsafe source folder from a passport', async (t) => {
  const projectsDir = root(t);
  const id = approvedMagnet(projectsDir, 'other');
  library.linkVideo(projectsDir, id, { folder: 'clip', codeWord: 'ГАЙД' });
  const passportPath = path.join(projectsDir, '.lead-magnets', id, 'lead-magnet.json');
  const original = JSON.parse(fs.readFileSync(passportPath, 'utf8'));
  const { session } = await start(t, projectsDir);
  const safe = (await get(session, '/api/lead-magnet?key=clip')).json.magnets[0].promise;
  assert.equal(safe.sourceFolder, 'other');
  for (const unsafe of ['/private/client/source', '../client/source']) {
    const passport = structuredClone(original);
    passport.promise.sourceFolder = unsafe;
    fs.writeFileSync(passportPath, JSON.stringify(passport));
    const response = await get(session, '/api/lead-magnet?key=clip');
    assert.equal(response.status, 200);
    assert.equal(response.body.toString('utf8').includes(unsafe), false);
    assert.deepEqual(response.json.magnets[0].promise.current,
      { state: 'unknown', quote: null, offerId: null });
    assert.equal(response.json.magnets[0].promiseChanged, true);
  }
});

test('promise decisions reject a linked video key and missing keep requires null offer ID', async (t) => {
  const projectsDir = root(t);
  const id = approvedMagnet(projectsDir, 'other');
  library.linkVideo(projectsDir, id, { folder: 'clip', codeWord: 'ГАЙД' });
  const { session } = await start(t, projectsDir);
  const body = { type: 'promise-keep', offerId: 'o-gayd', leadMagnetId: id };
  assert.equal((await post(session, '/api/lead-magnet/decision', { key: 'clip', ...body })).status, 400);
  assert.equal((await post(session, '/api/lead-magnet/decision', { key: 'clip', ...body, type: 'promise-refresh' })).status, 400);
  assert.equal(fs.existsSync(path.join(projectsDir, 'clip', 'pult', 'lead-magnet.json')), false);
  fs.writeFileSync(path.join(projectsDir, 'other', 'lead-magnet', 'offers.json'), JSON.stringify({ version: 1, offers: [] }));
  assert.equal((await post(session, '/api/lead-magnet/decision', { key: 'other', ...body })).status, 400);
  assert.equal((await post(session, '/api/lead-magnet/decision', { key: 'other', ...body, offerId: null })).status, 201);
  assert.deepEqual(library.readLeadMagnet(projectsDir, id).promise.acknowledged, ['']);
  assert.equal(readDecisions(path.join(projectsDir, 'other')).at(-1).offerId, null);
  fs.renameSync(path.join(projectsDir, 'other', 'lead-magnet', 'offers.json'),
    path.join(projectsDir, 'other', 'lead-magnet', 'offers.hidden'));
  assert.equal((await post(session, '/api/lead-magnet/decision', { key: 'other', ...body, offerId: null })).status, 400);
  assert.equal(readDecisions(path.join(projectsDir, 'other')).length, 1);
});

test('decisions need exact bodies; create reaches the inbox, decline does not', async (t) => {
  const projectsDir = root(t);
  const { session } = await start(t, projectsDir);
  const create = { key: 'clip', type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: PARAMS };
  const created = await post(session, '/api/lead-magnet/decision', create);
  assert.equal(created.status, 201);
  assert.equal(created.json.decision.status, 'new');
  assert.equal(buildLeadMagnetInbox({ projectsDir }).decisions.length, 1);
  const declined = await post(session, '/api/lead-magnet/decision', { key: 'clip', type: 'decline', offerId: 'o-gayd', codeWord: 'ГАЙД' });
  assert.equal(declined.json.decision.status, 'accepted');
  assert.equal(buildLeadMagnetInbox({ projectsDir }).decisions.length, 1);
  assert.equal((await post(session, '/api/lead-magnet/decision', { ...create, extra: 1 })).status, 400);
  const unconfirmed = await post(session, '/api/lead-magnet/decision', { ...create, params: { ...PARAMS, promiseConfirmed: false } });
  assert.equal(unconfirmed.status, 400);
  assert.match(unconfirmed.json.message, /подтвердите/);
  const unknown = await post(session, '/api/lead-magnet/decision', { key: 'clip', type: 'link', offerId: 'o-gayd', codeWord: 'ГАЙД', leadMagnetId: '2026.01.01_net' });
  assert.equal(unknown.status, 400);
  assert.equal((await request(session, '/api/lead-magnet/decision', { method: 'POST', json: create })).status, 403);
  assert.equal((await request(session, '/api/lead-magnet/decision', { method: 'POST', origin: session.origin, token: null, json: create })).status, 401);
  assert.equal(readDecisions(path.join(projectsDir, 'clip')).length, 2);
});

test('malformed create params return 400 without recording a decision', async (t) => {
  const projectsDir = root(t);
  const { session } = await start(t, projectsDir);
  const create = { key: 'clip', type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: PARAMS };
  const malformed = [
    null,
    {},
    { ...PARAMS, design: null },
    { ...PARAMS, design: { ...PARAMS.design, references: null } },
    { ...PARAMS, design: { ...PARAMS.design, references: [null] } },
  ];
  for (const params of malformed) {
    const response = await post(session, '/api/lead-magnet/decision', { ...create, params });
    assert.equal(response.status, 400, JSON.stringify(params));
    assert.equal(response.json.code, 'INVALID_REQUEST');
  }
  assert.equal(readDecisions(path.join(projectsDir, 'clip')).length, 0);
  const valid = await post(session, '/api/lead-magnet/decision', create);
  assert.equal(valid.status, 201);
  assert.equal(readDecisions(path.join(projectsDir, 'clip')).length, 1);
});

test('a design reference is uploaded as bytes, stored by hash and usable in a create decision', async (t) => {
  const projectsDir = root(t);
  const { session } = await start(t, projectsDir);
  const uploaded = await request(session, '/api/lead-magnet/reference?key=clip', { method: 'POST', origin: session.origin, raw: PNG_BYTES });
  assert.equal(uploaded.status, 201);
  const { reference } = uploaded.json;
  assert.match(reference.path, /^pult\/lead-magnet-refs\/[a-f0-9]{64}\.png$/);
  assert.ok(fs.existsSync(path.join(projectsDir, 'clip', ...reference.path.split('/'))));
  const params = { ...PARAMS, design: { ...PARAMS.design, mode: 'reference', references: [reference, { kind: 'url', url: 'https://example.com/guide' }] } };
  const created = await post(session, '/api/lead-magnet/decision', { key: 'clip', type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params });
  assert.equal(created.status, 201);
});

test('reference upload refuses spoofed types, wrong content type, oversize, foreign origin and unknown video', async (t) => {
  const projectsDir = root(t);
  const { session } = await start(t, projectsDir);
  const upload = (options) => request(session, '/api/lead-magnet/reference?key=clip', { method: 'POST', origin: session.origin, ...options });
  const spoofed = await upload({ raw: Buffer.from('MZ\u0090\u0000 not an image') });
  assert.deepEqual([spoofed.status, spoofed.json.code], [400, 'REFERENCE_INVALID']);
  assert.equal((await upload({ raw: PNG_BYTES, contentType: 'image/png' })).status, 415);
  const huge = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(30 * 1024 * 1024)]);
  assert.equal((await upload({ raw: huge })).status, 413);
  assert.equal((await request(session, '/api/lead-magnet/reference?key=clip', { method: 'POST', raw: PNG_BYTES })).status, 403);
  assert.equal((await request(session, '/api/lead-magnet/reference?key=nope', { method: 'POST', origin: session.origin, raw: PNG_BYTES })).status, 404);
  assert.equal(fs.existsSync(path.join(projectsDir, 'clip', 'pult', 'lead-magnet-refs')), false);
});

test('an uploaded HTML reference is stored but never served by the pult', async (t) => {
  const projectsDir = root(t);
  const { session } = await start(t, projectsDir);
  const html = Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>');
  const { reference } = (await request(session, '/api/lead-magnet/reference?key=clip', { method: 'POST', origin: session.origin, raw: html })).json;
  assert.match(reference.path, /\.html$/);
  assert.equal((await get(session, `/${reference.path}`)).status, 404);
  assert.equal((await get(session, `/clip/${reference.path}`)).status, 404);
});

test('«Уже есть готовый» attaches the video to the chosen lead magnet at once', async (t) => {
  const projectsDir = root(t);
  const libraryId = approvedMagnet(projectsDir, 'other');
  const { session } = await start(t, projectsDir);
  const linked = await post(session, '/api/lead-magnet/decision', {
    key: 'clip', type: 'link', offerId: 'o-gayd', codeWord: 'ГАЙД', leadMagnetId: libraryId,
  });
  assert.equal(linked.status, 201);
  assert.deepEqual(library.readLeadMagnet(projectsDir, libraryId).videos, ['other', 'clip']);
  const state = (await get(session, '/api/lead-magnet?key=clip')).json;
  assert.equal(state.offers[0].state, 'linked');
  assert.deepEqual(state.magnets.map((magnet) => [magnet.id, magnet.status]), [[libraryId, 'ready']]);
});

test('the lead magnet screen script is served like the rest of the pult', async (t) => {
  const { session } = await start(t, root(t));
  const script = await request(session, '/lead-magnet.js', { token: null });
  assert.equal(script.status, 200);
  assert.match(script.headers['content-type'], /^text\/javascript/);
  assert.match(script.body.toString('utf8'), /function lmCardTag/);
});

module.exports = { get, post, request, root, start };

async function publishedMagnet(t) {
  const projectsDir = root(t);
  const id = addLeadMagnetFor(projectsDir, 'clip');
  const published = publishCheckedRevision(projectsDir, id);
  const { session, calls } = await start(t, projectsDir);
  const state = (await get(session, '/api/lead-magnet?key=clip')).json;
  return { projectsDir, id, session, calls, state, ...published };
}

test('the page is served only by its own ticket, sandboxed and offline', async (t) => {
  const { session, state, dir } = await publishedMagnet(t);
  const { pageUrl } = state.magnets[0].revision;
  const original = fs.readFileSync(path.join(dir, 'page.html'));
  const page = await request(session, pageUrl, { token: null });
  assert.equal(page.status, 200);
  const csp = page.headers['content-security-policy'];
  for (const directive of ["default-src 'none'", "connect-src 'none'", "frame-ancestors 'self'", 'sandbox allow-scripts']) {
    assert.ok(csp.includes(directive), directive);
  }
  assert.equal(csp.includes('allow-same-origin'), false);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'page.html')), original);
  const head = await request(session, pageUrl, { method: 'HEAD', token: null });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-security-policy'], csp);
  assert.equal((await request(session, pageUrl.replace(/rev=\d+/, 'rev=99'), { token: null })).status, 404);
  const html = page.body.toString('utf8');
  assert.match(html, /data-lm-block="hero"/);
  // Скрипт правок встроен сервером перед </body>; само слово data-lm-block есть и в странице,
  // поэтому ищем именно строку сообщения скрипта.
  const injected = html.indexOf("type: 'lm-block'");
  assert.ok(injected > 0);
  assert.ok(injected < html.lastIndexOf('</body>'));
  assert.equal((await request(session, pageUrl.replace(/ticket=[^&]+/, 'ticket=wrong'), { token: null })).status, 404);
  assert.equal((await request(session, pageUrl, { method: 'POST', token: null, origin: session.origin, json: {} })).status, 405);
  fs.appendFileSync(path.join(dir, 'page.html'), '<!-- changed -->');
  assert.equal((await request(session, pageUrl, { token: null })).status, 404);
});

test('a block comment gets a snapshot from the QA screenshot; a text comment has none', async (t) => {
  const { id, n, session } = await publishedMagnet(t);
  const block = { kind: 'block', blockId: 'steps', view: 'phone', rect: { x: 0, y: 10, w: 300, h: 200 } };
  const added = await post(session, '/api/lead-magnet/comment', { id, revision: n, target: block, text: 'короче' });
  assert.equal(added.status, 201);
  await post(session, '/api/lead-magnet/comment', { id, revision: n, target: { kind: 'text', text: 'dm' }, text: 'без смайлов' });
  const [onBlock, onText] = (await get(session, '/api/lead-magnet?key=clip')).json.magnets[0].comments;
  assert.ok(onBlock.snapshotUrl);
  assert.equal(onText.snapshotUrl, null);
  const snapshot = await request(session, `${onBlock.snapshotUrl}&token=${encodeURIComponent(session.token)}`, { token: null });
  assert.deepEqual([snapshot.status, snapshot.headers['content-type']], [200, 'image/png']);
  assert.equal((await request(session, onBlock.snapshotUrl, { token: null })).status, 401);
  assert.equal((await post(session, '/api/lead-magnet/comment', { id, revision: 9, target: block, text: 'x' })).status, 400);
  assert.equal((await post(session, '/api/lead-magnet/comment/delete', { id, commentId: onBlock.id })).status, 200);
  assert.equal((await post(session, '/api/lead-magnet/comment/delete', { id, commentId: 'c-zzzzzzzz' })).status, 400);
});

test('approval needs the checkbox and the ticket of the viewed revision', async (t) => {
  const { projectsDir, id, n, session, state } = await publishedMagnet(t);
  const ticket = state.magnets[0].revision.approvalTicket;
  assert.ok(ticket);
  const approve = (body) => post(session, '/api/lead-magnet/approve', { id, ticket, confirmViewed: true, ...body });
  assert.equal((await approve({ confirmViewed: false })).status, 400);
  const stale = await approve({ ticket: 'stale' });
  assert.deepEqual([stale.status, stale.json.code], [409, 'LM_CHANGED']);
  assert.equal((await approve({})).status, 201);
  assert.equal(library.readLeadMagnet(projectsDir, id).approved, n);
  const after = (await get(session, '/api/lead-magnet?key=clip')).json.magnets[0];
  assert.deepEqual([after.status, after.revision.approvalTicket], ['ready', null]);
  assert.equal((await approve({})).status, 409);
});

test('a comment that arrives before approval and a red check both block it', async (t) => {
  const { id, n, session, state } = await publishedMagnet(t);
  const { approvalTicket: ticket } = state.magnets[0].revision;
  await post(session, '/api/lead-magnet/comment', { id, revision: n, target: { kind: 'text', text: 'dm' }, text: 'короче' });
  const pending = await post(session, '/api/lead-magnet/approve', { id, ticket, confirmViewed: true });
  assert.deepEqual([pending.status, pending.json.code], [409, 'LM_PENDING_COMMENTS']);

  const projectsDir = root(t);
  const redId = addLeadMagnetFor(projectsDir, 'clip');
  publishCheckedRevision(projectsDir, redId, { ok: false });
  const red = await start(t, projectsDir);
  const redState = (await get(red.session, '/api/lead-magnet?key=clip')).json.magnets[0];
  assert.equal(redState.revision.approvalTicket, null);
  assert.equal(redState.revision.ready, false);
  assert.equal((await post(red.session, '/api/lead-magnet/approve', { id: redId, ticket: 'x', confirmViewed: true })).status, 409);
});

test('«Показать в папке» opens only whitelisted files of the shown revision', async (t) => {
  const { id, session, calls, state } = await publishedMagnet(t);
  assert.deepEqual(state.magnets[0].files, {
    revision: 1, list: ['page.html', 'page.pdf', 'texts/dm.txt', 'texts/telegram.txt', 'texts/instagram.txt'],
  });
  assert.equal((await post(session, '/api/lead-magnet/reveal', { id, file: 'page.pdf' })).status, 200);
  assert.match(calls.reveal[0], /v01[\\/]page\.pdf$/);
  assert.equal((await post(session, '/api/lead-magnet/reveal', { id, file: '../lead-magnet.json' })).status, 400);
  assert.equal((await post(session, '/api/lead-magnet/reveal', { id: '2026.01.01_net', file: 'page.pdf' })).status, 404);
});

test('approval rejects changed page bytes, a newer revision and a newly red check', async (t) => {
  for (const change of ['page', 'revision', 'check']) {
    const { projectsDir, id, dir, session, state } = await publishedMagnet(t);
    const ticket = state.magnets[0].revision.approvalTicket;
    if (change === 'page') fs.appendFileSync(path.join(dir, 'page.html'), '<!-- changed -->');
    if (change === 'revision') publishCheckedRevision(projectsDir, id);
    if (change === 'check') {
      const file = path.join(dir, 'qa', 'check.json');
      const report = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...report, ok: false }));
    }
    const result = await post(session, '/api/lead-magnet/approve', { id, ticket, confirmViewed: true });
    assert.deepEqual([result.status, result.json.code], change === 'check' ? [422, 'LM_CHECK_FAILED'] : [409, 'LM_CHANGED']);
    assert.equal(library.readLeadMagnet(projectsDir, id).approved, null);
  }
});

test('approval and reveal require authentication, origin and exact request bodies', async (t) => {
  const { id, session, state, calls, projectsDir } = await publishedMagnet(t);
  const bodies = {
    approve: { id, ticket: state.magnets[0].revision.approvalTicket, confirmViewed: true },
    reveal: { id, file: 'page.pdf' },
  };
  for (const [action, json] of Object.entries(bodies)) {
    const url = `/api/lead-magnet/${action}`;
    assert.equal((await request(session, url, { method: 'POST', origin: session.origin, token: null, json })).status, 401);
    assert.equal((await request(session, url, { method: 'POST', origin: 'https://example.com', json })).status, 403);
    assert.equal((await post(session, url, { ...json, extra: true })).status, 400);
  }
  assert.equal(library.readLeadMagnet(projectsDir, id).approved, null);
  assert.deepEqual(calls.reveal, []);
});

test('reveal rejects symlinks and missing files and reports opener failures without paths', async (t) => {
  const { id, dir, session, calls } = await publishedMagnet(t);
  fs.unlinkSync(path.join(dir, 'page.pdf'));
  fs.symlinkSync(path.join(dir, 'content.md'), path.join(dir, 'page.pdf'));
  assert.equal((await post(session, '/api/lead-magnet/reveal', { id, file: 'page.pdf' })).status, 404);
  fs.unlinkSync(path.join(dir, 'texts', 'dm.txt'));
  assert.equal((await post(session, '/api/lead-magnet/reveal', { id, file: 'texts/dm.txt' })).status, 404);
  assert.deepEqual(calls.reveal, []);
  const projectsDir = root(t);
  const failedId = addLeadMagnetFor(projectsDir, 'clip');
  publishCheckedRevision(projectsDir, failedId);
  const failed = await start(t, projectsDir, { revealImpl: async () => { throw new Error(`cannot open ${projectsDir}`); } });
  const result = await post(failed.session, '/api/lead-magnet/reveal', { id: failedId, file: 'page.pdf' });
  assert.deepEqual([result.status, result.json.code], [409, 'REVEAL_FAILED']);
  assert.equal(JSON.stringify([result.json, failed.calls.logs]).includes(projectsDir), false);
});

test('approval rechecks the source promise after issuing the ticket', async (t) => {
  for (const change of ['changed', 'missing', 'unknown']) {
    await t.test(change, async (t) => {
      const { projectsDir, id, session, state } = await publishedMagnet(t);
      const ticket = state.magnets[0].revision.approvalTicket;
      assert.ok(ticket);
      const offersPath = path.join(projectsDir, 'clip', 'lead-magnet', 'offers.json');
      const offers = JSON.parse(fs.readFileSync(offersPath, 'utf8'));
      if (change === 'changed') offers.offers[0].quote = 'и я пришлю пошаговую инструкцию и семь промптов';
      if (change === 'missing') offers.offers = [];
      fs.writeFileSync(offersPath, change === 'unknown' ? '{broken' : JSON.stringify(offers));
      const fresh = (await get(session, '/api/lead-magnet?key=clip')).json.magnets[0];
      assert.equal(fresh.promise.current.state, change);
      assert.equal(fresh.approvable, false);
      assert.equal(fresh.revision.approvalTicket, null);
      const response = await post(session, '/api/lead-magnet/approve', { id, ticket, confirmViewed: true });
      assert.deepEqual([response.status, response.json.code], [409, 'LM_CHANGED']);
      assert.equal(library.readLeadMagnet(projectsDir, id).approved, null);
      assert.equal(JSON.stringify(response.json).includes(projectsDir), false);
    });
  }
});

test('approval accepts an unchanged or explicitly acknowledged source promise', async (t) => {
  for (const change of ['same', 'changed', 'missing']) {
    await t.test(change, async (t) => {
      const { projectsDir, id, session } = await publishedMagnet(t);
      let n = library.readLeadMagnet(projectsDir, id).current;
      if (change !== 'same') {
        const offersPath = path.join(projectsDir, 'clip', 'lead-magnet', 'offers.json');
        const offers = JSON.parse(fs.readFileSync(offersPath, 'utf8'));
        if (change === 'changed') offers.offers[0].quote = 'и я пришлю пошаговую инструкцию и семь промптов';
        else offers.offers = [];
        fs.writeFileSync(offersPath, JSON.stringify(offers));
        const keep = await post(session, '/api/lead-magnet/decision', {
          key: 'clip', type: 'promise-keep', offerId: change === 'missing' ? null : 'o-gayd', leadMagnetId: id,
        });
        assert.equal(keep.status, 201);
        // Acknowledgement changes the QA input fingerprint; publish a checked fixture for it.
        n = publishCheckedRevision(projectsDir, id).n;
      }
      const fresh = (await get(session, '/api/lead-magnet?key=clip')).json.magnets[0];
      assert.equal(fresh.approvable, true);
      const ticket = fresh.revision.approvalTicket;
      assert.ok(ticket);
      const response = await post(session, '/api/lead-magnet/approve', { id, ticket, confirmViewed: true });
      assert.equal(response.status, 201);
      assert.equal(library.readLeadMagnet(projectsDir, id).approved, n);
    });
  }
});

test('the state offers the last custom link and the brand call', async (t) => {
  const projectsDir = root(t);
  const id = addLeadMagnetFor(projectsDir, 'clip');
  const passport = library.readLeadMagnet(projectsDir, id);
  library.savePassport(projectsDir, { ...passport, params: { ...passport.params, cta: { mode: 'link', title: 'Глубже?', label: 'Практикум', url: 'https://example.com/p' } } }, () => new Date());
  const { session } = await start(t, projectsDir);
  const state = (await get(session, '/api/lead-magnet?key=clip')).json;
  assert.deepEqual(state.lastLink, { title: 'Глубже?', label: 'Практикум', url: 'https://example.com/p' });
  assert.deepEqual(Object.keys(state.brand.call).sort(), ['buttons', 'title']);
  assert.ok(Array.isArray(state.brand.socials));
});
