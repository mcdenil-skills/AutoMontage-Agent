const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { formatBriefMarkdown } = require('../scripts/lesson/brief');
const { resolvePersistedBrollMedia } = require('../scripts/lesson/broll-media-files');

const {
  approveBrief,
  createOrOpenProject,
  formatProjectId,
  nextBriefPaths,
  nextRenderPaths,
  publishFinal,
  publishBriefRevision,
  readProjectManifest,
  recordBrief,
  recordRender,
  resolveProjectPath,
  runRenderLifecycle,
  slugifyProjectName,
  writeProjectManifest,
} = require('../scripts/project/workspace');
const { prepareLessonRender } = require('../scripts/lesson/workflow');

function makeFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-project-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'camera.MP4');
  fs.writeFileSync(sourcePath, 'video');
  return { dir, sourcePath };
}

test('project id uses a full dotted date and latin slug', () => {
  assert.equal(formatProjectId({
    date: new Date('2026-08-05T12:00:00Z'),
    name: 'Монтаж Claude Code',
  }), '2026.08.05_montazh-claude-code');
});

test('project slug rejects a name with no letters or digits', () => {
  assert.throws(() => slugifyProjectName('...'), /названи/);
});

test('manifest rejects traversal and non-canonical final paths without touching an outside file', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Manifest paths',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const sentinelPath = path.join(fixture.dir, 'outside.mp4');
  fs.writeFileSync(sentinelPath, 'do-not-touch');
  const maliciousPaths = [
    '../../outside.mp4',
    '../outside.mp4',
    '/tmp/outside.mp4',
    'C:\\temp\\outside.mp4',
    'C:outside.mp4',
    '..\\..\\outside.mp4',
    'renders/../outside.mp4',
    'renders//final.mp4',
  ];

  for (const maliciousPath of maliciousPaths) {
    const manifest = { ...workspace.manifest, final: maliciousPath };
    fs.writeFileSync(
      path.join(workspace.dir, 'project.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    assert.throws(
      () => readProjectManifest(workspace.dir),
      /final/,
      `read rejects ${JSON.stringify(maliciousPath)} with the field name`,
    );
    assert.throws(
      () => writeProjectManifest(workspace.dir, manifest),
      /final/,
      `write rejects ${JSON.stringify(maliciousPath)} with the field name`,
    );
    assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'do-not-touch');
  }

  const validManifest = { ...workspace.manifest, final: 'renders/final/final.mp4' };
  fs.writeFileSync(
    path.join(workspace.dir, 'project.json'),
    `${JSON.stringify(validManifest, null, 2)}\n`,
  );
  assert.equal(readProjectManifest(workspace.dir).final, 'renders/final/final.mp4');
});

test('manifest rejects a final path that escapes through a symbolic link', (t) => {
  const fixture = makeFixture(t);
  const projectDir = path.join(fixture.dir, 'project');
  const workspace = createOrOpenProject({
    projectDir,
    name: 'Symbolic link',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const outsideDir = path.join(fixture.dir, 'outside');
  fs.mkdirSync(outsideDir);
  fs.symlinkSync('../../outside', path.join(workspace.dir, 'renders', 'link'), 'dir');
  const manifest = { ...workspace.manifest, final: 'renders/link/final.mp4' };
  fs.writeFileSync(
    path.join(workspace.dir, 'project.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  assert.throws(() => readProjectManifest(workspace.dir), /final.*symbolic link/i);
  assert.equal(fs.existsSync(path.join(outsideDir, 'final.mp4')), false);
});

test('project paths reject dangling final and intermediate symlinks before creating outside data', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    projectDir: path.join(fixture.dir, 'project'),
    name: 'Dangling links',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const outsideFinal = path.join(fixture.dir, 'outside-final.json');
  const outsideDirectory = path.join(fixture.dir, 'outside-directory');
  fs.symlinkSync(outsideFinal, path.join(workspace.dir, 'brief', 'dangling-final.json'));
  fs.symlinkSync(outsideDirectory, path.join(workspace.dir, 'renders', 'dangling-dir'));

  assert.throws(
    () => resolveProjectPath(workspace.dir, 'brief/dangling-final.json', { mustExist: false }),
    /symbolic link/i,
  );
  assert.throws(
    () => resolveProjectPath(workspace.dir, 'renders/dangling-dir/owned.json', { mustExist: false }),
    /symbolic link/i,
  );
  assert.equal(fs.existsSync(outsideFinal), false);
  assert.equal(fs.existsSync(outsideDirectory), false);
});

test('manifest write ignores a predictable temp symlink and publishes a regular manifest', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    projectDir: path.join(fixture.dir, 'project'),
    name: 'Safe manifest temp',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const sentinel = path.join(fixture.dir, 'manifest-sentinel.json');
  fs.writeFileSync(sentinel, 'outside-must-survive');
  fs.symlinkSync(sentinel, path.join(workspace.dir, 'project.json.tmp'));

  const updated = { ...workspace.manifest, updatedAt: '2026-08-06T00:00:00.000Z' };
  writeProjectManifest(workspace.dir, updated, { expectedManifest: workspace.manifest });

  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside-must-survive');
  assert.equal(fs.lstatSync(path.join(workspace.dir, 'project.json')).isFile(), true);
  assert.equal(fs.lstatSync(path.join(workspace.dir, 'project.json')).isSymbolicLink(), false);
  assert.equal(readProjectManifest(workspace.dir).updatedAt, updated.updatedAt);
});

test('manifest rejects non-canonical slugs and accepts canonical lowercase tokens', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    projectDir: path.join(fixture.dir, 'project'),
    name: 'Canonical slug',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });

  for (const slug of ['../outside', 'nested/slug', 'Uppercase', 'two--hyphens', '-leading']) {
    assert.throws(
      () => writeProjectManifest(workspace.dir, { ...workspace.manifest, slug }),
      /manifest\/slug/,
      slug,
    );
  }
  assert.doesNotThrow(() => writeProjectManifest(workspace.dir, {
    ...workspace.manifest,
    slug: 'safe-project-01',
  }, { expectedManifest: workspace.manifest }));
});

test('manifest migration adds the canonical transcript paths before validation', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Legacy manifest',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const legacyManifest = { ...workspace.manifest };
  delete legacyManifest.transcript;
  fs.writeFileSync(
    path.join(workspace.dir, 'project.json'),
    `${JSON.stringify(legacyManifest, null, 2)}\n`,
  );

  assert.deepEqual(readProjectManifest(workspace.dir).transcript, {
    words: 'transcript/words.json',
    captions: 'transcript/captions.js',
  });
});

test('new motion projects persist project, source and brief discriminators', (t) => {
  const fixture = makeFixture(t);
  const narrationPath = path.join(fixture.dir, 'narration.mp3');
  fs.writeFileSync(narrationPath, 'audio');
  const project = createOrOpenProject({
    projectDir: path.join(fixture.dir, 'motion-project'),
    name: 'Motion project',
    sourcePath: narrationPath,
    projectKind: 'motion-reel',
    mediaKind: 'audio',
    now: new Date('2026-09-08T10:00:00Z'),
  });
  const brief = {
    version: 1,
    kind: 'motion-reel',
    status: 'draft',
    source: 'input/source.mp3',
    theme: 'motion-neutral',
    title: 'Motion contract',
    output: { aspect: 'vertical', width: 1080, height: 1920, fps: 30, durationInFrames: 90 },
    scenes: [{ scene: 'kinetic-title', start: 0, end: 3, text: 'Движение' }],
  };

  assert.throws(() => publishBriefRevision(project, {
    kind: 'motion-reel',
    brief: { ...brief, status: 'approved' },
  }), /draft/i);
  assert.equal(project.manifest.briefs.length, 0);

  const published = publishBriefRevision(project, {
    kind: 'motion-reel',
    brief,
    markdown: '# Wrong lesson formatter\n',
  });

  assert.equal(project.manifest.projectKind, 'motion-reel');
  assert.equal(project.manifest.source.mediaKind, 'audio');
  assert.equal(project.manifest.briefs[0].kind, 'motion-reel');
  assert.equal(path.basename(project.manifest.currentBrief), 'v01-draft.motion.json');
  assert.match(fs.readFileSync(published.markdownPath, 'utf8'), /^# Motion Reel: Motion contract$/m);
});

test('old manifests infer video, video and lesson without rewriting project.json', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    projectDir: path.join(fixture.dir, 'legacy-project'),
    name: 'Legacy project',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-09-08T10:00:00Z'),
  });
  const draft = nextBriefPaths(workspace);
  fs.writeFileSync(draft.jsonPath, '{}');
  fs.writeFileSync(draft.markdownPath, '# Legacy\n');
  recordBrief(workspace, {
    revision: draft.revision,
    jsonPath: draft.jsonPath,
    markdownPath: draft.markdownPath,
    status: 'draft',
  });
  const manifestPath = path.join(workspace.dir, 'project.json');
  const legacy = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  delete legacy.projectKind;
  delete legacy.source.mediaKind;
  for (const entry of legacy.briefs) delete entry.kind;
  fs.writeFileSync(manifestPath, `${JSON.stringify(legacy, null, 2)}\n`);
  const bytesBefore = fs.readFileSync(manifestPath);

  const reopened = createOrOpenProject({ projectDir: workspace.dir });

  assert.equal(reopened.manifest.projectKind, 'video');
  assert.equal(reopened.manifest.source.mediaKind, 'video');
  assert.equal(reopened.manifest.briefs[0].kind, 'lesson');
  assert.deepEqual(fs.readFileSync(manifestPath), bytesBefore);
});

test('manifest rejects traversal in every workspace-owned path field', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Every manifest path',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const brief = {
    revision: 1,
    jsonPath: 'brief/v01.lesson.json',
    markdownPath: 'brief/v01.lesson.md',
    status: 'draft',
    theme: null,
    aspect: null,
  };
  const render = {
    version: 1,
    label: 'complete',
    dir: 'renders/v01-complete',
    briefPath: 'brief/v01.lesson.json',
    status: 'complete',
  };
  const cases = [
    ['manifest.source.localPath', (manifest) => { manifest.source.localPath = '../../sentinel.mp4'; }],
    ['manifest.transcript.words', (manifest) => { manifest.transcript.words = '../../sentinel.mp4'; }],
    ['manifest.transcript.captions', (manifest) => { manifest.transcript.captions = '../../sentinel.mp4'; }],
    ['manifest.briefs[0].jsonPath', (manifest) => {
      manifest.briefs = [{ ...brief, jsonPath: '../../sentinel.mp4' }];
    }],
    ['manifest.briefs[0].markdownPath', (manifest) => {
      manifest.briefs = [{ ...brief, markdownPath: '../../sentinel.mp4' }];
    }],
    ['manifest.currentBrief', (manifest) => {
      manifest.briefs = [{ ...brief, jsonPath: '../../sentinel.mp4' }];
      manifest.currentBrief = '../../sentinel.mp4';
    }],
    ['manifest.currentPreview.filePath', (manifest) => {
      manifest.currentPreview = {
        filePath: '../../sentinel.mp4', briefPath: 'brief/v01-draft.lesson.json',
        kind: 'full', fromSec: 0, toSec: 4, width: 960, height: 540, fps: 25,
        generatedAt: '2026-08-23T17:05:00.000Z', sha256: 'a'.repeat(64),
      };
    }],
    ['manifest.currentPreview.briefPath', (manifest) => {
      manifest.currentPreview = {
        filePath: 'previews/v01-draft-full.mp4', briefPath: '../../sentinel.json',
        kind: 'full', fromSec: 0, toSec: 4, width: 960, height: 540, fps: 25,
        generatedAt: '2026-08-23T17:05:00.000Z', sha256: 'a'.repeat(64),
      };
    }],
    ['manifest.renders[0].dir', (manifest) => {
      manifest.renders = [{ ...render, dir: '../../sentinel.mp4' }];
    }],
    ['manifest.renders[0].briefPath', (manifest) => {
      manifest.renders = [{ ...render, briefPath: '../../sentinel.mp4' }];
    }],
    ['manifest.latestRender', (manifest) => {
      manifest.renders = [{ ...render, dir: '../../sentinel.mp4' }];
      manifest.latestRender = '../../sentinel.mp4';
    }],
    ['manifest.final', (manifest) => { manifest.final = '../../sentinel.mp4'; }],
  ];

  for (const [label, mutate] of cases) {
    const manifest = JSON.parse(JSON.stringify(workspace.manifest));
    mutate(manifest);
    assert.throws(() => writeProjectManifest(workspace.dir, manifest), new RegExp(label.replace(/[.[\]]/g, '\\$&')));
  }
});

test('project creation copies one source and creates the full workspace', (t) => {
  const fixture = makeFixture(t);
  const baseDir = path.join(fixture.dir, 'projects');
  const workspace = createOrOpenProject({
    baseDir,
    name: 'Тест ролик',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });

  assert.equal(path.basename(workspace.dir), '2026.08.05_test-rolik');
  assert.equal(fs.readFileSync(workspace.sourcePath, 'utf8'), 'video');
  assert.ok(fs.existsSync(path.join(workspace.dir, 'assets/music')));
  assert.ok(fs.existsSync(path.join(workspace.dir, 'assets/broll')));
  assert.ok(fs.existsSync(path.join(workspace.dir, 'brief')));
  assert.ok(fs.existsSync(path.join(workspace.dir, 'transcript')));
  assert.ok(fs.existsSync(path.join(workspace.dir, 'previews')));
  assert.ok(fs.existsSync(path.join(workspace.dir, 'renders')));
  assert.ok(fs.existsSync(path.join(workspace.dir, 'final')));
  assert.equal(workspace.manifest.source.localPath, 'input/source.mp4');
  assert.equal(workspace.manifest.transcript.words, 'transcript/words.json');
  assert.equal(workspace.manifest.transcript.captions, 'transcript/captions.js');
  assert.equal(readProjectManifest(workspace.dir).id, '2026.08.05_test-rolik');
});

test('existing project opens without copying its source again', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Test reel',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  fs.writeFileSync(workspace.sourcePath, 'kept');

  const reopened = createOrOpenProject({ projectDir: workspace.dir });

  assert.equal(reopened.dir, workspace.dir);
  assert.equal(fs.readFileSync(reopened.sourcePath, 'utf8'), 'kept');
});

test('existing project rejects a different source', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Test reel',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const otherSource = path.join(fixture.dir, 'other.mp4');
  fs.writeFileSync(otherSource, 'other');

  assert.throws(
    () => createOrOpenProject({ projectDir: workspace.dir, sourcePath: otherSource }),
    /другой исходник/,
  );
});

test('first brief and render allocation reject project directory symlinks before writing outside', (t) => {
  const fixture = makeFixture(t);

  for (const [directory, allocate] of [
    ['brief', (workspace) => nextBriefPaths(workspace)],
    ['renders', (workspace) => nextRenderPaths(workspace, 'First')],
  ]) {
    const workspace = createOrOpenProject({
      baseDir: path.join(fixture.dir, 'projects'),
      name: `Symlink ${directory}`,
      sourcePath: fixture.sourcePath,
      now: new Date('2026-08-05T12:00:00Z'),
    });
    const outsideDir = path.join(fixture.dir, `outside-${directory}`);
    const sentinelPath = path.join(outsideDir, 'sentinel.txt');
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(sentinelPath, `outside-${directory}`);
    fs.rmdirSync(path.join(workspace.dir, directory));
    fs.symlinkSync(outsideDir, path.join(workspace.dir, directory), 'dir');

    assert.throws(() => createOrOpenProject({ projectDir: workspace.dir }), /symbolic link/i);
    assert.throws(() => allocate(workspace), /symbolic link/i);
    assert.equal(fs.readFileSync(sentinelPath, 'utf8'), `outside-${directory}`);
    assert.deepEqual(fs.readdirSync(outsideDir), ['sentinel.txt']);
  }
});

test('brief revisions advance from manifest history', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Versioned brief',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });

  const first = nextBriefPaths(workspace);
  assert.equal(path.basename(first.jsonPath), 'v01-draft.lesson.json');
  assert.equal(path.basename(first.markdownPath), 'v01-draft.lesson.md');

  recordBrief(workspace, {
    revision: first.revision,
    jsonPath: first.jsonPath,
    markdownPath: first.markdownPath,
    status: 'draft',
    theme: 'lesson-neutral',
    aspect: 'source',
  });

  assert.equal(path.basename(nextBriefPaths(workspace).jsonPath), 'v02-draft.lesson.json');
  const manifest = readProjectManifest(workspace.dir);
  assert.equal(manifest.currentBrief, 'brief/v01-draft.lesson.json');
  assert.equal(manifest.briefs[0].theme, 'lesson-neutral');
});

test('approval freezes a reviewed draft under an approved filename', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Approved brief',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const draft = nextBriefPaths(workspace);
  const draftBrief = {
    version: 1,
    status: 'draft',
    source: fixture.sourcePath,
    theme: 'lesson-neutral',
    title: 'Утверждённый brief',
    output: {
      aspect: 'horizontal',
      width: 1920,
      height: 1080,
      fps: 30,
      durationInFrames: 240,
    },
    corrections: [],
    scenes: [{ scene: 'fullscreen', start: 0, end: 8, caption: 'УТВЕРЖДЕНО' }],
  };
  fs.writeFileSync(draft.jsonPath, JSON.stringify(draftBrief));
  fs.writeFileSync(draft.markdownPath, formatBriefMarkdown(draftBrief));
  recordBrief(workspace, {
    revision: draft.revision,
    jsonPath: draft.jsonPath,
    markdownPath: draft.markdownPath,
    status: 'draft',
  });

  const approved = approveBrief(workspace, draft.jsonPath);

  assert.equal(path.basename(approved.jsonPath), 'v01-approved.lesson.json');
  assert.equal(path.basename(approved.markdownPath), 'v01-approved.lesson.md');
  assert.equal(JSON.parse(fs.readFileSync(approved.jsonPath, 'utf8')).status, 'approved');
  const markdown = fs.readFileSync(approved.markdownPath, 'utf8');
  assert.match(markdown, /^Статус: `approved`$/m);
  assert.equal((markdown.match(/^Статус:/gm) || []).length, 1);
  assert.doesNotMatch(markdown, /^Статус: `draft`$/m);
  assert.equal(
    readProjectManifest(workspace.dir).currentBrief,
    'brief/v01-approved.lesson.json',
  );
});

test('approval leaves no outputs when approved Markdown generation fails', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Malformed approved brief',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const draft = nextBriefPaths(workspace);
  fs.writeFileSync(draft.jsonPath, JSON.stringify({
    version: 1,
    status: 'draft',
    source: fixture.sourcePath,
    theme: 'lesson-neutral',
    title: 'Некорректная геометрия',
    output: { width: 1920, height: 1080, fps: 30, durationInFrames: 240 },
    corrections: [],
    scenes: [{ scene: 'fullscreen', start: 0, end: 8, caption: 'ТЕСТ' }],
  }));
  fs.writeFileSync(draft.markdownPath, 'Статус: `draft`\n');
  recordBrief(workspace, {
    revision: draft.revision,
    jsonPath: draft.jsonPath,
    markdownPath: draft.markdownPath,
    status: 'draft',
  });

  assert.throws(() => approveBrief(workspace, draft.jsonPath), /aspect/);

  const approvedJsonPath = draft.jsonPath.replace('-draft.lesson.json', '-approved.lesson.json');
  const approvedMarkdownPath = draft.markdownPath.replace('-draft.lesson.md', '-approved.lesson.md');
  assert.equal(fs.existsSync(approvedJsonPath), false);
  assert.equal(fs.existsSync(approvedMarkdownPath), false);
  const manifest = readProjectManifest(workspace.dir);
  assert.equal(manifest.briefs.length, 1);
  assert.equal(manifest.briefs[0].status, 'draft');
  assert.equal(manifest.currentBrief, 'brief/v01-draft.lesson.json');
});

function makeApprovalFailureFixture(t, name) {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    projectDir: path.join(fixture.dir, `project-${name}`),
    name,
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const draft = nextBriefPaths(workspace);
  const brief = {
    version: 1,
    status: 'draft',
    source: fixture.sourcePath,
    theme: 'lesson-neutral',
    title: 'Atomic approval',
    output: {
      aspect: 'horizontal',
      width: 1920,
      height: 1080,
      fps: 30,
      durationInFrames: 240,
    },
    corrections: [],
    scenes: [{ scene: 'fullscreen', start: 0, end: 8, caption: 'SAFE' }],
  };
  fs.writeFileSync(draft.jsonPath, `${JSON.stringify(brief, null, 2)}\n`);
  fs.writeFileSync(draft.markdownPath, formatBriefMarkdown(brief));
  recordBrief(workspace, {
    revision: draft.revision,
    jsonPath: draft.jsonPath,
    markdownPath: draft.markdownPath,
    status: 'draft',
    theme: 'lesson-neutral',
    aspect: 'horizontal',
  });
  return {
    fixture,
    workspace,
    draft,
    approvedJson: draft.jsonPath.replace('-draft.lesson.json', '-approved.lesson.json'),
    approvedMarkdown: draft.markdownPath.replace('-draft.lesson.md', '-approved.lesson.md'),
  };
}

function writeApprovalImportedAsset(state, {
  kind,
  id = '4af36be4-0b26-4e6f-bd48-8bdd2215a4f1',
  durationSec = 10,
  hasAudio = true,
  audioDurationSec = hasAudio ? durationSec : null,
  fps = 30,
} = {}) {
  const mediaType = kind === 'image' ? 'images' : 'video';
  const filename = kind === 'image' ? 'media.webp' : 'media.mp4';
  const directory = path.join(
    state.workspace.dir, 'assets', 'broll', mediaType, id,
  );
  fs.mkdirSync(directory, { recursive: true });
  const canonical = Buffer.from(`normalized-${kind}-bytes`);
  const canonicalPath = path.join(directory, filename);
  fs.writeFileSync(canonicalPath, canonical);
  let previewPath = null;
  let previewSha256 = null;
  if (kind === 'video') {
    previewPath = path.join(state.workspace.dir, 'previews', 'broll', `${id}.webm`);
    fs.mkdirSync(path.dirname(previewPath), { recursive: true });
    const preview = Buffer.from('normalized-video-proxy');
    fs.writeFileSync(previewPath, preview);
    previewSha256 = crypto.createHash('sha256').update(preview).digest('hex');
  }
  const metadata = {
    version: 2,
    id,
    label: kind === 'image' ? 'diagram.png' : 'demo.mov',
    mediaKind: kind,
    canonicalSha256: crypto.createHash('sha256').update(canonical).digest('hex'),
    previewSha256,
    width: 640,
    height: 360,
    fps: kind === 'image' ? 0 : fps,
    durationSec: kind === 'image' ? 0 : durationSec,
    audioDurationSec: kind === 'image' ? null : audioDurationSec,
    hasAudio: kind === 'image' ? false : hasAudio,
  };
  const metadataPath = path.join(directory, 'asset.json');
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`);
  return {
    canonicalPath,
    metadata,
    metadataPath,
    previewPath,
    reference: `assets/broll/${mediaType}/${id}/${filename}`,
  };
}

function setApprovalBrollMedia(state, asset, overrides = {}) {
  const brief = JSON.parse(fs.readFileSync(state.draft.jsonPath, 'utf8'));
  brief.scenes = [{
    scene: 'broll',
    start: 0,
    end: 8,
    brollMedia: asset.metadata.mediaKind === 'video'
      ? {
        kind: 'video',
        src: asset.reference,
        sha256: asset.metadata.canonicalSha256,
        trimStartSec: 0,
        fit: 'contain',
        audioMode: 'replace',
        ...overrides,
      }
      : {
        kind: 'image',
        src: asset.reference,
        sha256: asset.metadata.canonicalSha256,
        fit: 'cover',
        ...overrides,
      },
    headCream: 'ПРОВЕРЕННОЕ',
    headOrange: 'МЕДИА',
  }];
  fs.writeFileSync(state.draft.jsonPath, `${JSON.stringify(brief, null, 2)}\n`);
  return brief;
}

function setRepeatedApprovalBrollMedia(state, asset, trimStarts) {
  const brief = JSON.parse(fs.readFileSync(state.draft.jsonPath, 'utf8'));
  brief.scenes = trimStarts.map((trimStartSec, index) => ({
    scene: 'broll',
    start: index * 0.5,
    end: (index + 1) * 0.5,
    brollMedia: {
      kind: 'video',
      src: asset.reference,
      sha256: asset.metadata.canonicalSha256,
      trimStartSec,
      fit: index % 2 === 0 ? 'contain' : 'cover',
      audioMode: index % 2 === 0 ? 'replace' : 'mix',
    },
    headCream: `ПОВТОР ${index + 1}`,
    headOrange: 'МЕДИА',
  }));
  fs.writeFileSync(state.draft.jsonPath, `${JSON.stringify(brief, null, 2)}\n`);
  return brief;
}

function monitorApprovalMediaDescriptors(asset) {
  const watched = new Set([
    asset.canonicalPath,
    asset.metadataPath,
    asset.previewPath,
  ].map((target) => path.resolve(target)));
  const descriptors = new Map();
  const counts = new Map([...watched].map((target) => [target, 0]));
  let active = 0;
  let maxActive = 0;
  return {
    fileSystem: {
      ...fs,
      openSync(target, flags, mode) {
        const descriptor = fs.openSync(target, flags, mode);
        const resolved = path.resolve(String(target));
        if (watched.has(resolved)) {
          descriptors.set(descriptor, resolved);
          counts.set(resolved, counts.get(resolved) + 1);
          active += 1;
          maxActive = Math.max(maxActive, active);
        }
        return descriptor;
      },
      closeSync(descriptor) {
        if (descriptors.delete(descriptor)) active -= 1;
        return fs.closeSync(descriptor);
      },
    },
    assertBounded() {
      assert.deepEqual([...counts.values()], [1, 1, 1]);
      assert.equal(maxActive, 3);
      assert.equal(active, 0);
    },
  };
}

function approvalProbe(metadata) {
  return (command, args, options) => {
    assert.equal(command, 'ffprobe');
    assert.equal(args.at(-1), 'pipe:0');
    assert.equal(options.shell, false);
    assert.equal(options.stdio.length, 3);
    assert.equal(options.stdio[0] >= 0, true);
    const video = {
      codec_type: 'video',
      codec_name: metadata.mediaKind === 'image' ? 'webp' : 'h264',
      width: metadata.width,
      height: metadata.height,
      avg_frame_rate: metadata.mediaKind === 'image' ? '25/1' : `${metadata.fps}/1`,
      r_frame_rate: metadata.mediaKind === 'image' ? '25/1' : `${metadata.fps}/1`,
      ...(metadata.mediaKind === 'video' ? { duration: String(metadata.durationSec) } : {}),
      pix_fmt: 'yuv420p',
      disposition: { attached_pic: 0 },
    };
    const streams = metadata.hasAudio
      ? [video, {
        codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2,
        duration: String(metadata.audioDurationSec),
      }]
      : [video];
    return {
      status: 0,
      signal: null,
      stdout: JSON.stringify({
        streams,
        format: {
          format_name: metadata.mediaKind === 'image' ? 'webp_pipe' : 'mov,mp4,m4a,3gp,3g2,mj2',
          duration: metadata.mediaKind === 'image' ? undefined : String(metadata.durationSec),
        },
      }),
      stderr: '',
    };
  };
}

test('approval accepts verified normalized image and video b-roll', async (t) => {
  for (const kind of ['image', 'video']) {
    await t.test(kind, () => {
      const state = makeApprovalFailureFixture(t, `approved-${kind}-media`);
      const asset = writeApprovalImportedAsset(state, { kind });
      const draft = setApprovalBrollMedia(state, asset);
      const draftBytes = fs.readFileSync(state.draft.jsonPath);

      const approved = approveBrief(state.workspace, state.draft.jsonPath, {
        root: path.resolve(__dirname, '..'),
        runToolImpl: approvalProbe(asset.metadata),
      });

      assert.deepEqual(
        JSON.parse(fs.readFileSync(approved.jsonPath, 'utf8')).scenes[0].brollMedia,
        draft.scenes[0].brollMedia,
      );
      assert.deepEqual(fs.readFileSync(state.draft.jsonPath), draftBytes);
      assert.equal(JSON.parse(draftBytes).status, 'draft');
    });
  }
});

test('approval deduplicates repeated immutable media while validating every scene trim', async (t) => {
  for (const item of [
    { name: 'valid differing trims', trims: [0, 1, 2, 3.5], rejects: false },
    { name: 'one overrun trim', trims: [0, 1, 3.6], rejects: true },
  ]) {
    await t.test(item.name, () => {
      const state = makeApprovalFailureFixture(t, `repeated-${item.name.replaceAll(' ', '-')}`);
      const asset = writeApprovalImportedAsset(state, {
        kind: 'video', durationSec: 4, hasAudio: true,
      });
      setRepeatedApprovalBrollMedia(state, asset, item.trims);
      const monitor = monitorApprovalMediaDescriptors(asset);
      const probe = approvalProbe(asset.metadata);
      let probeCalls = 0;
      const options = {
        root: path.resolve(__dirname, '..'),
        fileSystem: monitor.fileSystem,
        runToolImpl(command, args, processOptions) {
          probeCalls += 1;
          return probe(command, args, processOptions);
        },
      };

      if (item.rejects) {
        assertApprovalMediaFailure(state, options, APPROVAL_MEDIA_ERRORS.clip);
      } else {
        const approved = approveBrief(state.workspace, state.draft.jsonPath, options);
        assert.equal(JSON.parse(fs.readFileSync(approved.jsonPath, 'utf8')).scenes.length, 4);
      }
      assert.equal(probeCalls, 1);
      monitor.assertBounded();
    });
  }
});

const APPROVAL_MEDIA_ERRORS = {
  scene: [
    'BROLL_MEDIA_SCENE_INVALID',
    'BROLL_MEDIA_SCENE_INVALID: b-roll media is allowed only on a b-roll scene',
  ],
  path: [
    'BROLL_MEDIA_PATH_INVALID',
    'BROLL_MEDIA_PATH_INVALID: b-roll media reference is not allowed',
  ],
  missing: ['BROLL_MEDIA_MISSING', 'BROLL_MEDIA_MISSING: b-roll media file is missing'],
  hash: [
    'BROLL_MEDIA_HASH_MISMATCH',
    'BROLL_MEDIA_HASH_MISMATCH: b-roll media hash does not match the draft',
  ],
  symlink: [
    'BROLL_MEDIA_SYMLINK',
    'BROLL_MEDIA_SYMLINK: b-roll media path contains a symbolic link',
  ],
  metadata: [
    'BROLL_MEDIA_METADATA_MISMATCH',
    'BROLL_MEDIA_METADATA_MISMATCH: b-roll asset metadata does not match the media',
  ],
  metadataInvalid: [
    'BROLL_MEDIA_METADATA_INVALID',
    'BROLL_MEDIA_METADATA_INVALID: b-roll asset metadata is invalid',
  ],
  proxyMissing: [
    'BROLL_MEDIA_PROXY_MISSING',
    'BROLL_MEDIA_PROXY_MISSING: b-roll preview proxy is missing',
  ],
  proxyHash: [
    'BROLL_MEDIA_PROXY_HASH_MISMATCH',
    'BROLL_MEDIA_PROXY_HASH_MISMATCH: b-roll preview proxy hash is invalid',
  ],
  kind: [
    'BROLL_MEDIA_KIND_MISMATCH',
    'BROLL_MEDIA_KIND_MISMATCH: b-roll media kind does not match the draft',
  ],
  probe: [
    'BROLL_MEDIA_PROBE_FAILED',
    'BROLL_MEDIA_PROBE_FAILED: b-roll media could not be verified',
  ],
  clip: [
    'BROLL_MEDIA_CLIP_OVERRUN',
    'BROLL_MEDIA_CLIP_OVERRUN: b-roll video clip exceeds media duration',
  ],
  audio: [
    'BROLL_MEDIA_AUDIO_REQUIRED',
    'BROLL_MEDIA_AUDIO_REQUIRED: b-roll audio mode requires an audio stream',
  ],
};

test('persisted b-roll resolver contains paths and rejects ancestor symlinks', (t) => {
  const state = makeApprovalFailureFixture(t, 'persisted-media-paths');
  const repositoryRoot = path.join(state.fixture.dir, 'repository');
  const publicDirectory = path.join(repositoryRoot, 'public', 'broll');
  const projectMedia = path.join(state.workspace.dir, 'assets', 'broll', 'safe.webp');
  fs.mkdirSync(publicDirectory, { recursive: true });
  fs.mkdirSync(path.dirname(projectMedia), { recursive: true });
  fs.writeFileSync(path.join(publicDirectory, 'safe.webp'), 'public');
  fs.writeFileSync(projectMedia, 'project');
  const media = (src) => ({ kind: 'image', src, sha256: 'a'.repeat(64), fit: 'cover' });

  assert.equal(resolvePersistedBrollMedia({
    root: repositoryRoot, workspace: state.workspace, media: media('assets/broll/safe.webp'),
  }).filePath, projectMedia);
  assert.equal(resolvePersistedBrollMedia({
    root: repositoryRoot, workspace: state.workspace, media: media('broll/safe.webp'),
  }).filePath, path.join(publicDirectory, 'safe.webp'));

  for (const src of ['/tmp/outside.webp', 'assets/../input/source.mp4', 'C:\\outside.webp']) {
    let caught;
    assert.throws(() => resolvePersistedBrollMedia({
      root: repositoryRoot, workspace: state.workspace, media: media(src),
    }), (error) => {
      caught = error;
      return true;
    });
    assert.equal(caught.code, APPROVAL_MEDIA_ERRORS.path[0]);
    assert.equal(caught.message, APPROVAL_MEDIA_ERRORS.path[1]);
  }

  const outside = path.join(state.fixture.dir, 'outside-assets');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'escaped.webp'), 'outside');
  fs.symlinkSync(outside, path.join(state.workspace.dir, 'assets', 'linked'), 'dir');
  let caught;
  assert.throws(() => resolvePersistedBrollMedia({
    root: repositoryRoot,
    workspace: state.workspace,
    media: media('assets/linked/escaped.webp'),
  }), (error) => {
    caught = error;
    return true;
  });
  assert.equal(caught.code, APPROVAL_MEDIA_ERRORS.symlink[0]);
  assert.equal(caught.message, APPROVAL_MEDIA_ERRORS.symlink[1]);
  assert.equal(fs.readFileSync(path.join(outside, 'escaped.webp'), 'utf8'), 'outside');
});

function assertApprovalMediaFailure(state, options, expected) {
  const manifestPath = path.join(state.workspace.dir, 'project.json');
  const before = {
    draft: fs.readFileSync(state.draft.jsonPath),
    markdown: fs.readFileSync(state.draft.markdownPath),
    manifest: fs.readFileSync(manifestPath),
    briefEntries: fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort(),
  };
  let caught = null;
  assert.throws(() => approveBrief(state.workspace, state.draft.jsonPath, options), (error) => {
    caught = error;
    return true;
  });
  assert.equal(caught.code, expected[0]);
  assert.equal(caught.message, expected[1]);
  assert.deepEqual(fs.readFileSync(state.draft.jsonPath), before.draft);
  assert.equal(JSON.parse(before.draft).status, 'draft');
  assert.deepEqual(fs.readFileSync(state.draft.markdownPath), before.markdown);
  assert.deepEqual(fs.readFileSync(manifestPath), before.manifest);
  assert.deepEqual(fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort(), before.briefEntries);
  assert.equal(fs.existsSync(state.approvedJson), false);
  assert.equal(fs.existsSync(state.approvedMarkdown), false);
  assert.deepEqual(
    fs.readdirSync(state.workspace.dir).filter((entry) => entry.includes('.tmp-')),
    [],
  );
  assert.deepEqual(
    fs.readdirSync(path.join(state.workspace.dir, 'brief'))
      .filter((entry) => entry.includes('.tmp-')),
    [],
  );
}

test('approval rejects malformed non-array scenes through canonical brief validation', async (t) => {
  for (const [name, scenes] of [
    ['object', {}],
    ['string', 'not-an-array'],
    ['number', 42],
  ]) {
    await t.test(name, () => {
      const state = makeApprovalFailureFixture(t, `malformed-scenes-${name}`);
      const draft = JSON.parse(fs.readFileSync(state.draft.jsonPath, 'utf8'));
      draft.scenes = scenes;
      fs.writeFileSync(state.draft.jsonPath, `${JSON.stringify(draft, null, 2)}\n`);

      assertApprovalMediaFailure(state, {
        runToolImpl() {
          assert.fail('ffprobe must not run for a structurally invalid brief');
        },
      }, [undefined, 'draft brief is invalid: /scenes: must be array']);
    });
  }
});

test('approval rejects non-broll media fields before schema or publication', async (t) => {
  for (const field of ['brollSrc', 'brollMedia']) {
    await t.test(field, () => {
      const state = makeApprovalFailureFixture(t, `wrong-scene-${field}`);
      const draft = JSON.parse(fs.readFileSync(state.draft.jsonPath, 'utf8'));
      const asset = writeApprovalImportedAsset(state, { kind: 'image' });
      draft.scenes = [{
        scene: 'fullscreen',
        start: 0,
        end: 8,
        caption: 'SAFE FULLSCREEN',
        ...(field === 'brollSrc'
          ? { brollSrc: '../../outside.png' }
          : {
            brollMedia: {
              kind: 'image',
              src: asset.reference,
              sha256: asset.metadata.canonicalSha256,
              fit: 'cover',
            },
          }),
      }];
      fs.writeFileSync(state.draft.jsonPath, `${JSON.stringify(draft, null, 2)}\n`);

      assertApprovalMediaFailure(state, {
        root: path.resolve(__dirname, '..'),
        runToolImpl: approvalProbe(asset.metadata),
      }, APPROVAL_MEDIA_ERRORS.scene);
    });
  }
});

test('approval returns the exact path error for every unsafe persisted reference', async (t) => {
  const unsafeReferences = [
    '/tmp/outside.webp',
    'C:\\outside.webp',
    'https://example.invalid/outside.webp',
    'assets/broll/../outside.webp',
    'assets/broll/%2e%2e/outside.webp',
    'assets\\broll\\outside.webp',
    '/media/assets/asset-1',
  ];
  for (const [index, reference] of unsafeReferences.entries()) {
    await t.test(String(index), () => {
      const state = makeApprovalFailureFixture(t, `unsafe-approval-path-${index}`);
      const asset = writeApprovalImportedAsset(state, { kind: 'image' });
      setApprovalBrollMedia(state, asset, { src: reference });

      assertApprovalMediaFailure(state, {
        root: path.resolve(__dirname, '..'),
        runToolImpl: approvalProbe(asset.metadata),
      }, APPROVAL_MEDIA_ERRORS.path);
    });
  }
});

test('approval rejects each stale normalized b-roll condition with an exact reason', async (t) => {
  const cases = [
    {
      name: 'missing canonical',
      expected: APPROVAL_MEDIA_ERRORS.missing,
      mutate({ asset }) { fs.unlinkSync(asset.canonicalPath); },
    },
    {
      name: 'changed canonical hash',
      expected: APPROVAL_MEDIA_ERRORS.hash,
      mutate({ asset }) { fs.writeFileSync(asset.canonicalPath, 'replaced canonical bytes'); },
    },
    {
      name: 'final symlink',
      expected: APPROVAL_MEDIA_ERRORS.symlink,
      mutate({ asset, state }) {
        const outside = path.join(state.fixture.dir, 'outside-media.webp');
        fs.writeFileSync(outside, 'outside');
        fs.unlinkSync(asset.canonicalPath);
        fs.symlinkSync(outside, asset.canonicalPath);
      },
    },
    {
      name: 'wrong metadata fields',
      expected: APPROVAL_MEDIA_ERRORS.metadata,
      mutate({ asset }) {
        fs.writeFileSync(asset.metadataPath, `${JSON.stringify({
          ...asset.metadata, width: asset.metadata.width + 1,
        })}\n`);
      },
    },
    {
      name: 'invalid metadata shape',
      expected: APPROVAL_MEDIA_ERRORS.metadataInvalid,
      mutate({ asset }) {
        fs.writeFileSync(asset.metadataPath, `${JSON.stringify({
          ...asset.metadata, unexpected: true,
        })}\n`);
      },
    },
    {
      name: 'missing proxy',
      expected: APPROVAL_MEDIA_ERRORS.proxyMissing,
      mutate({ asset }) { fs.unlinkSync(asset.previewPath); },
    },
    {
      name: 'changed proxy hash',
      expected: APPROVAL_MEDIA_ERRORS.proxyHash,
      mutate({ asset }) { fs.writeFileSync(asset.previewPath, 'replaced proxy bytes'); },
    },
    {
      name: 'wrong probed kind',
      expected: APPROVAL_MEDIA_ERRORS.kind,
      probeMetadata(asset) {
        return { ...asset.metadata, mediaKind: 'image', hasAudio: false };
      },
    },
    {
      name: 'probe failure is bounded',
      expected: APPROVAL_MEDIA_ERRORS.probe,
      runTool() {
        return {
          status: 1,
          signal: null,
          stdout: '',
          stderr: '/private/project/assets/broll/video/media.mp4: secret decoder error',
        };
      },
    },
    {
      name: 'clip overrun',
      expected: APPROVAL_MEDIA_ERRORS.clip,
      assetOptions: { durationSec: 5 },
    },
    {
      name: 'sub-frame clip overrun',
      expected: APPROVAL_MEDIA_ERRORS.clip,
      assetOptions: { durationSec: 1, fps: 25 },
      mutate({ state }) {
        const draft = JSON.parse(fs.readFileSync(state.draft.jsonPath, 'utf8'));
        draft.output.fps = 25;
        draft.scenes[0].end = 0.01;
        draft.scenes[0].brollMedia.trimStartSec = 1;
        fs.writeFileSync(state.draft.jsonPath, `${JSON.stringify(draft, null, 2)}\n`);
      },
    },
    {
      name: 'replace without audio',
      expected: APPROVAL_MEDIA_ERRORS.audio,
      assetOptions: { hasAudio: false },
    },
    {
      name: 'replace beyond short audio',
      expected: APPROVAL_MEDIA_ERRORS.clip,
      assetOptions: { durationSec: 10, audioDurationSec: 1, hasAudio: true },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, () => {
      const state = makeApprovalFailureFixture(t, `media-${item.name.replaceAll(' ', '-')}`);
      const asset = writeApprovalImportedAsset(state, {
        kind: 'video',
        ...(item.assetOptions || {}),
      });
      setApprovalBrollMedia(state, asset);
      if (item.mutate) item.mutate({ state, asset });
      assertApprovalMediaFailure(state, {
        root: path.resolve(__dirname, '..'),
        runToolImpl: item.runTool || approvalProbe(
          item.probeMetadata ? item.probeMetadata(asset) : asset.metadata,
        ),
      }, item.expected);
    });
  }
});

test('approval preserves the legacy image brollSrc path byte-for-byte', (t) => {
  const state = makeApprovalFailureFixture(t, 'legacy-image-broll');
  const brief = JSON.parse(fs.readFileSync(state.draft.jsonPath, 'utf8'));
  brief.scenes = [{
    scene: 'broll', start: 0, end: 8, brollSrc: 'assets/broll/legacy.png',
    headCream: 'СТАРОЕ', headOrange: 'ИЗОБРАЖЕНИЕ',
  }];
  fs.mkdirSync(path.join(state.workspace.dir, 'assets', 'broll'), { recursive: true });
  fs.writeFileSync(path.join(state.workspace.dir, 'assets', 'broll', 'legacy.png'), 'legacy');
  fs.writeFileSync(state.draft.jsonPath, `${JSON.stringify(brief, null, 2)}\n`);

  const approved = approveBrief(state.workspace, state.draft.jsonPath);

  const persisted = JSON.parse(fs.readFileSync(approved.jsonPath, 'utf8'));
  assert.equal(persisted.scenes[0].brollSrc, 'assets/broll/legacy.png');
  assert.equal(persisted.scenes[0].brollMedia, undefined);
});

test('approval rejects a draft whose b-roll renderer cannot display', (t) => {
  const state = makeApprovalFailureFixture(t, 'unsupported-broll');
  const brief = JSON.parse(fs.readFileSync(state.draft.jsonPath, 'utf8'));
  brief.scenes = [{
    scene: 'broll',
    start: 0,
    end: 8,
    brollSrc: 'assets/broll/clip.mp4',
    headCream: 'НЕПОДДЕРЖИВАЕМОЕ',
    headOrange: 'ВИДЕО',
  }];
  fs.writeFileSync(state.draft.jsonPath, `${JSON.stringify(brief, null, 2)}\n`);
  const beforeManifest = fs.readFileSync(path.join(state.workspace.dir, 'project.json'));

  assert.throws(
    () => approveBrief(state.workspace, state.draft.jsonPath),
    /b-roll|изображен/i,
  );
  assert.deepEqual(fs.readFileSync(path.join(state.workspace.dir, 'project.json')), beforeManifest);
  assert.equal(fs.existsSync(state.approvedJson), false);
  assert.equal(fs.existsSync(state.approvedMarkdown), false);
});

test('approval rolls back manifest and outputs when a destination commit fails', async (t) => {
  for (const destination of ['project.json', 'approved Markdown', 'approved JSON']) {
    await t.test(destination, () => {
      const state = makeApprovalFailureFixture(t, destination.replace(' ', '-'));
      const failedPath = destination === 'project.json'
        ? path.join(state.workspace.dir, 'project.json')
        : destination === 'approved Markdown'
          ? state.approvedMarkdown
          : state.approvedJson;
      const failingFs = {
        ...fs,
        linkSync(source, target) {
          if (path.resolve(target) === path.resolve(failedPath)) {
            throw new Error(`simulated ${destination} failure`);
          }
          return fs.linkSync(source, target);
        },
        renameSync(source, target) {
          if (path.resolve(target) === path.resolve(failedPath)) {
            throw new Error(`simulated ${destination} failure`);
          }
          return fs.renameSync(source, target);
        },
      };

      assert.throws(
        () => approveBrief(state.workspace, state.draft.jsonPath, {
          fileSystem: failingFs,
          temporaryId: () => '12345678-1234-4123-8123-123456789abc',
        }),
        new RegExp(`simulated ${destination}`),
      );

      assert.equal(fs.existsSync(state.approvedJson), false);
      assert.equal(fs.existsSync(state.approvedMarkdown), false);
      const manifest = readProjectManifest(state.workspace.dir);
      assert.equal(manifest.currentBrief, 'brief/v01-draft.lesson.json');
      assert.deepEqual(manifest.briefs.map((entry) => entry.status), ['draft']);
      assert.deepEqual(
        fs.readdirSync(path.join(state.workspace.dir, 'brief')).filter((entry) => entry.includes('.tmp-')),
        [],
      );
      assert.deepEqual(
        fs.readdirSync(state.workspace.dir).filter((entry) => entry.includes('.tmp-')),
        [],
      );
      assert.throws(() => {
        const leaked = JSON.parse(fs.readFileSync(state.approvedJson, 'utf8'));
        return prepareLessonRender({
          brief: leaked,
          theme: 'lesson-neutral',
          sourceVideo: state.fixture.sourcePath,
        });
      }, /ENOENT/);
    });
  }
});

test('approval cleans owned temps when staging a manifest or Markdown write fails', async (t) => {
  for (const purpose of ['approval-manifest', 'approval-markdown']) {
    await t.test(purpose, () => {
      const state = makeApprovalFailureFixture(t, `stage-${purpose}`);
      const handles = new Map();
      const failingFs = {
        ...fs,
        openSync(target, flags, mode) {
          const handle = fs.openSync(target, flags, mode);
          handles.set(handle, target);
          return handle;
        },
        writeFileSync(target, data, options) {
          if (typeof target === 'number' && handles.get(target).includes(`.tmp-${purpose}-`)) {
            throw new Error(`simulated ${purpose} stage write failure`);
          }
          return fs.writeFileSync(target, data, options);
        },
        closeSync(handle) {
          handles.delete(handle);
          return fs.closeSync(handle);
        },
      };

      assert.throws(
        () => approveBrief(state.workspace, state.draft.jsonPath, {
          fileSystem: failingFs,
          temporaryId: () => '12345678-1234-4123-8123-123456789abc',
        }),
        new RegExp(`simulated ${purpose}`),
      );
      assert.equal(fs.existsSync(state.approvedJson), false);
      assert.equal(fs.existsSync(state.approvedMarkdown), false);
      assert.deepEqual(
        fs.readdirSync(state.workspace.dir).filter((entry) => entry.includes('.tmp-')),
        [],
      );
      assert.deepEqual(
        fs.readdirSync(path.join(state.workspace.dir, 'brief')).filter((entry) => entry.includes('.tmp-')),
        [],
      );
      assert.equal(readProjectManifest(state.workspace.dir).currentBrief, 'brief/v01-draft.lesson.json');
    });
  }
});

test('render versions keep history and publish one canonical final', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Versioned render',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });

  const first = nextRenderPaths(workspace, 'Новая музыка');
  assert.equal(path.basename(first.dir), 'v01-novaya-muzyka');
  assert.equal(path.basename(first.propsPath), 'props.json');
  assert.equal(path.basename(first.rawPath), 'raw.mp4');
  assert.equal(path.basename(first.finalPath), 'final.mp4');
  fs.writeFileSync(first.finalPath, 'render');

  recordRender(workspace, {
    version: first.version,
    label: first.label,
    dir: first.dir,
    status: 'complete',
  });

  assert.equal(path.basename(nextRenderPaths(workspace, 'Ducking').dir), 'v02-ducking');
  const canonicalFinal = publishFinal(workspace, first.finalPath);
  assert.equal(fs.readFileSync(canonicalFinal, 'utf8'), 'render');
  const manifest = readProjectManifest(workspace.dir);
  assert.equal(manifest.latestRender, 'renders/v01-novaya-muzyka');
  assert.equal(manifest.final, 'final/versioned-render.mp4');
});

test('publish final fsyncs through a write-capable handle on Windows', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Windows durable final',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const render = nextRenderPaths(workspace, 'Portable publish');
  fs.writeFileSync(render.finalPath, 'windows-final');
  const writeCapable = new Set();
  const windowsFileSystem = {
    ...fs,
    openSync(target, flags, mode) {
      const descriptor = fs.openSync(target, flags, mode);
      if (flags === 'r+' || flags === 'w+' || flags === 'a+') writeCapable.add(descriptor);
      return descriptor;
    },
    fsyncSync(descriptor) {
      if (!writeCapable.has(descriptor)) {
        const error = new Error('EPERM: operation not permitted, fsync');
        error.code = 'EPERM';
        throw error;
      }
      return fs.fsyncSync(descriptor);
    },
    closeSync(descriptor) {
      writeCapable.delete(descriptor);
      return fs.closeSync(descriptor);
    },
  };

  const canonicalFinal = publishFinal(workspace, render.finalPath, {
    fileSystem: windowsFileSystem,
  });

  assert.equal(fs.readFileSync(canonicalFinal, 'utf8'), 'windows-final');
  assert.deepEqual(
    fs.readdirSync(path.dirname(canonicalFinal)).filter((name) => name.includes('.tmp-')),
    [],
  );
});

test('render status updates one manifest entry instead of duplicating a version', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Render lifecycle',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const render = nextRenderPaths(workspace, 'Ducking');

  recordRender(workspace, {
    version: render.version,
    label: render.label,
    dir: render.dir,
    status: 'started',
  });
  recordRender(workspace, {
    version: render.version,
    label: render.label,
    dir: render.dir,
    status: 'complete',
  });

  const manifest = readProjectManifest(workspace.dir);
  assert.equal(manifest.renders.length, 1);
  assert.equal(manifest.renders[0].status, 'complete');
});

test('render lifecycle publishes final only after successful work', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Lifecycle success',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const render = nextRenderPaths(workspace, 'First');

  const destination = runRenderLifecycle(workspace, render, () => {
    fs.writeFileSync(render.finalPath, 'new-final');
    return render.finalPath;
  });

  const manifest = readProjectManifest(workspace.dir);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'new-final');
  assert.equal(manifest.latestRender, 'renders/v01-first');
  assert.equal(manifest.renders[0].status, 'complete');
});

test('render lifecycle records stage failures and retains the previous final', async (t) => {
  for (const failedStage of ['render', 'finish', 'music']) {
    await t.test(failedStage, () => {
      const fixture = makeFixture(t);
      const workspace = createOrOpenProject({
        baseDir: path.join(fixture.dir, 'projects'),
        name: `Failure ${failedStage}`,
        sourcePath: fixture.sourcePath,
        now: new Date('2026-08-05T12:00:00Z'),
      });
      const previous = nextRenderPaths(workspace, 'Previous');
      fs.writeFileSync(previous.finalPath, 'previous-final');
      recordRender(workspace, { ...previous, status: 'complete' });
      const canonical = publishFinal(workspace, previous.finalPath);
      const previousHash = fs.readFileSync(canonical, 'utf8');
      const attempted = nextRenderPaths(workspace, 'Attempted');

      assert.throws(() => runRenderLifecycle(workspace, attempted, () => {
        throw new Error(`${failedStage} failed`);
      }), new RegExp(`${failedStage} failed`));

      const manifest = readProjectManifest(workspace.dir);
      assert.equal(fs.readFileSync(canonical, 'utf8'), previousHash);
      assert.equal(manifest.latestRender, 'renders/v01-previous');
      assert.equal(manifest.renders.at(-1).status, 'failed');
      assert.equal(manifest.renders.length, 2);
    });
  }
});

test('publish failure records failed and retains the previous final', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Publish failure',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const previous = nextRenderPaths(workspace, 'Previous');
  fs.writeFileSync(previous.finalPath, 'previous-final');
  recordRender(workspace, { ...previous, status: 'complete' });
  const canonical = publishFinal(workspace, previous.finalPath);
  const attempted = nextRenderPaths(workspace, 'Attempted');
  fs.writeFileSync(attempted.finalPath, 'attempted-final');

  assert.throws(() => runRenderLifecycle(
    workspace,
    attempted,
    () => attempted.finalPath,
    { publish: () => { throw new Error('publish failed'); } },
  ), /publish failed/);

  const manifest = readProjectManifest(workspace.dir);
  assert.equal(fs.readFileSync(canonical, 'utf8'), 'previous-final');
  assert.equal(manifest.latestRender, 'renders/v01-previous');
  assert.equal(manifest.renders.at(-1).status, 'failed');
});

test('atomic final publish removes a failed temporary copy and preserves canonical final', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Atomic publish',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const render = nextRenderPaths(workspace, 'Attempt');
  fs.writeFileSync(render.finalPath, 'replacement');
  const canonical = path.join(workspace.dir, workspace.manifest.final);
  fs.writeFileSync(canonical, 'previous-final');
  const failingFs = {
    ...fs,
    renameSync() {
      throw new Error('rename failed');
    },
  };

  assert.throws(
    () => publishFinal(workspace, render.finalPath, { fileSystem: failingFs }),
    /rename failed/,
  );

  assert.equal(fs.readFileSync(canonical, 'utf8'), 'previous-final');
  assert.deepEqual(
    fs.readdirSync(path.dirname(canonical)).filter((name) => name.includes('.tmp-')),
    [],
  );
});

test('manifest requires currentBrief to match a registered brief and latestRender to match a complete render', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Manifest cross references',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });

  assert.throws(() => writeProjectManifest(workspace.dir, {
    ...workspace.manifest,
    currentBrief: 'brief/unregistered.lesson.json',
  }), /currentBrief.*briefs\[\]/);

  assert.throws(() => writeProjectManifest(workspace.dir, {
    ...workspace.manifest,
    renders: [{
      version: 1,
      label: 'unfinished',
      dir: 'renders/v01-unfinished',
      briefPath: null,
      status: 'started',
    }],
    latestRender: 'renders/v01-unfinished',
  }), /latestRender.*complete/);
});

test('publish final rejects an in-memory traversal manifest and leaves the outside sentinel unchanged', (t) => {
  const fixture = makeFixture(t);
  const workspace = createOrOpenProject({
    baseDir: path.join(fixture.dir, 'projects'),
    name: 'Traversal publish',
    sourcePath: fixture.sourcePath,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  const render = nextRenderPaths(workspace, 'Contained');
  fs.writeFileSync(render.finalPath, 'contained-render');
  const sentinelPath = path.join(fixture.dir, 'sentinel.mp4');
  fs.writeFileSync(sentinelPath, 'outside-must-survive');
  const maliciousWorkspace = {
    ...workspace,
    manifest: { ...workspace.manifest, final: '../../sentinel.mp4' },
  };

  let caught;
  try {
    publishFinal(maliciousWorkspace, render.finalPath);
  } catch (error) {
    caught = error;
  }

  assert.match(caught && caught.message, /manifest\.final/);
  assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'outside-must-survive');

  const containedWorkspace = {
    ...workspace,
    manifest: { ...workspace.manifest, final: 'renders/final/final.mp4' },
  };
  const published = publishFinal(containedWorkspace, render.finalPath);
  assert.equal(published, path.join(workspace.dir, 'renders/final/final.mp4'));
  assert.equal(fs.readFileSync(published, 'utf8'), 'contained-render');
});
