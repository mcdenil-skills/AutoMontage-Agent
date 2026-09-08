const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

const {
  acquireProjectMutationLease,
  approveBrief,
  createOrOpenProject,
  nextBriefPaths,
  nextRenderPaths,
  publishBriefRevision,
  readProjectManifest,
  recordBrief,
  recordRender,
  saveDraftRevision,
  writeProjectManifest,
} = require('../scripts/project/workspace');
const { makeReviewProject, registerHigherBrief } = require('./helpers/review-project');
const { formatMotionBriefMarkdown } = require('../scripts/motion/brief');

function makeProject(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-project-mutation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'camera.mp4');
  fs.writeFileSync(sourcePath, 'source-video');
  return createOrOpenProject({
    projectDir: path.join(root, 'project'),
    name,
    sourcePath,
    now: new Date('2026-08-22T08:00:00.000Z'),
  });
}

function writeLeaseWorker(directory) {
  const workerPath = path.join(directory, 'lease-worker.js');
  fs.writeFileSync(workerPath, String.raw`
const { acquireProjectMutationLease } = require(process.argv[2]);
const projectDir = process.argv[3];
const mode = process.argv[4];
const lease = acquireProjectMutationLease(projectDir);
if (mode === 'crash') process.exit(73);
if (process.send) process.send({ type: 'ready', leasePath: lease.path });
process.on('message', (message) => {
  if (message === 'release') {
    lease.release();
    process.exit(0);
  }
});
`);
  return workerPath;
}

function waitForMessage(child, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`worker timeout: ${type}`)), 10_000);
    const fail = (error) => {
      clearTimeout(timeout);
      reject(error);
    };
    child.once('error', fail);
    child.once('exit', (code, signal) => fail(new Error(
      `worker exited before ${type}: code=${code} signal=${signal}`,
    )));
    child.on('message', (message) => {
      if (message && message.type === type) {
        clearTimeout(timeout);
        resolve(message);
      }
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function runMutationRace(t, state, leftOperation, rightOperation) {
  const workerPath = path.join(state.root, `mutation-race-${leftOperation}-${rightOperation}.js`);
  fs.writeFileSync(workerPath, String.raw`
const fs = require('node:fs');
const path = require('node:path');
const [modulePath, projectDir, operation] = process.argv.slice(2);
const api = require(modulePath);
const manifest = api.readProjectManifest(projectDir);
const workspace = { dir: projectDir, manifest };
function report(payload) {
  if (process.send) process.send(payload, () => process.exit(0));
  else process.exit(0);
}
if (process.send) process.send({ type: 'ready', operation });
process.once('message', () => {
  try {
    let result;
    if (operation === 'save') {
      const basePath = path.join(projectDir, manifest.currentBrief);
      const brief = JSON.parse(fs.readFileSync(basePath, 'utf8'));
      brief.scenes[0].caption = 'RACING SAVE';
      result = api.saveDraftRevision(workspace, { baseJsonPath: basePath, brief });
    } else if (operation === 'approve') {
      result = api.approveBrief(workspace, path.join(projectDir, manifest.currentBrief));
    } else if (operation === 'render') {
      const render = api.nextRenderPaths(workspace, 'Racing render');
      result = api.recordRender(workspace, { ...render, status: 'started' });
    }
    report({ type: 'result', operation, ok: true, result });
  } catch (error) {
    report({
      type: 'result', operation, ok: false, code: error && error.code, message: error && error.message,
    });
  }
});
`);
  const children = [leftOperation, rightOperation].map((operation) => fork(
    workerPath,
    [require.resolve('../scripts/project/workspace'), state.workspace.dir, operation],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  ));
  t.after(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
  });
  await Promise.all(children.map((child) => waitForMessage(child, 'ready')));
  const results = children.map((child) => waitForMessage(child, 'result'));
  const exits = children.map(waitForExit);
  for (const child of children) child.send('go');
  const resolved = await Promise.all(results);
  await Promise.all(exits);
  return resolved;
}

async function holdLease(t, workspace) {
  const workerPath = writeLeaseWorker(path.dirname(workspace.dir));
  const child = fork(workerPath, [require.resolve('../scripts/project/workspace'), workspace.dir, 'hold'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  });
  const ready = await waitForMessage(child, 'ready');
  return {
    child,
    ready,
    async release() {
      child.send('release');
      assert.deepEqual(await waitForExit(child), { code: 0, signal: null });
    },
  };
}

test('a live process mutation lease blocks a second process without changing owner bytes', async (t) => {
  const workspace = makeProject(t, 'Live owner');
  const workerPath = writeLeaseWorker(path.dirname(workspace.dir));
  const child = fork(workerPath, [require.resolve('../scripts/project/workspace'), workspace.dir, 'hold'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  });
  const ready = await waitForMessage(child, 'ready');
  const before = fs.readFileSync(ready.leasePath);

  assert.throws(
    () => acquireProjectMutationLease(workspace.dir),
    (error) => error && error.code === 'PROJECT_MANIFEST_CONFLICT',
  );
  assert.deepEqual(fs.readFileSync(ready.leasePath), before);

  child.send('release');
  assert.deepEqual(await waitForExit(child), { code: 0, signal: null });
});

test('a hard process exit leaves a provably dead lease that the next mutation reclaims', async (t) => {
  const workspace = makeProject(t, 'Dead owner');
  const workerPath = writeLeaseWorker(path.dirname(workspace.dir));
  const child = fork(workerPath, [require.resolve('../scripts/project/workspace'), workspace.dir, 'crash'], {
    stdio: 'ignore',
  });

  assert.deepEqual(await waitForExit(child), { code: 73, signal: null });
  const recovered = acquireProjectMutationLease(workspace.dir);
  assert.equal(typeof recovered.path, 'string');
  recovered.release();
});

test('Save, approval, render and brief manifest writers share the live process lease', async (t) => {
  const cases = [
    {
      name: 'Save',
      run(state) {
        const brief = JSON.parse(fs.readFileSync(state.briefPath, 'utf8'));
        brief.scenes[0].caption = 'ИЗМЕНЕНО';
        return saveDraftRevision(state.workspace, {
          baseJsonPath: state.briefPath,
          brief,
        });
      },
    },
    {
      name: 'approval',
      run(state) {
        return approveBrief(state.workspace, state.briefPath);
      },
    },
    {
      name: 'render manifest writer',
      run(state) {
        const render = nextRenderPaths(state.workspace, 'Concurrent render');
        return recordRender(state.workspace, { ...render, status: 'started' });
      },
    },
    {
      name: 'brief manifest writer',
      run(state) {
        const next = nextBriefPaths(state.workspace);
        return recordBrief(state.workspace, {
          revision: next.revision,
          jsonPath: next.jsonPath,
          markdownPath: next.markdownPath,
          status: 'draft',
          theme: 'lesson-neutral',
          aspect: 'horizontal',
        });
      },
    },
    {
      name: 'direct manifest writer',
      run(state) {
        return writeProjectManifest(state.workspace.dir, {
          ...state.workspace.manifest,
          name: 'Concurrent overwrite',
        }, { expectedManifest: state.workspace.manifest });
      },
    },
  ];

  for (const currentCase of cases) {
    await t.test(currentCase.name, async (subtest) => {
      const state = makeReviewProject(subtest, { briefStatus: 'draft' });
      const manifestPath = path.join(state.workspace.dir, 'project.json');
      const beforeManifest = fs.readFileSync(manifestPath);
      const holder = await holdLease(subtest, state.workspace);
      const beforeLease = fs.readFileSync(holder.ready.leasePath);

      assert.throws(
        () => currentCase.run(state),
        (error) => error && error.code === 'PROJECT_MANIFEST_CONFLICT',
      );
      assert.deepEqual(fs.readFileSync(manifestPath), beforeManifest);
      assert.deepEqual(fs.readFileSync(holder.ready.leasePath), beforeLease);
      await holder.release();
    });
  }
});

test('approval rejects a stale in-memory draft instead of replacing a newer persisted manifest', (t) => {
  const state = makeReviewProject(t, { briefStatus: 'draft' });
  const originalManifest = structuredClone(state.workspace.manifest);
  registerHigherBrief(state, { revision: 5 });
  const newerManifest = fs.readFileSync(path.join(state.workspace.dir, 'project.json'));
  state.workspace.manifest = originalManifest;

  assert.throws(
    () => approveBrief(state.workspace, state.briefPath),
    (error) => error && error.code === 'PROJECT_MANIFEST_CONFLICT',
  );
  assert.deepEqual(fs.readFileSync(path.join(state.workspace.dir, 'project.json')), newerManifest);
  assert.equal(fs.existsSync(state.briefPath.replace('-draft.', '-approved.')), false);
});

test('approval always runs the complete lesson brief validator before publication', (t) => {
  const state = makeReviewProject(t, { briefStatus: 'draft' });
  const invalid = JSON.parse(fs.readFileSync(state.briefPath, 'utf8'));
  delete invalid.title;
  fs.writeFileSync(state.briefPath, `${JSON.stringify(invalid, null, 2)}\n`);
  const manifestBefore = fs.readFileSync(path.join(state.workspace.dir, 'project.json'));

  assert.throws(() => approveBrief(state.workspace, state.briefPath), /draft brief is invalid.*title/is);
  assert.deepEqual(fs.readFileSync(path.join(state.workspace.dir, 'project.json')), manifestBefore);
  assert.equal(fs.existsSync(state.briefPath.replace('-draft.', '-approved.')), false);
});

test('approval dispatches from the stored motion brief kind even with a lesson filename', (t) => {
  const workspace = makeProject(t, 'Stored motion kind');
  const draft = nextBriefPaths(workspace, 'lesson');
  const brief = {
    version: 1,
    kind: 'motion-reel',
    status: 'draft',
    source: workspace.manifest.source.localPath,
    theme: 'motion-neutral',
    title: 'Stored kind wins',
    output: { aspect: 'vertical', width: 1080, height: 1920, fps: 30, durationInFrames: 90 },
    scenes: [{ scene: 'kinetic-title', start: 0, end: 3, text: 'Не имя файла' }],
  };
  fs.writeFileSync(draft.jsonPath, `${JSON.stringify(brief, null, 2)}\n`);
  fs.writeFileSync(draft.markdownPath, formatMotionBriefMarkdown(brief));
  recordBrief(workspace, {
    revision: draft.revision,
    jsonPath: draft.jsonPath,
    markdownPath: draft.markdownPath,
    status: 'draft',
    kind: 'motion-reel',
    theme: brief.theme,
    aspect: brief.output.aspect,
  });

  const approved = approveBrief(workspace, draft.jsonPath);
  const persisted = JSON.parse(fs.readFileSync(approved.jsonPath, 'utf8'));
  const markdown = fs.readFileSync(approved.markdownPath, 'utf8');

  assert.equal(persisted.status, 'approved');
  assert.match(markdown, /^# Motion Reel: Stored kind wins$/m);
  assert.equal(readProjectManifest(workspace.dir).briefs.at(-1).kind, 'motion-reel');
});

test('approval no-replace publication preserves a foreign destination created at commit', (t) => {
  const state = makeReviewProject(t, { briefStatus: 'draft' });
  const approvedJsonPath = state.briefPath.replace('-draft.', '-approved.');
  const approvedMarkdownPath = approvedJsonPath.replace('.json', '.md');
  const foreignBytes = Buffer.from('foreign-approved-json\n');
  const manifestPath = path.join(state.workspace.dir, 'project.json');
  const manifestBefore = fs.readFileSync(manifestPath);
  let collided = false;
  const collisionFs = {
    ...fs,
    linkSync(source, destination) {
      if (!collided && path.resolve(String(destination)) === path.resolve(approvedJsonPath)) {
        collided = true;
        fs.writeFileSync(approvedJsonPath, foreignBytes, { flag: 'wx' });
      }
      return fs.linkSync(source, destination);
    },
  };

  assert.throws(() => approveBrief(state.workspace, state.briefPath, {
    fileSystem: collisionFs,
  }), (error) => error && error.code === 'EEXIST');
  assert.equal(collided, true);
  assert.deepEqual(fs.readFileSync(approvedJsonPath), foreignBytes);
  assert.equal(fs.existsSync(approvedMarkdownPath), false);
  assert.deepEqual(fs.readFileSync(manifestPath), manifestBefore);
  assert.equal(readProjectManifest(state.workspace.dir).currentBrief, 'brief/v01-draft.lesson.json');
});

test('two real processes racing Save against approval publish exactly one manifest mutation', async (t) => {
  const state = makeReviewProject(t, { briefStatus: 'draft' });
  const results = await runMutationRace(t, state, 'save', 'approve');

  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.deepEqual(
    results.filter((result) => !result.ok).map((result) => result.code),
    ['PROJECT_MANIFEST_CONFLICT'],
  );
  const manifest = readProjectManifest(state.workspace.dir);
  assert.equal(fs.existsSync(path.join(state.workspace.dir, manifest.currentBrief)), true);
});

test('two real processes racing approval against a render writer publish exactly one mutation', async (t) => {
  const state = makeReviewProject(t, { briefStatus: 'draft' });
  const results = await runMutationRace(t, state, 'approve', 'render');

  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.deepEqual(
    results.filter((result) => !result.ok).map((result) => result.code),
    ['PROJECT_MANIFEST_CONFLICT'],
  );
  const manifest = readProjectManifest(state.workspace.dir);
  assert.equal(fs.existsSync(path.join(state.workspace.dir, manifest.currentBrief)), true);
});

test('a foreign-host lease is preserved because its owner cannot be proved dead', (t) => {
  const workspace = makeProject(t, 'Foreign owner');
  const foreign = acquireProjectMutationLease(workspace.dir, {
    hostname: 'foreign-host.example',
    pid: 424242,
  });
  const before = fs.readFileSync(foreign.path);

  assert.throws(
    () => acquireProjectMutationLease(workspace.dir),
    (error) => error && error.code === 'PROJECT_MANIFEST_CONFLICT',
  );
  assert.deepEqual(fs.readFileSync(foreign.path), before);
  foreign.release();
});

test('hard exits at every Save publication boundary remain recoverable and never expose missing JSON', async (t) => {
  for (const boundary of ['lease', 'markdown', 'json', 'manifest']) {
    await t.test(boundary, async (subtest) => {
      const state = makeReviewProject(subtest, { briefStatus: 'draft' });
      const originalDraft = fs.readFileSync(state.briefPath);
      const workerPath = path.join(state.root, `crash-save-${boundary}.js`);
      fs.writeFileSync(workerPath, String.raw`
const fs = require('node:fs');
const path = require('node:path');
const [modulePath, projectDir, boundary] = process.argv.slice(2);
const api = require(modulePath);
const manifest = api.readProjectManifest(projectDir);
const workspace = { dir: projectDir, manifest };
const baseJsonPath = path.join(projectDir, manifest.currentBrief);
const brief = JSON.parse(fs.readFileSync(baseJsonPath, 'utf8'));
brief.scenes[0].caption = 'CRASHED SAVE';
const crashingFs = {
  ...fs,
  linkSync(source, destination) {
    const result = fs.linkSync(source, destination);
    const name = path.basename(String(destination));
    if ((boundary === 'lease' && name === '.project-mutation.lock')
      || (boundary === 'markdown' && name === 'v02-draft.lesson.md')
      || (boundary === 'json' && name === 'v02-draft.lesson.json')) process.exit(81);
    return result;
  },
  renameSync(source, destination) {
    const result = fs.renameSync(source, destination);
    if (boundary === 'manifest' && String(source).includes('.tmp-review-draft-manifest-')) {
      process.exit(81);
    }
    return result;
  },
};
api.saveDraftRevision(workspace, { baseJsonPath, brief, fileSystem: crashingFs });
process.exit(99);
`);
      const child = fork(
        workerPath,
        [require.resolve('../scripts/project/workspace'), state.workspace.dir, boundary],
        { stdio: 'ignore' },
      );
      assert.deepEqual(await waitForExit(child), { code: 81, signal: null });

      const afterCrash = readProjectManifest(state.workspace.dir);
      assert.equal(
        fs.existsSync(path.join(state.workspace.dir, afterCrash.currentBrief)),
        true,
      );
      assert.deepEqual(fs.readFileSync(state.briefPath), originalDraft);

      const reopened = createOrOpenProject({ projectDir: state.workspace.dir });
      const recoveredBrief = JSON.parse(fs.readFileSync(
        path.join(reopened.dir, reopened.manifest.currentBrief),
        'utf8',
      ));
      recoveredBrief.scenes[0].caption = `RECOVERED ${boundary}`;
      const saved = saveDraftRevision(reopened, {
        baseJsonPath: path.join(reopened.dir, reopened.manifest.currentBrief),
        brief: recoveredBrief,
      });
      assert.equal(fs.existsSync(saved.jsonPath), true);
      assert.equal(readProjectManifest(reopened.dir).currentBrief, saved.relativePath);
      assert.equal(fs.existsSync(path.join(reopened.dir, '.project-mutation.lock')), false);
    });
  }
});

test('hard exits at every approval publication boundary keep currentBrief resolvable', async (t) => {
  for (const boundary of ['lease', 'markdown', 'json', 'manifest']) {
    await t.test(boundary, async (subtest) => {
      const state = makeReviewProject(subtest, { briefStatus: 'draft' });
      const originalDraft = fs.readFileSync(state.briefPath);
      const workerPath = path.join(state.root, `crash-approval-${boundary}.js`);
      fs.writeFileSync(workerPath, String.raw`
const fs = require('node:fs');
const path = require('node:path');
const [modulePath, projectDir, boundary] = process.argv.slice(2);
const api = require(modulePath);
const manifest = api.readProjectManifest(projectDir);
const workspace = { dir: projectDir, manifest };
const crashingFs = {
  ...fs,
  linkSync(source, destination) {
    const result = fs.linkSync(source, destination);
    const name = path.basename(String(destination));
    if ((boundary === 'lease' && name === '.project-mutation.lock')
      || (boundary === 'markdown' && name === 'v01-approved.lesson.md')
      || (boundary === 'json' && name === 'v01-approved.lesson.json')) process.exit(82);
    return result;
  },
  renameSync(source, destination) {
    const result = fs.renameSync(source, destination);
    if (boundary === 'manifest' && String(source).includes('.tmp-approval-manifest-')) {
      process.exit(82);
    }
    return result;
  },
};
api.approveBrief(workspace, path.join(projectDir, manifest.currentBrief), { fileSystem: crashingFs });
process.exit(99);
`);
      const child = fork(
        workerPath,
        [require.resolve('../scripts/project/workspace'), state.workspace.dir, boundary],
        { stdio: 'ignore' },
      );
      assert.deepEqual(await waitForExit(child), { code: 82, signal: null });

      const afterCrash = readProjectManifest(state.workspace.dir);
      assert.equal(fs.existsSync(path.join(state.workspace.dir, afterCrash.currentBrief)), true);
      assert.deepEqual(fs.readFileSync(state.briefPath), originalDraft);

      const reopened = createOrOpenProject({ projectDir: state.workspace.dir });
      const render = nextRenderPaths(reopened, `Recovered ${boundary}`);
      recordRender(reopened, { ...render, status: 'started' });
      assert.equal(readProjectManifest(reopened.dir).renders.at(-1).status, 'started');
      assert.equal(fs.existsSync(path.join(reopened.dir, '.project-mutation.lock')), false);
    });
  }
});

test('approval keeps committed history when a post-rename manifest probe fails', async (t) => {
  for (const failedProbe of ['readFileSync', 'lstatSync']) {
    await t.test(failedProbe, (subtest) => {
      const state = makeReviewProject(subtest, { briefStatus: 'draft' });
      const manifestPath = path.join(state.workspace.dir, 'project.json');
      const approvedJsonPath = state.briefPath.replace('-draft.', '-approved.');
      const approvedMarkdownPath = approvedJsonPath.replace('.json', '.md');
      let manifestReplaced = false;
      let injected = false;
      const failingFs = {
        ...fs,
        renameSync(source, destination) {
          const result = fs.renameSync(source, destination);
          if (path.resolve(String(destination)) === path.resolve(manifestPath)
            && String(source).includes('.tmp-approval-manifest-')) {
            manifestReplaced = true;
          }
          return result;
        },
        [failedProbe](target, ...args) {
          if (manifestReplaced && !injected
            && path.resolve(String(target)) === path.resolve(manifestPath)) {
            injected = true;
            const error = new Error(`simulated post-rename ${failedProbe}`);
            error.code = 'EIO';
            throw error;
          }
          return fs[failedProbe](target, ...args);
        },
      };

      const approved = approveBrief(state.workspace, state.briefPath, { fileSystem: failingFs });

      assert.equal(injected, false);
      assert.equal(approved.jsonPath, approvedJsonPath);
      assert.equal(fs.existsSync(approvedJsonPath), true);
      assert.equal(fs.existsSync(approvedMarkdownPath), true);
      assert.equal(readProjectManifest(state.workspace.dir).currentBrief, 'brief/v01-approved.lesson.json');
    });
  }
});

test('direct manifest update rejects a stale expected snapshot instead of overwriting newer bytes', (t) => {
  const workspace = makeProject(t, 'Expected manifest CAS');
  const expected = structuredClone(workspace.manifest);
  const newer = { ...expected, name: 'Newer manifest', updatedAt: '2026-08-22T09:00:00.000Z' };
  writeProjectManifest(workspace.dir, newer, { expectedManifest: expected });
  const newerBytes = fs.readFileSync(path.join(workspace.dir, 'project.json'));

  const staleUpdate = { ...expected, name: 'Stale overwrite', updatedAt: '2026-08-22T09:01:00.000Z' };
  assert.throws(
    () => writeProjectManifest(workspace.dir, staleUpdate, { expectedManifest: expected }),
    (error) => error && error.code === 'PROJECT_MANIFEST_CONFLICT',
  );
  assert.deepEqual(fs.readFileSync(path.join(workspace.dir, 'project.json')), newerBytes);
});

test('initial brief publication preserves a foreign destination created at commit', (t) => {
  const workspace = makeProject(t, 'Initial brief collision');
  const manifestPath = path.join(workspace.dir, 'project.json');
  const beforeManifest = fs.readFileSync(manifestPath);
  const foreignPath = path.join(workspace.dir, 'brief/v01-draft.lesson.json');
  const foreignBytes = Buffer.from('foreign-initial-brief\n');
  let injected = false;
  const collisionFs = {
    ...fs,
    linkSync(source, destination) {
      if (!injected && path.resolve(String(destination)) === path.resolve(foreignPath)) {
        fs.writeFileSync(foreignPath, foreignBytes, { flag: 'wx' });
        injected = true;
      }
      return fs.linkSync(source, destination);
    },
  };

  assert.throws(() => publishBriefRevision(workspace, {
    kind: 'lesson',
    brief: { version: 1, status: 'draft', title: 'Collision' },
    markdown: '# Collision\n',
    status: 'draft',
    theme: 'lesson-neutral',
    aspect: 'horizontal',
  }, { fileSystem: collisionFs }), (error) => error && error.code === 'EEXIST');

  assert.equal(injected, true);
  assert.deepEqual(fs.readFileSync(foreignPath), foreignBytes);
  assert.equal(fs.existsSync(foreignPath.replace('.json', '.md')), false);
  assert.deepEqual(fs.readFileSync(manifestPath), beforeManifest);
});

test('two real processes racing initial brief publication never overwrite history', async (t) => {
  const workspace = makeProject(t, 'Initial brief race');
  const workerPath = path.join(path.dirname(workspace.dir), 'initial-brief-race.js');
  fs.writeFileSync(workerPath, String.raw`
const [modulePath, projectDir, title] = process.argv.slice(2);
const api = require(modulePath);
const workspace = { dir: projectDir, manifest: api.readProjectManifest(projectDir) };
if (process.send) process.send({ type: 'ready' });
process.once('message', () => {
  try {
    const result = api.publishBriefRevision(workspace, {
      kind: 'lesson', brief: { version: 1, status: 'draft', title },
      markdown: '# ' + title + '\n', status: 'draft', theme: 'lesson-neutral', aspect: 'horizontal',
    });
    process.send({ type: 'result', ok: true, result }, () => process.exit(0));
  } catch (error) {
    process.send({ type: 'result', ok: false, code: error && error.code }, () => process.exit(0));
  }
});
`);
  const children = ['LEFT', 'RIGHT'].map((title) => fork(
    workerPath,
    [require.resolve('../scripts/project/workspace'), workspace.dir, title],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  ));
  t.after(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
  });
  await Promise.all(children.map((child) => waitForMessage(child, 'ready')));
  const results = children.map((child) => waitForMessage(child, 'result'));
  const exits = children.map(waitForExit);
  for (const child of children) child.send('go');
  const resolved = await Promise.all(results);
  await Promise.all(exits);

  assert.equal(resolved.filter((result) => result.ok).length, 1);
  assert.deepEqual(resolved.filter((result) => !result.ok).map((result) => result.code), [
    'PROJECT_MANIFEST_CONFLICT',
  ]);
  const manifest = readProjectManifest(workspace.dir);
  assert.equal(manifest.briefs.length, 1);
  assert.equal(fs.existsSync(path.join(workspace.dir, manifest.currentBrief)), true);
  assert.equal(['LEFT', 'RIGHT'].includes(JSON.parse(
    fs.readFileSync(path.join(workspace.dir, manifest.currentBrief), 'utf8'),
  ).title), true);
});
