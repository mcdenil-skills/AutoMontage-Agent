const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { formatBriefMarkdown } = require('../scripts/lesson/brief');
const {
  approveBrief,
  createOrOpenProject,
  nextBriefPaths,
  readProjectManifest,
  recordBrief,
  saveDraftRevision,
} = require('../scripts/project/workspace');
const { listReviewAssetRecords } = require('../scripts/review/assets');
const { buildReviewCandidateBase, loadReviewBase } = require('../scripts/review/model');
const { materializeReviewAssets, startReviewServer } = require('../scripts/review/server');

const TEMPORARY_ID = 'review-safe-id';
const REPOSITORY_ROOT = path.resolve(__dirname, '..');

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
}

async function reviewJson(session, pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`${session.origin}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${session.token}`,
      ...(method === 'POST' ? {
        Origin: session.origin,
        'Content-Type': 'application/json',
      } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

function writeImportedVideo(projectDir, {
  id = '4af36be4-0b26-4e6f-bd48-8bdd2215a4f1',
  durationSec = 20,
  hasAudio = true,
  audioDurationSec = hasAudio ? durationSec : null,
} = {}) {
  const mediaDirectory = path.join(projectDir, 'assets', 'broll', 'video', id);
  const previewDirectory = path.join(projectDir, 'previews', 'broll');
  fs.mkdirSync(mediaDirectory, { recursive: true });
  fs.mkdirSync(previewDirectory, { recursive: true });
  const canonical = Buffer.from('normalized canonical video');
  const preview = Buffer.from('normalized proxy video');
  const canonicalPath = path.join(mediaDirectory, 'media.mp4');
  const previewPath = path.join(previewDirectory, `${id}.webm`);
  fs.writeFileSync(canonicalPath, canonical);
  fs.writeFileSync(previewPath, preview);
  const metadata = {
    version: 2,
    id,
    label: 'Recorded demo.mov',
    mediaKind: 'video',
    canonicalSha256: crypto.createHash('sha256').update(canonical).digest('hex'),
    previewSha256: crypto.createHash('sha256').update(preview).digest('hex'),
    width: 1920,
    height: 1080,
    fps: 25,
    durationSec,
    audioDurationSec,
    hasAudio,
  };
  const metadataPath = path.join(mediaDirectory, 'asset.json');
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`);
  return {
    canonical,
    canonicalPath,
    metadata,
    metadataPath,
    previewPath,
    reference: `assets/broll/video/${id}/media.mp4`,
  };
}

function approvalVideoProbe(metadata) {
  return (command, args, options) => {
    assert.equal(command, 'ffprobe');
    assert.equal(args.at(-1), 'pipe:0');
    assert.equal(options.shell, false);
    assert.equal(options.stdio.length, 3);
    assert.equal(Number.isInteger(options.stdio[0]), true);
    return {
      status: 0,
      signal: null,
      stdout: JSON.stringify({
        streams: [
          {
            codec_type: 'video', codec_name: 'h264', width: metadata.width,
            height: metadata.height, avg_frame_rate: `${metadata.fps}/1`,
            r_frame_rate: `${metadata.fps}/1`, duration: String(metadata.durationSec),
            pix_fmt: 'yuv420p',
            disposition: { attached_pic: 0 },
          },
          ...(metadata.hasAudio ? [{
            codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2,
            duration: String(metadata.audioDurationSec),
          }] : []),
        ],
        format: {
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          duration: String(metadata.durationSec),
        },
      }),
      stderr: '',
    };
  };
}

function approvalBoundaryRaceFileSystem({ state, triggerPath, replacedAsset }) {
  const handles = new Map();
  let armed = false;
  let replaced = false;
  return {
    fileSystem: {
      ...fs,
      openSync(target, flags, mode) {
        const descriptor = fs.openSync(target, flags, mode);
        handles.set(descriptor, path.resolve(String(target)));
        return descriptor;
      },
      writeFileSync(target, data, options) {
        const result = fs.writeFileSync(target, data, options);
        const openedPath = typeof target === 'number' ? handles.get(target) : null;
        if (openedPath && openedPath.includes('.tmp-approval-json-')) armed = true;
        return result;
      },
      readSync(descriptor, ...args) {
        if (armed && !replaced && handles.get(descriptor) === path.resolve(triggerPath)) {
          const replacement = path.join(state.root, `boundary-replacement-${path.basename(triggerPath)}`);
          fs.writeFileSync(replacement, replacedAsset.canonical);
          fs.renameSync(replacement, replacedAsset.canonicalPath);
          replaced = true;
        }
        return fs.readSync(descriptor, ...args);
      },
      closeSync(descriptor) {
        handles.delete(descriptor);
        return fs.closeSync(descriptor);
      },
    },
    wasReplaced() {
      return replaced;
    },
  };
}

function assertApprovalRacePreserved(state, options, race) {
  const manifestPath = path.join(state.workspace.dir, 'project.json');
  const before = {
    draft: fs.readFileSync(state.baseJsonPath),
    markdown: fs.readFileSync(state.baseMarkdownPath),
    manifest: fs.readFileSync(manifestPath),
    briefs: fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort(),
  };
  let caught;
  assert.throws(() => approveBrief(state.workspace, state.baseJsonPath, options), (error) => {
    caught = error;
    return true;
  });
  assert.equal(race.wasReplaced(), true);
  assert.equal(caught.code, 'BROLL_MEDIA_IDENTITY_CHANGED');
  assert.equal(
    caught.message,
    'BROLL_MEDIA_IDENTITY_CHANGED: b-roll media identity changed during approval',
  );
  assert.deepEqual(fs.readFileSync(state.baseJsonPath), before.draft);
  assert.equal(JSON.parse(before.draft).status, 'draft');
  assert.deepEqual(fs.readFileSync(state.baseMarkdownPath), before.markdown);
  assert.deepEqual(fs.readFileSync(manifestPath), before.manifest);
  assert.deepEqual(fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort(), before.briefs);
  assert.equal(fs.existsSync(state.baseJsonPath.replace('-draft.', '-approved.')), false);
  assert.equal(fs.existsSync(state.baseMarkdownPath.replace('-draft.', '-approved.')), false);
  assert.deepEqual(tempEntries(state.workspace), []);
}

function makeReviewWorkspace(t, { approved = true, name = 'review-save' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-review-save-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'camera.mp4');
  fs.writeFileSync(sourcePath, 'source-video');
  const workspace = createOrOpenProject({
    projectDir: path.join(root, `project-${name}`),
    name,
    sourcePath,
    now: new Date('2026-08-20T08:00:00.000Z'),
  });
  const brollPath = path.join(workspace.dir, 'assets', 'broll', 'diagram.png');
  fs.writeFileSync(brollPath, 'safe-image');

  const first = nextBriefPaths(workspace);
  const draftBrief = {
    version: 1,
    status: 'draft',
    source: workspace.manifest.source.localPath,
    theme: 'lesson-neutral',
    title: 'Atomic review save',
    output: {
      aspect: 'horizontal',
      width: 1920,
      height: 1080,
      fps: 25,
      durationInFrames: 250,
    },
    corrections: [],
    scenes: [
      { scene: 'fullscreen', start: 0, end: 4, caption: 'ПЕРВАЯ СЦЕНА' },
      {
        scene: 'broll',
        start: 4,
        end: 7,
        brollSrc: 'assets/broll/diagram.png',
        headCream: 'ПОКАЗЫВАЕМ',
        headOrange: 'СХЕМУ',
      },
      {
        scene: 'split',
        start: 7,
        end: 10,
        headCream: 'ФИНАЛЬНЫЙ',
        headOrange: 'БЛОК',
        bullets: ['Одна', 'Две'],
      },
    ],
  };
  fs.writeFileSync(first.jsonPath, `${JSON.stringify(draftBrief, null, 2)}\n`);
  fs.writeFileSync(first.markdownPath, formatBriefMarkdown(draftBrief));
  recordBrief(workspace, {
    revision: first.revision,
    jsonPath: first.jsonPath,
    markdownPath: first.markdownPath,
    status: 'draft',
    theme: draftBrief.theme,
    aspect: draftBrief.output.aspect,
  });

  const savedBase = approved ? approveBrief(workspace, first.jsonPath) : first;
  const baseBrief = JSON.parse(fs.readFileSync(savedBase.jsonPath, 'utf8'));
  return {
    root,
    workspace,
    baseJsonPath: savedBase.jsonPath,
    baseMarkdownPath: savedBase.markdownPath,
    baseBrief,
  };
}

function editedCandidate(baseBrief) {
  const candidate = structuredClone(baseBrief);
  candidate.status = 'draft';
  candidate.scenes[0].end = 4.25;
  candidate.scenes[1].start = 4.25;
  return candidate;
}

function expectedDraftPaths(workspace) {
  return {
    jsonPath: path.join(workspace.dir, 'brief', 'v02-draft.lesson.json'),
    markdownPath: path.join(workspace.dir, 'brief', 'v02-draft.lesson.md'),
  };
}

function tempEntries(workspace) {
  return [workspace.dir, path.join(workspace.dir, 'brief')]
    .flatMap((directory) => fs.readdirSync(directory)
      .filter((entry) => entry.includes('.tmp-'))
      .map((entry) => path.join(directory, entry)))
    .sort();
}

function assertSaveFailurePreserved(state, before, foreignTempPath) {
  const outputs = expectedDraftPaths(state.workspace);
  assert.deepEqual(fs.readFileSync(path.join(state.workspace.dir, 'project.json')), before.manifest);
  assert.deepEqual(fs.readFileSync(state.baseJsonPath), before.baseJson);
  assert.deepEqual(fs.readFileSync(state.baseMarkdownPath), before.baseMarkdown);
  assert.equal(fs.existsSync(outputs.jsonPath), false);
  assert.equal(fs.existsSync(outputs.markdownPath), false);
  assert.equal(readProjectManifest(state.workspace.dir).currentBrief, before.currentBrief);
  assert.equal(state.workspace.manifest.currentBrief, before.currentBrief);
  assert.deepEqual(tempEntries(state.workspace), foreignTempPath ? [foreignTempPath] : []);
  assert.equal(fs.existsSync(path.join(state.workspace.dir, '.review-draft-reservation')), false);
}

function failureFileSystem({ stagePurpose = null, commitPurpose = null }) {
  const handles = new Map();
  return {
    ...fs,
    openSync(target, flags, mode) {
      const handle = fs.openSync(target, flags, mode);
      handles.set(handle, target);
      return handle;
    },
    writeFileSync(target, data, options) {
      const openPath = typeof target === 'number' ? handles.get(target) : null;
      if (openPath && stagePurpose && openPath.includes(`.tmp-${stagePurpose}-`)) {
        throw new Error(`simulated ${stagePurpose} stage failure`);
      }
      return fs.writeFileSync(target, data, options);
    },
    closeSync(handle) {
      handles.delete(handle);
      return fs.closeSync(handle);
    },
    renameSync(source, target) {
      if (commitPurpose && source.includes(`.tmp-${commitPurpose}-`)) {
        throw new Error(`simulated ${commitPurpose} commit failure`);
      }
      return fs.renameSync(source, target);
    },
    linkSync(source, target) {
      if (commitPurpose && source.includes(`.tmp-${commitPurpose}-`)) {
        throw new Error(`simulated ${commitPurpose} commit failure`);
      }
      return fs.linkSync(source, target);
    },
  };
}

function runSaveWorker(workerPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `save worker exited ${code}: ${Buffer.concat(stderr).toString('utf8') || Buffer.concat(stdout).toString('utf8')}`,
      ));
    });
  });
}

test('review save reserves one revision across two real processes', async (t) => {
  const state = makeReviewWorkspace(t, { name: 'cross-process-reservation' });
  const candidatePath = path.join(state.root, 'candidate.json');
  const workerPath = path.join(state.root, 'save-worker.js');
  const barrierDir = path.join(state.root, 'barrier');
  fs.mkdirSync(barrierDir);
  fs.writeFileSync(candidatePath, `${JSON.stringify(editedCandidate(state.baseBrief), null, 2)}\n`);
  fs.writeFileSync(workerPath, String.raw`
const fs = require('node:fs');
const path = require('node:path');

const [modulePath, projectDir, baseJsonPath, candidatePath, barrierDir, id, resultPath] = process.argv.slice(2);
const { readProjectManifest, saveDraftRevision } = require(modulePath);
const manifestPath = path.join(projectDir, 'project.json');
const otherId = id === 'a' ? 'b' : 'a';
const pause = new Int32Array(new SharedArrayBuffer(4));

function waitUntil(predicate, label) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('barrier timeout: ' + label);
    Atomics.wait(pause, 0, 0, 10);
  }
}

function marker(name) {
  return path.join(barrierDir, name);
}

let readBarrierEntered = false;
const racingFileSystem = {
  ...fs,
  readFileSync(target, options) {
    if (!readBarrierEntered && path.resolve(String(target)) === manifestPath) {
      readBarrierEntered = true;
      fs.writeFileSync(marker('read-' + id), 'ready', { flag: 'wx' });
      waitUntil(
        () => fs.existsSync(marker('read-' + otherId)) || fs.existsSync(marker('lock-loser')),
        'manifest read',
      );
    }
    return fs.readFileSync(target, options);
  },
  renameSync(source, target) {
    if (String(source).includes('.tmp-review-draft-manifest-')) {
      if (id === 'a') {
        waitUntil(
          () => fs.existsSync(marker('b-manifest-ready')) || fs.existsSync(marker('lock-loser')),
          'second precommit check',
        );
        fs.writeFileSync(marker('a-manifest-commit'), 'ready', { flag: 'wx' });
      } else {
        fs.writeFileSync(marker('b-manifest-ready'), 'ready', { flag: 'wx' });
        waitUntil(
          () => fs.existsSync(marker('a-manifest-commit')) || fs.existsSync(marker('lock-loser')),
          'ordered manifest commit',
        );
        if (!fs.existsSync(marker('lock-loser'))) Atomics.wait(pause, 0, 0, 200);
      }
    }
    return fs.renameSync(source, target);
  },
};

try {
  const manifest = readProjectManifest(projectDir);
  const workspace = { dir: projectDir, manifest };
  const brief = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const saved = saveDraftRevision(workspace, {
    baseJsonPath,
    brief,
    fileSystem: racingFileSystem,
    temporaryId: () => 'process-' + id,
  });
  fs.writeFileSync(resultPath, JSON.stringify({ id, ok: true, revision: saved.revision }));
} catch (error) {
  if (error && error.code === 'PROJECT_MANIFEST_CONFLICT') {
    try { fs.writeFileSync(marker('lock-loser'), id, { flag: 'wx' }); } catch (_) {}
  }
  fs.writeFileSync(resultPath, JSON.stringify({
    id,
    ok: false,
    code: error && error.code,
    message: error && error.message,
  }));
}
`);

  const modulePath = require.resolve('../scripts/project/workspace');
  const resultPaths = ['a', 'b'].map((id) => path.join(state.root, `result-${id}.json`));
  await Promise.all(['a', 'b'].map((id, index) => runSaveWorker(workerPath, [
    modulePath,
    state.workspace.dir,
    state.baseJsonPath,
    candidatePath,
    barrierDir,
    id,
    resultPaths[index],
  ])));

  const results = resultPaths.map((resultPath) => JSON.parse(fs.readFileSync(resultPath, 'utf8')));
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.deepEqual(
    results.filter((result) => !result.ok).map((result) => result.code),
    ['PROJECT_MANIFEST_CONFLICT'],
  );
  const manifest = readProjectManifest(state.workspace.dir);
  assert.equal(manifest.briefs.filter((entry) => entry.revision === 2).length, 1);
  assert.equal(manifest.currentBrief, 'brief/v02-draft.lesson.json');
  assert.equal(fs.existsSync(path.join(state.workspace.dir, 'brief', 'v02-draft.lesson.json')), true);
  assert.equal(fs.existsSync(path.join(state.workspace.dir, 'brief', 'v02-draft.lesson.md')), true);
  assert.equal(fs.existsSync(path.join(state.workspace.dir, '.review-draft-reservation')), false);
});

test('review save never overwrites a foreign reservation file or symlink', async (t) => {
  const cases = [
    {
      name: 'regular file',
      prepare(reservationPath) {
        fs.writeFileSync(reservationPath, 'foreign-reservation', { flag: 'wx' });
      },
    },
    {
      name: 'symlink',
      prepare(reservationPath, sentinelPath) {
        fs.symlinkSync(sentinelPath, reservationPath);
      },
    },
  ];

  for (const currentCase of cases) {
    await t.test(currentCase.name, () => {
      const state = makeReviewWorkspace(t, { name: `foreign-reservation-${currentCase.name}` });
      const reservationPath = path.join(state.workspace.dir, '.review-draft-reservation');
      const sentinelPath = path.join(state.root, 'outside-sentinel.txt');
      const manifestPath = path.join(state.workspace.dir, 'project.json');
      const beforeManifest = fs.readFileSync(manifestPath);
      fs.writeFileSync(sentinelPath, 'outside-safe');
      currentCase.prepare(reservationPath, sentinelPath);

      assert.throws(
        () => saveDraftRevision(state.workspace, {
          baseJsonPath: state.baseJsonPath,
          brief: editedCandidate(state.baseBrief),
          temporaryId: () => TEMPORARY_ID,
        }),
        (error) => error && error.code === 'PROJECT_MANIFEST_CONFLICT',
      );

      assert.deepEqual(fs.readFileSync(manifestPath), beforeManifest);
      assert.equal(fs.existsSync(expectedDraftPaths(state.workspace).jsonPath), false);
      assert.equal(fs.existsSync(expectedDraftPaths(state.workspace).markdownPath), false);
      assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'outside-safe');
      const reservationStat = fs.lstatSync(reservationPath);
      assert.equal(reservationStat.isSymbolicLink(), currentCase.name === 'symlink');
      if (!reservationStat.isSymbolicLink()) {
        assert.equal(fs.readFileSync(reservationPath, 'utf8'), 'foreign-reservation');
      }
    });
  }
});

test('review save publishes Markdown and JSON before the manifest exposes them', (t) => {
  const state = makeReviewWorkspace(t, { name: 'ordered-approved' });
  const beforeJson = fs.readFileSync(state.baseJsonPath);
  const beforeMarkdown = fs.readFileSync(state.baseMarkdownPath);
  const outputs = expectedDraftPaths(state.workspace);
  const commits = [];
  const observingFs = {
    ...fs,
    linkSync(source, target) {
      if (source.includes('.tmp-review-draft-markdown-')) {
        assert.equal(readProjectManifest(state.workspace.dir).currentBrief, 'brief/v01-approved.lesson.json');
        assert.equal(fs.existsSync(outputs.markdownPath), false);
        assert.equal(fs.existsSync(outputs.jsonPath), false);
        commits.push('markdown');
      } else if (source.includes('.tmp-review-draft-json-')) {
        assert.equal(readProjectManifest(state.workspace.dir).currentBrief, 'brief/v01-approved.lesson.json');
        assert.equal(fs.existsSync(outputs.markdownPath), true);
        assert.equal(fs.existsSync(outputs.jsonPath), false);
        commits.push('json');
      }
      return fs.linkSync(source, target);
    },
    renameSync(source, target) {
      if (source.includes('.tmp-review-draft-manifest-')) {
        assert.equal(readProjectManifest(state.workspace.dir).currentBrief, 'brief/v01-approved.lesson.json');
        assert.equal(fs.existsSync(outputs.markdownPath), true);
        assert.equal(fs.existsSync(outputs.jsonPath), true);
        commits.push('manifest');
      }
      return fs.renameSync(source, target);
    },
  };

  const candidate = editedCandidate(state.baseBrief);
  candidate.status = 'approved';
  const expectedDraft = { ...candidate, status: 'draft' };
  const beforeBriefCount = state.workspace.manifest.briefs.length;
  const saved = saveDraftRevision(state.workspace, {
    baseJsonPath: state.baseJsonPath,
    brief: candidate,
    fileSystem: observingFs,
    temporaryId: () => TEMPORARY_ID,
  });

  assert.deepEqual(commits, ['markdown', 'json', 'manifest']);
  assert.equal(saved.revision, 2);
  assert.equal(saved.jsonPath, outputs.jsonPath);
  assert.equal(saved.markdownPath, outputs.markdownPath);
  assert.deepEqual(fs.readFileSync(state.baseJsonPath), beforeJson);
  assert.deepEqual(fs.readFileSync(state.baseMarkdownPath), beforeMarkdown);
  const persisted = JSON.parse(fs.readFileSync(saved.jsonPath, 'utf8'));
  assert.deepEqual(persisted, expectedDraft);
  assert.equal(persisted.status, 'draft');
  assert.equal(persisted.source, state.baseBrief.source);
  assert.deepEqual(persisted.theme, state.baseBrief.theme);
  assert.deepEqual(persisted.output, state.baseBrief.output);
  assert.match(fs.readFileSync(saved.markdownPath, 'utf8'), /^Статус: `draft`$/m);
  const manifest = readProjectManifest(state.workspace.dir);
  assert.equal(manifest.currentBrief, 'brief/v02-draft.lesson.json');
  assert.equal(manifest.briefs.length, beforeBriefCount + 1);
  assert.deepEqual(manifest.briefs.at(-1), {
    kind: 'lesson',
    revision: 2,
    jsonPath: 'brief/v02-draft.lesson.json',
    markdownPath: 'brief/v02-draft.lesson.md',
    status: 'draft',
    theme: 'lesson-neutral',
    aspect: 'horizontal',
  });
  assert.deepEqual(tempEntries(state.workspace), []);
});

test('review save also keeps a current draft base byte-for-byte', (t) => {
  const state = makeReviewWorkspace(t, { approved: false, name: 'draft-base' });
  const beforeJson = fs.readFileSync(state.baseJsonPath);
  const beforeMarkdown = fs.readFileSync(state.baseMarkdownPath);

  const saved = saveDraftRevision(state.workspace, {
    baseJsonPath: state.baseJsonPath,
    brief: editedCandidate(state.baseBrief),
    temporaryId: () => TEMPORARY_ID,
  });

  assert.equal(path.basename(saved.jsonPath), 'v02-draft.lesson.json');
  assert.deepEqual(fs.readFileSync(state.baseJsonPath), beforeJson);
  assert.deepEqual(fs.readFileSync(state.baseMarkdownPath), beforeMarkdown);
});

test('review save returns committed data when only post-commit temp cleanup fails', (t) => {
  const state = makeReviewWorkspace(t, { name: 'post-commit-cleanup' });
  let jsonCommitted = false;
  let cleanupAttempted = false;
  const cleanupFailureFs = {
    ...fs,
    linkSync(source, target) {
      const result = fs.linkSync(source, target);
      if (source.includes('.tmp-review-draft-json-')) jsonCommitted = true;
      return result;
    },
    renameSync(source, target) {
      return fs.renameSync(source, target);
    },
    unlinkSync(target) {
      if (jsonCommitted && target.includes('.tmp-review-draft-rollback-')) {
        cleanupAttempted = true;
        throw new Error('simulated post-commit cleanup failure');
      }
      return fs.unlinkSync(target);
    },
  };

  const saved = saveDraftRevision(state.workspace, {
    baseJsonPath: state.baseJsonPath,
    brief: editedCandidate(state.baseBrief),
    fileSystem: cleanupFailureFs,
    temporaryId: () => TEMPORARY_ID,
  });

  assert.equal(jsonCommitted, true);
  assert.equal(cleanupAttempted, true);
  assert.equal(saved.revision, 2);
  assert.equal(saved.relativePath, 'brief/v02-draft.lesson.json');
  assert.equal(readProjectManifest(state.workspace.dir).currentBrief, saved.relativePath);
  assert.equal(state.workspace.manifest.currentBrief, saved.relativePath);
  assert.equal(JSON.parse(fs.readFileSync(saved.jsonPath, 'utf8')).status, 'draft');
  assert.match(fs.readFileSync(saved.markdownPath, 'utf8'), /^Статус: `draft`$/m);
  assert.deepEqual(tempEntries(state.workspace), [
    path.join(
      state.workspace.dir,
      `project.json.tmp-review-draft-rollback-${TEMPORARY_ID}`,
    ),
  ]);
});

test('review save rolls back every staging and destination commit failure', async (t) => {
  const failures = [
    { kind: 'stage', purpose: 'review-draft-manifest' },
    { kind: 'stage', purpose: 'review-draft-rollback' },
    { kind: 'stage', purpose: 'review-draft-markdown' },
    { kind: 'stage', purpose: 'review-draft-json' },
    { kind: 'commit', purpose: 'review-draft-manifest' },
    { kind: 'commit', purpose: 'review-draft-markdown' },
    { kind: 'commit', purpose: 'review-draft-json' },
  ];

  for (const failure of failures) {
    await t.test(`${failure.kind} ${failure.purpose}`, () => {
      const state = makeReviewWorkspace(t, { name: `${failure.kind}-${failure.purpose}` });
      const manifestPath = path.join(state.workspace.dir, 'project.json');
      const before = {
        manifest: fs.readFileSync(manifestPath),
        baseJson: fs.readFileSync(state.baseJsonPath),
        baseMarkdown: fs.readFileSync(state.baseMarkdownPath),
        currentBrief: state.workspace.manifest.currentBrief,
      };
      const foreignTempPath = path.join(
        state.workspace.dir,
        'brief',
        'unrelated.lesson.json.tmp-foreign-owner-do-not-delete',
      );
      fs.writeFileSync(foreignTempPath, 'foreign-temp');
      const sentinelPath = path.join(state.root, 'outside-sentinel.txt');
      fs.writeFileSync(sentinelPath, 'outside-safe');
      const fileSystem = failureFileSystem({
        stagePurpose: failure.kind === 'stage' ? failure.purpose : null,
        commitPurpose: failure.kind === 'commit' ? failure.purpose : null,
      });

      assert.throws(
        () => saveDraftRevision(state.workspace, {
          baseJsonPath: state.baseJsonPath,
          brief: editedCandidate(state.baseBrief),
          fileSystem,
          temporaryId: () => TEMPORARY_ID,
        }),
        new RegExp(`simulated ${failure.purpose} ${failure.kind} failure`),
      );

      assertSaveFailurePreserved(state, before, foreignTempPath);
      assert.equal(fs.readFileSync(foreignTempPath, 'utf8'), 'foreign-temp');
      assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'outside-safe');
    });
  }
});

test('review save rejects stale, unregistered and traversing bases before writes', async (t) => {
  const cases = [
    {
      name: 'registered but no longer current',
      basePath(state) {
        return path.join(state.workspace.dir, 'brief', 'v01-draft.lesson.json');
      },
      pattern: /current|stale/i,
    },
    {
      name: 'unregistered inside project',
      basePath(state) {
        const unregistered = path.join(state.workspace.dir, 'brief', 'unregistered.lesson.json');
        fs.writeFileSync(unregistered, JSON.stringify(state.baseBrief));
        return unregistered;
      },
      pattern: /registered|project\.json/i,
    },
    {
      name: 'traversal outside project',
      basePath(state) {
        const outside = path.join(state.root, 'outside-base.json');
        fs.writeFileSync(outside, JSON.stringify(state.baseBrief));
        return path.join(state.workspace.dir, 'brief', '..', '..', path.basename(outside));
      },
      pattern: /inside|путь/i,
    },
  ];

  for (const currentCase of cases) {
    await t.test(currentCase.name, () => {
      const state = makeReviewWorkspace(t, { name: currentCase.name.replaceAll(' ', '-') });
      const beforeManifest = fs.readFileSync(path.join(state.workspace.dir, 'project.json'));
      const beforeBriefNames = fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort();
      assert.throws(() => saveDraftRevision(state.workspace, {
        baseJsonPath: currentCase.basePath(state),
        brief: editedCandidate(state.baseBrief),
        temporaryId: () => TEMPORARY_ID,
      }), currentCase.pattern);
      assert.deepEqual(fs.readFileSync(path.join(state.workspace.dir, 'project.json')), beforeManifest);
      assert.deepEqual(
        fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort(),
        currentCase.name === 'unregistered inside project'
          ? [...beforeBriefNames, 'unregistered.lesson.json'].sort()
          : beforeBriefNames,
      );
      assert.deepEqual(tempEntries(state.workspace), []);
    });
  }
});

test('review save rejects a base replaced by a symlink without touching its target', (t) => {
  const state = makeReviewWorkspace(t, { name: 'symlink-base' });
  const manifestPath = path.join(state.workspace.dir, 'project.json');
  const beforeManifest = fs.readFileSync(manifestPath);
  const outside = path.join(state.root, 'outside-base.json');
  fs.writeFileSync(outside, 'outside-safe');
  fs.unlinkSync(state.baseJsonPath);
  fs.symlinkSync(outside, state.baseJsonPath);

  assert.throws(() => saveDraftRevision(state.workspace, {
    baseJsonPath: state.baseJsonPath,
    brief: editedCandidate(state.baseBrief),
    temporaryId: () => TEMPORARY_ID,
  }), /symbolic link/i);

  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside-safe');
  assert.deepEqual(fs.readFileSync(manifestPath), beforeManifest);
  assert.equal(fs.lstatSync(state.baseJsonPath).isSymbolicLink(), true);
  assert.deepEqual(tempEntries(state.workspace), []);
});

test('review save preserves a newer on-disk current brief when the session is stale', (t) => {
  const state = makeReviewWorkspace(t, { name: 'disk-stale' });
  const manifestPath = path.join(state.workspace.dir, 'project.json');
  const persistedManifest = readProjectManifest(state.workspace.dir);
  persistedManifest.currentBrief = 'brief/v01-draft.lesson.json';
  fs.writeFileSync(manifestPath, `${JSON.stringify(persistedManifest, null, 2)}\n`);
  const newerManifestBytes = fs.readFileSync(manifestPath);
  const beforeBriefNames = fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort();

  assert.throws(() => saveDraftRevision(state.workspace, {
    baseJsonPath: state.baseJsonPath,
    brief: editedCandidate(state.baseBrief),
    temporaryId: () => TEMPORARY_ID,
  }), /current|stale/i);

  assert.deepEqual(fs.readFileSync(manifestPath), newerManifestBytes);
  assert.equal(readProjectManifest(state.workspace.dir).currentBrief, 'brief/v01-draft.lesson.json');
  assert.equal(state.workspace.manifest.currentBrief, 'brief/v01-approved.lesson.json');
  assert.deepEqual(fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort(), beforeBriefNames);
  assert.deepEqual(tempEntries(state.workspace), []);
});

test('review save never follows or removes an unowned predictable temp symlink', (t) => {
  const state = makeReviewWorkspace(t, { name: 'symlink-temp' });
  const before = {
    manifest: fs.readFileSync(path.join(state.workspace.dir, 'project.json')),
    baseJson: fs.readFileSync(state.baseJsonPath),
    baseMarkdown: fs.readFileSync(state.baseMarkdownPath),
    currentBrief: state.workspace.manifest.currentBrief,
  };
  const outside = path.join(state.root, 'outside-temp-target.txt');
  fs.writeFileSync(outside, 'outside-safe');
  const outputs = expectedDraftPaths(state.workspace);
  const unownedTemp = `${outputs.jsonPath}.tmp-review-draft-json-${TEMPORARY_ID}`;
  fs.symlinkSync(outside, unownedTemp);

  assert.throws(() => saveDraftRevision(state.workspace, {
    baseJsonPath: state.baseJsonPath,
    brief: editedCandidate(state.baseBrief),
    temporaryId: () => TEMPORARY_ID,
  }), /EEXIST/);

  assertSaveFailurePreserved(state, before, unownedTemp);
  assert.equal(fs.lstatSync(unownedTemp).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside-safe');
});

test('review save rejects a no-op without allocating another revision', (t) => {
  const state = makeReviewWorkspace(t, { name: 'no-op' });
  const manifestPath = path.join(state.workspace.dir, 'project.json');
  const beforeManifest = fs.readFileSync(manifestPath);
  const beforeBriefNames = fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort();
  const candidate = structuredClone(state.baseBrief);
  candidate.status = 'draft';

  assert.throws(
    () => saveDraftRevision(state.workspace, {
      baseJsonPath: state.baseJsonPath,
      brief: candidate,
      temporaryId: () => TEMPORARY_ID,
    }),
    (error) => error && error.message === 'ничего не изменено',
  );

  assert.deepEqual(fs.readFileSync(manifestPath), beforeManifest);
  assert.deepEqual(fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort(), beforeBriefNames);
  assert.deepEqual(tempEntries(state.workspace), []);
});

test('review save rejects unresolved opaque asset ids and browser media pseudo-paths', async (t) => {
  const cases = [
    ['opaque b-roll id', (candidate) => { candidate.scenes[1].brollSrc = 'asset-2'; }, /asset|opaque|изображ/i],
    ['browser asset path', (candidate) => { candidate.scenes[1].brollSrc = '/media/assets/asset-2'; }, /browser|media|изображ/i],
    ['browser source path', (candidate) => { candidate.source = '/media/source'; }, /browser|media/i],
    [
      'absolute URL dot segment',
      (candidate) => { candidate.scenes[1].brollSrc = 'http://review.local/./media/assets/asset-2'; },
      /browser|media|изображ/i,
    ],
    [
      'percent-encoded parent segment',
      (candidate) => { candidate.scenes[1].brollSrc = 'http://review.local/safe/%2e%2e/media/assets/asset-2'; },
      /browser|media|изображ/i,
    ],
    [
      'relative percent-encoded parent segment',
      (candidate) => { candidate.scenes[1].brollSrc = '/safe/%2e%2e/media/source'; },
      /browser|media|изображ/i,
    ],
    [
      'absolute URL backslashes',
      (candidate) => { candidate.scenes[1].brollSrc = 'http://review.local\\media\\assets\\asset-2'; },
      /browser|media|изображ/i,
    ],
  ];

  for (const [name, mutate, pattern] of cases) {
    await t.test(name, () => {
      const state = makeReviewWorkspace(t, { name: name.replaceAll(' ', '-') });
      const manifestPath = path.join(state.workspace.dir, 'project.json');
      const beforeManifest = fs.readFileSync(manifestPath);
      const beforeBriefNames = fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort();
      const candidate = editedCandidate(state.baseBrief);
      mutate(candidate);

      assert.throws(() => saveDraftRevision(state.workspace, {
        baseJsonPath: state.baseJsonPath,
        brief: candidate,
        temporaryId: () => TEMPORARY_ID,
      }), pattern);
      assert.deepEqual(fs.readFileSync(manifestPath), beforeManifest);
      assert.deepEqual(fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort(), beforeBriefNames);
      assert.deepEqual(tempEntries(state.workspace), []);
    });
  }
});

test('review save accepts canonical project/public refs and safe filenames containing media', async (t) => {
  const cases = [
    ['current project ref', 'assets/broll/diagram.png'],
    ['project media filename', 'assets/broll/social-media-card.png'],
    ['public media ref', 'public/broll/growth.png'],
  ];

  for (const [name, reference] of cases) {
    await t.test(name, () => {
      const state = makeReviewWorkspace(t, { name: name.replaceAll(' ', '-') });
      if (reference === 'assets/broll/social-media-card.png') {
        fs.writeFileSync(path.join(state.workspace.dir, ...reference.split('/')), 'safe-media');
      }
      const candidate = editedCandidate(state.baseBrief);
      candidate.scenes[1].brollSrc = reference;

      const saved = saveDraftRevision(state.workspace, {
        baseJsonPath: state.baseJsonPath,
        brief: candidate,
        temporaryId: () => TEMPORARY_ID,
      });

      assert.equal(JSON.parse(fs.readFileSync(saved.jsonPath, 'utf8')).scenes[1].brollSrc, reference);
      assert.equal(readProjectManifest(state.workspace.dir).currentBrief, 'brief/v02-draft.lesson.json');
    });
  }
});

test('review save CAS preserves a foreign manifest and referenced temp injected before JSON and manifest publish', (t) => {
  const state = makeReviewWorkspace(t, { name: 'cas-before-commit' });
  const manifestPath = path.join(state.workspace.dir, 'project.json');
  const outputs = expectedDraftPaths(state.workspace);
  const jsonTempPath = `${outputs.jsonPath}.tmp-review-draft-json-${TEMPORARY_ID}`;
  const jsonTempRelative = path.relative(state.workspace.dir, jsonTempPath).split(path.sep).join('/');
  const foreignManifest = readProjectManifest(state.workspace.dir);
  foreignManifest.name = 'Foreign writer before commit';
  foreignManifest.updatedAt = '2026-08-20T09:00:00.000Z';
  foreignManifest.briefs.push({
    revision: 99,
    jsonPath: jsonTempRelative,
    markdownPath: null,
    status: 'draft',
    theme: 'lesson-neutral',
    aspect: 'horizontal',
  });
  foreignManifest.currentBrief = jsonTempRelative;
  const foreignManifestBytes = Buffer.from(`${JSON.stringify(foreignManifest, null, 2)}\n`);
  const handles = new Map();
  let injected = false;
  const racingFs = {
    ...fs,
    openSync(target, flags, mode) {
      const handle = fs.openSync(target, flags, mode);
      handles.set(handle, target);
      return handle;
    },
    writeFileSync(target, data, options) {
      const result = fs.writeFileSync(target, data, options);
      const openPath = typeof target === 'number' ? handles.get(target) : null;
      if (!injected && openPath && openPath.includes('.tmp-review-draft-rollback-')) {
        fs.writeFileSync(jsonTempPath, 'foreign-referenced-temp');
        fs.writeFileSync(manifestPath, foreignManifestBytes);
        injected = true;
      }
      return result;
    },
    closeSync(handle) {
      handles.delete(handle);
      return fs.closeSync(handle);
    },
  };

  assert.throws(() => saveDraftRevision(state.workspace, {
    baseJsonPath: state.baseJsonPath,
    brief: editedCandidate(state.baseBrief),
    fileSystem: racingFs,
    temporaryId: () => TEMPORARY_ID,
  }), /concurrent|changed/i);

  assert.equal(injected, true);
  assert.deepEqual(fs.readFileSync(manifestPath), foreignManifestBytes);
  assert.equal(fs.readFileSync(jsonTempPath, 'utf8'), 'foreign-referenced-temp');
  assert.equal(fs.existsSync(outputs.jsonPath), false);
  assert.equal(fs.existsSync(outputs.markdownPath), false);
  assert.equal(readProjectManifest(state.workspace.dir).currentBrief, jsonTempRelative);
  assert.deepEqual(fs.readFileSync(state.baseJsonPath), Buffer.from(`${JSON.stringify(state.baseBrief, null, 2)}\n`));
});

test('review save no-replace preserves a foreign JSON created after Markdown publication', (t) => {
  const state = makeReviewWorkspace(t, { name: 'foreign-json-collision' });
  const manifestPath = path.join(state.workspace.dir, 'project.json');
  const outputs = expectedDraftPaths(state.workspace);
  const beforeManifest = fs.readFileSync(manifestPath);
  const beforeBase = fs.readFileSync(state.baseJsonPath);
  const foreignJson = Buffer.from('foreign-json-destination');
  let injected = false;
  const racingFs = {
    ...fs,
    linkSync(source, target) {
      if (!injected && path.resolve(target) === path.resolve(outputs.jsonPath)) {
        fs.writeFileSync(outputs.jsonPath, foreignJson, { flag: 'wx' });
        injected = true;
      }
      return fs.linkSync(source, target);
    },
  };

  assert.throws(() => saveDraftRevision(state.workspace, {
    baseJsonPath: state.baseJsonPath,
    brief: editedCandidate(state.baseBrief),
    fileSystem: racingFs,
    temporaryId: () => TEMPORARY_ID,
  }), (error) => error && error.code === 'EEXIST');

  assert.equal(injected, true);
  assert.deepEqual(fs.readFileSync(manifestPath), beforeManifest);
  assert.deepEqual(fs.readFileSync(outputs.jsonPath), foreignJson);
  assert.equal(fs.existsSync(outputs.markdownPath), false);
  assert.equal(readProjectManifest(state.workspace.dir).currentBrief, state.workspace.manifest.currentBrief);
  assert.deepEqual(fs.readFileSync(state.baseJsonPath), beforeBase);
});

test('review save validates the candidate and preserves protected identity', async (t) => {
  const cases = [
    ['invalid lesson brief', (candidate) => { delete candidate.scenes[0].caption; }, /brief|caption|required/i],
    ['changed source', (candidate) => { candidate.source = 'input/other.mp4'; }, /identity|source/i],
    ['changed theme', (candidate) => { candidate.theme = 'other-theme'; }, /identity|theme/i],
    ['changed full output', (candidate) => { candidate.output.width = 1080; }, /identity|output/i],
  ];

  for (const [name, mutate, pattern] of cases) {
    await t.test(name, () => {
      const state = makeReviewWorkspace(t, { name: name.replaceAll(' ', '-') });
      const manifestPath = path.join(state.workspace.dir, 'project.json');
      const beforeManifest = fs.readFileSync(manifestPath);
      const beforeBriefNames = fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort();
      const candidate = editedCandidate(state.baseBrief);
      mutate(candidate);

      assert.throws(() => saveDraftRevision(state.workspace, {
        baseJsonPath: state.baseJsonPath,
        brief: candidate,
        temporaryId: () => TEMPORARY_ID,
      }), pattern);
      assert.deepEqual(fs.readFileSync(manifestPath), beforeManifest);
      assert.deepEqual(fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort(), beforeBriefNames);
      assert.deepEqual(tempEntries(state.workspace), []);
    });
  }
});

test('review materialization uses the opened registered bytes and preserves untouched legacy b-roll', (t) => {
  const state = makeReviewWorkspace(t, { name: 'materialize-trusted-media' });
  const current = loadReviewBase({ projectDir: state.workspace.dir });
  const records = listReviewAssetRecords({ root: REPOSITORY_ROOT, projectDir: state.workspace.dir });
  const assetFiles = new Map(records.map((record, index) => [`asset-${index + 1}`, record]));
  const selected = [...assetFiles].find(([, record]) => record.reference === 'assets/broll/diagram.png');
  assert.ok(selected);
  const base = buildReviewCandidateBase({ canonicalBrief: current.brief, assetFiles });

  const boundaryOnly = structuredClone(base);
  boundaryOnly.scenes[0].end = 4.2;
  boundaryOnly.scenes[1].start = 4.2;
  const legacy = materializeReviewAssets({
    root: REPOSITORY_ROOT,
    current,
    assetFiles,
    candidate: boundaryOnly,
    words: [],
  });
  assert.equal(legacy.scenes[1].brollSrc, 'assets/broll/diagram.png');
  assert.equal(legacy.scenes[1].brollMedia, undefined);

  const selectedCandidate = structuredClone(base);
  delete selectedCandidate.scenes[1].brollSrc;
  selectedCandidate.scenes[1].brollMedia = {
    kind: 'image', assetId: selected[0], fit: 'contain',
  };
  const materialized = materializeReviewAssets({
    root: REPOSITORY_ROOT,
    current,
    assetFiles,
    candidate: selectedCandidate,
    words: [],
    probeMediaImpl: () => ({
      mediaKind: 'image', width: 1, height: 1, fps: 0, durationSec: 0, hasAudio: false,
    }),
  });
  const expectedHash = crypto.createHash('sha256').update(
    fs.readFileSync(path.join(state.workspace.dir, 'assets', 'broll', 'diagram.png')),
  ).digest('hex');
  assert.deepEqual(materialized.scenes[1].brollMedia, {
    kind: 'image',
    src: 'assets/broll/diagram.png',
    sha256: expectedHash,
    fit: 'contain',
  });
  assert.equal(materialized.scenes[1].brollSrc, undefined);
  assert.doesNotMatch(JSON.stringify(selectedCandidate), /assets\/broll|[a-f0-9]{64}/);
});

test('review materialization rechecks immutable registry identity before any revision allocation', (t) => {
  const state = makeReviewWorkspace(t, { name: 'materialize-race' });
  const current = loadReviewBase({ projectDir: state.workspace.dir });
  const records = listReviewAssetRecords({ root: REPOSITORY_ROOT, projectDir: state.workspace.dir });
  const assetFiles = new Map(records.map((record, index) => [`asset-${index + 1}`, record]));
  const selected = [...assetFiles].find(([, record]) => record.reference === 'assets/broll/diagram.png');
  const candidate = buildReviewCandidateBase({ canonicalBrief: current.brief, assetFiles });
  delete candidate.scenes[1].brollSrc;
  candidate.scenes[1].brollMedia = {
    kind: 'image', assetId: selected[0], fit: 'cover',
  };
  const mediaPath = path.join(state.workspace.dir, 'assets', 'broll', 'diagram.png');
  const replacement = path.join(state.root, 'replacement.png');
  fs.writeFileSync(replacement, 'different image bytes');
  fs.renameSync(replacement, mediaPath);
  const beforeBriefs = fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort();

  assert.throws(() => materializeReviewAssets({
    root: REPOSITORY_ROOT,
    current,
    assetFiles,
    candidate,
    words: [],
  }), /asset|media|identity|unresolved/i);
  assert.deepEqual(fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort(), beforeBriefs);
  assert.equal(readProjectManifest(state.workspace.dir).currentBrief,
    state.workspace.manifest.currentBrief);
});

test('review materialization cannot probe swapped pathname bytes and hash a restored file', (t) => {
  const state = makeReviewWorkspace(t, { name: 'materialize-probe-swap-back' });
  const current = loadReviewBase({ projectDir: state.workspace.dir });
  const records = listReviewAssetRecords({ root: REPOSITORY_ROOT, projectDir: state.workspace.dir });
  const assetFiles = new Map(records.map((record, index) => [`asset-${index + 1}`, record]));
  const selected = [...assetFiles].find(([, record]) => record.reference === 'assets/broll/diagram.png');
  const candidate = buildReviewCandidateBase({ canonicalBrief: current.brief, assetFiles });
  delete candidate.scenes[1].brollSrc;
  candidate.scenes[1].brollMedia = { kind: 'image', assetId: selected[0], fit: 'cover' };
  const mediaPath = selected[1].filePath;
  const parkedPath = path.join(state.root, 'parked-original.png');
  const beforeBriefs = fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort();

  assert.throws(() => materializeReviewAssets({
    root: REPOSITORY_ROOT,
    current,
    assetFiles,
    candidate,
    words: [],
    probeMediaImpl(target) {
      fs.renameSync(mediaPath, parkedPath);
      fs.writeFileSync(mediaPath, 'attacker bytes');
      if (typeof target === 'string') {
        assert.equal(target, mediaPath);
        fs.unlinkSync(mediaPath);
        fs.renameSync(parkedPath, mediaPath);
      } else {
        assert.equal(typeof target.fileDescriptor, 'number');
        assert.deepEqual(Object.keys(target), ['fileDescriptor']);
      }
      return {
        mediaKind: 'image', width: 1, height: 1, fps: 0, durationSec: 0, hasAudio: false,
      };
    },
  }), /asset|media|identity|unresolved/i);
  assert.deepEqual(fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort(), beforeBriefs);
  assert.equal(fs.existsSync(expectedDraftPaths(state.workspace).jsonPath), false);
});

test('review materialization rejects a media ancestor renamed and replaced by a symlink during probe', (t) => {
  const state = makeReviewWorkspace(t, { name: 'materialize-probe-ancestor-symlink' });
  const current = loadReviewBase({ projectDir: state.workspace.dir });
  const records = listReviewAssetRecords({ root: REPOSITORY_ROOT, projectDir: state.workspace.dir });
  const assetFiles = new Map(records.map((record, index) => [`asset-${index + 1}`, record]));
  const selected = [...assetFiles].find(([, record]) => record.reference === 'assets/broll/diagram.png');
  const candidate = buildReviewCandidateBase({ canonicalBrief: current.brief, assetFiles });
  delete candidate.scenes[1].brollSrc;
  candidate.scenes[1].brollMedia = { kind: 'image', assetId: selected[0], fit: 'cover' };
  const brollDirectory = path.dirname(selected[1].filePath);
  const parkedDirectory = path.join(state.workspace.dir, 'assets', 'broll-parked');
  const outsideDirectory = path.join(state.root, 'outside-broll');
  fs.mkdirSync(outsideDirectory);
  fs.writeFileSync(path.join(outsideDirectory, 'diagram.png'), 'attacker bytes');
  const beforeBriefs = fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort();

  assert.throws(() => materializeReviewAssets({
    root: REPOSITORY_ROOT,
    current,
    assetFiles,
    candidate,
    words: [],
    probeMediaImpl(target) {
      fs.renameSync(brollDirectory, parkedDirectory);
      fs.symlinkSync(outsideDirectory, brollDirectory);
      if (typeof target === 'string') {
        fs.unlinkSync(brollDirectory);
        fs.renameSync(parkedDirectory, brollDirectory);
      } else {
        assert.equal(typeof target.fileDescriptor, 'number');
        assert.deepEqual(Object.keys(target), ['fileDescriptor']);
      }
      return {
        mediaKind: 'image', width: 1, height: 1, fps: 0, durationSec: 0, hasAudio: false,
      };
    },
  }), /asset|media|identity|unresolved/i);
  assert.deepEqual(fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort(), beforeBriefs);
  assert.equal(fs.existsSync(expectedDraftPaths(state.workspace).jsonPath), false);
});

test('video materialization rechecks probe fields and persists snapped seconds without changing approved bytes', (t) => {
  const state = makeReviewWorkspace(t, { name: 'video-materialize' });
  writeImportedVideo(state.workspace.dir);
  const approvedBytes = fs.readFileSync(state.baseJsonPath);
  const current = loadReviewBase({ projectDir: state.workspace.dir });
  const records = listReviewAssetRecords({ root: REPOSITORY_ROOT, projectDir: state.workspace.dir });
  const assetFiles = new Map(records.map((record, index) => [`asset-${index + 1}`, record]));
  const selected = [...assetFiles].find(([, record]) => record.mediaKind === 'video');
  assert.ok(selected);
  const candidate = buildReviewCandidateBase({ canonicalBrief: current.brief, assetFiles });
  delete candidate.scenes[1].brollSrc;
  candidate.scenes[1].brollMedia = {
    kind: 'video', assetId: selected[0], fit: 'contain', trimStartSec: 12.4, audioMode: 'replace',
  };

  for (const mutate of [
    (asset) => { asset.canonicalSha256 = '0'.repeat(64); },
    (asset) => { asset.durationSec = 12; },
    (asset) => { asset.hasAudio = false; },
  ]) {
    const staleFiles = new Map([...assetFiles].map(([id, asset]) => [id, { ...asset }]));
    mutate(staleFiles.get(selected[0]));
    assert.throws(() => materializeReviewAssets({
      root: REPOSITORY_ROOT,
      current,
      assetFiles: staleFiles,
      candidate,
      words: [],
    }), /asset|media|identity|duration|audio|unresolved/i);
    assert.equal(fs.existsSync(expectedDraftPaths(state.workspace).jsonPath), false);
  }

  assert.throws(() => materializeReviewAssets({
    root: REPOSITORY_ROOT,
    current,
    assetFiles,
    candidate,
    words: [],
    probeMediaImpl: () => ({
      mediaKind: 'video', width: 1920, height: 1080, fps: 25,
      durationSec: 20, audioDurationSec: null, hasAudio: false,
    }),
  }), /probe|media|audio|unresolved/i);
  assert.equal(fs.existsSync(expectedDraftPaths(state.workspace).jsonPath), false);

  const freshDurationOverrun = structuredClone(candidate);
  freshDurationOverrun.scenes[1].brollMedia.trimStartSec = 17;
  assert.throws(() => materializeReviewAssets({
    root: REPOSITORY_ROOT,
    current,
    assetFiles,
    candidate: freshDurationOverrun,
    words: [],
    probeMediaImpl: () => ({
      mediaKind: 'video', width: 1920, height: 1080, fps: 25,
      durationSec: 19.96, audioDurationSec: 20, hasAudio: true,
    }),
  }), /duration|clip|media|unresolved/i);
  assert.equal(fs.existsSync(expectedDraftPaths(state.workspace).jsonPath), false);

  const materialized = materializeReviewAssets({
    root: REPOSITORY_ROOT,
    current,
    assetFiles,
    candidate,
    words: [],
    probeMediaImpl: () => ({
      mediaKind: 'video', width: 1920, height: 1080, fps: 25,
      durationSec: 20, audioDurationSec: 20, hasAudio: true,
    }),
  });
  assert.deepEqual(materialized.scenes[1].brollMedia, {
    kind: 'video',
    src: selected[1].reference,
    sha256: selected[1].canonicalSha256,
    trimStartSec: 12.4,
    fit: 'contain',
    audioMode: 'replace',
  });
  const saved = saveDraftRevision(current.workspace, {
    baseJsonPath: current.briefFilePath,
    brief: materialized,
    temporaryId: () => TEMPORARY_ID,
  });
  assert.deepEqual(fs.readFileSync(state.baseJsonPath), approvedBytes);
  assert.equal(JSON.parse(fs.readFileSync(saved.jsonPath, 'utf8'))
    .scenes[1].brollMedia.trimStartSec, 12.4);
});

test('approval rechecks the opened media identity after staging and before any publication', (t) => {
  const state = makeReviewWorkspace(t, { approved: false, name: 'approval-media-race' });
  const asset = writeImportedVideo(state.workspace.dir);
  const draft = JSON.parse(fs.readFileSync(state.baseJsonPath, 'utf8'));
  delete draft.scenes[1].brollSrc;
  draft.scenes[1].brollMedia = {
    kind: 'video',
    src: asset.reference,
    sha256: asset.metadata.canonicalSha256,
    trimStartSec: 0,
    fit: 'contain',
    audioMode: 'replace',
  };
  fs.writeFileSync(state.baseJsonPath, `${JSON.stringify(draft, null, 2)}\n`);
  const manifestPath = path.join(state.workspace.dir, 'project.json');
  const before = {
    draft: fs.readFileSync(state.baseJsonPath),
    markdown: fs.readFileSync(state.baseMarkdownPath),
    manifest: fs.readFileSync(manifestPath),
    briefs: fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort(),
  };
  const handles = new Map();
  let replaced = false;
  const racingFs = {
    ...fs,
    openSync(target, flags, mode) {
      const descriptor = fs.openSync(target, flags, mode);
      handles.set(descriptor, String(target));
      return descriptor;
    },
    writeFileSync(target, data, options) {
      const result = fs.writeFileSync(target, data, options);
      const openedPath = typeof target === 'number' ? handles.get(target) : null;
      if (!replaced && openedPath && openedPath.includes('.tmp-approval-json-')) {
        const replacement = path.join(state.root, 'same-bytes-new-identity.mp4');
        fs.writeFileSync(replacement, asset.canonical);
        fs.renameSync(replacement, asset.canonicalPath);
        replaced = true;
      }
      return result;
    },
    closeSync(descriptor) {
      handles.delete(descriptor);
      return fs.closeSync(descriptor);
    },
  };

  let caught;
  assert.throws(() => approveBrief(state.workspace, state.baseJsonPath, {
    root: REPOSITORY_ROOT,
    fileSystem: racingFs,
    runToolImpl: approvalVideoProbe(asset.metadata),
    temporaryId: () => TEMPORARY_ID,
  }), (error) => {
    caught = error;
    return true;
  });
  assert.equal(replaced, true);
  assert.equal(caught.code, 'BROLL_MEDIA_IDENTITY_CHANGED');
  assert.equal(
    caught.message,
    'BROLL_MEDIA_IDENTITY_CHANGED: b-roll media identity changed during approval',
  );
  assert.deepEqual(fs.readFileSync(state.baseJsonPath), before.draft);
  assert.equal(JSON.parse(before.draft).status, 'draft');
  assert.deepEqual(fs.readFileSync(state.baseMarkdownPath), before.markdown);
  assert.deepEqual(fs.readFileSync(manifestPath), before.manifest);
  assert.deepEqual(fs.readdirSync(path.join(state.workspace.dir, 'brief')).sort(), before.briefs);
  assert.equal(fs.existsSync(state.baseJsonPath.replace('-draft.', '-approved.')), false);
  assert.equal(fs.existsSync(state.baseMarkdownPath.replace('-draft.', '-approved.')), false);
  assert.deepEqual(tempEntries(state.workspace), []);
});

test('approval catches canonical replacement while the same bundle proxy is rehashed', (t) => {
  const state = makeReviewWorkspace(t, { approved: false, name: 'approval-proxy-race' });
  const asset = writeImportedVideo(state.workspace.dir);
  const draft = JSON.parse(fs.readFileSync(state.baseJsonPath, 'utf8'));
  delete draft.scenes[1].brollSrc;
  draft.scenes[1].brollMedia = {
    kind: 'video',
    src: asset.reference,
    sha256: asset.metadata.canonicalSha256,
    trimStartSec: 0,
    fit: 'contain',
    audioMode: 'replace',
  };
  fs.writeFileSync(state.baseJsonPath, `${JSON.stringify(draft, null, 2)}\n`);
  const race = approvalBoundaryRaceFileSystem({
    state,
    triggerPath: asset.previewPath,
    replacedAsset: asset,
  });

  assertApprovalRacePreserved(state, {
    root: REPOSITORY_ROOT,
    fileSystem: race.fileSystem,
    runToolImpl: approvalVideoProbe(asset.metadata),
    temporaryId: () => TEMPORARY_ID,
  }, race);
});

test('approval catches first-scene replacement while a second asset is rehashed', (t) => {
  const state = makeReviewWorkspace(t, { approved: false, name: 'approval-two-scene-race' });
  const first = writeImportedVideo(state.workspace.dir, {
    id: '4af36be4-0b26-4e6f-bd48-8bdd2215a4f1',
  });
  const second = writeImportedVideo(state.workspace.dir, {
    id: '5bf47cf5-1c37-4f70-9e59-9cee3326b5a2',
  });
  const draft = JSON.parse(fs.readFileSync(state.baseJsonPath, 'utf8'));
  draft.scenes = [first, second].map((asset, index) => ({
    scene: 'broll',
    start: index * 2,
    end: (index + 1) * 2,
    brollMedia: {
      kind: 'video',
      src: asset.reference,
      sha256: asset.metadata.canonicalSha256,
      trimStartSec: index,
      fit: 'contain',
      audioMode: 'replace',
    },
    headCream: `СЦЕНА ${index + 1}`,
    headOrange: 'ВИДЕО',
  }));
  fs.writeFileSync(state.baseJsonPath, `${JSON.stringify(draft, null, 2)}\n`);
  const race = approvalBoundaryRaceFileSystem({
    state,
    triggerPath: second.canonicalPath,
    replacedAsset: first,
  });

  assertApprovalRacePreserved(state, {
    root: REPOSITORY_ROOT,
    fileSystem: race.fileSystem,
    runToolImpl: approvalVideoProbe(first.metadata),
    temporaryId: () => TEMPORARY_ID,
  }, race);
});

test('legacy image re-selection persists brollMedia and resolves after a real server restart', async (t) => {
  const state = makeReviewWorkspace(t, { name: 'restart-media-selection' });
  fs.writeFileSync(path.join(state.workspace.dir, 'transcript', 'words.json'), `${JSON.stringify([{
    start: 0,
    end: 10,
    text: 'Тестовая дорожка',
    words: [{ w: 'Тестовая', s: 0, e: 1 }, { w: 'дорожка', s: 1, e: 2 }],
  }])}\n`);
  const approvedBytes = fs.readFileSync(state.baseJsonPath);
  const start = () => startReviewServer({
    root: REPOSITORY_ROOT,
    projectDir: state.workspace.dir,
    editable: true,
    open: false,
    runToolImpl: () => { throw new Error('waveform unavailable'); },
    probeReviewMediaImpl: () => ({
      mediaKind: 'image', width: 1, height: 1, fps: 0, durationSec: 0, hasAudio: false,
    }),
  });
  const first = await start();
  let savedPath;
  let selectedId;
  try {
    const initial = await reviewJson(first, '/api/state');
    assert.equal(initial.status, 200);
    const selected = initial.body.assets.find((asset) => asset.label === 'diagram.png');
    assert.ok(selected);
    selectedId = selected.id;
    const payload = {
      baseRevision: initial.body.session.baseRevision,
      baseHash: initial.body.session.baseHash,
      manifestHash: initial.body.session.manifestHash,
      commands: [{ type: 'replace-broll', sceneIndex: 1, assetId: selected.id }],
    };
    const response = await reviewJson(first, '/api/save', { method: 'POST', body: payload });
    assert.equal(response.status, 201);
    savedPath = response.body.path;
  } finally {
    await closeServer(first.server);
  }

  assert.deepEqual(fs.readFileSync(state.baseJsonPath), approvedBytes);
  const persisted = JSON.parse(fs.readFileSync(path.join(state.workspace.dir, savedPath), 'utf8'));
  assert.equal(persisted.scenes[1].brollSrc, undefined);
  assert.equal(persisted.scenes[1].brollMedia.src, 'assets/broll/diagram.png');
  assert.match(persisted.scenes[1].brollMedia.sha256, /^[a-f0-9]{64}$/);

  const second = await start();
  try {
    const reloaded = await reviewJson(second, '/api/state');
    assert.equal(reloaded.status, 200);
    assert.deepEqual(reloaded.body.brief.scenes[1].brollMedia, {
      kind: 'image', assetId: selectedId, fit: 'cover',
    });
    assert.doesNotMatch(
      JSON.stringify({ brief: reloaded.body.brief, assets: reloaded.body.assets }),
      /assets\/broll|[a-f0-9]{64}|\/Users\//,
    );
  } finally {
    await closeServer(second.server);
  }
});
