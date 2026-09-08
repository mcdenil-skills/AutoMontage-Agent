const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PUBLIC_TEXT_FIXTURES,
  generateNeutralFixtures,
} = require('../scripts/generate-neutral-fixtures');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-neutral-fixtures-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function read(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('tracked demo text equals one deterministic generated fixture set', (t) => {
  const first = temporaryRoot(t);
  const second = temporaryRoot(t);

  generateNeutralFixtures({ root: first });
  generateNeutralFixtures({ root: second });

  for (const relativePath of PUBLIC_TEXT_FIXTURES) {
    const expected = read(REPOSITORY_ROOT, relativePath);
    assert.equal(read(first, relativePath), expected, relativePath);
    assert.equal(read(second, relativePath), expected, relativePath);
  }
});

test('neutral fixtures fit the fourteen-second source and share exact captions', (t) => {
  const root = temporaryRoot(t);
  generateNeutralFixtures({ root });
  const transcript = JSON.parse(read(root, 'src/data/transcript.json'));
  const captionSource = read(root, 'src/data/captions.js');
  const captions = JSON.parse(captionSource.match(/export const CAPTIONS = ([\s\S]+);\n$/u)[1]);

  assert.equal(transcript.length, 1);
  assert.equal(transcript[0].start >= 0, true);
  assert.equal(transcript[0].end <= 14, true);
  assert.equal(transcript[0].words.at(-1).e, transcript[0].end);

  for (const relativePath of ['props/job1v.json', 'props/preview.json', 'props/preview_h.json']) {
    const props = JSON.parse(read(root, relativePath));
    assert.equal(props.source, 'demo-source.mp4', relativePath);
    assert.equal(props.fps, 25, relativePath);
    assert.equal(props.durationInFrames, 350, relativePath);
    assert.deepEqual(props.blocks.find((block) => block.type === 'CaptionsAuto').groups, captions);
    assert.equal(Object.hasOwn(props, 'audio'), false, relativePath);
  }
});

test('neutral fixture text contains no local path or client-specific legacy copy', () => {
  const all = PUBLIC_TEXT_FIXTURES
    .map((relativePath) => read(REPOSITORY_ROOT, relativePath))
    .join('\n');
  const slash = '/';
  const backslash = '\\\\';
  const localPath = new RegExp([
    [slash, 'Users', slash].join(''),
    [slash, 'var', slash, 'folders', slash].join(''),
    ['[A-Za-z]:', backslash, 'Users', backslash].join(''),
  ].join('|'), 'u');

  assert.doesNotMatch(all, localPath);
  assert.doesNotMatch(all, /projects\/\d{4}[.-]\d{2}[.-]\d{2}_/u);
  const namedClient = ['Ди', 'м'].join('');
  const legacyCopy = new RegExp([
    namedClient,
    'контент на вайбе',
    '100\\s?000',
    'экономи',
    'прокачай',
  ].join('|'), 'u');
  assert.doesNotMatch(all, legacyCopy);
});

test('motion fixtures generate deterministic audio and a hashed image without provider calls', () => {
  const { buildMotionDemoFixture } = require('../scripts/generate-neutral-fixtures');
  const { createHash } = require('node:crypto');
  const first = buildMotionDemoFixture();
  const second = buildMotionDemoFixture();
  assert.deepEqual(first, second);
  assert.equal(first.audioBytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(first.audioBytes.readUInt32LE(24), 24000);
  assert.equal(first.audioBytes.readUInt16LE(22), 1);
  assert.equal(first.audioBytes.readUInt32LE(40), 27 * 24000 * 2);
  assert.ok(first.audioBytes.subarray(44 + 26 * 24000 * 2).some(value => value !== 0), 'tone audio covers the last scene');
  assert.ok(first.audioBytes.subarray(44).some(value => value !== 0));
  assert.equal(first.imageBytes.toString('hex', 0, 8), '89504e470d0a1a0a');
  assert.equal(first.brief.scenes.find(scene => scene.scene === 'media').media.sha256,
    createHash('sha256').update(first.imageBytes).digest('hex'));
  assert.deepEqual(first.brief, JSON.parse(read(REPOSITORY_ROOT, 'examples/motion-brief-demo.json')));
  assert.match(first.script, /тестов.*тон/iu);
  require('../scripts/motion/source').validateCanonicalTranscript(first.transcript);
});
