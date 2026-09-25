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
