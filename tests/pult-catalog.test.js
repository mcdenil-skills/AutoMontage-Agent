const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ENTRY_KEY, folderFromKey, scanFolder, scanProjects } = require('../scripts/pult/catalog');
const { addComment } = require('../scripts/pult/comments');
const { nextRenderPaths, recordRender } = require('../scripts/project/workspace');
const {
  addDraftProject, addLegacyFolder, makePultRoot, unresolvedBrollScenes,
} = require('./helpers/pult-projects');

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

test('a draft with an unresolved b-roll intent waits for the author to pick b-roll, not to approve', (t) => {
  const { projectsDir } = makePultRoot(t);
  addDraftProject(projectsDir, { folder: 'intent-clip', scenes: unresolvedBrollScenes() });
  addDraftProject(projectsDir, { folder: 'plain-clip' });
  const byKey = Object.fromEntries(scanProjects({ projectsDir }).entries.map((entry) => [entry.key, entry]));
  const intent = byKey['intent-clip'];
  assert.equal(intent.status, 'waiting');
  assert.equal(intent.nextStep, 'Выберите B-roll в проверке монтажа');
  assert.equal(intent.approvable, false);
  assert.equal(intent.video.kind, 'preview');
  assert.equal(intent.reviewable, true);
  assert.equal(byKey['plain-clip'].approvable, true);
  assert.equal(byKey['plain-clip'].nextStep, 'Посмотрите preview и утвердите');
});

test('history lists complete renders newest first without raw files', (t) => {
  const { projectsDir } = makePultRoot(t);
  addDraftProject(projectsDir, { folder: 'ready-clip', approve: true, final: true });
  const entry = scanProjects({ projectsDir }).entries[0];
  assert.deepEqual(entry.history, [{ label: 'Рендер v01 – final', path: 'renders/v01-final/final.mp4' }]);
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
// и содержат скобки/плюс – символьный allow-list их отклонял бы, а deny-list SAFE_NAME
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

// Сервер вызывает scanProjects на каждый запрос: одна нечитаемая папка не должна ронять
// весь каталог. chmod 000 на brief делает чтение brief внутри standardEntry непредсказуемо
// падающим – именно такой сбой должен превращаться в «Папка ролика не читается», а не
// в необработанное исключение.
test('scanProjects keeps other folders when one folder throws while building its entry', {
  skip: process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0),
}, (t) => {
  const { projectsDir } = makePultRoot(t);
  addDraftProject(projectsDir, { folder: 'ok-clip' });
  const { draft } = addDraftProject(projectsDir, { folder: 'broken-brief' });
  fs.chmodSync(draft.jsonPath, 0o000);
  t.after(() => {
    try {
      fs.chmodSync(draft.jsonPath, 0o644);
    } catch (_) {
      // временная папка теста уже могла быть удалена – это не ошибка.
    }
  });

  const scan = scanProjects({ projectsDir });
  assert.deepEqual(scan.entries.map((entry) => entry.key).sort(), ['ok-clip']);
  assert.deepEqual(scan.broken, [{ folder: 'broken-brief', error: 'Папка ролика не читается' }]);
});

test('scanFolder matches scanProjects for one folder and stays empty for unsafe or missing folders', (t) => {
  const { projectsDir } = makePultRoot(t);
  addDraftProject(projectsDir, { folder: 'waiting-clip', name: 'Ждёт меня' });
  addLegacyFolder(projectsDir, 'series', { files: { 'out/one.mp4': '1', 'out/two.mp4': '2' }, card: seriesCard() });

  const full = scanProjects({ projectsDir });
  const seriesEntries = full.entries.filter((entry) => entry.folder === 'series');
  assert.deepEqual(scanFolder(projectsDir, 'series'), { entries: seriesEntries, unregistered: [], broken: [] });

  const empty = { entries: [], unregistered: [], broken: [] };
  assert.deepEqual(scanFolder(projectsDir, '../x'), empty);
  assert.deepEqual(scanFolder(projectsDir, '.pult'), empty);
  assert.deepEqual(scanFolder(projectsDir, 'missing'), empty);
});

test('scanFolder ignores a symlinked folder', { skip: process.platform === 'win32' }, (t) => {
  const { base, projectsDir } = makePultRoot(t);
  const outside = path.join(base, 'outside');
  addLegacyFolder(base, 'outside', { files: { 'notes.md': 'x' } });
  fs.symlinkSync(outside, path.join(projectsDir, 'linked'), 'dir');
  assert.deepEqual(scanFolder(projectsDir, 'linked'), { entries: [], unregistered: [], broken: [] });
});

// APFS/NTFS по умолчанию не различают регистр и нормализацию Unicode при поиске файла,
// но ключ приходит от браузера – разное написание одной и той же папки не должно находить
// её и выдавать один и тот же результат под разными ключами.
test('scanFolder requires the exact on-disk spelling, not a case-insensitive match', (t) => {
  const { projectsDir } = makePultRoot(t);
  addDraftProject(projectsDir, { folder: 'Clip' });
  const empty = { entries: [], unregistered: [], broken: [] };
  assert.deepEqual(scanFolder(projectsDir, 'clip'), empty);
  assert.deepEqual(scanFolder(projectsDir, 'CLIP'), empty);
  const exact = scanFolder(projectsDir, 'Clip');
  assert.equal(exact.entries.length, 1);
  assert.equal(exact.entries[0].key, 'Clip');
});

test('scanFolder requires the exact Unicode normalization of an on-disk folder name', (t) => {
  const { projectsDir } = makePultRoot(t);
  const folder = 'Мой'.normalize('NFD');
  addLegacyFolder(projectsDir, folder, {
    files: { 'out/one.mp4': '1' },
    card: {
      version: 1,
      legacy: { status: 'ready', variants: [{ label: 'Ролик', video: 'out/one.mp4', final: true }] },
    },
  });
  assert.deepEqual(
    scanFolder(projectsDir, folder.normalize('NFC')),
    { entries: [], unregistered: [], broken: [] },
  );
  const exact = scanFolder(projectsDir, folder);
  assert.equal(exact.entries.length, 1);
  assert.equal(exact.entries[0].key, `${folder}#0`);
});

test('folderFromKey strips the trailing variant suffix', () => {
  assert.equal(folderFromKey('a#1'), 'a');
  assert.equal(folderFromKey('a'), 'a');
});

test('folderFromKey returns an empty string for non-string input', () => {
  assert.equal(folderFromKey(undefined), '');
  assert.equal(folderFromKey(null), '');
  assert.equal(folderFromKey(42), '');
});

test('a folder name containing # is reported as broken instead of scanned', (t) => {
  const { projectsDir } = makePultRoot(t);
  addLegacyFolder(projectsDir, 'series#0', { files: { 'out/one.mp4': '1' }, card: seriesCard() });
  const scan = scanProjects({ projectsDir });
  assert.deepEqual(scan.entries, []);
  assert.deepEqual(scan.broken, [{
    folder: 'series#0',
    error: 'Символ # в имени папки не поддерживается – переименуйте папку',
  }]);
});

test('render history orders files with final first, excludes raw suffixes, and labels multi-file renders', (t) => {
  const { projectsDir } = makePultRoot(t);
  const { workspace } = addDraftProject(projectsDir, { folder: 'clip', approve: true, final: true });
  const render2 = nextRenderPaths(workspace, 'final');
  fs.writeFileSync(path.join(render2.dir, 'alt.mp4'), 'alt');
  fs.writeFileSync(path.join(render2.dir, 'x.raw.mp4'), 'raw');
  fs.writeFileSync(render2.finalPath, 'final v2');
  recordRender(workspace, {
    version: render2.version,
    label: render2.label,
    dir: render2.dir,
    briefPath: null,
    status: 'complete',
  });

  const entry = scanProjects({ projectsDir }).entries[0];
  assert.deepEqual(entry.history, [
    { label: 'Рендер v02 – final (final.mp4)', path: 'renders/v02-final/final.mp4' },
    { label: 'Рендер v02 – final (alt.mp4)', path: 'renders/v02-final/alt.mp4' },
    { label: 'Рендер v01 – final', path: 'renders/v01-final/final.mp4' },
  ]);
});

test('a standard project with an invalid pult-card.json keeps its entry and is also flagged broken', (t) => {
  const { projectsDir } = makePultRoot(t);
  const { projectDir } = addDraftProject(projectsDir, { folder: 'clip' });
  fs.writeFileSync(path.join(projectDir, 'pult-card.json'), '{ not json');
  const scan = scanProjects({ projectsDir });
  assert.equal(scan.entries.length, 1);
  assert.equal(scan.entries[0].key, 'clip');
  assert.deepEqual(scan.broken, [{ folder: 'clip', error: 'pult-card.json: неверный JSON' }]);
});

test('a legacy variant with a missing video file reports a clear next step', (t) => {
  const { projectsDir } = makePultRoot(t);
  addLegacyFolder(projectsDir, 'missing-video', {
    files: {},
    card: {
      version: 1,
      legacy: { status: 'ready', variants: [{ label: 'Ролик', video: 'out/missing.mp4', final: true }] },
    },
  });
  const entry = scanProjects({ projectsDir }).entries[0];
  assert.equal(entry.video, null);
  assert.equal(entry.status, 'ready');
  assert.equal(entry.nextStep, 'Видео не найдено – проверьте pult-card.json');
});

test('a legacy card without a title falls back to the NFC-normalized folder name', (t) => {
  const { projectsDir } = makePultRoot(t);
  const folder = 'Ролик Ё'.normalize('NFD');
  addLegacyFolder(projectsDir, folder, {
    files: { 'out/one.mp4': '1' },
    card: {
      version: 1,
      legacy: { status: 'ready', variants: [{ label: 'Ролик', video: 'out/one.mp4', final: true }] },
    },
  });
  const entry = scanProjects({ projectsDir }).entries[0];
  assert.equal(entry.key, `${folder}#0`);
  assert.equal(entry.title, 'Ролик Ё'.normalize('NFC'));
  assert.notEqual(entry.title, folder);
});

test('folders sort numerically so hook-2 comes before hook-10', (t) => {
  const { projectsDir } = makePultRoot(t);
  addDraftProject(projectsDir, { folder: 'hook-10' });
  addDraftProject(projectsDir, { folder: 'hook-1' });
  addDraftProject(projectsDir, { folder: 'hook-2' });
  const scan = scanProjects({ projectsDir });
  assert.deepEqual(scan.entries.map((entry) => entry.folder), ['hook-1', 'hook-2', 'hook-10']);
});
