const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { readPultState, setArchived } = require('../scripts/pult/state');
const { addLegacyFolder, makePultRoot } = require('./helpers/pult-projects');

test('archive state starts empty and toggles card ids in order', (t) => {
  const { projectsDir } = makePultRoot(t);
  assert.deepEqual(readPultState(projectsDir), { version: 1, archived: [] });
  setArchived(projectsDir, 'folder:old-test', true);
  setArchived(projectsDir, 'group:agents', true);
  setArchived(projectsDir, 'folder:old-test', true);
  assert.deepEqual(readPultState(projectsDir).archived, ['folder:old-test', 'group:agents']);
  setArchived(projectsDir, 'folder:old-test', false);
  assert.deepEqual(readPultState(projectsDir).archived, ['group:agents']);
});

test('archiving never touches the video folder', (t) => {
  const { projectsDir } = makePultRoot(t);
  const dir = addLegacyFolder(projectsDir, 'old-test', { files: { 'final/x.mp4': 'x' } });
  setArchived(projectsDir, 'folder:old-test', true);
  assert.equal(fs.readFileSync(path.join(dir, 'final', 'x.mp4'), 'utf8'), 'x');
  assert.deepEqual(fs.readdirSync(projectsDir).sort(), ['.pult', 'old-test']);
});

test('invalid card ids are rejected', (t) => {
  const { projectsDir } = makePultRoot(t);
  for (const id of ['', '../x', 'folder:', `folder:${'x'.repeat(200)}`, 'folder:a/b', 'other:x']) {
    assert.throws(() => setArchived(projectsDir, id, true), /карточк/, id);
  }
});
