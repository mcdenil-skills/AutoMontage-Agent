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
