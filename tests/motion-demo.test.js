const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { MOTION_SCENES, validateMotionBrief } = require('../scripts/motion/brief');
const { readProjectManifest } = require('../scripts/project/workspace');

const ROOT = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-demo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('public motion demo brief covers exactly seven frame-aligned scenes with neutral media', () => {
  const brief = JSON.parse(read('examples/motion-brief-demo.json'));
  assert.deepEqual(validateMotionBrief(brief), { ok: true, errors: [] });
  assert.deepEqual(brief.scenes.map(scene => scene.scene), MOTION_SCENES);
  assert.equal(brief.status, 'draft');
  assert.equal(brief.source, 'input/narration.wav');
  assert.deepEqual(brief.output, { aspect: 'vertical', width: 1080, height: 1920, fps: 30, durationInFrames: 630 });
  assert.equal(brief.scenes.at(-1).end, 21);
});

test('motion demo CLI creates only an audio draft offline and refuses to overwrite a project', t => {
  const projectDir = path.join(temporary(t), 'project');
  const env = { ...process.env, ELEVENLABS_API_KEY: '', ELEVENLABS_VOICE_ID: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' };
  const cli = args => execFileSync(process.execPath, [path.join(ROOT, 'scripts/cli.js'), ...args], { cwd: ROOT, env, encoding: 'utf8', stdio: 'pipe' });
  const output = cli(['demo', '--motion', '--project-dir', projectDir]);
  assert.match(output, /test tones|тестов.*тон/iu);
  assert.match(output, /automontage preview/);
  const manifest = readProjectManifest(projectDir);
  assert.equal(manifest.projectKind, 'motion-reel');
  assert.equal(manifest.source.mediaKind, 'audio');
  assert.equal(manifest.final, 'final/neutral-motion-demo.mp4');
  assert.deepEqual(manifest.renders, []);
  assert.equal(manifest.briefs.length, 1);
  assert.equal(manifest.briefs[0].status, 'draft');
  assert.equal(manifest.currentPreview, undefined);
  assert.equal(fs.existsSync(path.join(projectDir, manifest.final)), false);
  const brief = JSON.parse(fs.readFileSync(path.join(projectDir, manifest.currentBrief)));
  assert.deepEqual(brief.scenes.map(scene => scene.scene), MOTION_SCENES);
  const media = brief.scenes.find(scene => scene.scene === 'media').media;
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(projectDir, media.src))).digest('hex'), media.sha256);
  const before = fs.readFileSync(path.join(projectDir, 'project.json'));
  fs.writeFileSync(path.join(projectDir, 'keep.txt'), 'user edits');
  assert.throws(() => cli(['demo', '--motion', '--project-dir', projectDir]), /already exists|уже существует/i);
  assert.deepEqual(fs.readFileSync(path.join(projectDir, 'project.json')), before);
  assert.equal(fs.readFileSync(path.join(projectDir, 'keep.txt'), 'utf8'), 'user edits');
  assert.throws(() => cli(['demo', '--motion', '--accept-provider-cost']), /unknown|usage|option/i);
});

test('canonical motion skill and its references are identical in agent adapters', () => {
  for (const file of ['SKILL.md', 'references/brief-package.md']) {
    const canonical = read(`skills/motion-reel/${file}`);
    for (const prefix of ['.agents', '.codex']) assert.equal(read(`${prefix}/skills/motion-reel/${file}`), canonical);
  }
  const skill = read('skills/motion-reel/SKILL.md');
  for (const token of ['script', 'ElevenLabs', '--accept-provider-cost', 'automontage preview', '--confirm-preview-viewed', '--version-label', 'qa-preview.js']) assert.ok(skill.includes(token), token);
  for (const prefix of ['skills', '.agents/skills', '.codex/skills']) {
    const turnkey = read(`${prefix}/reel-turnkey/SKILL.md`);
    assert.match(turnkey, /без камеры[\s\S]*motion-reel/u);
    if (prefix === 'skills') assert.ok(turnkey.indexOf('motion-reel') < turnkey.indexOf('## Границы навыка'));
    else assert.match(turnkey, /\.\.\/\.\.\/\.\.\/skills\/reel-turnkey\/SKILL\.md/u);
  }
});

test('motion demo defaults to the caller workspace and rejects existing empty destinations', t => {
  const cwd = temporary(t);
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/cli.js'), 'demo', '--motion'], { cwd, stdio: 'pipe' });
  assert.equal(readProjectManifest(path.join(cwd, 'projects/motion-demo')).projectKind, 'motion-reel');
  const empty = path.join(cwd, 'empty'); fs.mkdirSync(empty);
  assert.throws(() => require('../scripts/motion/demo').initializeMotionDemo({ projectDir: empty }), /already exists/i);
  assert.deepEqual(fs.readdirSync(empty), []);
});

for (const explicit of [false, true]) {
  test(`local-audio motion initialization uses ${explicit ? 'explicit project-dir' : 'only the caller projects directory'}`, t => {
    const cwd = temporary(t);
    const source = path.join(cwd, 'narration.wav');
    fs.writeFileSync(source, require('../scripts/generate-neutral-fixtures').buildMotionDemoFixture().audioBytes);
    const previousCwd = process.cwd();
    let result;
    try {
      process.chdir(cwd);
      result = require('../scripts/motion/build').runMotion({ narrationPath: source, project: 'Neutral local audio',
        ...(explicit ? { projectDir: path.join(cwd, 'chosen') } : {}),
      }, {
        probeOpenedAudioImpl: () => ({ mediaKind: 'audio', durationSec: 21 }),
        transcribeMotionNarrationImpl({ workspace }) {
          const transcript = [{ start: 0, end: 21, text: 'Нейтральный тест', words: [] }];
          fs.writeFileSync(path.join(workspace.dir, 'transcript/words.json'), JSON.stringify(transcript));
          return { transcript };
        },
      });
    } finally { process.chdir(previousCwd); }
    assert.equal(fs.realpathSync(explicit ? result.projectDir : path.dirname(result.projectDir)),
      fs.realpathSync(path.join(cwd, explicit ? 'chosen' : 'projects')));
    assert.deepEqual(fs.readdirSync(cwd).sort(), [explicit ? 'chosen' : 'projects', 'narration.wav'].sort());
    assert.equal(readProjectManifest(result.projectDir).projectKind, 'motion-reel');
  });
}

test('public docs connect the motion demo, scene catalog and approval workflow', () => {
  for (const file of ['README.md', 'ARCHITECTURE.md', 'docs/TEMPLATES.md', 'docs/SCENE-CATALOG.md', 'docs/MONTAGE-GUIDE.md', 'TESTING.md', 'CHANGELOG.md']) {
    assert.match(read(file), /motion-reel|MotionReel/, file);
  }
  for (const file of ['README.md', 'TESTING.md', 'docs/MONTAGE-GUIDE.md']) assert.ok(read(file).includes('automontage demo --motion'), file);
  for (const file of ['README.md', 'TESTING.md']) assert.ok(read(file).includes('projects/motion-demo/final/neutral-motion-demo.mp4'), file);
  for (const scene of MOTION_SCENES) assert.ok(read('docs/SCENE-CATALOG.md').includes(`\`${scene}\``), scene);
  assert.match(read('skills/motion-reel/SKILL.md'), /расписан[\s\S]*автопубликац[\s\S]*отдельн/iu);
});

test('real offline demo CLI renders seven scenes to a checked H.264/AAC final', {
  skip: process.env.AUTOMONTAGE_TEST_MOTION_DEMO !== '1', timeout: 600_000,
}, t => {
  require('../scripts/env').configureMediaToolPath();
  const keep = process.env.AUTOMONTAGE_MOTION_DEMO_DIR;
  const work = keep ? fs.mkdtempSync(path.join(path.resolve(keep), 'run-')) : temporary(t);
  const projectDir = path.join(work, 'project');
  const env = { ...process.env, ELEVENLABS_API_KEY: '', ELEVENLABS_VOICE_ID: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' };
  const node = (file, args) => execFileSync(process.execPath, [path.join(ROOT, file), ...args], { cwd: ROOT, env, maxBuffer: 32 * 1024 * 1024 });
  const cli = args => node('scripts/cli.js', args);
  const ffmpeg = args => execFileSync('ffmpeg', ['-v', 'error', ...args], { maxBuffer: 32 * 1024 * 1024 });
  cli(['demo', '--motion', '--project-dir', projectDir]);
  cli(['preview', '--project-dir', projectDir, '--brief', 'brief/v01-draft.motion.json', '--no-open']);
  node('scripts/qa-preview.js', ['--project-dir', projectDir]);
  const before = readProjectManifest(projectDir);
  assert.equal(before.currentPreview.kind, 'full');
  assert.equal(before.briefs[0].status, 'draft');
  assert.deepEqual(before.renders, []);
  const preview = path.join(projectDir, 'previews/current-preview.mp4');
  ffmpeg(['-i', preview, '-f', 'null', '-']);
  ffmpeg(['-ss', '1.5', '-i', preview, '-frames:v', '1', path.join(work, 'draft-watermark.png')]);
  // Explicit synthetic-fixture test approval; normal user work still requires user consent.
  node('scripts/project/approve-brief.js', [projectDir, 'brief/v01-draft.motion.json', '--confirm-preview-viewed']);
  cli(['motion', '--project-dir', projectDir, '--brief', 'brief/v01-approved.motion.json', '--version-label', 'demo-qa']);
  const manifest = readProjectManifest(projectDir);
  const final = path.join(projectDir, manifest.final);
  const metadata = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', final]));
  const video = metadata.streams.filter(stream => stream.codec_type === 'video');
  const audio = metadata.streams.filter(stream => stream.codec_type === 'audio');
  assert.equal(video.length, 1);
  assert.deepEqual([video[0].codec_name, video[0].width, video[0].height, video[0].r_frame_rate], ['h264', 1080, 1920, '30/1']);
  assert.equal(audio.length, 1);
  assert.equal(audio[0].codec_name, 'aac');
  assert.ok(Math.abs(Number(metadata.format.duration) - 21) < 0.08);
  assert.equal(manifest.renders.at(-1).status, 'complete');
  ffmpeg(['-i', final, '-f', 'null', '-']);
  for (let index = 0; index < MOTION_SCENES.length; index += 1) {
    ffmpeg(['-ss', String(index * 3 + 1.8), '-i', final, '-frames:v', '1', path.join(work, `${MOTION_SCENES[index]}.png`)]);
  }
  fs.writeFileSync(path.join(work, 'metadata.json'), JSON.stringify(metadata, null, 2));
  console.log(`Motion demo evidence: ${work}`);
});
