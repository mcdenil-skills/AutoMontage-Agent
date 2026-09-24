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

function probeHealth(port, { timeoutMs = 1500, maxBodyBytes = 4096 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (response) => {
      const chunks = [];
      let received = 0;
      response.on('data', (chunk) => {
        received += chunk.length;
        // Пульт никогда не отвечает больше пары байт JSON: чужой сервис на переиспользованном
        // порту не должен заставить нас буферизовать неограниченный или бесконечный ответ.
        if (received > maxBodyBytes) {
          request.destroy();
          finish(false);
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          finish(response.statusCode === 200 && body.app === 'automontage-pult');
        } catch (_) {
          finish(false);
        }
      });
    });
    request.on('timeout', () => {
      request.destroy();
      finish(false);
    });
    request.on('error', () => finish(false));
  });
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Сборка обложек через ffprobe/ffmpeg держит пульт синхронно занятым до ~15 с: один
// неответивший /api/health не значит, что процесс мёртв. Повторяем проверку каждые
// retryMs, пока не наберётся busyWaitMs, и только тогда сдаёмся — не удаляя файл: это
// либо действительно зависший процесс (вызывающий код сам решит, запускать ли новый —
// он перезапишет регистрацию), либо гонка, которую надёжнее оставить на следующий заход.
async function findRunningInstance(projectsDir, {
  isAlive = isProcessAlive,
  probe = probeHealth,
  busyWaitMs = 20000,
  retryMs = 500,
  sleep = defaultSleep,
} = {}) {
  const instance = readInstance(projectsDir);
  if (!instance) return null;
  if (!isAlive(instance.pid)) {
    // Владельца больше нет, но файл снимаем только через проверку pid: за время проверки
    // другой процесс мог успеть перезаписать регистрацию своей — её нельзя терять.
    removeInstance(projectsDir, instance.pid);
    return null;
  }
  const attempts = retryMs > 0 ? Math.max(1, Math.floor(busyWaitMs / retryMs) + 1) : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await probe(instance.port)) return { ...instance, url: instanceUrl(instance) };
    if (attempt < attempts - 1) await sleep(retryMs);
  }
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
