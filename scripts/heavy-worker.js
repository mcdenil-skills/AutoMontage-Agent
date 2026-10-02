// The detached supervisor is the POSIX process-group leader. Its descendants inherit
// the group, including tools whose immediate parent exits before they do.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { recordGroup } = require('./heavy-execution');
const [serialized, command, ...args] = process.argv.slice(2);
const { tickets, contexts } = JSON.parse(serialized);
recordGroup(tickets, process.pid);
const env = {
  ...process.env,
  AUTOMONTAGE_EXECUTION_CONTEXT: JSON.stringify(contexts),
  NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${JSON.stringify(require.resolve('./heavy-child-preload'))}`,
};
let forwarding = false;
let child;
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    if (forwarding) return;
    forwarding = true;
    if (process.platform !== 'win32') process.kill(-process.pid, signal);
    else child?.kill(signal);
    // Stay alive until the direct child closes. Recovery also checks the group,
    // so surviving descendants remain protected after this supervisor exits.
  });
}
child = spawn(command, args, { stdio: 'inherit', shell: false, env });
child.on('error', (error) => {
  for (const file of tickets) {
    const ticket = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...ticket, launchError: { code: error.code, message: error.message } }));
  }
  process.stderr.write(`${command}: ${error.message}\n`);
  process.exitCode = 127;
});
child.on('close', (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else process.exitCode = code ?? 127;
});
