const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildInbox, formatInbox, main, parseInboxOptions } = require('../scripts/pult/inbox');
const { scanProjects } = require('../scripts/pult/catalog');
const { addComment } = require('../scripts/pult/comments');
const { addDraftProject, makePultRoot } = require('./helpers/pult-projects');

function withComment(t) {
  const { projectsDir } = makePultRoot(t);
  const waiting = addDraftProject(projectsDir, { folder: 'waiting', name: 'Ролик с правкой' });
  const entry = scanProjects({ projectsDir }).entries.find((item) => item.key === 'waiting');
  addComment(waiting.projectDir, { timeSec: 14.4, text: 'Текст\nзалезает на лицо', video: entry.video }, {
    id: () => 'c-0001',
    captureFrame: (videoPath, timeSec, outPath) => {
      fs.writeFileSync(outPath, 'jpg');
      return true;
    },
  });
  return { projectsDir, waiting };
}

test('an empty inbox says so', (t) => {
  const { projectsDir } = makePultRoot(t);
  addDraftProject(projectsDir, { folder: 'clip' });
  assert.equal(formatInbox(buildInbox({ projectsDir }), { projectsDir }), 'Во входящих пульта пусто.');
});

test('the inbox lists edits with time and frame, and approved videos without a final', (t) => {
  const { projectsDir } = withComment(t);
  addDraftProject(projectsDir, { folder: 'approved', name: 'Утверждённый', approve: true });
  const text = formatInbox(buildInbox({ projectsDir }), { projectsDir, cwd: path.dirname(projectsDir) });
  assert.match(text, /## Ролик с правкой — `projects\/waiting`/);
  assert.match(text, /- Правка `c-0001` на 0:14: «Текст залезает на лицо»\. Видео: `previews\//);
  assert.match(text, /Кадр: `projects\/waiting\/pult\/frames\/c-0001\.jpg`/);
  assert.match(text, /## Утверждённый — `projects\/approved`/);
  assert.match(text, /- Утверждено: `brief\/v\d{2}-approved\.lesson\.json`\. Собери финал и проведи полный QA\./);
  assert.match(text, /automontage inbox --accept <папка> <id>/);
});

test('edits to an older video are marked', (t) => {
  const { projectsDir, waiting } = withComment(t);
  const file = path.join(waiting.projectDir, 'pult', 'comments.json');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  value.comments[0].video.sha256 = 'f'.repeat(64);
  fs.writeFileSync(file, JSON.stringify(value));
  const text = formatInbox(buildInbox({ projectsDir }), { projectsDir, cwd: path.dirname(projectsDir) });
  assert.match(text, /на 0:14 \(к прежней версии видео\)/);
});

test('accepting an edit removes it from the inbox', (t) => {
  const { projectsDir } = withComment(t);
  const output = [];
  const code = main(['--projects-dir', projectsDir, '--accept', 'waiting', 'c-0001'], { write: (line) => output.push(line) });
  assert.equal(code, 0);
  assert.match(output.join('\n'), /c-0001/);
  assert.deepEqual(buildInbox({ projectsDir }), []);
});

test('options reject unsafe folders and ids', () => {
  assert.throws(() => parseInboxOptions(['--accept', '../x', 'c-1']), /папк/);
  assert.throws(() => parseInboxOptions(['--accept', 'clip', '../c']), /правк/);
  assert.throws(() => parseInboxOptions(['--bogus']), /опци/);
  assert.equal(parseInboxOptions(['--projects-dir', 'x']).projectsDir, path.resolve('x'));
});

test('a corrupted comments.json is reported instead of silently dropped', (t) => {
  const { projectsDir } = withComment(t);
  const broken = addDraftProject(projectsDir, { folder: 'broken', name: 'Сломанный' });
  fs.mkdirSync(path.join(broken.projectDir, 'pult'), { recursive: true });
  fs.writeFileSync(path.join(broken.projectDir, 'pult', 'comments.json'), '{ broken');
  const text = formatInbox(buildInbox({ projectsDir }), { projectsDir, cwd: path.dirname(projectsDir) });
  assert.match(text, /## Сломанный — `projects\/broken`/);
  assert.match(
    text,
    /- Файл правок повреждён: `projects\/broken\/pult\/comments\.json`\. Проверь его и попроси автора повторить правки в пульте\./,
  );
  // Остальная часть входящих не должна пострадать из-за одной сломанной папки.
  assert.match(text, /## Ролик с правкой — `projects\/waiting`/);
  assert.match(text, /- Правка `c-0001` на 0:14/);
});
