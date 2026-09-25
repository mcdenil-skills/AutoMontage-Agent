const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { addTakes, transcribeTakeFile } = require('../scripts/project/takes');
const {
  createOrOpenProject,
  readProjectManifest,
} = require('../scripts/project/workspace');
const { runTool } = require('../scripts/process');
const { ffmpegEncoderAvailable, toolAvailable } = require('./helpers/media-fixtures');

function media(overrides = {}) {
  return {
    mediaKind: 'video',
    width: 1920,
    height: 1080,
    rotation: 0,
    hasAudio: true,
    audioSampleRate: 48000,
    audioChannels: 2,
    videoDurationSec: 10,
    audioDurationSec: 10,
    ...overrides,
  };
}

function makeProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-takes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, 'take1.mp4');
  const second = path.join(root, 'take2.MOV');
  fs.writeFileSync(original, 'TAKE-ONE');
  fs.writeFileSync(second, 'TAKE-TWO');
  const workspace = createOrOpenProject({
    projectDir: path.join(root, 'project'),
    name: 'Takes',
    sourcePath: original,
    now: new Date('2026-09-25T10:00:00.000Z'),
  });
  return { root, original, second, dir: workspace.dir };
}

function fakes(overrides = {}) {
  const transcribed = [];
  return {
    transcribed,
    deps: {
      probeVideoImpl: () => ({ width: 1920, height: 1080, fps: 25, duration: 10 }),
      probeMediaPathImpl: () => media(),
      transcribeImpl({ videoPath }) {
        transcribed.push(path.basename(videoPath));
        return [{ start: 0, end: 1, text: 'слово', words: [{ w: 'слово', s: 0.2, e: 0.6 }] }];
      },
      now: () => new Date('2026-09-25T11:00:00.000Z'),
      temporaryId: () => 'takes-test',
      ...overrides,
    },
  };
}

test('takes add registers the original as take-01 and copies new takes without touching the source', (t) => {
  const fixture = makeProject(t);
  const { deps, transcribed } = fakes();
  const result = addTakes({ projectDir: fixture.dir, files: [fixture.second] }, deps);
  const manifest = readProjectManifest(fixture.dir);

  assert.deepEqual(manifest.takes, [
    {
      id: 'take-01',
      originalPath: fixture.original,
      localPath: 'input/source.mp4',
      transcriptPath: 'transcript/takes/take-01.json',
    },
    {
      id: 'take-02',
      originalPath: fixture.second,
      localPath: 'input/takes/take-02.mov',
      transcriptPath: 'transcript/takes/take-02.json',
    },
  ]);
  assert.deepEqual(result.takes.map((take) => take.id), ['take-01', 'take-02']);
  assert.deepEqual(transcribed, ['source.mp4', 'take-02.mov']);
  assert.equal(fs.readFileSync(path.join(fixture.dir, 'input', 'takes', 'take-02.mov'), 'utf8'), 'TAKE-TWO');
  assert.equal(fs.readFileSync(fixture.second, 'utf8'), 'TAKE-TWO');
  assert.equal(manifest.source.localPath, 'input/source.mp4');
  assert.equal(manifest.source.revision, 1);
  assert.equal(JSON.parse(fs.readFileSync(
    path.join(fixture.dir, 'transcript', 'takes', 'take-02.json'), 'utf8',
  ))[0].words[0].w, 'слово');
});

test('a second takes add appends without re-transcribing registered takes', (t) => {
  const fixture = makeProject(t);
  addTakes({ projectDir: fixture.dir, files: [fixture.second] }, fakes().deps);
  const third = path.join(fixture.root, 'take3.mp4');
  fs.writeFileSync(third, 'TAKE-THREE');
  const { deps, transcribed } = fakes();
  addTakes({ projectDir: fixture.dir, files: [third] }, deps);
  assert.deepEqual(readProjectManifest(fixture.dir).takes.map((take) => take.id), ['take-01', 'take-02', 'take-03']);
  assert.deepEqual(transcribed, ['take-03.mp4']);
});

test('incompatible takes are rejected before anything is copied', (t) => {
  const fixture = makeProject(t);
  for (const [label, overrides, pattern] of [
    ['fps', { probeVideoImpl: (file) => ({ width: 1920, height: 1080, fps: file.endsWith('take2.MOV') ? 30 : 25, duration: 10 }) }, /FPS/],
    ['size', { probeMediaPathImpl: (file) => (file.endsWith('take2.MOV') ? media({ width: 1280, height: 720 }) : media()) }, /frame size/],
    ['audio', { probeMediaPathImpl: (file) => (file.endsWith('take2.MOV') ? media({ hasAudio: false, audioSampleRate: null, audioChannels: null, audioDurationSec: null }) : media()) }, /no usable audio/],
    ['pixel aspect ratio', { probeMediaPathImpl: (file) => (file.endsWith('take2.MOV') ? media({ sampleAspectRatio: '4:3' }) : media()) }, /pixel aspect ratio/],
  ]) {
    assert.throws(() => addTakes({ projectDir: fixture.dir, files: [fixture.second] }, fakes(overrides).deps), pattern, label);
    assert.equal(readProjectManifest(fixture.dir).takes, undefined, label);
    assert.equal(fs.existsSync(path.join(fixture.dir, 'input', 'takes', 'take-02.mov')), false, label);
  }
});

test('a rotated take with the same displayed size is compatible', (t) => {
  const fixture = makeProject(t);
  const { deps } = fakes({
    probeMediaPathImpl: (file) => (file.endsWith('take2.MOV')
      ? media({ width: 1080, height: 1920, rotation: 90 })
      : media()),
  });
  addTakes({ projectDir: fixture.dir, files: [fixture.second] }, deps);
  assert.equal(readProjectManifest(fixture.dir).takes.length, 2);
});

test('a rotated take whose displayed pixel aspect ratio matches the reference is accepted', (t) => {
  const fixture = makeProject(t);
  const { deps } = fakes({
    probeMediaPathImpl: (file) => (file.endsWith('take2.MOV')
      // Raw SAR 3:4 swaps to the displayed 4:3 once rotation is applied, matching the
      // unrotated 4:3 reference below.
      ? media({
        width: 1080, height: 1920, rotation: 90, sampleAspectRatio: '3:4',
      })
      : media({ sampleAspectRatio: '4:3' })),
  });
  addTakes({ projectDir: fixture.dir, files: [fixture.second] }, deps);
  assert.equal(readProjectManifest(fixture.dir).takes.length, 2);
});

test('failed transcription removes copied files and leaves the manifest unchanged', (t) => {
  const fixture = makeProject(t);
  const { deps } = fakes({
    transcribeImpl({ videoPath }) {
      if (videoPath.endsWith('take-02.mov')) throw new Error('whisper failed');
      return [{ start: 0, end: 1, text: 'слово', words: [{ w: 'слово', s: 0.2, e: 0.6 }] }];
    },
  });
  let thrown = null;
  try {
    addTakes({ projectDir: fixture.dir, files: [fixture.second] }, deps);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, 'addTakes should throw');
  assert.match(thrown.message, /^take-02: whisper failed/);
  assert.equal(readProjectManifest(fixture.dir).takes, undefined);
  assert.equal(fs.existsSync(path.join(fixture.dir, 'input', 'takes', 'take-02.mov')), false);
  assert.equal(fs.existsSync(path.join(fixture.dir, 'transcript', 'takes', 'take-01.json')), false);
});

test('takes are refused for motion-reel projects and missing files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-takes-motion-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const narration = path.join(root, 'narration.wav');
  fs.writeFileSync(narration, 'NARRATION');
  const motion = createOrOpenProject({
    projectDir: path.join(root, 'motion'),
    name: 'Motion takes',
    sourcePath: narration,
    projectKind: 'motion-reel',
  });
  assert.throws(() => addTakes({ projectDir: motion.dir, files: [narration] }, fakes().deps), /only for video projects/);

  const fixture = makeProject(t);
  assert.throws(
    () => addTakes({ projectDir: fixture.dir, files: [path.join(fixture.root, 'missing.mp4')] }, fakes().deps),
    /take file not found/,
  );
});

test('takes stay registered when releasing the project lock fails after commit', (t) => {
  const fixture = makeProject(t);
  const { deps } = fakes({
    fileSystem: {
      ...fs,
      unlinkSync(target) {
        if (path.basename(target) === '.project-mutation.lock') {
          throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        }
        return fs.unlinkSync(target);
      },
    },
  });
  assert.throws(() => addTakes({ projectDir: fixture.dir, files: [fixture.second] }, deps), /EPERM/);
  const manifest = readProjectManifest(fixture.dir);
  assert.equal(manifest.takes.length, 2);
  assert.equal(fs.existsSync(path.join(fixture.dir, 'input', 'takes', 'take-02.mov')), true);
  assert.equal(fs.existsSync(path.join(fixture.dir, 'transcript', 'takes', 'take-02.json')), true);
  assert.equal(fs.existsSync(path.join(fixture.dir, 'transcript', 'takes', 'take-01.json')), true);
});

test('addTakes clamps zero-length whisper word timings before storing the transcript', (t) => {
  const fixture = makeProject(t);
  const { deps } = fakes({
    transcribeImpl: () => [{
      start: 46.6,
      end: 47,
      text: 'а б',
      words: [{ w: 'а', s: 46.6, e: 46.6 }, { w: 'б', s: 46.6, e: 47 }],
    }],
  });
  addTakes({ projectDir: fixture.dir, files: [fixture.second] }, deps);
  const stored = JSON.parse(fs.readFileSync(
    path.join(fixture.dir, 'transcript', 'takes', 'take-02.json'), 'utf8',
  ));
  assert.equal(stored[0].words[0].e, 46.61);
  assert.equal(stored[0].words[1].e, 47);
});

test('addTakes still rejects inverted word timings via collectWords', (t) => {
  const fixture = makeProject(t);
  const { deps } = fakes({
    transcribeImpl: () => [{ start: 0, end: 1, text: 'x', words: [{ w: 'x', s: 2, e: 1 }] }],
  });
  assert.throws(() => addTakes({ projectDir: fixture.dir, files: [fixture.second] }, deps), /таймкод/);
});

test('transcribeTakeFile clamps zero-length whisper words and removes its temporary directory', () => {
  let capturedDir = null;
  let ffmpegArgs = null;
  const segments = transcribeTakeFile({
    videoPath: '/tmp/source.mp4',
    model: 'large-v3-turbo',
    prompt: 'привет',
  }, {
    pythonCommand: 'python3',
    runToolImpl(command, args) {
      if (command === 'ffmpeg') {
        ffmpegArgs = args;
        return;
      }
      if (String(args[0]).endsWith('transcribe.py')) {
        capturedDir = path.dirname(args[1]);
        assert.equal(args[3], 'large-v3-turbo');
        assert.deepEqual(args.slice(4), ['--prompt', 'привет']);
        fs.writeFileSync(args[2], JSON.stringify([
          { start: 0, end: 1, text: 'а', words: [{ w: 'а', s: 46.6, e: 46.6 }] },
        ]));
      }
    },
  });
  assert.equal(segments[0].words[0].e, 46.61);
  assert.notEqual(capturedDir, null);
  assert.equal(fs.existsSync(capturedDir), false);
  assert.notEqual(ffmpegArgs, null);
  // -map 0:a:0 pins the first audio track (like trim's [N:a]) right after the input, and
  // aresample=async=1:min_hard_comp=0:first_pts=0 must sit right before the WAV output path, so a
  // take's audio that starts after the container start keeps its leading silence instead of
  // shifting every Whisper word earlier than the trim axis. The WAV path is no longer the last
  // argument: a second null output keeps the video stream in use (without decoding it) so MPEG-TS
  // does not recompute the start time from audio alone.
  assert.deepEqual(ffmpegArgs.slice(0, 5), ['-y', '-i', '/tmp/source.mp4', '-map', '0:a:0']);
  assert.deepEqual(ffmpegArgs.slice(5, 11), [
    '-af', 'aresample=async=1:min_hard_comp=0:first_pts=0', '-ar', '16000', '-ac', '1',
  ]);
  assert.ok(ffmpegArgs[11].endsWith('audio.wav'));
  assert.deepEqual(ffmpegArgs.slice(-7), ['-map', '0:v:0?', '-c', 'copy', '-f', 'null', '-']);
});

test('real transcribeTakeFile keeps the leading silence of audio starting after the video', { timeout: 60_000 }, (t) => {
  if (!toolAvailable('ffmpeg') || !toolAvailable('ffprobe') || !ffmpegEncoderAvailable('libx264')) {
    t.skip('leading audio gap probe requires ffmpeg, ffprobe and libx264');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-take-late-audio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const late = path.join(dir, 'late.mp4');
  const encode = spawnSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=3',
    '-itsoffset', '0.3', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-t', '3.3',
    late,
  ], { encoding: 'utf8' });
  assert.equal(encode.status, 0, encode.stderr);

  let measuredDuration = null;
  transcribeTakeFile({ videoPath: late }, {
    pythonCommand: 'python3',
    runToolImpl(command, args, options) {
      if (command === 'ffmpeg') {
        runTool(command, args, options);
        return;
      }
      const wavPath = args[1];
      const wordsPath = args[2];
      const probe = spawnSync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', wavPath,
      ], { encoding: 'utf8' });
      measuredDuration = Number(JSON.parse(probe.stdout).format.duration);
      fs.writeFileSync(wordsPath, JSON.stringify([
        { start: 0, end: 1, text: 'x', words: [{ w: 'x', s: 0.1, e: 0.5 }] },
      ]));
    },
  });
  // Without the leading-gap fix, extracting only the audio stream drops the 0.3 s gap and the
  // WAV measures near 3.0 s; with the fix it keeps the container's full ~3.3 s.
  assert.ok(measuredDuration > 3.2, `expected WAV duration > 3.2, got ${measuredDuration}`);
});

test('real transcribeTakeFile keeps the leading silence of an MPEG-TS take whose audio starts after the video', { timeout: 60_000 }, (t) => {
  if (!toolAvailable('ffmpeg') || !toolAvailable('ffprobe') || !ffmpegEncoderAvailable('libx264')) {
    t.skip('leading audio gap probe requires ffmpeg, ffprobe and libx264');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-take-late-audio-ts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const late = path.join(dir, 'late.ts');
  const encode = spawnSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=3',
    '-itsoffset', '0.3', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-t', '3.3',
    late,
  ], { encoding: 'utf8' });
  assert.equal(encode.status, 0, encode.stderr);

  let measuredDuration = null;
  transcribeTakeFile({ videoPath: late }, {
    pythonCommand: 'python3',
    runToolImpl(command, args, options) {
      if (command === 'ffmpeg') {
        runTool(command, args, options);
        return;
      }
      const wavPath = args[1];
      const wordsPath = args[2];
      const probe = spawnSync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', wavPath,
      ], { encoding: 'utf8' });
      measuredDuration = Number(JSON.parse(probe.stdout).format.duration);
      fs.writeFileSync(wordsPath, JSON.stringify([
        { start: 0, end: 1, text: 'x', words: [{ w: 'x', s: 0.1, e: 0.5 }] },
      ]));
    },
  });
  // Same leading-gap fixture as the MP4 test above, but MPEG-TS: without -copyts, ffmpeg
  // recomputes the start time from the streams it actually uses, so dropping the video used to
  // move the start to the first audio sample and erase the 0.3 s gap.
  assert.ok(measuredDuration > 3.2, `expected WAV duration > 3.2, got ${measuredDuration}`);
});

test('a leftover take file from an interrupted run is rejected before transcribing', (t) => {
  const fixture = makeProject(t);
  fs.mkdirSync(path.join(fixture.dir, 'input', 'takes'), { recursive: true });
  fs.writeFileSync(path.join(fixture.dir, 'input', 'takes', 'take-02.mov'), 'LEFTOVER');
  const { deps, transcribed } = fakes();
  assert.throws(
    () => addTakes({ projectDir: fixture.dir, files: [fixture.second] }, deps),
    /leftover files.*input\/takes\/take-02\.mov/,
  );
  assert.deepEqual(transcribed, []);
});

test('a take file listed twice in one call is rejected before anything happens', (t) => {
  const fixture = makeProject(t);
  const { deps, transcribed } = fakes();
  assert.throws(
    () => addTakes({ projectDir: fixture.dir, files: [fixture.second, fixture.second] }, deps),
    /listed more than once/,
  );
  assert.deepEqual(transcribed, []);
  assert.equal(readProjectManifest(fixture.dir).takes, undefined);
});

test('the original source file cannot be added again as a take', (t) => {
  const fixture = makeProject(t);
  const { deps, transcribed } = fakes();
  assert.throws(
    () => addTakes({ projectDir: fixture.dir, files: [fixture.original] }, deps),
    /already registered as take-01/,
  );
  assert.deepEqual(transcribed, []);
  assert.equal(readProjectManifest(fixture.dir).takes, undefined);
});

test('an already registered take cannot be added again', (t) => {
  const fixture = makeProject(t);
  addTakes({ projectDir: fixture.dir, files: [fixture.second] }, fakes().deps);
  const { deps, transcribed } = fakes();
  assert.throws(
    () => addTakes({ projectDir: fixture.dir, files: [fixture.second] }, deps),
    /already registered as take-02/,
  );
  assert.deepEqual(transcribed, []);
  assert.equal(readProjectManifest(fixture.dir).takes.length, 2);
});

test('a leftover transcript file from an interrupted run is rejected before transcribing', (t) => {
  const fixture = makeProject(t);
  fs.mkdirSync(path.join(fixture.dir, 'transcript', 'takes'), { recursive: true });
  fs.writeFileSync(path.join(fixture.dir, 'transcript', 'takes', 'take-01.json'), 'LEFTOVER');
  const { deps, transcribed } = fakes();
  assert.throws(
    () => addTakes({ projectDir: fixture.dir, files: [fixture.second] }, deps),
    /leftover files.*transcript\/takes\/take-01\.json/,
  );
  assert.deepEqual(transcribed, []);
});

test('a concurrent takes add fails on the project lock instead of reporting the running import as leftovers', (t) => {
  const fixture = makeProject(t);
  const third = path.join(fixture.root, 'take3-concurrent.mp4');
  fs.writeFileSync(third, 'TAKE-THREE');

  const bTranscribed = [];
  let concurrentError = null;
  let callCount = 0;

  const { deps: aDeps } = fakes({
    transcribeImpl({ videoPath }) {
      callCount += 1;
      if (callCount === 2) {
        // A уже скопировал take-02 и держит замок, расшифровывая его; B стартует импорт того же проекта.
        const { deps: bDeps } = fakes({
          transcribeImpl({ videoPath: bVideoPath }) {
            bTranscribed.push(path.basename(bVideoPath));
            return [{ start: 0, end: 1, text: 'слово', words: [{ w: 'слово', s: 0.2, e: 0.6 }] }];
          },
        });
        try {
          addTakes({ projectDir: fixture.dir, files: [third] }, bDeps);
        } catch (error) {
          concurrentError = error;
        }
      }
      return [{ start: 0, end: 1, text: 'слово', words: [{ w: 'слово', s: 0.2, e: 0.6 }] }];
    },
  });

  const result = addTakes({ projectDir: fixture.dir, files: [fixture.second] }, aDeps);

  assert.ok(concurrentError, 'the concurrent import should have failed');
  assert.equal(concurrentError.code, 'PROJECT_MANIFEST_CONFLICT');
  assert.doesNotMatch(concurrentError.message, /leftover files/);
  assert.deepEqual(bTranscribed, []);

  assert.deepEqual(result.takes.map((take) => take.id), ['take-01', 'take-02']);
  const manifest = readProjectManifest(fixture.dir);
  assert.deepEqual(manifest.takes.map((take) => take.id), ['take-01', 'take-02']);
  assert.equal(fs.existsSync(path.join(fixture.dir, 'input', 'takes', 'take-02.mov')), true);
  assert.equal(fs.readFileSync(path.join(fixture.dir, 'input', 'takes', 'take-02.mov'), 'utf8'), 'TAKE-TWO');
});

test('addTakes lets collectWords reject a non-array transcript instead of crashing', (t) => {
  const fixture = makeProject(t);
  const { deps } = fakes({ transcribeImpl: () => ({}) });
  assert.throws(() => addTakes({ projectDir: fixture.dir, files: [fixture.second] }, deps), /массивом сегментов/);
});
