const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { installShortcut, macShortcutFiles, shellQuote } = require('../scripts/pult/shortcut');

test('shell quoting survives apostrophes, spaces and shell syntax', { skip: process.platform === 'win32' }, () => {
  for (const value of ["/tmp/o'neil/My Projects/AutoMontage", 'plain', "it's $HOME `x` \"q\""]) {
    const output = execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(value)}`], { encoding: 'utf8' });
    assert.equal(output, value);
  }
});

test('macOS app bundle launches the pult with the install-time environment', () => {
  const { appDir, files } = macShortcutFiles({
    root: '/r/AutoMontage',
    nodePath: '/n/node',
    homeDir: '/tmp/home-u',
    env: { PATH: '/opt/homebrew/bin:/usr/bin', AUTOMONTAGE_FFMPEG_DIR: '/ff' },
  });
  assert.equal(appDir, '/tmp/home-u/Applications/Пульт роликов.app');
  const script = files.find((file) => file.relative === 'Contents/MacOS/pult');
  assert.equal(script.mode, 0o755);
  assert.equal(
    script.content,
    "#!/bin/sh\nexport PATH='/opt/homebrew/bin:/usr/bin'\nexport AUTOMONTAGE_FFMPEG_DIR='/ff'\nexec '/n/node' '/r/AutoMontage/scripts/cli.js' pult\n",
  );
  const plist = files.find((file) => file.relative === 'Contents/Info.plist').content;
  assert.match(plist, /<key>CFBundleExecutable<\/key><string>pult<\/string>/);
  assert.match(plist, /io\.automontage\.pult/);
});

test('installing on macOS writes an app and refuses to replace a foreign one', { skip: process.platform === 'win32' }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const first = installShortcut({ platform: 'darwin', root: '/r/AutoMontage', nodePath: '/n/node', homeDir: home, env: { PATH: '/usr/bin' } });
  const script = path.join(first.location, 'Contents', 'MacOS', 'pult');
  assert.equal(fs.statSync(script).mode & 0o777, 0o755);
  assert.match(first.message, /Dock/);
  installShortcut({ platform: 'darwin', root: '/r/Other', nodePath: '/n/node', homeDir: home, env: {} });
  assert.match(fs.readFileSync(script, 'utf8'), /\/r\/Other/);
  fs.writeFileSync(path.join(first.location, 'Contents', 'Info.plist'), '<plist>other</plist>');
  assert.throws(
    () => installShortcut({ platform: 'darwin', root: '/r', nodePath: '/n', homeDir: home, env: {} }),
    /другая программа/,
  );
});

test('Windows shortcut passes paths through the environment, not the script', () => {
  let call;
  const result = installShortcut({
    platform: 'win32',
    root: 'C:\\Users\\u\\AutoMontage',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    env: { PATH: 'x' },
    execFileSyncImpl: (command, args, options) => {
      call = { command, args, options };
      return 'C:\\Users\\u\\Desktop\\Пульт роликов.lnk\r\n';
    },
  });
  assert.equal(call.command, 'powershell.exe');
  assert.equal(call.options.shell, false);
  assert.ok(!call.args.join(' ').includes('AutoMontage'));
  assert.equal(call.options.env.AUTOMONTAGE_SHORTCUT_NODE, 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(call.options.env.AUTOMONTAGE_SHORTCUT_ARGS, '"C:\\Users\\u\\AutoMontage\\scripts\\cli.js" pult');
  assert.equal(result.location, 'C:\\Users\\u\\Desktop\\Пульт роликов.lnk');
});

test('other systems get a clear message', () => {
  assert.throws(() => installShortcut({ platform: 'linux' }), /automontage pult/);
});
