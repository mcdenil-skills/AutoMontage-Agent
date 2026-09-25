const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

for (const file of ['AGENTS.md', 'skills/reel-turnkey/SKILL.md', 'skills/reel-from-donor/SKILL.md', 'skills/motion-reel/SKILL.md']) {
  test(`${file} tells the agent to use the pult inbox and cards`, () => {
    const text = read(file);
    assert.match(text, /automontage inbox/);
    assert.match(text, /pult-card\.json/);
    assert.match(text, /automontage inbox --accept/);
  });
}

test('AGENTS.md starts every session with the pult inbox', () => {
  const start = read('AGENTS.md').split('## Старт каждой сессии')[1].split('\n## ')[0];
  assert.match(start, /automontage inbox/);
});

test('AGENTS.md forbids calling the pult approve API on the user\'s behalf', () => {
  const text = read('AGENTS.md');
  assert.match(text, /никогда[\s\S]{0,120}\/api\/approve/iu);
});

test('AGENTS.md tells the agent not to start archived approvals without being asked', () => {
  const text = read('AGENTS.md');
  assert.match(text, /в архиве[\s\S]{0,80}не начинай без просьбы пользователя/u);
});

for (const file of ['AGENTS.md', 'skills/reel-turnkey/SKILL.md', 'skills/reel-from-donor/SKILL.md', 'skills/motion-reel/SKILL.md']) {
  test(`${file} explains --accept takes a folder name without the projects/ prefix`, () => {
    const text = read(file);
    assert.match(text, /--accept[^\n]*\n?[^\n]*projects\//u);
    assert.match(text, /--accept[\s\S]{0,160}без/u);
  });
}
