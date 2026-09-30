const fs = require('node:fs');
const path = require('node:path');

const { captureProjectDirectoryGuard, resolveProjectPath, writeFilesNoReplace } = require('../project/workspace');
const { ensureDirectory, hashBytes, hashFile } = require('../pult/files');

const MB = 1024 * 1024;
const REFERENCE_LIMITS = { png: 15 * MB, jpg: 15 * MB, webp: 15 * MB, pdf: 30 * MB, html: 5 * MB };
const REFS_DIR = 'pult/lead-magnet-refs';
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

function looksLikeHtml(bytes) {
  if (bytes.includes(0)) return false;
  const head = bytes.subarray(0, 2048).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

// Тип определяется по первым байтам: расширение и MIME из браузера подделать легко.
function sniffReference(bytes) {
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC)) return { ext: 'png', mime: 'image/png' };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' };
  }
  if (bytes.length >= 5 && bytes.toString('latin1', 0, 5) === '%PDF-') return { ext: 'pdf', mime: 'application/pdf' };
  if (looksLikeHtml(bytes)) return { ext: 'html', mime: 'text/html' };
  return null;
}

// Референс хранится по SHA-256 содержимого: повторная загрузка того же файла не плодит копий,
// а имя файла никогда не приходит от пользователя.
function storeReference(projectDir, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error('референс: пустой файл');
  const type = sniffReference(bytes);
  if (!type) throw new Error('референс: такой тип файла не поддерживается – нужны PNG, JPG, WebP, PDF или HTML');
  if (bytes.length > REFERENCE_LIMITS[type.ext]) {
    throw new Error(`референс: файл больше ${REFERENCE_LIMITS[type.ext] / MB} МБ`);
  }
  const sha256 = hashBytes(bytes);
  const relative = `${REFS_DIR}/${sha256}.${type.ext}`;
  const target = resolveProjectPath(projectDir, relative, { label: 'reference', mustExist: false, type: 'file' });
  ensureDirectory(path.join(projectDir, 'pult'));
  ensureDirectory(path.dirname(target));
  const guard = captureProjectDirectoryGuard(projectDir, target, fs, 'reference');
  try {
    writeFilesNoReplace([{ destination: target, data: bytes, purpose: 'reference' }], {
      assertParentCurrent: () => guard.assertCurrent(),
      verifyPublishedIdentity: true,
    });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
    guard.assertCurrent();
    if (fs.lstatSync(target).isSymbolicLink() || hashFile(target) !== sha256) {
      throw new Error('референс: на месте файла лежит чужое содержимое');
    }
  }
  return { kind: 'file', path: relative, sha256, mime: type.mime, bytes: bytes.length };
}

function normalizeReferenceUrl(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 2048 || CONTROL_CHARS.test(text)) throw new Error('ссылка на референс: неверный адрес');
  let url;
  try {
    url = new URL(text);
  } catch (_) {
    throw new Error('ссылка на референс: неверный адрес');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    throw new Error('ссылка на референс: нужен обычный адрес http или https');
  }
  return url.href;
}

module.exports = { REFERENCE_LIMITS, REFS_DIR, normalizeReferenceUrl, sniffReference, storeReference };
