const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ENTRY_KEY, scanProjects } = require('../scripts/pult/catalog');
const { addComment } = require('../scripts/pult/comments');
const { addDraftProject, addLegacyFolder, makePultRoot } = require('./helpers/pult-projects');

function seriesCard() {
  return {
    version: 1,
    title: 'Серия',
    legacy: {
      status: 'ready',
      variants: [
        { label: 'Ролик 1', video: 'out/one.mp4', final: true },
        { label: 'Ролик 2', video: 'out/two.mp4', final: true },
      ],
    },
  };
}

test('scan classifies standard, legacy, unregistered and broken folders', (t) => {
  const { projectsDir } = makePultRoot(t);
  addDraftProject(projectsDir, { folder: 'waiting-clip', name: 'Ждёт меня' });
  addDraftProject(projectsDir, { folder: 'ready-clip', name: 'Готовый', approve: true, final: true });
  addLegacyFolder(projectsDir, 'series', { files: { 'out/one.mp4': '1', 'out/two.mp4': '2' }, card: seriesCard() });
  addLegacyFolder(projectsDir, 'research', { files: { 'notes.md': '# notes' } });
  addLegacyFolder(projectsDir, 'broken', { files: { 'project.json': '{ "version": 1 }' } });
  addLegacyFolder(projectsDir, '.pult', { files: { 'state.json': '{}' } });

  const scan = scanProjects({ projectsDir });
  const byKey = Object.fromEntries(scan.entries.map((entry) => [entry.key, entry]));
  assert.deepEqual(Object.keys(byKey).sort(), ['ready-clip', 'series#0', 'series#1', 'waiting-clip']);
  assert.equal(byKey['waiting-clip'].status, 'waiting');
  assert.equal(byKey['waiting-clip'].approvable, true);
  assert.equal(byKey['waiting-clip'].title, 'Ждёт меня');
  assert.equal(byKey['waiting-clip'].variantLabel, 'Основной');
  assert.equal(byKey['ready-clip'].status, 'ready');
  assert.equal(byKey['ready-clip'].video.kind, 'final');
  assert.equal(byKey['series#1'].variantLabel, 'Ролик 2');
  assert.equal(byKey['series#1'].video.path, 'out/two.mp4');
  assert.equal(byKey['series#1'].status, 'ready');
  assert.deepEqual(scan.unregistered.map((item) => item.folder), ['research']);
  assert.deepEqual(scan.broken.map((item) => item.folder), ['broken']);
});

test('history lists complete renders newest first without raw files', (t) => {
  const { projectsDir } = makePultRoot(t);
  addDraftProject(projectsDir, { folder: 'ready-clip', approve: true, final: true });
  const entry = scanProjects({ projectsDir }).entries[0];
  assert.deepEqual(entry.history, [{ label: 'Рендер v01 — final', path: 'renders/v01-final/final.mp4' }]);
});

test('pending comments move a waiting video back to the agent', (t) => {
  const { projectsDir } = makePultRoot(t);
  const { projectDir } = addDraftProject(projectsDir, { folder: 'clip' });
  const entry = scanProjects({ projectsDir }).entries[0];
  addComment(projectDir, { timeSec: 1, text: 'Правка', video: entry.video }, { captureFrame: () => false });
  const after = scanProjects({ projectsDir }).entries[0];
  assert.equal(after.status, 'working');
  assert.equal(after.pendingComments, 1);
  assert.equal(after.nextStep, 'Ждёт агента: 1 правка');
});

test('legacy comments only affect their own variant', (t) => {
  const { projectsDir } = makePultRoot(t);
  const dir = addLegacyFolder(projectsDir, 'series', { files: { 'out/one.mp4': '1', 'out/two.mp4': '2' }, card: seriesCard() });
  const first = scanProjects({ projectsDir }).entries.find((entry) => entry.key === 'series#0');
  addComment(dir, { timeSec: 1, text: 'Правка', video: first.video }, { captureFrame: () => false });
  const statuses = Object.fromEntries(scanProjects({ projectsDir }).entries.map((entry) => [entry.key, entry.status]));
  assert.deepEqual(statuses, { 'series#0': 'working', 'series#1': 'ready' });
});

test('group and variant labels come from pult-card.json', (t) => {
  const { projectsDir } = makePultRoot(t);
  addDraftProject(projectsDir, {
    folder: 'hook-1',
    card: { version: 1, group: { id: 'value-thing', title: 'Самая ценная вещь' }, variantLabel: 'Хук 1' },
  });
  const entry = scanProjects({ projectsDir }).entries[0];
  assert.deepEqual(entry.group, { id: 'value-thing', title: 'Самая ценная вещь' });
  assert.equal(entry.variantLabel, 'Хук 1');
});

test('symlinked folders are ignored and a missing projects dir is empty', { skip: process.platform === 'win32' }, (t) => {
  const { base, projectsDir } = makePultRoot(t);
  const outside = path.join(base, 'outside');
  addLegacyFolder(base, 'outside', { files: { 'notes.md': 'x' } });
  fs.symlinkSync(outside, path.join(projectsDir, 'linked'), 'dir');
  const scan = scanProjects({ projectsDir });
  assert.deepEqual([scan.entries, scan.unregistered, scan.broken], [[], [], []]);
  assert.deepEqual(scanProjects({ projectsDir: path.join(base, 'missing') }), { entries: [], unregistered: [], broken: [] });
});

// Реальные legacy-папки на macOS часто хранят имя в NFD (й/ё разложены на буква + акцент)
// и содержат скобки/плюс — символьный allow-list их отклонял бы, а deny-list SAFE_NAME
// пропускает. Ключ карточки обязан пройти ENTRY_KEY, иначе ролик нельзя будет ни открыть,
// ни прокомментировать через API.
test('legacy folder names with NFD Cyrillic and punctuation stay addressable', (t) => {
  const { projectsDir } = makePultRoot(t);
  const folder = 'Мой ролик (часть 2) + бонус'.normalize('NFD');
  addLegacyFolder(projectsDir, folder, {
    files: { 'out/one.mp4': '1' },
    card: {
      version: 1,
      legacy: {
        status: 'ready',
        variants: [{ label: 'Ролик', video: 'out/one.mp4', final: true }],
      },
    },
  });
  const scan = scanProjects({ projectsDir });
  assert.equal(scan.entries.length, 1);
  const [entry] = scan.entries;
  assert.equal(entry.key, `${folder}#0`);
  assert.match(entry.key, ENTRY_KEY);
});
