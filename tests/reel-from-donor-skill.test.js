const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('reel-from-donor requires consent gates and concrete content', () => {
  const skill = read('skills/reel-from-donor/SKILL.md');
  const contract = read('skills/reel-from-donor/references/content-contract.md');
  const qa = read('skills/reel-from-donor/references/qa-checklist.md');
  const combined = `${skill}\n${contract}\n${qa}`;

  for (const required of [
    /CTA.*дизайн.*формат/iu,
    /Telegram-лайфхаков/iu,
    /сначала согласуются тексты/iu,
    /явного утверждения/iu,
    /не придумывай факты/iu,
    /готовый промпт/iu,
    /терминальн.*команд/iu,
    /анимиру.*по элементам/iu,
    /первоисточник/iu,
  ]) {
    assert.match(combined, required);
  }
});

test('reel-from-donor has three public adapters and pressure cases', () => {
  const adapterPaths = [
    '.agents/skills/reel-from-donor/SKILL.md',
    '.claude/skills/reel-from-donor/SKILL.md',
    '.codex/skills/reel-from-donor/SKILL.md',
  ];
  for (const adapterPath of adapterPaths) {
    assert.match(read(adapterPath), /skills\/reel-from-donor\/SKILL\.md/u);
  }

  const evals = JSON.parse(read('skills/reel-from-donor/evals/evals.json'));
  assert.equal(evals.skill_name, 'reel-from-donor');
  assert.equal(evals.evals.length, 3);
});
