const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { addTakes } = require('../scripts/project/takes');
const {
  formatTakesMarkdown,
  groupIntoPhrases,
  packTakes,
} = require('../scripts/project/takes-pack');
const { createOrOpenProject } = require('../scripts/project/workspace');

test('words group into phrases on pauses of at least the threshold', () => {
  assert.deepEqual(groupIntoPhrases([
    { w: 'Привет', s: 0.5, e: 0.9 },
    { w: 'мир', s: 1.0, e: 1.25 },
    { w: ',', s: 1.25, e: 1.3 },
    { w: 'это', s: 1.8, e: 2.0 },
    { w: 'дубль', s: 2.1, e: 2.4 },
  ], 0.5), [
    { start: 0.5, end: 1.3, text: 'Привет мир,' },
    { start: 1.8, end: 2.4, text: 'это дубль' },
  ]);
  assert.equal(groupIntoPhrases([
    { w: 'раз', s: 0, e: 0.5 },
    { w: 'два', s: 0.99, e: 1.2 },
  ], 0.5).length, 1);
});

test('packed markdown lists every take with fixed-width time ranges', () => {
  assert.equal(formatTakesMarkdown([{
    id: 'take-02',
    phrases: [
      { start: 0.5, end: 1.3, text: 'Привет мир,' },
      { start: 1.8, end: 2.4, text: 'это дубль' },
    ],
  }], 0.5), [
    '# Дубли проекта',
    '',
    'Фразы разделены паузами от 0.5 с. Время указано в секундах от начала файла дубля.',
    'Диапазоны для edit/vNN-takes.json записывай как take + start/end из этих строк.',
    '',
    '## take-02  (речь 1.9 с, фраз: 2)',
    '  [000.50-001.30] Привет мир,',
    '  [001.80-002.40] это дубль',
    '',
  ].join('\n'));
});

test('packTakes reads registered take transcripts from the project', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-takes-pack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'take1.mp4');
  const second = path.join(root, 'take2.mp4');
  fs.writeFileSync(first, 'ONE');
  fs.writeFileSync(second, 'TWO');
  const workspace = createOrOpenProject({ projectDir: path.join(root, 'project'), name: 'Pack', sourcePath: first });
  assert.throws(() => packTakes({ projectDir: workspace.dir }), /takes add/);
  addTakes({ projectDir: workspace.dir, files: [second] }, {
    probeVideoImpl: () => ({ width: 160, height: 90, fps: 25, duration: 3 }),
    probeMediaPathImpl: () => ({
      mediaKind: 'video', width: 160, height: 90, rotation: 0, hasAudio: true,
      audioSampleRate: 48000, audioChannels: 2, videoDurationSec: 3, audioDurationSec: 3,
    }),
    transcribeImpl: () => [{ start: 0, end: 1, text: 'слово', words: [{ w: 'слово', s: 0.2, e: 0.6 }] }],
  });
  const markdown = packTakes({ projectDir: workspace.dir, silence: 0.4 });
  assert.match(markdown, /Фразы разделены паузами от 0\.4 с/);
  assert.match(markdown, /## take-01 {2}\(речь 0\.4 с, фраз: 1\)\n {2}\[000\.20-000\.60\] слово/);
  assert.match(markdown, /## take-02 /);
  assert.throws(() => packTakes({ projectDir: workspace.dir, silence: 9 }), /silence/);
});
