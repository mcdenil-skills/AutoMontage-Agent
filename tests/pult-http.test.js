const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  hasUnsafePath,
  readJsonBody,
  requestToken,
  safeTokenEqual,
  serveFile,
} = require('../scripts/pult/http');

const WINDOWS = process.platform === 'win32';

test('unsafe request targets are detected', () => {
  for (const target of ['/media/../x', '/%2e%2e/x', '/a\\b', '/a%5cb', '/a%00', '/%E0%A4%A', '/media/..#x']) {
    assert.equal(hasUnsafePath(target), true, target);
  }
  for (const target of ['/', '/api/cards', '/media/video?key=a%2Fb']) {
    assert.equal(hasUnsafePath(target), false, target);
  }
});

test('tokens come from the bearer header, or from the query only for media', () => {
  assert.equal(requestToken({ headers: {} }, new URL('http://127.0.0.1/api/cards?token=q')), null);
  assert.equal(requestToken({ headers: { authorization: 'Bearer abc' } }, new URL('http://127.0.0.1/api/cards')), 'abc');
  assert.equal(requestToken({ headers: {} }, new URL('http://127.0.0.1/media/video?token=q')), 'q');
  assert.equal(safeTokenEqual('abc', 'abc'), true);
  assert.equal(safeTokenEqual('abc', 'abd'), false);
  assert.equal(safeTokenEqual('abc', 'abcd'), false);
  assert.equal(safeTokenEqual(null, 'abc'), false);
});

// Поддельный IncomingMessage: EventEmitter с headers и resume(), как ждёт readJsonBody.
function fakeRequest(headers, chunks) {
  const request = new EventEmitter();
  request.headers = headers;
  request.resume = () => {};
  queueMicrotask(() => {
    for (const chunk of chunks) request.emit('data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    request.emit('end');
  });
  return request;
}

test('readJsonBody rejects invalid UTF-8 bytes with 400', async () => {
  const request = fakeRequest({ 'content-type': 'application/json' }, [Buffer.from([0xff, 0xfe, 0xfd])]);
  await assert.rejects(readJsonBody(request), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, 'INVALID_JSON');
    return true;
  });
});

test('readJsonBody rejects a non-utf-8 charset with 415', async () => {
  const request = fakeRequest({ 'content-type': 'application/json; charset=latin1' }, ['{}']);
  await assert.rejects(readJsonBody(request), (error) => {
    assert.equal(error.status, 415);
    assert.equal(error.code, 'UNSUPPORTED_MEDIA_TYPE');
    return true;
  });
});

test('readJsonBody parses application/json with an explicit utf-8 charset', async () => {
  const request = fakeRequest({ 'content-type': 'application/json; charset=utf-8' }, ['{"a":1}']);
  assert.deepEqual(await readJsonBody(request), { a: 1 });
});

// Мини-HTTP-сервер поверх serveFile для тестов, которым нужен настоящий request/response.
function withServeFileServer(filePath, requestOptions, onResponse) {
  const responseClosed = [];
  const server = http.createServer((request, response) => {
    responseClosed.push(new Promise((resolve) => response.on('close', resolve)));
    serveFile(request, response, filePath);
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const outgoing = http.request({
        host: '127.0.0.1',
        port,
        path: '/file',
        agent: false,
        ...requestOptions,
      });
      outgoing.on('error', reject);
      outgoing.on('response', async (response) => {
        try {
          const result = await onResponse(response, outgoing);
          await Promise.all(responseClosed);
          server.close(() => resolve(result));
        } catch (error) {
          server.close(() => reject(error));
        }
      });
      outgoing.end();
    });
  });
}

test('serveFile releases the file descriptor when the client cancels a range request', { skip: WINDOWS && 'нет /dev/fd на Windows' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-http-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'video.mp4');
  fs.writeFileSync(filePath, Buffer.alloc(2 * 1024 * 1024, 1));

  const fdCount = () => fs.readdirSync('/dev/fd').length;
  const before = fdCount();

  const ATTEMPTS = 20;
  for (let i = 0; i < ATTEMPTS; i += 1) {
    await withServeFileServer(filePath, { headers: { Range: 'bytes=0-' } }, (response, outgoing) => new Promise((resolve) => {
      response.once('data', () => outgoing.destroy());
      response.on('close', resolve);
      response.on('error', () => {});
    }));
  }

  // Дать серверу время закрыть файловые дескрипторы после отмены запросов.
  let after = fdCount();
  const deadline = Date.now() + 1000;
  while (after > before && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    after = fdCount();
  }
  assert.equal(after, before);
});

test('serveFile: a regular file serves 200, a symlinked final component is rejected', { skip: WINDOWS && 'символические ссылки требуют прав на Windows' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-http-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const realPath = path.join(dir, 'real.mp4');
  fs.writeFileSync(realPath, Buffer.from('abc'));

  const okStatus = await withServeFileServer(realPath, {}, (response) => {
    response.resume();
    return new Promise((resolve) => response.on('end', () => resolve(response.statusCode)));
  });
  assert.equal(okStatus, 200);

  const linkPath = path.join(dir, 'link.mp4');
  fs.symlinkSync(realPath, linkPath);
  const linkedStatus = await withServeFileServer(linkPath, {}, (response) => {
    response.resume();
    return new Promise((resolve) => response.on('end', () => resolve(response.statusCode)));
  });
  assert.equal(linkedStatus, 404);
});

test('serveFile only ever sends media content types, never text/html', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-http-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'page.html');
  fs.writeFileSync(filePath, '<html></html>');

  const contentType = await withServeFileServer(filePath, {}, (response) => {
    response.resume();
    return new Promise((resolve) => response.on('end', () => resolve(response.headers['content-type'])));
  });
  assert.equal(contentType, 'application/octet-stream');
});

test('serveFile answers an unsatisfiable range with 416 and Content-Range: bytes */size', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-http-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'video.mp4');
  fs.writeFileSync(filePath, Buffer.alloc(100, 1));

  const result = await withServeFileServer(filePath, { headers: { Range: 'bytes=500-600' } }, (response) => {
    response.resume();
    return new Promise((resolve) => response.on('end', () => resolve({
      status: response.statusCode,
      contentRange: response.headers['content-range'],
    })));
  });
  assert.equal(result.status, 416);
  assert.equal(result.contentRange, 'bytes */100');
});
