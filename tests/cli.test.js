const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { runForwardingSignals, SIGNAL_FORWARDING } = require('../scripts/cli');
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

test('public CLI advertises the rough cut and routes roughcut to its own script', () => {
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.match(help.stdout, /automontage roughcut --project-dir/);
  assert.match(help.stdout, /automontage roughcut confirm/);
  const usage = spawnSync(process.execPath, [cli, 'roughcut'], { encoding: 'utf8' });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage: automontage roughcut --project-dir/);
  assert.doesNotMatch(usage.stderr, /build\.js|ENOENT/);
  const roughCutHelp = spawnSync(process.execPath, [cli, 'roughcut', '--help'], { encoding: 'utf8' });
  assert.equal(roughCutHelp.status, 0, roughCutHelp.stderr);
  assert.match(roughCutHelp.stdout, /automontage roughcut confirm --project-dir/);
});

// Step 0 задачи 33: на Windows у Node нет настоящих POSIX-сигналов – child.kill(signal) там делает
// TerminateProcess, то есть убивает ребёнка мимо его собственной уборки (например, layer new удаляет
// недостроенную папку по SIGINT). Консольное событие и так доходит до ребёнка напрямую через общую
// консольную группу, поэтому на win32 внешний процесс не должен слать сигнал сам – только дождаться
// и передать дальше настоящий код выхода ребёнка.
test('runForwardingSignals never force-kills the child on win32; on other platforms it forwards the signal; either way the child\'s real exit code passes through, and a bare kill-by-signal exit falls back to the table', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    for (const signal of Object.keys(SIGNAL_FORWARDING.layer.signalExitCodes)) {
      // 1) Код возврата ребёнка – целое число вне таблицы (2 нет ни у SIGINT:130, ни у SIGTERM:143,
      // ни у SIGHUP:129): мутант, который вместо реального code просто возвращает signalExitCodes[signal],
      // здесь не совпадёт со 143/130/129 случайно, как совпал бы при коде 143 и сигнале SIGTERM.
      {
        const killed = [];
        const child = new EventEmitter();
        child.kill = (s) => killed.push(s);
        const processLike = new EventEmitter();
        let exitCode = null;
        processLike.exit = (code) => { exitCode = code; };

        runForwardingSignals(SIGNAL_FORWARDING.layer, ['check', '--project-dir', 'p'], { platform, spawnImpl: () => child, processLike });
        assert.equal(processLike.listenerCount(signal), 1, `${platform}/${signal} before`);

        processLike.emit(signal);
        assert.deepEqual(killed, platform === 'win32' ? [] : [signal], `${platform}/${signal} kill`);

        child.emit('exit', 2);
        assert.equal(exitCode, 2, `${platform}/${signal} real code passthrough`);
        for (const other of Object.keys(SIGNAL_FORWARDING.layer.signalExitCodes)) {
          assert.equal(processLike.listenerCount(other), 0, `${platform}/${signal} listener ${other} removed after exit`);
        }
      }
      // 2) Ребёнка убило самим сигналом без явного кода (code=null, signal='SIGTERM', как отдаёт Node,
      // когда сигнал дошёл до процесса без собственного обработчика) – код берём из таблицы signalExitCodes.
      {
        const child = new EventEmitter();
        child.kill = () => {};
        const processLike = new EventEmitter();
        let exitCode = null;
        processLike.exit = (code) => { exitCode = code; };

        runForwardingSignals(SIGNAL_FORWARDING.layer, ['check', '--project-dir', 'p'], { platform, spawnImpl: () => child, processLike });
        processLike.emit(signal);
        child.emit('exit', null, 'SIGTERM');
        assert.equal(exitCode, SIGNAL_FORWARDING.layer.signalExitCodes[signal], `${platform}/${signal} table fallback`);
        for (const other of Object.keys(SIGNAL_FORWARDING.layer.signalExitCodes)) {
          assert.equal(processLike.listenerCount(other), 0, `${platform}/${signal} listener ${other} removed after signal-only exit`);
        }
      }
    }
  }
});
