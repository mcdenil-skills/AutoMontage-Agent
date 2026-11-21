const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { playbackForOffer } = require('../scripts/pult/offer-playback');
const { readProjectManifest } = require('../scripts/project/workspace');
const { makePultRoot, addRoughCutProject } = require('./helpers/pult-projects');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function setup(t) {
  const { projectsDir } = makePultRoot(t);
  const { projectDir } = addRoughCutProject(projectsDir, { folder: 'clip', sourceDuration: 12,
    keep: [{ start: 0, end: 2 }, { start: 5, end: 12 }] });
  const manifest = readProjectManifest(projectDir);
  const transcript = path.join(projectDir, manifest.transcript.words);
  fs.writeFileSync(transcript, JSON.stringify([{ words: [{ w: 'обещание', s: 8, e: 9 }] }]));
  const offer = { startSec: 8, endSec: 9,
    source: { kind: 'transcript', path: manifest.transcript.words, sha256: hash(fs.readFileSync(transcript)) } };
  return { projectDir, manifest, offer, entry: { video: { kind: 'roughcut', path: manifest.roughCut.filePath } },
    video: { kind: 'roughcut', url: '/media/video?key=clip&v=public-version' } };
}
test('rough-cut playback maps the entire verified offer and never changes stored source time', (t) => {
  const args = setup(t);
  assert.deepEqual(playbackForOffer(args), { videoUrl: args.video.url, startSec: 5, endSec: 6, unavailableReason: null });
  assert.equal(args.offer.startSec, 8);
});
for (const issue of ['removed', 'partial', 'edit bytes', 'video bytes', 'transcript hash', 'transcript path', 'revision', 'missing edit', 'outside symlink']) {
  test(`rough-cut playback is unavailable for ${issue}`, (t) => {
    const args = setup(t);
    const cut = args.manifest.roughCut;
    if (issue === 'removed') Object.assign(args.offer, { startSec: 3, endSec: 4 });
    if (issue === 'partial') Object.assign(args.offer, { startSec: 1, endSec: 6 });
    if (issue === 'edit bytes') fs.appendFileSync(path.join(args.projectDir, cut.editPath), '\n');
    if (issue === 'video bytes') fs.appendFileSync(path.join(args.projectDir, cut.filePath), 'CHANGED');
    if (issue === 'transcript hash') args.offer.source.sha256 = '0'.repeat(64);
    if (issue === 'transcript path') args.offer.source.path = 'transcript/other.json';
    if (issue === 'revision') args.entry.video.path = 'previews/roughcut-v99.mp4';
    if (issue === 'missing edit' || issue === 'outside symlink') fs.unlinkSync(path.join(args.projectDir, cut.editPath));
    if (issue === 'outside symlink') {
      const sentinel = path.join(path.dirname(args.projectDir), 'sentinel.json');
      fs.writeFileSync(sentinel, 'FOREIGN');
      fs.symlinkSync(sentinel, path.join(args.projectDir, cut.editPath));
      args.sentinel = sentinel;
    }
    const result = playbackForOffer(args);
    if (args.sentinel) assert.equal(fs.readFileSync(args.sentinel, 'utf8'), 'FOREIGN');
    assert.equal(result.videoUrl, null);
    assert.equal(result.startSec, null);
    assert.ok(result.unavailableReason);
    assert.equal(JSON.stringify(result).includes(args.projectDir), false);
  });
}
for (const kind of ['preview', 'final', 'legacy']) test(`playback leaves ${kind} time unchanged`, (t) => {
  const args = setup(t); args.entry.video.kind = kind; args.video.kind = kind;
  assert.deepEqual(playbackForOffer(args), { videoUrl: args.video.url, startSec: 8, endSec: 9, unavailableReason: null });
});
test('script without times and missing player cannot seek', (t) => {
  const args = setup(t); args.offer.startSec = null; args.offer.endSec = null;
  assert.equal(playbackForOffer(args).startSec, null);
  args.offer.startSec = 8; args.video = null;
  assert.equal(playbackForOffer(args).startSec, null);
});
