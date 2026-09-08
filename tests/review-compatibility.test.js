const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDraftPreviewProps, buildReelScenesProps } = require('../scripts/lesson/brief');

test('review additions do not change canonical lesson props', () => {
  const brief = require('../examples/lesson-neutral-approved.json');
  const props = buildReelScenesProps({ brief, theme: { id: 'fixture' } });
  assert.deepEqual(props.scenes, brief.scenes);
  assert.equal(props.fps, 25);
  assert.equal(props.durationInFrames, 350);
  assert.equal(props.faceSrc, 'source.mp4');
  assert.equal(props.audioSrc, 'source.mp4');
});

test('draft remains forbidden at the renderer boundary', () => {
  const draft = { ...require('../examples/lesson-neutral-approved.json'), status: 'draft' };
  assert.throws(() => buildReelScenesProps({ brief: draft, theme: {} }), /approved/);
});

test('review draft props use a separate marked preview boundary', () => {
  const draft = { ...require('../examples/lesson-neutral-approved.json'), status: 'draft' };
  const props = buildDraftPreviewProps({ brief: draft, theme: { id: 'fixture' } });

  assert.equal(props.draftPreview, true);
  assert.deepEqual(props.scenes, draft.scenes);
});

const fs = require('node:fs');
const { fixture } = require('./helpers/motion-workflow-fixture.cjs');
const { loadReviewState } = require('../scripts/review/model');
test('Review exposes motion scene text through stored kind without host paths or hashes', (t) => {
  const f = fixture(t);
  const state = loadReviewState({ root: f.root, projectDir: f.workspace.dir, editable: true });
  assert.equal(state.brief.kind, 'motion-reel');
  assert.equal(state.brief.scenes[0].text, 'Точный текст');
  assert.equal(state.session.editable, false);
  assert.equal(state.source.mediaKind, 'audio');
  assert.doesNotMatch(JSON.stringify(state), /sha256|baseHash|manifestHash|input\/narration|provider|faceSrc|\/Users\/|\/var\//i);
});
test('Review motion media exposes only display metadata, never project references or hashes', (t) => {
  const f = fixture(t);
  f.brief.scenes = [{ scene: 'media', start: 0, end: 2, overlayText: 'Изображение', media: { kind: 'image', src: 'assets/broll/private.png', sha256: 'a'.repeat(64), fit: 'contain' } }];
  fs.writeFileSync(f.published.jsonPath, JSON.stringify(f.brief));
  const state = loadReviewState({ root: f.root, projectDir: f.workspace.dir });
  assert.deepEqual(state.brief.scenes[0].media, { kind: 'image', fit: 'contain' });
  assert.doesNotMatch(JSON.stringify(state), /private\.png|sha256/);
  f.brief.scenes[0].overlayText = '<script>alert(1)</script>';
  fs.writeFileSync(f.published.jsonPath, JSON.stringify(f.brief));
  assert.throws(() => loadReviewState({ root: f.root, projectDir: f.workspace.dir }), /invalid/);
});

test('Review HTTP serves audio motion safely and refuses unsupported lesson edits', async (t) => {
  const { startReviewServer } = require('../scripts/review/server');
  const f = fixture(t);
  const app = await startReviewServer({ root: f.root, projectDir: f.workspace.dir, open: false, editable: true,
    runToolImpl() {}, logger: { log() {}, warn() {}, error() {} },
  });
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const headers = { Authorization: `Bearer ${app.token}`, Origin: app.origin, 'Content-Type': 'application/json' };
  const response = await fetch(`${app.origin}/api/state`, { headers });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.session.editable, false);
  assert.equal(state.brief.kind, 'motion-reel');
  assert.doesNotMatch(JSON.stringify(state), /sha256|baseHash|manifestHash|provider/i);
  const source = await fetch(`${app.origin}/media/source`, { headers });
  assert.equal(source.status, 200);
  assert.equal(source.headers.get('content-type'), 'audio/wav');
  const edit = await fetch(`${app.origin}/api/save`, { method: 'POST', headers, body: '{}' });
  assert.equal(edit.status, 405);
});

test('motion timeline labels include scene type and every visible copy field', () => {
  const { loadMotion } = require('./helpers/motion-render');
  const { sceneDisplayText } = loadMotion('review/timeline.js');
  assert.equal(sceneDisplayText({ scene: 'kinetic-title', text: 'Точная мысль' }), 'kinetic-title · Точная мысль');
  assert.equal(sceneDisplayText({ scene: 'steps', title: 'План', steps: ['Раз', 'Два'] }), 'steps · План · Раз → Два');
  assert.equal(sceneDisplayText({ scene: 'counter', label: 'Рост', value: 42, suffix: '%' }), 'counter · Рост · 42%');
});

test('motion Review marks the preview stale when narration changes', (t) => {
  const { fakeMedia } = require('./helpers/motion-workflow-fixture.cjs');
  const f = fixture(t);
  require('../scripts/preview').runPreview({ projectDir: f.workspace.dir, briefPath: f.published.relativePath, open: false }, fakeMedia());
  assert.equal(loadReviewState({ root: f.root, projectDir: f.workspace.dir }).currentPreview.stale, false);
  fs.appendFileSync(f.workspace.sourcePath, 'changed');
  assert.equal(loadReviewState({ root: f.root, projectDir: f.workspace.dir }).currentPreview.stale, true);
});
