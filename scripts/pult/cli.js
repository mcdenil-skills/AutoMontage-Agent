#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { ensureDirectory } = require('./files');
const { findRunningInstance, removeInstance, writeInstance } = require('./instance');
const { openPultWindow } = require('./launcher');
const { startPultServer } = require('./server');
const { installShortcut } = require('./shortcut');

const ROOT = path.resolve(__dirname, '../..');
const START_TIMEOUT_MS = 15000;
const POLL_MS = 200;
// Замок запуска старше этого считается брошенным: живой запускающий держит его не дольше
// START_TIMEOUT_MS плюс одна health-проверка.
const START_LOCK_STALE_MS = 30000;
const USAGE = `Пульт роликов AutoMontage

  automontage pult                       открыть пульт (запустит его, если нужно)
  automontage pult --install-shortcut    создать значок (macOS: «Программы», Windows: рабочий стол)
  automontage pult --serve               запустить пульт в этом окне терминала
  automontage inbox                      правки и утверждения из пульта для агента

Опции:
  --projects-dir <путь>   папка с роликами (по умолчанию projects/ в репозитории)
  --no-open               не открывать окно`;

function parsePultOptions(argv, { root = ROOT } = {}) {
  const options = { mode: 'open', projectsDir: path.join(root, 'projects'), open: true };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (seen.has(argument)) throw new Error(`повтор опции ${argument}`);
    seen.add(argument);
    if (argument === '--help' || argument === '-h') options.mode = 'help';
    else if (argument === '--serve') options.mode = 'serve';
    else if (argument === '--install-shortcut') options.mode = 'install-shortcut';
    else if (argument === '--no-open') options.open = false;
    else if (argument === '--projects-dir') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--projects-dir требует путь');
      options.projectsDir = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`неизвестная опция ${argument}`);
    }
  }
  if (seen.has('--serve') && seen.has('--install-shortcut')) {
    throw new Error('--serve и --install-shortcut нельзя указывать вместе');
  }
  return options;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startLockPath(projectsDir) {
  return path.join(projectsDir, '.pult', 'starting.lock');
}

function serveLogPath(projectsDir) {
  return path.join(projectsDir, '.pult', 'serve.log');
}

// Сервер жив, а окно не открылось (нет браузера, ошибка запуска) — это не провал команды:
// печатаем полный адрес с токеном, это собственный терминал пользователя.
async function openWindowSafely(openWindowImpl, url, log) {
  try {
    await openWindowImpl(url);
    return true;
  } catch (_) {
    log(`Пульт работает, но окно не открылось. Откройте в браузере: ${url}`);
    return false;
  }
}

// Журнал фонового сервера: без него падение при запуске со значка не оставило бы следа.
// O_NOFOLLOW: подложенный симлинк не должен перенаправить запись в чужой файл. Не вышло
// открыть журнал — запускаем без него, это только диагностика.
function openServeLog(projectsDir) {
  const { constants } = fs;
  let descriptor = null;
  try {
    descriptor = fs.openSync(
      serveLogPath(projectsDir),
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW || 0),
      0o600,
    );
    // Права при создании не меняют уже существующий файл — выравниваем явно.
    if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
    return descriptor;
  } catch (_) {
    if (descriptor !== null) fs.closeSync(descriptor);
    return null;
  }
}

// Замок запуска: два щелчка по значку подряд не должны поднять два сервера. Файл создаётся
// только исключительно ('wx'): такой open не проходит по симлинку и не открывает чужой файл.
// Возвращает объект с release(), если замок наш, или null, если его держит другой запуск.
function acquireStartLock(projectsDir, { now = Date.now, staleMs = START_LOCK_STALE_MS } = {}) {
  const lockPath = startLockPath(projectsDir);
  ensureDirectory(path.dirname(lockPath));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx', 0o600);
      let identity;
      try {
        identity = fs.fstatSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      return { release: () => releaseStartLock(lockPath, identity) };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
    if (attempt > 0) return null;
    let stat;
    try {
      // lstat: у симлинка важен возраст самой ссылки, а не файла, на который она указывает.
      stat = fs.lstatSync(lockPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (now() - stat.mtimeMs < staleMs) return null;
    // Замок брошен (запуск убили на середине) — снимаем его и пробуем ещё раз.
    // rmSync удаляет саму ссылку, а не её цель.
    fs.rmSync(lockPath, { force: true });
  }
  return null;
}

// Снимаем замок, только если это всё ещё наш файл: чужой замок, созданный после нашего,
// удалять нельзя.
function releaseStartLock(lockPath, identity) {
  let current;
  try {
    current = fs.lstatSync(lockPath);
  } catch (_) {
    return;
  }
  if (current.ino === identity.ino && current.dev === identity.dev) fs.rmSync(lockPath, { force: true });
}

// Пульт в этом процессе. Если он уже запущен — только открываем окно. Родительский
// openMode уже подождал занятый пульт, поэтому здесь повторно не ждём (busyWaitMs: 0).
async function serve(options, {
  openWindowImpl = openPultWindow,
  findRunningInstanceImpl = findRunningInstance,
  startServerImpl = startPultServer,
  log = console.log,
} = {}) {
  fs.mkdirSync(options.projectsDir, { recursive: true });
  const existing = await findRunningInstanceImpl(options.projectsDir, { busyWaitMs: 0 });
  if (existing) {
    log('Пульт уже запущен.');
    if (options.open) await openWindowSafely(openWindowImpl, existing.url, log);
    return 'existing';
  }
  const session = await startServerImpl({
    root: ROOT,
    projectsDir: options.projectsDir,
    onIdle: () => {
      removeInstance(options.projectsDir, process.pid);
      process.exit(0);
    },
  });
  writeInstance(options.projectsDir, { pid: process.pid, port: session.server.address().port, token: session.token });
  const stop = async (code) => {
    try {
      await session.close();
    } finally {
      removeInstance(options.projectsDir, process.pid);
      process.exit(code);
    }
  };
  process.once('SIGINT', () => stop(130));
  process.once('SIGTERM', () => stop(143));
  log(`Пульт работает: ${session.origin}`);
  if (options.open) await openWindowSafely(openWindowImpl, session.url, log);
  return 'started';
}

// Обычный запуск: сервер уходит в отдельный процесс, а команда (или значок) сразу завершается.
async function openMode(options, {
  spawnImpl = spawn,
  openWindowImpl = openPultWindow,
  findRunningInstanceImpl = findRunningInstance,
  sleep = defaultSleep,
  now = Date.now,
  log = console.log,
} = {}) {
  fs.mkdirSync(options.projectsDir, { recursive: true });
  // Окно — только удобство: если оно не открылось, команда всё равно успешна, адрес в выводе.
  const reveal = async (running) => {
    const opened = options.open ? await openWindowSafely(openWindowImpl, running.url, log) : true;
    if (opened) log('Пульт открыт.');
    return 'open';
  };
  // Первая проверка ждёт занятый пульт (до 20 с): пользователь ждёт именно его окно.
  const existing = await findRunningInstanceImpl(options.projectsDir);
  if (existing) return reveal(existing);

  // Сервер запускает только владелец замка; остальные просто ждут его регистрацию.
  const lock = acquireStartLock(options.projectsDir, { now });
  try {
    let spawnError = null;
    if (lock) {
      const logDescriptor = openServeLog(options.projectsDir);
      let child;
      try {
        child = spawnImpl(process.execPath, [__filename, '--serve', '--no-open', '--projects-dir', options.projectsDir], {
          cwd: ROOT,
          detached: true,
          env: process.env,
          shell: false,
          stdio: logDescriptor === null ? 'ignore' : ['ignore', logDescriptor, logDescriptor],
          windowsHide: true,
        });
      } finally {
        // Дочерний процесс уже получил свою копию дескриптора — родителю он больше не нужен.
        if (logDescriptor !== null) fs.closeSync(logDescriptor);
      }
      // Без обработчика ошибка запуска уронила бы процесс; с ним — понятное сообщение.
      child.once('error', (error) => { spawnError = error; });
      child.unref();
    }
    const deadline = now() + START_TIMEOUT_MS;
    while (now() < deadline) {
      await sleep(POLL_MS);
      if (spawnError) throw new Error(`пульт не запустился: ${spawnError.message}`);
      // Цикл сам повторяет проверку каждые 200 мс, поэтому внутри неё занятый пульт не ждём.
      const running = await findRunningInstanceImpl(options.projectsDir, { busyWaitMs: 0 });
      if (running) return reveal(running);
    }
    // Путь журнала — относительно папки роликов: абсолютный путь здесь не нужен.
    const logHint = `${path.basename(options.projectsDir)}/.pult/serve.log`;
    throw new Error(`пульт не запустился за 15 секунд. Подробности: ${logHint}. Для диагностики: automontage pult --serve`);
  } finally {
    if (lock) lock.release();
  }
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parsePultOptions(argv);
  } catch (error) {
    console.error(`❌ ${error.message}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  try {
    if (options.mode === 'help') console.log(USAGE);
    else if (options.mode === 'install-shortcut') console.log(installShortcut({ root: ROOT }).message);
    else if (options.mode === 'serve') await serve(options);
    else await openMode(options);
  } catch (error) {
    console.error(`❌ Пульт: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  USAGE, acquireStartLock, main, openMode, parsePultOptions, serve, startLockPath,
};
