const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { appWindowCommand, openPultWindow, revealCommand } = require('../scripts/pult/launcher');

const URL_ = 'http://127.0.0.1:4100/#token=abc';
const only = (paths) => (candidate) => paths.includes(candidate);

test('macOS prefers Chrome in app mode, then Edge, then the default browser', () => {
  assert.deepEqual(
    appWindowCommand(URL_, { platform: 'darwin', homeDir: '/tmp/home-u', exists: only(['/Applications/Google Chrome.app']) }),
    { command: 'open', args: ['-na', '/Applications/Google Chrome.app', '--args', `--app=${URL_}`], appMode: true },
  );
  assert.equal(
    appWindowCommand(URL_, { platform: 'darwin', homeDir: '/tmp/home-u', exists: only(['/tmp/home-u/Applications/Microsoft Edge.app']) }).args[1],
    '/tmp/home-u/Applications/Microsoft Edge.app',
  );
  assert.deepEqual(
    appWindowCommand(URL_, { platform: 'darwin', homeDir: '/tmp/home-u', exists: () => false }),
    { command: 'open', args: [URL_], appMode: false },
  );
});

test('Windows uses Edge in app mode and falls back to the default browser', () => {
  const env = {
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    ProgramFiles: 'C:\\Program Files',
    LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  };
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  assert.deepEqual(
    appWindowCommand(URL_, { platform: 'win32', env, exists: only([edge]) }),
    { command: edge, args: [`--app=${URL_}`], appMode: true },
  );
  assert.deepEqual(
    appWindowCommand(URL_, { platform: 'win32', env, exists: () => false }),
    { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', URL_], appMode: false },
  );
});

test('reveal commands select the file in the file manager', () => {
  assert.deepEqual(revealCommand('/p/final.mp4', { platform: 'darwin' }), { command: 'open', args: ['-R', '/p/final.mp4'] });
  assert.deepEqual(revealCommand('/p', { platform: 'darwin', isDirectory: true }), { command: 'open', args: ['/p'] });
  assert.deepEqual(
    revealCommand('C:\\p\\final.mp4', { platform: 'win32' }),
    { command: 'explorer.exe', args: ['/select,', 'C:\\p\\final.mp4'] },
  );
  assert.deepEqual(revealCommand('/p/final.mp4', { platform: 'linux' }), { command: 'xdg-open', args: ['/p'] });
});

test('launches are detached and never use a shell', async () => {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const call = { command, args, options, unref: false };
    calls.push(call);
    const child = new EventEmitter();
    child.unref = () => { call.unref = true; };
    setImmediate(() => child.emit('spawn'));
    return child;
  };
  await openPultWindow(URL_, { platform: 'darwin', homeDir: '/tmp/home-u', exists: () => false, spawnImpl });
  assert.equal(calls[0].command, 'open');
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].unref, true);
});
