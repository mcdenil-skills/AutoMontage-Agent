const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { REFERENCE_LIMITS, normalizeReferenceUrl, sniffReference, storeReference } = require('../scripts/lead-magnet/references');
const { makeVideoProject } = require('./helpers/lead-magnet-fixtures');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpg-body')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const PDF = Buffer.from('%PDF-1.7\n...');
const HTML = Buffer.from('﻿  <!DOCTYPE html><html><body>ref</body></html>');

test('file type is detected by signature, not by name', () => {
  assert.equal(sniffReference(PNG).ext, 'png');
  assert.equal(sniffReference(JPG).ext, 'jpg');
  assert.equal(sniffReference(WEBP).ext, 'webp');
  assert.equal(sniffReference(PDF).ext, 'pdf');
  assert.equal(sniffReference(HTML).ext, 'html');
  assert.equal(sniffReference(Buffer.from('MZ\x90\x00 fake exe')), null);
  assert.equal(sniffReference(Buffer.from('<html>\u0000binary')), null);
});

test('stored reference gets a content-addressed name inside the project', (t) => {
  const { projectDir } = makeVideoProject(t);
  const stored = storeReference(projectDir, PNG);
  assert.match(stored.path, /^pult\/lead-magnet-refs\/[a-f0-9]{64}\.png$/);
  assert.equal(stored.kind, 'file');
  assert.equal(stored.mime, 'image/png');
  assert.deepEqual(fs.readFileSync(path.join(projectDir, ...stored.path.split('/'))), PNG);
  assert.deepEqual(storeReference(projectDir, PNG), stored);
});

test('unsupported, empty and oversized files are rejected without writing', (t) => {
  const { projectDir } = makeVideoProject(t);
  assert.throws(() => storeReference(projectDir, Buffer.alloc(0)), /пустой/);
  assert.throws(() => storeReference(projectDir, Buffer.from('MZ fake')), /не поддерживается/);
  const huge = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(REFERENCE_LIMITS.pdf)]);
  assert.throws(() => storeReference(projectDir, huge), /больше 30 МБ/);
  assert.equal(fs.existsSync(path.join(projectDir, 'pult', 'lead-magnet-refs')), false);
});

test('a symlinked refs folder is refused', (t) => {
  const { base, projectDir } = makeVideoProject(t);
  fs.mkdirSync(path.join(projectDir, 'pult'), { recursive: true });
  fs.mkdirSync(path.join(base, 'elsewhere'));
  fs.symlinkSync(path.join(base, 'elsewhere'), path.join(projectDir, 'pult', 'lead-magnet-refs'));
  assert.throws(() => storeReference(projectDir, PNG));
  assert.deepEqual(fs.readdirSync(path.join(base, 'elsewhere')), []);
});

test('a refs folder swapped for a symlink at the write boundary cannot receive reference bytes', (t) => {
  const { base, projectDir } = makeVideoProject(t);
  const refsDir = path.join(projectDir, 'pult', 'lead-magnet-refs');
  const heldDir = path.join(projectDir, 'pult', 'lead-magnet-refs-held');
  const outsideDir = path.join(base, 'outside');
  fs.mkdirSync(outsideDir);
  const originalWrite = fs.writeFileSync;
  const originalOpen = fs.openSync;
  let swapped = false;
  const swap = (candidate) => {
    if (swapped || !candidate.startsWith(`${refsDir}${path.sep}`)) return;
    swapped = true;
    fs.renameSync(refsDir, heldDir);
    fs.symlinkSync(outsideDir, refsDir, 'dir');
  };
  fs.writeFileSync = (candidate, ...args) => {
    swap(String(candidate));
    return originalWrite(candidate, ...args);
  };
  fs.openSync = (candidate, ...args) => {
    swap(String(candidate));
    return originalOpen(candidate, ...args);
  };
  try {
    assert.throws(() => storeReference(projectDir, PNG));
  } finally {
    fs.writeFileSync = originalWrite;
    fs.openSync = originalOpen;
  }
  assert.equal(swapped, true);
  assert.deepEqual(fs.readdirSync(outsideDir), []);
});

test('a normal write at the same boundary stores a reference in the project', (t) => {
  const { projectDir } = makeVideoProject(t);
  const refsDir = path.join(projectDir, 'pult', 'lead-magnet-refs');
  const originalWrite = fs.writeFileSync;
  const originalOpen = fs.openSync;
  let reachedBoundary = false;
  const observe = (candidate) => {
    if (String(candidate).startsWith(`${refsDir}${path.sep}`)) reachedBoundary = true;
  };
  fs.writeFileSync = (candidate, ...args) => {
    observe(candidate);
    return originalWrite(candidate, ...args);
  };
  fs.openSync = (candidate, ...args) => {
    observe(candidate);
    return originalOpen(candidate, ...args);
  };
  let stored;
  try {
    stored = storeReference(projectDir, PNG);
  } finally {
    fs.writeFileSync = originalWrite;
    fs.openSync = originalOpen;
  }
  assert.equal(reachedBoundary, true);
  assert.deepEqual(fs.readFileSync(path.join(projectDir, ...stored.path.split('/'))), PNG);
});

test('only plain http(s) links are accepted', () => {
  assert.equal(normalizeReferenceUrl(' https://example.com/guide '), 'https://example.com/guide');
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pass@example.com', 'https://exa\u0007mple.com', 'не ссылка', `https://e.com/${'a'.repeat(2100)}`]) {
    assert.throws(() => normalizeReferenceUrl(bad), /ссылка/);
  }
});
