const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, sha, fakeMedia } = require('./helpers/motion-workflow-fixture.cjs');
const { runMotion, parseMotionOptions } = require('../scripts/motion/build');
const { runPreview } = require('../scripts/preview');
const { approveBrief, readProjectManifest } = require('../scripts/project/workspace');
const { buildReelScenesProps } = require('../scripts/lesson/brief');
const { buildMotionProps } = require('../scripts/motion/brief');
function preview(f, dependencies = {}) {
  return runPreview({ projectDir: f.workspace.dir, briefPath: f.published.relativePath, open: false }, { ...fakeMedia(), ...dependencies });
}
function approve(f) {
  f.workspace.manifest = readProjectManifest(f.workspace.dir);
  return approveBrief(f.workspace, f.published.jsonPath, { confirmPreviewViewed: true });
}
function final(f, approved, dependencies = {}) {
  return runMotion({ projectDir: f.workspace.dir, briefPath: approved.jsonPath, versionLabel: 'reviewed' }, { ...fakeMedia(), probeVideoImpl: () => ({ width: 320, height: 568, fps: 30, duration: 2 }), ...dependencies });
}
test('motion option parser separates audio initialization from approved continuation', () => {
  assert.equal(parseMotionOptions(['voice.wav', '--project', 'Reel']).narrationPath, 'voice.wav');
  assert.equal(parseMotionOptions(['--project-dir', '.', '--brief', 'brief/approved.json']).briefPath, 'brief/approved.json');
  for (const args of [[], ['voice.wav'], ['--brief', 'x'], ['voice.wav', '--project', 'X', '--face-x', '0.5'], ['--project-dir', '.', '--brief', 'a', '--brief', 'b']]) assert.throws(() => parseMotionOptions(args));
});
test('motion initialization transcribes locally and publishes a draft scaffold without a render', (t) => {
  const f = fixture(t);
  const result = runMotion({ narrationPath: f.narrationPath, projectDir: path.join(f.root, 'initialized'), project: 'Scaffold' }, {
    probeOpenedAudioImpl() { return { mediaKind: 'audio', durationSec: 2 }; },
    transcribeMotionNarrationImpl({ workspace }) {
      const transcript = [{ start: 0, end: 2, text: 'Дословно из речи', words: [] }];
      fs.writeFileSync(path.join(workspace.dir, 'transcript/words.json'), JSON.stringify(transcript));
      return { transcript };
    },
  });
  assert.equal(result.action, 'draft');
  const brief = JSON.parse(fs.readFileSync(result.jsonPath));
  assert.equal(brief.kind, 'motion-reel');
  assert.equal(brief.status, 'draft');
  assert.equal(brief.scenes[0].text, 'Дословно из речи');
  assert.equal(brief.output.durationInFrames, 60);
  assert.deepEqual(readProjectManifest(result.projectDir).renders, []);
});
test('stored motion kind chooses watermarked MotionReel preview and an audio-only no-follow bundle', (t) => {
  const f = fixture(t); const calls = [];
  const result = preview(f, fakeMedia(calls));
  assert.equal(result.metadata.kind, 'full');
  assert.equal(result.metadata.briefSha256, sha(fs.readFileSync(f.published.jsonPath)));
  assert.equal(result.metadata.sourceSha256, sha(fs.readFileSync(f.workspace.sourcePath)));
  const render = calls.find(call => call.stage.includes('Remotion'));
  assert.ok(render.args.includes('MotionReel'));
  assert.equal(render.props.draftPreview, true);
  assert.equal(Object.hasOwn(render.props, 'faceSrc'), false);
  assert.match(render.props.audioSrc, /^\.automontage\//);
  assert.deepEqual(readProjectManifest(f.workspace.dir).renders, []);
  assert.equal(fs.existsSync(path.join(f.workspace.dir, 'final/final.mp4')), false);
});
test('motion approval requires an explicitly viewed, exact full preview and stores three hashes', (t) => {
  const f = fixture(t);
  assert.throws(() => approve(f), /preview/i);
  preview(f); f.workspace.manifest = readProjectManifest(f.workspace.dir);
  assert.throws(() => approveBrief(f.workspace, f.published.jsonPath), /preview/i);
  const result = approve(f); const brief = JSON.parse(fs.readFileSync(result.jsonPath));
  assert.equal(brief.approval.draftSha256, sha(fs.readFileSync(f.published.jsonPath)));
  assert.equal(brief.approval.sourceSha256, sha(fs.readFileSync(f.workspace.sourcePath)));
  assert.equal(brief.approval.previewSha256, readProjectManifest(f.workspace.dir).currentPreview.sha256);
  assert.equal(brief.status, 'approved');
});
test('motion approval rejects excerpt, changed narration and changed brief', (t) => {
  for (const mutation of ['excerpt', 'source', 'brief']) {
    const f = fixture(t); preview(f);
    if (mutation === 'excerpt') {
      const file = path.join(f.workspace.dir, 'project.json'); const manifest = JSON.parse(fs.readFileSync(file));
      manifest.currentPreview.kind = 'excerpt'; fs.writeFileSync(file, JSON.stringify(manifest));
    } else if (mutation === 'source') fs.appendFileSync(f.workspace.sourcePath, 'changed');
    else { f.brief.title = 'Изменено'; fs.writeFileSync(f.published.jsonPath, JSON.stringify(f.brief)); }
    assert.throws(() => approve(f), /preview|bytes|identity/i, mutation);
    assert.equal(fs.readdirSync(path.join(f.workspace.dir, 'brief')).some(name => name.includes('approved')), false);
  }
});
test('final rejects draft and unregistered approved data before allocating renders', (t) => {
  const f = fixture(t);
  assert.throws(() => final(f, { jsonPath: f.published.jsonPath }), /approved/i);
  const unregistered = path.join(f.workspace.dir, 'brief/forged.motion.json');
  fs.writeFileSync(unregistered, JSON.stringify({ ...f.brief, status: 'approved' }));
  assert.throws(() => final(f, { jsonPath: unregistered }), /registered|current/i);
  assert.deepEqual(fs.readdirSync(path.join(f.workspace.dir, 'renders')), []);
});
test('approved final preserves immutable labeled history and publishes only after QA', (t) => {
  const f = fixture(t); preview(f); const approved = approve(f); const calls = [];
  const one = final(f, approved, { ...fakeMedia(calls), probeVideoImpl: () => ({ width: 320, height: 568, fps: 30, duration: 2 }) });
  const two = final(f, approved);
  const manifest = readProjectManifest(f.workspace.dir);
  assert.equal(one.action, 'render');
  assert.equal(two.action, 'render');
  assert.deepEqual(manifest.renders.map(render => [render.dir, render.status]), [['renders/v01-reviewed', 'complete'], ['renders/v02-reviewed', 'complete']]);
  assert.equal(fs.readFileSync(one.finalPath, 'utf8'), 'rendered');
  assert.equal(fs.readFileSync(path.join(f.workspace.dir, 'renders/v01-reviewed/final.mp4'), 'utf8'), 'rendered');
  assert.ok(calls.some(call => call.stage === 'motion QA decode'));
  assert.equal(calls.find(call => call.stage.includes('Remotion')).props.draftPreview, undefined);
});
test('final detects edited approved copy, draft, narration and preview before rendering', (t) => {
  for (const mutation of ['approved', 'draft', 'source', 'preview']) {
    const f = fixture(t); preview(f); const approved = approve(f);
    if (mutation === 'approved') { const brief = JSON.parse(fs.readFileSync(approved.jsonPath)); brief.title = 'changed'; fs.writeFileSync(approved.jsonPath, JSON.stringify(brief)); }
    if (mutation === 'draft') fs.appendFileSync(f.published.jsonPath, ' ');
    if (mutation === 'source') fs.appendFileSync(f.workspace.sourcePath, 'changed');
    if (mutation === 'preview') fs.appendFileSync(path.join(f.workspace.dir, 'previews/current-preview.mp4'), 'changed');
    assert.throws(() => final(f, approved), /approval|preview|changed|bytes/i, mutation);
    assert.deepEqual(fs.readdirSync(path.join(f.workspace.dir, 'renders')), []);
  }
});
test('failed final QA records failure and preserves the prior final', (t) => {
  const f = fixture(t); preview(f); const approved = approve(f); const good = final(f, approved);
  const prior = fs.readFileSync(good.finalPath);
  assert.throws(() => final(f, approved, { probeVideoImpl: () => ({ width: 1, height: 1, fps: 1, duration: 1 }) }), /metadata|QA/i);
  assert.deepEqual(fs.readFileSync(good.finalPath), prior);
  assert.equal(readProjectManifest(f.workspace.dir).renders.at(-1).status, 'failed');
});
test('both renderer builders reject the other brief kind', (t) => {
  const f = fixture(t);
  assert.throws(() => buildReelScenesProps({ brief: { ...f.brief, status: 'approved' } }));
  assert.throws(() => buildMotionProps({ brief: require('../examples/lesson-neutral-approved.json') }));
});
test('motion preview refuses a lesson entry even with a motion filename', (t) => {
  const f = fixture(t); const file = path.join(f.workspace.dir, 'project.json'); const manifest = JSON.parse(fs.readFileSync(file));
  manifest.briefs[0].kind = 'lesson'; fs.writeFileSync(file, JSON.stringify(manifest));
  assert.throws(() => preview(f), /kind|lesson|invalid/i);
});
test('motion media bundle verifies project file hashes and rejects symlinks', (t) => {
  const f = fixture(t); const media = path.join(f.workspace.dir, 'assets/broll/photo.png'); fs.writeFileSync(media, 'photo');
  f.brief.scenes = [{ scene: 'media', start: 0, end: 2, media: { kind: 'image', src: 'assets/broll/photo.png', sha256: sha('photo'), fit: 'contain' } }];
  fs.writeFileSync(f.published.jsonPath, JSON.stringify(f.brief));
  preview(f);
  fs.writeFileSync(media, 'changed'); assert.throws(() => preview(f), /hash/i);
  fs.unlinkSync(media); fs.symlinkSync(f.narrationPath, media); assert.throws(() => preview(f), /symbolic/i);
});

test('motion music is hash-bound and shared finishing uses an isolated ducking source', (t) => {
  const f = fixture(t); const calls = [];
  fs.writeFileSync(path.join(f.workspace.dir, 'assets/music/track.wav'), 'music');
  f.brief.music = { file: 'assets/music/track.wav', sha256: sha('music'), gainDb: -20, ducking: { ratio: 6 } };
  fs.writeFileSync(f.published.jsonPath, JSON.stringify(f.brief));
  preview(f, fakeMedia(calls));
  const mix = calls.find(call => call.stage === 'preview music mix');
  assert.equal(mix.args[mix.args.indexOf('--ratio') + 1], '6');
  assert.match(mix.args[1], /automontage-render-.*media-2\.wav/);
  const approved = approve(f); final(f, approved);
  fs.writeFileSync(path.join(f.workspace.dir, 'assets/music/track.wav'), 'new music');
  assert.throws(() => final(f, approved), /hash/i);
});

test('motion approval rejects replaced media after preview', (t) => {
  const f = fixture(t); const media = path.join(f.workspace.dir, 'assets/broll/photo.png'); fs.writeFileSync(media, 'photo');
  f.brief.scenes = [{ scene: 'media', start: 0, end: 2, media: { kind: 'image', src: 'assets/broll/photo.png', sha256: sha('photo'), fit: 'contain' } }];
  fs.writeFileSync(f.published.jsonPath, JSON.stringify(f.brief));
  preview(f); fs.writeFileSync(media, 'changed');
  assert.throws(() => approve(f), /hash/i);
});

test('final refuses foreign version directories and late narration changes', (t) => {
  const f = fixture(t); preview(f); const approved = approve(f);
  const target = path.join(f.workspace.dir, 'renders/v01-reviewed'); fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'sentinel.txt'), 'foreign');
  assert.throws(() => final(f, approved), /exist/i);
  assert.equal(fs.readFileSync(path.join(target, 'sentinel.txt'), 'utf8'), 'foreign');
  const f2 = fixture(t); preview(f2); const approved2 = approve(f2);
  const deps = fakeMedia(); const run = deps.runToolImpl;
  assert.throws(() => final(f2, approved2, { ...deps, runToolImpl(command, args, options) {
    run(command, args, options); if (options.stage === 'motion Remotion') fs.appendFileSync(f2.workspace.sourcePath, 'changed');
  }, probeVideoImpl: () => ({ width: 320, height: 568, fps: 30, duration: 2 }) }), /changed|identity/i);
  assert.equal(readProjectManifest(f2.workspace.dir).renders.at(-1).status, 'failed');
  assert.equal(fs.existsSync(path.join(f2.workspace.dir, f2.workspace.manifest.final)), false);
});

test('approved motion JSON is byte-immutable, including receipt and whitespace', (t) => {
  for (const change of ['whitespace', 'receipt']) {
    const f = fixture(t); preview(f); const approved = approve(f);
    if (change === 'whitespace') fs.appendFileSync(approved.jsonPath, '\n');
    else { const brief = JSON.parse(fs.readFileSync(approved.jsonPath)); brief.approval.confirmedAt = '2026-09-08T00:00:00.000Z'; fs.writeFileSync(approved.jsonPath, `${JSON.stringify(brief, null, 2)}\n`); }
    assert.throws(() => final(f, approved), /approval|immutable|hash/i, change);
    assert.deepEqual(fs.readdirSync(path.join(f.workspace.dir, 'renders')), []);
  }
});
