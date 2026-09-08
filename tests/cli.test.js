const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const cli = path.resolve(__dirname, '../scripts/cli.js');
test('public CLI advertises motion and routes it ahead of legacy build', () => {
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.match(help.stdout, /automontage motion/);
  const motion = spawnSync(process.execPath, [cli, 'motion', '--help'], { encoding: 'utf8' });
  assert.equal(motion.status, 0, motion.stderr);
  assert.match(motion.stdout, /motion.*audio|motion.*narration/s);
  assert.doesNotMatch(motion.stderr, /ENOENT|build\.js/);
});
