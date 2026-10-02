// The detached supervisor is the POSIX process-group leader. Its descendants inherit
// the group, including tools whose immediate parent exits before they do.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { recordGroup } = require('./heavy-execution');
const [serialized, command, ...args] = process.argv.slice(2);
const { tickets, contexts, capture, deadline, maxBuffer, terminationGraceMs = 100 } = JSON.parse(serialized);
recordGroup(tickets, process.pid);
const env = {
  ...process.env,
  AUTOMONTAGE_EXECUTION_CONTEXT: JSON.stringify(contexts),
  NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${JSON.stringify(require.resolve('./heavy-child-preload'))}`,
};
let forwarding = false;
let child;
let escalation;
let fallback;
let timer;
function recordError(error) {
  for (const file of tickets) {
    const ticket = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...ticket, launchError: { code: error.code, message: error.message } }));
  }
}
function forceStop() {
  // This process is the still-live group leader: never sweep historical PGIDs
  // or another invocation which happens to share the lease token.
  if (process.platform !== 'win32') process.kill(-process.pid, 'SIGKILL');
  else {
    child?.kill('SIGKILL');
    fallback = setTimeout(() => process.exit(1), 100);
  }
}
function terminate(signal) {
  if (signal === 'SIGKILL') { forceStop(); return; }
  if (forwarding) return;
  forwarding = true;
  if (process.platform !== 'win32') process.kill(-process.pid, signal);
  else child?.kill(signal);
  escalation = setTimeout(forceStop, terminationGraceMs);
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => terminate(signal));
}
if (process.connected) {
  process.on('message', (message) => {
    if (message?.type === 'terminate-owned-tool' && ['SIGTERM', 'SIGKILL'].includes(message.signal)) {
      terminate(message.signal);
    }
  });
}
child = spawn(command, args, { stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit', shell: false, env });
if (capture) {
  let bytes = 0;
  for (const [source, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    source.on('data', (chunk) => {
      bytes += chunk.length;
      if (maxBuffer && bytes > maxBuffer) {
        recordError({ code: 'ENOBUFS', message: `spawnSync ${command} ENOBUFS (maxBuffer exceeded)` });
        forceStop();
        return;
      }
      if (!destination.write(chunk)) source.pause();
    });
    destination.on('drain', () => source.resume());
  }
}
if (deadline !== null) {
  timer = setTimeout(() => {
    recordError({ code: 'ETIMEDOUT', message: `spawnSync ${command} ETIMEDOUT` });
    forceStop();
  }, Math.max(0, deadline - Date.now()));
}
child.on('error', (error) => {
  recordError(error);
  process.stderr.write(`${command}: ${error.message}\n`);
  process.exitCode = 127;
});
child.on('close', (code, signal) => {
  clearTimeout(timer);
  clearTimeout(escalation);
  clearTimeout(fallback);
  if (process.connected) process.disconnect();
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else process.exitCode = code ?? 127;
});
