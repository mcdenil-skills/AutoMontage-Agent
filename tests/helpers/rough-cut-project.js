// Проект для тестов черновой нарезки без настоящего видео: исходник – байты-заглушка, ffmpeg и
// ffprobe в таких тестах подменяют фейки. Транскрипт – слова 0–8 с, как makeProject в
// tests/source-edit.test.js (логика скопирована: тестовые файлы друг друга не подключают).
//
//   const { root, workspace, projectDir, writeEdit } = makeRoughCutSourceProject(t, { fps = 25 });
//   const editPath = writeEdit('roughcut-v01.json', { keep: [{ start: 0, end: 2 }] });
//
// root      – временная папка теста (удаляется в t.after), в ней camera.mp4 и project/;
// workspace – результат createOrOpenProject (manifest – паспорт на момент создания);
// writeEdit – пишет edit/<name> и возвращает путь относительно проекта ('edit/roughcut-v01.json').
//             Не заданные поля списка кусков берутся по умолчанию: version 1, sourceRevision 1,
//             fps из опции, keep 0–2 («хук») и 4–8 («объяснение»).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createOrOpenProject } = require('../../scripts/project/workspace');

function makeRoughCutSourceProject(t, { fps = 25 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-rough-cut-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, 'camera.mp4');
  fs.writeFileSync(original, 'ORIGINAL-SOURCE');
  const workspace = createOrOpenProject({
    projectDir: path.join(root, 'project'),
    name: 'Rough cut',
    sourcePath: original,
    now: new Date('2026-10-03T08:00:00.000Z'),
  });
  fs.writeFileSync(path.join(workspace.dir, 'transcript', 'words.json'), `${JSON.stringify([{
    start: 0,
    end: 8,
    text: 'один вырезать два три',
    words: [
      { w: 'один', s: 0.5, e: 0.9 },
      { w: 'вырезать', s: 2.5, e: 3.2 },
      { w: 'два', s: 4.2, e: 4.6 },
      { w: 'три', s: 7.5, e: 7.9 },
    ],
  }], null, 2)}\n`);
  fs.mkdirSync(path.join(workspace.dir, 'edit'), { recursive: true });
  function writeEdit(name, edit = {}) {
    const relative = `edit/${name}`;
    fs.writeFileSync(path.join(workspace.dir, 'edit', name), `${JSON.stringify({
      version: 1,
      sourceRevision: 1,
      fps,
      keep: [
        { start: 0, end: 2, note: 'хук' },
        { start: 4, end: 8, note: 'объяснение' },
      ],
      ...edit,
    }, null, 2)}\n`);
    return relative;
  }
  return { root, workspace, projectDir: workspace.dir, writeEdit };
}

module.exports = { makeRoughCutSourceProject };
