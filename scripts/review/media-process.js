const { spawn } = require('node:child_process');

const DEFAULT_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;

function processError(code, message, properties = {}) {
  return Object.assign(new Error(message), { code, ...properties });
}

function runMediaProcess({
  command,
  args,
  cwd,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxStdoutBytes = DEFAULT_OUTPUT_BYTES,
  maxStderrBytes = DEFAULT_OUTPUT_BYTES,
  stdin = null,
  stdoutEncoding = 'utf8',
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
  spawnImpl = spawn,
}) {
  return new Promise((resolve, reject) => {
    let child;
    let invocation;
    try {
      if (!(stdin === null || Buffer.isBuffer(stdin))
        || ![null, 'utf8'].includes(stdoutEncoding)) {
        throw processError('MEDIA_PROCESS_INPUT_INVALID', `invalid ${command} process input`);
      }
      const spawnOptions = {
        cwd,
        shell: false,
        stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      };
      invocation = spawnImpl === spawn
        ? require('../heavy-execution').managedInvocation(command, args, spawnOptions, {
          controlChannel: true, terminationGraceMs: Number.isFinite(terminationGraceMs) && terminationGraceMs >= 0
            ? terminationGraceMs : DEFAULT_TERMINATION_GRACE_MS,
        })
        : { command, args, options: spawnOptions };
      child = spawnImpl(invocation.command, invocation.args, invocation.options);
    } catch (error) {
      reject(processError('MEDIA_PROCESS_SPAWN', `cannot start ${command}`, { cause: error }));
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let pendingError = null;
    let terminationSent = false;
    let escalationTimer = null;
    let pipeDeadline = null;
    let settled = false;
    const sendTermination = (signal) => {
      try {
        if (invocation.terminate) invocation.terminate(child, signal);
        else child.kill(signal);
      } catch (_) {
        // Signal failures never clear execution tickets or cancel the pipe bound.
      }
    };

    const terminate = (error) => {
      if (!pendingError) pendingError = error;
      if (!terminationSent) {
        terminationSent = true;
        sendTermination('SIGTERM');
        const grace = Number.isFinite(terminationGraceMs) && terminationGraceMs >= 0
          ? terminationGraceMs
          : DEFAULT_TERMINATION_GRACE_MS;
        escalationTimer = setTimeout(() => sendTermination('SIGKILL'), grace);
        if (invocation.terminate) {
          pipeDeadline = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.stdin?.destroy();
            if (child.connected) child.disconnect();
            child.unref();
            finish(null, null);
          }, grace + 250);
        }
        escalationTimer.unref?.();
      }
    };
    const collect = (chunks, limit, streamName) => (chunk) => {
      const bytes = Buffer.from(chunk);
      const current = streamName === 'stdout' ? stdoutBytes : stderrBytes;
      const next = current + bytes.length;
      if (streamName === 'stdout') stdoutBytes = next;
      else stderrBytes = next;
      if (next > limit) {
        terminate(processError('MEDIA_PROCESS_OUTPUT_LIMIT', `${command} ${streamName} exceeded limit`));
        return;
      }
      chunks.push(bytes);
    };
    child.stdout?.on('data', collect(stdoutChunks, maxStdoutBytes, 'stdout'));
    child.stderr?.on('data', collect(stderrChunks, maxStderrBytes, 'stderr'));
    if (stdin !== null) {
      child.stdin?.on('error', (error) => terminate(processError(
        'MEDIA_PROCESS_STDIN', `${command} stdin failed`, { cause: error },
      )));
      child.stdin?.end(stdin);
    }

    const onAbort = () => terminate(processError('MEDIA_PROCESS_ABORTED', `${command} aborted`));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    const timer = Number.isFinite(timeoutMs) && timeoutMs >= 0
      ? setTimeout(() => terminate(processError('MEDIA_PROCESS_TIMEOUT', `${command} timed out`)), timeoutMs)
      : null;
    timer?.unref?.();

    child.on('error', (error) => {
      if (!pendingError) {
        pendingError = processError('MEDIA_PROCESS_SPAWN', `cannot start ${command}`, { cause: error });
      }
    });
    const finish = (code, closeSignal) => {
      if (settled) return;
      settled = true;
      const launchError = invocation.launchError?.();
      if (!pendingError && launchError) {
        pendingError = processError('MEDIA_PROCESS_SPAWN', `cannot start ${command}`, { cause: launchError });
      }
      try { invocation.complete?.(!pendingError && code === 0 && !closeSignal); } catch (error) {
        if (!pendingError) pendingError = processError('MEDIA_PROCESS_COMPLETION', `cannot record ${command} completion`, { cause: error });
      }
      if (timer) clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (pipeDeadline) clearTimeout(pipeDeadline);
      signal?.removeEventListener('abort', onAbort);
      const stdoutBuffer = Buffer.concat(stdoutChunks);
      const stdout = stdoutEncoding === null ? stdoutBuffer : stdoutBuffer.toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (pendingError) {
        pendingError.stdout = stdout;
        pendingError.stderr = stderr;
        reject(pendingError);
        return;
      }
      if (code !== 0) {
        reject(processError('MEDIA_PROCESS_EXIT', `${command} exited with code ${code}`, {
          exitCode: code,
          processSignal: closeSignal,
          stdout,
          stderr,
        }));
        return;
      }
      resolve({ stdout, stderr, code, signal: closeSignal });
    };
    child.once('close', finish);
  });
}

module.exports = { runMediaProcess };
