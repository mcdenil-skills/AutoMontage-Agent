const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream');
const { timingSafeEqual } = require('node:crypto');

const { openReadOnlyFlags } = require('../media-probe');
const { parseRange } = require('../review/server');

const BODY_LIMIT = 64 * 1024;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/styles.css', 'styles.css'],
]);
// Только для serveStatic (страница пульта) и JSON-ответов — не для медиа.
const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
]);
// Только для serveFile: пульт отдаёт через него лишь эти медиа, всё остальное — 404.
const MEDIA_CONTENT_TYPES = new Map([
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.m4v', 'video/x-m4v'],
  ['.mov', 'video/quicktime'],
  ['.mp4', 'video/mp4'],
  ['.png', 'image/png'],
  ['.webm', 'video/webm'],
]);
const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
});

class PultRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'PultRequestError';
    this.status = status;
    this.code = code;
  }
}

function send(response, status, body = '', headers = {}, head = false) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  response.writeHead(status, { ...SECURITY_HEADERS, 'Content-Length': payload.length, ...headers });
  response.end(head ? undefined : payload);
}

function sendError(response, status, head = false) {
  send(response, status, 'Request rejected', { 'Content-Type': 'text/plain; charset=utf-8' }, head);
}

function sendJson(response, status, value) {
  send(response, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8' });
}

function sendProblem(response, status, code, message) {
  sendJson(response, status, { code, message });
}

function safeTokenEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function requestToken(request, url) {
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length);
  }
  return url.pathname.startsWith('/media/') ? url.searchParams.get('token') : null;
}

function hasUnsafePath(requestTarget) {
  const rawPath = String(requestTarget || '').split(/[?#]/, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch (_) {
    return true;
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return true;
  return decoded.split('/').some((segment) => segment === '.' || segment === '..');
}

function contentType(filePath) {
  return CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

// Можно ли отдать этот файл браузеру через serveFile: только известные видео и картинки.
function isServableMedia(filePath) {
  return MEDIA_CONTENT_TYPES.has(path.extname(filePath).toLowerCase());
}

function readJsonBody(request, limit = BODY_LIMIT) {
  const type = String(request.headers['content-type'] || '');
  if (!JSON_CONTENT_TYPE.test(type)) {
    request.resume();
    return Promise.reject(new PultRequestError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Ожидался JSON'));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    request.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new PultRequestError(413, 'BODY_TOO_LARGE', 'Слишком большой запрос'));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (failed) return;
      try {
        // fatal: true — невалидный UTF-8 должен провалить разбор, а не молча испортить текст.
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        resolve(JSON.parse(text));
      } catch (_) {
        reject(new PultRequestError(400, 'INVALID_JSON', 'Неверный JSON'));
      }
    });
    request.on('error', () => {
      if (failed) return;
      failed = true;
      reject(new PultRequestError(400, 'BODY_ERROR', 'Запрос прерван'));
    });
  });
}

function serveStatic(root, pathname, request, response) {
  const filename = STATIC_FILES.get(pathname);
  if (!filename) return false;
  const head = request.method === 'HEAD';
  const directory = path.resolve(root, 'pult');
  const filePath = path.join(directory, filename);
  try {
    const directoryStat = fs.lstatSync(directory);
    const fileStat = fs.lstatSync(filePath);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()
      || fileStat.isSymbolicLink() || !fileStat.isFile()) throw new Error('unsafe static file');
  } catch (_) {
    sendError(response, 404, head);
    return true;
  }
  send(response, 200, fs.readFileSync(filePath), { 'Content-Type': contentType(filePath) }, head);
  return true;
}

// Отдаёт файл с поддержкой Range, чтобы видео можно было перематывать.
function serveFile(request, response, filePath) {
  const head = request.method === 'HEAD';
  // Только известные видео и картинки: legacy-карточка может указать «видео» на
  // notes.txt или .html рядом с роликом — такие файлы браузер не получит вовсе.
  const mediaType = MEDIA_CONTENT_TYPES.get(path.extname(filePath).toLowerCase());
  if (!mediaType) {
    sendError(response, 404, head);
    return;
  }
  let descriptor;
  let stat;
  try {
    descriptor = fs.openSync(filePath, openReadOnlyFlags(fs));
    stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('not a file');
  } catch (_) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    sendError(response, 404, head);
    return;
  }
  const range = parseRange(request.headers.range, stat.size);
  if (range === false) {
    fs.closeSync(descriptor);
    // RFC 9110: 416 обязан назвать актуальный размер, чтобы клиент мог пересчитать диапазон.
    send(response, 416, 'Request rejected', {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Range': `bytes */${stat.size}`,
    }, head);
    return;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : stat.size - 1;
  const length = stat.size === 0 ? 0 : end - start + 1;
  response.writeHead(range ? 206 : 200, {
    ...SECURITY_HEADERS,
    'Accept-Ranges': 'bytes',
    'Content-Length': length,
    'Content-Type': mediaType,
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}),
  });
  if (head || stat.size === 0) {
    fs.closeSync(descriptor);
    response.end();
    return;
  }
  const stream = fs.createReadStream(filePath, { fd: descriptor, autoClose: true, start, end });
  // pipeline, а не stream.pipe(): при отмене запроса (Chrome шлёт новый Range на каждой
  // перемотке) response уничтожается раньше конца файла — pipe() не закрывает источник за
  // собой, и файловый дескриптор остаётся висеть. pipeline() уничтожает оба конца всегда.
  pipeline(stream, response, () => {});
}

module.exports = {
  PultRequestError,
  SECURITY_HEADERS,
  hasUnsafePath,
  isServableMedia,
  readJsonBody,
  requestToken,
  safeTokenEqual,
  send,
  sendError,
  sendJson,
  sendProblem,
  serveFile,
  serveStatic,
};
