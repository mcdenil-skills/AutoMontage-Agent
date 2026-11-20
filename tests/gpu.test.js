const test = require('node:test');
const assert = require('node:assert/strict');
const { gpuMode, layerGpuPlan, describeLayerGpu, LAYER_OFFTHREAD_CACHE_BYTES } = require('../scripts/gpu');

test('gpuMode: пусто и auto – auto, off в любом регистре – off', () => {
  assert.equal(gpuMode({}), 'auto');
  assert.equal(gpuMode({ AUTOMONTAGE_GPU: '' }), 'auto');
  assert.equal(gpuMode({ AUTOMONTAGE_GPU: ' Auto ' }), 'auto');
  assert.equal(gpuMode({ AUTOMONTAGE_GPU: 'OFF' }), 'off');
});

test('gpuMode: неизвестное значение – ошибка с именем переменной', () => {
  for (const value of ['gpu', 'on', '1', 'angle', 'off;rm']) {
    assert.throws(() => gpuMode({ AUTOMONTAGE_GPU: value }), /AUTOMONTAGE_GPU.*auto\|off/);
  }
});

test('layerGpuPlan: angle только на darwin arm64 в режиме auto', () => {
  assert.equal(layerGpuPlan({ env: {}, platform: 'darwin', arch: 'arm64' }).gl, 'angle');
  assert.equal(layerGpuPlan({ env: { AUTOMONTAGE_GPU: 'off' }, platform: 'darwin', arch: 'arm64' }).gl, null);
  for (const [platform, arch] of [['darwin', 'x64'], ['linux', 'x64'], ['linux', 'arm64'], ['win32', 'x64']]) {
    const plan = layerGpuPlan({ env: {}, platform, arch });
    assert.equal(plan.gl, null);
    assert.match(plan.reason, /не проверено/);
  }
  assert.match(layerGpuPlan({ env: { AUTOMONTAGE_GPU: 'off' }, platform: 'darwin', arch: 'arm64' }).reason, /AUTOMONTAGE_GPU=off/);
});

test('LAYER_OFFTHREAD_CACHE_BYTES – 2 ГиБ', () => assert.equal(LAYER_OFFTHREAD_CACHE_BYTES, 2 * 1024 ** 3));

test('describeLayerGpu: текст для doctor по платформам и режимам', () => {
  const mac = describeLayerGpu({ env: {}, platform: 'darwin', arch: 'arm64' });
  assert.equal(mac.level, 'ok');
  assert.match(mac.message, /angle/);
  const off = describeLayerGpu({ env: { AUTOMONTAGE_GPU: 'off' }, platform: 'darwin', arch: 'arm64' });
  assert.equal(off.level, 'ok');
  assert.match(off.message, /AUTOMONTAGE_GPU=off/);
  const linux = describeLayerGpu({ env: {}, platform: 'linux', arch: 'x64' });
  assert.equal(linux.level, 'ok');
  assert.match(linux.message, /CPU/);
});

test('describeLayerGpu: неверное значение не бросает, а даёт warn', () => {
  const bad = describeLayerGpu({ env: { AUTOMONTAGE_GPU: 'gpu' }, platform: 'darwin', arch: 'arm64' });
  assert.equal(bad.level, 'warn');
  assert.match(bad.message, /auto\|off/);
  assert.doesNotMatch(bad.message, /будет использован/);
  assert.match(bad.message, /не запустится/);
});

// 3D-слои (#150): WebGL нужен всегда – angle на Apple Silicon, иначе программный swangle.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanLayerWebgl } = require('../scripts/gpu');

function layerSrc(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-webgl-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

test('layerGpuPlan: 3D-слой – angle с запасным swangle на Apple Silicon, swangle везде ещё', () => {
  const mac = layerGpuPlan({ env: {}, platform: 'darwin', arch: 'arm64', webgl: true });
  assert.equal(mac.gl, 'angle');
  assert.equal(mac.fallbackGl, 'swangle');
  for (const [env, platform, arch] of [[{}, 'linux', 'x64'], [{ AUTOMONTAGE_GPU: 'off' }, 'darwin', 'arm64'], [{}, 'darwin', 'x64']]) {
    const plan = layerGpuPlan({ env, platform, arch, webgl: true });
    assert.equal(plan.gl, 'swangle');
    assert.equal(plan.fallbackGl, null);
    assert.match(plan.reason, /3D/);
  }
});

test('layerGpuPlan: обычный слой без изменений – запасной попытки с gl нет', () => {
  assert.equal(layerGpuPlan({ env: {}, platform: 'darwin', arch: 'arm64' }).fallbackGl, null);
  assert.equal(layerGpuPlan({ env: {}, platform: 'linux', arch: 'x64', webgl: false }).gl, null);
});

test('layerGpuPlan: неверный AUTOMONTAGE_GPU бросает и для 3D-слоя', () => {
  assert.throws(() => layerGpuPlan({ env: { AUTOMONTAGE_GPU: 'gpu' }, platform: 'linux', arch: 'x64', webgl: true }), /auto\|off/);
});

test('scanLayerWebgl: находит импорт 3D-пакетов в любом файле src, в том числе вложенном', () => {
  for (const line of [
    "import { ThreeCanvas } from '@remotion/three';",
    'import * as THREE from "three";',
    "import { Canvas } from '@react-three/fiber';",
    "import { OrbitControls } from '@react-three/drei';",
    "const { MeshBasicMaterial } = require('three/src/materials/MeshBasicMaterial.js');",
    "import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';",
  ]) {
    const dir = layerSrc({ 'index.jsx': "import React from 'react';\n", 'scenes/Hero.jsx': `${line}\n` });
    assert.equal(scanLayerWebgl(dir).webgl, true, line);
  }
});

test('scanLayerWebgl: обычный слой и похожие имена – не 3D', () => {
  const dir = layerSrc({
    'index.jsx': "import React from 'react';\nimport { Three } from './three';\nimport x from 'threejs-like-name';\n// import '@remotion/three' в комментарии\n",
    'three.jsx': 'export const Three = () => null;\n',
  });
  const scan = scanLayerWebgl(dir);
  assert.equal(scan.webgl, false);
  assert.deepEqual(scan.clockHooks, []);
});

test('scanLayerWebgl: часы useFrame, Math.random, Date.now в 3D-слое – предупреждение с файлом и строкой', () => {
  const dir = layerSrc({
    'index.jsx': "import { ThreeCanvas } from '@remotion/three';\nimport { useFrame } from '@react-three/fiber';\n",
    'Box.jsx': "export const Box = () => {\n  useFrame((s) => { s.camera.position.x = Math.random(); });\n  const t = Date.now();\n  return null;\n};\n",
  });
  const scan = scanLayerWebgl(dir);
  assert.equal(scan.webgl, true);
  assert.deepEqual(scan.clockHooks.map((h) => `${h.file}:${h.line}:${h.token}`).sort(),
    ['Box.jsx:2:Math.random', 'Box.jsx:2:useFrame', 'Box.jsx:3:Date.now']);
});

test('scanLayerWebgl: нет папки src – не 3D, без ошибки; node_modules и ссылки не читаются', () => {
  assert.deepEqual(scanLayerWebgl(path.join(os.tmpdir(), 'am-webgl-missing-xyz')), { webgl: false, clockHooks: [] });
  const dir = layerSrc({ 'index.jsx': "import React from 'react';\n", 'node_modules/x/index.js': "import 'three';\n" });
  const outside = layerSrc({ 'evil.jsx': "import 'three';\n" });
  fs.symlinkSync(outside, path.join(dir, 'linked'));
  assert.equal(scanLayerWebgl(dir).webgl, false);
});

test('describeLayerGpu: doctor называет, чем рисуются 3D-слои', () => {
  assert.match(describeLayerGpu({ env: {}, platform: 'darwin', arch: 'arm64' }).message, /3D.*angle/);
  assert.match(describeLayerGpu({ env: {}, platform: 'linux', arch: 'x64' }).message, /3D.*swangle/);
});
