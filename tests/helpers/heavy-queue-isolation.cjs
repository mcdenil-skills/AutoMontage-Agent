const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The preload also runs in the test runner parent. Each test file needs its own queue.
if (process.env.NODE_TEST_CONTEXT || !process.env.AUTOMONTAGE_HEAVY_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-heavy-test-'));
  process.env.AUTOMONTAGE_HEAVY_DIR = dir;
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
}
