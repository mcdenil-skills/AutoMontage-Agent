const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const { openReadOnlyFlags } = require('../filesystem-capabilities');

// undefined — файла нет; битый JSON — ошибка с понятным именем файла.
// Открывается без прохода по симлинку: подменённый файл не должен читаться незаметно.
function readJsonIfExists(filePath, label) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, openReadOnlyFlags(fs));
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined;
    throw new Error(`${label} не читается`);
  }
  let text;
  try {
    text = fs.readFileSync(descriptor, 'utf8');
  } catch (_) {
    throw new Error(`${label} не читается`);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error(`${label}: неверный JSON`);
  }
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  const stat = fs.lstatSync(dirPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${path.basename(dirPath)}: небезопасная папка`);
  }
}

// Запись через временный файл и rename: оборванная запись не оставит полупустой JSON.
// Запись и переименование в одном try: если сам writeFileSync упадёт на середине
// (например диск переполнился), временный файл не должен остаться на диске.
function writeJsonAtomic(filePath, value, { mode = 0o644 } = {}) {
  ensureDirectory(path.dirname(filePath));
  const temporary = `${filePath}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  if (process.platform !== 'win32') fs.chmodSync(filePath, mode);
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function hashFile(filePath) {
  return hashBytes(fs.readFileSync(filePath));
}

module.exports = { ensureDirectory, hashBytes, hashFile, readJsonIfExists, writeJsonAtomic };
