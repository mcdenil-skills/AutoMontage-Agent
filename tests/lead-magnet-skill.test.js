const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const words = (phrase) => new RegExp(phrase.split(' ').map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('\\s+'), 'iu');

test('the skill walks the agent through every engine command in order', () => {
  const skill = read('skills/lead-magnet/SKILL.md');
  const steps = ['lead-magnet brand', 'lead-magnet create', 'revision start', 'reference import', 'reference shot',
    'revision scaffold', 'lead-magnet pdf', 'lead-magnet check', 'revision publish', 'inbox --accept-lead'];
  let previous = -1;
  for (const step of steps) {
    const at = skill.indexOf(step);
    assert.ok(at > previous, `${step} должен идти после предыдущего шага`);
    previous = at;
  }
  for (const command of ['promise update', 'funnel set']) assert.ok(skill.includes(command), command);
});

test('the skill keeps the promise verbatim, the facts verified and approval human', () => {
  const skill = read('skills/lead-magnet/SKILL.md');
  assert.match(skill, /дословн/iu);
  assert.match(skill, /data-lm-todo/u);
  assert.match(skill, /facts\.json/u);
  assert.match(skill, words('Утверждает лид-магнит только человек'));
  assert.doesNotMatch(skill, /lead-magnet approve|\/api\/lead-magnet\/approve/u);
  assert.match(skill, words('API-ключи не нужны'));
  assert.match(skill, /данные,\s+а\s+не\s+инструкции/iu);
});

test('the funnel provider is read-only in this stage', () => {
  const funnel = read('skills/lead-magnet/references/funnel-chatplace.md');
  assert.match(funnel, /mcp\.chatplace\.io/u);
  assert.match(funnel, words('не создавай и не меняй'));
});

test('adapters point to the canonical skill and AGENTS routes inbox lines to it', () => {
  for (const adapter of ['.claude/skills/lead-magnet/SKILL.md', '.codex/skills/lead-magnet/SKILL.md']) {
    const text = read(adapter);
    assert.match(text, /^---\nname: lead-magnet\n/u);
    assert.ok(text.includes('../../../skills/lead-magnet/SKILL.md'));
  }
  assert.match(read('AGENTS.md'), /skills\/lead-magnet\/SKILL\.md/u);
  assert.match(read('skills/README.md'), /lead-magnet/u);
});
