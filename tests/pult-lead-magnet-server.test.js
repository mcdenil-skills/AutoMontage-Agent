const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { addDecision } = require('../scripts/lead-magnet/requests');
const { startPultServer } = require('../scripts/pult/server');
const { makePultRoot } = require('./helpers/pult-projects');
const { PARAMS, PNG_BYTES, addVideoWithOffer } = require('./helpers/lead-magnet-fixtures');

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

module.exports = { get, post, request, root, start };
