const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { buildSync } = require('esbuild');
const remotion = require('remotion');

function loadMotion(relativePath, overrides = {}) {
  const filename = path.join(__dirname, '../..', relativePath);
  const output = buildSync({
    entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false,
    jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'remotion', '@remotion/layout-utils'],
    logLevel: 'silent',
  }).outputFiles[0].text;
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  compiled.require = (request) => request === 'remotion' ? {
    ...remotion,
    AbsoluteFill: ({ children, style, ...props }) => React.createElement('div', { style, ...props }, children),
    Sequence: 'sequence', Audio: 'audio', OffthreadVideo: 'video', Img: 'img',
    staticFile: (src) => `/static/${src}`,
    useCurrentFrame: () => 89,
    useVideoConfig: () => ({ width: 1080, height: 1920, fps: 30, durationInFrames: 630 }),
    ...overrides,
  } : require(request);
  compiled._compile(output, filename);
  return compiled.exports;
}

const dense = (length) => 'Широкие щедрые возможности помогают действовать увереннее. '.repeat(10).slice(0, length);
const scenes = [
  { scene: 'kinetic-title', text: dense(120), emphasis: dense(40) },
  { scene: 'card', title: dense(80), body: dense(240) },
  { scene: 'steps', title: dense(80), steps: Array.from({ length: 4 }, () => dense(60)) },
  { scene: 'list', title: dense(80), items: Array.from({ length: 4 }, () => dense(80)) },
  { scene: 'counter', label: dense(80), value: -1234567.89, prefix: dense(16), suffix: dense(16) },
  { scene: 'media', overlayText: dense(120), media: { kind: 'image', src: 'assets/test.png', sha256: 'a'.repeat(64), fit: 'contain' } },
  { scene: 'cta', title: dense(80), action: dense(80), handle: dense(80) },
].map((scene, index) => ({ ...scene, start: index * 3, end: (index + 1) * 3 }));
function brief(overrides = {}) {
  return {
    version: 1, kind: 'motion-reel', status: 'approved', source: 'input/narration.wav',
    approval: { draftSha256: 'a'.repeat(64), sourceSha256: 'b'.repeat(64), previewSha256: 'c'.repeat(64), confirmedAt: '2026-09-08T10:00:00.000Z' },
    theme: 'motion-neutral', title: 'Общедоступные сцены',
    output: { aspect: 'vertical', width: 1080, height: 1920, fps: 30, durationInFrames: 660 },
    scenes, ...overrides,
  };
}
module.exports = { loadMotion, dense, scenes, brief };
