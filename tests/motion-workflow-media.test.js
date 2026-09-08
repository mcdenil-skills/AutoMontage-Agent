const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createOrOpenProject, publishBriefRevision, readProjectManifest } = require('../scripts/project/workspace');
const { runPreviewQa } = require('../scripts/qa-preview');
const { configureMediaToolPath } = require('../scripts/env');

// Opt-in real Remotion + ffmpeg regression; generated local media, no provider or credentials.
test('real motion MP4 keeps clip trim, narration mix/replace, watermark, approval and QA', {
  skip: process.env.AUTOMONTAGE_TEST_MOTION_WORKFLOW !== '1', timeout: 600_000,
}, (t) => {
  configureMediaToolPath();
  const root = path.resolve(__dirname, '..');
  const work = process.env.AUTOMONTAGE_MOTION_E2E_DIR
    ? fs.mkdtempSync(path.join(path.resolve(process.env.AUTOMONTAGE_MOTION_E2E_DIR), 'run-'))
    : fs.mkdtempSync(path.join(os.tmpdir(), 'motion-media-e2e-'));
  if (!process.env.AUTOMONTAGE_MOTION_E2E_DIR) t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const ffmpeg = (args, options = {}) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { maxBuffer: 64 * 1024 * 1024, ...options });
  const cli = (args) => execFileSync(process.execPath, [path.join(root, 'scripts/cli.js'), ...args], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  const source = path.join(work, 'narration.wav');
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=9:sample_rate=48000', source]);
  const workspace = createOrOpenProject({ projectDir: path.join(work, 'project'), name: 'Neutral motion media test', sourcePath: source, projectKind: 'motion-reel', mediaKind: 'audio' });
  const clip = path.join(workspace.dir, 'assets/broll/colors.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=640x480:r=30:d=1', '-f', 'lavfi', '-i', 'color=c=green:s=640x480:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=3:sample_rate=48000', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);
  const sha256 = createHash('sha256').update(fs.readFileSync(clip)).digest('hex');
  const silent = path.join(workspace.dir, 'assets/broll/silent.mp4');
  ffmpeg(['-i', clip, '-an', '-c:v', 'copy', silent]);
  const silentSha256 = createHash('sha256').update(fs.readFileSync(silent)).digest('hex');
  const scenes = [
    { scene: 'kinetic-title', text: 'Точное движение' },
    { scene: 'card', title: 'Один тезис', body: 'Только проверенный текст' },
    { scene: 'steps', title: 'Три шага', steps: ['Прочитать', 'Проверить', 'Собрать'] },
    { scene: 'list', title: 'Два пункта', items: ['Звук', 'Изображение'] },
    { scene: 'counter', label: 'Проверено', value: 7 },
    ...['mute', 'mix', 'replace'].map(audioMode => ({ scene: 'media', media: { kind: 'video',
      src: audioMode === 'mute' ? 'assets/broll/silent.mp4' : 'assets/broll/colors.mp4',
      sha256: audioMode === 'mute' ? silentSha256 : sha256, fit: 'contain', trimStartSec: 1, audioMode } })),
    { scene: 'cta', title: 'Готово', action: 'Сохраните результат' },
  ].map((scene, index) => ({ ...scene, start: index, end: index + 1 }));
  const brief = { version: 1, kind: 'motion-reel', status: 'draft', source: workspace.manifest.source.localPath, theme: 'motion-neutral', title: 'Публичная проверка', output: { aspect: 'vertical', width: 1080, height: 1920, fps: 30, durationInFrames: 270 }, scenes };
  fs.writeFileSync(path.join(workspace.dir, 'transcript/words.json'), JSON.stringify([{ start: 0, end: 9, text: 'Синтетический тест', words: [] }]));
  const draft = publishBriefRevision(workspace, { kind: 'motion-reel', brief });
  cli(['preview', '--project-dir', workspace.dir, '--brief', draft.relativePath, '--no-open']);
  const preview = path.join(workspace.dir, 'previews/current-preview.mp4');
  const previewQa = runPreviewQa({ projectDir: workspace.dir });
  assert.equal(previewQa.video.width, 540);
  assert.equal(previewQa.video.height, 960);
  assert.ok(Number.isFinite(previewQa.audio.voiceDb));
  execFileSync(process.execPath, [path.join(root, 'scripts/project/approve-brief.js'), workspace.dir, draft.relativePath, '--confirm-preview-viewed']);
  const manifest = readProjectManifest(workspace.dir);
  cli(['motion', '--project-dir', workspace.dir, '--brief', manifest.currentBrief, '--version-label', 'media-e2e']);
  const final = path.join(workspace.dir, manifest.final);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', final]));
  const video = probe.streams.find(stream => stream.codec_type === 'video');
  assert.deepEqual([video.width, video.height, video.r_frame_rate], [1080, 1920, '30/1']);
  assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'));
  assert.ok(Math.abs(Number(probe.format.duration) - 9) < 0.08);
  ffmpeg(['-i', final, '-f', 'null', '-']);
  function frequencies(time) {
    const pcm = ffmpeg(['-ss', String(time), '-i', final, '-t', '0.25', '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1']);
    const values = Array.from({ length: pcm.length / 4 }, (_, index) => pcm.readFloatLE(index * 4));
    const amplitude = frequency => {
      let re = 0; let im = 0;
      values.forEach((value, index) => { const angle = 2 * Math.PI * frequency * index / 48000; re += value * Math.cos(angle); im += value * Math.sin(angle); });
      return 2 * Math.hypot(re, im) / values.length;
    };
    return { narration440: amplitude(440), clip880: amplitude(880) };
  }
  const mute = frequencies(5.35); const mix = frequencies(6.35); const replace = frequencies(7.35); const after = frequencies(8.35);
  assert.ok(mute.narration440 > mute.clip880 * 30, JSON.stringify(mute));
  assert.ok(mix.narration440 > 0.01 && mix.clip880 > 0.001, JSON.stringify(mix));
  assert.ok(mix.clip880 < mix.narration440 * 0.3, JSON.stringify(mix));
  assert.ok(replace.clip880 > replace.narration440 * 30, JSON.stringify(replace));
  assert.ok(after.narration440 > after.clip880 * 30, JSON.stringify(after));
  // At global 5.5 s, clip-local 0.5 s must read source 1.5 s (green), not red source 0.5 s.
  const pixel = ffmpeg(['-ss', '5.5', '-i', final, '-vf', 'crop=4:4:538:758,scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  assert.ok(pixel[1] > pixel[0] * 2 && pixel[1] > pixel[2] * 2, `trim pixel ${[...pixel]}`);
  for (let index = 0; index < 9; index += 1) ffmpeg(['-ss', String(index + 0.5), '-i', final, '-frames:v', '1', path.join(work, `scene-${index + 1}.png`)]);
  ffmpeg(['-ss', '0.5', '-i', preview, '-frames:v', '1', path.join(work, 'draft-watermark.png')]);
  const report = { work, projectDir: workspace.dir, final, previewQa, duration: Number(probe.format.duration), mute, mix, replace, after, trimPixel: [...pixel], render: readProjectManifest(workspace.dir).renders.at(-1) };
  fs.writeFileSync(path.join(work, 'evidence.json'), JSON.stringify(report, null, 2));
  console.log(`Motion real-media evidence: ${path.join(work, 'evidence.json')}`);
});
