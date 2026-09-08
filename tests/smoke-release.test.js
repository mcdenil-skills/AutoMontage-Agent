const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { assertProjectFinal } = require('../scripts/smoke-release');
const {
  createOrOpenProject,
  nextRenderPaths,
  publishFinal,
  recordRender,
} = require('../scripts/project/workspace');

test('release smoke accepts a final owned by the complete render selected in the manifest', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-smoke-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'source.mp4');
  fs.writeFileSync(sourcePath, 'source');
  const workspace = createOrOpenProject({
    baseDir: path.join(dir, 'projects'),
    name: 'Smoke final',
    sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const render = nextRenderPaths(workspace, 'Release');
  fs.writeFileSync(render.finalPath, 'release-render');
  recordRender(workspace, { ...render, status: 'complete' });
  const finalPath = publishFinal(workspace, render.finalPath);

  assert.equal(assertProjectFinal(workspace.dir), finalPath);
});

test('release smoke rejects a latestRender that does not select a complete render', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-smoke-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'source.mp4');
  fs.writeFileSync(sourcePath, 'source');
  const workspace = createOrOpenProject({
    baseDir: path.join(dir, 'projects'),
    name: 'Invalid smoke final',
    sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const render = nextRenderPaths(workspace, 'Unfinished');
  fs.writeFileSync(render.finalPath, 'unfinished-render');
  const manifest = {
    ...workspace.manifest,
    renders: [{
      version: render.version,
      label: render.label,
      dir: 'renders/v01-unfinished',
      briefPath: null,
      status: 'started',
    }],
    latestRender: 'renders/v01-unfinished',
  };
  fs.writeFileSync(
    path.join(workspace.dir, 'project.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  assert.throws(() => assertProjectFinal(workspace.dir), /latestRender.*complete/);
});

test('release smoke rejects a selected render final that escapes through a symbolic link', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-smoke-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'source.mp4');
  const outsideFinal = path.join(dir, 'outside-final.mp4');
  fs.writeFileSync(sourcePath, 'source');
  fs.writeFileSync(outsideFinal, 'release-render');
  const workspace = createOrOpenProject({
    baseDir: path.join(dir, 'projects'),
    name: 'Symlink smoke final',
    sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const render = nextRenderPaths(workspace, 'Release');
  fs.writeFileSync(render.finalPath, 'release-render');
  recordRender(workspace, { ...render, status: 'complete' });
  publishFinal(workspace, render.finalPath);
  fs.unlinkSync(render.finalPath);
  fs.symlinkSync(outsideFinal, render.finalPath, 'file');

  assert.throws(() => assertProjectFinal(workspace.dir), /symbolic link/);
});


test('motion smoke removes provider credentials and private themes from child environment', () => {
  const { createSmokeEnvironment } = require('../scripts/smoke-release');
  const env = createSmokeEnvironment({ PATH: '/bin', HOME: '/tmp', AUTOMONTAGE_FFMPEG_DIR: '/tools',
    ELEVENLABS_API_KEY: 'private', ELEVENLABS_VOICE_ID: 'private', OPENAI_API_KEY: 'private',
    ANTHROPIC_API_KEY: 'private', PEXELS_API_KEY: 'private', THEMES_EXT: '/private',
    UNKNOWN_PROVIDER_TOKEN: 'private', NODE_OPTIONS: '--require=private.js' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/tmp', AUTOMONTAGE_FFMPEG_DIR: '/tools' });
});

test('motion smoke fails when actual CLI help does not expose motion and the offline demo', t => {
  const { assertMotionCliHelp } = require('../scripts/smoke-release');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-help-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts/cli.js'), "console.log('legacy help');\n");
  assert.throws(() => assertMotionCliHelp(root), /motion.*help/i);
  assert.doesNotThrow(() => assertMotionCliHelp(path.resolve(__dirname, '..')));
});

test('motion media gate rejects wrong geometry, codec or extra audio while accepting the public format', t => {
  const { assertMedia } = require('../scripts/smoke-release');
  const { execFileSync } = require('node:child_process');
  require('../scripts/env').configureMediaToolPath();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-metadata-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expected = { width: 1080, height: 1920, fps: 30, videoCodec: 'h264', audioCodec: 'aac', audioTracks: 1 };
  for (const [name, size, codec, extraAudio] of [
    ['valid', '1080x1920', 'libx264', false], ['geometry', '108x192', 'libx264', false],
    ['codec', '1080x1920', 'mpeg4', false], ['audio', '1080x1920', 'libx264', true],
  ]) {
    const file = path.join(root, name + '.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=s=${size}:r=30:d=0.1`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1', '-map', '0:v', '-map', '1:a',
      ...(extraAudio ? ['-map', '1:a'] : []), '-c:v', codec, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '0.1', file], { stdio: 'pipe' });
    if (name === 'valid') assert.doesNotThrow(() => assertMedia(file, 3, expected));
    else assert.throws(() => assertMedia(file, 3, expected), /geometry|codec|audio track/i, name);
  }
});
