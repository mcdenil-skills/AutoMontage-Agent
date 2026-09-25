const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { startReviewServer } = require('../scripts/review/server');
const { inspectImportedAssetBundle } = require('../scripts/review/imported-assets');
const { mediaImportError } = require('../scripts/review/media-import');
const { makeReviewProject, registerHigherBrief } = require('./helpers/review-project');
const { windowsFileSystem } = require('./helpers/windows-filesystem');

const IMPORT_UUID = '4af36be4-0b26-4e6f-bd48-8bdd2215a4f1';
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const WINDOWS = process.platform === 'win32';

function request(session, pathname, {
  token,
  queryToken = false,
  method = 'GET',
  origin,
  body,
  chunked = false,
  contentType = 'application/json',
  headers: extraHeaders = {},
} = {}) {
  const suffix = queryToken && token
    ? `${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
    : '';
  const headers = { ...extraHeaders };
  if (token && !queryToken) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  if (body !== undefined) {
    headers['content-type'] = contentType;
    if (chunked) headers['transfer-encoding'] = 'chunked';
    else headers['content-length'] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: '127.0.0.1',
      port: session.server.address().port,
      path: `${pathname}${suffix}`,
      method,
      headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    outgoing.on('error', reject);
    if (body !== undefined && chunked) {
      const split = Math.floor(body.length / 2);
      outgoing.write(body.subarray(0, split));
      outgoing.end(body.subarray(split));
    } else if (body !== undefined) outgoing.end(body);
    else outgoing.end();
  });
}

function earlyResponse(session, pathname, {
  token,
  method = 'POST',
  origin,
  headers = {},
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let outgoing;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outgoing.destroy();
      resolve(value);
    };
    outgoing = http.request({
      host: '127.0.0.1',
      port: session.server.address().port,
      path: pathname,
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(origin ? { origin } : {}),
        'content-length': '1048576',
        'content-type': 'video/mp4',
        'x-automontage-filename': 'clip.mp4',
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => finish({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    outgoing.on('error', (error) => {
      if (!settled) reject(error);
    });
    const timer = setTimeout(() => {
      outgoing.destroy();
      finish({ status: 0, body: 'timed out waiting for an early response' });
    }, 500);
    outgoing.flushHeaders();
  });
}

function writeImportedVideoBundle(projectDir, {
  id = IMPORT_UUID,
  label = 'Product demo.mov',
  canonicalBytes = Buffer.from('canonical video'),
  previewBytes = Buffer.from('preview video'),
} = {}) {
  const mediaDirectory = path.join(projectDir, 'assets', 'broll', 'video', id);
  const previewPath = path.join(projectDir, 'previews', 'broll', `${id}.webm`);
  fs.mkdirSync(mediaDirectory, { recursive: true });
  fs.mkdirSync(path.dirname(previewPath), { recursive: true });
  const canonicalPath = path.join(mediaDirectory, 'media.mp4');
  fs.writeFileSync(canonicalPath, canonicalBytes);
  fs.writeFileSync(previewPath, previewBytes);
  fs.writeFileSync(path.join(mediaDirectory, 'asset.json'), `${JSON.stringify({
    version: 2,
    id,
    label,
    mediaKind: 'video',
    canonicalSha256: sha256(canonicalBytes),
    previewSha256: sha256(previewBytes),
    width: 1920,
    height: 1080,
    fps: 25,
    durationSec: 18.4,
    audioDurationSec: 18.4,
    hasAudio: true,
  })}\n`);
  return {
    canonicalPath,
    mediaDirectory,
    previewPath,
    record: inspectImportedAssetBundle({ projectDir, assetDirectory: mediaDirectory }),
  };
}

function registerCurrentPreview(fixture, bytes = Buffer.from('rendered preview fixture')) {
  const revisionPath = path.join(fixture.workspace.dir, 'previews', 'v01-draft-full.mp4');
  const currentPath = path.join(fixture.workspace.dir, 'previews', 'current-preview.mp4');
  fs.writeFileSync(revisionPath, bytes);
  fs.writeFileSync(currentPath, bytes);
  const manifestPath = path.join(fixture.workspace.dir, 'project.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.currentPreview = {
    filePath: 'previews/v01-draft-full.mp4',
    briefPath: manifest.currentBrief,
    kind: 'full', fromSec: 0, toSec: 4,
    width: 960, height: 540, fps: 25,
    generatedAt: '2026-08-23T17:05:00.000Z',
    sha256: sha256(bytes),
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { currentPath, revisionPath, manifestPath };
}

function importHeaders(filename = 'clip.mp4', contentType = 'video/mp4') {
  return {
    'content-type': contentType,
    'x-automontage-filename': encodeURIComponent(filename),
  };
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
}

function startTestReviewServer(options) {
  return startReviewServer({
    runToolImpl: () => {
      throw new Error('waveform unavailable in unrelated server test');
    },
    ...options,
  });
}

function jsonBody(value) {
  return JSON.stringify(value);
}

async function editablePayload(session, commands = [{
  type: 'move-boundary',
  leftSceneIndex: 0,
  seconds: 2.2,
}]) {
  const response = await request(session, '/api/state', { token: session.token });
  assert.equal(response.status, 200);
  const state = JSON.parse(response.body.toString('utf8'));
  return {
    state,
    payload: {
      baseRevision: state.session.baseRevision,
      baseHash: state.session.baseHash,
      manifestHash: state.session.manifestHash,
      commands,
    },
  };
}

function postJson(session, pathname, value, overrides = {}) {
  return request(session, pathname, {
    token: session.token,
    method: 'POST',
    origin: session.origin,
    body: jsonBody(value),
    ...overrides,
  });
}

function waitForFile(filePath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (fs.existsSync(filePath)) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for ${path.basename(filePath)}`));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

function runNodeWorker(workerPath, args) {
  const child = spawn(process.execPath, [workerPath, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  const completed = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `review worker exited ${code}: ${Buffer.concat(stderr).toString('utf8') || Buffer.concat(stdout).toString('utf8')}`,
      ));
    });
  });
  return { child, completed };
}

test('review server binds only to loopback and keeps its token in the URL fragment', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const session = await startTestReviewServer({ root: ROOT, projectDir, open: false });
  t.after(() => closeServer(session.server));

  const address = session.server.address();
  assert.equal(address.address, '127.0.0.1');
  assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    session.url,
    `http://127.0.0.1:${address.port}/#token=${session.token}`,
  );

  const shell = await request(session, '/');
  assert.notEqual(shell.status, 401);
  assert.doesNotMatch(shell.body.toString('utf8'), /#token=|Bearer |baseHash|manifestHash/);
});

test('no-open creates an exclusive 0600 session URL handoff and removes it on close', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const handoffDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-review-handoff-'));
  t.after(() => fs.rmSync(handoffDirectory, { recursive: true, force: true }));
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir,
    open: false,
    handoffDirectory,
    handoffId: () => 'fixed-safe-id',
  });
  t.after(() => closeServer(session.server));
  const expectedPath = path.join(handoffDirectory, 'automontage-review-fixed-safe-id.url');

  assert.equal(session.handoffPath, expectedPath);
  assert.equal(fs.statSync(expectedPath).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(expectedPath, 'utf8'), `${session.url}\n`);
  assert.doesNotMatch(expectedPath, new RegExp(session.token));

  await closeServer(session.server);
  assert.equal(fs.existsSync(expectedPath), false);
});

test('Windows-mode handoff stays exclusive without POSIX modes or O_NOFOLLOW', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const handoffDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-review-win-handoff-'));
  t.after(() => fs.rmSync(handoffDirectory, { recursive: true, force: true }));
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir,
    open: false,
    handoffDirectory,
    handoffId: () => 'windows-safe-id',
    handoffFileSystem: windowsFileSystem(fs),
  });
  t.after(() => closeServer(session.server));

  assert.equal(fs.lstatSync(session.handoffPath).isFile(), true);
  assert.equal(fs.readFileSync(session.handoffPath, 'utf8'), `${session.url}\n`);
  await closeServer(session.server);
  assert.equal(fs.existsSync(session.handoffPath), false);
});

test('browser launch failure falls back to handoff while successful launch leaves no token file', async (t) => {
  const failedFixture = makeReviewProject(t);
  const failedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-review-open-failed-'));
  t.after(() => fs.rmSync(failedDirectory, { recursive: true, force: true }));
  let failedLaunchUrl = null;
  const failed = await startTestReviewServer({
    root: ROOT,
    projectDir: failedFixture.projectDir,
    open: true,
    openBrowserImpl: async (url) => {
      failedLaunchUrl = url;
      throw new Error('browser unavailable');
    },
    handoffDirectory: failedDirectory,
    handoffId: () => 'browser-fallback',
  });
  t.after(() => closeServer(failed.server));
  assert.equal(failedLaunchUrl, failed.url);
  assert.equal(
    fs.readFileSync(failed.handoffPath, 'utf8'),
    `${failed.url}\n`,
  );

  const successFixture = makeReviewProject(t);
  const successDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-review-open-ok-'));
  t.after(() => fs.rmSync(successDirectory, { recursive: true, force: true }));
  let successfulLaunchUrl = null;
  const successful = await startTestReviewServer({
    root: ROOT,
    projectDir: successFixture.projectDir,
    open: true,
    openBrowserImpl: async (url) => { successfulLaunchUrl = url; },
    handoffDirectory: successDirectory,
  });
  t.after(() => closeServer(successful.server));
  assert.equal(successfulLaunchUrl, successful.url);
  assert.equal(successful.handoffPath, null);
  assert.deepEqual(fs.readdirSync(successDirectory), []);
});

test('handoff collision, symlink and write failure all fail closed without overwriting', async (t) => {
  for (const kind of ['collision', 'symlink', 'write-failure']) {
    await t.test(kind, async () => {
      const fixture = makeReviewProject(t);
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), `automontage-review-${kind}-`));
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const id = `fixed-${kind}`;
      const handoffPath = path.join(directory, `automontage-review-${id}.url`);
      const outside = path.join(fixture.root, `${kind}-outside.txt`);
      fs.writeFileSync(outside, 'outside-safe');
      if (kind === 'collision') fs.writeFileSync(handoffPath, 'existing-safe');
      if (kind === 'symlink') fs.symlinkSync(outside, handoffPath);
      const handoffFileSystem = kind === 'write-failure'
        ? {
          ...fs,
          openSync(target, flags, mode) {
            if (path.resolve(String(target)) === handoffPath) {
              const error = new Error('simulated handoff write failure');
              error.code = 'EACCES';
              throw error;
            }
            return fs.openSync(target, flags, mode);
          },
        }
        : fs;

      await assert.rejects(
        startTestReviewServer({
          root: ROOT,
          projectDir: fixture.projectDir,
          open: false,
          handoffDirectory: directory,
          handoffId: () => id,
          handoffFileSystem,
        }),
      );
      assert.equal(fs.readFileSync(outside, 'utf8'), 'outside-safe');
      if (kind === 'collision') assert.equal(fs.readFileSync(handoffPath, 'utf8'), 'existing-safe');
      if (kind === 'symlink') assert.equal(fs.lstatSync(handoffPath).isSymbolicLink(), true);
      if (kind === 'write-failure') assert.equal(fs.existsSync(handoffPath), false);
    });
  }
});

test('manual handoff expires and removes only its owned file', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-review-expiry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir,
    open: false,
    handoffDirectory: directory,
    handoffId: () => 'short-lived',
    handoffTtlMs: 25,
  });
  t.after(() => closeServer(session.server));
  assert.equal(fs.existsSync(session.handoffPath), true);

  const deadline = Date.now() + 1_000;
  while (fs.existsSync(session.handoffPath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(session.handoffPath), false);
  assert.equal(session.server.listening, true);
});

test('review API authenticates state and sends defensive response headers', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const session = await startTestReviewServer({ root: ROOT, projectDir, open: false });
  t.after(() => closeServer(session.server));

  assert.equal((await request(session, '/api/state')).status, 401);
  assert.equal((await request(session, '/api/state', { token: 'wrong' })).status, 401);
  assert.equal((await request(session, '/api/state', {
    token: session.token,
    queryToken: true,
  })).status, 401);
  const response = await request(session, '/api/state', { token: session.token });
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(JSON.parse(response.body.toString('utf8')).project.name, 'Review fixture');
  assert.doesNotMatch(
    response.body.toString('utf8'),
    new RegExp(`${projectDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|${session.token}`),
  );
});

test('review server rejects foreign writes, oversized bodies, and traversal', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const session = await startTestReviewServer({ root: ROOT, projectDir, open: false });
  t.after(() => closeServer(session.server));
  const origin = `http://127.0.0.1:${session.server.address().port}`;

  assert.equal((await request(session, '/api/validate', {
    token: session.token,
    method: 'POST',
    origin: 'https://evil.test',
    body: '{}',
  })).status, 403);
  assert.equal((await request(session, '/api/validate', {
    token: session.token,
    method: 'POST',
    origin,
    body: '{}',
  })).status, 405);
  assert.equal((await request(session, '/api/validate', {
    token: session.token,
    method: 'POST',
    origin,
    body: Buffer.alloc((256 * 1024) + 1, 0x61),
  })).status, 413);
  assert.equal((await request(session, '/', {
    method: 'POST',
    origin,
    body: Buffer.alloc((256 * 1024) + 1, 0x61),
  })).status, 413);
  assert.equal((await request(session, '/../../.env', { token: session.token })).status, 404);
  assert.equal((await request(session, '/api/ignored/../state', {
    token: session.token,
  })).status, 404);
  assert.equal((await request(session, '/api/ignored/%2e%2e/state', {
    token: session.token,
  })).status, 404);
  assert.equal((await request(session, '/package.json', { token: session.token })).status, 404);
  assert.equal((await request(session, '/api/%00', { token: session.token })).status, 404);
});

test('review edit routes authenticate and exist only in editable sessions', async (t) => {
  const readOnlyProject = makeReviewProject(t);
  const readOnly = await startTestReviewServer({
    root: ROOT,
    projectDir: readOnlyProject.projectDir,
    open: false,
  });
  t.after(() => closeServer(readOnly.server));
  const { payload: readOnlyPayload } = await editablePayload(readOnly);

  assert.equal((await postJson(readOnly, '/api/validate', readOnlyPayload)).status, 405);
  assert.equal((await postJson(readOnly, '/api/save', readOnlyPayload)).status, 405);
  assert.equal((await request(readOnly, '/api/save', {
    token: readOnly.token,
    method: 'POST',
    origin: readOnly.origin,
    body: '{',
    contentType: 'text/plain',
  })).status, 405);

  const editableProject = makeReviewProject(t);
  const editable = await startTestReviewServer({
    root: ROOT,
    projectDir: editableProject.projectDir,
    editable: true,
    open: false,
  });
  t.after(() => closeServer(editable.server));
  const { payload } = await editablePayload(editable);
  const malformed = '{"baseRevision":';

  assert.equal((await request(editable, '/api/validate', {
    token: 'wrong',
    method: 'POST',
    origin: editable.origin,
    body: malformed,
  })).status, 401);
  assert.equal((await request(editable, '/api/validate', {
    token: editable.token,
    method: 'POST',
    origin: 'https://evil.test',
    body: malformed,
  })).status, 403);
  assert.equal((await postJson(editable, '/api/validate', payload)).status, 200);
});

test('review edit routes reject malformed, extra, path-bearing and unknown JSON', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir,
    editable: true,
    open: false,
  });
  t.after(() => closeServer(session.server));
  const { payload } = await editablePayload(session);
  const malformedBodies = [
    '{',
    jsonBody({ ...payload, brief: { source: '/fixture-host/private/source.mov' } }),
    jsonBody({ ...payload, projectDir: '/fixture-host/private/project' }),
    jsonBody({ ...payload, ['__proto__']: { polluted: true } }),
    jsonBody({
      ...payload,
      commands: [{
        type: 'move-boundary',
        leftSceneIndex: 0,
        seconds: 2.2,
        path: '/fixture-host/private/source.mov',
      }],
    }),
    jsonBody({ ...payload, commands: [{ type: 'delete-project' }] }),
  ];

  for (const body of malformedBodies) {
    const response = await request(session, '/api/validate', {
      token: session.token,
      method: 'POST',
      origin: session.origin,
      body,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.toString('utf8'), 'Request rejected');
    assert.doesNotMatch(response.body.toString('utf8'), /Users|private|delete-project/);
  }
  assert.equal((await request(session, '/api/validate', {
    token: session.token,
    method: 'POST',
    origin: session.origin,
    body: jsonBody(payload),
    contentType: 'text/plain',
  })).status, 400);
});

test('review edit routes reject stale revisions and disk hashes', async (t) => {
  const revisionProject = makeReviewProject(t);
  const revisionSession = await startTestReviewServer({
    root: ROOT,
    projectDir: revisionProject.projectDir,
    editable: true,
    open: false,
  });
  t.after(() => closeServer(revisionSession.server));
  const { payload: revisionPayload } = await editablePayload(revisionSession);
  assert.equal((await postJson(revisionSession, '/api/validate', {
    ...revisionPayload,
    baseRevision: revisionPayload.baseRevision + 1,
  })).status, 409);

  const briefProject = makeReviewProject(t);
  const briefSession = await startTestReviewServer({
    root: ROOT,
    projectDir: briefProject.projectDir,
    editable: true,
    open: false,
  });
  t.after(() => closeServer(briefSession.server));
  const { payload: briefPayload } = await editablePayload(briefSession);
  const brief = JSON.parse(fs.readFileSync(briefProject.briefPath, 'utf8'));
  brief.scenes[0].caption = 'ИЗМЕНЕНО НА ДИСКЕ';
  fs.writeFileSync(briefProject.briefPath, `${JSON.stringify(brief, null, 2)}\n`);
  assert.equal((await postJson(briefSession, '/api/save', briefPayload)).status, 409);

  const manifestProject = makeReviewProject(t);
  const manifestSession = await startTestReviewServer({
    root: ROOT,
    projectDir: manifestProject.projectDir,
    editable: true,
    open: false,
  });
  t.after(() => closeServer(manifestSession.server));
  const { payload: manifestPayload } = await editablePayload(manifestSession);
  const manifestPath = path.join(manifestProject.projectDir, 'project.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.name = 'Changed concurrently';
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.equal((await postJson(manifestSession, '/api/validate', manifestPayload)).status, 409);
});

test('review state refreshes after a second server saves and preserves unchanged asset ids', async (t) => {
  const fixture = makeReviewProject(t);
  const assetPath = path.join(fixture.workspace.dir, 'assets', 'broll', 'stable.png');
  fs.writeFileSync(assetPath, 'stable asset');
  const first = await startTestReviewServer({
    root: ROOT,
    projectDir: fixture.projectDir,
    editable: true,
    open: false,
  });
  const second = await startTestReviewServer({
    root: ROOT,
    projectDir: fixture.projectDir,
    editable: true,
    open: false,
  });
  t.after(() => closeServer(first.server));
  t.after(() => closeServer(second.server));

  const firstBeforeResponse = await request(first, '/api/state', { token: first.token });
  const firstBefore = JSON.parse(firstBeforeResponse.body.toString('utf8'));
  const stableBefore = firstBefore.assets.find((asset) => asset.label === 'stable.png');
  assert.ok(stableBefore);
  const { payload: secondPayload } = await editablePayload(second, [{
    type: 'move-boundary',
    leftSceneIndex: 0,
    seconds: 2.4,
  }]);
  assert.equal((await postJson(second, '/api/save', secondPayload)).status, 201);

  const firstAfterResponse = await request(first, '/api/state', { token: first.token });
  assert.equal(firstAfterResponse.status, 200);
  const firstAfter = JSON.parse(firstAfterResponse.body.toString('utf8'));
  const stableAfter = firstAfter.assets.find((asset) => asset.label === 'stable.png');
  assert.equal(firstAfter.session.baseRevision, 2);
  assert.equal(firstAfter.brief.scenes[0].end, 2.4);
  assert.equal(firstAfter.brief.scenes[1].start, 2.4);
  assert.equal(stableAfter.id, stableBefore.id);
  assert.equal(stableAfter.url, stableBefore.url);
});

test('review state never observes a manifest revision before its draft JSON is visible', async (t) => {
  const fixture = makeReviewProject(t);
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir: fixture.projectDir,
    open: false,
    logger: { error() {} },
  });
  t.after(() => closeServer(session.server));
  const before = JSON.parse((await request(session, '/api/state', {
    token: session.token,
  })).body.toString('utf8'));
  assert.equal(before.session.baseRevision, 1);

  const candidate = JSON.parse(fs.readFileSync(fixture.briefPath, 'utf8'));
  candidate.scenes[0].end = 2.2;
  candidate.scenes[1].start = 2.2;
  const candidatePath = path.join(fixture.root, 'publish-candidate.json');
  const workerPath = path.join(fixture.root, 'publish-worker.js');
  const readyPath = path.join(fixture.root, 'manifest-visible');
  const releasePath = path.join(fixture.root, 'release-writer');
  const resultPath = path.join(fixture.root, 'publish-result.json');
  fs.writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
  fs.writeFileSync(workerPath, String.raw`
const fs = require('node:fs');

const [modulePath, projectDir, baseJsonPath, candidatePath, readyPath, releasePath, resultPath] = process.argv.slice(2);
const { readProjectManifest, saveDraftRevision } = require(modulePath);
const pause = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 10_000;
const racingFileSystem = {
  ...fs,
  renameSync(source, target) {
    const result = fs.renameSync(source, target);
    if (String(source).includes('.tmp-review-draft-manifest-')) {
      fs.writeFileSync(readyPath, 'visible', { flag: 'wx' });
      while (!fs.existsSync(releasePath)) {
        if (Date.now() >= deadline) throw new Error('release barrier timeout');
        Atomics.wait(pause, 0, 0, 10);
      }
    }
    return result;
  },
};

try {
  const workspace = { dir: projectDir, manifest: readProjectManifest(projectDir) };
  const brief = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const saved = saveDraftRevision(workspace, {
    baseJsonPath,
    brief,
    fileSystem: racingFileSystem,
  });
  fs.writeFileSync(resultPath, JSON.stringify({ ok: true, revision: saved.revision }));
} catch (error) {
  fs.writeFileSync(resultPath, JSON.stringify({
    ok: false,
    code: error && error.code,
    message: error && error.message,
  }));
}
`);

  const worker = runNodeWorker(workerPath, [
    require.resolve('../scripts/project/workspace'),
    fixture.projectDir,
    fixture.briefPath,
    candidatePath,
    readyPath,
    releasePath,
    resultPath,
  ]);
  await waitForFile(readyPath);
  let duringPublish;
  try {
    duringPublish = await request(session, '/api/state', { token: session.token });
  } finally {
    fs.writeFileSync(releasePath, 'continue', { flag: 'wx' });
  }
  await worker.completed;
  const workerResult = JSON.parse(fs.readFileSync(resultPath, 'utf8'));

  assert.equal(duringPublish.status, 200);
  const visible = JSON.parse(duringPublish.body.toString('utf8'));
  assert.equal(visible.session.baseRevision, 2);
  assert.equal(visible.brief.scenes[0].end, 2.2);
  assert.deepEqual(workerResult, { ok: true, revision: 2 });
});

test('review state expires instead of rebinding replaced source or asset bytes', async (t) => {
  const sourceFixture = makeReviewProject(t);
  const sourceSession = await startTestReviewServer({
    root: ROOT,
    projectDir: sourceFixture.projectDir,
    editable: true,
    open: false,
  });
  t.after(() => closeServer(sourceSession.server));
  const { payload: sourcePayload } = await editablePayload(sourceSession);
  const sourcePath = path.join(
    sourceFixture.projectDir,
    sourceFixture.workspace.manifest.source.localPath,
  );
  const sourceReplacement = path.join(sourceFixture.projectDir, 'input', 'replacement.mp4');
  fs.writeFileSync(sourceReplacement, 'different source bytes');
  fs.renameSync(sourceReplacement, sourcePath);
  assert.equal((await request(sourceSession, '/api/state', {
    token: sourceSession.token,
  })).status, 409);
  assert.equal((await postJson(sourceSession, '/api/validate', sourcePayload)).status, 409);
  assert.equal((await postJson(sourceSession, '/api/save', sourcePayload)).status, 409);

  const assetFixture = makeReviewProject(t);
  const assetPath = path.join(assetFixture.projectDir, 'assets', 'broll', 'registered.png');
  fs.writeFileSync(assetPath, 'registered bytes');
  const assetSession = await startTestReviewServer({
    root: ROOT,
    projectDir: assetFixture.projectDir,
    editable: true,
    open: false,
  });
  t.after(() => closeServer(assetSession.server));
  const before = JSON.parse((await request(assetSession, '/api/state', {
    token: assetSession.token,
  })).body.toString('utf8'));
  assert.ok(before.assets.some((asset) => asset.label === 'registered.png'));
  const assetReplacement = path.join(assetFixture.projectDir, 'assets', 'broll', 'replacement.png');
  fs.writeFileSync(assetReplacement, 'different asset bytes');
  fs.renameSync(assetReplacement, assetPath);
  assert.equal((await request(assetSession, '/api/state', {
    token: assetSession.token,
  })).status, 409);
  const assetPayload = {
    baseRevision: before.session.baseRevision,
    baseHash: before.session.baseHash,
    manifestHash: before.session.manifestHash,
    commands: [{ type: 'move-boundary', leftSceneIndex: 0, seconds: 2.2 }],
  };
  assert.equal((await postJson(assetSession, '/api/validate', assetPayload)).status, 409);
  assert.equal((await postJson(assetSession, '/api/save', assetPayload)).status, 409);
});

test('review validate reports safe diff and timing without writing files', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir,
    editable: true,
    open: false,
  });
  t.after(() => closeServer(session.server));
  const { payload } = await editablePayload(session);
  const beforeManifest = fs.readFileSync(path.join(projectDir, 'project.json'));
  const beforeBriefNames = fs.readdirSync(path.join(projectDir, 'brief')).sort();

  const response = await postJson(session, '/api/validate', payload);

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body.toString('utf8')), {
    ok: true,
    destinationRevision: 2,
    diff: [{ kind: 'boundary', leftScene: 0, rightScene: 1, from: 2, to: 2.2 }],
    timing: { errors: [], warnings: [], suggestions: [] },
  });
  assert.deepEqual(fs.readFileSync(path.join(projectDir, 'project.json')), beforeManifest);
  assert.deepEqual(fs.readdirSync(path.join(projectDir, 'brief')).sort(), beforeBriefNames);
  assert.doesNotMatch(response.body.toString('utf8'), /Users|projectDir|source\.mov/);
});

test('review validate allocates its destination above the highest registered revision', async (t) => {
  const fixture = makeReviewProject(t);
  registerHigherBrief(fixture, { revision: 5 });
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir: fixture.projectDir,
    editable: true,
    open: false,
  });
  t.after(() => closeServer(session.server));
  const { state, payload } = await editablePayload(session);

  const response = await postJson(session, '/api/validate', payload);

  assert.equal(state.session.baseRevision, 1);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body.toString('utf8')).destinationRevision, 6);
  assert.doesNotMatch(response.body.toString('utf8'), /brief\/v05|Users|projectDir/);
});

test('review save rejects invalid timing and no-op commands without writing', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir,
    editable: true,
    open: false,
  });
  t.after(() => closeServer(session.server));
  const { payload } = await editablePayload(session);
  const beforeManifest = fs.readFileSync(path.join(projectDir, 'project.json'));
  const beforeBriefNames = fs.readdirSync(path.join(projectDir, 'brief')).sort();

  assert.equal((await postJson(session, '/api/validate', {
    ...payload,
    commands: [{ type: 'move-boundary', leftSceneIndex: 0, seconds: 4 }],
  })).status, 422);
  assert.equal((await postJson(session, '/api/save', {
    ...payload,
    commands: [],
  })).status, 400);
  assert.deepEqual(fs.readFileSync(path.join(projectDir, 'project.json')), beforeManifest);
  assert.deepEqual(fs.readdirSync(path.join(projectDir, 'brief')).sort(), beforeBriefNames);
});

test('review save materializes project and public broll ids into canonical references', async (t) => {
  const { projectDir, briefPath, workspace } = makeReviewProject(t);
  const projectAssets = path.join(workspace.dir, 'assets', 'broll');
  fs.writeFileSync(path.join(projectAssets, 'diagram.png'), 'base asset');
  fs.writeFileSync(path.join(projectAssets, 'replacement.png'), 'replacement asset');
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-review-repository-'));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repository, 'public', 'broll'), { recursive: true });
  fs.writeFileSync(path.join(repository, 'public', 'broll', 'public.png'), 'public asset');
  const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
  brief.scenes = [
    {
      scene: 'broll',
      start: 0,
      end: 2,
      brollSrc: 'assets/broll/diagram.png',
      headCream: 'ПЕРВАЯ',
      headOrange: 'СХЕМА',
    },
    {
      scene: 'broll',
      start: 2,
      end: 4,
      brollSrc: 'assets/broll/diagram.png',
      headCream: 'ВТОРАЯ',
      headOrange: 'СХЕМА',
    },
  ];
  fs.writeFileSync(briefPath, `${JSON.stringify(brief, null, 2)}\n`);
  const session = await startTestReviewServer({
    root: repository,
    projectDir,
    editable: true,
    open: false,
    probeReviewMediaImpl: () => ({
      mediaKind: 'image', width: 1, height: 1, fps: 0, durationSec: 0, hasAudio: false,
    }),
  });
  t.after(() => closeServer(session.server));
  const stateResponse = await request(session, '/api/state', { token: session.token });
  const state = JSON.parse(stateResponse.body.toString('utf8'));
  assert.deepEqual(state.assets.map(({ id, kind, label }) => ({ id, kind, label })), [
    { id: 'asset-1', kind: 'project', label: 'diagram.png' },
    { id: 'asset-2', kind: 'project', label: 'replacement.png' },
    { id: 'asset-3', kind: 'public', label: 'public.png' },
  ]);
  const payload = {
    baseRevision: state.session.baseRevision,
    baseHash: state.session.baseHash,
    manifestHash: state.session.manifestHash,
    commands: [
      { type: 'replace-broll', sceneIndex: 0, assetId: 'asset-2' },
      { type: 'replace-broll', sceneIndex: 1, assetId: 'asset-3' },
    ],
  };

  const validationResponse = await postJson(session, '/api/validate', payload);
  assert.equal(validationResponse.status, 200);
  assert.deepEqual(JSON.parse(validationResponse.body.toString('utf8')).diff, [
    { kind: 'asset', scene: 0, from: 'asset-1', to: 'asset-2' },
    { kind: 'asset', scene: 1, from: 'asset-1', to: 'asset-3' },
  ]);
  assert.doesNotMatch(
    validationResponse.body.toString('utf8'),
    /assets\/broll|broll\/public|Users|\/media\//,
  );

  const response = await postJson(session, '/api/save', payload);

  assert.equal(response.status, 201);
  const result = JSON.parse(response.body.toString('utf8'));
  const saved = JSON.parse(fs.readFileSync(path.join(projectDir, result.path), 'utf8'));
  assert.deepEqual(saved.scenes[0].brollMedia, {
    kind: 'image',
    src: 'assets/broll/replacement.png',
    sha256: sha256('replacement asset'),
    fit: 'cover',
  });
  assert.deepEqual(saved.scenes[1].brollMedia, {
    kind: 'image',
    src: 'broll/public.png',
    sha256: sha256('public asset'),
    fit: 'cover',
  });
  assert.equal(saved.scenes[0].brollSrc, undefined);
  assert.equal(saved.scenes[1].brollSrc, undefined);
  assert.doesNotMatch(JSON.stringify(saved), /asset-[1-9]|\/media\//);
  assert.doesNotMatch(response.body.toString('utf8'), /Users|asset-[1-9]|\/media\//);
});

test('review b-roll commands accept images and normalized video but reject audio-only media', async (t) => {
  const { projectDir, briefPath, workspace } = makeReviewProject(t);
  const assets = path.join(workspace.dir, 'assets', 'broll');
  fs.writeFileSync(path.join(assets, 'base.png'), 'base image');
  fs.writeFileSync(path.join(assets, 'replacement.png'), 'replacement image');
  fs.writeFileSync(path.join(assets, 'voice.mp3'), 'audio bytes');
  writeImportedVideoBundle(projectDir, { label: 'Recorded demo.mov' });
  const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
  brief.scenes[1] = {
    scene: 'broll',
    start: 2,
    end: 4,
    brollSrc: 'assets/broll/base.png',
    headCream: 'БАЗОВАЯ',
    headOrange: 'СХЕМА',
  };
  fs.writeFileSync(briefPath, `${JSON.stringify(brief, null, 2)}\n`);
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir,
    editable: true,
    open: false,
    probeReviewMediaImpl: (target) => {
      const bytes = Buffer.alloc(fs.fstatSync(target.fileDescriptor).size);
      fs.readSync(target.fileDescriptor, bytes, 0, bytes.length, 0);
      return bytes.equals(Buffer.from('canonical video')) ? {
        mediaKind: 'video', width: 1920, height: 1080, fps: 25,
        durationSec: 18.4, audioDurationSec: 18.4, hasAudio: true,
      }
        : { mediaKind: 'image', width: 1, height: 1, fps: 0, durationSec: 0, hasAudio: false };
    },
  });
  t.after(() => closeServer(session.server));
  const state = JSON.parse((await request(session, '/api/state', {
    token: session.token,
  })).body.toString('utf8'));
  const byLabel = new Map(state.assets.map((asset) => [asset.label, asset]));
  const payloadFor = (label) => ({
    baseRevision: state.session.baseRevision,
    baseHash: state.session.baseHash,
    manifestHash: state.session.manifestHash,
    commands: [{ type: 'replace-broll', sceneIndex: 1, assetId: byLabel.get(label).id }],
  });

  assert.equal((await postJson(session, '/api/validate', payloadFor('voice.mp3'))).status, 400);
  assert.equal((await postJson(session, '/api/save', payloadFor('voice.mp3'))).status, 400);
  assert.equal((await postJson(session, '/api/validate', payloadFor('replacement.png'))).status, 200);
  const videoValidation = await postJson(session, '/api/validate', payloadFor('Recorded demo.mov'));
  assert.equal(videoValidation.status, 200);
  assert.deepEqual(JSON.parse(videoValidation.body.toString('utf8')).diff.slice(-4), [
    { kind: 'asset', scene: 1, from: byLabel.get('base.png').id, to: byLabel.get('Recorded demo.mov').id },
    { kind: 'fit', scene: 1, from: 'cover', to: 'contain' },
    { kind: 'clip-start', scene: 1, from: null, to: 0 },
    { kind: 'audio-mode', scene: 1, from: null, to: 'mute' },
  ]);
  const savedResponse = await postJson(session, '/api/save', payloadFor('Recorded demo.mov'));
  assert.equal(savedResponse.status, 201);
  const saved = JSON.parse(fs.readFileSync(
    path.join(projectDir, JSON.parse(savedResponse.body.toString('utf8')).path),
    'utf8',
  ));
  assert.deepEqual(saved.scenes[1].brollMedia, {
    kind: 'video',
    src: `assets/broll/video/${IMPORT_UUID}/media.mp4`,
    sha256: sha256('canonical video'),
    trimStartSec: 0,
    fit: 'contain',
    audioMode: 'mute',
  });
  assert.equal(saved.scenes[1].brollSrc, undefined);
});

test('review validate runs the same media probe gate as save without allocating a revision', async (t) => {
  const { projectDir, briefPath, workspace } = makeReviewProject(t);
  const assets = path.join(workspace.dir, 'assets', 'broll');
  fs.writeFileSync(path.join(assets, 'base.png'), 'base image');
  fs.writeFileSync(path.join(assets, 'replacement.png'), 'replacement image');
  const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
  brief.scenes[1] = {
    scene: 'broll', start: 2, end: 4, brollSrc: 'assets/broll/base.png',
    headCream: 'БАЗОВАЯ', headOrange: 'СХЕМА',
  };
  fs.writeFileSync(briefPath, `${JSON.stringify(brief, null, 2)}\n`);
  const beforeManifest = fs.readFileSync(path.join(projectDir, 'project.json'));
  const beforeBriefs = fs.readdirSync(path.join(projectDir, 'brief')).sort();
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir,
    editable: true,
    open: false,
    probeReviewMediaImpl: () => { throw new Error('simulated authoritative probe failure'); },
  });
  t.after(() => closeServer(session.server));
  const state = JSON.parse((await request(session, '/api/state', {
    token: session.token,
  })).body.toString('utf8'));
  const replacement = state.assets.find((asset) => asset.label === 'replacement.png');
  const response = await postJson(session, '/api/validate', {
    baseRevision: state.session.baseRevision,
    baseHash: state.session.baseHash,
    manifestHash: state.session.manifestHash,
    commands: [{ type: 'replace-broll', sceneIndex: 1, assetId: replacement.id }],
  });

  assert.equal(response.status, 422);
  assert.deepEqual(fs.readFileSync(path.join(projectDir, 'project.json')), beforeManifest);
  assert.deepEqual(fs.readdirSync(path.join(projectDir, 'brief')).sort(), beforeBriefs);
});

test('review validate rebuilds the registry and sees imported duration changes after startup', async (t) => {
  const { projectDir, briefPath } = makeReviewProject(t);
  const imported = writeImportedVideoBundle(projectDir, { label: 'Fresh duration.mov' });
  const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
  brief.scenes[1] = {
    scene: 'broll', start: 2, end: 4, brollSrc: 'broll/growth.png',
    headCream: 'БАЗОВАЯ', headOrange: 'СХЕМА',
  };
  fs.writeFileSync(briefPath, `${JSON.stringify(brief, null, 2)}\n`);
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir,
    editable: true,
    open: false,
    probeReviewMediaImpl: () => ({
      mediaKind: 'video', width: 1920, height: 1080, fps: 25,
      durationSec: 1, audioDurationSec: 1, hasAudio: true,
    }),
  });
  t.after(() => closeServer(session.server));
  const state = JSON.parse((await request(session, '/api/state', {
    token: session.token,
  })).body.toString('utf8'));
  const video = state.assets.find((asset) => asset.label === 'Fresh duration.mov');
  assert.ok(video);
  const metadataPath = path.join(imported.mediaDirectory, 'asset.json');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  metadata.durationSec = 1;
  metadata.audioDurationSec = 1;
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`);
  const beforeManifest = fs.readFileSync(path.join(projectDir, 'project.json'));
  const beforeBriefs = fs.readdirSync(path.join(projectDir, 'brief')).sort();

  const response = await postJson(session, '/api/validate', {
    baseRevision: state.session.baseRevision,
    baseHash: state.session.baseHash,
    manifestHash: state.session.manifestHash,
    commands: [{ type: 'replace-broll', sceneIndex: 1, assetId: video.id }],
  });
  assert.equal(response.status, 422);
  assert.deepEqual(fs.readFileSync(path.join(projectDir, 'project.json')), beforeManifest);
  assert.deepEqual(fs.readdirSync(path.join(projectDir, 'brief')).sort(), beforeBriefs);
});

test('review validate rejects an unrelated asset removed during the selected probe without rebinding ids', async (t) => {
  const { projectDir, briefPath, workspace } = makeReviewProject(t);
  const assets = path.join(workspace.dir, 'assets', 'broll');
  const basePath = path.join(assets, 'base.png');
  const selectedPath = path.join(assets, 'selected.png');
  const unrelatedPath = path.join(assets, 'unrelated.png');
  const parkedPath = path.join(workspace.dir, 'unrelated-parked.png');
  fs.writeFileSync(basePath, 'base image');
  fs.writeFileSync(selectedPath, 'selected image');
  fs.writeFileSync(unrelatedPath, 'unrelated image');
  const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
  brief.scenes[1] = {
    scene: 'broll', start: 2, end: 4, brollSrc: 'assets/broll/base.png',
    headCream: 'БАЗОВАЯ', headOrange: 'СХЕМА',
  };
  fs.writeFileSync(briefPath, `${JSON.stringify(brief, null, 2)}\n`);
  let moved = false;
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir,
    editable: true,
    open: false,
    probeReviewMediaImpl: () => {
      if (!moved) {
        moved = true;
        fs.renameSync(unrelatedPath, parkedPath);
      }
      return {
        mediaKind: 'image', width: 1, height: 1, fps: 0, durationSec: 0, hasAudio: false,
      };
    },
  });
  t.after(() => closeServer(session.server));
  const state = JSON.parse((await request(session, '/api/state', {
    token: session.token,
  })).body.toString('utf8'));
  const selected = state.assets.find((asset) => asset.label === 'selected.png');
  const unrelated = state.assets.find((asset) => asset.label === 'unrelated.png');
  assert.ok(selected);
  assert.ok(unrelated);
  const beforeManifest = fs.readFileSync(path.join(projectDir, 'project.json'));
  const beforeBriefs = fs.readdirSync(path.join(projectDir, 'brief')).sort();

  const response = await postJson(session, '/api/validate', {
    baseRevision: state.session.baseRevision,
    baseHash: state.session.baseHash,
    manifestHash: state.session.manifestHash,
    commands: [{ type: 'replace-broll', sceneIndex: 1, assetId: selected.id }],
  });
  fs.renameSync(parkedPath, unrelatedPath);

  assert.equal(response.status, 409);
  assert.deepEqual(fs.readFileSync(path.join(projectDir, 'project.json')), beforeManifest);
  assert.deepEqual(fs.readdirSync(path.join(projectDir, 'brief')).sort(), beforeBriefs);
  const refreshed = JSON.parse((await request(session, '/api/state', {
    token: session.token,
  })).body.toString('utf8'));
  assert.equal(refreshed.assets.find((asset) => asset.label === 'unrelated.png').id, unrelated.id);
});

test('review save allocates nothing when an unrelated asset is replaced during the selected probe', async (t) => {
  const { projectDir, briefPath, workspace } = makeReviewProject(t);
  const assets = path.join(workspace.dir, 'assets', 'broll');
  const basePath = path.join(assets, 'base.png');
  const selectedPath = path.join(assets, 'selected.png');
  const unrelatedPath = path.join(assets, 'unrelated.png');
  const replacementPath = path.join(assets, 'unrelated-replacement.png');
  fs.writeFileSync(basePath, 'base image');
  fs.writeFileSync(selectedPath, 'selected image');
  fs.writeFileSync(unrelatedPath, 'unrelated image');
  fs.writeFileSync(replacementPath, 'attacker replacement');
  const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
  brief.scenes[1] = {
    scene: 'broll', start: 2, end: 4, brollSrc: 'assets/broll/base.png',
    headCream: 'БАЗОВАЯ', headOrange: 'СХЕМА',
  };
  fs.writeFileSync(briefPath, `${JSON.stringify(brief, null, 2)}\n`);
  let replaced = false;
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir,
    editable: true,
    open: false,
    probeReviewMediaImpl: () => {
      if (!replaced) {
        replaced = true;
        fs.renameSync(replacementPath, unrelatedPath);
      }
      return {
        mediaKind: 'image', width: 1, height: 1, fps: 0, durationSec: 0, hasAudio: false,
      };
    },
  });
  t.after(() => closeServer(session.server));
  const state = JSON.parse((await request(session, '/api/state', {
    token: session.token,
  })).body.toString('utf8'));
  const selected = state.assets.find((asset) => asset.label === 'selected.png');
  assert.ok(selected);
  const beforeManifest = fs.readFileSync(path.join(projectDir, 'project.json'));
  const beforeBriefs = fs.readdirSync(path.join(projectDir, 'brief')).sort();

  const response = await postJson(session, '/api/save', {
    baseRevision: state.session.baseRevision,
    baseHash: state.session.baseHash,
    manifestHash: state.session.manifestHash,
    commands: [{ type: 'replace-broll', sceneIndex: 1, assetId: selected.id }],
  });

  assert.equal(response.status, 409);
  assert.deepEqual(fs.readFileSync(path.join(projectDir, 'project.json')), beforeManifest);
  assert.deepEqual(fs.readdirSync(path.join(projectDir, 'brief')).sort(), beforeBriefs);
});

test('review save creates a draft and advances the browser-safe session state', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir,
    editable: true,
    open: false,
  });
  t.after(() => closeServer(session.server));
  const { state: beforeState, payload } = await editablePayload(session);

  const response = await postJson(session, '/api/save', payload);

  assert.equal(response.status, 201);
  const result = JSON.parse(response.body.toString('utf8'));
  assert.equal(result.ok, true);
  assert.equal(result.revision, 2);
  assert.equal(result.path, 'brief/v02-draft.lesson.json');
  assert.equal(result.session.editable, true);
  assert.equal(result.session.baseRevision, 2);
  assert.match(result.session.baseHash, /^[a-f0-9]{64}$/);
  assert.match(result.session.manifestHash, /^[a-f0-9]{64}$/);
  assert.notEqual(result.session.baseHash, beforeState.session.baseHash);
  assert.notEqual(result.session.manifestHash, beforeState.session.manifestHash);
  assert.doesNotMatch(response.body.toString('utf8'), /Users|projectDir|source\.mov/);
  const saved = JSON.parse(fs.readFileSync(path.join(projectDir, result.path), 'utf8'));
  assert.equal(saved.status, 'draft');
  assert.equal(saved.scenes[0].end, 2.2);
  assert.equal(saved.scenes[1].start, 2.2);

  const nextStateResponse = await request(session, '/api/state', { token: session.token });
  const nextState = JSON.parse(nextStateResponse.body.toString('utf8'));
  assert.deepEqual(nextState.session, result.session);
  assert.equal(nextState.brief.scenes[0].end, 2.2);
  assert.equal((await postJson(session, '/api/save', payload)).status, 409);
});

test('review save rejects a manifest changed after replay but before its atomic snapshot', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const manifestPath = path.join(projectDir, 'project.json');
  const beforeBriefNames = fs.readdirSync(path.join(projectDir, 'brief')).sort();
  let foreignManifestBytes = null;
  let injected = false;
  const racingFileSystem = {
    ...fs,
    readFileSync(target, options) {
      if (!injected && path.resolve(target) === manifestPath) {
        injected = true;
        const foreignManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        foreignManifest.name = 'Foreign concurrent manifest';
        foreignManifest.updatedAt = '2026-08-20T15:00:00.000Z';
        foreignManifestBytes = Buffer.from(`${JSON.stringify(foreignManifest, null, 2)}\n`);
        fs.writeFileSync(manifestPath, foreignManifestBytes);
      }
      return fs.readFileSync(target, options);
    },
  };
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir,
    editable: true,
    open: false,
    fileSystem: racingFileSystem,
  });
  t.after(() => closeServer(session.server));
  const { state: beforeState, payload } = await editablePayload(session);

  const response = await postJson(session, '/api/save', payload);

  assert.equal(injected, true);
  assert.equal(response.status, 409);
  assert.equal(response.body.toString('utf8'), 'Request rejected');
  assert.deepEqual(fs.readFileSync(manifestPath), foreignManifestBytes);
  assert.deepEqual(fs.readdirSync(path.join(projectDir, 'brief')).sort(), beforeBriefNames);
  const stateResponse = await request(session, '/api/state', { token: session.token });
  assert.equal(stateResponse.status, 200);
  const refreshed = JSON.parse(stateResponse.body.toString('utf8'));
  assert.equal(refreshed.project.name, 'Foreign concurrent manifest');
  assert.equal(refreshed.session.baseRevision, beforeState.session.baseRevision);
  assert.equal(refreshed.session.baseHash, beforeState.session.baseHash);
  assert.notEqual(refreshed.session.manifestHash, beforeState.session.manifestHash);
});

test('review save stays committed but fresh state fails closed when canonical transcript disappears', async (t) => {
  const { projectDir, workspace } = makeReviewProject(t);
  const transcriptPath = path.join(workspace.dir, workspace.manifest.transcript.words);
  let transcriptRemovedAfterCommit = false;
  const postCommitFileSystem = {
    ...fs,
    renameSync(source, target) {
      const result = fs.renameSync(source, target);
      if (!transcriptRemovedAfterCommit && source.includes('.tmp-review-draft-manifest-')) {
        fs.unlinkSync(transcriptPath);
        transcriptRemovedAfterCommit = true;
      }
      return result;
    },
  };
  const logs = [];
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir,
    editable: true,
    open: false,
    fileSystem: postCommitFileSystem,
    logger: { error: (...args) => logs.push(args) },
  });
  t.after(() => closeServer(session.server));
  const { payload } = await editablePayload(session);

  const response = await postJson(session, '/api/save', payload);

  assert.equal(transcriptRemovedAfterCommit, true);
  assert.equal(fs.existsSync(transcriptPath), false);
  assert.equal(response.status, 201);
  const result = JSON.parse(response.body.toString('utf8'));
  assert.equal(result.revision, 2);
  assert.equal(result.session.baseRevision, 2);
  assert.equal(logs.length, 0);
  const manifest = JSON.parse(fs.readFileSync(path.join(projectDir, 'project.json'), 'utf8'));
  assert.equal(manifest.currentBrief, result.path);
  const stateResponse = await request(session, '/api/state', { token: session.token });
  assert.equal(stateResponse.status, 500);
  assert.equal(stateResponse.body.toString('utf8'), 'Request rejected');
});

test('review save advances session when only post-commit temp cleanup fails', async (t) => {
  const { projectDir } = makeReviewProject(t);
  let jsonCommitted = false;
  let cleanupAttempted = false;
  const postCommitCleanupFailureFs = {
    ...fs,
    linkSync(source, target) {
      const result = fs.linkSync(source, target);
      if (source.includes('.tmp-review-draft-json-')) jsonCommitted = true;
      return result;
    },
    renameSync(source, target) {
      return fs.renameSync(source, target);
    },
    unlinkSync(target) {
      if (jsonCommitted && target.includes('.tmp-review-draft-rollback-')) {
        cleanupAttempted = true;
        throw new Error('simulated post-commit cleanup failure');
      }
      return fs.unlinkSync(target);
    },
  };
  const logs = [];
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir,
    editable: true,
    open: false,
    fileSystem: postCommitCleanupFailureFs,
    logger: { error: (...args) => logs.push(args) },
  });
  t.after(() => closeServer(session.server));
  const { payload } = await editablePayload(session);

  const response = await postJson(session, '/api/save', payload);

  assert.equal(jsonCommitted, true);
  assert.equal(cleanupAttempted, true);
  assert.equal(response.status, 201);
  const result = JSON.parse(response.body.toString('utf8'));
  assert.equal(result.revision, 2);
  assert.equal(result.session.baseRevision, 2);
  assert.equal(logs.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(projectDir, 'project.json'), 'utf8')).currentBrief,
    result.path);
  const stateResponse = await request(session, '/api/state', { token: session.token });
  assert.deepEqual(JSON.parse(stateResponse.body.toString('utf8')).session, result.session);
  assert.ok(fs.readdirSync(projectDir).some((name) => (
    name.includes('.tmp-review-draft-rollback-')
  )));
});

test('review distinguishes unavailable registered assets from unknown ids', async (t) => {
  const { projectDir, briefPath, workspace } = makeReviewProject(t);
  const assetsDirectory = path.join(workspace.dir, 'assets', 'broll');
  const baseAssetPath = path.join(assetsDirectory, 'base.png');
  const unavailableAssetPath = path.join(assetsDirectory, 'gone.png');
  fs.writeFileSync(baseAssetPath, 'base asset');
  fs.writeFileSync(unavailableAssetPath, 'registered at startup');
  const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
  brief.scenes[1] = {
    scene: 'broll',
    start: 2,
    end: 4,
    brollSrc: 'assets/broll/base.png',
    headCream: 'БАЗОВАЯ',
    headOrange: 'СХЕМА',
  };
  fs.writeFileSync(briefPath, `${JSON.stringify(brief, null, 2)}\n`);
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir,
    editable: true,
    open: false,
  });
  t.after(() => closeServer(session.server));
  const stateResponse = await request(session, '/api/state', { token: session.token });
  const state = JSON.parse(stateResponse.body.toString('utf8'));
  const unavailable = state.assets.find((asset) => asset.label === 'gone.png');
  assert.ok(unavailable);
  fs.unlinkSync(unavailableAssetPath);
  const payload = {
    baseRevision: state.session.baseRevision,
    baseHash: state.session.baseHash,
    manifestHash: state.session.manifestHash,
    commands: [{ type: 'replace-broll', sceneIndex: 1, assetId: unavailable.id }],
  };

  assert.equal((await postJson(session, '/api/validate', payload)).status, 422);
  assert.equal((await postJson(session, '/api/save', payload)).status, 422);
  assert.equal((await postJson(session, '/api/validate', {
    ...payload,
    commands: [{ type: 'replace-broll', sceneIndex: 1, assetId: 'asset-999999' }],
  })).status, 400);
  assert.equal((await postJson(session, '/api/validate', {
    ...payload,
    commands: [{ type: 'replace-broll', sceneIndex: 1, assetId: '../gone.png' }],
  })).status, 400);
  assert.equal(JSON.parse(fs.readFileSync(path.join(projectDir, 'project.json'), 'utf8')).currentBrief,
    workspace.manifest.currentBrief);
});

test('review save returns a fixed 500, preserves state, and redacts Windows paths', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const internalPath = `${projectDir}\\private-save-target.json`;
  const logs = [];
  const failingFileSystem = {
    ...fs,
    renameSync(source, target) {
      if (source.includes('.tmp-review-draft-manifest-')) {
        throw new Error(`simulated save failure at ${internalPath}`);
      }
      return fs.renameSync(source, target);
    },
  };
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir,
    editable: true,
    open: false,
    fileSystem: failingFileSystem,
    logger: { error: (...args) => logs.push(args) },
  });
  t.after(() => closeServer(session.server));
  const { state: beforeState, payload } = await editablePayload(session);
  const beforeManifest = fs.readFileSync(path.join(projectDir, 'project.json'));

  const response = await postJson(session, '/api/save', payload);

  assert.equal(response.status, 500);
  assert.equal(response.body.toString('utf8'), 'Request rejected');
  assert.doesNotMatch(response.body.toString('utf8'), /simulated|private|Users/);
  assert.deepEqual(fs.readFileSync(path.join(projectDir, 'project.json')), beforeManifest);
  const afterStateResponse = await request(session, '/api/state', { token: session.token });
  assert.deepEqual(JSON.parse(afterStateResponse.body.toString('utf8')).session, beforeState.session);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][1].name, 'Error');
  assert.equal(logs[0][1].code, 'INTERNAL_ERROR');
  const logged = JSON.stringify(logs);
  assert.match(logged, /simulated save failure/);
  assert.doesNotMatch(logged, new RegExp(session.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(logged, new RegExp(projectDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(logged, /private-save-target|\/api\/save|baseHash|commands/);
});

test('review applies the body limit to declared GET and HEAD requests', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const session = await startTestReviewServer({ root: ROOT, projectDir, open: false });
  t.after(() => closeServer(session.server));
  const oversized = Buffer.alloc((256 * 1024) + 1, 0x61);

  assert.equal((await request(session, '/api/state', { token: session.token })).status, 200);
  assert.equal((await request(session, '/api/state', {
    token: session.token,
    method: 'HEAD',
  })).status, 200);
  assert.equal((await request(session, '/api/state', {
    token: session.token,
    method: 'GET',
    body: oversized,
  })).status, 413);
  assert.equal((await request(session, '/api/state', {
    token: session.token,
    method: 'HEAD',
    body: oversized,
  })).status, 413);
});

test('review applies the body limit to chunked GET and HEAD requests', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const session = await startTestReviewServer({ root: ROOT, projectDir, open: false });
  t.after(() => closeServer(session.server));
  const oversized = Buffer.alloc((256 * 1024) + 1, 0x61);

  assert.equal((await request(session, '/api/state', {
    token: session.token,
    method: 'GET',
    body: oversized,
    chunked: true,
  })).status, 413);
  assert.equal((await request(session, '/api/state', {
    token: session.token,
    method: 'HEAD',
    body: oversized,
    chunked: true,
  })).status, 413);
});

test('review media requires authentication and resolves only opaque handles', async (t) => {
  const { projectDir, workspace } = makeReviewProject(t);
  const assetPath = path.join(workspace.dir, 'assets', 'broll', 'diagram.png');
  fs.writeFileSync(assetPath, 'project asset fixture');
  const session = await startTestReviewServer({ root: ROOT, projectDir, open: false });
  t.after(() => closeServer(session.server));

  assert.equal((await request(session, '/media/source')).status, 401);
  const source = await request(session, '/media/source', { token: session.token });
  assert.equal(source.status, 200);
  assert.equal(source.body.toString('utf8'), 'video fixture');

  const stateResponse = await request(session, '/api/state', { token: session.token });
  const state = JSON.parse(stateResponse.body.toString('utf8'));
  const descriptor = state.assets.find((asset) => asset.label === 'diagram.png');
  assert.ok(descriptor);
  assert.match(descriptor.url, /^\/media\/assets\/asset-[1-9]\d*$/);
  assert.equal((await request(session, descriptor.url)).status, 401);
  const asset = await request(session, descriptor.url, {
    token: session.token,
    queryToken: true,
  });
  assert.equal(asset.status, 200);
  assert.equal(asset.body.toString('utf8'), 'project asset fixture');
  assert.equal((await request(session, '/media/assets/../../project.json', {
    token: session.token,
  })).status, 404);
});

test('current rendered preview is token-protected, ranged, and hash-pinned at request time', async (t) => {
  const fixture = makeReviewProject(t);
  const bytes = Buffer.from('0123456789-rendered-preview');
  const preview = registerCurrentPreview(fixture, bytes);
  const session = await startTestReviewServer({ root: ROOT, projectDir: fixture.projectDir, open: false });
  t.after(() => closeServer(session.server));

  assert.equal((await request(session, '/media/current-preview')).status, 401);
  assert.equal((await request(session, '/media/current-preview', { token: 'wrong' })).status, 401);
  const ranged = await request(session, '/media/current-preview', {
    token: session.token,
    headers: { range: 'bytes=2-7' },
  });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers['content-range'], `bytes 2-7/${bytes.length}`);
  assert.deepEqual(ranged.body, bytes.subarray(2, 8));

  fs.writeFileSync(preview.currentPath, Buffer.from('x'.repeat(bytes.length)));
  assert.equal((await request(session, '/media/current-preview', { token: session.token })).status, 404);
});

// Отменённый Range-запрос к serveFile: браузер рвёт соединение посреди файла (Chrome делает
// это на каждой перемотке <video>). Если serveFile отдаёт поток через stream.pipe() вместо
// pipeline(), файловый дескриптор источника остаётся открытым навсегда. agent: false – как в
// tests/pult-http.test.js – чтобы каждый запрос шёл по своему сокету, без пула keep-alive.
// Резолвится response.complete: false подтверждает, что отмена случилась до конца файла.
function cancelRangedMediaRequest(session, pathname, token) {
  return new Promise((resolve) => {
    let response = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(response ? response.complete : false);
    };
    const outgoing = http.request({
      host: '127.0.0.1',
      port: session.server.address().port,
      path: pathname,
      agent: false,
      headers: { authorization: `Bearer ${token}`, range: 'bytes=0-' },
    }, (res) => {
      response = res;
      response.once('data', () => outgoing.destroy());
      response.on('close', finish);
      response.on('error', () => {});
    });
    outgoing.on('error', () => {});
    // Если соединение упало раньше ответа, request тоже эмитит 'close' – без этого один
    // неудачный запрос подвесил бы промис и весь тест навсегда.
    outgoing.on('close', finish);
    outgoing.end();
  });
}

test(
  'review media streaming releases the file descriptor when a range request is cancelled',
  { skip: WINDOWS && 'нет /dev/fd на Windows', timeout: 10_000 },
  async (t) => {
    const fixture = makeReviewProject(t);
    // Файл должен быть достаточно большим, чтобы поток ещё читал его, когда клиент рвёт
    // соединение – иначе передача успевает завершиться раньше отмены и утечка не проявится.
    // workspace.sourcePath – скопированный внутрь проекта исходник (input/source.mp4),
    // именно его отдаёт /media/source, а не внешний camera.mp4 из фикстуры.
    const fileSize = 2 * 1024 * 1024;
    fs.writeFileSync(fixture.workspace.sourcePath, Buffer.alloc(fileSize, 1));
    const session = await startTestReviewServer({ root: ROOT, projectDir: fixture.projectDir, open: false });
    t.after(() => closeServer(session.server));

    // Убедиться, что обычный (не отменённый) запрос честно отдаёт весь файл – иначе тест ниже
    // мог бы пройти даже при полностью сломанном /media/source.
    const full = await request(session, '/media/source', { token: session.token });
    assert.equal(full.status, 200);
    assert.equal(full.body.length, fileSize);

    const fdCount = () => fs.readdirSync('/dev/fd').length;
    // Дать осесть хвостовым дескрипторам от предыдущих тестов файла, прежде чем снимать
    // базовую метку – иначе случайно закрывающийся чужой сокет сдвигает счёт мимо теста.
    let before = fdCount();
    const settleDeadline = Date.now() + 2000;
    let stableReadings = 0;
    while (stableReadings < 3) {
      assert.ok(
        Date.now() < settleDeadline,
        `число дескрипторов не устоялось за 2 с (последнее значение ${before})`,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      const reading = fdCount();
      if (reading === before) stableReadings += 1;
      else { before = reading; stableReadings = 0; }
    }

    const ATTEMPTS = 20;
    const completed = [];
    for (let i = 0; i < ATTEMPTS; i += 1) {
      completed.push(await cancelRangedMediaRequest(session, '/media/source', session.token));
    }
    // Самопроверка: если хоть один запрос успел дочитаться целиком, отмена не задела
    // середину потока, и тест мог бы пройти, не упражняя утечку вовсе.
    assert.deepEqual(completed, new Array(ATTEMPTS).fill(false));

    // Дать серверу время закрыть файловые дескрипторы после отмены запросов.
    let after = fdCount();
    const deadline = Date.now() + 1000;
    while (after > before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      after = fdCount();
    }
    // <= а не ===: соседний тест файла мог закрыть свой сокет ровно в этот момент, и счётчик
    // пойдёт вниз – это не утечка. Настоящая утечка добавляет +20.
    assert.ok(after <= before, `утекло ${after - before} дескрипторов`);
    // Позитивный случай для того же serveFile (206, точные байты, Content-Range) уже
    // проверен тестом «current rendered preview is token-protected, ranged, and
    // hash-pinned at request time» выше – не дублируем его здесь.
  },
);

test('current rendered preview refuses a symlink even when its target has registered bytes', async (t) => {
  const fixture = makeReviewProject(t);
  const bytes = Buffer.from('rendered preview fixture');
  const preview = registerCurrentPreview(fixture, bytes);
  const outside = path.join(fixture.root, 'outside-preview.mp4');
  fs.writeFileSync(outside, bytes);
  fs.unlinkSync(preview.currentPath);
  fs.symlinkSync(outside, preview.currentPath);
  const session = await startTestReviewServer({ root: ROOT, projectDir: fixture.projectDir, open: false });
  t.after(() => closeServer(session.server));

  assert.equal((await request(session, '/media/current-preview', { token: session.token })).status, 404);
});

test('review waveform is optional, token-protected, and exposes no cache path', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const session = await startReviewServer({
    root: ROOT,
    projectDir,
    open: false,
    runToolImpl: (_command, args) => fs.writeFileSync(args.at(-1), 'waveform fixture'),
  });
  t.after(() => closeServer(session.server));

  const stateResponse = await request(session, '/api/state', { token: session.token });
  const stateBody = stateResponse.body.toString('utf8');
  assert.deepEqual(JSON.parse(stateBody).waveform, { url: '/media/waveform' });
  assert.doesNotMatch(JSON.stringify(JSON.parse(stateBody).waveform), /previews|review-waveform-[a-f0-9]|\.png/);
  assert.equal((await request(session, '/media/waveform')).status, 401);
  const waveform = await request(session, '/media/waveform', { token: session.token });
  assert.equal(waveform.status, 200);
  assert.equal(waveform.headers['content-type'], 'image/png');
  assert.equal(waveform.body.toString('utf8'), 'waveform fixture');
});

test('review starts with null waveform when generation fails', async (t) => {
  const { projectDir } = makeReviewProject(t);
  const session = await startReviewServer({
    root: ROOT,
    projectDir,
    open: false,
    runToolImpl: () => {
      throw new Error('ffmpeg unavailable');
    },
  });
  t.after(() => closeServer(session.server));

  const stateResponse = await request(session, '/api/state', { token: session.token });
  assert.equal(stateResponse.status, 200);
  assert.equal(JSON.parse(stateResponse.body.toString('utf8')).waveform, null);
  assert.equal((await request(session, '/media/waveform', { token: session.token })).status, 404);
});

test('review waveform fails closed if its cache file is replaced after startup', async (t) => {
  const { root, projectDir, workspace } = makeReviewProject(t);
  const session = await startReviewServer({
    root: ROOT,
    projectDir,
    open: false,
    runToolImpl: (_command, args) => fs.writeFileSync(args.at(-1), 'waveform fixture'),
  });
  t.after(() => closeServer(session.server));
  const waveformName = fs.readdirSync(path.join(workspace.dir, 'previews'))
    .find((name) => /^review-waveform-[a-f0-9]{64}\.png$/.test(name));
  assert.ok(waveformName);
  const waveformPath = path.join(workspace.dir, 'previews', waveformName);
  const outsidePath = path.join(root, 'private-waveform.png');
  fs.writeFileSync(outsidePath, 'private fixture');
  fs.unlinkSync(waveformPath);
  fs.symlinkSync(outsidePath, waveformPath);

  const response = await request(session, '/media/waveform', { token: session.token });
  assert.equal(response.status, 404);
  assert.doesNotMatch(response.body.toString('utf8'), /private fixture/);
});

test('review advertises and serves only explicit non-hidden media types', async (t) => {
  const { projectDir, workspace } = makeReviewProject(t);
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-review-root-'));
  fs.mkdirSync(path.join(repository, 'public'));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const assets = path.join(workspace.dir, 'assets', 'broll');
  fs.writeFileSync(path.join(assets, '.env'), 'PRIVATE_VALUE=secret');
  fs.writeFileSync(path.join(assets, '.hidden.png'), 'hidden image');
  fs.writeFileSync(path.join(assets, 'diagram.png'), 'safe image');
  fs.writeFileSync(path.join(assets, 'payload.svg'), '<svg><script>alert(1)</script></svg>');
  fs.writeFileSync(path.join(assets, 'page.html'), '<script>alert(1)</script>');

  const session = await startTestReviewServer({ root: repository, projectDir, open: false });
  t.after(() => closeServer(session.server));
  const stateResponse = await request(session, '/api/state', { token: session.token });
  const state = JSON.parse(stateResponse.body.toString('utf8'));

  assert.deepEqual(state.assets.map((asset) => asset.label), ['diagram.png']);
  const safe = await request(session, state.assets[0].url, { token: session.token });
  assert.equal(safe.status, 200);
  assert.equal(safe.body.toString('utf8'), 'safe image');
  for (const id of ['asset-2', 'asset-3', 'asset-4', 'asset-5']) {
    assert.equal((await request(session, `/media/assets/${id}`, {
      token: session.token,
    })).status, 404);
  }
});

test('review media fails closed if an allowed asset is replaced after startup', async (t) => {
  const { root, projectDir, workspace } = makeReviewProject(t);
  const assetPath = path.join(workspace.dir, 'assets', 'broll', 'diagram.png');
  const outsidePath = path.join(root, 'private.txt');
  fs.writeFileSync(assetPath, 'allowed asset');
  fs.writeFileSync(outsidePath, 'private fixture');
  const session = await startTestReviewServer({ root: ROOT, projectDir, open: false });
  t.after(() => closeServer(session.server));

  const stateResponse = await request(session, '/api/state', { token: session.token });
  const state = JSON.parse(stateResponse.body.toString('utf8'));
  const descriptor = state.assets.find((asset) => asset.label === 'diagram.png');
  assert.ok(descriptor);

  fs.rmSync(assetPath);
  fs.symlinkSync(outsidePath, assetPath);
  const response = await request(session, descriptor.url, { token: session.token });
  assert.equal(response.status, 404);
  assert.doesNotMatch(response.body.toString('utf8'), /private fixture/);
});

test('review validate and save reject the same atomically replaced asset as media preview', async (t) => {
  const { projectDir, briefPath, workspace } = makeReviewProject(t);
  const assets = path.join(workspace.dir, 'assets', 'broll');
  const basePath = path.join(assets, 'base.png');
  const candidatePath = path.join(assets, 'candidate.png');
  fs.writeFileSync(basePath, 'base image');
  fs.writeFileSync(candidatePath, 'registered candidate image');
  const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
  brief.scenes[1] = {
    scene: 'broll',
    start: 2,
    end: 4,
    brollSrc: 'assets/broll/base.png',
    headCream: 'БАЗОВАЯ',
    headOrange: 'СХЕМА',
  };
  fs.writeFileSync(briefPath, `${JSON.stringify(brief, null, 2)}\n`);
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir,
    editable: true,
    open: false,
  });
  t.after(() => closeServer(session.server));
  const state = JSON.parse((await request(session, '/api/state', {
    token: session.token,
  })).body.toString('utf8'));
  const candidate = state.assets.find((asset) => asset.label === 'candidate.png');
  assert.ok(candidate);
  const payload = {
    baseRevision: state.session.baseRevision,
    baseHash: state.session.baseHash,
    manifestHash: state.session.manifestHash,
    commands: [{ type: 'replace-broll', sceneIndex: 1, assetId: candidate.id }],
  };
  const beforeManifest = fs.readFileSync(path.join(projectDir, 'project.json'));

  const replacementPath = path.join(assets, 'atomic-replacement.png');
  fs.writeFileSync(replacementPath, 'different regular file');
  fs.renameSync(replacementPath, candidatePath);

  assert.equal((await request(session, candidate.url, { token: session.token })).status, 404);
  assert.equal((await postJson(session, '/api/validate', payload)).status, 422);
  assert.equal((await postJson(session, '/api/save', payload)).status, 422);
  assert.deepEqual(fs.readFileSync(path.join(projectDir, 'project.json')), beforeManifest);
});

test('raw media import rejects auth, Origin, method and read-only access before upload bytes', async (t) => {
  const editableFixture = makeReviewProject(t);
  const editable = await startTestReviewServer({
    root: ROOT,
    projectDir: editableFixture.projectDir,
    editable: true,
    open: false,
  });
  t.after(() => closeServer(editable.server));

  assert.equal((await earlyResponse(editable, '/api/assets/import', {
    origin: editable.origin,
  })).status, 401);
  assert.equal((await earlyResponse(editable, '/api/assets/import', {
    token: editable.token,
    origin: 'https://evil.test',
  })).status, 403);
  assert.equal((await earlyResponse(editable, '/api/assets/import', {
    token: editable.token,
    method: 'GET',
  })).status, 405);

  const readOnlyFixture = makeReviewProject(t);
  const readOnly = await startTestReviewServer({
    root: ROOT,
    projectDir: readOnlyFixture.projectDir,
    open: false,
  });
  t.after(() => closeServer(readOnly.server));
  assert.equal((await earlyResponse(readOnly, '/api/assets/import', {
    token: readOnly.token,
    origin: readOnly.origin,
  })).status, 405);
});

test('raw media import exposes the fixed public status map without internal diagnostics', async (t) => {
  const fixture = makeReviewProject(t);
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir: fixture.projectDir,
    editable: true,
    open: false,
    statfsImpl: () => ({ bavail: 0, bsize: 4096 }),
  });
  t.after(() => closeServer(session.server));

  const malformed = await request(session, '/api/assets/import', {
    token: session.token,
    method: 'POST',
    origin: session.origin,
    body: Buffer.from('x'),
    contentType: 'video/mp4',
  });
  const unsupported = await request(session, '/api/assets/import', {
    token: session.token,
    method: 'POST',
    origin: session.origin,
    body: Buffer.from('x'),
    contentType: 'text/plain',
    headers: { 'x-automontage-filename': 'clip.txt' },
  });
  const diskFull = await request(session, '/api/assets/import', {
    token: session.token,
    method: 'POST',
    origin: session.origin,
    body: Buffer.from('x'),
    contentType: 'video/mp4',
    headers: { 'x-automontage-filename': 'clip.mp4' },
  });
  const tooLarge = await earlyResponse(session, '/api/assets/import', {
    token: session.token,
    origin: session.origin,
    headers: { 'content-length': String((1024 * 1024 * 1024) + 1) },
  });

  assert.deepEqual(
    [malformed.status, unsupported.status, diskFull.status, tooLarge.status],
    [400, 415, 507, 413],
  );
  for (const response of [malformed, unsupported, diskFull, tooLarge]) {
    assert.equal(response.body.toString?.('utf8') || response.body, 'Request rejected');
    assert.doesNotMatch(response.body.toString?.('utf8') || response.body, /clip|ffmpeg|\/Users\//i);
  }

  for (const [status, error] of [
    [422, mediaImportError(422, 'MEDIA_IMPORT_DECODE_FAILED', '/private/input.mov ffmpeg stderr')],
    [500, new Error('/private/project unexpected stack detail')],
  ]) {
    const branchFixture = makeReviewProject(t);
    const branch = await startTestReviewServer({
      root: ROOT,
      projectDir: branchFixture.projectDir,
      editable: true,
      open: false,
      logger: { error() {} },
      importMediaImpl: async () => { throw error; },
    });
    t.after(() => closeServer(branch.server));
    const response = await request(branch, '/api/assets/import', {
      token: branch.token,
      method: 'POST',
      origin: branch.origin,
      body: Buffer.from('x'),
      contentType: 'video/mp4',
      headers: { 'x-automontage-filename': 'clip.mp4' },
    });
    assert.equal(response.status, status);
    assert.equal(response.body.toString('utf8'), 'Request rejected');
  }
});

test('raw media import returns only an opaque registered descriptor and survives restart', async (t) => {
  const fixture = makeReviewProject(t);
  const importMediaImpl = async ({ request: incoming, projectDir }) => {
    for await (const _chunk of incoming) { /* consume the real HTTP body */ }
    return writeImportedVideoBundle(projectDir).record;
  };
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir: fixture.projectDir,
    editable: true,
    open: false,
    importMediaImpl,
  });
  const response = await request(session, '/api/assets/import', {
    token: session.token,
    method: 'POST',
    origin: session.origin,
    body: Buffer.from('raw upload'),
    contentType: 'video/mp4',
    headers: { 'x-automontage-filename': 'Product%20demo.mov' },
  });
  assert.equal(response.status, 201);
  const payload = JSON.parse(response.body.toString('utf8'));
  assert.match(payload.asset.id, /^asset-[1-9]\d*$/);
  assert.deepEqual(payload, {
    ok: true,
    asset: {
      id: payload.asset.id,
      kind: 'project',
      mediaKind: 'video',
      label: 'Product demo.mov',
      url: `/media/assets/${payload.asset.id}`,
      previewUrl: `/media/assets/${payload.asset.id}/preview`,
      width: 1920,
      height: 1080,
      fps: 25,
      durationSec: 18.4,
      audioDurationSec: 18.4,
      hasAudio: true,
      capabilities: { preview: true, brollImage: false, brollVideo: true },
    },
  });
  assert.doesNotMatch(JSON.stringify(payload), /assets\/broll|previews\/broll|[a-f0-9]{64}|\/Users\//);
  await closeServer(session.server);

  const restarted = await startTestReviewServer({
    root: ROOT,
    projectDir: fixture.projectDir,
    editable: true,
    open: false,
  });
  t.after(() => closeServer(restarted.server));
  const state = JSON.parse((await request(restarted, '/api/state', {
    token: restarted.token,
  })).body.toString('utf8'));
  const reconstructed = state.assets.find((asset) => asset.label === 'Product demo.mov');
  assert.match(reconstructed.id, /^asset-[1-9]\d*$/);
  assert.equal(reconstructed.url, `/media/assets/${reconstructed.id}`);
  assert.equal(reconstructed.previewUrl, `/media/assets/${reconstructed.id}/preview`);
  assert.deepEqual(
    { ...reconstructed, id: null, url: null, previewUrl: null },
    { ...payload.asset, id: null, url: null, previewUrl: null },
  );
});

test('active normalization blocks mutations without blocking reads or cleaning its preview window', async (t) => {
  const fixture = makeReviewProject(t);
  let releaseImport;
  const release = new Promise((resolve) => { releaseImport = resolve; });
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const importMediaImpl = async ({ request: incoming, controller, projectDir }) => {
    if (!controller.acquire()) throw mediaImportError(409, 'MEDIA_IMPORT_BUSY');
    try {
      for await (const _chunk of incoming) { /* real body */ }
      markStarted();
      await release;
      return writeImportedVideoBundle(projectDir).record;
    } finally {
      controller.release();
    }
  };
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir: fixture.projectDir,
    editable: true,
    open: false,
    importMediaImpl,
  });
  t.after(() => closeServer(session.server));
  const first = request(session, '/api/assets/import', {
    token: session.token,
    method: 'POST',
    origin: session.origin,
    body: Buffer.from('first'),
    contentType: 'video/mp4',
    headers: { 'x-automontage-filename': 'first.mp4' },
  });
  await started;

  const orphanPreview = path.join(fixture.projectDir, 'previews', 'broll', `${IMPORT_UUID}.webm`);
  fs.mkdirSync(path.dirname(orphanPreview), { recursive: true });
  fs.writeFileSync(orphanPreview, 'preview-first publication');
  const state = await request(session, '/api/state', { token: session.token });
  const source = await request(session, '/media/source', { token: session.token });
  const busyImport = await earlyResponse(session, '/api/assets/import', {
    token: session.token,
    origin: session.origin,
  });
  const busyValidate = await earlyResponse(session, '/api/validate', {
    token: session.token,
    origin: session.origin,
    headers: { 'content-type': 'application/json' },
  });
  const busySave = await earlyResponse(session, '/api/save', {
    token: session.token,
    origin: session.origin,
    headers: { 'content-type': 'application/json' },
  });

  assert.equal(state.status, 200);
  assert.equal(source.status, 200);
  assert.deepEqual([busyImport.status, busyValidate.status, busySave.status], [409, 409, 409]);
  assert.equal(fs.readFileSync(orphanPreview, 'utf8'), 'preview-first publication');
  releaseImport();
  assert.equal((await first).status, 201);
});

test('a completed request body keeps normalizing after incoming close', async (t) => {
  const fixture = makeReviewProject(t);
  let observedSignal;
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir: fixture.projectDir,
    editable: true,
    open: false,
    importMediaImpl: async ({ request: incoming, signal, projectDir }) => {
      for await (const _chunk of incoming) { /* wait for 100% upload */ }
      await new Promise((resolve) => setTimeout(resolve, 40));
      observedSignal = signal.aborted;
      return writeImportedVideoBundle(projectDir).record;
    },
  });
  t.after(() => closeServer(session.server));

  const response = await request(session, '/api/assets/import', {
    token: session.token,
    method: 'POST',
    origin: session.origin,
    body: Buffer.from('complete upload'),
    contentType: 'video/mp4',
    headers: { 'x-automontage-filename': 'complete.mp4' },
  });
  assert.equal(response.status, 201);
  assert.equal(observedSignal, false);
});

test('post-100-percent disconnect aborts the real child and publishes no asset', async (t) => {
  const fixture = makeReviewProject(t);
  const marker = path.join(fixture.root, 'child-sigterm.txt');
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let markDone;
  const done = new Promise((resolve) => { markDone = resolve; });
  let processCode = null;
  const session = await startTestReviewServer({
    root: ROOT,
    projectDir: fixture.projectDir,
    editable: true,
    open: false,
    importMediaImpl: async ({ request: incoming, signal, controller, runMediaProcessImpl }) => {
      if (!controller.acquire()) throw mediaImportError(409, 'MEDIA_IMPORT_BUSY');
      try {
        for await (const _chunk of incoming) { /* 100% uploaded */ }
        markStarted();
        const script = `const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(marker)},'SIGTERM');process.exit(0)});setInterval(()=>{},1000)`;
        await runMediaProcessImpl({ command: process.execPath, args: ['-e', script], signal });
      } catch (error) {
        processCode = error.code;
        throw error;
      } finally {
        controller.release();
        markDone();
      }
    },
  });
  t.after(() => closeServer(session.server));

  const outgoing = http.request({
    host: '127.0.0.1',
    port: session.server.address().port,
    path: '/api/assets/import',
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.token}`,
      origin: session.origin,
      'content-length': '8',
      'content-type': 'video/mp4',
      'x-automontage-filename': 'abort.mp4',
    },
  });
  outgoing.on('error', () => {});
  outgoing.end('complete');
  await started;
  await new Promise((resolve) => setTimeout(resolve, 120));
  outgoing.destroy();
  await done;

  assert.equal(processCode, 'MEDIA_PROCESS_ABORTED');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'SIGTERM');
  const publicationDirectory = path.join(fixture.projectDir, 'assets', 'broll', 'video');
  assert.equal(
    !fs.existsSync(publicationDirectory) || fs.readdirSync(publicationDirectory).length === 0,
    true,
  );
});

test('imported proxy is authenticated, ranged, pinned and never follows replacements', async (t) => {
  const fixture = makeReviewProject(t);
  const bundle = writeImportedVideoBundle(fixture.projectDir);
  const outside = path.join(fixture.root, 'outside.webm');
  fs.writeFileSync(outside, 'outside secret');
  const session = await startTestReviewServer({ root: ROOT, projectDir: fixture.projectDir, open: false });
  t.after(() => closeServer(session.server));
  const state = JSON.parse((await request(session, '/api/state', {
    token: session.token,
  })).body.toString('utf8'));
  const asset = state.assets[0];

  assert.equal((await request(session, asset.previewUrl)).status, 401);
  const head = await request(session, asset.previewUrl, { token: session.token, method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers['x-content-type-options'], 'nosniff');
  const range = await request(session, asset.previewUrl, {
    token: session.token,
    headers: { range: 'bytes=0-6' },
  });
  assert.equal(range.status, 206);
  assert.equal(range.body.toString('utf8'), 'preview');

  fs.unlinkSync(bundle.previewPath);
  fs.symlinkSync(outside, bundle.previewPath);
  const replacedProxy = await request(session, asset.previewUrl, { token: session.token });
  assert.equal(replacedProxy.status, 404);
  assert.doesNotMatch(replacedProxy.body.toString('utf8'), /outside secret/);

  fs.unlinkSync(bundle.canonicalPath);
  fs.symlinkSync(outside, bundle.canonicalPath);
  const replacedCanonical = await request(session, asset.url, { token: session.token });
  assert.equal(replacedCanonical.status, 404);
  assert.doesNotMatch(replacedCanonical.body.toString('utf8'), /outside secret/);
});

test('replacing an imported canonical master expires its paired preview handle', async (t) => {
  const fixture = makeReviewProject(t);
  const bundle = writeImportedVideoBundle(fixture.projectDir);
  const session = await startTestReviewServer({ root: ROOT, projectDir: fixture.projectDir, open: false });
  t.after(() => closeServer(session.server));
  const state = JSON.parse((await request(session, '/api/state', {
    token: session.token,
  })).body.toString('utf8'));
  const asset = state.assets.find((candidate) => candidate.label === 'Product demo.mov');

  const replacement = path.join(bundle.mediaDirectory, 'replacement.mp4');
  fs.writeFileSync(replacement, 'replacement canonical bytes');
  fs.renameSync(replacement, bundle.canonicalPath);

  const response = await request(session, asset.previewUrl, { token: session.token });
  assert.equal(response.status, 404);
  assert.doesNotMatch(response.body.toString('utf8'), /preview video/);
});

test('replacing an imported proxy expires its paired canonical handle', async (t) => {
  const fixture = makeReviewProject(t);
  const bundle = writeImportedVideoBundle(fixture.projectDir);
  const session = await startTestReviewServer({ root: ROOT, projectDir: fixture.projectDir, open: false });
  t.after(() => closeServer(session.server));
  const state = JSON.parse((await request(session, '/api/state', {
    token: session.token,
  })).body.toString('utf8'));
  const asset = state.assets.find((candidate) => candidate.label === 'Product demo.mov');

  const replacement = path.join(path.dirname(bundle.previewPath), 'replacement.webm');
  fs.writeFileSync(replacement, 'replacement proxy bytes');
  fs.renameSync(replacement, bundle.previewPath);

  const response = await request(session, asset.url, { token: session.token });
  assert.equal(response.status, 404);
  assert.doesNotMatch(response.body.toString('utf8'), /canonical video/);
});

test('startup and idle refresh preserve unrecorded UUID-shaped import remnants', async (t) => {
  const fixture = makeReviewProject(t);
  const stage = path.join(fixture.projectDir, 'assets', 'broll', 'video', `.${IMPORT_UUID}.stage`);
  const orphanPreview = path.join(fixture.projectDir, 'previews', 'broll', `${IMPORT_UUID}.webm`);
  const unrelated = path.join(fixture.projectDir, 'previews', 'broll', 'notes.txt');
  const outside = path.join(fixture.root, 'outside-safe.txt');
  const symlink = path.join(fixture.projectDir, 'assets', 'broll', 'video', '.7c0f5b6a-a921-4a51-8787-467a3a5c7c20.stage');
  fs.mkdirSync(stage, { recursive: true });
  fs.mkdirSync(path.dirname(orphanPreview), { recursive: true });
  fs.writeFileSync(orphanPreview, 'orphan');
  fs.writeFileSync(unrelated, 'unrelated');
  fs.writeFileSync(outside, 'outside');
  fs.symlinkSync(outside, symlink);
  const valid = writeImportedVideoBundle(fixture.projectDir, {
    id: '6cfbc858-7e33-4d29-b948-7ce7992761fc',
  });

  const session = await startTestReviewServer({ root: ROOT, projectDir: fixture.projectDir, open: false });
  t.after(() => closeServer(session.server));
  assert.equal(fs.existsSync(stage), true);
  assert.equal(fs.existsSync(orphanPreview), true);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'unrelated');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
  assert.equal(fs.lstatSync(symlink).isSymbolicLink(), true);
  assert.ok(inspectImportedAssetBundle({
    projectDir: fixture.projectDir,
    assetDirectory: valid.mediaDirectory,
  }));

  const idleOrphan = path.join(fixture.projectDir, 'previews', 'broll', `${IMPORT_UUID}.webm`);
  fs.writeFileSync(idleOrphan, 'idle orphan');
  assert.equal((await request(session, '/api/state', { token: session.token })).status, 200);
  assert.equal(fs.existsSync(idleOrphan), true);
});
