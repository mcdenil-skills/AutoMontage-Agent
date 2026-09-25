const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  captureTool,
  hostPath,
  runNodeTool,
  runTool,
} = require('../scripts/process');

test('hostile paths stay one literal argv and cannot execute a sentinel', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'argv security '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const probe = path.join(root, 'argv-probe.js');
  const sentinel = path.join(root, 'sentinel');
  fs.writeFileSync(probe, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n');
  const hostile = [
    '-leading.mp4',
    'path with spaces.mp4',
    "single'quote.mp4",
    'double"quote.mp4',
    `$(touch ${sentinel})`,
    `clip;touch ${sentinel}`,
    'line\nbreak.mp4',
    'Юникод-🎬.mp4',
  ];

  const stdout = captureTool(process.execPath, [probe, ...hostile], {
    stage: 'hostile argv probe',
    maxBuffer: 64 * 1024,
  });

  assert.deepEqual(JSON.parse(stdout), hostile);
  assert.equal(fs.existsSync(sentinel), false);
  assert.equal(path.isAbsolute(hostPath('-leading.mp4', root)), true);
});

test('runner reports ENOENT with the doctor recovery command', () => {
  assert.throws(
    () => runTool('automontage-tool-that-does-not-exist', [], { stage: 'render' }),
    /render.*не найден.*npm run doctor/,
  );
});

test('runner rejects non-zero status and terminating signals', () => {
  assert.throws(
    () => captureTool(process.execPath, ['-e', 'process.exit(7)'], {
      stage: 'probe',
      maxBuffer: 1024,
    }),
    /probe.*status 7/,
  );

  assert.throws(
    () => runTool('ffmpeg', [], {
      stage: 'render',
      spawnSyncImpl: () => ({ status: null, signal: 'SIGTERM', error: null }),
    }),
    /render.*SIGTERM/,
  );
});

test('long-running helpers inherit stdio and Node scripts use process.execPath', () => {
  let call;
  runNodeTool('/tmp/tool.js', ['input.mp4'], {
    stage: 'render',
    spawnSyncImpl: (command, args, options) => {
      call = { command, args, options };
      return { status: 0, signal: null, error: null };
    },
  });

  assert.equal(call.command, process.execPath);
  assert.deepEqual(call.args, ['/tmp/tool.js', 'input.mp4']);
  assert.equal(call.options.stdio, 'inherit');
  assert.equal(call.options.shell, false);
});

test('captured commands require an explicit positive maxBuffer', () => {
  assert.throws(
    () => captureTool(process.execPath, ['--version'], { stage: 'probe' }),
    /maxBuffer/,
  );
});

test('an explicit timeout is forwarded to spawnSync with SIGKILL, and is absent otherwise', () => {
  let withTimeout;
  captureTool(process.execPath, ['--version'], {
    stage: 'probe',
    maxBuffer: 1024,
    timeout: 5000,
    spawnSyncImpl: (command, args, options) => {
      withTimeout = options;
      return { status: 0, signal: null, error: null, stdout: '', stderr: '' };
    },
  });
  assert.equal(withTimeout.timeout, 5000);
  assert.equal(withTimeout.killSignal, 'SIGKILL');

  let withoutTimeout;
  captureTool(process.execPath, ['--version'], {
    stage: 'probe',
    maxBuffer: 1024,
    spawnSyncImpl: (command, args, options) => {
      withoutTimeout = options;
      return { status: 0, signal: null, error: null, stdout: '', stderr: '' };
    },
  });
  assert.equal('timeout' in withoutTimeout, false);
  assert.equal('killSignal' in withoutTimeout, false);
});

test('an invalid timeout is rejected before spawning anything', () => {
  assert.throws(
    () => captureTool(process.execPath, ['--version'], {
      stage: 'probe',
      maxBuffer: 1024,
      timeout: -1,
      spawnSyncImpl: () => { throw new Error('must not spawn'); },
    }),
    /probe.*timeout должен быть положительным целым/,
  );
  assert.throws(
    () => captureTool(process.execPath, ['--version'], {
      stage: 'probe',
      maxBuffer: 1024,
      timeout: 1.5,
      spawnSyncImpl: () => { throw new Error('must not spawn'); },
    }),
    /probe.*timeout должен быть положительным целым/,
  );
});

// Свой timeout у spawnSync убивает дочерний процесс и сообщает об этом через
// result.error/result.signal – assertProcessResult обязан превратить это в обычную
// ошибку, а не в тихое зависание.
test('a timed-out spawnSync result surfaces as a thrown error', () => {
  assert.throws(
    () => captureTool(process.execPath, ['--version'], {
      stage: 'probe',
      maxBuffer: 1024,
      timeout: 50,
      spawnSyncImpl: () => {
        const error = new Error('spawnSync /bin/x ETIMEDOUT');
        error.code = 'ETIMEDOUT';
        return { status: null, signal: 'SIGKILL', error, stdout: null, stderr: null };
      },
    }),
    /probe.*не запустился/,
  );
});
