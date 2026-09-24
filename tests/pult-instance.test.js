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
