const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { hidePaths } = require('../qa/report');

// Хвост stderr preview, в котором ищется причина остановки барьером.
const STDERR_TAIL = 16384;
const REASON_MAX = 400;

// Барьер проверок (scripts/qa/preview-gates.js) останавливает preview строкой «preview не опубликован: …».
// Только эта русская причина уходит в интерфейс, без абсолютных путей проекта и движка; любой другой
// сбой остаётся голым PREVIEW_FAILED – сырой stderr в браузер не попадает.
function barrierReason(stderr, { projectDir, root }) {
  const match = /preview не опубликован: ([^\r\n]+)/u.exec(stderr);
  if (!match) return null;
  const text = hidePaths(hidePaths(match[1], projectDir), root).trim();
  return text ? text.slice(0, REASON_MAX) : null;
}

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
function createPreviewJobs({
  root,
  projectDir,
  getBase,
  spawnImpl = spawn,
  timeoutMs = 600000,
  maxOutputBytes = 1048576,
  maxJobs = 16,
} = {}) {
  const jobs = new Map();
  let active = null;
  let closed = false;
  function check(base) {
    const current = getBase();
    if (
      !base ||
      current.entry.revision !== base.baseRevision ||
      current.baseHash !== base.baseHash ||
      current.manifestHash !== base.manifestHash
    )
      throw failure('STALE_REVIEW_BASE');
    if (current.brief.status !== 'draft')
      throw failure('PREVIEW_DRAFT_REQUIRED');
    return current;
  }
  function start(input) {
    if (closed || active) throw failure('PREVIEW_BUSY');
    const current = check(input);
    if (!['full', 'excerpt'].includes(input.kind))
      throw failure('PREVIEW_INVALID_REQUEST');
    const args = [
      path.join(root, 'scripts', 'preview.js'),
      '--project-dir',
      projectDir,
      '--brief',
      current.briefFilePath,
      '--no-open',
    ];
    if (input.kind === 'excerpt') {
      const scene =
        Number.isInteger(input.sceneIndex) &&
        current.brief.scenes[input.sceneIndex];
      const fps = current.brief.output.fps;
      const duration = current.brief.output.durationInFrames / fps;
      if (
        !scene ||
        !Number.isFinite(scene.start) ||
        !Number.isFinite(scene.end) ||
        scene.start < 0 ||
        scene.end <= scene.start ||
        scene.end > duration
      )
        throw failure('PREVIEW_INVALID_REQUEST');
      args.push(
        '--from-sec',
        String(scene.start),
        '--to-sec',
        String(scene.end),
      );
    }
    const id = randomBytes(24).toString('base64url');
    const job = { id, status: 'running', error: null };
    while (jobs.size >= maxJobs) jobs.delete(jobs.keys().next().value);
    jobs.set(id, job);
    active = job;
    let child;
    let bytes = 0;
    let stderrTail = '';
    const stderrText = new StringDecoder('utf8');
    let timer;
    let killTimer;
    let resolveDone;
    job.done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    function killTree(signal) {
      if (!child?.pid) return;
      try {
        if (process.platform === 'win32')
          spawnImpl('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            shell: false,
            stdio: 'ignore',
          });
        else process.kill(-child.pid, signal);
      } catch (_) {
        /* already exited */
      }
    }
    job.cancel = (code = 'PREVIEW_CANCELLED') => {
      if (job.status !== 'running' || job.error) return;
      job.error = code;
      killTree('SIGTERM');
      killTimer = setTimeout(() => killTree('SIGKILL'), 750);
      killTimer.unref?.();
    };
    function finish(code) {
      if (job.status !== 'running') return;
      clearTimeout(timer);
      // Kill remaining descendants even if the parent exited before its children.
      if (job.error) killTree('SIGKILL');
      clearTimeout(killTimer);
      job.status = !job.error && code === 0 ? 'complete' : 'failed';
      if (job.status === 'failed' && !job.error) {
        const reason = barrierReason(stderrTail, { projectDir, root });
        if (reason) job.reason = reason;
        job.error = reason ? 'PREVIEW_BLOCKED' : 'PREVIEW_FAILED';
      }
      active = null;
      resolveDone();
    }
    try {
      const childEnv = { ...process.env };
      for (const name of [
        'PEXELS_API_KEY',
        'PIXABAY_API_KEY',
        'OPENVERSE_CLIENT_ID',
        'OPENVERSE_CLIENT_SECRET',
      ])
        delete childEnv[name];
      child = spawnImpl(process.execPath, args, {
        cwd: root,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...childEnv,
          AUTOMONTAGE_HEAVY_WAIT_MS: '0',
          AUTOMONTAGE_PREVIEW_MANIFEST_HASH: current.manifestHash,
          AUTOMONTAGE_PREVIEW_BRIEF_HASH: current.baseHash,
        },
      });
      for (const stream of [child.stdout, child.stderr])
        stream?.on('data', (chunk) => {
          bytes += chunk.length;
          if (stream === child.stderr) stderrTail = (stderrTail + stderrText.write(chunk)).slice(-STDERR_TAIL);
          if (bytes > maxOutputBytes) job.cancel('PREVIEW_OUTPUT_LIMIT');
        });
      child.once('error', () => {
        job.error = 'PREVIEW_FAILED';
        finish(1);
      });
      child.once('close', finish);
      timer = setTimeout(() => job.cancel('PREVIEW_TIMEOUT'), timeoutMs);
      timer.unref?.();
    } catch (_) {
      job.error = 'PREVIEW_FAILED';
      finish(1);
    }
    return { jobId: id, status: job.status };
  }
  return {
    start,
    check,
    get busy() {
      return Boolean(active);
    },
    get(id) {
      const job = jobs.get(id);
      if (!job) throw failure('PREVIEW_NOT_FOUND');
      return {
        jobId: id,
        status: job.status,
        ...(job.error ? { error: job.error } : {}),
        ...(job.reason ? { reason: job.reason } : {}),
      };
    },
    close() {
      closed = true;
      active?.cancel();
    },
    async waitIdle() {
      await Promise.allSettled([...jobs.values()].map((job) => job.done));
    },
  };
}
module.exports = { createPreviewJobs };
