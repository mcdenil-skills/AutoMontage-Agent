const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Playwright loads config in workers too. Only the root owns creation/cleanup;
// workers and their children inherit the same directory, never the caller's queue.
if (process.env.TEST_WORKER_INDEX === undefined || !process.env.AUTOMONTAGE_PLAYWRIGHT_QUEUE_ROOT) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-heavy-test-'));
  process.env.AUTOMONTAGE_PLAYWRIGHT_QUEUE_ROOT = String(process.pid);
  process.env.AUTOMONTAGE_HEAVY_DIR = dir;
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
}
