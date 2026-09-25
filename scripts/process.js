const path = require('node:path');
const { spawnSync } = require('node:child_process');

function hostPath(value, cwd = process.cwd()) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('host path должен быть непустой строкой');
  }
  return path.resolve(cwd, value);
}

function assertInvocation(command, args, stage) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error(`${stage}: executable не задан`);
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new Error(`${stage}: каждый argv должен быть строкой`);
  }
}

function assertProcessResult(result, { command, stage }) {
  const tool = path.basename(command);
  const fail = (message) => {
    const error = new Error(message);
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    error.status = result.status;
    error.signal = result.signal;
    throw error;
  };
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      fail(`${stage}: ${tool} не найден; запусти npm run doctor`);
    }
    fail(`${stage}: ${tool} не запустился (${result.error.message})`);
  }
  if (result.signal) {
    fail(`${stage}: ${tool} завершён сигналом ${result.signal}`);
  }
  if (result.status !== 0) {
    fail(`${stage}: ${tool} завершился со status ${String(result.status)}`);
  }
  return result;
}

function invoke(command, args, options, stdioOptions) {
  const {
    stage = 'process',
    spawnSyncImpl = spawnSync,
    cwd,
    env,
    timeout,
  } = options;
  assertInvocation(command, args, stage);
  if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout <= 0)) {
    throw new Error(`${stage}: timeout должен быть положительным целым`);
  }
  // Зависший ffprobe/ffmpeg (например файл ещё копируется по сети) не должен вешать
  // однопоточный сервер пульта навечно – timeout настраивается только по явному
  // запросу вызывающего кода, старые вызовы без него ведут себя как прежде.
  const timeoutOptions = timeout === undefined ? {} : { timeout, killSignal: 'SIGKILL' };
  const result = spawnSyncImpl(command, args, {
    cwd,
    env,
    shell: false,
    ...timeoutOptions,
    ...stdioOptions,
  });
  return assertProcessResult(result, { command, stage });
}

function runTool(command, args, options = {}) {
  return invoke(command, args, options, { stdio: 'inherit' });
}

function runNodeTool(script, args, options = {}) {
  return runTool(process.execPath, [script, ...args], options);
}

function captureToolResult(command, args, options = {}) {
  if (!Number.isSafeInteger(options.maxBuffer) || options.maxBuffer <= 0) {
    throw new Error(`${options.stage || 'process'}: capture требует явный положительный maxBuffer`);
  }
  return invoke(command, args, options, {
    encoding: 'utf8',
    maxBuffer: options.maxBuffer,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function captureTool(command, args, options = {}) {
  const result = captureToolResult(command, args, options);
  return result.stdout || '';
}

module.exports = {
  assertProcessResult,
  captureTool,
  captureToolResult,
  hostPath,
  runNodeTool,
  runTool,
};
