const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  ffmpegEncoderAvailable,
  runTool: runFixture,
  toolAvailable,
} = require('./helpers/media-fixtures');
const { buildMaster } = require('../scripts/project/build-master');
const { addTakes } = require('../scripts/project/takes');
const { analyzeLevels, readTakeLevels } = require('../scripts/project/take-pauses');
const { createOrOpenProject, readProjectManifest } = require('../scripts/project/workspace');

function streams(file) {
  const result = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,duration,r_frame_rate,width,height,sample_rate,channels',
    '-of', 'json', file,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).streams;
}

test('real takes master joins two generated takes with matching audio and video length', {
  timeout: 180_000,
}, (t) => {
  if (!toolAvailable('ffmpeg') || !toolAvailable('ffprobe') || !ffmpegEncoderAvailable('libx264')) {
    t.skip('real takes master requires ffmpeg, ffprobe and libx264');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-takes-real-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'take1.mp4');
  const second = path.join(root, 'take2.mp4');
  runFixture('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=3',
    '-ac', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', first,
  ], root);
  runFixture('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'smptebars=s=160x90:r=25:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100:d=3',
    '-ac', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', second,
  ], root);

  const workspace = createOrOpenProject({
    projectDir: path.join(root, 'project'), name: 'Real takes', sourcePath: first,
  });
  addTakes({ projectDir: workspace.dir, files: [second] }, {
    transcribeImpl: ({ videoPath }) => [{
      start: 0,
      end: 3,
      text: path.basename(videoPath),
      words: [{ w: path.basename(videoPath, path.extname(videoPath)), s: 0.6, e: 1.2 }],
    }],
  });
  fs.writeFileSync(path.join(workspace.dir, 'edit', 'v02-takes.json'), `${JSON.stringify({
    version: 1,
    kind: 'takes',
    sourceRevision: 1,
    ranges: [
      { take: 'take-01', start: 0, end: 1, beat: 'HOOK', reason: 'проверка первого дубля' },
      { take: 'take-02', start: 1, end: 2, beat: 'CTA', reason: 'проверка второго дубля' },
    ],
  }, null, 2)}\n`);

  const result = buildMaster({ projectDir: workspace.dir, editPath: 'edit/v02-takes.json' });

  const output = streams(result.sourcePath);
  const video = output.find((stream) => stream.codec_type === 'video');
  const audio = output.find((stream) => stream.codec_type === 'audio');
  assert.equal(video.r_frame_rate, '25/1');
  assert.deepEqual([video.width, video.height], [160, 90]);
  assert.ok(Math.abs(Number(video.duration) - 2) < 0.02, video.duration);
  assert.ok(Math.abs(Number(audio.duration) - Number(video.duration)) < 0.03, `${audio.duration} vs ${video.duration}`);
  assert.equal(audio.sample_rate, '48000');
  assert.equal(audio.channels, 2);
  assert.equal(readProjectManifest(workspace.dir).source.localPath, 'input/source-v02.mp4');
  const words = JSON.parse(fs.readFileSync(result.transcriptPath, 'utf8'))[0].words;
  assert.deepEqual(words.map((word) => [word.w, word.s, word.e]), [
    ['source', 0.6, 1],
    ['take-02', 1, 1.2],
  ]);
});

test('real takes master stays in sync with a late-video take and a take reused backwards', {
  timeout: 180_000,
}, (t) => {
  if (!toolAvailable('ffmpeg') || !toolAvailable('ffprobe') || !ffmpegEncoderAvailable('libx264')) {
    t.skip('real takes master requires ffmpeg, ffprobe and libx264');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-takes-late-video-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'take1.mp4');
  const second = path.join(root, 'take2.mp4');
  runFixture('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=3',
    '-ac', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', first,
  ], root);
  runFixture('ffmpeg', [
    '-y', '-v', 'error',
    '-itsoffset', '0.04', '-f', 'lavfi', '-i', 'smptebars=s=160x90:r=25:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:d=3',
    // -fps_mode passthrough keeps the encoder from filling the itsoffset gap with a duplicated
    // first frame: without it, some ffmpeg builds (constant-frame-rate MP4 output by default,
    // e.g. 6.1.x) synthesize a frame at 0-0.04 and the video stream start_time comes back 0,
    // silently erasing the leading gap this fixture exists to exercise.
    '-ac', '2', '-fps_mode', 'passthrough', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', second,
  ], root);

  // Документируем форму фикстуры: -itsoffset на видео-входе должен дать видео с более поздним
  // start_time, чем у звука. Отсутствие ffmpeg/ffprobe/libx264 уже отловлено skip'ом выше;
  // если сама фикстура вышла другой формы на установленном инструментарии, это ошибка
  // окружения и должна валиться явной проверкой, а не тихим пропуском (см. TESTING.md).
  const secondProbe = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,start_time',
    '-of', 'json', second,
  ], { encoding: 'utf8' });
  assert.equal(secondProbe.status, 0, secondProbe.stderr);
  const secondStartTimes = JSON.parse(secondProbe.stdout).streams;
  const secondVideoStream = secondStartTimes.find((stream) => stream.codec_type === 'video');
  const secondAudioStream = secondStartTimes.find((stream) => stream.codec_type === 'audio');
  assert.ok(secondVideoStream, 'take2 fixture must have a video stream');
  assert.ok(secondAudioStream, 'take2 fixture must have an audio stream');
  const secondVideoStart = Number(secondVideoStream.start_time);
  const secondAudioStart = Number(secondAudioStream.start_time);
  assert.ok(
    Math.abs(secondVideoStart - 0.04) <= 0.005,
    `take2 video start_time expected ~0.04, got ${secondVideoStart}`,
  );
  assert.ok(
    Math.abs(secondAudioStart) <= 0.005,
    `take2 audio start_time expected ~0, got ${secondAudioStart}`,
  );

  const workspace = createOrOpenProject({
    projectDir: path.join(root, 'project'), name: 'Real takes late video', sourcePath: first,
  });
  addTakes({ projectDir: workspace.dir, files: [second] }, {
    transcribeImpl: ({ videoPath }) => [{
      start: 0,
      end: 3,
      text: path.basename(videoPath),
      words: [{ w: path.basename(videoPath, path.extname(videoPath)), s: 0.6, e: 1.2 }],
    }],
  });
  fs.writeFileSync(path.join(workspace.dir, 'edit', 'v02-takes.json'), `${JSON.stringify({
    version: 1,
    kind: 'takes',
    sourceRevision: 1,
    ranges: [
      // Начинается внутри ведущего видео-зазора take-02 - должен быть прижат к 0.04.
      { take: 'take-02', start: 0, end: 1, beat: 'HOOK', reason: 'проверка зажима зазора' },
      { take: 'take-01', start: 2, end: 3, beat: 'B', reason: 'первое использование take-01' },
      // take-01 уже использован дальше по времени (2-3) - этот кусок раньше требует новый вход.
      { take: 'take-01', start: 0, end: 1, beat: 'C', reason: 'повторное использование назад во времени' },
    ],
  }, null, 2)}\n`);

  const result = buildMaster({ projectDir: workspace.dir, editPath: 'edit/v02-takes.json' });

  const frameCount = spawnSync('ffprobe', [
    '-v', 'error', '-count_frames',
    '-show_entries', 'stream=codec_type,duration,r_frame_rate,nb_read_frames',
    '-of', 'json', result.sourcePath,
  ], { encoding: 'utf8' });
  assert.equal(frameCount.status, 0, frameCount.stderr);
  const outputStreams = JSON.parse(frameCount.stdout).streams;
  const video = outputStreams.find((stream) => stream.codec_type === 'video');
  const audio = outputStreams.find((stream) => stream.codec_type === 'audio');
  assert.equal(Number(video.nb_read_frames), 74, video.nb_read_frames);
  assert.equal(video.r_frame_rate, '25/1');
  assert.ok(
    Math.abs(Number(audio.duration) - Number(video.duration)) < 0.02,
    `${audio.duration} vs ${video.duration}`,
  );
  assert.ok(Math.abs(Number(video.duration) - 2.96) < 0.02, video.duration);
  assert.equal(result.ranges[0].start, 0.04);
});

test('real takes master moves cuts inside speech into the nearest pause', { timeout: 180_000 }, (t) => {
  if (!toolAvailable('ffmpeg') || !toolAvailable('ffprobe') || !ffmpegEncoderAvailable('libx264')) {
    t.skip('real pause cuts require ffmpeg, ffprobe and libx264');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-takes-pauses-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'take1.mp4');
  const second = path.join(root, 'take2.mp4');
  // Тон вместо речи: take1 звучит 0-1.0 и 1.3-2.5 с, take2 звучит 0-0.8 и с 1.2 с.
  runFixture('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=3',
    '-f', 'lavfi', '-i', "aevalsrc='if(lt(t,1)+between(t,1.3,2.5),0.3*sin(2*PI*440*t),0)':s=48000:d=3",
    '-ac', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', first,
  ], root);
  runFixture('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'smptebars=s=160x90:r=25:d=3',
    '-f', 'lavfi', '-i', "aevalsrc='if(lt(t,0.8)+gte(t,1.2),0.3*sin(2*PI*660*t),0)':s=48000:d=3",
    '-ac', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', second,
  ], root);
  const workspace = createOrOpenProject({
    projectDir: path.join(root, 'project'), name: 'Pause cuts', sourcePath: first,
  });
  const takeWords = {
    'source.mp4': [
      { w: 'один', s: 0.2, e: 0.9 },
      { w: 'Продолжение', s: 1.02, e: 1.08 },
    ],
    'take-02.mp4': [{ w: 'три', s: 1.3, e: 1.9 }],
  };
  addTakes({ projectDir: workspace.dir, files: [second] }, {
    transcribeImpl: ({ videoPath }) => [{
      start: 0, end: 3, text: 'x', words: takeWords[path.basename(videoPath)],
    }],
  });
  fs.writeFileSync(path.join(workspace.dir, 'edit', 'v02-takes.json'), `${JSON.stringify({
    version: 1,
    kind: 'takes',
    sourceRevision: 1,
    ranges: [
      { take: 'take-01', start: 0, end: 1.36, beat: 'HOOK', reason: 'конец внутри второго тона' },
      { take: 'take-02', start: 0.75, end: 2, beat: 'CTA', reason: 'начало внутри первого тона' },
    ],
  }, null, 2)}\n`);

  const result = buildMaster({ projectDir: workspace.dir, editPath: 'edit/v02-takes.json' });

  const moved = (index, edge) => result.pauseAdjustments
    .find((item) => item.index === index && item.edge === edge && item.reason === 'pause');
  assert.ok(moved(0, 'end') && moved(0, 'end').to >= 1 && moved(0, 'end').to <= 1.3, JSON.stringify(result.pauseAdjustments));
  assert.ok(moved(1, 'start') && moved(1, 'start').to >= 0.8 && moved(1, 'start').to <= 1.2, JSON.stringify(result.pauseAdjustments));
  const [pieceOne, pieceTwo] = result.ranges;
  const expectedFrames = Math.round(pieceOne.end * 25) + Math.round((pieceTwo.end - pieceTwo.start) * 25);
  const probe = spawnSync('ffprobe', [
    '-v', 'error', '-count_frames',
    '-show_entries', 'stream=codec_type,nb_read_frames,duration', '-of', 'json', result.sourcePath,
  ], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  const output = JSON.parse(probe.stdout).streams;
  const video = output.find((stream) => stream.codec_type === 'video');
  const audio = output.find((stream) => stream.codec_type === 'audio');
  assert.equal(Number(video.nb_read_frames), expectedFrames);
  assert.ok(Math.abs(Number(audio.duration) - Number(video.duration)) < 0.02, `${audio.duration} vs ${video.duration}`);
  const [joint] = result.joints;
  const levels = analyzeLevels(readTakeLevels(result.sourcePath));
  const around = levels.levels.slice(Math.round((joint - 0.1) * 100), Math.round((joint + 0.08) * 100));
  assert.ok(Math.max(...around) < -60, `joint ${joint}: ${Math.max(...around)} dB`);
  const words = JSON.parse(fs.readFileSync(result.transcriptPath, 'utf8'))[0].words;
  assert.deepEqual(words.map((word) => word.w), ['один', 'три']);
});
