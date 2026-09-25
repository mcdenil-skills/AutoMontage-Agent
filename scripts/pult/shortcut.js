const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SHORTCUT_NAME = 'Пульт роликов';
const BUNDLE_ID = 'io.automontage.pult';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Приложение из Dock не видит PATH терминала: без сохранённого PATH пульт не найдёт ffmpeg.
function macShortcutFiles({ root, nodePath, homeDir, env = process.env }) {
  const appDir = path.posix.join(homeDir, 'Applications', `${SHORTCUT_NAME}.app`);
  const lines = ['#!/bin/sh'];
  if (env.PATH) lines.push(`export PATH=${shellQuote(env.PATH)}`);
  if (env.AUTOMONTAGE_FFMPEG_DIR) lines.push(`export AUTOMONTAGE_FFMPEG_DIR=${shellQuote(env.AUTOMONTAGE_FFMPEG_DIR)}`);
  // `brew upgrade node` меняет версионный путь в Cellar — записанный nodePath может исчезнуть.
  // Тогда ищем node на сохранённом PATH, чтобы значок не переставал работать молча.
  lines.push(`NODE=${shellQuote(nodePath)}`);
  lines.push('[ -x "$NODE" ] || NODE="$(command -v node)"');
  lines.push(`exec "$NODE" ${shellQuote(path.posix.join(root, 'scripts', 'cli.js'))} pult`);
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>CFBundleExecutable</key><string>pult</string>',
    `  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>`,
    `  <key>CFBundleName</key><string>${xmlEscape(SHORTCUT_NAME)}</string>`,
    `  <key>CFBundleDisplayName</key><string>${xmlEscape(SHORTCUT_NAME)}</string>`,
    '  <key>CFBundlePackageType</key><string>APPL</string>',
    '  <key>CFBundleShortVersionString</key><string>1.0</string>',
    '  <key>LSUIElement</key><true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
  return {
    appDir,
    files: [
      { relative: 'Contents/Info.plist', content: plist, mode: 0o644 },
      { relative: 'Contents/MacOS/pult', content: `${lines.join('\n')}\n`, mode: 0o755 },
    ],
  };
}

// Значения передаются через переменные окружения: в тексте PowerShell-скрипта нет путей,
// поэтому кавычки и спецсимволы в пути не могут изменить команду.
const WINDOWS_SCRIPT = [
  // PowerShell 5.1 в русской локали пишет перенаправленный stdout не в UTF-8 —
  // без этого путь к «Пульт роликов.lnk» вернётся кракозябрами.
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$OutputEncoding = [System.Text.Encoding]::UTF8',
  "$ErrorActionPreference = 'Stop'",
  "$desktop = [Environment]::GetFolderPath('Desktop')",
  "$link = Join-Path $desktop ($env:AUTOMONTAGE_SHORTCUT_NAME + '.lnk')",
  '$shell = New-Object -ComObject WScript.Shell',
  '$shortcut = $shell.CreateShortcut($link)',
  '$shortcut.TargetPath = $env:AUTOMONTAGE_SHORTCUT_NODE',
  '$shortcut.Arguments = $env:AUTOMONTAGE_SHORTCUT_ARGS',
  '$shortcut.WorkingDirectory = $env:AUTOMONTAGE_SHORTCUT_ROOT',
  '$shortcut.WindowStyle = 7',
  '$shortcut.Save()',
  'Write-Output $link',
].join('; ');

function windowsShortcutCommand({ root, nodePath, env = process.env }) {
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT],
    env: {
      ...env,
      AUTOMONTAGE_SHORTCUT_NAME: SHORTCUT_NAME,
      AUTOMONTAGE_SHORTCUT_NODE: nodePath,
      AUTOMONTAGE_SHORTCUT_ARGS: `"${path.win32.join(root, 'scripts', 'cli.js')}" pult`,
      AUTOMONTAGE_SHORTCUT_ROOT: root,
    },
  };
}

function installShortcut({
  platform = process.platform,
  root = path.resolve(__dirname, '../..'),
  nodePath = process.execPath,
  homeDir = os.homedir(),
  env = process.env,
  fileSystem = fs,
  execFileSyncImpl = execFileSync,
} = {}) {
  if (platform === 'darwin') {
    const { appDir, files } = macShortcutFiles({ root, nodePath, homeDir, env });
    if (fileSystem.existsSync(appDir)) {
      let existing = '';
      try {
        existing = fileSystem.readFileSync(path.join(appDir, 'Contents', 'Info.plist'), 'utf8');
      } catch (_) {
        existing = '';
      }
      if (!existing.includes(BUNDLE_ID)) {
        throw new Error(`${appDir}: там уже другая программа — переименуйте или удалите её вручную`);
      }
      fileSystem.rmSync(appDir, { recursive: true, force: true });
    }
    for (const file of files) {
      const target = path.join(appDir, ...file.relative.split('/'));
      fileSystem.mkdirSync(path.dirname(target), { recursive: true });
      fileSystem.writeFileSync(target, file.content, { mode: file.mode });
      fileSystem.chmodSync(target, file.mode);
    }
    return {
      location: appDir,
      message: `Значок создан: ${appDir}\nОткройте папку «Программы» в домашней папке и перетащите значок в Dock.`,
    };
  }
  if (platform === 'win32') {
    const command = windowsShortcutCommand({ root, nodePath, env });
    const output = execFileSyncImpl(command.command, command.args, {
      env: command.env,
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
    });
    const location = String(output).trim().split(/\r?\n/).at(-1);
    return { location, message: `Значок создан на рабочем столе: ${location}` };
  }
  throw new Error('Значок для этой системы пока не поддерживается. Запускайте: automontage pult');
}

module.exports = {
  BUNDLE_ID,
  SHORTCUT_NAME,
  installShortcut,
  macShortcutFiles,
  shellQuote,
  windowsShortcutCommand,
};
