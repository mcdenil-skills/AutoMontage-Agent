const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  configureMediaToolPath,
  ffmpegEncoderAvailable,
  pythonCandidates,
  resolveRemotionCommand,
} = require('../scripts/env');

test('ffmpeg encoder detection requires the exact encoder name', () => {
  const encoders = [
    'Encoders:',
    ' V....D libwebp              libwebp WebP image',
    ' V....D libwebp_anim         libwebp WebP animation',
  ].join('\n');

  assert.equal(ffmpegEncoderAvailable(encoders, 'libwebp'), true);
  assert.equal(ffmpegEncoderAvailable(encoders, 'libwebp_anim'), true);
  assert.equal(ffmpegEncoderAvailable(encoders, 'webp'), false);
  assert.equal(ffmpegEncoderAvailable(' V....D libwebp_anim animated', 'libwebp'), false);
});

test('configured ffmpeg directory becomes the first production PATH entry', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-ffmpeg-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const command of ['ffmpeg', 'ffprobe']) {
    const executable = path.join(directory, command);
    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(executable, 0o755);
  }
  const env = { AUTOMONTAGE_FFMPEG_DIR: directory, PATH: '/usr/bin' };

  assert.equal(configureMediaToolPath(env, 'darwin'), directory);
  assert.deepEqual(env.PATH.split(path.delimiter), [directory, '/usr/bin']);
  assert.equal(configureMediaToolPath(env, 'darwin'), directory);
  assert.deepEqual(env.PATH.split(path.delimiter), [directory, '/usr/bin']);
});

test('Python candidates prefer the project virtual environment', () => {
  assert.deepEqual(
    pythonCandidates('/work/automontage', 'darwin'),
    ['/work/automontage/.venv/bin/python', 'python3', 'python'],
  );
  assert.deepEqual(
    pythonCandidates('C:\\work\\automontage', 'win32'),
    [
      path.join('C:\\work\\automontage', '.venv/Scripts/python.exe'),
      'python',
      'python3',
      'py',
    ],
  );
});

test('Remotion resolves the package bin and always runs it through Node', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageDir = path.join(root, 'node_modules/@remotion/cli');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name: '@remotion/cli',
    bin: { remotion: 'remotion-cli.js' },
  }));
  fs.writeFileSync(path.join(packageDir, 'remotion-cli.js'), '#!/usr/bin/env node\n');

  assert.deepEqual(resolveRemotionCommand(root), {
    command: process.execPath,
    argsPrefix: [
      fs.realpathSync(path.join(packageDir, 'remotion-cli.js')),
      `--env-file=${path.resolve(__dirname, '../config/remotion-public.env')}`,
    ],
  });
});

test('Remotion resolver fails instead of falling back to npx downloads', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => resolveRemotionCommand(root),
    /@remotion\/cli.*npm (ci|run doctor)/,
  );
});

for (const layout of ['hoisted', 'nested']) {
  test(`Remotion package resolver supports ${layout} npm installation and rejects foreign package identity`, t => {
    const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-installed-'));
    t.after(() => fs.rmSync(consumer, { recursive: true, force: true }));
    const root = path.join(consumer, 'node_modules/automontage-agent');
    fs.mkdirSync(root, { recursive: true });
    const packageDir = path.join(layout === 'hoisted' ? consumer : root, 'node_modules/@remotion/cli');
    fs.mkdirSync(packageDir, { recursive: true });
    const metadata = path.join(packageDir, 'package.json');
    fs.writeFileSync(metadata, JSON.stringify({ name: '@remotion/cli', bin: { remotion: 'run.js' } }));
    fs.writeFileSync(path.join(packageDir, 'run.js'), 'console.log("fixture");\n');
    assert.equal(resolveRemotionCommand(root).argsPrefix[0], fs.realpathSync(path.join(packageDir, 'run.js')));
    fs.writeFileSync(metadata, JSON.stringify({ name: 'foreign-package', bin: { remotion: 'run.js' } }));
    assert.throws(() => resolveRemotionCommand(root), /identity|имя пакета/i);
  });
}

test('Remotion package bin cannot escape its package through a symbolic link', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-bin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageDir = path.join(root, 'node_modules/@remotion/cli');
  fs.mkdirSync(packageDir, { recursive: true });
  const outside = path.join(root, 'outside.js'); fs.writeFileSync(outside, 'throw new Error("do not run");\n');
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@remotion/cli', bin: 'run.js' }));
  fs.symlinkSync(outside, path.join(packageDir, 'run.js'), 'file');
  assert.throws(() => resolveRemotionCommand(root), /bin.remotion.*недоступен|escape/i);
});
