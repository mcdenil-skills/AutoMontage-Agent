const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const { runPreviewQa } = require('../scripts/qa-preview');
const {
  createOrOpenProject,
  writeProjectManifest,
} = require('../scripts/project/workspace');

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function makeQaProject(t, { music = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-qa-preview-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'camera.mp4');
  fs.writeFileSync(source, 'voice-source');
  const workspace = createOrOpenProject({
    projectDir: path.join(root, 'project'),
    name: 'Preview QA',
    sourcePath: source,
    now: new Date('2026-08-23T12:00:00.000Z'),
  });
  const briefRelative = 'brief/v01-draft.lesson.json';
  const musicPath = path.join(workspace.dir, 'assets', 'music', 'track.mp3');
  if (music) fs.writeFileSync(musicPath, 'music');
  const brief = {
    version: 1,
    status: 'draft',
    source: workspace.sourcePath,
    theme: 'lesson-neutral',
    title: 'QA',
    output: { aspect: 'horizontal', width: 1920, height: 1080, fps: 25, durationInFrames: 250 },
    corrections: [],
    scenes: [{ scene: 'fullscreen', start: 0, end: 10, caption: 'QA' }],
  };
  if (music) {
    brief.music = {
      file: musicPath,
      gainDb: -20,
      ducking: { thresholdDb: -26, ratio: 6, attackMs: 10, releaseMs: 220 },
    };
  }
  fs.writeFileSync(path.join(workspace.dir, briefRelative), `${JSON.stringify(brief, null, 2)}\n`);
  const previewBytes = Buffer.from('real-remotion-preview');
  fs.writeFileSync(path.join(workspace.dir, 'previews', 'current-preview.mp4'), previewBytes);
  fs.writeFileSync(path.join(workspace.dir, 'previews', 'v01-draft-full.mp4'), previewBytes);
  const manifest = structuredClone(workspace.manifest);
  manifest.briefs.push({
    revision: 1,
    jsonPath: briefRelative,
    markdownPath: null,
    status: 'draft',
    theme: 'lesson-neutral',
    aspect: 'horizontal',
  });
  manifest.currentBrief = briefRelative;
  manifest.currentPreview = {
    filePath: 'previews/v01-draft-full.mp4',
    briefPath: briefRelative,
    kind: 'full',
    fromSec: 0,
    toSec: 10,
    width: 960,
    height: 540,
    fps: 25,
    generatedAt: '2026-08-23T13:00:00.000Z',
    sha256: sha(previewBytes),
  };
  writeProjectManifest(workspace.dir, manifest, { expectedManifest: workspace.manifest });
  return { workspace, brief, previewBytes };
}

test('preview QA proves decode frames metadata range and separate audio measurements', (t) => {
  const fixture = makeQaProject(t);
  const stages = [];
  const measures = [];
  const result = runPreviewQa({ projectDir: fixture.workspace.dir }, {
    runToolImpl(_command, args, options) {
      stages.push({ args, stage: options.stage });
    },
    probeVideoImpl() {
      return { width: 960, height: 540, fps: 25, duration: 10 };
    },
    measureAudioImpl(input) {
      measures.push(input.role);
      return input.role === 'voice' ? -15.2 : -36.8;
    },
  });

  assert.equal(result.kind, 'full');
  assert.deepEqual(result.range, { fromSec: 0, toSec: 10 });
  assert.deepEqual(result.video, { width: 960, height: 540, fps: 25, duration: 10 });
  assert.deepEqual(result.audio, { voiceDb: -15.2, musicUnderSpeechDb: -36.8 });
  assert.deepEqual(measures, ['voice', 'music-under-speech']);
  assert.deepEqual(stages.map(({ stage }) => stage), [
    'preview QA full decode', 'preview QA first frame', 'preview QA last frame',
  ]);
  assert.equal(stages[2].args.includes('9.96'), true);
  assert.equal(result.finalStateUnchanged, true);
});

test('preview QA fails closed on hash or media metadata drift', (t) => {
  const fixture = makeQaProject(t, { music: false });
  const preview = path.join(fixture.workspace.dir, 'previews', 'current-preview.mp4');
  fs.writeFileSync(preview, 'foreign-preview');

  assert.throws(() => runPreviewQa({ projectDir: fixture.workspace.dir }, {
    runToolImpl() {},
    probeVideoImpl() { return { width: 960, height: 540, fps: 25, duration: 10 }; },
  }), /hash/i);

  fs.writeFileSync(preview, fixture.previewBytes);
  assert.throws(() => runPreviewQa({ projectDir: fixture.workspace.dir }, {
    runToolImpl() {},
    probeVideoImpl() { return { width: 1920, height: 1080, fps: 30, duration: 9 }; },
  }), /metadata|geometry|FPS|duration/i);
});

test('preview QA requires one explicit current full or excerpt preview', (t) => {
  const fixture = makeQaProject(t, { music: false });
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture.workspace.dir, 'project.json'), 'utf8'));
  manifest.currentPreview = null;
  fs.writeFileSync(path.join(fixture.workspace.dir, 'project.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  assert.throws(() => runPreviewQa({ projectDir: fixture.workspace.dir }), /current preview|предпросмотр/i);
});

test('motion QA measures narration without music and rejects stale narration/brief', (t) => {
  const { fixture, fakeMedia } = require('./helpers/motion-workflow-fixture.cjs');
  const { runPreview } = require('../scripts/preview');
  const f = fixture(t);
  runPreview({ projectDir: f.workspace.dir, briefPath: f.published.relativePath, open: false }, fakeMedia());
  const result = runPreviewQa({ projectDir: f.workspace.dir }, {
    runToolImpl() {}, probeVideoImpl: () => ({ width: 160, height: 284, fps: 30, duration: 2 }),
    measureAudioImpl({ role, sourcePath }) { assert.equal(role, 'voice'); assert.equal(sourcePath, f.workspace.sourcePath); return -18; },
  });
  assert.equal(result.audio.voiceDb, -18);
  fs.appendFileSync(f.workspace.sourcePath, 'changed');
  assert.throws(() => runPreviewQa({ projectDir: f.workspace.dir }, { runToolImpl() {}, probeVideoImpl: () => ({ width: 160, height: 284, fps: 30, duration: 2 }) }), /source|narration|stale/i);
});

test('motion QA dispatches from stored kind and refuses a preview of an older draft', (t) => {
  const { fixture, fakeMedia } = require('./helpers/motion-workflow-fixture.cjs');
  const { runPreview } = require('../scripts/preview');
  const { publishBriefRevision, readProjectManifest } = require('../scripts/project/workspace');
  const f = fixture(t);
  runPreview({ projectDir: f.workspace.dir, briefPath: f.published.relativePath, open: false }, fakeMedia());
  const deps = { runToolImpl() {}, probeVideoImpl: () => ({ width: 160, height: 284, fps: 30, duration: 2 }), measureAudioImpl: () => -18 };
  const original = fs.readFileSync(f.published.jsonPath);
  const tampered = { ...f.brief }; delete tampered.kind;
  fs.writeFileSync(f.published.jsonPath, JSON.stringify(tampered));
  assert.throws(() => runPreviewQa({ projectDir: f.workspace.dir }, deps), /kind|invalid/i);
  fs.writeFileSync(f.published.jsonPath, original);
  f.workspace.manifest = readProjectManifest(f.workspace.dir);
  publishBriefRevision(f.workspace, { kind: 'motion-reel', brief: { ...f.brief, title: 'Новая ревизия' } });
  assert.throws(() => runPreviewQa({ projectDir: f.workspace.dir }, deps), /stale|current/i);
});
