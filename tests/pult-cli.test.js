const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');

const { openMode, parsePultOptions, serve, startLockPath } = require('../scripts/pult/cli');
const { probeHealth, readInstance, writeInstance } = require('../scripts/pult/instance');
const { ROOT, makePultRoot } = require('./helpers/pult-projects');

const TOKEN = 'b'.repeat(43);

test('pult options', () => {
  assert.deepEqual(parsePultOptions([], { root: '/r' }), { mode: 'open', projectsDir: path.join('/r', 'projects'), open: true });
  assert.equal(parsePultOptions(['--serve', '--no-open'], { root: '/r' }).mode, 'serve');
  assert.equal(parsePultOptions(['--serve', '--no-open'], { root: '/r' }).open, false);
  assert.equal(parsePultOptions(['--install-shortcut'], { root: '/r' }).mode, 'install-shortcut');
  assert.equal(parsePultOptions(['--projects-dir', 'x'], { root: '/r' }).projectsDir, path.resolve('x'));
  for (const argv of [['--bogus'], ['--projects-dir'], ['--serve', '--serve'], ['--serve', '--install-shortcut']]) {
    assert.throws(() => parsePultOptions(argv, { root: '/r' }), JSON.stringify(argv));
  }
});

test('main help lists the pult and inbox commands', (t) => {
  const cli = path.join(ROOT, 'scripts', 'cli.js');
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.match(help.stdout, /automontage pult/);
  assert.match(help.stdout, /automontage inbox/);
  const pult = spawnSync(process.execPath, [cli, 'pult', '--help'], { encoding: 'utf8' });
  assert.equal(pult.status, 0);
  assert.match(pult.stdout, /Пульт роликов/);
  const bad = spawnSync(process.execPath, [cli, 'pult', '--bogus'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  // inbox уходит в свой скрипт, а не в build.js: пустая папка роликов даёт пустые входящие.
  const { projectsDir } = makePultRoot(t);
  const inbox = spawnSync(process.execPath, [cli, 'inbox', '--projects-dir', projectsDir], { encoding: 'utf8' });
  assert.equal(inbox.status, 0, inbox.stderr);
  assert.match(inbox.stdout, /Во входящих пульта пусто/);
});

test('serve mode registers one instance and removes it on SIGTERM', { skip: process.platform === 'win32' }, async (t) => {
  const { projectsDir } = makePultRoot(t);
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'pult', 'cli.js'), '--serve', '--no-open', '--projects-dir', projectsDir], { stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let instance = null;
  for (let attempt = 0; attempt < 50 && !instance; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    instance = readInstance(projectsDir);
  }
  assert.ok(instance, 'instance.json appeared');
  assert.equal(await probeHealth(instance.port), true);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
  assert.equal(readInstance(projectsDir), null);
});

// Крошечный сервер, который отвечает на /api/health как настоящий пульт.
async function startFakePult(t) {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end('{"app":"automontage-pult"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

// Поддельный spawn: вместо процесса сервера через паузу пишет instance.json живого фейка.
function fakeSpawner({ projectsDir, port, delayMs = 100 }) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    setTimeout(() => writeInstance(projectsDir, { pid: process.pid, port, token: TOKEN }), delayMs);
    return child;
  };
  return { calls, spawnImpl };
}

function recordWindows() {
  const urls = [];
  return { urls, openWindowImpl: async (url) => { urls.push(url); } };
}

const quiet = () => {};

test('two icon clicks at once start exactly one server and both open it', async (t) => {
  const { projectsDir } = makePultRoot(t);
  const port = await startFakePult(t);
  const { calls, spawnImpl } = fakeSpawner({ projectsDir, port });
  const { urls, openWindowImpl } = recordWindows();
  const options = { mode: 'open', projectsDir, open: true };
  const results = await Promise.all([
    openMode(options, { spawnImpl, openWindowImpl, log: quiet }),
    openMode(options, { spawnImpl, openWindowImpl, log: quiet }),
  ]);
  assert.deepEqual(results, ['open', 'open']);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(1), ['--serve', '--no-open', '--projects-dir', projectsDir]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.detached, true);
  assert.deepEqual(urls, [`http://127.0.0.1:${port}/#token=${TOKEN}`, `http://127.0.0.1:${port}/#token=${TOKEN}`]);
  assert.equal(fs.existsSync(startLockPath(projectsDir)), false, 'lock released after start');
});

test('a fresh start lock held by another launcher means wait, not spawn', async (t) => {
  const { projectsDir } = makePultRoot(t);
  const port = await startFakePult(t);
  fs.mkdirSync(path.dirname(startLockPath(projectsDir)), { recursive: true });
  fs.writeFileSync(startLockPath(projectsDir), '');
  const calls = [];
  const spawnImpl = () => { calls.push(1); throw new Error('must not spawn'); };
  const { urls, openWindowImpl } = recordWindows();
  setTimeout(() => writeInstance(projectsDir, { pid: process.pid, port, token: TOKEN }), 300);
  const result = await openMode({ mode: 'open', projectsDir, open: true }, { spawnImpl, openWindowImpl, log: quiet });
  assert.equal(result, 'open');
  assert.equal(calls.length, 0);
  assert.equal(urls.length, 1);
  assert.ok(fs.existsSync(startLockPath(projectsDir)), 'someone else\'s lock is not removed');
});

test('a stale start lock is removed and exactly one server is spawned', async (t) => {
  const { projectsDir } = makePultRoot(t);
  const port = await startFakePult(t);
  const lockPath = startLockPath(projectsDir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, '');
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(lockPath, past, past);
  const { calls, spawnImpl } = fakeSpawner({ projectsDir, port });
  const { urls, openWindowImpl } = recordWindows();
  const result = await openMode({ mode: 'open', projectsDir, open: true }, { spawnImpl, openWindowImpl, log: quiet });
  assert.equal(result, 'open');
  assert.equal(calls.length, 1);
  assert.equal(urls.length, 1);
  assert.equal(fs.existsSync(lockPath), false);
});

test('the start lock never follows a symlink', { skip: process.platform === 'win32' }, async (t) => {
  const { base, projectsDir } = makePultRoot(t);
  const port = await startFakePult(t);
  const target = path.join(base, 'outside.txt');
  fs.writeFileSync(target, 'keep');
  const lockPath = startLockPath(projectsDir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.symlinkSync(target, lockPath);
  const past = new Date(Date.now() - 60000);
  fs.lutimesSync(lockPath, past, past);
  const { calls, spawnImpl } = fakeSpawner({ projectsDir, port });
  const { openWindowImpl } = recordWindows();
  await openMode({ mode: 'open', projectsDir, open: true }, { spawnImpl, openWindowImpl, log: quiet });
  assert.equal(calls.length, 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
});

test('the polling loop never waits for a busy pult on its own', async (t) => {
  const { projectsDir } = makePultRoot(t);
  const seen = [];
  let calls = 0;
  const findRunningInstanceImpl = async (dir, options) => {
    seen.push(options);
    calls += 1;
    return calls >= 3 ? { url: 'http://127.0.0.1:1/#token=x' } : null;
  };
  const child = new EventEmitter();
  child.unref = () => {};
  const { urls, openWindowImpl } = recordWindows();
  const result = await openMode({ mode: 'open', projectsDir, open: true }, {
    spawnImpl: () => child,
    openWindowImpl,
    findRunningInstanceImpl,
    sleep: async () => {},
    log: quiet,
  });
  assert.equal(result, 'open');
  assert.deepEqual(urls, ['http://127.0.0.1:1/#token=x']);
  // Первая проверка до запуска ждёт занятый пульт по умолчанию, цикл – нет.
  assert.equal(seen[0] && seen[0].busyWaitMs, undefined);
  assert.ok(seen.length >= 3);
  for (const options of seen.slice(1)) assert.equal(options.busyWaitMs, 0);
});

test('a launcher that gives up releases its start lock', async (t) => {
  const { projectsDir } = makePultRoot(t);
  let clock = Date.now();
  const child = new EventEmitter();
  child.unref = () => {};
  await assert.rejects(
    openMode({ mode: 'open', projectsDir, open: true }, {
      spawnImpl: () => child,
      openWindowImpl: async () => { throw new Error('must not open'); },
      findRunningInstanceImpl: async () => null,
      sleep: async () => {},
      now: () => { clock += 1000; return clock; },
      log: quiet,
    }),
    // Путь к журналу – внутри папки роликов, без абсолютного пути.
    /не запустился[\s\S]*Подробности: projects\/\.pult\/serve\.log/,
  );
  assert.equal(fs.existsSync(startLockPath(projectsDir)), false);
});

test('the detached server writes its output to a private serve.log', async (t) => {
  const { projectsDir } = makePultRoot(t);
  const port = await startFakePult(t);
  const stdios = [];
  const spawnImpl = (command, args, options) => {
    stdios.push(options.stdio);
    // Родитель закроет дескриптор сразу после spawn – пишем в него, пока он открыт.
    if (Array.isArray(options.stdio)) fs.writeSync(options.stdio[2], 'след сервера\n');
    const child = new EventEmitter();
    child.unref = () => {};
    setTimeout(() => writeInstance(projectsDir, { pid: process.pid, port, token: TOKEN }), 50);
    return child;
  };
  const { openWindowImpl } = recordWindows();
  await openMode({ mode: 'open', projectsDir, open: true }, { spawnImpl, openWindowImpl, log: quiet });
  assert.equal(stdios.length, 1);
  const [stdin, stdout, stderr] = stdios[0];
  assert.equal(stdin, 'ignore');
  assert.equal(typeof stdout, 'number');
  assert.equal(stderr, stdout);
  const logPath = path.join(projectsDir, '.pult', 'serve.log');
  assert.equal(fs.readFileSync(logPath, 'utf8'), 'след сервера\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
});

test('a symlinked serve.log is never followed', { skip: process.platform === 'win32' }, async (t) => {
  const { base, projectsDir } = makePultRoot(t);
  const port = await startFakePult(t);
  const target = path.join(base, 'outside.txt');
  fs.writeFileSync(target, 'keep');
  fs.mkdirSync(path.join(projectsDir, '.pult'), { recursive: true });
  fs.symlinkSync(target, path.join(projectsDir, '.pult', 'serve.log'));
  const { calls, spawnImpl } = fakeSpawner({ projectsDir, port });
  const { openWindowImpl } = recordWindows();
  const result = await openMode({ mode: 'open', projectsDir, open: true }, { spawnImpl, openWindowImpl, log: quiet });
  assert.equal(result, 'open');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
});

// Пульт жив, но браузер не открылся: это не ошибка команды – даём адрес вручную.
test('a window that fails to open still leaves a working pult and its address', async (t) => {
  const { projectsDir } = makePultRoot(t);
  const url = 'http://127.0.0.1:3/#token=z';
  const failingWindow = async () => { throw new Error('нет браузера'); };
  const expected = `Пульт работает, но окно не открылось. Откройте в браузере: ${url}`;

  const running = [];
  assert.equal(await openMode({ mode: 'open', projectsDir, open: true }, {
    findRunningInstanceImpl: async () => ({ url }),
    openWindowImpl: failingWindow,
    log: (line) => running.push(line),
  }), 'open');
  assert.ok(running.includes(expected), running.join('\n'));

  const started = [];
  let checks = 0;
  const child = new EventEmitter();
  child.unref = () => {};
  assert.equal(await openMode({ mode: 'open', projectsDir, open: true }, {
    spawnImpl: () => child,
    findRunningInstanceImpl: async () => { checks += 1; return checks > 1 ? { url } : null; },
    openWindowImpl: failingWindow,
    sleep: async () => {},
    log: (line) => started.push(line),
  }), 'open');
  assert.ok(started.includes(expected), started.join('\n'));

  const existing = [];
  assert.equal(await serve({ mode: 'serve', projectsDir, open: true }, {
    findRunningInstanceImpl: async () => ({ url }),
    openWindowImpl: failingWindow,
    startServerImpl: async () => { throw new Error('must not start a second server'); },
    log: (line) => existing.push(line),
  }), 'existing');
  assert.ok(existing.includes(expected), existing.join('\n'));
});

test('a freshly served pult tells its address when the window fails', async (t) => {
  const { projectsDir } = makePultRoot(t);
  const signals = ['SIGINT', 'SIGTERM'];
  const before = new Map(signals.map((signal) => [signal, process.listeners(signal)]));
  // serve вешает обработчики сигналов на процесс – снимаем их, чтобы не задеть раннер тестов.
  t.after(() => {
    for (const signal of signals) {
      for (const listener of process.listeners(signal)) {
        if (!before.get(signal).includes(listener)) process.removeListener(signal, listener);
      }
    }
  });
  const url = `http://127.0.0.1:4/#token=${TOKEN}`;
  const lines = [];
  const result = await serve({ mode: 'serve', projectsDir, open: true }, {
    findRunningInstanceImpl: async () => null,
    startServerImpl: async () => ({
      server: { address: () => ({ port: 4 }) },
      token: TOKEN,
      origin: 'http://127.0.0.1:4',
      url,
      close: async () => {},
    }),
    openWindowImpl: async () => { throw new Error('нет браузера'); },
    log: (line) => lines.push(line),
  });
  assert.equal(result, 'started');
  assert.ok(lines.includes(`Пульт работает, но окно не открылось. Откройте в браузере: ${url}`), lines.join('\n'));
});

test('a server that fails to spawn is reported instead of waiting', async (t) => {
  const { projectsDir } = makePultRoot(t);
  const child = new EventEmitter();
  child.unref = () => {};
  const spawnImpl = () => {
    setImmediate(() => child.emit('error', new Error('spawn EACCES')));
    return child;
  };
  await assert.rejects(
    openMode({ mode: 'open', projectsDir, open: true }, {
      spawnImpl,
      openWindowImpl: async () => {},
      findRunningInstanceImpl: async () => null,
      // Пауза отдаёт ход циклу событий, иначе событие error не успеет прийти.
      sleep: () => new Promise((resolve) => setImmediate(resolve)),
      log: quiet,
    }),
    /EACCES/,
  );
  assert.equal(fs.existsSync(startLockPath(projectsDir)), false);
});

test('serve opens a running pult without waiting on it again', async (t) => {
  const { projectsDir } = makePultRoot(t);
  const seen = [];
  const { urls, openWindowImpl } = recordWindows();
  const result = await serve({ mode: 'serve', projectsDir, open: true }, {
    findRunningInstanceImpl: async (dir, options) => { seen.push(options); return { url: 'http://127.0.0.1:2/#token=y' }; },
    openWindowImpl,
    startServerImpl: async () => { throw new Error('must not start a second server'); },
    log: quiet,
  });
  assert.equal(result, 'existing');
  assert.deepEqual(urls, ['http://127.0.0.1:2/#token=y']);
  assert.deepEqual(seen, [{ busyWaitMs: 0 }]);
});
