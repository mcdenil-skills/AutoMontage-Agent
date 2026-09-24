const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { extractFrame, probeMedia, thumbnailFor } = require('../scripts/pult/media-cache');
const { makePultRoot } = require('./helpers/pult-projects');

const PROBE = JSON.stringify({
  streams: [{ codec_type: 'video', width: 1080, height: 1920, r_frame_rate: '25/1', duration: '27.48' }],
  format: { duration: '27.48' },
});

test('probe results are cached by file identity', (t) => {
  const { projectsDir } = makePultRoot(t);
  const video = path.join(projectsDir, 'clip.mp4');
  fs.writeFileSync(video, 'video');
  let calls = 0;
  const captureImpl = (command) => {
    calls += 1;
    assert.equal(command, 'ffprobe');
    return { stdout: PROBE };
  };
  const expected = { width: 1080, height: 1920, durationSec: 27.48 };
  assert.deepEqual(probeMedia(projectsDir, video, { captureImpl }), expected);
  assert.deepEqual(probeMedia(projectsDir, video, { captureImpl }), expected);
  assert.equal(calls, 1);
  fs.writeFileSync(video, 'changed video bytes');
  probeMedia(projectsDir, video, { captureImpl });
  assert.equal(calls, 2);
});

test('probe failure returns null instead of breaking the list', (t) => {
  const { projectsDir } = makePultRoot(t);
  const video = path.join(projectsDir, 'clip.mp4');
  fs.writeFileSync(video, 'video');
  assert.equal(probeMedia(projectsDir, video, { captureImpl: () => { throw new Error('no ffprobe'); } }), null);
});

test('thumbnail is rendered once into the pult cache', (t) => {
  const { projectsDir } = makePultRoot(t);
  const video = path.join(projectsDir, 'clip.mp4');
  fs.writeFileSync(video, 'video');
  let calls = 0;
  const captureImpl = (command, args) => {
    calls += 1;
    assert.equal(command, 'ffmpeg');
    fs.writeFileSync(args.at(-1), 'jpg');
    return { stdout: '' };
  };
  const first = thumbnailFor(projectsDir, video, { captureImpl });
  assert.ok(first.startsWith(path.join(projectsDir, '.pult', 'cache')));
  assert.equal(thumbnailFor(projectsDir, video, { captureImpl }), first);
  assert.equal(calls, 1);
});

test('frame extraction passes arguments without a shell and reports failure', (t) => {
  const { projectsDir } = makePultRoot(t);
  const video = path.join(projectsDir, 'clip.mp4');
  const out = path.join(projectsDir, 'frame.jpg');
  let seen;
  const ok = extractFrame(video, 14.24, out, {
    captureImpl: (command, args) => {
      seen = { command, args };
      fs.writeFileSync(out, 'jpg');
      return { stdout: '' };
    },
  });
  assert.equal(ok, true);
  assert.equal(seen.command, 'ffmpeg');
  assert.deepEqual(seen.args.slice(seen.args.indexOf('-ss'), seen.args.indexOf('-ss') + 4), ['-ss', '14.24', '-i', video]);
  assert.equal(seen.args.at(-1), out);
  assert.equal(extractFrame(video, 1, path.join(projectsDir, 'none.jpg'), { captureImpl: () => ({ stdout: '' }) }), false);
});

// mkdir -p следует за символической ссылкой .pult, если проверить только .pult/cache.
// Враждебная .pult не должна выпускать кэш за пределы projects/.
test('a symlinked .pult must not redirect the cache outside projects/', { skip: process.platform === 'win32' }, (t) => {
  const { base, projectsDir } = makePultRoot(t);
  const video = path.join(projectsDir, 'clip.mp4');
  fs.writeFileSync(video, 'video');
  const outside = path.join(base, 'outside-pult');
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(projectsDir, '.pult'), 'dir');

  assert.equal(probeMedia(projectsDir, video, { captureImpl: () => ({ stdout: PROBE }) }), null);
  assert.equal(thumbnailFor(projectsDir, video, {
    captureImpl: (command, args) => {
      fs.writeFileSync(args.at(-1), 'jpg');
      return { stdout: '' };
    },
  }), null);

  assert.deepEqual(fs.readdirSync(outside), []);
});

// Симлинк .pult должен отклоняться в самом начале функции — до чтения кэша и до
// fs.existsSync — иначе .pult, указывающая на уже заполненный чужой кэш с тем же
// именем файла (совпадающим по ключу), будет молча прочитана как «свой» кэш.
test('a symlinked .pult pointing at a pre-populated cache is rejected before any read', { skip: process.platform === 'win32' }, (t) => {
  const { base, projectsDir } = makePultRoot(t);
  const video = path.join(projectsDir, 'clip.mp4');
  fs.writeFileSync(video, 'video');

  const realCaptureImpl = (command, args) => {
    if (command === 'ffprobe') return { stdout: PROBE };
    fs.writeFileSync(args.at(-1), 'jpg');
    return { stdout: '' };
  };
  assert.ok(probeMedia(projectsDir, video, { captureImpl: realCaptureImpl }));
  assert.ok(thumbnailFor(projectsDir, video, { captureImpl: realCaptureImpl }));

  const cacheDirPath = path.join(projectsDir, '.pult', 'cache');
  const entries = fs.readdirSync(cacheDirPath).map((name) => ({
    name,
    content: fs.readFileSync(path.join(cacheDirPath, name)),
  }));
  assert.equal(entries.length, 2);
  fs.rmSync(path.join(projectsDir, '.pult'), { recursive: true, force: true });

  const outside = path.join(base, 'outside-pult');
  fs.mkdirSync(path.join(outside, 'cache'), { recursive: true });
  for (const entry of entries) {
    fs.writeFileSync(path.join(outside, 'cache', entry.name), entry.content);
  }
  fs.symlinkSync(outside, path.join(projectsDir, '.pult'), 'dir');

  let probeCalls = 0;
  let thumbCalls = 0;
  assert.equal(probeMedia(projectsDir, video, { captureImpl: () => { probeCalls += 1; return { stdout: PROBE }; } }), null);
  assert.equal(thumbnailFor(projectsDir, video, {
    captureImpl: (command, args) => { thumbCalls += 1; fs.writeFileSync(args.at(-1), 'jpg'); return { stdout: '' }; },
  }), null);
  assert.equal(probeCalls, 0);
  assert.equal(thumbCalls, 0);
  assert.deepEqual(fs.readdirSync(path.join(outside, 'cache')).sort(), entries.map((entry) => entry.name).sort());
});

// Прочитанный из кэша JSON отправляется в браузер как `meta`: подменённый файл не
// должен протаскивать посторонние поля или ломать типы, а битая по форме запись
// обязана вызвать повторный пробинг, а не постоянный отказ.
test('a tampered probe cache is trimmed to three keys, or ignored and re-probed', (t) => {
  const { projectsDir } = makePultRoot(t);
  const video = path.join(projectsDir, 'clip.mp4');
  fs.writeFileSync(video, 'video');
  let calls = 0;
  const captureImpl = () => {
    calls += 1;
    return { stdout: PROBE };
  };

  const first = probeMedia(projectsDir, video, { captureImpl });
  assert.deepEqual(first, { width: 1080, height: 1920, durationSec: 27.48 });
  assert.equal(calls, 1);

  const cacheDirPath = path.join(projectsDir, '.pult', 'cache');
  const [cacheFile] = fs.readdirSync(cacheDirPath).filter((name) => name.endsWith('.json'));
  const cachePath = path.join(cacheDirPath, cacheFile);

  fs.writeFileSync(cachePath, `${JSON.stringify({
    width: 1, height: 1, durationSec: 1, path: '/secret',
  }, null, 2)}\n`);
  const withExtraFields = probeMedia(projectsDir, video, { captureImpl });
  assert.deepEqual(withExtraFields, { width: 1, height: 1, durationSec: 1 });
  assert.equal(calls, 1);

  fs.writeFileSync(cachePath, `${JSON.stringify({ width: 'x' }, null, 2)}\n`);
  const reprobed = probeMedia(projectsDir, video, { captureImpl });
  assert.deepEqual(reprobed, { width: 1080, height: 1920, durationSec: 27.48 });
  assert.equal(calls, 2);
});

// Битый (непарсящийся) JSON кэша обязан считаться промахом кэша, а не постоянным
// провалом на будущее: readJsonIfExists кидает исключение на невалидном JSON, и это
// исключение не должно улетать во внешний catch, который вернул бы null навсегда.
test('a corrupt (unparseable) probe cache is treated as a miss, not a permanent failure', (t) => {
  const { projectsDir } = makePultRoot(t);
  const video = path.join(projectsDir, 'clip.mp4');
  fs.writeFileSync(video, 'video');
  let calls = 0;
  const captureImpl = () => {
    calls += 1;
    return { stdout: PROBE };
  };

  const first = probeMedia(projectsDir, video, { captureImpl });
  assert.deepEqual(first, { width: 1080, height: 1920, durationSec: 27.48 });
  assert.equal(calls, 1);

  const cacheDirPath = path.join(projectsDir, '.pult', 'cache');
  const [cacheFile] = fs.readdirSync(cacheDirPath).filter((name) => name.endsWith('.json'));
  fs.writeFileSync(path.join(cacheDirPath, cacheFile), '{ broken');

  const reprobed = probeMedia(projectsDir, video, { captureImpl });
  assert.deepEqual(reprobed, { width: 1080, height: 1920, durationSec: 27.48 });
  assert.equal(calls, 2);
});

// Зависший ffprobe/ffmpeg (например файл ещё копируется по сети) не должен вешать
// однопоточный сервер пульта навечно — оба вызова обязаны нести ограничение по времени.
test('ffprobe and ffmpeg calls carry a bounded timeout', (t) => {
  const { projectsDir } = makePultRoot(t);
  const video = path.join(projectsDir, 'clip.mp4');
  fs.writeFileSync(video, 'video');

  let probeOptions;
  probeMedia(projectsDir, video, {
    captureImpl: (command, args, options) => {
      probeOptions = options;
      return { stdout: PROBE };
    },
  });
  assert.equal(probeOptions.timeout, 15000);

  let frameOptions;
  const out = path.join(projectsDir, 'frame.jpg');
  extractFrame(video, 1, out, {
    captureImpl: (command, args, options) => {
      frameOptions = options;
      fs.writeFileSync(out, 'jpg');
      return { stdout: '' };
    },
  });
  assert.equal(frameOptions.timeout, 15000);
});

// Провал ffmpeg (даже после того как он успел записать часть файла) не должен
// оставлять недорисованный кадр на диске — ни как временный файл, ни как результат.
test('extractFrame removes a partial output file after failure', (t) => {
  const { projectsDir } = makePultRoot(t);
  const video = path.join(projectsDir, 'clip.mp4');
  const out = path.join(projectsDir, 'frame.jpg');
  const ok = extractFrame(video, 1, out, {
    captureImpl: (command, args) => {
      fs.writeFileSync(args.at(-1), 'partial');
      throw new Error('ffmpeg crashed');
    },
  });
  assert.equal(ok, false);
  assert.equal(fs.existsSync(out), false);
});

// Частично записанная обложка не должна становиться «вечным» кэшем: рендер идёт во
// временный файл, и только успешный результат переименовывается в целевой путь.
test('a crashed thumbnail render leaves no partial cover in the cache', (t) => {
  const { projectsDir } = makePultRoot(t);
  const video = path.join(projectsDir, 'clip.mp4');
  fs.writeFileSync(video, 'video');
  const result = thumbnailFor(projectsDir, video, {
    captureImpl: (command, args) => {
      fs.writeFileSync(args.at(-1), 'partial');
      throw new Error('ffmpeg crashed');
    },
  });
  assert.equal(result, null);
  const cacheDirPath = path.join(projectsDir, '.pult', 'cache');
  const leftJpgFiles = fs.existsSync(cacheDirPath)
    ? fs.readdirSync(cacheDirPath).filter((name) => name.endsWith('.jpg'))
    : [];
  assert.deepEqual(leftJpgFiles, []);
});

// Нулевой байт в кэше — это испорченная обложка, а не валидный результат: она должна
// быть перерисована, а не отдаваться браузеру как есть.
test('a zero-byte cached thumbnail is treated as a miss and re-rendered', (t) => {
  const { projectsDir } = makePultRoot(t);
  const video = path.join(projectsDir, 'clip.mp4');
  fs.writeFileSync(video, 'video');
  let calls = 0;
  const captureImpl = (command, args) => {
    calls += 1;
    fs.writeFileSync(args.at(-1), 'jpg');
    return { stdout: '' };
  };
  const target = thumbnailFor(projectsDir, video, { captureImpl });
  assert.equal(calls, 1);
  fs.writeFileSync(target, '');
  const again = thumbnailFor(projectsDir, video, { captureImpl });
  assert.equal(again, target);
  assert.equal(calls, 2);
  assert.equal(fs.statSync(target).size, 3);
});
