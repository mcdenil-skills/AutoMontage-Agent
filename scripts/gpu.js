// Режим GPU для layer render (D-052). Headless Chrome без флага --gl рисует
// программно (SwiftShader); на Apple Silicon --gl=angle (Metal) считает слой
// примерно вдвое быстрее при SSIM >= 0.99. Здесь только решение, без запуска.
// 3D-слой (#150, D-053: @remotion/three) без WebGL не рисуется вовсе: ему нужен --gl всегда – angle на
// Apple Silicon (запасная попытка – swangle), в остальных случаях программный swangle (SwiftShader).

const fs = require('node:fs');
const path = require('node:path');

const GPU_ENV = 'AUTOMONTAGE_GPU';
const SOFT_3D_REASON = '3D-слой: WebGL программно (swangle, SwiftShader)';
// Кэш видео-кадров Remotion для слоя: 2 ГиБ.
const LAYER_OFFTHREAD_CACHE_BYTES = 2 * 1024 ** 3;

function gpuMode(env = process.env) {
  const raw = env[GPU_ENV];
  const value = raw === undefined ? '' : String(raw).trim().toLowerCase();
  if (value === '' || value === 'auto') return 'auto';
  if (value === 'off') return 'off';
  throw new Error(`${GPU_ENV}: допустимы значения auto|off`);
}

function layerGpuPlan({ env = process.env, platform = process.platform, arch = process.arch, webgl = false } = {}) {
  const mode = gpuMode(env);
  if (webgl) {
    if (mode === 'auto' && platform === 'darwin' && arch === 'arm64') {
      return { gl: 'angle', fallbackGl: 'swangle', reason: 'Apple Silicon: 3D-слой рисует ANGLE (Metal), запасная попытка – swangle' };
    }
    const why = mode === 'off' ? `выключено ${GPU_ENV}=off` : 'GPU на этой платформе не проверен (#93)';
    return { gl: 'swangle', fallbackGl: null, reason: `${SOFT_3D_REASON}; ${why}` };
  }
  if (mode === 'off') {
    return { gl: null, fallbackGl: null, reason: `выключено ${GPU_ENV}=off` };
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return { gl: 'angle', fallbackGl: null, reason: 'Apple Silicon: Chrome рисует через ANGLE (Metal)' };
  }
  return { gl: null, fallbackGl: null, reason: 'ускорение на этой платформе не проверено (#93)' };
}

// Импорт 3D-пакетов в коде слоя: @remotion/three, three (и его подпути), @react-three/*.
const WEBGL_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](?:@remotion\/three|three|@react-three\/[\w.-]+)(?:\/[^'"]*)?['"]/;
// Часы, которые ломают покадровый рендер 3D: R3F useFrame идёт от реального времени, а не от кадра.
const CLOCK_TOKENS = ['useFrame', 'Math.random', 'Date.now', 'performance.now', 'requestAnimationFrame'];
const SOURCE_EXT = /\.(?:[cm]?js|jsx|tsx?)$/;
const SCAN_LIMITS = { files: 400, bytes: 2 * 1024 * 1024, depth: 8 };

function stripLineComment(line) {
  const at = line.indexOf('//');
  return at === -1 ? line : line.slice(0, at);
}

// Сканирует src слоя без исполнения: есть ли 3D и где стоят часы реального времени. Ссылки и
// node_modules не читаются, размер и глубина ограничены – чужой код слоя не может увести сканер наружу.
function scanLayerWebgl(srcDir, fsImpl = fs) {
  const result = { webgl: false, clockHooks: [] };
  const hits = [];
  let files = 0;
  const walk = (dir, rel, depth) => {
    if (depth > SCAN_LIMITS.depth || files >= SCAN_LIMITS.files) return;
    let entries;
    try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      const relName = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(full, relName, depth + 1); continue; }
      if (!entry.isFile() || !SOURCE_EXT.test(entry.name) || files >= SCAN_LIMITS.files) continue;
      files += 1;
      const stat = fsImpl.statSync(full);
      if (stat.size > SCAN_LIMITS.bytes) continue;
      fsImpl.readFileSync(full, 'utf8').split('\n').forEach((raw, index) => {
        const line = stripLineComment(raw);
        if (WEBGL_IMPORT.test(line)) result.webgl = true;
        for (const token of CLOCK_TOKENS) {
          const pattern = new RegExp(`\\b${token.replace('.', '\\.')}\\s*\\(`);
          if (pattern.test(line)) hits.push({ file: relName, line: index + 1, token });
        }
      });
    }
  };
  if (fsImpl.lstatSync(srcDir, { throwIfNoEntry: false })?.isDirectory()) walk(srcDir, '', 0);
  if (result.webgl) result.clockHooks = hits;
  return result;
}

// Строка для doctor: какой режим выберет layer render и почему. Не бросает.
// Живую пробу браузера не делаем: `remotion gpu` в Remotion 4.0.536 падает
// на chrome://gpu (net::ERR_FAILED), поэтому судим по платформе и env.
function describeLayerGpu({ env = process.env, platform = process.platform, arch = process.arch } = {}) {
  let plan;
  try {
    plan = layerGpuPlan({ env, platform, arch });
  } catch (err) {
    return { level: 'warn', message: `Рендер слоя: ${err.message}; layer render не запустится – исправь значение (auto|off) или убери переменную` };
  }
  const plan3d = layerGpuPlan({ env, platform, arch, webgl: true });
  const tail = `; 3D-слои: ${plan3d.gl}`;
  if (plan.gl) return { level: 'ok', message: `Рендер слоя: GPU (${plan.gl}) – ${plan.reason}${tail}` };
  return { level: 'ok', message: `Рендер слоя: CPU – ${plan.reason}${tail}` };
}

module.exports = { GPU_ENV, LAYER_OFFTHREAD_CACHE_BYTES, gpuMode, layerGpuPlan, scanLayerWebgl, describeLayerGpu };
