const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');

const {
  findRunningInstance,
  instancePath,
  instanceUrl,
  probeHealth,
  readInstance,
  removeInstance,
  writeInstance,
} = require('../scripts/pult/instance');
const { startPultServer } = require('../scripts/pult/server');
const { makePultRoot } = require('./helpers/pult-projects');

const TOKEN = 'a'.repeat(43);

test('instance file round-trips with private permissions', (t) => {
  const { projectsDir } = makePultRoot(t);
  writeInstance(projectsDir, { pid: 123, port: 4100, token: TOKEN });
  const value = readInstance(projectsDir);
  assert.equal(value.port, 4100);
  assert.equal(instanceUrl(value), `http://127.0.0.1:4100/#token=${TOKEN}`);
  if (process.platform !== 'win32') assert.equal(fs.statSync(instancePath(projectsDir)).mode & 0o777, 0o600);
});

test('malformed instance files are ignored', (t) => {
  const { projectsDir } = makePultRoot(t);
  fs.mkdirSync(`${projectsDir}/.pult`, { recursive: true });
  for (const value of [
    { version: 1, pid: 'x', port: 4100, token: TOKEN },
    { version: 1, pid: 1, port: 70000, token: TOKEN },
    { version: 1, pid: 1, port: 4100, token: 'short' },
    { version: 2, pid: 1, port: 4100, token: TOKEN },
  ]) {
    fs.writeFileSync(instancePath(projectsDir), JSON.stringify(value));
    assert.equal(readInstance(projectsDir), null, JSON.stringify(value));
  }
});

test('a live healthy instance is found, a dead one is cleaned up', async (t) => {
  const { projectsDir } = makePultRoot(t);
  writeInstance(projectsDir, { pid: 1, port: 4100, token: TOKEN });
  const found = await findRunningInstance(projectsDir, { isAlive: () => true, probe: async () => true });
  assert.equal(found.url, `http://127.0.0.1:4100/#token=${TOKEN}`);
  assert.equal(await findRunningInstance(projectsDir, { isAlive: () => false, probe: async () => true }), null);
  assert.equal(fs.existsSync(instancePath(projectsDir)), false);
});

test('removeInstance keeps a file owned by another process', (t) => {
  const { projectsDir } = makePultRoot(t);
  writeInstance(projectsDir, { pid: 5, port: 4100, token: TOKEN });
  assert.equal(removeInstance(projectsDir, 6), false);
  assert.ok(fs.existsSync(instancePath(projectsDir)));
  assert.equal(removeInstance(projectsDir, 5), true);
  assert.equal(fs.existsSync(instancePath(projectsDir)), false);
});

test('health probe recognizes only the pult', async (t) => {
  const { projectsDir } = makePultRoot(t);
  const session = await startPultServer({ projectsDir, idleMs: 0 });
  t.after(() => session.close());
  assert.equal(await probeHealth(session.server.address().port), true);
  const other = http.createServer((incoming, outgoing) => {
    outgoing.setHeader('content-type', 'application/json');
    outgoing.end('{"app":"other"}');
  });
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
  t.after(() => other.close());
  assert.equal(await probeHealth(other.address().port), false);
});

// Сборка обложек через ffprobe/ffmpeg держит пульт занятым до ~15 с: один неответивший
// /api/health не должен считаться смертью процесса и удалять его регистрацию.
test('a busy pult survives an unresponsive health check without losing its registration', async (t) => {
  const { projectsDir } = makePultRoot(t);
  writeInstance(projectsDir, { pid: 1, port: 4100, token: TOKEN });
  const probeCalls = [];
  const result = await findRunningInstance(projectsDir, {
    isAlive: () => true,
    probe: async () => {
      probeCalls.push(1);
      return false;
    },
    busyWaitMs: 1000,
    retryMs: 500,
    sleep: async () => {}, // подменяем ожидание — тест не должен реально ждать секунду
  });
  assert.equal(result, null);
  assert.equal(probeCalls.length, 3);
  assert.ok(fs.existsSync(instancePath(projectsDir)));
  assert.equal(readInstance(projectsDir).pid, 1);
});

test('a pult that answers again during the busy wait is found', async (t) => {
  const { projectsDir } = makePultRoot(t);
  writeInstance(projectsDir, { pid: 1, port: 4100, token: TOKEN });
  let calls = 0;
  const result = await findRunningInstance(projectsDir, {
    isAlive: () => true,
    probe: async () => {
      calls += 1;
      return calls >= 3;
    },
    busyWaitMs: 1000,
    retryMs: 500,
    sleep: async () => {},
  });
  assert.equal(calls, 3);
  assert.equal(result.url, `http://127.0.0.1:4100/#token=${TOKEN}`);
});

test('a dead pid never deletes a registration rewritten by another process meanwhile', async (t) => {
  const { projectsDir } = makePultRoot(t);
  writeInstance(projectsDir, { pid: 5, port: 4100, token: TOKEN });
  const isAlive = (pid) => {
    assert.equal(pid, 5);
    // Пока мы решали, жив ли старый процесс, новый экземпляр уже переписал файл —
    // findRunningInstance обязан снимать регистрацию через владельческую проверку,
    // а не сырым rmSync по пути.
    writeInstance(projectsDir, { pid: 9, port: 4200, token: TOKEN });
    return false;
  };
  const result = await findRunningInstance(projectsDir, { isAlive, probe: async () => true });
  assert.equal(result, null);
  const current = readInstance(projectsDir);
  assert.equal(current.pid, 9);
  assert.equal(current.port, 4200);
});

test('probeHealth stops reading an oversized body from a foreign service on the port', async (t) => {
  const bigBody = JSON.stringify({ app: 'automontage-pult', padding: 'x'.repeat(200 * 1024) });
  const server = http.createServer((incoming, outgoing) => {
    outgoing.setHeader('content-type', 'application/json');
    outgoing.end(bigBody);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const started = Date.now();
  assert.equal(await probeHealth(server.address().port, { timeoutMs: 5000 }), false);
  assert.ok(Date.now() - started < 2000, 'не должен ждать таймаут, чтобы понять, что тело слишком большое');
});
