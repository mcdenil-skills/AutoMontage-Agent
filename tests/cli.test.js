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
  assert.match(motion.stdout, /--script.*--voice elevenlabs.*--accept-provider-cost/);
  assert.match(motion.stdout, /separate paid API/);
  assert.doesNotMatch(motion.stderr, /ENOENT|build\.js/);
});

test('public CLI advertises multi-take commands and routes takes to its own script', () => {
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.match(help.stdout, /automontage takes add --project-dir/);
  assert.match(help.stdout, /automontage takes pack --project-dir/);
  assert.match(help.stdout, /edit\/v02-takes\.json/);
  const usage = spawnSync(process.execPath, [cli, 'takes'], { encoding: 'utf8' });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage: automontage takes add\|pack/);
  assert.doesNotMatch(usage.stderr, /build\.js|ENOENT/);
  const takesHelp = spawnSync(process.execPath, [cli, 'takes', '--help'], { encoding: 'utf8' });
  assert.equal(takesHelp.status, 0, takesHelp.stderr);
  assert.match(takesHelp.stdout, /usage: automontage takes add\|pack/);
});
