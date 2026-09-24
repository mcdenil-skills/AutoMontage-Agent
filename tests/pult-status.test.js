const test = require('node:test');
const assert = require('node:assert/strict');

const { deriveVariantStatus, pluralEdits } = require('../scripts/pult/status');

const BRIEF = 'brief/v02-draft.lesson.json';
const APPROVED = 'brief/v03-approved.lesson.json';
const DRAFT_SHA = 'a'.repeat(64);
const PREVIEW_SHA = 'b'.repeat(64);

function manifest(overrides = {}) {
  return {
    currentBrief: BRIEF,
    currentPreview: {
      filePath: 'previews/v02-draft-full.mp4',
      briefPath: BRIEF,
      kind: 'full',
      sha256: PREVIEW_SHA,
      briefSha256: DRAFT_SHA,
    },
    renders: [],
    latestRender: null,
    final: 'final/clip.mp4',
    ...overrides,
  };
}

function derive(overrides = {}, input = {}) {
  return deriveVariantStatus({
    manifest: manifest(overrides),
    currentBriefStatus: 'draft',
    currentBriefSha256: DRAFT_SHA,
    finalExists: false,
    pendingComments: 0,
    ...input,
  });
}

test('fresh full preview of the current draft waits for the author', () => {
  const result = derive();
  assert.equal(result.status, 'waiting');
  assert.equal(result.nextStep, 'Посмотрите preview и утвердите');
  assert.deepEqual(result.video, { kind: 'preview', path: 'previews/v02-draft-full.mp4', sha256: PREVIEW_SHA });
  assert.equal(result.approvable, true);
  assert.equal(result.needsFinal, false);
  assert.equal(result.briefPath, BRIEF);
  assert.equal(result.previewSha256, PREVIEW_SHA);
});

test('stale, excerpt, foreign or missing preview keeps the agent working', () => {
  const cases = [
    ['changed brief bytes', {}, { currentBriefSha256: 'c'.repeat(64) }],
    ['excerpt', { currentPreview: { ...manifest().currentPreview, kind: 'excerpt' } }, {}],
    ['other brief', { currentPreview: { ...manifest().currentPreview, briefPath: 'brief/v01-draft.lesson.json' } }, {}],
    ['no preview', { currentPreview: null }, {}],
  ];
  for (const [label, overrides, input] of cases) {
    const result = derive(overrides, input);
    assert.equal(result.status, 'working', label);
    assert.equal(result.nextStep, 'Агент готовит preview', label);
    assert.equal(result.approvable, false, label);
  }
  assert.equal(derive({}, { currentBriefSha256: 'c'.repeat(64) }).video.kind, 'stale-preview');
  assert.equal(derive({ currentPreview: null }).video, null);
});

test('no brief yet means the agent prepares a draft', () => {
  const result = derive(
    { currentBrief: null, currentPreview: null },
    { currentBriefStatus: null, currentBriefSha256: null },
  );
  assert.equal(result.status, 'working');
  assert.equal(result.nextStep, 'Агент готовит черновик');
});

test('approved brief without its final waits for the agent render', () => {
  const result = derive({ currentBrief: APPROVED }, { currentBriefStatus: 'approved' });
  assert.equal(result.status, 'working');
  assert.equal(result.nextStep, 'Утверждено — агент собирает финал');
  assert.equal(result.approvable, false);
  assert.equal(result.needsFinal, true);
  assert.equal(result.video.kind, 'preview');
});

test('complete render of the approved brief with an existing final is ready', () => {
  const result = derive({
    currentBrief: APPROVED,
    renders: [{ version: 1, label: 'final', dir: 'renders/v01-final', briefPath: APPROVED, status: 'complete' }],
    latestRender: 'renders/v01-final',
  }, { currentBriefStatus: 'approved', finalExists: true });
  assert.equal(result.status, 'ready');
  assert.equal(result.nextStep, 'Готов — можно забирать');
  assert.equal(result.needsFinal, false);
  assert.deepEqual(result.video, { kind: 'final', path: 'final/clip.mp4', sha256: null });
});

test('final of an older brief is not ready for the new approval', () => {
  const result = derive({
    currentBrief: APPROVED,
    renders: [{ version: 1, label: 'old', dir: 'renders/v01-old', briefPath: 'brief/v01-approved.lesson.json', status: 'complete' }],
    latestRender: 'renders/v01-old',
  }, { currentBriefStatus: 'approved', finalExists: true });
  assert.equal(result.status, 'working');
  assert.equal(result.needsFinal, true);
  assert.equal(result.video.kind, 'final');
});

test('scenario-only projects with a complete render are ready', () => {
  const result = derive({
    currentBrief: null,
    currentPreview: null,
    renders: [{ version: 1, label: 'smoke', dir: 'renders/v01-smoke', briefPath: null, status: 'complete' }],
    latestRender: 'renders/v01-smoke',
  }, { currentBriefStatus: null, currentBriefSha256: null, finalExists: true });
  assert.equal(result.status, 'ready');
});

test('new comments hand the video back to the agent', () => {
  const result = derive({}, { pendingComments: 3 });
  assert.equal(result.status, 'working');
  assert.equal(result.nextStep, 'Ждёт агента: 3 правки');
  assert.equal(result.approvable, false);
  assert.equal(result.video.kind, 'preview');
});

test('russian plural forms for edits', () => {
  assert.deepEqual(
    [1, 2, 5, 11, 12, 21, 22, 25].map(pluralEdits),
    ['1 правка', '2 правки', '5 правок', '11 правок', '12 правок', '21 правка', '22 правки', '25 правок'],
  );
});
