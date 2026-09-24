const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createHash } = require('node:crypto');

const { hashBytes, hashFile, writeJsonAtomic } = require('../scripts/pult/files');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-pult-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Minor: if fs.writeFileSync itself fails partway (e.g. disk full after the exclusive
// create), the temp file it created must not be left behind. Simulate a failure that
// still creates the temp file (as a real partial write would) before throwing.
test('writeJsonAtomic removes its temp file when the write itself fails', (t) => {
  const dir = tmpDir(t);
  const target = path.join(dir, 'value.json');
  const original = fs.writeFileSync;
  fs.writeFileSync = (filePath, data, options) => {
    fs.writeFileSync = original;
    fs.closeSync(fs.openSync(filePath, options.flag, options.mode));
    throw new Error('disk full');
  };
  try {
    assert.throws(() => writeJsonAtomic(target, { a: 1 }), /disk full/);
  } finally {
    fs.writeFileSync = original;
  }
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
  assert.equal(fs.existsSync(target), false);
});

// Preview может весить сотни мегабайт: hashFile читает его кусками, а не целиком в память.
// Размер больше одного куска и не кратен ему — чтобы проверить и склейку, и хвост.
test('hashFile hashes a multi-chunk file exactly like its bytes', (t) => {
  const dir = tmpDir(t);
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 12345);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31) % 251;
  const big = path.join(dir, 'big.mp4');
  fs.writeFileSync(big, bytes);
  const expected = createHash('sha256').update(bytes).digest('hex');
  assert.equal(hashFile(big), expected);
  assert.equal(hashBytes(bytes), expected);

  const empty = path.join(dir, 'empty.mp4');
  fs.writeFileSync(empty, '');
  assert.equal(hashFile(empty), createHash('sha256').update('').digest('hex'));
});
