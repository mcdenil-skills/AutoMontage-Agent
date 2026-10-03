const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ROUGH_CUT_EDIT,
  activeRoughCut,
  assertRoughCutSettled,
  editPathForRoughCutVideo,
  removedRanges,
  roughCutPaths,
  roughCutSize,
  roughCutTimeToSource,
} = require('../scripts/project/rough-cut-model');
const {
  createOrOpenProject,
  validateProjectManifest,
} = require('../scripts/project/workspace');

const KEEP = [
  { start: 1, end: 3, note: 'хук' },
  { start: 5, end: 9, note: 'вырезан повтор' },
];

function roughCutRecord(overrides = {}) {
  return {
    editPath: 'edit/roughcut-v02.json',
    filePath: 'previews/roughcut-v02.mp4',
    sourceRevision: 1,
    sourceDuration: 66.67,
    editSha256: 'a'.repeat(64),
    sha256: 'b'.repeat(64),
    duration: 63.32,
    width: 720,
    height: 1280,
    fps: 50,
    createdAt: '2026-10-03T09:00:00.000Z',
    status: 'review',
    ...overrides,
  };
}

function makeManifest(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-rough-cut-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, 'camera.mp4');
  fs.writeFileSync(original, 'ORIGINAL-SOURCE');
  const workspace = createOrOpenProject({
    projectDir: path.join(root, 'project'),
    name: 'Rough cut',
    sourcePath: original,
    now: new Date('2026-10-03T09:00:00.000Z'),
  });
  return { workspace, manifest: JSON.parse(JSON.stringify(workspace.manifest)) };
}

test('roughCutPaths pairs the edit list with the preview copy of the same number', () => {
  assert.deepEqual(roughCutPaths('edit/roughcut-v02.json'), {
    editPath: 'edit/roughcut-v02.json',
    filePath: 'previews/roughcut-v02.mp4',
    version: 2,
  });
  assert.equal(roughCutPaths('edit/roughcut-v105.json').version, 105);
  assert.ok(ROUGH_CUT_EDIT.test('edit/roughcut-v02.json'));
});

test('roughCutPaths rejects names that are not edit/roughcut-vNN.json', () => {
  for (const bad of ['edit/v02-source.json', 'edit/roughcut-v2.json', '../edit/roughcut-v02.json']) {
    assert.throws(() => roughCutPaths(bad), /edit\/roughcut-vNN\.json/, bad);
  }
});

test('editPathForRoughCutVideo maps only rough cut copies back to their edit list', () => {
  assert.equal(editPathForRoughCutVideo('previews/roughcut-v02.mp4'), 'edit/roughcut-v02.json');
  assert.equal(editPathForRoughCutVideo('previews/roughcut-v105.mp4'), 'edit/roughcut-v105.json');
  assert.equal(editPathForRoughCutVideo('previews/v02-draft-full.mp4'), null);
});

test('roughCutTimeToSource converts a rough cut second to a source second', () => {
  assert.equal(roughCutTimeToSource(KEEP, 0), 1);
  assert.equal(roughCutTimeToSource(KEEP, 2), 3);
  assert.equal(roughCutTimeToSource(KEEP, 2.5), 5.5);
  assert.equal(roughCutTimeToSource(KEEP, 100), 9);
});

test('removedRanges lists the head, the joints and the tail with the reason of the next piece', () => {
  assert.deepEqual(removedRanges(KEEP, 10), [
    { atSec: 0, sourceStart: 0, sourceEnd: 1, removedSec: 1, note: 'хук' },
    { atSec: 2, sourceStart: 3, sourceEnd: 5, removedSec: 2, note: 'вырезан повтор' },
    { atSec: 6, sourceStart: 9, sourceEnd: 10, removedSec: 1, note: null },
  ]);
});

test('removedRanges gives null note to a piece without one and skips an uncut head', () => {
  const noNotes = removedRanges([{ start: 1, end: 3 }], 3);
  assert.deepEqual(noNotes, [{ atSec: 0, sourceStart: 0, sourceEnd: 1, removedSec: 1, note: null }]);
  const uncutHead = removedRanges([{ start: 0, end: 4 }, { start: 5, end: 9 }], 9);
  assert.equal(uncutHead.length, 1);
  assert.deepEqual(uncutHead[0], { atSec: 4, sourceStart: 4, sourceEnd: 5, removedSec: 1, note: null });
  const keepFirst = removedRanges([{ start: 0, end: 9, note: 'всё' }], 9);
  assert.deepEqual(keepFirst, []);
});

test('removedRanges rounds seconds to milliseconds and drops sub-millisecond cuts', () => {
  const rounded = removedRanges([{ start: 0, end: 0.6666666667 }, { start: 1, end: 2 }], 2);
  assert.equal(rounded.length, 1);
  assert.equal(rounded[0].atSec, 0.667);
  assert.equal(rounded[0].sourceStart, 0.667);
  assert.equal(rounded[0].sourceEnd, 1);
  assert.equal(rounded[0].removedSec, 0.333);
  const tiny = removedRanges([{ start: 0.0005, end: 2 }], 2.0005);
  assert.deepEqual(tiny, []);
});

test('removedRanges with fps drops a removed range shorter than one frame', () => {
  // Контейнер длиннее последнего кадра: список, оставленный до последнего кадра, хвоста не режет.
  const keep = [{ start: 0, end: 2 }, { start: 4, end: 66.68 }];
  assert.deepEqual(removedRanges(keep, 66.687, { fps: 50 }), [
    { atSec: 2, sourceStart: 2, sourceEnd: 4, removedSec: 2, note: null },
  ]);
  // Без fps – прежнее правило миллисекунды: хвост 0,007 с остаётся.
  const withoutFps = removedRanges(keep, 66.687);
  assert.equal(withoutFps.length, 2);
  assert.deepEqual(withoutFps[1], { atSec: 64.68, sourceStart: 66.68, sourceEnd: 66.687, removedSec: 0.007, note: null });
  // Ровно один кадр – настоящий вырез.
  assert.deepEqual(removedRanges([{ start: 0, end: 1 }, { start: 1.02, end: 2 }], 2, { fps: 50 }), [
    { atSec: 1, sourceStart: 1, sourceEnd: 1.02, removedSec: 0.02, note: null },
  ]);
});

test('roughCutSize keeps the short side at 720, never upscales and keeps sides even', () => {
  assert.deepEqual(roughCutSize({ width: 1080, height: 1920 }), { width: 720, height: 1280 });
  assert.deepEqual(roughCutSize({ width: 1920, height: 1080 }), { width: 1280, height: 720 });
  assert.deepEqual(roughCutSize({ width: 540, height: 960 }), { width: 540, height: 960 });
  assert.deepEqual(roughCutSize({ width: 1080, height: 1350 }), { width: 720, height: 900 });
});

test('activeRoughCut is the stored record only while it belongs to the active source revision', () => {
  assert.equal(activeRoughCut({ source: { revision: 2 }, roughCut: { sourceRevision: 1 } }), null);
  const record = { sourceRevision: 1 };
  assert.equal(activeRoughCut({ source: {}, roughCut: record }), record);
  assert.equal(activeRoughCut({ source: { revision: 2 }, roughCut: { sourceRevision: 2 } })?.sourceRevision, 2);
  assert.equal(activeRoughCut({ source: { revision: 1 } }), null);
  assert.equal(activeRoughCut({ source: { revision: 1 }, roughCut: null }), null);
});

test('manifest accepts a review rough cut, no field and roughCut null', (t) => {
  const { workspace, manifest } = makeManifest(t);
  assert.doesNotThrow(() => validateProjectManifest(manifest, { projectDir: workspace.dir }));
  manifest.roughCut = null;
  assert.doesNotThrow(() => validateProjectManifest(manifest, { projectDir: workspace.dir }));
  manifest.roughCut = roughCutRecord();
  // Копии на диске ещё может не быть: манифест всё равно читается.
  assert.doesNotThrow(() => validateProjectManifest(manifest, { projectDir: workspace.dir }));
  assert.doesNotThrow(() => validateProjectManifest(manifest));
});

test('manifest accepts a confirmed rough cut with who and when', (t) => {
  const { workspace, manifest } = makeManifest(t);
  for (const confirmedBy of ['pult', 'chat']) {
    manifest.roughCut = roughCutRecord({
      status: 'confirmed',
      confirmedAt: '2026-10-03T09:05:00.000Z',
      confirmedBy,
    });
    assert.doesNotThrow(() => validateProjectManifest(manifest, { projectDir: workspace.dir }));
  }
});

test('manifest rejects a confirmed rough cut without confirmedAt or confirmedBy', (t) => {
  const { workspace, manifest } = makeManifest(t);
  manifest.roughCut = roughCutRecord({ status: 'confirmed', confirmedBy: 'pult' });
  assert.throws(() => validateProjectManifest(manifest, { projectDir: workspace.dir }), /confirmedAt/);
  manifest.roughCut = roughCutRecord({ status: 'confirmed', confirmedAt: '2026-10-03T09:05:00.000Z' });
  assert.throws(() => validateProjectManifest(manifest, { projectDir: workspace.dir }), /confirmedBy/);
});

test('manifest rejects confirmedAt or confirmedBy on a review rough cut', (t) => {
  const { workspace, manifest } = makeManifest(t);
  manifest.roughCut = roughCutRecord({ confirmedAt: '2026-10-03T09:05:00.000Z' });
  assert.throws(() => validateProjectManifest(manifest, { projectDir: workspace.dir }), /confirmedAt/);
  manifest.roughCut = roughCutRecord({ confirmedBy: 'chat' });
  assert.throws(() => validateProjectManifest(manifest, { projectDir: workspace.dir }), /confirmedBy/);
});

test('manifest rejects a copy path that does not match the edit list number', (t) => {
  const { workspace, manifest } = makeManifest(t);
  manifest.roughCut = roughCutRecord({ filePath: 'previews/roughcut-v03.mp4' });
  assert.throws(() => validateProjectManifest(manifest, { projectDir: workspace.dir }), /roughcut-v02/);
  // Проверка пары – до проверки путей: работает и без каталога проекта.
  assert.throws(() => validateProjectManifest(manifest), /roughcut-v02/);
});

test('manifest rejects traversal and foreign names in rough cut paths', (t) => {
  const { workspace, manifest } = makeManifest(t);
  manifest.roughCut = roughCutRecord({ editPath: '../x.json' });
  assert.throws(() => validateProjectManifest(manifest, { projectDir: workspace.dir }));
  manifest.roughCut = roughCutRecord({ editPath: 'edit/v02-source.json' });
  assert.throws(() => validateProjectManifest(manifest, { projectDir: workspace.dir }), /roughcut-vNN/);
});

test('manifest rejects a rough cut copy that escapes the project through a symbolic link', (t) => {
  const { workspace, manifest } = makeManifest(t);
  const outside = path.join(path.dirname(workspace.dir), 'outside.mp4');
  fs.writeFileSync(outside, 'outside');
  fs.mkdirSync(path.join(workspace.dir, 'previews'), { recursive: true });
  fs.symlinkSync(outside, path.join(workspace.dir, 'previews', 'roughcut-v02.mp4'));
  manifest.roughCut = roughCutRecord();
  assert.throws(
    () => validateProjectManifest(manifest, { projectDir: workspace.dir }),
    /roughCut\.filePath.*symbolic link/i,
  );
});

test('manifest rejects unknown rough cut fields, bad hashes and bad status', (t) => {
  const { workspace, manifest } = makeManifest(t);
  const mutations = [
    { extra: true },
    { sha256: 'xyz' },
    { editSha256: 'A'.repeat(64) },
    { status: 'draft' },
    { sourceRevision: 0 },
    { duration: 0 },
    { sourceDuration: 0 },
    { fps: 0 },
    { width: 0 },
    { height: 1.5 },
  ];
  for (const mutation of mutations) {
    manifest.roughCut = roughCutRecord(mutation);
    assert.throws(
      () => validateProjectManifest(manifest, { projectDir: workspace.dir }),
      undefined,
      JSON.stringify(mutation),
    );
  }
  manifest.roughCut = roughCutRecord({
    status: 'confirmed',
    confirmedAt: '2026-10-03T09:05:00.000Z',
    confirmedBy: 'agent',
  });
  assert.throws(() => validateProjectManifest(manifest, { projectDir: workspace.dir }));
});

function settledManifest(overrides) {
  return {
    source: { revision: 1 },
    roughCut: roughCutRecord(overrides),
  };
}

test('assertRoughCutSettled is silent when no rough cut is active', () => {
  for (const action of ['master', 'layer new']) {
    assert.doesNotThrow(() => assertRoughCutSettled({ source: { revision: 1 } }, action, { projectDir: '/p' }));
    assert.doesNotThrow(() => assertRoughCutSettled(
      { source: { revision: 2 }, roughCut: roughCutRecord() },
      action,
      { projectDir: '/p' },
    ));
  }
});

test('assertRoughCutSettled blocks every action while the author has not confirmed', () => {
  for (const action of ['master', 'layer new']) {
    assert.throws(
      () => assertRoughCutSettled(settledManifest(), action, { projectDir: '/p' }),
      (error) => {
        assert.equal(error.code, 'ROUGH_CUT_PENDING');
        assert.equal(error.message, 'черновая нарезка previews/roughcut-v02.mp4 ждёт автора: подтверждает только автор – кнопкой «Нарезка готова» в пульте или явными словами в чате. Сам не подтверждай.');
        return true;
      },
    );
  }
});

test('assertRoughCutSettled lets master run but stops layer new after confirmation', () => {
  const confirmed = settledManifest({
    status: 'confirmed',
    confirmedAt: '2026-10-03T09:05:00.000Z',
    confirmedBy: 'pult',
  });
  assert.doesNotThrow(() => assertRoughCutSettled(confirmed, 'master', { projectDir: '/p' }));
  assert.throws(
    () => assertRoughCutSettled(confirmed, 'layer new', { projectDir: '/work/my project' }),
    (error) => {
      assert.equal(error.code, 'ROUGH_CUT_PENDING');
      assert.equal(error.message, 'нарезка подтверждена, но master по ней ещё не собран: automontage master --project-dir "/work/my project" --edit edit/roughcut-v02.json (или ваш список с правками автора к этой нарезке)');
      return true;
    },
  );
});

test('assertRoughCutSettled rejects an unknown action so a typo cannot skip the guard', () => {
  const manifests = [{ source: { revision: 1 } }, settledManifest()];
  for (const action of ['layer-new', 'Master', 'roughcut', '', undefined]) {
    for (const manifest of manifests) {
      assert.throws(
        () => assertRoughCutSettled(manifest, action, { projectDir: '/p' }),
        (error) => {
          assert.equal(error.code, undefined);
          assert.match(error.message, /неизвестное действие/);
          return true;
        },
      );
    }
  }
});
