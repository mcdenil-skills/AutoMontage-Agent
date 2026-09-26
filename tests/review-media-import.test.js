const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { spawnSync } = require('node:child_process');

const {
  IMAGE_MAX_BYTES,
  VIDEO_MAX_BYTES,
  createImportController,
  deriveOutputBudgets,
  importReviewMedia,
  parseImportHeaders,
  requiredFreeBytes,
} = require('../scripts/review/media-import');
const { runMediaProcess } = require('../scripts/review/media-process');
const { cleanupOrphanImportedStages } = require('../scripts/review/imported-assets');
const {
  ffmpegEncoderAvailable,
  makeMediaFixtures,
  toolAvailable,
} = require('./helpers/media-fixtures');
const { windowsFileSystem } = require('./helpers/windows-filesystem');

const UUID = '4af36be4-0b26-4e6f-bd48-8bdd2215a4f1';

function rawHeaders(filename, contentType, contentLength) {
  return {
    'content-length': String(contentLength),
    'content-type': contentType,
    'x-automontage-filename': encodeURIComponent(filename),
  };
}

function expectImportError(fn, status, code) {
  assert.throws(fn, (error) => error.status === status && error.code === code);
}

function tempProject(t) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-media-import-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  return projectDir;
}

function findRegularFileWithBytes(root, expected) {
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const nested = findRegularFileWithBytes(candidate, expected);
      if (nested) return nested;
    } else if (entry.isFile() && fs.readFileSync(candidate, 'utf8') === expected) {
      return candidate;
    }
  }
  return null;
}

function findSymlinkTo(root, expected) {
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isSymbolicLink() && fs.readlinkSync(candidate) === expected) return candidate;
    if (entry.isDirectory()) {
      const nested = findSymlinkTo(candidate, expected);
      if (nested) return nested;
    }
  }
  return null;
}

function probeJson({
  kind = 'video',
  width = 320,
  height = 180,
  fps = '25/1',
  avgFps = fps,
  realFps = fps,
  duration = 1,
  videoDuration = duration,
  audioDuration = duration,
  containerDuration = duration,
  audio = false,
  rotation = 0,
  formatName = kind === 'image' ? 'png_pipe' : 'mov,mp4,m4a,3gp,3g2,mj2',
  videoCodec = kind === 'image' ? 'png' : 'h264',
  pixelFormat = kind === 'image' ? 'rgba' : 'yuv420p',
  audioCodec = 'aac',
  audioSampleRate = 48000,
  audioChannels = 2,
} = {}) {
  return JSON.stringify({
    streams: [
      {
        codec_type: 'video', codec_name: videoCodec, pix_fmt: pixelFormat,
        width, height, avg_frame_rate: avgFps, r_frame_rate: realFps,
        ...(kind === 'video' ? { duration: String(videoDuration) } : {}),
        ...(rotation ? { side_data_list: [{ rotation }] } : {}),
      },
      ...(audio ? [{
        codec_type: 'audio', codec_name: audioCodec,
        sample_rate: String(audioSampleRate), channels: audioChannels,
        duration: String(audioDuration),
      }] : []),
    ],
    format: {
      format_name: formatName,
      ...(kind === 'video' ? { duration: String(containerDuration) } : {}),
    },
  });
}

function fakeProcessor({
  source = probeJson(),
  imageOverrides = {},
  masterOverrides = {},
  proxyOverrides = {},
  onCall,
} = {}) {
  const parsedSource = JSON.parse(source);
  const sourceVideo = parsedSource.streams.find((stream) => stream.codec_type === 'video');
  const sourceAudio = parsedSource.streams.some((stream) => stream.codec_type === 'audio');
  const sourceRotation = Number(sourceVideo.side_data_list?.[0]?.rotation || 0);
  let normalizedFps = 25;
  return async (invocation) => {
    onCall?.(invocation);
    if (invocation.command === 'ffprobe') {
      const input = invocation.args.at(-1);
      if (input.includes('upload')) return { stdout: source, stderr: '', code: 0, signal: null };
      const rotated = [90, -90, 270, -270].includes(sourceRotation);
      const normalizedShape = {
        width: rotated ? sourceVideo.height : sourceVideo.width,
        height: rotated ? sourceVideo.width : sourceVideo.height,
      };
      if (input.endsWith('.webp')) return {
        stdout: probeJson({
          kind: 'image', ...normalizedShape, videoCodec: 'webp', formatName: 'webp_pipe',
          pixelFormat: /a/.test(sourceVideo.pix_fmt || '') ? 'yuva420p' : 'yuv420p',
          ...imageOverrides,
        }),
        stderr: '', code: 0, signal: null,
      };
      const isProxy = input.endsWith('.webm');
      const scale = isProxy ? Math.min(1, 1280 / Math.max(normalizedShape.width, normalizedShape.height)) : 1;
      const outputShape = {
        width: Math.max(2, Math.ceil(normalizedShape.width * scale / 2) * 2),
        height: Math.max(2, Math.ceil(normalizedShape.height * scale / 2) * 2),
      };
      return { stdout: probeJson({
        ...outputShape,
        audio: sourceAudio,
        fps: `${normalizedFps}/1`,
        duration: Number(sourceVideo.duration || 1),
        videoDuration: Number(sourceVideo.duration || 1),
        audioDuration: sourceAudio
          ? Math.min(
            Number(sourceVideo.duration || 1),
            Number(parsedSource.streams.find((stream) => stream.codec_type === 'audio').duration),
          )
          : Number(sourceVideo.duration || 1),
        containerDuration: Number(sourceVideo.duration || 1),
        videoCodec: isProxy ? 'vp8' : 'h264',
        pixelFormat: 'yuv420p',
        formatName: isProxy ? 'matroska,webm' : 'mov,mp4,m4a,3gp,3g2,mj2',
        audioCodec: isProxy ? 'opus' : 'aac',
        ...(isProxy ? proxyOverrides : masterOverrides),
      }), stderr: '', code: 0, signal: null };
    }
    if (invocation.command === 'ffmpeg' && !invocation.args.includes('null')) {
      const fpsFilter = invocation.args.find((value) => typeof value === 'string' && /(?:^|,)fps=/.test(value));
      const fpsMatch = /(?:^|,)fps=([0-9.]+)/.exec(fpsFilter || '');
      if (fpsMatch) normalizedFps = Number(fpsMatch[1]);
      fs.writeFileSync(invocation.args.at(-1), `normalized:${path.extname(invocation.args.at(-1))}`);
    }
    return { stdout: '', stderr: '', code: 0, signal: null };
  };
}

test('import headers require canonical length and an encoded single safe filename component', () => {
  assert.deepEqual(parseImportHeaders(rawHeaders('Product demo.mov', 'video/quicktime', 123)), {
    contentLength: 123,
    contentType: 'video/quicktime',
    extension: '.mov',
    filename: 'Product demo.mov',
    mediaKind: 'video',
  });
  assert.equal(
    parseImportHeaders(rawHeaders('Cafe\u0301.png', 'image/png', 1)).filename,
    'Café.png',
  );
  for (const value of [undefined, ['1', '1'], '', '0', '+1', ' 1', '1 ', '01', '1.0', '9007199254740992']) {
    const headers = rawHeaders('x.png', 'image/png', 1);
    headers['content-length'] = value;
    expectImportError(() => parseImportHeaders(headers), 400, 'MEDIA_IMPORT_LENGTH_INVALID');
  }
  for (const value of [undefined, ['x.png'], '%', '..%2Fsecret.png', 'C%3A%5Csecret.png', 'bad%00.png', 'bad%0A.png', 'photo.exe.png', `${'é'.repeat(126)}.png`]) {
    const headers = rawHeaders('x.png', 'image/png', 1);
    headers['x-automontage-filename'] = value;
    expectImportError(() => parseImportHeaders(headers), 400, 'MEDIA_IMPORT_FILENAME_INVALID');
  }
});

test('import headers enforce extension/MIME matrix, octet-stream, and exact byte ceilings', () => {
  const accepted = [
    ['x.avif', 'image/avif'], ['x.gif', 'image/gif'], ['x.jpeg', 'image/jpeg'],
    ['x.jpg', 'image/jpeg'], ['x.png', 'image/png'], ['x.webp', 'image/webp'],
    ['x.mp4', 'video/mp4'], ['x.mov', 'video/quicktime'], ['x.m4v', 'video/x-m4v'], ['x.webm', 'video/webm'],
    ['x.png', 'application/octet-stream'], ['x.mov', 'application/octet-stream'],
  ];
  for (const [filename, mime] of accepted) assert.doesNotThrow(() => parseImportHeaders(rawHeaders(filename, mime, 1)));
  for (const [filename, mime] of [['x.exe', 'application/octet-stream'], ['x.png', 'video/mp4'], ['x.mov', 'image/png']]) {
    expectImportError(() => parseImportHeaders(rawHeaders(filename, mime, 1)), 415, 'MEDIA_IMPORT_TYPE_UNSUPPORTED');
  }
  assert.equal(parseImportHeaders(rawHeaders('x.png', 'image/png', IMAGE_MAX_BYTES)).contentLength, IMAGE_MAX_BYTES);
  expectImportError(() => parseImportHeaders(rawHeaders('x.png', 'image/png', IMAGE_MAX_BYTES + 1)), 413, 'MEDIA_IMPORT_TOO_LARGE');
  assert.equal(parseImportHeaders(rawHeaders('x.mp4', 'video/mp4', VIDEO_MAX_BYTES)).contentLength, VIDEO_MAX_BYTES);
  expectImportError(() => parseImportHeaders(rawHeaders('x.mp4', 'video/mp4', VIDEO_MAX_BYTES + 1)), 413, 'MEDIA_IMPORT_TOO_LARGE');
  assert.equal(requiredFreeBytes(7), 4n * 7n + 512n * 1024n * 1024n);
});

test('output budgets include geometry and time, clamp absolute caps, and reject unsafe arithmetic inputs', () => {
  const tiny = deriveOutputBudgets({
    mediaKind: 'video', inputBytes: 1, width: 320, height: 180,
    durationSec: 1, fps: 25, hasAudio: false,
  });
  const long4k = deriveOutputBudgets({
    mediaKind: 'video', inputBytes: 1, width: 4096, height: 2160,
    durationSec: 1800, fps: 120, hasAudio: true,
  });
  assert.ok(tiny.master > 4n);
  assert.ok(long4k.master > tiny.master);
  assert.equal(long4k.master, 2n * 1024n * 1024n * 1024n);
  assert.equal(long4k.proxy, 512n * 1024n * 1024n);
  assert.throws(() => deriveOutputBudgets({
    mediaKind: 'video', inputBytes: Number.MAX_SAFE_INTEGER,
    width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER,
    durationSec: Number.MAX_VALUE, fps: Number.MAX_VALUE,
  }), (error) => error.code === 'MEDIA_IMPORT_OUTPUT_BUDGET_INVALID');
});

test('disk reserve is checked before reading a request byte', async (t) => {
  let reads = 0;
  const request = new Readable({ read() { reads += 1; this.push(Buffer.from('x')); this.push(null); } });
  await assert.rejects(importReviewMedia({
    request,
    projectDir: tempProject(t),
    outputFps: 25,
    headers: rawHeaders('x.png', 'image/png', 1),
    controller: createImportController(),
    statfsImpl: () => ({ bavail: 0, bsize: 4096 }),
    randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({ source: probeJson({ kind: 'image' }) }),
  }), (error) => error.status === 507 && error.code === 'MEDIA_IMPORT_DISK_FULL');
  assert.equal(reads, 0);
});

test('import publishes video when ffprobe average FPS is 0/0 but real FPS is valid', async (t) => {
  const projectDir = tempProject(t);
  const result = await importReviewMedia({
    request: Readable.from([Buffer.from('x')]),
    projectDir,
    outputFps: 25,
    headers: rawHeaders('fallback-fps.mp4', 'video/mp4', 1),
    controller: createImportController(),
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }),
    randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({
      source: probeJson({ avgFps: '0/0', realFps: '25/1' }),
    }),
  });

  assert.equal(result.fps, 25);
  assert.equal(fs.existsSync(result.filePath), true);
  assert.equal(fs.existsSync(result.previewPath), true);
  assert.equal(fs.existsSync(path.join(path.dirname(result.filePath), 'asset.json')), true);
});

test('discovery import publishes v3 evidence while manual import remains v2', async (t) => {
  const projectDir = tempProject(t);
  const provenance = {
    provider: 'pexels', providerAssetId: '123',
    sourcePage: 'https://www.pexels.com/photo/example-123/',
    author: { name: 'Jane', url: 'https://www.pexels.com/@jane/' },
    license: { name: 'Pexels License', url: 'https://www.pexels.com/license/' },
    queryOriginal: 'офис', queryEnglish: 'office',
    retrievedAt: '2026-09-08T12:00:00.000Z',
    rendition: { id: 'original', width: 320, height: 180, mimeType: 'image/png' },
  };
  const textScan = {
    status: 'needs-review', text: 'ACME', reasons: ['embedded-text-detected'], engine: 'tesseract',
  };
  const result = await importReviewMedia({
    request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
    headers: rawHeaders('found.png', 'image/png', 1), controller: createImportController(),
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({ source: probeJson({ kind: 'image' }) }),
    provenance, scanEmbeddedTextImpl: async (input) => {
      assert.equal(input.filePath.endsWith('/bundle/media.webp'), true);
      return textScan;
    },
  });
  const published = JSON.parse(fs.readFileSync(path.join(path.dirname(result.filePath), 'asset.json')));
  assert.equal(published.version, 3);
  assert.deepEqual(published.provenance, provenance);
  assert.deepEqual(published.textScan, textScan);
});

test('discovery import cancelled after scanning publishes no bundle', async (t) => {
  const projectDir = tempProject(t);
  const abort = new AbortController();
  const provenance = {
    provider: 'pexels', providerAssetId: '123',
    sourcePage: 'https://www.pexels.com/photo/example-123/',
    author: { name: 'Jane', url: 'https://www.pexels.com/@jane/' },
    license: { name: 'Pexels License', url: 'https://www.pexels.com/license/' },
    queryOriginal: 'офис', queryEnglish: 'office',
    retrievedAt: '2026-09-08T12:00:00.000Z',
    rendition: { id: 'original', width: 320, height: 180, mimeType: 'image/png' },
  };
  await assert.rejects(importReviewMedia({
    request: Readable.from([Buffer.from('x')]), signal: abort.signal,
    projectDir, outputFps: 25, headers: rawHeaders('found.png', 'image/png', 1),
    controller: createImportController(),
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({ source: probeJson({ kind: 'image' }) }), provenance,
    scanEmbeddedTextImpl: async () => {
      abort.abort();
      return { status: 'clear', text: '', reasons: [], engine: 'tesseract' };
    },
  }), (error) => error.code === 'MEDIA_PROCESS_ABORTED');
  assert.equal(fs.existsSync(path.join(projectDir, 'assets', 'broll', 'images', UUID)), false);
});

test('video normalization uses visual duration, even padding, explicit audio duration, and hard encoder bounds', async (t) => {
  const projectDir = tempProject(t);
  const calls = [];
  const result = await importReviewMedia({
    request: Readable.from([Buffer.from('x')]),
    projectDir,
    outputFps: 24,
    headers: rawHeaders('mismatched.mov', 'video/quicktime', 1),
    controller: createImportController(),
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }),
    randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({
      source: probeJson({
        width: 321,
        height: 181,
        fps: '24/1',
        videoDuration: 1,
        audio: true,
        audioDuration: 3,
        containerDuration: 3,
      }),
      onCall(invocation) { calls.push(invocation); },
    }),
  });
  assert.deepEqual({
    width: result.width,
    height: result.height,
    durationSec: result.durationSec,
    audioDurationSec: result.audioDurationSec,
    hasAudio: result.hasAudio,
  }, {
    width: 322,
    height: 182,
    durationSec: 1,
    audioDurationSec: 1,
    hasAudio: true,
  });
  const metadata = JSON.parse(fs.readFileSync(
    path.join(path.dirname(result.filePath), 'asset.json'),
    'utf8',
  ));
  assert.equal(metadata.version, 2);
  assert.equal(metadata.durationSec, 1);
  assert.equal(metadata.audioDurationSec, 1);
  const encodes = calls.filter((call) => call.command === 'ffmpeg' && !call.args.includes('null'));
  assert.equal(encodes.length, 2);
  assert.equal(encodes[0].args[encodes[0].args.indexOf('-t') + 1], '1');
  assert.match(encodes[0].args[encodes[0].args.indexOf('-vf') + 1], /pad=.*ceil/);
  for (const encode of encodes) {
    const quotaIndex = encode.args.indexOf('-fs');
    assert.ok(quotaIndex >= 0);
    assert.match(encode.args[quotaIndex + 1], /^[1-9][0-9]*$/);
  }
});

test('still image ignores the video FPS ceiling while video fails closed', async (t) => {
  const image = await importReviewMedia({
    request: Readable.from([Buffer.from('x')]), projectDir: tempProject(t), outputFps: 240,
    headers: rawHeaders('still.png', 'image/png', 1), controller: createImportController(),
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({ source: probeJson({ kind: 'image' }) }),
  });
  assert.equal(image.mediaKind, 'image');

  await assert.rejects(importReviewMedia({
    request: Readable.from([Buffer.from('x')]), projectDir: tempProject(t), outputFps: 240,
    headers: rawHeaders('clip.mp4', 'video/mp4', 1), controller: createImportController(),
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor(),
  }), (error) => error.status === 500 && error.code === 'MEDIA_IMPORT_OUTPUT_FPS_INVALID');
});

test('free-space is rechecked between phases and a 507 cleans ownership for immediate retry', async (t) => {
  const projectDir = tempProject(t);
  const controller = createImportController();
  let checks = 0;
  await assert.rejects(importReviewMedia({
    request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
    headers: rawHeaders('clip.mp4', 'video/mp4', 1), controller,
    statfsImpl: () => (++checks === 3
      ? { bavail: 0n, bsize: 4096n }
      : { bavail: 10n ** 12n, bsize: 4096n }),
    randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor(),
  }), (error) => error.status === 507 && error.code === 'MEDIA_IMPORT_DISK_FULL');
  assert.ok(checks >= 3);
  assert.equal(controller.busy, false);
  assert.equal(fs.existsSync(path.join(projectDir, '.project-mutation.lock')), false);
  assert.equal(fs.existsSync(path.join(projectDir, 'assets', 'broll', 'video', UUID)), false);

  const retried = await importReviewMedia({
    request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
    headers: rawHeaders('clip.mp4', 'video/mp4', 1), controller,
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }),
    randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor(),
  });
  assert.equal(retried.mediaKind, 'video');
});

test('every video free-space phase returns 507, cleans owned files, and permits retry', async (t) => {
  for (const failingCheck of [2, 3, 4, 5]) {
    await t.test(`check-${failingCheck}`, async () => {
      const projectDir = tempProject(t);
      const controller = createImportController();
      let checks = 0;
      await assert.rejects(importReviewMedia({
        request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
        headers: rawHeaders('clip.mp4', 'video/mp4', 1), controller,
        statfsImpl: () => (++checks === failingCheck
          ? { bavail: 0n, bsize: 4096n }
          : { bavail: 10n ** 12n, bsize: 4096n }),
        randomId: () => UUID,
        runMediaProcessImpl: fakeProcessor(),
      }), (error) => error.status === 507 && error.code === 'MEDIA_IMPORT_DISK_FULL');
      assert.equal(checks, failingCheck);
      assert.equal(controller.busy, false);
      assert.equal(fs.existsSync(path.join(projectDir, '.project-mutation.lock')), false);
      assert.equal(fs.existsSync(path.join(projectDir, 'assets', 'broll', 'video', UUID)), false);
      assert.equal(fs.existsSync(path.join(projectDir, 'previews', 'broll', `${UUID}.webm`)), false);

      const retry = await importReviewMedia({
        request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
        headers: rawHeaders('clip.mp4', 'video/mp4', 1), controller,
        statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }),
        randomId: () => UUID,
        runMediaProcessImpl: fakeProcessor(),
      });
      assert.equal(retry.mediaKind, 'video');
    });
  }
});

test('post-close encoder quota rejects one byte above and publishes one byte below', async (t) => {
  const source = probeJson();
  const budgets = deriveOutputBudgets({
    mediaKind: 'video', inputBytes: 1, width: 320, height: 180,
    durationSec: 1, fps: 25, hasAudio: false,
  });
  const processorAt = (delta) => {
    const base = fakeProcessor({ source });
    return async (invocation) => {
      const result = await base(invocation);
      if (invocation.command === 'ffmpeg' && !invocation.args.includes('null')) {
        const target = invocation.args.at(-1);
        const quota = target.endsWith('.mp4') ? budgets.master : budgets.proxy;
        fs.truncateSync(target, Number(quota + BigInt(delta)));
      }
      return result;
    };
  };

  const rejectedProject = tempProject(t);
  const rejectedController = createImportController();
  await assert.rejects(importReviewMedia({
    request: Readable.from([Buffer.from('x')]), projectDir: rejectedProject, outputFps: 25,
    headers: rawHeaders('above.mp4', 'video/mp4', 1), controller: rejectedController,
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: processorAt(1),
  }), (error) => error.status === 507 && error.code === 'MEDIA_IMPORT_OUTPUT_QUOTA_EXCEEDED');
  assert.equal(rejectedController.busy, false);
  assert.equal(fs.existsSync(path.join(rejectedProject, 'assets', 'broll', 'video', UUID)), false);

  const published = await importReviewMedia({
    request: Readable.from([Buffer.from('x')]), projectDir: tempProject(t), outputFps: 25,
    headers: rawHeaders('below.mp4', 'video/mp4', 1), controller: createImportController(),
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: processorAt(-1),
  });
  assert.equal(fs.statSync(published.filePath).size, Number(budgets.master - 1n));
  assert.equal(fs.statSync(published.previewPath).size, Number(budgets.proxy - 1n));
});

test('controller has one owner and releases after every transaction failure', async (t) => {
  const controller = createImportController();
  assert.equal(controller.acquire(), true);
  assert.equal(controller.busy, true);
  assert.equal(controller.acquire(), false);
  controller.release();
  assert.equal(controller.busy, false);

  const cases = [
    ['parse', { headers: { ...rawHeaders('x.png', 'image/png', 1), 'content-length': '01' } }],
    ['stream', { request: Readable.from([]), headers: rawHeaders('x.png', 'image/png', 1) }],
    ['probe', { runMediaProcessImpl: async () => { throw new Error('probe failed'); } }],
    ['abort', { signal: AbortSignal.abort() }],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const ownedController = createImportController();
      const projectDir = tempProject(t);
      await assert.rejects(importReviewMedia({
        request: Readable.from([Buffer.from('x')]),
        projectDir,
        outputFps: 25,
        headers: rawHeaders('x.png', 'image/png', 1),
        controller: ownedController,
        statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }),
        randomId: () => UUID,
        runMediaProcessImpl: fakeProcessor({ source: probeJson({ kind: 'image' }) }),
        ...overrides,
      }));
      assert.equal(ownedController.busy, false);
    });
  }
});

test('controller releases after normalize timeout, non-zero exit, and publication failure', async (t) => {
  for (const [name, processCode] of [
    ['timeout', 'MEDIA_PROCESS_TIMEOUT'],
    ['non-zero', 'MEDIA_PROCESS_EXIT'],
  ]) {
    await t.test(name, async () => {
      const controller = createImportController();
      const base = fakeProcessor();
      await assert.rejects(importReviewMedia({
        request: Readable.from([Buffer.from('x')]), projectDir: tempProject(t), outputFps: 25,
        headers: rawHeaders('x.mp4', 'video/mp4', 1), controller,
        statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
        runMediaProcessImpl: async (invocation) => {
          if (invocation.command === 'ffmpeg' && invocation.args.at(-1).endsWith('.mp4')) {
            throw Object.assign(new Error(name), { code: processCode });
          }
          return base(invocation);
        },
      }));
      assert.equal(controller.busy, false);
    });
  }
});

test('lease release retries transient failure and never strands the import controller', async (t) => {
  const projectDir = tempProject(t);
  const controller = createImportController();
  const leasePath = path.join(projectDir, '.project-mutation.lock');
  const fileSystem = Object.create(fs);
  let releaseAttempts = 0;
  fileSystem.unlinkSync = (target) => {
    if (target === leasePath && releaseAttempts++ === 0) {
      const error = new Error('transient lease unlink');
      error.code = 'EIO';
      throw error;
    }
    return fs.unlinkSync(target);
  };

  const imported = await importReviewMedia({
    request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
    headers: rawHeaders('retry-release.png', 'image/png', 1), controller, fileSystem,
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({ source: probeJson({ kind: 'image' }) }),
  });
  assert.equal(imported.mediaKind, 'image');
  assert.equal(releaseAttempts, 2);
  assert.equal(controller.busy, false);
  assert.equal(fs.existsSync(leasePath), false);
});

test('persistent lease release failure preserves the work error and still frees the controller', async (t) => {
  const projectDir = tempProject(t);
  const controller = createImportController();
  const leasePath = path.join(projectDir, '.project-mutation.lock');
  const fileSystem = Object.create(fs);
  let releaseAttempts = 0;
  fileSystem.unlinkSync = (target) => {
    if (target === leasePath) {
      releaseAttempts += 1;
      const error = new Error('persistent lease unlink');
      error.code = 'EIO';
      throw error;
    }
    return fs.unlinkSync(target);
  };
  const workError = new Error('authoritative probe failed');
  await assert.rejects(importReviewMedia({
    request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
    headers: rawHeaders('release-error.png', 'image/png', 1), controller, fileSystem,
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: async () => { throw workError; },
  }), (error) => error.code === 'MEDIA_IMPORT_DECODE_FAILED'
    && error.cause === workError
    && error.leaseReleaseError?.code === 'EIO');
  assert.equal(releaseAttempts, 3);
  assert.equal(controller.busy, false);
  assert.equal(fs.existsSync(leasePath), true);
});

test('streaming requires exact bytes, ignores post-body close, and keeps private exact modes', async (t) => {
  for (const chunks of [[], [Buffer.from('xx')]]) {
    const projectDir = tempProject(t);
    await assert.rejects(importReviewMedia({
      request: Readable.from(chunks), projectDir, outputFps: 25,
      headers: rawHeaders('x.png', 'image/png', 1), controller: createImportController(),
      statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
      runMediaProcessImpl: fakeProcessor({ source: probeJson({ kind: 'image' }) }),
    }), (error) => error.code === 'MEDIA_IMPORT_LENGTH_MISMATCH');
  }

  const projectDir = tempProject(t);
  let modes;
  const request = Readable.from([Buffer.from('x')]);
  const result = await importReviewMedia({
    request, projectDir, outputFps: 25,
    headers: rawHeaders('x.png', 'image/png', 1), controller: createImportController(),
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({
      source: probeJson({ kind: 'image' }),
      onCall(invocation) {
        if (invocation.command === 'ffprobe' && invocation.args.at(-1).includes('upload')) {
          const upload = invocation.args.at(-1);
          modes = {
            directory: fs.statSync(path.dirname(upload)).mode & 0o777,
            upload: fs.statSync(upload).mode & 0o777,
          };
          request.emit('close');
        }
      },
    }),
  });
  assert.deepEqual(modes, { directory: 0o700, upload: 0o600 });
  assert.equal(result.reference, `assets/broll/images/${UUID}/media.webp`);
});

test('authoritative probe rejects content disagreement and exact media ceilings', async (t) => {
  const cases = [
    ['kind', probeJson({ kind: 'video' }), rawHeaders('x.png', 'image/png', 1)],
    ['PNG declared JPEG', probeJson({
      kind: 'image', videoCodec: 'mjpeg', pixelFormat: 'yuvj420p', formatName: 'jpeg_pipe',
    }), rawHeaders('x.png', 'image/png', 1)],
    ['MP4 declared WebM', probeJson({
      videoCodec: 'vp8', formatName: 'matroska,webm',
    }), rawHeaders('x.mp4', 'video/mp4', 1)],
    ['video dimension', probeJson({ width: 4097, height: 10 }), rawHeaders('x.mp4', 'video/mp4', 1)],
    ['video pixels', probeJson({ width: 4096, height: 2161 }), rawHeaders('x.mp4', 'video/mp4', 1)],
    ['duration', probeJson({ duration: 1800.01 }), rawHeaders('x.mp4', 'video/mp4', 1)],
    ['image dimension', probeJson({ kind: 'image', width: 12001, height: 10 }), rawHeaders('x.png', 'image/png', 1)],
    ['image pixels', probeJson({ kind: 'image', width: 10000, height: 10001 }), rawHeaders('x.png', 'image/png', 1)],
  ];
  for (const [name, source, headers] of cases) {
    await t.test(name, async () => {
      await assert.rejects(importReviewMedia({
        request: Readable.from([Buffer.from('x')]), projectDir: tempProject(t), outputFps: 25,
        headers, controller: createImportController(),
        statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
        runMediaProcessImpl: fakeProcessor({ source }),
      }), (error) => error.status === 422);
    });
  }
});

test('video process argv relies on cross-version default autorotation and metadata is the asset-last publication marker', async (t) => {
  const projectDir = tempProject(t);
  const calls = [];
  const publicationOrder = [];
  const fileSystem = Object.create(fs);
  fileSystem.linkSync = (from, to) => {
    if (to === path.join(projectDir, 'previews', 'broll', `${UUID}.webm`)) {
      publicationOrder.push(path.relative(projectDir, to));
    }
    return fs.linkSync(from, to);
  };
  fileSystem.openSync = (target, flags, mode) => {
    if (target === path.join(projectDir, 'assets', 'broll', 'video', UUID, 'asset.json')) {
      publicationOrder.push(path.relative(projectDir, target));
    }
    return fs.openSync(target, flags, mode);
  };
  const result = await importReviewMedia({
    request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 24,
    headers: rawHeaders('hostile;$(touch nope).mov', 'video/quicktime', 1),
    controller: createImportController(), fileSystem,
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({ source: probeJson({ audio: true, fps: '30000/1001', rotation: -90 }), onCall: (call) => calls.push(call) }),
  });
  assert.equal(result.label, 'hostile;$(touch nope).mov');
  const encodes = calls.filter((call) => call.command === 'ffmpeg' && !call.args.includes('null'));
  const master = encodes.find((call) => call.args.at(-1).endsWith('.mp4'));
  const proxy = encodes.find((call) => call.args.at(-1).endsWith('.webm'));
  const uploadPath = master.args[master.args.indexOf('-i') + 1];
  const budgets = deriveOutputBudgets({
    mediaKind: 'video', inputBytes: 1, width: 320, height: 180,
    durationSec: 1, fps: 24, hasAudio: true,
  });
  assert.deepEqual(master.args, [
    '-hide_banner', '-loglevel', 'error', '-i', uploadPath,
    '-map', '0:v:0', '-map', '0:a:0',
    '-map_metadata', '-1', '-metadata:s:v:0', 'rotate=0',
    '-vf', 'fps=24,pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-crf', '18', '-preset', 'medium',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '160k',
    '-t', '1', '-movflags', '+faststart', '-fs', String(budgets.master),
    '-y', master.args.at(-1),
  ]);
  assert.deepEqual(proxy.args, [
    '-hide_banner', '-loglevel', 'error', '-i', master.args.at(-1),
    '-map', '0:v:0', '-map', '0:a:0', '-map_metadata', '-1',
    '-vf', "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=24,pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0",
    '-c:v', 'libvpx', '-crf', '32', '-b:v', '0',
    '-c:a', 'libopus', '-ar', '48000', '-ac', '2', '-b:a', '96k',
    '-t', '1', '-fs', String(budgets.proxy), '-y', proxy.args.at(-1),
  ]);
  const probeEntry = 'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,duration,duration_ts,time_base,pix_fmt,sample_rate,channels:stream_tags=rotate,DURATION:stream_disposition=attached_pic:stream_side_data=rotation:format=format_name,duration:format_tags=major_brand,compatible_brands';
  for (const call of calls.filter((entry) => entry.command === 'ffprobe')) {
    assert.deepEqual(call.args, ['-v', 'error', '-show_entries', probeEntry, '-of', 'json', call.args.at(-1)]);
  }
  for (const call of calls.filter((entry) => entry.command === 'ffmpeg' && entry.args.includes('null'))) {
    const input = call.args[call.args.indexOf('-i') + 1];
    assert.deepEqual(call.args, ['-hide_banner', '-loglevel', 'error', '-i', input, '-f', 'null', '-']);
  }
  assert.deepEqual(publicationOrder, [
    `previews/broll/${UUID}.webm`,
    `assets/broll/video/${UUID}/asset.json`,
  ]);
  const claimPath = path.join(projectDir, 'assets', 'broll', 'video', `.${UUID}.claim`);
  assert.equal(fs.statSync(claimPath).mode & 0o777, 0o600);
  const claimRecords = fs.readFileSync(claimPath, 'utf8').trimEnd().split('\n').map(JSON.parse);
  assert.equal(claimRecords.length, 4);
  assert.deepEqual(
    claimRecords.map(({ directory, canonical, preview }) => ({
      directory: directory !== null,
      canonical: canonical !== null,
      preview: preview !== null,
    })),
    [
      { directory: false, canonical: false, preview: false },
      { directory: false, canonical: false, preview: true },
      { directory: true, canonical: false, preview: true },
      { directory: true, canonical: true, preview: true },
    ],
  );
  assert.deepEqual(cleanupOrphanImportedStages({ projectDir }), [claimPath]);
  assert.equal(fs.existsSync(result.filePath), true);
  assert.equal(fs.existsSync(result.previewPath), true);
});

test('image normalization relies on cross-version default autorotation and remains single-frame, metadata-free, and alpha-capable', async (t) => {
  const calls = [];
  await importReviewMedia({
    request: Readable.from([Buffer.from('x')]), projectDir: tempProject(t), outputFps: 25,
    headers: rawHeaders('x.png', 'image/png', 1), controller: createImportController(),
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({
      source: probeJson({ kind: 'image', pixelFormat: 'rgba' }),
      onCall: (call) => calls.push(call),
    }),
  });
  const encode = calls.find((call) => call.command === 'ffmpeg' && !call.args.includes('null'));
  const uploadPath = encode.args[encode.args.indexOf('-i') + 1];
  const imageBudget = deriveOutputBudgets({
    mediaKind: 'image', inputBytes: 1, width: 320, height: 180,
  }).image;
  assert.deepEqual(encode.args, [
    '-hide_banner', '-loglevel', 'error', '-i', uploadPath,
    '-map', '0:v:0', '-map_metadata', '-1', '-frames:v', '1',
    '-vf', 'format=rgba', '-c:v', 'libwebp', '-quality', '90', '-pix_fmt', 'yuva420p',
    '-fs', String(imageBudget),
    '-y', encode.args.at(-1),
  ]);
});

test('symlinked publication parents are refused', async (t) => {
  const symlinkProject = tempProject(t);
  const outside = tempProject(t);
  fs.symlinkSync(outside, path.join(symlinkProject, 'assets'));
  await assert.rejects(importReviewMedia({
    request: Readable.from([Buffer.from('x')]), projectDir: symlinkProject, outputFps: 25,
    headers: rawHeaders('x.png', 'image/png', 1), controller: createImportController(),
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({ source: probeJson({ kind: 'image' }) }),
  }), (error) => error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE');
});

test('exclusive quarantine never deletes a pre-existing foreign UUID directory', async (t) => {
  const projectDir = tempProject(t);
  const quarantine = path.join(projectDir, 'tmp', 'review-imports', UUID);
  fs.mkdirSync(quarantine, { recursive: true });
  const sentinel = path.join(quarantine, 'foreign.txt');
  fs.writeFileSync(sentinel, 'keep me');
  await assert.rejects(importReviewMedia({
    request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
    headers: rawHeaders('x.png', 'image/png', 1), controller: createImportController(),
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({ source: probeJson({ kind: 'image' }) }),
  }), (error) => error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep me');
});

test('a second import is rejected before body consumption while the first owns the semaphore', async (t) => {
  const projectDir = tempProject(t);
  const controller = createImportController();
  const abort = new AbortController();
  const firstBody = new Readable({ read() {} });
  const first = importReviewMedia({
    request: firstBody, signal: abort.signal, projectDir, outputFps: 25,
    headers: rawHeaders('first.png', 'image/png', 1), controller,
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({ source: probeJson({ kind: 'image' }) }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  let secondReads = 0;
  const secondBody = new Readable({ read() { secondReads += 1; this.push(null); } });
  await assert.rejects(importReviewMedia({
    request: secondBody, projectDir, outputFps: 25,
    headers: rawHeaders('second.png', 'image/png', 1), controller,
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({ source: probeJson({ kind: 'image' }) }),
  }), (error) => error.status === 409 && error.code === 'MEDIA_IMPORT_BUSY');
  assert.equal(secondReads, 0);
  abort.abort();
  await assert.rejects(first, (error) => error.code === 'MEDIA_IMPORT_ABORTED');
  assert.equal(controller.busy, false);
  const retry = await importReviewMedia({
    request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
    headers: rawHeaders('retry.png', 'image/png', 1), controller,
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }),
    randomId: () => '7c0f5b6a-a921-4a51-8787-467a3a5c7c20',
    runMediaProcessImpl: fakeProcessor({ source: probeJson({ kind: 'image' }) }),
  });
  assert.equal(retry.mediaKind, 'image');
});

test('parent replacement during processing and dangling final destinations abort publication', async (t) => {
  const projectDir = tempProject(t);
  let replaced = false;
  await assert.rejects(importReviewMedia({
    request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
    headers: rawHeaders('x.png', 'image/png', 1), controller: createImportController(),
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({
      source: probeJson({ kind: 'image' }),
      onCall(invocation) {
        if (!replaced && invocation.command === 'ffmpeg') {
          replaced = true;
          const parent = path.join(projectDir, 'assets', 'broll', 'images');
          fs.renameSync(parent, `${parent}-replaced`);
          fs.mkdirSync(parent);
        }
      },
    }),
  }), (error) => error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE');
  assert.equal(fs.existsSync(path.join(projectDir, 'assets', 'broll', 'images', UUID)), false);

  const danglingProject = tempProject(t);
  fs.mkdirSync(path.join(danglingProject, 'previews', 'broll'), { recursive: true });
  fs.symlinkSync(path.join(danglingProject, 'missing.webm'), path.join(danglingProject, 'previews', 'broll', `${UUID}.webm`));
  await assert.rejects(importReviewMedia({
    request: Readable.from([Buffer.from('x')]), projectDir: danglingProject, outputFps: 25,
    headers: rawHeaders('x.mp4', 'video/mp4', 1), controller: createImportController(),
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({ source: probeJson() }),
  }), (error) => error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE');
  assert.ok(findSymlinkTo(danglingProject, path.join(danglingProject, 'missing.webm')));
});

test('upload pathname replacement before probing is rejected by opened-file identity', async (t) => {
  const projectDir = tempProject(t);
  let replaced = false;
  await assert.rejects(importReviewMedia({
    request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
    headers: rawHeaders('x.png', 'image/png', 1), controller: createImportController(),
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({
      source: probeJson({ kind: 'image' }),
      onCall(invocation) {
        if (!replaced && invocation.command === 'ffprobe' && invocation.args.at(-1).includes('upload')) {
          replaced = true;
          const upload = invocation.args.at(-1);
          fs.renameSync(upload, `${upload}.original`);
          fs.writeFileSync(upload, 'different bytes');
        }
      },
    }),
  }), (error) => error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE');
  assert.equal(fs.existsSync(path.join(projectDir, 'assets', 'broll', 'images', UUID)), false);
});

test('the exact accepted geometry boundaries normalize without large request allocations', async (t) => {
  for (const [filename, mime, source] of [
    ['boundary.mp4', 'video/mp4', probeJson({ width: 4096, height: 2160, duration: 1800 })],
    ['boundary.png', 'image/png', probeJson({ kind: 'image', width: 10000, height: 10000 })],
  ]) {
    const result = await importReviewMedia({
      request: Readable.from([Buffer.from('x')]), projectDir: tempProject(t), outputFps: 25,
      headers: rawHeaders(filename, mime, 1), controller: createImportController(),
      statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => crypto.randomUUID(),
      runMediaProcessImpl: fakeProcessor({ source }),
    });
    assert.equal(result.label, filename);
  }
});

test('publication rejects a successful encoder result with the wrong authoritative master FPS', async (t) => {
  const controller = createImportController();
  const projectDir = tempProject(t);
  await assert.rejects(importReviewMedia({
    request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 24,
    headers: rawHeaders('wrong-fps.mp4', 'video/mp4', 1), controller,
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({ source: probeJson(), masterOverrides: { fps: '30/1' } }),
  }), (error) => error.status === 422 && error.code === 'MEDIA_IMPORT_OUTPUT_INVALID');
  assert.equal(controller.busy, false);
  assert.equal(fs.existsSync(path.join(projectDir, 'assets', 'broll', 'video', UUID)), false);
});

test('normalized probes enforce exact image, master, proxy, audio, alpha, and duration profiles', async (t) => {
  const cases = [
    ['image codec', 'x.png', 'image/png', probeJson({ kind: 'image' }), { imageOverrides: { videoCodec: 'mjpeg' } }],
    ['image alpha', 'x.png', 'image/png', probeJson({ kind: 'image', pixelFormat: 'rgba' }), { imageOverrides: { pixelFormat: 'yuv420p' } }],
    ['master codec', 'x.mp4', 'video/mp4', probeJson(), { masterOverrides: { videoCodec: 'hevc' } }],
    ['master pixel format', 'x.mp4', 'video/mp4', probeJson(), { masterOverrides: { pixelFormat: 'yuv444p' } }],
    ['master audio codec', 'x.mp4', 'video/mp4', probeJson({ audio: true }), { masterOverrides: { audioCodec: 'opus' } }],
    ['master audio rate', 'x.mp4', 'video/mp4', probeJson({ audio: true }), { masterOverrides: { audioSampleRate: 44100 } }],
    ['master audio channels', 'x.mp4', 'video/mp4', probeJson({ audio: true }), { masterOverrides: { audioChannels: 1 } }],
    ['truncated master', 'x.mp4', 'video/mp4', probeJson({ duration: 1 }), {
      masterOverrides: { videoDuration: 0.5, containerDuration: 0.5 },
      proxyOverrides: { videoDuration: 0.5, containerDuration: 0.5 },
    }],
    ['proxy codec', 'x.mp4', 'video/mp4', probeJson(), { proxyOverrides: { videoCodec: 'vp9' } }],
    ['proxy audio codec', 'x.mp4', 'video/mp4', probeJson({ audio: true }), { proxyOverrides: { audioCodec: 'aac' } }],
  ];
  for (const [name, filename, mime, source, overrides] of cases) {
    await t.test(name, async () => {
      await assert.rejects(importReviewMedia({
        request: Readable.from([Buffer.from('x')]), projectDir: tempProject(t), outputFps: 25,
        headers: rawHeaders(filename, mime, 1), controller: createImportController(),
        statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
        runMediaProcessImpl: fakeProcessor({ source, ...overrides }),
      }), (error) => error.status === 422 && error.code === 'MEDIA_IMPORT_OUTPUT_INVALID');
    });
  }
});

test('output replacement between probe, decode, and hash is rejected by captured identity', async (t) => {
  await t.test('between probe and decode', async () => {
    const projectDir = tempProject(t);
    let replaced = false;
    await assert.rejects(importReviewMedia({
      request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
      headers: rawHeaders('x.mp4', 'video/mp4', 1), controller: createImportController(),
      statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
      runMediaProcessImpl: fakeProcessor({
        onCall(invocation) {
          const input = invocation.args[invocation.args.indexOf('-i') + 1];
          if (!replaced && invocation.command === 'ffmpeg' && invocation.args.includes('null')
            && input?.endsWith('.mp4')) {
            replaced = true;
            fs.renameSync(input, `${input}.original`);
            fs.writeFileSync(input, 'replacement after probe');
          }
        },
      }),
    }), (error) => error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE');
    assert.equal(fs.existsSync(path.join(projectDir, 'assets', 'broll', 'video', UUID)), false);
  });

  await t.test('between decode and hash', async () => {
    const projectDir = tempProject(t);
    const fileSystem = Object.create(fs);
    let replaced = false;
    fileSystem.openSync = (target, flags, mode) => {
      const isHashRead = target.endsWith(`${path.sep}bundle${path.sep}media.mp4`)
        && (flags & fs.constants.O_RDONLY) === fs.constants.O_RDONLY;
      if (!replaced && isHashRead) {
        replaced = true;
        fs.renameSync(target, `${target}.original`);
        fs.writeFileSync(target, 'replacement before hash');
      }
      return fs.openSync(target, flags, mode);
    };
    await assert.rejects(importReviewMedia({
      request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
      headers: rawHeaders('x.mp4', 'video/mp4', 1), controller: createImportController(),
      fileSystem,
      statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
      runMediaProcessImpl: fakeProcessor(),
    }), (error) => error.code === 'MEDIA_IMPORT_FILESYSTEM_UNSAFE');
    assert.equal(fs.existsSync(path.join(projectDir, 'assets', 'broll', 'video', UUID)), false);
  });
});

test('publication claims final paths without clobber and preserves every foreign collision', async (t) => {
  await t.test('directory collision at claim time', async () => {
    const projectDir = tempProject(t);
    const finalDirectory = path.join(projectDir, 'assets', 'broll', 'video', UUID);
    const sentinel = path.join(finalDirectory, 'foreign.txt');
    const fileSystem = Object.create(fs);
    let injected = false;
    fileSystem.mkdirSync = (target, options) => {
      if (!injected && target === finalDirectory) {
        injected = true;
        fs.mkdirSync(target, { mode: 0o700 });
        fs.writeFileSync(sentinel, 'foreign directory');
      }
      return fs.mkdirSync(target, options);
    };
    await assert.rejects(importReviewMedia({
      request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
      headers: rawHeaders('x.mp4', 'video/mp4', 1), controller: createImportController(),
      fileSystem,
      statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
      runMediaProcessImpl: fakeProcessor(),
    }));
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'foreign directory');
    assert.equal(fs.existsSync(path.join(projectDir, 'previews', 'broll', `${UUID}.webm`)), false);
  });

  await t.test('foreign preview stage', async () => {
    const projectDir = tempProject(t);
    const stage = path.join(projectDir, 'previews', 'broll', `.${UUID}.stage.webm`);
    fs.mkdirSync(path.dirname(stage), { recursive: true });
    fs.writeFileSync(stage, 'foreign stage');
    await assert.rejects(importReviewMedia({
      request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
      headers: rawHeaders('x.mp4', 'video/mp4', 1), controller: createImportController(),
      statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
      runMediaProcessImpl: fakeProcessor(),
    }));
    assert.equal(fs.readFileSync(stage, 'utf8'), 'foreign stage');
    assert.equal(fs.existsSync(path.join(projectDir, 'previews', 'broll', `${UUID}.webm`)), false);
    assert.equal(fs.existsSync(path.join(projectDir, 'assets', 'broll', 'video', UUID)), false);
  });
});

test('failure after preview and final-directory claim leaves no selectable partial and releases controller', async (t) => {
  for (const failurePoint of ['canonical', 'metadata-commit']) {
    await t.test(failurePoint, async () => {
      const projectDir = tempProject(t);
      const controller = createImportController();
      const fileSystem = Object.create(fs);
      if (failurePoint === 'canonical') {
        fileSystem.openSync = (target, flags, mode) => {
          if (target === path.join(projectDir, 'assets', 'broll', 'video', UUID, 'media.mp4')) {
            throw new Error('canonical publish failed');
          }
          return fs.openSync(target, flags, mode);
        };
      } else {
        fileSystem.openSync = (target, flags, mode) => {
          if (target === path.join(projectDir, 'assets', 'broll', 'video', UUID, 'asset.json')) {
            throw new Error('metadata commit failed');
          }
          return fs.openSync(target, flags, mode);
        };
      }
      await assert.rejects(importReviewMedia({
        request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
        headers: rawHeaders('x.mp4', 'video/mp4', 1), controller, fileSystem,
        statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
        runMediaProcessImpl: fakeProcessor(),
      }));
      assert.equal(controller.busy, false);
      assert.equal(fs.existsSync(path.join(projectDir, 'previews', 'broll', `${UUID}.webm`)), false);
      const finalDirectory = path.join(projectDir, 'assets', 'broll', 'video', UUID);
      assert.equal(fs.existsSync(path.join(finalDirectory, 'asset.json')), false);
      assert.equal(
        fs.existsSync(finalDirectory),
        false,
        fs.existsSync(finalDirectory) ? fs.readdirSync(finalDirectory).join(',') : '',
      );
    });
  }
});

test('rollback retains the durable claim when an owned canonical cannot be deleted', async (t) => {
  const projectDir = tempProject(t);
  const controller = createImportController();
  const canonicalPath = path.join(
    projectDir,
    'assets',
    'broll',
    'video',
    UUID,
    'media.mp4',
  );
  const claimPath = path.join(
    projectDir,
    'assets',
    'broll',
    'video',
    `.${UUID}.claim`,
  );
  const fileSystem = Object.create(fs);
  fileSystem.openSync = (target, flags, mode) => {
    if (target === path.join(path.dirname(canonicalPath), 'asset.json')) {
      throw new Error('metadata commit failed');
    }
    return fs.openSync(target, flags, mode);
  };
  fileSystem.unlinkSync = (target) => {
    if (target === canonicalPath
      || (path.basename(target) === 'claimed'
        && path.basename(path.dirname(target)).startsWith('.media.mp4.remove-'))) {
      throw new Error('canonical deletion failed');
    }
    return fs.unlinkSync(target);
  };

  await assert.rejects(importReviewMedia({
    request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
    headers: rawHeaders('x.mp4', 'video/mp4', 1), controller, fileSystem,
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor(),
  }));
  assert.equal(controller.busy, false);
  assert.ok(findRegularFileWithBytes(projectDir, 'normalized:.mp4'));
  assert.equal(fs.existsSync(claimPath), true);
});

test('restrictive umask still yields exact private directory and file modes', { concurrency: false }, async (t) => {
  const projectDir = tempProject(t);
  const previousUmask = process.umask(0o777);
  let result;
  try {
    result = await importReviewMedia({
      request: Readable.from([Buffer.from('x')]), projectDir, outputFps: 25,
      headers: rawHeaders('x.png', 'image/png', 1), controller: createImportController(),
      statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }), randomId: () => UUID,
      runMediaProcessImpl: fakeProcessor({ source: probeJson({ kind: 'image' }) }),
    });
  } finally {
    process.umask(previousUmask);
  }
  for (const directory of [
    'tmp', 'tmp/review-imports', 'assets', 'assets/broll', 'assets/broll/images',
    `assets/broll/images/${UUID}`,
  ]) {
    assert.equal(fs.statSync(path.join(projectDir, directory)).mode & 0o777, 0o700, directory);
  }
  assert.equal(fs.statSync(result.filePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(path.dirname(result.filePath), 'asset.json')).mode & 0o777, 0o600);
});

test('Windows-mode import requires identity and bytes without POSIX modes or O_NOFOLLOW', async (t) => {
  const projectDir = tempProject(t);
  const fileSystem = windowsFileSystem(fs);
  const result = await importReviewMedia({
    request: Readable.from([Buffer.from('x')]),
    projectDir,
    outputFps: 25,
    headers: rawHeaders('windows.png', 'image/png', 1),
    controller: createImportController(),
    fileSystem,
    platform: 'win32',
    statfsImpl: () => ({ bavail: 10n ** 12n, bsize: 4096n }),
    randomId: () => UUID,
    runMediaProcessImpl: fakeProcessor({ source: probeJson({ kind: 'image' }) }),
  });
  assert.equal(result.reference, `assets/broll/images/${UUID}/media.webp`);
  assert.equal(fs.readFileSync(result.filePath, 'utf8'), 'normalized:.webp');

  const before = fs.readFileSync(result.filePath);
  fs.writeFileSync(result.filePath, Buffer.alloc(before.length, 0x78));
  assert.equal(fs.statSync(result.filePath).size, before.length);
  assert.equal(require('../scripts/review/imported-assets').inspectImportedAssetBundle({
    projectDir,
    assetDirectory: path.dirname(result.filePath),
    fileSystem,
    platform: 'win32',
  }), null);
});

test('real tiny images and videos normalize, decode, preserve alpha/first GIF frame, and expose expected streams', { timeout: 120000 }, async (t) => {
  if (!toolAvailable('ffmpeg') || !toolAvailable('ffprobe')) {
    t.skip('ffmpeg and ffprobe are unavailable; real-media ingest test requires both local tools');
    return;
  }
  const fixtureDir = tempProject(t);
  const files = makeMediaFixtures(fixtureDir);
  const hasWebpEncoder = ffmpegEncoderAvailable('libwebp');
  const hasAv1Encoder = ffmpegEncoderAvailable('libaom-av1');
  const cases = [
    ['tiny.avif', 'tiny.avif', files.avif, 'image/avif', 'image', 'av1'],
    ['real JPEG survives quarantine upload.bin', 'tiny.jpg', files.jpeg, 'image/jpeg', 'image'],
    ['animated.gif', 'animated.gif', files.animatedGif, 'image/gif', 'image'],
    ['transparent.png', 'transparent.png', files.transparentPng, 'image/png', 'image'],
    ['silent.mp4', 'silent.mp4', files.silentLandscape, 'video/mp4', 'video'],
    ['audio.mp4', 'audio.mp4', files.audioPortrait, 'video/mp4', 'video'],
    ['rotated-vfr.mov', 'rotated-vfr.mov', files.rotatedVfr, 'video/quicktime', 'video'],
    ['real WebM normalizes master and preview', 'vp8-opus.webm', files.webm, 'video/webm', 'video'],
  ];
  for (const [name, filename, sourcePath, mime, kind, requirement] of cases) {
    await t.test(name, async (subtest) => {
      if (requirement === 'av1' && !hasAv1Encoder) {
        subtest.skip('ffmpeg libaom-av1 encoder is unavailable; real AVIF fixture cannot be generated');
        return;
      }
      if (kind === 'image' && !hasWebpEncoder) {
        subtest.skip('ffmpeg libwebp encoder is unavailable; real image normalization requires that local encoder');
        return;
      }
      const projectDir = tempProject(t);
      const bytes = fs.statSync(sourcePath).size;
      const result = await importReviewMedia({
        request: fs.createReadStream(sourcePath), projectDir, outputFps: 25,
        headers: rawHeaders(filename, mime, bytes), controller: createImportController(),
        randomId: () => crypto.randomUUID(), runMediaProcessImpl: runMediaProcess,
      });
      assert.equal(result.mediaKind, kind);
      const metadata = JSON.parse(fs.readFileSync(
        path.join(path.dirname(result.filePath), 'asset.json'),
        'utf8',
      ));
      assert.equal(metadata.mediaKind, kind);
      assert.match(metadata.canonicalSha256, /^[a-f0-9]{64}$/);
      const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', result.filePath, '-f', 'null', '-'], { encoding: 'utf8' });
      assert.equal(decode.status, 0, decode.stderr);
      if (filename === 'animated.gif') {
        const count = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'default=nw=1:nk=1', result.filePath], { encoding: 'utf8' });
        assert.equal(count.stdout.trim(), '1');
        const pixel = spawnSync('ffmpeg', ['-v', 'error', '-i', result.filePath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: null });
        assert.ok(pixel.stdout[0] > pixel.stdout[2], 'first GIF frame should remain red, not the blue second frame');
      }
      if (filename === 'transparent.png') {
        const alpha = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt', '-of', 'default=nw=1:nk=1', result.filePath], { encoding: 'utf8' });
        assert.match(alpha.stdout, /yuva|rgba|argb|bgra/);
        const pixel = spawnSync('ffmpeg', ['-v', 'error', '-i', result.filePath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { encoding: null });
        assert.ok(pixel.stdout[3] < 16, 'transparent source pixel should remain transparent');
      }
      if (kind === 'video') {
        const master = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', result.filePath], { encoding: 'utf8' }).stdout);
        const proxy = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', result.previewPath], { encoding: 'utf8' }).stdout);
        const masterVideo = master.streams.find((stream) => stream.codec_type === 'video');
        const proxyVideo = proxy.streams.find((stream) => stream.codec_type === 'video');
        assert.equal(masterVideo.codec_name, 'h264');
        assert.equal(masterVideo.pix_fmt, 'yuv420p');
        assert.equal(masterVideo.avg_frame_rate, '25/1');
        assert.equal(proxyVideo.codec_name, 'vp8');
        assert.ok(proxyVideo.width <= 1280 && proxyVideo.height <= 1280);
        assert.ok(Number(proxyVideo.avg_frame_rate.split('/')[0]) / Number(proxyVideo.avg_frame_rate.split('/')[1]) <= 30);
        const masterAudio = master.streams.find((stream) => stream.codec_type === 'audio');
        const proxyAudio = proxy.streams.find((stream) => stream.codec_type === 'audio');
        if (!['audio.mp4', 'vp8-opus.webm'].includes(filename)) {
          assert.equal(masterAudio, undefined);
          assert.equal(proxyAudio, undefined);
        } else {
          assert.deepEqual([masterAudio.codec_name, masterAudio.sample_rate, masterAudio.channels], ['aac', '48000', 2]);
          assert.deepEqual([proxyAudio.codec_name, proxyAudio.sample_rate, proxyAudio.channels], ['opus', '48000', 2]);
        }
        const masterDuration = Number(master.format.duration);
        const proxyDuration = Number(proxy.format.duration);
        assert.ok(Math.abs(masterDuration - proxyDuration) <= (1 / 25) + 0.001);
        if (filename === 'rotated-vfr.mov') {
          assert.deepEqual([masterVideo.width, masterVideo.height], [90, 160]);
          assert.equal(masterVideo.tags?.rotate, undefined);
          assert.equal(masterVideo.side_data_list?.some((entry) => Number(entry.rotation) !== 0) ?? false, false);
        }
      }
    });
  }
  await t.test('renamed-av1-video.avif', async (subtest) => {
    if (!hasAv1Encoder) {
      subtest.skip('ffmpeg libaom-av1 encoder is unavailable; renamed AV1 fixture cannot be generated');
      return;
    }
    const projectDir = tempProject(t);
    const bytes = fs.statSync(files.renamedAv1Avif).size;
    await assert.rejects(importReviewMedia({
      request: fs.createReadStream(files.renamedAv1Avif), projectDir, outputFps: 25,
      headers: rawHeaders('renamed-av1-video.avif', 'image/avif', bytes),
      controller: createImportController(), randomId: () => crypto.randomUUID(),
      runMediaProcessImpl: runMediaProcess,
    }), (error) => error.status === 422 && error.code === 'MEDIA_IMPORT_CONTENT_MISMATCH');
  });
  await t.test('renamed WebM video is rejected as JPEG', async () => {
    const projectDir = tempProject(t);
    const bytes = fs.statSync(files.webm).size;
    await assert.rejects(importReviewMedia({
      request: fs.createReadStream(files.webm), projectDir, outputFps: 25,
      headers: rawHeaders('renamed-video.jpg', 'image/jpeg', bytes),
      controller: createImportController(), randomId: () => crypto.randomUUID(),
      runMediaProcessImpl: runMediaProcess,
    }), (error) => error.status === 422 && error.code === 'MEDIA_IMPORT_CONTENT_MISMATCH');
  });
});
