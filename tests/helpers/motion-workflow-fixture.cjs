const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createOrOpenProject, publishBriefRevision } = require('../../scripts/project/workspace');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-workflow-'));
  fs.mkdirSync(path.join(root, 'public'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const narrationPath = path.join(root, 'voice.wav');
  fs.writeFileSync(narrationPath, 'narration');
  const workspace = createOrOpenProject({ projectDir: path.join(root, 'project'), name: 'Motion', sourcePath: narrationPath, projectKind: 'motion-reel', mediaKind: 'audio' });
  const brief = { version: 1, kind: 'motion-reel', status: 'draft', source: workspace.manifest.source.localPath, theme: 'motion-neutral', title: 'Тема', output: { aspect: 'vertical', width: 320, height: 568, fps: 30, durationInFrames: 60 }, scenes: [{ scene: 'kinetic-title', start: 0, end: 2, text: 'Точный текст' }] };
  fs.writeFileSync(path.join(workspace.dir, 'transcript/words.json'), JSON.stringify([{ start: 0, end: 2, text: 'Точный текст', words: [{ w: 'Точный', s: 0, e: 1 }, { w: 'текст', s: 1, e: 2 }] }]));
  const published = publishBriefRevision(workspace, { brief, kind: 'motion-reel' });
  return { root, workspace, brief, published, narrationPath };
}
function fakeMedia(calls = []) {
  return {
    probeOpenedAudioImpl() { return { mediaKind: 'audio', durationSec: 2 }; },
    runToolImpl(command, args, options) {
      calls.push({ command, args, stage: options.stage });
      if (options.stage.includes('Remotion')) {
        const props = JSON.parse(fs.readFileSync(args[args.indexOf('--props') + 1], 'utf8'));
        calls.at(-1).props = props;
        fs.writeFileSync(args[args.indexOf('MotionReel') + 1], 'rendered');
      }
    },
    runNodeToolImpl(command, args, options) {
      calls.push({ command, args, stage: options.stage });
      fs.copyFileSync(args[0], options.stage.includes('music') ? args[2] : args[1]);
    },
    resolveRemotionCommandImpl() { return { command: 'remotion', argsPrefix: [] }; },
    probeVideoImpl() { return { width: 160, height: 284, fps: 30, duration: 2 }; },
  };
}
module.exports = { fixture, sha, fakeMedia };
