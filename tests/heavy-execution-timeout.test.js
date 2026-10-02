const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tryAcquireHeavySlot, heavyQueueConfig } = require('../scripts/heavy-queue');
const { captureTool, runTool } = require('../scripts/process');
const { runMediaProcess } = require('../scripts/review/media-process');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
async function until(predicate) {
  const end = Date.now() + 6000;
  while (!predicate()) {
    assert.ok(Date.now() < end, 'owned helper did not settle');
    await pause(20);
  }
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-timeout-'));
  const config = { ...heavyQueueConfig({}), dir };
  const slot = tryAcquireHeavySlot({ label: 'timeout surrogate', config });
  const markers = [];
  function helper(name, { output = false } = {}) {
    const marker = path.join(dir, `${name}.pid`);
    const stop = path.join(dir, `${name}.stop`);
    markers.push({ marker, stop });
    const code = `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {});
      fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
      ${output ? `process.${output === 'stderr' ? 'stderr' : 'stdout'}.write('x'.repeat(65536));` : ''}
      setInterval(() => { if (fs.existsSync(${JSON.stringify(stop)})) process.exit(0); }, 20);
      setTimeout(() => process.exit(0), 3000);
    `;
    return { marker, stop, code, pid: () => Number(fs.readFileSync(marker, 'utf8')) };
  }
  t.after(async () => {
    for (const { stop } of markers) fs.writeFileSync(stop, 'stop');
    for (const { marker } of markers) {
      if (fs.existsSync(marker)) await until(() => !alive(Number(fs.readFileSync(marker, 'utf8'))));
    }
    slot.release();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { config, slot, helper };
}

for (const mode of ['timeout', 'abort', 'output', 'stderr']) {
  test(`managed async ${mode} bounds noncooperative tool shutdown`, { timeout: 10_000 }, async (t) => {
    const { helper } = fixture(t);
    const worker = helper('worker', { output: mode === 'stderr' ? 'stderr' : mode === 'output' });
    const controller = new AbortController();
    const start = Date.now();
    const running = runMediaProcess({ command: process.execPath, args: ['-e', worker.code],
      timeoutMs: mode === 'timeout' ? 400 : 6000, terminationGraceMs: 100,
      signal: controller.signal, maxStdoutBytes: mode === 'output' ? 16 : 65536,
      maxStderrBytes: mode === 'stderr' ? 16 : 65536 });
    const rejected = assert.rejects(running, { code: {
      timeout: 'MEDIA_PROCESS_TIMEOUT', abort: 'MEDIA_PROCESS_ABORTED', output: 'MEDIA_PROCESS_OUTPUT_LIMIT',
      stderr: 'MEDIA_PROCESS_OUTPUT_LIMIT',
    }[mode] });
    await until(() => fs.existsSync(worker.marker));
    if (mode === 'abort') controller.abort();
    await rejected;
    const elapsed = Date.now() - start;
    t.diagnostic(`${mode}: ${elapsed} ms (natural exit: 3000 ms)`);
    assert.ok(elapsed < 1800, `managed ${mode} waited ${elapsed} ms for natural exit`);
    await until(() => !alive(worker.pid()));
  });
}

for (const capture of [true, false]) {
  test(`managed sync ${capture ? 'capture' : 'runTool'} timeout terminates actual tool`, {
    skip: process.platform === 'win32', timeout: 10_000,
  }, async (t) => {
    const { helper } = fixture(t);
    const worker = helper('worker');
    const start = Date.now();
    assert.throws(() => (capture ? captureTool : runTool)(process.execPath, ['-e', worker.code], {
      timeout: 400, maxBuffer: 65536,
    }), /не запустился/);
    const elapsed = Date.now() - start;
    t.diagnostic(`sync ${capture ? 'capture' : 'runTool'}: ${elapsed} ms`);
    assert.ok(elapsed < 1800);
    assert.ok(fs.existsSync(worker.marker));
    await pause(100);
    assert.equal(alive(worker.pid()), false, 'sync timeout must reach the real tool');
  });
}

test('one managed timeout preserves a sibling invocation sharing the slot', {
  skip: process.platform === 'win32', timeout: 10_000,
}, async (t) => {
  const { helper } = fixture(t);
  const sibling = helper('sibling');
  const siblingRun = runMediaProcess({ command: process.execPath, args: ['-e', sibling.code], timeoutMs: 6000 });
  const victim = helper('victim');
  await assert.rejects(runMediaProcess({ command: process.execPath, args: ['-e', victim.code],
    timeoutMs: 400, terminationGraceMs: 100 }), { code: 'MEDIA_PROCESS_TIMEOUT' });
  assert.ok(alive(sibling.pid()), 'timeout must not sweep all groups sharing a lease');
  fs.writeFileSync(sibling.stop, 'stop');
  await siblingRun;
});

test('detached pipe holder cannot delay rejection and retains queue until it ends', {
  skip: process.platform === 'win32', timeout: 10_000,
}, async (t) => {
  const { helper, slot, config } = fixture(t);
  const worker = helper('detached');
  const start = Date.now();
  await assert.rejects(runMediaProcess({ command: process.execPath, args: ['-e', `
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(worker.code)}], {
      detached: true, stdio: 'inherit'
    }).unref();
  `], timeoutMs: 400, terminationGraceMs: 100 }), { code: 'MEDIA_PROCESS_TIMEOUT' });
  const elapsed = Date.now() - start;
  t.diagnostic(`detached pipe holder: ${elapsed} ms`);
  assert.ok(elapsed < 1800, 'inherited pipes must not bypass the deadline');
  assert.ok(alive(worker.pid()));
  slot.release();
  assert.equal(tryAcquireHeavySlot({ label: 'must wait', config }), null);
  fs.writeFileSync(worker.stop, 'stop');
  let next;
  await until(() => {
    next = tryAcquireHeavySlot({ label: 'after descendant', config });
    return Boolean(next);
  });
  next.release();
});


test('managed sync capture output cap terminates the real writer', {
  skip: process.platform === 'win32', timeout: 10_000,
}, async (t) => {
  const { helper } = fixture(t);
  const worker = helper('writer', { output: true });
  const start = Date.now();
  assert.throws(() => captureTool(process.execPath, ['-e', worker.code], { maxBuffer: 16 }), /maxBuffer/);
  t.diagnostic(`sync output cap: ${Date.now() - start} ms`);
  assert.ok(Date.now() - start < 1800);
  await pause(100);
  assert.equal(alive(worker.pid()), false);
});
