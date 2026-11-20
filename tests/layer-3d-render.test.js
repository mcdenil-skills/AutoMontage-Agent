const test = require('node:test');
const assert = require('node:assert/strict');

// Настоящий 3D-рендер (#150, опт-ин как остальные рендер-тесты): @remotion/three рисует куб через тот же
// WebGL-бэкенд, что layer render выбрал бы для 3D-слоя на этой машине (angle на Apple Silicon, иначе
// swangle). Кадр не пустой, и повторный рендер того же кадра совпадает байт в байт – сцена зависит
// только от номера кадра.
test('real Remotion still of a 3D scene is drawn and repeatable', {
  skip: process.env.AUTOMONTAGE_TEST_MOTION_RENDER !== '1', timeout: 300_000,
}, async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const { bundle } = require('@remotion/bundler');
  const { openBrowser, renderStill, selectComposition } = require('@remotion/renderer');
  const { layerGpuPlan } = require('../scripts/gpu');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-3d-render-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serveUrl = await bundle({ entryPoint: path.join(__dirname, 'fixtures', 'three-scene', 'index.jsx'), outDir: path.join(root, 'bundle') });
  const { gl } = layerGpuPlan({ webgl: true });
  const browser = await openBrowser('chrome', { logLevel: 'error', chromiumOptions: { gl } });
  t.after(() => browser.close({ silent: true }));
  const composition = await selectComposition({ serveUrl, id: 'Scene3d', puppeteerInstance: browser });

  const still = async (name) => {
    const output = path.join(root, `${name}.png`);
    await renderStill({ serveUrl, composition, frame: 12, output, puppeteerInstance: browser, chromiumOptions: { gl } });
    return output;
  };
  const first = await still('a');
  const second = await still('b');
  assert.ok(fs.readFileSync(first).equals(fs.readFileSync(second)), 'повторный рендер 3D-кадра отличается');

  // Доля ярких пикселей: фон #101418 тёмный (яркость ~20), куб оранжевый – без WebGL кадр остался бы фоном.
  const gray = execFileSync('ffmpeg', ['-v', 'error', '-i', first, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 16 * 1024 * 1024 });
  const bright = gray.reduce((count, value) => count + (value > 60 ? 1 : 0), 0);
  assert.ok(bright / gray.length > 0.05, `куба не видно: ярких пикселей ${(100 * bright / gray.length).toFixed(1)} %`);
});
