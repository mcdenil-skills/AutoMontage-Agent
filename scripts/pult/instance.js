const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { readJsonIfExists, writeJsonAtomic } = require('./files');

// Windows повторяет SYN после отказа на localhost: ECONNREFUSED приходит только через ~2 с.
// Таймаут должен быть длиннее, иначе закрытый порт будет принят за занятый пульт.
const HEALTH_TIMEOUT_MS = process.platform === 'win32' ? 3000 : 1500;

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

// Различает три состояния порта из instance.json:
// 'ok'     — это точно наш пульт и он отвечает;
// 'busy'   — ядро приняло соединение (иначе была бы ECONNREFUSED), но ответа нет вовремя —
//            так выглядит пульт, застрявший в синхронном ffprobe/ffmpeg на обложки (до ~15 с),
//            либо сам пульт, закрывающийся и вернувший 503 простым текстом: тело у 503 не
//            JSON, опознать пульта по нему нельзя, поэтому статус 503 по коду тоже считаем занятостью;
// 'absent' — порт не отвечает как пульт вовсе: отказ в соединении, чужой статус или чужое тело
//            (например pid из instance.json достался после перезагрузки другому процессу).
function checkHealth(port, { timeoutMs = HEALTH_TIMEOUT_MS, maxBodyBytes = 4096 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (response) => {
      if (response.statusCode === 503) {
        response.resume();
        finish('busy');
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        finish('absent');
        return;
      }
      const chunks = [];
      let received = 0;
      response.on('data', (chunk) => {
        received += chunk.length;
        // Чужой сервис на переиспользованном порту не должен заставить нас буферизовать
        // неограниченный ответ: пульт никогда не отвечает больше пары байт JSON.
        if (received > maxBodyBytes) {
          request.destroy();
          finish('absent');
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          finish(body.app === 'automontage-pult' ? 'ok' : 'absent');
        } catch (_) {
          finish('absent');
        }
      });
    });
    request.on('timeout', () => {
      // Соединение уже принято ядром — до сюда ECONNREFUSED дошёл бы как 'error', а не
      // 'timeout'. Значит порт слушает, просто ответ не успел прийти: сервер занят, а не мёртв.
      request.destroy();
      finish('busy');
    });
    request.on('error', () => finish('absent'));
  });
}

// Узкий булев срез checkHealth для вызывающего кода, которому нужен только факт «жив и отвечает».
async function probeHealth(port, options) {
  return (await checkHealth(port, options)) === 'ok';
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Сборка обложек через ffprobe/ffmpeg держит пульт синхронно занятым до ~15 с: один
// неответивший /api/health не значит, что процесс мёртв. Пока checkHealth говорит 'busy',
// повторяем проверку каждые retryMs, пока не наберётся busyWaitMs, и только тогда сдаёмся —
// не удаляя файл: это действительно зависший процесс, вызывающий код сам решит, запускать ли
// новый (он перезапишет регистрацию). А вот 'absent' — не повод ждать: если pid жив, но порт
// не отвечает как пульт (например, pid переиспользован после перезагрузки чужим процессом),
// ждать busyWaitMs на каждом запуске значка бессмысленно — снимаем регистрацию сразу.
async function findRunningInstance(projectsDir, {
  isAlive = isProcessAlive,
  check = checkHealth,
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
    const state = await check(instance.port);
    if (state === 'ok') return { ...instance, url: instanceUrl(instance) };
    if (state === 'absent') {
      removeInstance(projectsDir, instance.pid);
      return null;
    }
    // state === 'busy': сервер жив и когда-нибудь ответит — ждём и пробуем ещё раз.
    if (attempt < attempts - 1) await sleep(retryMs);
  }
  return null;
}

module.exports = {
  checkHealth,
  findRunningInstance,
  instancePath,
  instanceUrl,
  isProcessAlive,
  probeHealth,
  readInstance,
  removeInstance,
  writeInstance,
};
