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
  assert.deepEqual(state.brand, { source: 'neutral', name: 'Нейтральный', logoRequired: false, defaultTake: { composition: true, colors: true, fonts: true } });
  assert.deepEqual(state.library.map((item) => item.id), [libraryId]);
  assert.deepEqual(state.magnets, []);
  assert.equal(JSON.stringify(state).includes(projectsDir), false);
  assert.equal((await get(session, '/api/lead-magnet?key=nope')).status, 404);
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

module.exports = { get, post, request, root, start };
