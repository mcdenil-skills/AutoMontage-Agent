const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { readPultCard } = require('../scripts/pult/card-file');
const { addLegacyFolder, makePultRoot } = require('./helpers/pult-projects');

test('missing pult-card.json is not an error', (t) => {
  const { projectsDir } = makePultRoot(t);
  const dir = addLegacyFolder(projectsDir, 'plain');
  assert.deepEqual(readPultCard(dir), { ok: true, card: null });
});

test('valid group and legacy variants are accepted', (t) => {
  const { projectsDir } = makePultRoot(t);
  const card = {
    version: 1,
    group: { id: 'series-agents', title: 'Серия про агентов' },
    legacy: {
      status: 'ready',
      variants: [{ label: 'Ролик 1', video: 'final/one.mp4', final: true }],
    },
  };
  const dir = addLegacyFolder(projectsDir, 'series', { card });
  assert.deepEqual(readPultCard(dir), { ok: true, card });
});

test('unknown fields, bad JSON and escaping paths are rejected', (t) => {
  const { projectsDir } = makePultRoot(t);
  const extra = addLegacyFolder(projectsDir, 'extra', { card: { version: 1, color: 'red' } });
  assert.equal(readPultCard(extra).ok, false);

  const broken = addLegacyFolder(projectsDir, 'broken');
  fs.writeFileSync(path.join(broken, 'pult-card.json'), '{ not json');
  assert.equal(readPultCard(broken).ok, false);

  const payloads = ['../other/final.mp4', '/etc/passwd', 'final/../../x.mp4', 'C:\\x.mp4'];
  payloads.forEach((video, index) => {
    const dir = addLegacyFolder(projectsDir, `escape-${index}`, {
      card: { version: 1, legacy: { status: 'ready', variants: [{ label: 'X', video }] } },
    });
    assert.equal(readPultCard(dir).ok, false, video);
  });
});

test('symlinked pult-card.json is rejected', { skip: process.platform === 'win32' }, (t) => {
  const { base, projectsDir } = makePultRoot(t);
  const outside = path.join(base, 'outside.json');
  fs.writeFileSync(outside, JSON.stringify({ version: 1 }));
  const dir = addLegacyFolder(projectsDir, 'linked');
  fs.symlinkSync(outside, path.join(dir, 'pult-card.json'));
  assert.equal(readPultCard(dir).ok, false);
});
