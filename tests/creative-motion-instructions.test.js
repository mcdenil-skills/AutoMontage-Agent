const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('every montage route points new chats to the shared choice contract', () => {
  const contract = read('skills/reel-turnkey/references/creative-motion.md');
  const entrypoints = [
    read('AGENTS.md'),
    read('skills/reel-turnkey/SKILL.md'),
    read('skills/reel-from-donor/SKILL.md'),
    read('skills/motion-reel/SKILL.md'),
  ];

  for (const entrypoint of entrypoints) {
    assert.match(entrypoint, /creative-motion\.md/u);
    assert.match(entrypoint, /Как\s+монтируем/iu);
  }

  for (const route of [
    /Уникальный Creative Motion[^\n]*рекоменду/iu,
    /Готовый стиль/iu,
    /По референсу/iu,
  ]) assert.match(contract, route);

  assert.match(contract, /нативные карточки\/кнопки/iu);
  assert.match(contract, /codex-followup/iu);
  assert.match(contract, /реши сам[\s\S]{0,160}Creative Motion/iu);
});

test('creative route is autonomous, project-local, and anti-template', () => {
  const contract = read('skills/reel-turnkey/references/creative-motion.md');
  const turnkey = read('skills/reel-turnkey/SKILL.md');
  const qa = read('skills/reel-turnkey/references/qa-checklist.md');
  const combined = `${contract}\n${turnkey}\n${qa}`;

  for (const invariant of [
    /не задавай[\s\S]*шрифт[\s\S]*цвет[\s\S]*музык/iu,
    /project-local/iu,
    /глобальн.*таймкод/iu,
    /современн.*кирилли/iu,
    /не повторяй одну композицию/iu,
    /одинаков.*motion-механик.*сосед/iu,
    /пуст.*чёрн.*переход/iu,
    /реальн.*интерфейс/iu,
    /официальн.*логотип/iu,
    /скриншот.*крупно и целиком/iu,
    /узел.*соединител.*следующ.*узел/iu,
    /начале, середине и конце/iu,
  ]) assert.match(combined, invariant);

  assert.doesNotMatch(turnkey, /Не генерируй новый дизайн ролика/u);
});

test('public guidance and behavioral evals expose the new choice', () => {
  for (const file of ['README.md', 'docs/MONTAGE-GUIDE.md', 'docs/TEMPLATES.md']) {
    const document = read(file);
    assert.match(document, /Уникальный Creative Motion/iu, file);
    assert.match(document, /Готовый стиль/iu, file);
    assert.match(document, /По референсу/iu, file);
  }

  const turnkeyEvals = JSON.parse(read('skills/reel-turnkey/evals/evals.json'));
  const delegated = turnkeyEvals.evals.find(item => item.id === 9);
  assert.ok(delegated);
  assert.match(delegated.expected_output, /автоном/iu);

  const donorEvals = JSON.parse(read('skills/reel-from-donor/evals/evals.json'));
  assert.match(JSON.stringify(donorEvals), /не задаёт серию вопросов/iu);
});

test('all public adapters advertise the autonomous route chooser', () => {
  for (const prefix of ['.agents', '.claude', '.codex']) {
    for (const skill of ['reel-turnkey', 'reel-from-donor']) {
      const adapter = read(`${prefix}/skills/${skill}/SKILL.md`);
      assert.match(adapter, /Creative Motion/u);
      assert.match(adapter, /skills\/(?:reel-turnkey|reel-from-donor)\/SKILL\.md/u);
    }
  }

  const canonicalMotion = read('skills/motion-reel/SKILL.md');
  for (const prefix of ['.agents', '.codex']) {
    assert.equal(read(`${prefix}/skills/motion-reel/SKILL.md`), canonicalMotion);
  }
});
