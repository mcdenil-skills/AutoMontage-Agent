const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
// Фраза из документа с любыми переносами строк и отступами между словами.
const words = phrase => new RegExp(phrase.split(' ').map(w => w.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('\\s+'), 'u');
const section = (text, heading) => text.split(heading)[1]?.split('\n## ')[0];

const ROUGH_CUT = 'skills/reel-turnkey/references/rough-cut.md';
const THREE_POINTS = 'Обязательные пользовательские точки – три: один выбор маршрута в начале, '
  + 'подтверждение черновой нарезки (для записи с речью; «режь сам» его снимает) и явное '
  + 'утверждение просмотренного preview перед final.';
const MASTER_FROM_ROUGH_CUT = 'Перед `layer new` всегда соберите master из подтверждённой черновой нарезки';
const NO_TIMINGS = 'Таймингов ещё нет – слой не создаём';
const PAUSE_ADVICE = 'оговорились – помолчите около 2 секунд и повторите фразу целиком';

test('agent rules and the autonomy contract name three author points', () => {
  for (const file of ['AGENTS.md', 'skills/reel-turnkey/references/creative-motion.md']) {
    const text = read(file);
    assert.match(text, words(THREE_POINTS), file);
    // Прежнее правило про две точки позволяло собрать слой, не показав автору нарезку.
    assert.doesNotMatch(text, /точки остаются две/u, file);
  }
  const contract = section(read('skills/reel-turnkey/references/creative-motion.md'), '## Контракт автономности');
  assert.ok(contract, 'creative-motion.md: нет раздела «Контракт автономности»');
  assert.match(contract, words(THREE_POINTS));
  assert.match(contract, /rough-cut\.md/u);
});

test('AGENTS.md pult rules: confirmed rough cut, no confirm API, chat confirm only on author words', () => {
  const agents = read('AGENTS.md');
  const pult = section(agents, '## Пульт роликов');
  assert.ok(pult, 'AGENTS.md: нет раздела «Пульт роликов»');
  assert.match(pult, words('Строка «Нарезка подтверждена» в `automontage inbox` означает'));
  assert.match(pult, words('внеси правки к ней, собери master и переходи к слою'));
  assert.match(pult, words('никогда не вызывай `/api/roughcut/confirm`'));
  assert.match(pult, words('`automontage roughcut confirm` – только по явным словам автора в чате'));
  assert.match(pult, words('`edit/roughcut-vNN.json` после подтверждения не меняй: скопируй его в `edit/vNN-source.json`'));
  assert.match(pult, words('по секундам исходника из `automontage inbox`'));
  assert.match(pult, words('«режь сам» после показа нарезки – тоже явное подтверждение'));
  // Правки к нарезке не выполняются новым preview: до подтверждения – новая нарезка.
  assert.match(pult, words('правки к черновой нарезке – по правилам ниже'));

  const commands = section(agents, '## Команды');
  assert.ok(commands, 'AGENTS.md: нет раздела «Команды»');
  assert.match(commands, /automontage roughcut /u);
  assert.match(commands, /automontage roughcut confirm/u);
});

test('motion-layer kit blocks start only from the confirmed rough cut', () => {
  for (const file of ['skills/reel-turnkey/SKILL.md', 'skills/reel-from-donor/SKILL.md', 'skills/motion-reel/SKILL.md']) {
    const block = section(read(file), '## Motion-слой из kit');
    assert.ok(block, `${file}: нет блока «Motion-слой из kit»`);
    assert.match(block, words(MASTER_FROM_ROUGH_CUT), file);
    assert.ok(block.includes(NO_TIMINGS), `${file}: ${NO_TIMINGS}`);
    assert.match(block, /rough-cut\.md/u, file);
    // Старая формулировка разрешала master из любой нарезки, не показанной автору.
    assert.doesNotMatch(block, /соберите master из нарезки/u, file);
    assert.doesNotMatch(block, /\u2014/u, file);
  }
  const canonical = read('skills/motion-reel/SKILL.md');
  for (const prefix of ['.agents', '.codex']) {
    assert.equal(read(`${prefix}/skills/motion-reel/SKILL.md`), canonical, prefix);
  }

  const creative = read('skills/reel-turnkey/references/creative-motion.md');
  const pack = section(creative, '## Project-local motion pack');
  assert.match(pack, words(MASTER_FROM_ROUGH_CUT));
  assert.doesNotMatch(pack, /даже без нарезки/u);

  const brief = read('skills/reel-turnkey/references/motion-layer-brief.md');
  const input = section(brief, '## Вход');
  assert.match(input, words('Слой создаётся только после подтверждённой черновой нарезки'));

  const qa = read('skills/reel-turnkey/references/qa-checklist.md');
  assert.match(qa, words('нарезка подтверждена автором до слоя'));
});

test('reel-turnkey step 2 is the rough cut and step 3 reads words from the passport', () => {
  const turnkey = read('skills/reel-turnkey/SKILL.md');
  assert.match(turnkey, /\(references\/rough-cut\.md\)/u);
  const lines = turnkey.split('\n');
  // Контракт batch-workflow-docs проверяет «сомнительн…повтор…остав» внутри одной строки.
  assert.ok(lines.some(line => line.includes('Сомнительный повтор оставляй и назови автору – он решит на нарезке.')));

  const step2 = section(turnkey, '## Шаг 2.');
  assert.ok(step2, 'нет шага 2');
  assert.match(turnkey, /^## Шаг 2\.[^\n]*Черновая нарезка/mu);
  assert.match(step2, /scripts\/transcribe\.py/u);
  assert.match(step2, /automontage roughcut --project-dir/u);
  assert.match(step2, /Остановись/u);

  const step3 = section(turnkey, '## Шаг 3.');
  assert.ok(step3, 'нет шага 3');
  assert.doesNotMatch(step3, /scripts\/transcribe\.py/u);
  assert.match(step3, /`transcript\.words`/u);
  assert.match(step3, /project\.json/u);
});

test('rough-cut.md describes the stage, the search order, commands and the stop point', () => {
  const guide = read(ROUGH_CUT);

  // Публичный файл: без длинного тире, личных путей, имён клиентских папок и локальной памяти.
  assert.doesNotMatch(guide, /\u2014/u);
  assert.doesNotMatch(guide, /\/Users\/|\/home\//u);
  assert.doesNotMatch(guide, /projects\/20\d\d/u);
  assert.doesNotMatch(guide, /knowledge\//u);

  // Когда этап нужен и когда пропускается.
  assert.match(guide, /^## Когда этап нужен/mu);
  assert.match(guide, words('«режь сам» или «нарезку не показывай» до показа'));

  // Порядок поиска пауз и повторов (пп. 1–6 спеки).
  for (const rule of [
    'шумовой фон плюс ≈ 20 дБ',
    'vad_filter=False',
    'пауза ≥ 1,2 с',
    '0,35 с',
    '≈ 0,2 с',
    'не ближе 0,08 с к слову',
  ]) assert.ok(guide.includes(rule), rule);
  assert.match(guide, words('слово длиннее 1 с – переслушать окнами 1–1,5 с с `condition_on_previous_text=False` и посмотреть огибающую RMS'));
  assert.match(guide, words('(похоже на повтор, но не уверен) – оставь и назови автору'));
  assert.match(guide, /`note`/u);

  // Команды и точка остановки.
  assert.match(guide, /automontage roughcut --project-dir [^\n]* --edit edit\/roughcut-v01\.json/u);
  assert.match(guide, /automontage inbox/u);
  assert.match(guide, /automontage roughcut confirm --project-dir/u);
  assert.match(guide, /automontage master --project-dir [^\n]*--edit edit\/roughcut-vNN\.json/u);
  assert.match(guide, words('никогда не вызывай `/api/roughcut/confirm`'));
  assert.match(guide, words(NO_TIMINGS));

  // Правки к подтверждённой нарезке.
  assert.match(guide, words('`edit/roughcut-vNN.json` после подтверждения не меняй: скопируй его в `edit/vNN-source.json`'));
  assert.match(guide, words('затем `automontage inbox --accept'));

  // Что готовить до подтверждения.
  const prep = section(guide, '## Что готовить, пока нарезка ждёт автора');
  assert.ok(prep, 'нет раздела подготовки');
  for (const item of ['`prep/`', 'ДНК дизайна', '`scenes.jsx`', 'по фразам суфлёра', 'без секунд', '`assets/`', 'музык', 'лид-магнит']) {
    assert.ok(prep.includes(item), item);
  }
  assert.match(guide, words('план слоя – только на якорях слов, без `near`'));
  assert.match(guide, words('«Готовый стиль» до подтверждения нарезки preview не собирай'));
  assert.match(guide, /^## Ночной режим/mu);
});

test('rough-cut pointers, donor preparation and the pause advice', () => {
  for (const prefix of ['.agents', '.codex']) {
    assert.match(read(`${prefix}/${ROUGH_CUT}`), /skills\/reel-turnkey\/references\/rough-cut\.md/u, prefix);
  }

  const donor = read('skills/reel-from-donor/SKILL.md');
  assert.match(donor, /^## Подготовка до съёмки/mu);
  assert.ok(donor.indexOf('## Подготовка до съёмки') < donor.indexOf('## Шаг 4.'), 'подготовка до шага 4');
  assert.match(donor, /reel-turnkey\/references\/rough-cut\.md/u);
  assert.match(section(donor, '## Подготовка до съёмки'), words(PAUSE_ADVICE));

  assert.match(read('docs/reels-guide/03-source-video.md'), words(PAUSE_ADVICE));
});

test('user documents show the rough cut command and the confirm button', () => {
  for (const file of ['README.md', 'docs/PULT.md']) {
    const text = read(file);
    assert.match(text, /automontage roughcut/u, file);
    assert.match(text, /Нарезка готова/u, file);
  }
  for (const file of ['docs/MONTAGE-GUIDE.md', 'docs/reels-guide/README.md', 'docs/reels-guide/04-montage.md']) {
    const text = read(file);
    assert.match(text, /черновую нарезку|черновая нарезка/iu, file);
    assert.match(text, /Нарезка готова/u, file);
  }
  // Клик по строке выреза только ставит видео, звук автор включает сам.
  assert.doesNotMatch(read('docs/PULT.md'), /вы услышите склейку/u);

  const decisions = read('DECISIONS.md');
  assert.match(decisions, /^## D-046 – Черновая нарезка до слоя/mu);
  const changelog = read('CHANGELOG.md');
  const unreleased = changelog.split('## [Unreleased]')[1].split('\n## [')[0];
  assert.match(unreleased, /^### Добавлено/mu);
  assert.match(unreleased, /automontage roughcut/u);
});
