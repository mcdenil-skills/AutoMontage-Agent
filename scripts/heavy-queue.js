const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acquireProjectMutationLease } = require('./project/workspace');

const { executionBusy, wasReleased, registerExecutionSlot } = require('./heavy-execution');

const HEAVY_QUEUE_BUSY = 'HEAVY_QUEUE_BUSY';
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function integerSetting(env, name, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  if (env[name] === undefined) return fallback;
  const raw = String(env[name]);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name}: требуется целое число от ${min} до ${max}`);
  }
  return value;
}

function heavyQueueConfig(env = process.env) {
  return {
    dir: env.AUTOMONTAGE_HEAVY_DIR || path.join(os.tmpdir(), 'automontage-heavy'),
    slots: integerSetting(env, 'AUTOMONTAGE_HEAVY_SLOTS', 1, 1, 8),
    waitMs: integerSetting(env, 'AUTOMONTAGE_HEAVY_WAIT_MS', 3 * 3600_000, 0),
    pollMs: 5000,
  };
}

function tryAcquireHeavySlot({ label, config = heavyQueueConfig(), leaseOptions = {} }) {
  for (let index = 0; index < config.slots; index += 1) {
    const slotDir = path.join(config.dir, `slot-${index}`);
    fs.mkdirSync(slotDir, { recursive: true });
    let lease;
    try {
      lease = acquireProjectMutationLease(slotDir, {
        ...leaseOptions,
        killProcess(pid, signal) {
          const owner = readJson(path.join(slotDir, '.project-mutation.lock'));
          if (owner && owner.pid === pid) {
            if (executionBusy(slotDir, owner)) return;
            if (wasReleased(slotDir, owner)) throw Object.assign(new Error('released'), { code: 'ESRCH' });
          }
          return (leaseOptions.killProcess || process.kill)(pid, signal);
        },
      });
    } catch (error) {
      if (error && error.code === 'PROJECT_MANIFEST_CONFLICT') continue;
      throw error;
    }
    const holderPath = path.join(slotDir, 'holder.json');
    try {
      fs.writeFileSync(holderPath, `${JSON.stringify({
        label, pid: lease.owner.pid, acquiredAt: lease.owner.acquiredAt,
      })}\n`);
    } catch (_) {
      // Metadata is advisory; the project mutation lease provides exclusion.
    }
    const execution = registerExecutionSlot(slotDir, lease.owner);
    let released = false;
    return {
      index,
      waited: false,
      release() {
        if (released) return;
        execution.stop();
        if (executionBusy(slotDir, lease.owner)) {
          // Keep the atomic lease until the owned group ends, even if this process
          // remains alive. The token-scoped release marker permits later recovery.
          execution.deferRelease();
          released = true;
          return;
        }
        try {
          fs.unlinkSync(holderPath);
        } catch (_) {
          // A missing or unwritable description must not keep the slot occupied.
        }
        lease.release();
        released = true;
      },
    };
  }
  return null;
}

function readJson(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return { invalid: true };
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : { invalid: true };
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return { invalid: true };
  }
}

function ownerIsDead(owner) {
  // Match the lease protocol's conservative recovery rule: only ESRCH proves death.
  if (owner.version !== 1 || owner.hostname !== os.hostname()
    || !Number.isInteger(owner.pid) || owner.pid <= 0
    || typeof owner.token !== 'string' || !/^[A-Za-z0-9_-]+$/.test(owner.token)) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return Boolean(error && error.code === 'ESRCH');
  }
}

function listHeavySlots(config = heavyQueueConfig()) {
  return Array.from({ length: config.slots }, (_, index) => {
    const empty = { index, busy: false, label: null, pid: null, acquiredAt: null };
    const slotDir = path.join(config.dir, `slot-${index}`);
    const owner = readJson(path.join(slotDir, '.project-mutation.lock'));
    if (!owner || ((ownerIsDead(owner) || wasReleased(slotDir, owner))
      && !executionBusy(slotDir, owner))) return empty;
    const holder = readJson(path.join(slotDir, 'holder.json'));
    const matchingHolder = holder && holder.pid === owner.pid && holder.acquiredAt === owner.acquiredAt;
    return {
      index,
      busy: true,
      label: matchingHolder && typeof holder.label === 'string' ? holder.label : null,
      pid: Number.isInteger(owner.pid) ? owner.pid : null,
      acquiredAt: typeof owner.acquiredAt === 'string' ? owner.acquiredAt : null,
    };
  });
}

function waitState(config, log, now) {
  let startedAt;
  let lastHolder;
  return () => {
    const holders = listHeavySlots(config).filter((slot) => slot.busy);
    const description = holders.map((slot) => slot.label || 'другая тяжёлая задача').join(', ')
      || 'другая тяжёлая задача';
    const currentTime = now();
    if (startedAt === undefined) startedAt = currentTime;
    if (config.waitMs === 0 || currentTime - startedAt >= config.waitMs) {
      const error = new Error(`машина занята: ${description}`);
      error.code = HEAVY_QUEUE_BUSY;
      throw error;
    }
    const signature = JSON.stringify(holders);
    if (signature !== lastHolder) {
      log(`очередь тяжёлых задач занята: ${description}; ожидаю свободный слот`);
      lastHolder = signature;
    }
  };
}

function acquireHeavySlotSync({
  label, config = heavyQueueConfig(), log = console.log,
  sleepSync = (ms) => Atomics.wait(sleepBuffer, 0, 0, ms), now = Date.now,
}) {
  const wait = waitState(config, log, now);
  let waited = false;
  while (true) {
    const slot = tryAcquireHeavySlot({ label, config });
    if (slot) return { ...slot, waited };
    wait();
    waited = true;
    sleepSync(config.pollMs);
  }
}

async function acquireHeavySlot({
  label, config = heavyQueueConfig(), log = console.log,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now,
}) {
  const wait = waitState(config, log, now);
  let waited = false;
  while (true) {
    const slot = tryAcquireHeavySlot({ label, config });
    if (slot) return { ...slot, waited };
    wait();
    waited = true;
    await sleep(config.pollMs);
  }
}

module.exports = {
  heavyQueueConfig, tryAcquireHeavySlot, acquireHeavySlotSync,
  acquireHeavySlot, listHeavySlots, HEAVY_QUEUE_BUSY,
};
