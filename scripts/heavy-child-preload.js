// Remotion deliberately starts Chromium in a new process group. Preserve its exact
// spawn contract while registering that new group before it can escape the outer one.
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const { createTickets, recordGroup } = require('./heavy-execution');
const contexts = JSON.parse(process.env.AUTOMONTAGE_EXECUTION_CONTEXT || '[]');
for (const method of ['spawn', 'spawnSync']) {
  const original = childProcess[method];
  childProcess[method] = function managedDetached(command, args, options) {
    const opts = Array.isArray(args) ? options : args;
    if (!opts?.detached || !contexts.length) return original.apply(this, arguments);
    const tickets = createTickets(contexts);
    const result = original.apply(this, arguments);
    if (result.pid) recordGroup(tickets, result.pid);
    // A throw/no PID leaves a pending ticket. Never infer completion from an
    // unacknowledged launch; this includes parent death immediately after spawn.
    return result;
  };
}
syncBuiltinESMExports();
