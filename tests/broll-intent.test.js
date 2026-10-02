const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildDraftPreviewProps,
  buildReelScenesProps,
  validateLessonBrief,
} = require('../scripts/lesson/brief');
const { buildSystemPrompt, normalizeGeneratedBrief } = require('../scripts/gen-brief');
const { applyReviewCommand } = require('../scripts/review/commands');
const { diffLessonBrief } = require('../scripts/review/diff');
const { formatBriefMarkdown } = require('../scripts/lesson/brief');
const {
  approveBrief, createOrOpenProject, nextBriefPaths, recordBrief,
} = require('../scripts/project/workspace');

const intent = {
  goal: 'Показать спокойную работу с задачами',
  sourceText: 'Я раскладываю большую задачу на маленькие шаги',
  queryOriginal: 'человек планирует задачи за ноутбуком',
  queryEnglish: 'person planning tasks on laptop',
};

function pendingScene(overrides = {}) {
  return {
    scene: 'broll', start: 0, end: 4,
    headCream: 'РАЗБИВАЕМ', headOrange: 'НА ШАГИ',
    brollIntent: structuredClone(intent),
    ...overrides,
  };
}

function makeBrief(overrides = {}) {
  return {
    version: 1,
    status: 'draft',
    source: 'input/source.mp4',
    theme: 'lesson-neutral',
    title: 'B-ROLL INTENT',
    output: { aspect: 'horizontal', width: 1920, height: 1080, fps: 25, durationInFrames: 100 },
    corrections: [],
    brollReviewPolicy: 'preview-required',
    scenes: [pendingScene()],
    ...overrides,
  };
}

test('pending b-roll intent is valid only in a draft and renders the draft placeholder', () => {
  const draft = makeBrief();
  assert.equal(validateLessonBrief(draft).ok, true);
  assert.equal(validateLessonBrief({ ...draft, status: 'approved' }).ok, false);
  assert.equal(buildDraftPreviewProps({ brief: draft }).scenes[0].scene, 'broll');
  assert.throws(() => buildReelScenesProps({ brief: { ...draft, status: 'approved' } }), /intent|b-roll/i);
});

test('intent fields are bounded and reject controls and unknown fields', () => {
  for (const brollIntent of [
    { ...intent, queryEnglish: '' },
    { ...intent, queryEnglish: '   ' },
    { ...intent, queryOriginal: 'x'.repeat(201) },
    { ...intent, goal: `bad\u0000goal` },
    { ...intent, extra: 'no' },
  ]) {
    assert.equal(validateLessonBrief(makeBrief({ scenes: [pendingScene({ brollIntent })] })).ok, false);
  }
});

test('normalizer preserves explicit intent without a local file and marks discovery drafts', () => {
  const brief = normalizeGeneratedBrief({ scenes: [pendingScene()] }, {
    source: 'input/source.mp4', theme: 'lesson-neutral', title: 'B-ROLL INTENT',
    output: { aspect: 'horizontal', width: 1920, height: 1080, fps: 25, durationInFrames: 100 },
    dictionaryCorrections: [], availableBroll: [],
  });
  assert.equal(brief.scenes[0].scene, 'broll');
  assert.deepEqual(brief.scenes[0].brollIntent, intent);
  assert.equal(brief.brollReviewPolicy, 'preview-required');
});

test('authoring prompt permits intent-only b-roll when no local files are available', () => {
  const prompt = buildSystemPrompt({ maxScenes: 4, availableBroll: [] });
  assert.doesNotMatch(prompt, /broll не используй/u);
  assert.match(prompt, /brollIntent/u);
  assert.match(prompt, /queryEnglish/u);
  assert.match(prompt, /brollSrc.*не используй/u);
});

test('normalizer derives intent meaning from scene speech only when both queries are explicit', () => {
  const context = {
    source: 'input/source.mp4', theme: 'lesson-neutral', title: 'B-ROLL INTENT',
    output: { aspect: 'horizontal', width: 1920, height: 1080, fps: 25, durationInFrames: 100 },
    dictionaryCorrections: [], availableBroll: [],
  };
  const brief = normalizeGeneratedBrief({ scenes: [{
    scene: 'broll', start: 0, end: 4,
    headCream: 'БОЛЬШАЯ', headOrange: 'ЗАДАЧА',
    sub: 'Я раскладываю большую задачу на маленькие шаги',
    brollIntent: {
      queryOriginal: 'человек планирует задачи за ноутбуком',
      queryEnglish: 'person planning tasks on laptop',
    },
  }] }, context);
  assert.equal(brief.scenes[0].scene, 'broll');
  assert.equal(brief.scenes[0].brollIntent.goal, 'БОЛЬШАЯ ЗАДАЧА');
  assert.equal(brief.scenes[0].brollIntent.sourceText, 'Я раскладываю большую задачу на маленькие шаги');

  const missingQuery = normalizeGeneratedBrief({ scenes: [{
    scene: 'broll', start: 0, end: 4,
    headCream: 'БОЛЬШАЯ', headOrange: 'ЗАДАЧА', sub: 'Точная речь',
    brollIntent: { queryOriginal: 'явный запрос' },
  }] }, context);
  assert.equal(missingQuery.scenes[0].scene, 'split');
  assert.equal(missingQuery.scenes[0].brollIntent, undefined);
});

test('set-broll-query has an exact shape and retains transcript-derived intent fields', () => {
  const before = makeBrief();
  const after = applyReviewCommand({ brief: before, assets: new Map(), fps: 25, command: {
    type: 'set-broll-query', sceneIndex: 0,
    queryOriginal: 'новый запрос', queryEnglish: 'new query',
  } });
  assert.deepEqual(after.scenes[0].brollIntent, {
    ...intent, queryOriginal: 'новый запрос', queryEnglish: 'new query',
  });
  assert.deepEqual(diffLessonBrief({ before, after }), [{
    kind: 'broll-query', scene: 0,
    from: { queryOriginal: intent.queryOriginal, queryEnglish: intent.queryEnglish },
    to: { queryOriginal: 'новый запрос', queryEnglish: 'new query' },
  }]);
  assert.throws(() => applyReviewCommand({ brief: before, assets: new Map(), fps: 25, command: {
    type: 'set-broll-query', sceneIndex: 0,
    queryOriginal: 'новый запрос', queryEnglish: 'new query', source: 'other.mp4',
  } }), /shape|command/i);
  assert.throws(() => applyReviewCommand({ brief: before, assets: new Map(), fps: 25, command: {
    type: 'set-broll-query', sceneIndex: 0,
    queryOriginal: 'bad\u0001query', queryEnglish: 'new query',
  } }), /query|command/i);
  assert.throws(() => applyReviewCommand({ brief: before, assets: new Map(), fps: 25, command: {
    type: 'set-broll-query', sceneIndex: 0,
    queryOriginal: 'новый запрос', queryEnglish: '   ',
  } }), /query|command/i);
});

test('query edits require a b-roll scene with intent and replacement keeps intent', () => {
  const nonBroll = makeBrief({ scenes: [{ scene: 'fullscreen', start: 0, end: 4, caption: 'TEXT' }] });
  assert.throws(() => applyReviewCommand({ brief: nonBroll, assets: new Map(), fps: 25, command: {
    type: 'set-broll-query', sceneIndex: 0, queryOriginal: 'запрос', queryEnglish: 'query',
  } }), /broll|intent|command/i);
  const assets = new Map([['asset-2', {
    mediaKind: 'image', reference: 'assets/broll/second.webp', canonicalSha256: '2'.repeat(64),
    capabilities: { brollImage: true, brollVideo: false },
  }]]);
  const selected = applyReviewCommand({ brief: makeBrief(), assets, fps: 25, command: {
    type: 'replace-broll', sceneIndex: 0, assetId: 'asset-2',
  } });
  assert.deepEqual(selected.scenes[0].brollIntent, intent);
});

test('diff permits the discovery policy marker while rejecting arbitrary top-level changes', () => {
  const before = makeBrief();
  delete before.brollReviewPolicy;
  const after = structuredClone(before);
  after.brollReviewPolicy = 'preview-required';
  assert.deepEqual(diffLessonBrief({ before, after }), []);
  after.title = 'CHANGED';
  assert.throws(() => diffLessonBrief({ before, after }), /unsupported/i);
});

test('diff rejects intent fields other than the two editable queries', () => {
  const before = makeBrief();
  const after = structuredClone(before);
  after.scenes[0].brollIntent.extra = 'must not cross the allowlist';
  assert.throws(() => diffLessonBrief({ before, after }), /unsupported/i);
});

test('workspace approval rejects pending intent and strips resolved intent while preserving policy', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-broll-intent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'source.mp4');
  fs.writeFileSync(sourcePath, 'source');
  const workspace = createOrOpenProject({
    projectDir: path.join(root, 'project'), name: 'intent', sourcePath,
    now: new Date('2026-09-08T10:00:00.000Z'),
  });
  const paths = nextBriefPaths(workspace);
  const pending = makeBrief({ source: workspace.sourcePath });
  fs.writeFileSync(paths.jsonPath, `${JSON.stringify(pending, null, 2)}\n`);
  fs.writeFileSync(paths.markdownPath, formatBriefMarkdown(pending));
  recordBrief(workspace, {
    revision: paths.revision, jsonPath: paths.jsonPath, markdownPath: paths.markdownPath,
    status: 'draft', theme: pending.theme, aspect: pending.output.aspect,
  });
  assert.throws(() => approveBrief(workspace, paths.jsonPath), /unresolved.*intent/i);

  const imagePath = path.join(workspace.dir, 'assets', 'broll', 'resolved.png');
  fs.writeFileSync(imagePath, 'image');
  pending.scenes[0].brollSrc = 'assets/broll/resolved.png';
  fs.writeFileSync(paths.jsonPath, `${JSON.stringify(pending, null, 2)}\n`);
  const {planPreview,publishCurrentPreview} = require('../scripts/project/preview-workspace');
  const plan = planPreview(workspace,{briefPath:paths.jsonPath,briefSha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(paths.jsonPath)).digest('hex'),range:{kind:'full',fromSec:0,toSec:4}});
  const staged = path.join(workspace.dir,'previews','stage.mp4'); fs.writeFileSync(staged,'preview fixture');
  publishCurrentPreview(workspace,plan,staged,{width:1920,height:1080,fps:25,generatedAt:new Date().toISOString()});
  const approved = approveBrief(workspace, paths.jsonPath,{confirmPreviewViewed:true});
  const approvedBrief = JSON.parse(fs.readFileSync(approved.jsonPath, 'utf8'));
  assert.equal(approvedBrief.brollReviewPolicy, 'preview-required');
  assert.equal(approvedBrief.scenes[0].brollIntent, undefined);
  assert.equal(validateLessonBrief(approvedBrief, { requireApproved: true }).ok, true);
});
