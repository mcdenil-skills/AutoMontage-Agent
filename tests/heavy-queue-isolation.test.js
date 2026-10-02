const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('Playwright root replaces configured production queue and children inherit isolation', (t) => {
  const production = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-production-sentinel-'));
  t.after(() => fs.rmSync(production, { recursive: true, force: true }));
  fs.writeFileSync(path.join(production, 'sentinel'), 'unchanged');
  const env = { ...process.env, AUTOMONTAGE_HEAVY_DIR: production };
  delete env.NODE_TEST_CONTEXT;
  delete env.TEST_WORKER_INDEX;
  env.AUTOMONTAGE_PLAYWRIGHT_QUEUE_ROOT = 'stale-root';
  const result = spawnSync(process.execPath, ['-e', `
    require(${JSON.stringify(require.resolve('../playwright.config'))});
    const root = process.env.AUTOMONTAGE_HEAVY_DIR;
    const child = require('node:child_process').spawnSync(process.execPath, ['-e',
      'require(' + JSON.stringify(${JSON.stringify(require.resolve('../playwright.config'))}) + '); process.stdout.write(process.env.AUTOMONTAGE_HEAVY_DIR)'
    ], { encoding: 'utf8', env: { ...process.env, TEST_WORKER_INDEX: '0' } });
    process.stdout.write(JSON.stringify({ root, child: child.stdout }));
  `], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const { root, child } = JSON.parse(result.stdout);
  assert.notEqual(root, production);
  assert.equal(child, root);
  assert.equal(fs.existsSync(root), false);
  assert.deepEqual(fs.readdirSync(production), ['sentinel']);
  assert.equal(fs.readFileSync(path.join(production, 'sentinel'), 'utf8'), 'unchanged');
});
