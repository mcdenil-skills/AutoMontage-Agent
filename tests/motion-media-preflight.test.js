const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fixture, sha, fakeMedia } = require('./helpers/motion-workflow-fixture.cjs');
const { runPreview } = require('../scripts/preview');
const { runPreviewQa } = require('../scripts/qa-preview');
const { prepareRenderMediaBundle } = require('../scripts/render-media-bundle');
const { buildDraftMotionProps } = require('../scripts/motion/brief');
const { readProjectManifest } = require('../scripts/project/workspace');
const { configureMediaToolPath } = require('../scripts/env');

function mediaFixture(t, { audioMode, duration = 3, trimStartSec = 1, audio = true, audioDuration = duration, fps = 30, videoFps = 30 }) {
  configureMediaToolPath();
  const f = fixture(t); const clip = path.join(f.workspace.dir, 'assets/broll/clip.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=green:s=64x64:r=${videoFps}:d=${duration}`,
    ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=880:duration=${audioDuration}`, '-c:a', 'aac'] : []),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
  f.brief.output.fps = fps; f.brief.output.durationInFrames = fps * 2;
  f.brief.scenes = [{ scene: 'media', start: 0, end: 2, media: { kind: 'video', src: 'assets/broll/clip.mp4', sha256: sha(fs.readFileSync(clip)), fit: 'contain', audioMode, trimStartSec } }];
  fs.writeFileSync(f.published.jsonPath, JSON.stringify(f.brief));
  return f;
}

const invalid = [
  { name: 'silent replace', audioMode: 'replace', audio: false, error: /audio stream/i },
  { name: 'silent mix', audioMode: 'mix', audio: false, error: /audio stream/i },
  { name: 'trim past video end', audioMode: 'mute', duration: 2, error: /duration|overrun/i },
  { name: 'replace past audio end', audioMode: 'replace', audioDuration: 1, error: /duration|overrun/i },
  { name: '25 fps boundary overrun', audioMode: 'mute', duration: 2.97, videoFps: 100, fps: 25, error: /duration|overrun/i },
  { name: 'deduplicated second scene overrun', audioMode: 'mix', error: /duration|overrun/i, dedup: true },
];
for (const entry of invalid) test(`motion ${entry.name} rejects preview and final bundle before renderer or publication`, t => {
  const f = mediaFixture(t, entry); const calls = [];
  if (entry.dedup) {
    f.brief.scenes[0].end = 1;
    f.brief.scenes.push({ ...f.brief.scenes[0], start: 1, end: 2, media: { ...f.brief.scenes[0].media, trimStartSec: 3 } });
    fs.writeFileSync(f.published.jsonPath, JSON.stringify(f.brief));
  }
  assert.throws(() => runPreview({ projectDir: f.workspace.dir, briefPath: f.published.relativePath, open: false }, fakeMedia(calls)), entry.error);
  assert.equal(calls.length, 0, 'renderer and finish must not run');
  assert.equal(readProjectManifest(f.workspace.dir).currentPreview, undefined);
  assert.equal(fs.existsSync(path.join(f.workspace.dir, 'previews/current-preview.mp4')), false);
  assert.deepEqual(fs.readdirSync(path.join(f.workspace.dir, 'previews')), []);
  assert.throws(() => runPreviewQa({ projectDir: f.workspace.dir }), /preview.*missing/i);
  const sourceAlias = path.basename(f.workspace.sourcePath);
  const props = buildDraftMotionProps({ brief: f.brief, sourceFile: sourceAlias });
  assert.throws(() => {
    const bundle = prepareRenderMediaBundle({ root: f.root, workspace: f.workspace, props,
      approvedBrief: { ...f.brief, status: 'approved' }, sourcePath: f.workspace.sourcePath, sourceAlias });
    bundle.cleanup();
  }, entry.error);
  assert.deepEqual(fs.readdirSync(path.join(f.workspace.dir, 'final')), []);
});

for (const entry of [
  { name: 'silent mute keeps narration', audioMode: 'mute', audio: false },
  { name: 'valid mix trim', audioMode: 'mix' },
  { name: 'valid replace trim', audioMode: 'replace' },
  { name: '25 fps rounded end tolerance', audioMode: 'mute', duration: 2.99, videoFps: 100, fps: 25 },
]) test(`motion ${entry.name} permits preview`, t => {
  const f = mediaFixture(t, entry); const calls = [];
  const deps = fakeMedia(calls);
  if (entry.fps) deps.probeVideoImpl = () => ({ width: 160, height: 284, fps: entry.fps, duration: 2 });
  runPreview({ projectDir: f.workspace.dir, briefPath: f.published.relativePath, open: false }, deps);
  const render = calls.find(call => call.stage.includes('Remotion'));
  assert.ok(render.props.audioSrc);
  assert.equal(render.props.scenes[0].media.audioMode, entry.audioMode);
  assert.ok(fs.existsSync(path.join(f.workspace.dir, 'previews/current-preview.mp4')));
});
