// Кросс-платформенные помощники (Windows / macOS / Linux).
// Убирает жёсткие /tmp и python3 – движок ставится и работает на любой ОС.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// Временная папка ОС (/tmp на Unix, %TEMP% на Windows) + путь под наш файл.
const TMPDIR = os.tmpdir();
function tmp(name) {
  return path.join(TMPDIR, name);
}

function ffmpegEncoderAvailable(output, encoder) {
  if (typeof output !== 'string' || typeof encoder !== 'string' || !encoder) return false;
  const escaped = encoder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*[A-Z.]{6}\\s+${escaped}(?:\\s|$)`, 'm').test(output);
}

// Позволяет выбрать отдельную полную сборку ffmpeg без замены системного бинарника.
// Публичный CLI применяет каталог до запуска Review/build, дочерние процессы наследуют PATH.
function configureMediaToolPath(env = process.env, platform = process.platform) {
  const configured = env.AUTOMONTAGE_FFMPEG_DIR;
  if (configured == null || configured === '') return null;
  const directory = path.resolve(configured);
  const suffix = platform === 'win32' ? '.exe' : '';
  for (const command of ['ffmpeg', 'ffprobe']) {
    const executable = path.join(directory, `${command}${suffix}`);
    try {
      fs.accessSync(executable, fs.constants.X_OK);
      if (!fs.statSync(executable).isFile()) throw new Error('not a file');
    } catch (_) {
      throw new Error(`AUTOMONTAGE_FFMPEG_DIR: ${command}${suffix} не найден в указанной папке`);
    }
  }
  const entries = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  env.PATH = [directory, ...entries.filter((entry) => path.resolve(entry) !== directory)]
    .join(path.delimiter);
  return directory;
}

// Автоопределение интерпретатора Python 3.
// Windows: обычно `python`. macOS/Linux: обычно `python3`. Берём тот, что реально Python 3.
let _py = null;
function pythonCandidates(root = ROOT, platform = process.platform) {
  const localPython = platform === 'win32'
    ? path.join(root, '.venv', 'Scripts', 'python.exe')
    : path.join(root, '.venv', 'bin', 'python');
  return platform === 'win32'
    ? [localPython, 'python', 'python3', 'py']
    : [localPython, 'python3', 'python'];
}

function python() {
  if (_py) return _py;
  const candidates = pythonCandidates();
  for (const cmd of candidates) {
    try {
      const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      if (r.status === 0 && /Python 3\./.test(out)) { _py = cmd; return _py; }
    } catch (_) { /* пробуем следующий */ }
  }
  throw new Error('Python 3 не найден. Установи Python 3 и добавь его в PATH '
    + '(Windows: python.org или "winget install Python.Python.3"; macOS: "brew install python").');
}

// Запуск локального Remotion CLI кросс-платформенно, без shell, .cmd и npx downloads.
// Читаем package.bin и всегда запускаем JavaScript entrypoint текущим Node.
function resolveRemotionCommand(root = ROOT) {
  let packageFile;
  try {
    packageFile = require.resolve('@remotion/cli/package.json', { paths: [path.resolve(root)] });
  } catch (_) {
    throw new Error('@remotion/cli не найден; запусти npm ci, затем npm run doctor');
  }

  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  } catch (_) {
    throw new Error('@remotion/cli package.json повреждён; повтори npm ci и npm run doctor');
  }
  if (metadata.name !== '@remotion/cli') throw new Error('@remotion/cli: неверное имя пакета (package identity)');
  const relativeBin = typeof metadata.bin === 'string'
    ? metadata.bin
    : metadata.bin?.remotion;
  if (typeof relativeBin !== 'string' || relativeBin.length === 0) {
    throw new Error('@remotion/cli не объявляет bin.remotion; повтори npm ci и npm run doctor');
  }
  const packageDir = path.dirname(packageFile);
  const entry = path.resolve(packageDir, relativeBin);
  const relative = path.relative(packageDir, entry);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(entry)) {
    throw new Error('@remotion/cli bin.remotion недоступен; повтори npm ci и npm run doctor');
  }
  const realRelative = path.relative(fs.realpathSync(packageDir), fs.realpathSync(entry));
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative) || !fs.statSync(entry).isFile()) {
    throw new Error('@remotion/cli bin.remotion недоступен; package bin escapes its package');
  }
  // Remotion exposes every key from its auto-discovered .env/.env.local to the
  // browser. Always select the packaged empty file instead. Its CLI parser
  // accepts this option before the subcommand; all render/still callers inherit
  // the protection, while public REMOTION_* process variables still work.
  return {
    command: process.execPath,
    argsPrefix: [entry, `--env-file=${path.join(ROOT, 'config', 'remotion-public.env')}`],
  };
}

function remotionBin() {
  const resolved = resolveRemotionCommand();
  return resolved.argsPrefix.length
    ? [resolved.command, ...resolved.argsPrefix].join(' ')
    : `"${resolved.command}"`;
}

module.exports = {
  ROOT,
  TMPDIR,
  configureMediaToolPath,
  ffmpegEncoderAvailable,
  tmp,
  python,
  pythonCandidates,
  remotionBin,
  resolveRemotionCommand,
};
