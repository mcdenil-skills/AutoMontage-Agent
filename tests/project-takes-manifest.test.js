const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createOrOpenProject,
  validateProjectManifest,
} = require('../scripts/project/workspace');

test('manifest accepts registered takes and rejects duplicates, bad ids and escaping paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-takes-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'take1.mp4');
  fs.writeFileSync(source, 'TAKE');
  const workspace = createOrOpenProject({
    projectDir: path.join(root, 'project'),
    name: 'Takes manifest',
    sourcePath: source,
    now: new Date('2026-09-25T10:00:00.000Z'),
  });
  const take = (overrides = {}) => ({
    id: 'take-01',
    originalPath: source,
    localPath: 'input/source.mp4',
    transcriptPath: 'transcript/takes/take-01.json',
    ...overrides,
  });
  const withTakes = (takes) => ({ ...structuredClone(workspace.manifest), takes });
  const options = { projectDir: workspace.dir };

  assert.deepEqual(validateProjectManifest(withTakes([
    take(),
    take({ id: 'take-02', localPath: 'input/takes/take-02.mov', transcriptPath: 'transcript/takes/take-02.json' }),
  ]), options).takes.map((item) => item.id), ['take-01', 'take-02']);
  assert.throws(() => validateProjectManifest(withTakes([take(), take()]), options), /unique/);
  assert.throws(() => validateProjectManifest(withTakes([take({ id: 'take-1' })]), options), /takes\/0\/id/);
  assert.throws(
    () => validateProjectManifest(withTakes([take({ localPath: '../escape.mp4' })]), options),
    /canonical relative path/,
  );
  assert.throws(
    () => validateProjectManifest(withTakes([take({ extra: true })]), options),
    /additional properties/,
  );
});
