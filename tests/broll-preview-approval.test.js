const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  createOrOpenProject,
  publishBriefRevision,
  approveBrief,
  readProjectManifest,
} = require('../scripts/project/workspace');
const {
  planPreview,
  publishCurrentPreview,
} = require('../scripts/project/preview-workspace');
const { validateLessonBrief } = require('../scripts/lesson/brief');
const hash = (x) => createHash('sha256').update(x).digest('hex');
function fixture(t, {width=320,height=180,previewWidth=width,previewHeight=height} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broll-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source.mp4');
  fs.writeFileSync(source, 'source');
  const workspace = createOrOpenProject({
    projectDir: path.join(dir, 'project'),
    name: 'Gate',
    sourcePath: source,
  });
  const brief = {
    version: 1,
    status: 'draft',
    source: workspace.sourcePath,
    theme: 'lesson-neutral',
    title: 'Gate',
    brollReviewPolicy: 'preview-required',
    output: {
      aspect: 'horizontal',
      width,
      height,
      fps: 25,
      durationInFrames: 100,
    },
    corrections: [],
    scenes: [{ scene: 'fullscreen', start: 0, end: 4, caption: 'Gate' }],
  };
  const draft = publishBriefRevision(workspace, { brief, markdown: '# Gate' });
  function preview(kind = 'full') {
    const plan = planPreview(workspace, {
      briefPath: draft.jsonPath,
      briefSha256: hash(fs.readFileSync(draft.jsonPath)),
      range: { kind, fromSec: 0, toSec: kind === 'full' ? 4 : 2 },
    });
    const staged = path.join(workspace.dir, 'previews', 'stage.mp4');
    fs.writeFileSync(staged, 'preview bytes');
    return publishCurrentPreview(workspace, plan, staged, {
      width: previewWidth,
      height: previewHeight,
      fps: 25,
      generatedAt: new Date().toISOString(),
    });
  }
  return { workspace, brief, draft, preview };
}
test('discovery approval requires full current preview and explicit confirmation', (t) => {
  const f = fixture(t);
  assert.throws(() => approveBrief(f.workspace, f.draft.jsonPath), /preview/i);
  f.preview('excerpt');
  assert.throws(
    () =>
      approveBrief(f.workspace, f.draft.jsonPath, {
        confirmPreviewViewed: true,
      }),
    /preview/i,
  );
  const p = f.preview();
  assert.throws(() => approveBrief(f.workspace, f.draft.jsonPath), /preview/i);
  assert.throws(
    () =>
      approveBrief(f.workspace, f.draft.jsonPath, {
        confirmPreviewViewed: true,
        expectedPreviewSha256: '0'.repeat(64),
      }),
    /preview/i,
  );
  const result = approveBrief(f.workspace, f.draft.jsonPath, {
    confirmPreviewViewed: true,
  });
  const approved = JSON.parse(fs.readFileSync(result.jsonPath));
  assert.equal(
    approved.brollApproval.draftSha256,
    hash(fs.readFileSync(f.draft.jsonPath)),
  );
  assert.equal(approved.brollApproval.previewSha256, p.metadata.sha256);
  assert.equal(
    validateLessonBrief(approved, { requireApproved: true }).ok,
    true,
  );
});
for (const altered of ['draft', 'current', 'revision', 'source'])
  test(`approval rejects changed ${altered} bytes`, (t) => {
    const f = fixture(t);
    const p = f.preview();
    const target = {
      draft: f.draft.jsonPath,
      current: p.currentPath,
      revision: p.revisionPath,
      source: f.workspace.sourcePath,
    }[altered];
    fs.appendFileSync(target, ' ');
    assert.throws(
      () =>
        approveBrief(f.workspace, f.draft.jsonPath, {
          confirmPreviewViewed: true,
        }),
      /preview|conflict/i,
    );
    assert.equal(readProjectManifest(f.workspace.dir).briefs.length, 1);
  });
test('preview publication rejects same-path draft edits after planning', (t) => {
  const f = fixture(t);
  const plan = planPreview(f.workspace, {
    briefPath: f.draft.jsonPath,
    briefSha256: hash(fs.readFileSync(f.draft.jsonPath)),
    range: { kind: 'full', fromSec: 0, toSec: 4 },
  });
  fs.appendFileSync(f.draft.jsonPath, ' ');
  const staged = path.join(f.workspace.dir, 'previews', 'stage.mp4');
  fs.writeFileSync(staged, 'preview');
  assert.throws(
    () =>
      publishCurrentPreview(f.workspace, plan, staged, {
        width: 320,
        height: 180,
        fps: 25,
        generatedAt: new Date().toISOString(),
      }),
    /preview/i,
  );
});
test('final validator rejects discovery approval without receipt', (t) => {
  const f = fixture(t);
  assert.equal(
    validateLessonBrief(
      { ...f.brief, status: 'approved' },
      { requireApproved: true },
    ).ok,
    false,
  );
});

test('preview jobs use fixed argv, reject stale/busy input and bound failed output', async (t) => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const { createPreviewJobs } = require('../scripts/review/preview-jobs');
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const base = {
    entry: { revision: 1 },
    baseHash: 'a',
    manifestHash: 'b',
    briefFilePath: '/test/brief.json',
    brief: {
      status: 'draft',
      output: { fps: 25, durationInFrames: 100 },
      scenes: [{ start: 0, end: 2 }],
    },
  };
  const credentials = [
    'PEXELS_API_KEY',
    'PIXABAY_API_KEY',
    'OPENVERSE_CLIENT_ID',
    'OPENVERSE_CLIENT_SECRET',
  ];
  const savedEnv = Object.fromEntries(
    credentials.map((name) => [name, process.env[name]]),
  );
  for (const name of credentials) process.env[name] = 'synthetic-private-test';
  t.after(() => {
    for (const name of credentials) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });
  let launched;
  const jobs = createPreviewJobs({
    root: '/test',
    projectDir: '/test/project',
    getBase: () => base,
    maxOutputBytes: 4,
    spawnImpl: (command, args, options) => {
      launched = { command, args, options };
      return child;
    },
  });
  const input = {
    baseRevision: 1,
    baseHash: 'a',
    manifestHash: 'b',
    kind: 'excerpt',
    sceneIndex: 0,
  };
  assert.throws(() => jobs.start({ ...input, baseHash: 'wrong' }), /STALE/);
  const job = jobs.start(input);
  assert.equal(launched.options.shell, false);
  assert.equal(launched.options.env.AUTOMONTAGE_HEAVY_WAIT_MS, '0');
  for (const name of [
    'PEXELS_API_KEY',
    'PIXABAY_API_KEY',
    'OPENVERSE_CLIENT_ID',
    'OPENVERSE_CLIENT_SECRET',
  ])
    assert.equal(Object.hasOwn(launched.options.env, name), false);
  assert.ok(launched.args.includes('--brief'));
  assert.deepEqual(launched.args.slice(-4), [
    '--from-sec',
    '0',
    '--to-sec',
    '2',
  ]);
  assert.throws(() => jobs.start(input), /BUSY/);
  child.stdout.write('excess');
  child.emit('close', 1);
  await jobs.waitIdle();
  assert.equal(jobs.get(job.jobId).error, 'PREVIEW_OUTPUT_LIMIT');
  const second = jobs.start({ ...input, kind: 'full' });
  jobs.close();
  child.emit('close', 1);
  await jobs.waitIdle();
  assert.equal(jobs.get(second.jobId).error, 'PREVIEW_CANCELLED');
});

// Барьер preview (scripts/qa/preview-gates.js) остановил preview: Review показывает его русскую причину, а не
// голый PREVIEW_FAILED. Абсолютные пути проекта и движка в причину не попадают; прочие сбои – как раньше.
test('a preview blocked by the QA barrier surfaces its Russian reason without paths', async () => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const { createPreviewJobs } = require('../scripts/review/preview-jobs');
  const base = {
    entry: { revision: 1 }, baseHash: 'a', manifestHash: 'b', briefFilePath: '/test/brief.json',
    brief: { status: 'draft', output: { fps: 25, durationInFrames: 100 }, scenes: [{ start: 0, end: 2 }] },
  };
  let child;
  const jobs = createPreviewJobs({
    root: '/engine/root', projectDir: '/srv/automontage/projects/client-x', getBase: () => base,
    spawnImpl: () => {
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      return child;
    },
  });
  const input = { baseRevision: 1, baseHash: 'a', manifestHash: 'b', kind: 'full' };
  const run = async (stderr, code = 1) => {
    const { jobId } = jobs.start(input);
    child.stdout.write('Проверки (preview): СТОП\n');
    child.stderr.write(stderr);
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('close', code);
    await jobs.waitIdle();
    return jobs.get(jobId);
  };
  const blocked = await run('❌ preview отменён: preview не опубликован: проверки не пройдены '
    + '(/srv/automontage/projects/client-x/qa/preview-20260929-120000-01.txt)\n');
  assert.equal(blocked.status, 'failed');
  assert.equal(blocked.error, 'PREVIEW_BLOCKED');
  assert.equal(blocked.reason, 'проверки не пройдены (qa/preview-20260929-120000-01.txt)');
  const unwritten = await run('❌ preview отменён: preview не опубликован: отчёт проверок не записан '
    + "(не удалось записать в qa/: qa/ должна быть папкой проекта, а не ссылкой или файлом – уберите её и верните настоящую папку qa/)\n");
  assert.equal(unwritten.error, 'PREVIEW_BLOCKED');
  assert.match(unwritten.reason, /^отчёт проверок не записан \(не удалось записать в qa\/: qa\/ должна быть папкой проекта/u);
  const busy = await run('preview не опубликован: машина занята: layer render demo\n');
  assert.equal(busy.error, 'PREVIEW_BLOCKED');
  assert.equal(busy.reason, 'машина занята: layer render demo');
  // Любой другой сбой – прежний код без текста: сырой stderr в браузер не уходит.
  const other = await run('❌ preview отменён: ENOENT /engine/root/node_modules/.bin/remotion\n');
  assert.equal(other.error, 'PREVIEW_FAILED');
  assert.equal(Object.hasOwn(other, 'reason'), false);
  const ok = await run('', 0);
  assert.equal(ok.status, 'complete');
  assert.equal(Object.hasOwn(ok, 'reason'), false);
});

for (const stage of ['approval-json', 'approval-manifest'])
  test(`approval detects preview replacement during ${stage} staging and rolls back`, (t) => {
    const f = fixture(t);
    const p = f.preview();
    const before = fs.readFileSync(path.join(f.workspace.dir, 'project.json'));
    let changed = false;
    const fileSystem = new Proxy(fs, {
      get(target, key) {
        if (key !== 'openSync') return Reflect.get(target, key);
        return (filename, ...args) => {
          if (!changed && String(filename).includes(`.tmp-${stage}-`)) {
            changed = true;
            fs.appendFileSync(p.currentPath, 'changed');
          }
          return target.openSync(filename, ...args);
        };
      },
    });
    assert.throws(
      () =>
        approveBrief(f.workspace, f.draft.jsonPath, {
          fileSystem,
          confirmPreviewViewed: true,
        }),
      /preview/i,
    );
    assert.equal(changed, true);
    assert.deepEqual(
      fs.readFileSync(path.join(f.workspace.dir, 'project.json')),
      before,
    );
    assert.equal(
      fs.existsSync(f.draft.jsonPath.replace('-draft.', '-approved.')),
      false,
    );
  });

test('preview and approval HTTP boundaries preserve read-only, token, Origin and exact payload shape', async (t) => {
  const { makeReviewProject } = require('./helpers/review-project');
  const { startReviewServer } = require('../scripts/review/server');
  for (const editable of [true, false]) {
    const f = makeReviewProject(t);
    const session = await startReviewServer({
      projectDir: f.projectDir,
      editable,
      open: false,
      runToolImpl: () => ({ status: 1 }),
    });
    t.after(() => new Promise((resolve) => session.server.close(resolve)));
    const request = (route, body, headers = {}) =>
      fetch(session.origin + route, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.token}`,
          Origin: session.origin,
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
      });
    const state = await (
      await fetch(session.origin + '/api/state', {
        headers: { Authorization: `Bearer ${session.token}` },
      })
    ).json();
    const base = {
      baseRevision: state.session.baseRevision,
      baseHash: state.session.baseHash,
      manifestHash: state.session.manifestHash,
    };
    assert.equal(
      (
        await request(
          '/api/broll/preview',
          { ...base, kind: 'full' },
          { Authorization: 'Bearer invalid' },
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await request(
          '/api/broll/approve',
          { ...base, confirmPreviewViewed: true },
          { Origin: 'https://foreign.invalid' },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request('/api/broll/preview', {
          ...base,
          kind: 'full',
          brief: '/private/forged.json',
        })
      ).status,
      editable ? 400 : 405,
    );
    assert.equal(
      (await request('/api/broll/approve', base)).status,
      editable ? 400 : 405,
    );
    const missing = await fetch(
      session.origin + '/api/broll/preview-job?id=unavailable',
      { headers: { Authorization: `Bearer ${session.token}` } },
    );
    assert.equal(missing.status, editable ? 404 : 405);
    assert.equal(readProjectManifest(f.projectDir).briefs.length, 1);
  }
});

test('cancelling a real preview job terminates its child process tree', async (t) => {
  const { createPreviewJobs } = require('../scripts/review/preview-jobs');
  const { spawn } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-cancel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, 'orphan');
  const childCode = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'orphan'),1800)`;
  const parentCode = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'inherit'});console.log('ready');setInterval(()=>{},1000);`;
  let ready;
  const started = new Promise((resolve) => {
    ready = resolve;
  });
  const base = {
    entry: { revision: 1 },
    baseHash: 'a',
    manifestHash: 'b',
    briefFilePath: '/test/brief.json',
    brief: { status: 'draft' },
  };
  const jobs = createPreviewJobs({
    root: dir,
    projectDir: dir,
    getBase: () => base,
    spawnImpl: (command, args, options) => {
      const child = spawn(process.execPath, ['-e', parentCode], options);
      child.stdout.once('data', ready);
      return child;
    },
  });
  const job = jobs.start({
    baseRevision: 1,
    baseHash: 'a',
    manifestHash: 'b',
    kind: 'full',
  });
  await started;
  jobs.close();
  await jobs.waitIdle();
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(fs.existsSync(marker), false);
  assert.equal(jobs.get(job.jobId).error, 'PREVIEW_CANCELLED');
});

test('approved receipt keeps the reviewed full preview current while a newly saved draft is stale', (t) => {
  const f = fixture(t);
  const p = f.preview();
  fs.writeFileSync(
    path.join(f.workspace.dir, 'transcript', 'words.json'),
    '[]',
  );
  const { loadReviewState } = require('../scripts/review/model');
  approveBrief(f.workspace, f.draft.jsonPath, { confirmPreviewViewed: true });
  assert.equal(
    loadReviewState({
      root: path.resolve(__dirname, '..'),
      projectDir: f.workspace.dir,
    }).currentPreview.stale,
    false,
  );
  const next = { ...f.brief, title: 'New draft' };
  publishBriefRevision(f.workspace, { brief: next, markdown: '# New' });
  assert.equal(
    loadReviewState({
      root: path.resolve(__dirname, '..'),
      projectDir: f.workspace.dir,
    }).currentPreview.stale,
    true,
  );
});

for (const [field, value] of [
  ['width', 158],
  ['height', 88],
  ['fps', 24],
  ['toSec', 3.96],
  ['fromSec', 0.04],
])
  test(`approval rejects full preview with changed ${field}`, (t) => {
    const f = fixture(t);
    f.preview();
    const manifestPath = path.join(f.workspace.dir, 'project.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    manifest.currentPreview[field] = value;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    f.workspace.manifest = manifest;
    assert.throws(
      () =>
        approveBrief(f.workspace, f.draft.jsonPath, {
          confirmPreviewViewed: true,
        }),
      /preview/i,
    );
  });

test('source or preview symlink replacement fails approval without changing history', (t) => {
  const f = fixture(t);
  const p = f.preview();
  fs.unlinkSync(p.currentPath);
  fs.symlinkSync(p.revisionPath, p.currentPath);
  assert.throws(
    () =>
      approveBrief(f.workspace, f.draft.jsonPath, {
        confirmPreviewViewed: true,
      }),
    /preview|symbolic/i,
  );
  assert.equal(readProjectManifest(f.workspace.dir).briefs.length, 1);
});

test('editing an approved discovery brief clears its old approval receipt and preserves policy', (t) => {
  const f = fixture(t);
  f.preview();
  const approved = approveBrief(f.workspace, f.draft.jsonPath, {
    confirmPreviewViewed: true,
  });
  const base = JSON.parse(fs.readFileSync(approved.jsonPath));
  const { validateReviewCandidate } = require('../scripts/review/commands');
  const { diffLessonBrief } = require('../scripts/review/diff');
  const candidate = structuredClone(base);
  validateReviewCandidate({ candidate, base, assets: new Map(), fps: 25 });
  assert.equal(candidate.status, 'draft');
  assert.equal(candidate.brollApproval, undefined);
  assert.equal(candidate.brollReviewPolicy, 'preview-required');
  assert.deepEqual(diffLessonBrief({ before: base, after: candidate }), []);
});

test('resolved intent cannot bypass preview gating by omitting the policy marker', (t) => {
  const f = fixture(t);
  const brief = { ...f.brief };
  delete brief.brollReviewPolicy;
  brief.scenes = [
    {
      scene: 'broll',
      start: 0,
      end: 4,
      headCream: 'COLOR',
      headOrange: 'BLUE',
      brollSrc: 'assets/broll/color.png',
      brollIntent: {
        goal: 'Color',
        sourceText: 'Blue color',
        queryOriginal: 'blue',
        queryEnglish: 'blue',
      },
    },
  ];
  fs.writeFileSync(
    path.join(f.workspace.dir, 'assets/broll/color.png'),
    'image',
  );
  fs.writeFileSync(f.draft.jsonPath, JSON.stringify(brief));
  assert.throws(() => approveBrief(f.workspace, f.draft.jsonPath), /preview/i);
});

test(
  'server close aborts an active HTTP preview job and busy preview rejects Save',
  { timeout: 10000 },
  async (t) => {
    const { startReviewServer } = require('../scripts/review/server');
    const { spawn } = require('node:child_process');
    const f = fixture(t);
    fs.writeFileSync(path.join(f.workspace.dir, 'transcript/words.json'), '[]');
    let ready;
    const started = new Promise((resolve) => {
      ready = resolve;
    });
    const session = await startReviewServer({
      projectDir: f.workspace.dir,
      editable: true,
      open: false,
      runToolImpl: () => ({ status: 1 }),
      previewSpawnImpl(command, args, options) {
        const child = spawn(
          process.execPath,
          ['-e', "console.log('ready');setInterval(()=>{},1000)"],
          options,
        );
        child.stdout.once('data', ready);
        return child;
      },
    });
    t.after(async () => {
      session.server.close();
      await session.waitForActiveImports();
    });
    const headers = {
      Authorization: `Bearer ${session.token}`,
      Origin: session.origin,
      'Content-Type': 'application/json',
    };
    const state = await (
      await fetch(session.origin + '/api/state', { headers })
    ).json();
    const base = {
      baseRevision: state.session.baseRevision,
      baseHash: state.session.baseHash,
      manifestHash: state.session.manifestHash,
    };
    const response = await fetch(session.origin + '/api/broll/preview', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...base, kind: 'full' }),
    });
    assert.equal(response.status, 202);
    await started;
    const save = await fetch(session.origin + '/api/save', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...base, commands: [] }),
    });
    assert.equal(save.status, 409);
    await new Promise((resolve) => session.server.close(resolve));
    await session.waitForActiveImports();
    assert.equal(
      readProjectManifest(f.workspace.dir).currentPreview,
      undefined,
    );
    assert.equal(readProjectManifest(f.workspace.dir).briefs.length, 1);
  },
);

test(
  'the server takes no project lease while a preview job runs',
  { timeout: 20000 },
  async (t) => {
    const { startReviewServer } = require('../scripts/review/server');
    const { spawn } = require('node:child_process');
    const f = fixture(t);
    fs.writeFileSync(path.join(f.workspace.dir, 'transcript/words.json'), '[]');
    const leasePath = path.join(f.workspace.dir, '.project-mutation.lock');
    let jobRunning = false;
    let leasesDuringJob = 0;
    // Lease берётся жёсткой ссылкой на project-mutation.lock: считаем такие ссылки сервера,
    // пока preview-процесс жив.
    const fileSystem = new Proxy(fs, {
      get(target, key) {
        if (key !== 'linkSync') return Reflect.get(target, key);
        return (existing, destination) => {
          if (jobRunning && path.resolve(String(destination)) === leasePath) leasesDuringJob += 1;
          return target.linkSync(existing, destination);
        };
      },
    });
    const session = await startReviewServer({
      projectDir: f.workspace.dir,
      editable: true,
      open: false,
      fileSystem,
      runToolImpl: () => ({ status: 1 }),
      previewSpawnImpl(command, args, options) {
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1200)'], options);
        jobRunning = true;
        child.once('close', () => {
          jobRunning = false;
        });
        return child;
      },
    });
    try {
      const headers = {
        Authorization: `Bearer ${session.token}`,
        Origin: session.origin,
        'Content-Type': 'application/json',
      };
      const state = await (
        await fetch(session.origin + '/api/state', { headers })
      ).json();
      const response = await fetch(session.origin + '/api/broll/preview', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          baseRevision: state.session.baseRevision,
          baseHash: state.session.baseHash,
          manifestHash: state.session.manifestHash,
          kind: 'full',
        }),
      });
      assert.equal(response.status, 202);
      const { jobId } = await response.json();
      const deadline = Date.now() + 10000;
      let job;
      let polls = 0;
      do {
        await new Promise((resolve) => setTimeout(resolve, 50));
        job = await (
          await fetch(`${session.origin}/api/broll/preview-job?id=${encodeURIComponent(jobId)}`, { headers })
        ).json();
        await fetch(session.origin + '/api/state', { headers });
        polls += 1;
      } while (job.status === 'running' && Date.now() < deadline);
      assert.equal(job.status, 'complete');
      assert.ok(polls > 5, `опросов во время preview: ${polls}`);
      assert.equal(leasesDuringJob, 0, `сервер брал project lease во время preview: ${leasesDuringJob}`);
    } finally {
      await new Promise((resolve) => session.server.close(resolve));
      await session.waitForActiveImports();
    }
  },
);

test(
  'status polls of a running preview never take the project lease its publication needs',
  { timeout: 20000 },
  async (t) => {
    const { startReviewServer } = require('../scripts/review/server');
    const { spawn } = require('node:child_process');
    const f = fixture(t);
    fs.writeFileSync(path.join(f.workspace.dir, 'transcript/words.json'), '[]');
    const stopFile = path.join(path.dirname(f.workspace.dir), 'stop-publisher');
    // Как публикация настоящего preview.js: берёт и отпускает project lease, пока браузер
    // опрашивает задание. Конфликт с опросом сервера = preview сорван «stale snapshot».
    // Файл-сигнал и предел по времени гарантируют, что процесс не крутится после сбоя теста.
    const publisher = `
      const fs = require('node:fs');
      const { acquireProjectMutationLease } = require(${JSON.stringify(path.join(__dirname, '..', 'scripts', 'project', 'workspace.js'))});
      const dir = ${JSON.stringify(f.workspace.dir)};
      const stopFile = ${JSON.stringify(stopFile)};
      console.log('ready');
      const end = Date.now() + 3000;
      let conflicts = 0;
      const pause = new Int32Array(new SharedArrayBuffer(4));
      while (Date.now() < end && !fs.existsSync(stopFile)) {
        try { acquireProjectMutationLease(dir).release(); }
        catch (error) { if (error.code !== 'PROJECT_MANIFEST_CONFLICT') throw error; conflicts += 1; }
        // Промежуток без lease: в него успевает войти опрос сервера, если он берёт lease.
        Atomics.wait(pause, 0, 0, 2);
      }
      process.exit(conflicts ? 3 : 0);
    `;
    let ready;
    const started = new Promise((resolve) => {
      ready = resolve;
    });
    const session = await startReviewServer({
      projectDir: f.workspace.dir,
      editable: true,
      open: false,
      runToolImpl: () => ({ status: 1 }),
      previewSpawnImpl(command, args, options) {
        const child = spawn(process.execPath, ['-e', publisher], options);
        child.stdout.once('data', ready);
        return child;
      },
    });
    try {
      const headers = {
        Authorization: `Bearer ${session.token}`,
        Origin: session.origin,
        'Content-Type': 'application/json',
      };
      const state = await (
        await fetch(session.origin + '/api/state', { headers })
      ).json();
      const response = await fetch(session.origin + '/api/broll/preview', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          baseRevision: state.session.baseRevision,
          baseHash: state.session.baseHash,
          manifestHash: state.session.manifestHash,
          kind: 'full',
        }),
      });
      assert.equal(response.status, 202);
      const { jobId } = await response.json();
      await started;
      const deadline = Date.now() + 10000;
      let job;
      let polls = 0;
      do {
        const poll = await fetch(
          `${session.origin}/api/broll/preview-job?id=${encodeURIComponent(jobId)}`,
          { headers },
        );
        job = { http: poll.status, ...(await poll.json()) };
        polls += 1;
        assert.equal(job.http, 200, `опрос задания вернул HTTP ${job.http}: ${job.error}`);
      } while (job.status === 'running' && Date.now() < deadline);
      assert.ok(polls > 5, `опросов во время публикации: ${polls}`);
      assert.equal(job.status, 'complete', `опрос задания сорвал публикацию: ${job.error}`);
    } finally {
      fs.writeFileSync(stopFile, 'stop');
      await new Promise((resolve) => session.server.close(resolve));
      await session.waitForActiveImports();
    }
  },
);

test('final all-file barrier rejects a prior preview modified during the later source hash', (t) => {
  const f = fixture(t); const p = f.preview();
  const descriptors = new Map(); let sourceReads = 0; let mutated = false;
  const fileSystem = new Proxy(fs, { get(target, key) {
    if (key === 'openSync') return (filename, ...args) => { const fd = target.openSync(filename, ...args); descriptors.set(fd, String(filename)); return fd; };
    if (key === 'readSync') return (fd, buffer, offset, length, position) => {
      const read = target.readSync(fd, buffer, offset, length, position);
      if (descriptors.get(fd) === f.workspace.sourcePath && position === 0 && ++sourceReads === 4) { fs.writeFileSync(p.revisionPath, 'tampered bytes'); mutated = true; }
      return read;
    };
    return Reflect.get(target, key);
  }});
  assert.throws(() => approveBrief(f.workspace, f.draft.jsonPath, {confirmPreviewViewed:true,fileSystem}), /preview/i);
  assert.equal(mutated,true);assert.equal(readProjectManifest(f.workspace.dir).briefs.length,1);
});

for (const [width,height,previewWidth,previewHeight] of [[2048,1080,1920,1012],[1080,2048,1012,1920]]) {
  test(`approval accepts actual even DCI preview ${width}x${height}`, (t) => {
    const f=fixture(t,{width,height,previewWidth,previewHeight});
    f.preview();
    assert.doesNotThrow(() => approveBrief(f.workspace,f.draft.jsonPath,{confirmPreviewViewed:true}));
  });
}

// Ролики, начатые до рабочего 1080p, хранят preview в половину композиции: их утверждение не требует пересборки.
test('approval still accepts a legacy half-size preview of an unchanged draft', (t) => {
  const f=fixture(t,{width:1080,height:1920,previewWidth:540,previewHeight:960});
  f.preview();
  assert.doesNotThrow(() => approveBrief(f.workspace,f.draft.jsonPath,{confirmPreviewViewed:true}));
});

test('approval rejects a preview that is neither the current nor the legacy size', (t) => {
  const f=fixture(t,{width:1080,height:1920,previewWidth:720,previewHeight:1280});
  f.preview();
  assert.throws(() => approveBrief(f.workspace,f.draft.jsonPath,{confirmPreviewViewed:true}), /preview/i);
});
