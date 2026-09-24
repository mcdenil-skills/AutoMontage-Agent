const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { readJsonIfExists, writeJsonAtomic } = require('./files');

function instancePath(projectsDir) {
  return path.join(projectsDir, '.pult', 'instance.json');
}

function instanceUrl({ port, token }) {
  return `http://127.0.0.1:${port}/#token=${token}`;
}

// Токен лежит в файле с правами 0600 внутри projects/ пользователя: так повторный
// запуск значка открывает тот же пульт, а не второй сервер.
function writeInstance(projectsDir, { pid, port, token }) {
  writeJsonAtomic(instancePath(projectsDir), {
    version: 1,
    pid,
    port,
    token,
    startedAt: new Date().toISOString(),
  }, { mode: 0o600 });
}

function readInstance(projectsDir) {
  let value;
  try {
    value = readJsonIfExists(instancePath(projectsDir), '.pult/instance.json');
  } catch (_) {
    return null;
  }
  if (!value || value.version !== 1
    || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || !Number.isSafeInteger(value.port) || value.port <= 0 || value.port > 65535
    || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{20,}$/.test(value.token)) return null;
  return value;
}

function removeInstance(projectsDir, expectedPid) {
  const current = readInstance(projectsDir);
  if (current && current.pid !== expectedPid) return false;
  fs.rmSync(instancePath(projectsDir), { force: true });
  return true;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function probeHealth(port, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(response.statusCode === 200 && body.app === 'automontage-pult');
        } catch (_) {
          resolve(false);
        }
      });
    });
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });
}

async function findRunningInstance(projectsDir, { isAlive = isProcessAlive, probe = probeHealth } = {}) {
  const instance = readInstance(projectsDir);
  if (!instance) return null;
  if (isAlive(instance.pid) && await probe(instance.port)) return { ...instance, url: instanceUrl(instance) };
  fs.rmSync(instancePath(projectsDir), { force: true });
  return null;
}

module.exports = {
  findRunningInstance,
  instancePath,
  instanceUrl,
  isProcessAlive,
  probeHealth,
  readInstance,
  removeInstance,
  writeInstance,
};
