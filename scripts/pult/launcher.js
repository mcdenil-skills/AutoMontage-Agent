const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAC_APPS = ['Google Chrome.app', 'Microsoft Edge.app', 'Chromium.app'];
const LINUX_BROWSERS = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];

// Окно без адресной строки: Chrome/Edge в режиме приложения. Нет браузера — обычная вкладка.
function appWindowCommand(url, {
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
  exists = fs.existsSync,
} = {}) {
  const appArgument = `--app=${url}`;
  if (platform === 'darwin') {
    for (const base of ['/Applications', path.posix.join(homeDir, 'Applications')]) {
      for (const app of MAC_APPS) {
        const appPath = path.posix.join(base, app);
        if (exists(appPath)) return { command: 'open', args: ['-na', appPath, '--args', appArgument], appMode: true };
      }
    }
    return { command: 'open', args: [url], appMode: false };
  }
  if (platform === 'win32') {
    const candidates = [
      env['ProgramFiles(x86)'] && path.win32.join(env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      env.ProgramFiles && path.win32.join(env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      env.ProgramFiles && path.win32.join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ].filter(Boolean);
    const found = candidates.find((candidate) => exists(candidate));
    if (found) return { command: found, args: [appArgument], appMode: true };
    return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url], appMode: false };
  }
  const browser = LINUX_BROWSERS.find((candidate) => exists(candidate));
  if (browser) return { command: browser, args: [appArgument], appMode: true };
  return { command: 'xdg-open', args: [url], appMode: false };
}

function revealCommand(targetPath, { platform = process.platform, isDirectory = false } = {}) {
  if (platform === 'darwin') return { command: 'open', args: isDirectory ? [targetPath] : ['-R', targetPath] };
  if (platform === 'win32') return { command: 'explorer.exe', args: isDirectory ? [targetPath] : ['/select,', targetPath] };
  return { command: 'xdg-open', args: [isDirectory ? targetPath : path.posix.dirname(targetPath)] };
}

function launchDetached(command, args, { spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function openPultWindow(url, options = {}) {
  const { command, args } = appWindowCommand(url, options);
  await launchDetached(command, args, options);
}

async function revealInFileManager(targetPath, options = {}) {
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(targetPath).isDirectory();
  } catch (_) {
    isDirectory = false;
  }
  const { command, args } = revealCommand(targetPath, { ...options, isDirectory });
  await launchDetached(command, args, options);
}

module.exports = { appWindowCommand, launchDetached, openPultWindow, revealCommand, revealInFileManager };
