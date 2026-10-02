const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const {
  heavyQueueConfig, tryAcquireHeavySlot, acquireHeavySlotSync,
  acquireHeavySlot, listHeavySlots, HEAVY_QUEUE_BUSY,
} = require('../scripts/heavy-queue');

function configFor(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-heavy-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { ...heavyQueueConfig({}), dir, ...overrides };
}

function hold(t, config, label = 'layer render demo') {
  const slot = tryAcquireHeavySlot({ label, config });
  assert.ok(slot);
  t.after(() => slot.release());
  return slot;
}

function writeDeadOwner(config, pid, index = 0) {
  const dir = path.join(config.dir, `slot-${index}`);
  fs.mkdirSync(dir, { recursive: true });
  const owner = {
    version: 1, token: randomUUID(), pid, hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, '.project-mutation.lock'), JSON.stringify(owner));
  fs.writeFileSync(path.join(dir, 'holder.json'), JSON.stringify({
    label: 'old render demo', pid, acquiredAt: owner.acquiredAt,
  }));
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid;
  assert.deepEqual(await once(child, 'exit'), [0, null]);
  return pid;
}

test('one slot excludes a second holder and idempotent release permits reuse', (t) => {
  const config = configFor(t);
  const first = hold(t, config);
  assert.equal(first.index, 0);
  assert.equal(first.waited, false);
  assert.equal(tryAcquireHeavySlot({ label: 'preview demo', config }), null);
  first.release();
  first.release();
  assert.equal(fs.existsSync(path.join(config.dir, 'slot-0', 'holder.json')), false);
  const next = hold(t, config, 'preview demo');
  first.release();
  assert.equal(listHeavySlots(config)[0].label, 'preview demo');
  assert.equal(next.index, 0);
});

test('two slots permit two holders and reject a third', (t) => {
  const config = configFor(t, { slots: 2 });
  assert.equal(hold(t, config).index, 0);
  assert.equal(hold(t, config).index, 1);
  assert.equal(tryAcquireHeavySlot({ label: 'third demo', config }), null);
});

test('a completed child owner is reclaimed through the project lease protocol', async (t) => {
  const config = configFor(t);
  writeDeadOwner(config, await deadPid());
  assert.equal(hold(t, config).index, 0);
  assert.equal(listHeavySlots(config)[0].label, 'layer render demo');
});

test('a live child process holds the slot until it exits', { timeout: 10_000 }, async (t) => {
  const config = configFor(t);
  const child = spawn(process.execPath, ['-e', `
    const { tryAcquireHeavySlot } = require(process.argv[1]);
    const slot = tryAcquireHeavySlot({ label: 'child render demo', config: JSON.parse(process.argv[2]) });
    process.send({ acquired: Boolean(slot) });
    process.on('message', () => process.exit(0));
  `, require.resolve('../scripts/heavy-queue'), JSON.stringify(config)], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  });
  const [ready] = await once(child, 'message');
  assert.equal(ready.acquired, true);
  assert.equal(tryAcquireHeavySlot({ label: 'parent render demo', config }), null);
  const exit = once(child, 'exit');
  child.send('exit');
  assert.deepEqual(await exit, [0, null]);
  assert.equal(hold(t, config).index, 0);
});

test('sync waiting logs the holder once and reports waited after acquiring', (t) => {
  const config = configFor(t);
  const first = hold(t, config);
  const logs = [];
  const sleeps = [];
  const slot = acquireHeavySlotSync({
    label: 'preview demo', config, log: (message) => logs.push(message),
    sleepSync: (ms) => { sleeps.push(ms); first.release(); },
  });
  t.after(() => slot.release());
  assert.equal(slot.waited, true);
  assert.deepEqual(sleeps, [5000]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /очередь тяжёлых задач занята.*layer render demo/);
});

test('zero wait fails immediately with the busy code and holder label', (t) => {
  const config = configFor(t, { waitMs: 0 });
  hold(t, config);
  assert.throws(() => acquireHeavySlotSync({ label: 'preview demo', config }), (error) => {
    assert.equal(error.code, HEAVY_QUEUE_BUSY);
    assert.match(error.message, /^машина занята: .*layer render demo/);
    return true;
  });
});

test('sync waiting times out on the third failed poll and logs an unchanged holder once', (t) => {
  const config = configFor(t, { waitMs: 10_000 });
  hold(t, config);
  let ticks = 0;
  let sleeps = 0;
  const logs = [];
  assert.throws(() => acquireHeavySlotSync({
    label: 'preview demo', config, now: () => { ticks += 6000; return ticks; },
    sleepSync: () => { sleeps += 1; }, log: (message) => logs.push(message),
  }), { code: HEAVY_QUEUE_BUSY });
  assert.equal(ticks, 18_000);
  assert.equal(sleeps, 2);
  assert.equal(logs.length, 1);
});

test('async waiting yields, observes a changed holder and acquires after release', async (t) => {
  const config = configFor(t);
  let holder = hold(t, config, 'first render demo');
  let sleeps = 0;
  const logs = [];
  const slot = await acquireHeavySlot({
    label: 'preview demo', config, log: (message) => logs.push(message),
    sleep: async (ms) => {
      assert.equal(ms, 5000);
      holder.release();
      sleeps += 1;
      if (sleeps === 1) holder = hold(t, config, 'second render demo');
    },
  });
  t.after(() => slot.release());
  assert.equal(slot.waited, true);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /first render demo/);
  assert.match(logs[1], /second render demo/);
});

test('async zero wait rejects with HEAVY_QUEUE_BUSY', async (t) => {
  const config = configFor(t, { waitMs: 0 });
  hold(t, config);
  await assert.rejects(acquireHeavySlot({ label: 'preview demo', config }), { code: HEAVY_QUEUE_BUSY });
});

test('the default sync sleep works on the main thread', (t) => {
  const config = configFor(t, { waitMs: 1, pollMs: 1 });
  hold(t, config);
  assert.throws(() => acquireHeavySlotSync({ label: 'preview demo', config, log: () => {} }), {
    code: HEAVY_QUEUE_BUSY,
  });
});

test('missing holder metadata does not weaken exclusion', (t) => {
  const config = configFor(t);
  const holderDir = path.join(config.dir, 'slot-0', 'holder.json');
  fs.mkdirSync(holderDir, { recursive: true });
  hold(t, config);
  assert.equal(tryAcquireHeavySlot({ label: 'preview demo', config }), null);
  assert.equal(listHeavySlots(config)[0].busy, true);
  assert.equal(listHeavySlots(config)[0].label, null);
});

test('lease failures other than contention propagate', (t) => {
  const config = configFor(t);
  const failure = new Error('clock failure');
  assert.throws(() => tryAcquireHeavySlot({
    label: 'preview demo', config, leaseOptions: { now: () => { throw failure; } },
  }), (error) => error === failure);
});

test('invalid lock data is listed conservatively as busy', (t) => {
  const config = configFor(t);
  const dir = path.join(config.dir, 'slot-0');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '.project-mutation.lock'), 'null');
  assert.equal(listHeavySlots(config)[0].busy, true);
  assert.equal(tryAcquireHeavySlot({ label: 'preview demo', config }), null);
});

test('listing shows live, dead and empty slots without acquiring them', async (t) => {
  const config = configFor(t, { slots: 3 });
  hold(t, config);
  writeDeadOwner(config, await deadPid(), 1);
  const slots = listHeavySlots(config);
  assert.equal(slots[1].busy, false);
  assert.deepEqual(slots[0], {
    index: 0, busy: true, label: 'layer render demo', pid: process.pid,
    acquiredAt: JSON.parse(fs.readFileSync(path.join(config.dir, 'slot-0', 'holder.json'))).acquiredAt,
  });
  assert.equal(slots[2].busy, false);
});

test('config defaults and explicit overrides are validated', () => {
  assert.deepEqual(heavyQueueConfig({}), {
    dir: path.join(os.tmpdir(), 'automontage-heavy'), slots: 1,
    waitMs: 3 * 3600_000, pollMs: 5000,
  });
  assert.deepEqual(heavyQueueConfig({
    AUTOMONTAGE_HEAVY_DIR: 'custom-queue', AUTOMONTAGE_HEAVY_SLOTS: '8', AUTOMONTAGE_HEAVY_WAIT_MS: '0',
  }), { dir: 'custom-queue', slots: 8, waitMs: 0, pollMs: 5000 });
  for (const value of ['9', '0', '-1', '1.5', '1x', '', 'Infinity']) {
    assert.throws(() => heavyQueueConfig({ AUTOMONTAGE_HEAVY_SLOTS: value }), /AUTOMONTAGE_HEAVY_SLOTS/);
  }
  for (const value of ['-1', '1.5', '1x', '', 'Infinity', '9007199254740992']) {
    assert.throws(() => heavyQueueConfig({ AUTOMONTAGE_HEAVY_WAIT_MS: value }), /AUTOMONTAGE_HEAVY_WAIT_MS/);
  }
});

test('preloaded test process has an isolated temporary queue', () => {
  assert.ok(process.env.AUTOMONTAGE_HEAVY_DIR.startsWith(path.join(os.tmpdir(), 'automontage-heavy-test-')));
  const child = spawnSync(process.execPath, [
    '--require', require.resolve('./helpers/heavy-queue-isolation.cjs'),
    '-e', 'process.stdout.write(process.env.AUTOMONTAGE_HEAVY_DIR)',
  ], { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8' } });
  assert.equal(child.status, 0, child.stderr);
  assert.notEqual(child.stdout, process.env.AUTOMONTAGE_HEAVY_DIR);
  assert.ok(child.stdout.startsWith(path.join(os.tmpdir(), 'automontage-heavy-test-')));
  assert.equal(fs.existsSync(child.stdout), false);
});

function queueStatus(config) {
  return spawnSync(process.execPath, [require.resolve('../scripts/cli'), 'queue'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AUTOMONTAGE_HEAVY_DIR: config.dir,
      AUTOMONTAGE_HEAVY_SLOTS: String(config.slots),
    },
  });
}

test('queue CLI reports a free queue and its directory without acquiring a slot', (t) => {
  const config = configFor(t);
  const result = queueStatus(config);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `Очередь тяжёлых задач: свободно (слотов: 1)\nПапка очереди: ${config.dir}\n`);
  assert.deepEqual(fs.readdirSync(config.dir), []);
});

test('queue CLI reports occupied slots with their label, pid and start time', (t) => {
  const config = configFor(t, { slots: 2 });
  hold(t, config, 'layer render demo/motion-v01');
  const holder = listHeavySlots(config)[0];
  const result = queueStatus(config);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('layer render demo/motion-v01'));
  assert.ok(result.stdout.includes(`pid: ${holder.pid}`));
  assert.ok(result.stdout.includes(`начало: ${holder.acquiredAt}`));
  assert.ok(result.stdout.includes(`Папка очереди: ${config.dir}`));
  assert.equal(listHeavySlots(config)[0].busy, true);
  assert.equal(fs.existsSync(path.join(config.dir, 'slot-1')), false);
});
