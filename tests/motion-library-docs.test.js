const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Каталог приёмов по библиотеке Opus 5.5-анимаций (#149): структура JSON, полное покрытие 703 записей
// ровно один раз, ссылки из навыков живые, без личных путей и длинного тире.
const ROOT = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const DIR = 'skills/reel-turnkey/references';
const catalog = JSON.parse(read(`${DIR}/motion-library.json`));
const doc = read(`${DIR}/motion-library.md`);

const PORTS = new Set(['easy', 'medium', 'hard', 'needs-3d']);
const ROUTES = new Set(['reel-turnkey', 'lesson', 'motion-reel', 'ai-promo', 'lead-magnet']);
const PLACEMENTS = new Set(['over-speaker', 'fullscreen-insert', 'both']);
const FORMATS = new Set(['9:16', '16:9', 'both']);

test('motion-library: источник – MIT-библиотека с фиксированным коммитом', () => {
  assert.equal(catalog.version, 1);
  assert.equal(catalog.source.repo, 'https://github.com/yihui-dev/awesome-opus5-5-videos');
  assert.equal(catalog.source.license, 'MIT');
  assert.match(catalog.source.commit, /^[0-9a-f]{7,40}$/);
});

test('motion-library: у каждого приёма полный набор полей и допустимые значения', () => {
  const families = new Set(catalog.families.map((family) => family.id));
  assert.ok(families.size >= 8, 'семейств слишком мало');
  const ids = new Set();
  for (const item of catalog.techniques) {
    assert.match(item.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, item.id);
    assert.ok(!ids.has(item.id), `повтор id ${item.id}`);
    ids.add(item.id);
    assert.ok(families.has(item.family), `${item.id}: семейство ${item.family}`);
    for (const key of ['name_ru', 'looks_ru', 'port_notes_ru', 'adapt_ru', 'pitfalls_ru']) {
      assert.ok(typeof item[key] === 'string' && item[key].trim(), `${item.id}: ${key}`);
    }
    assert.ok(Array.isArray(item.speech_triggers_ru) && item.speech_triggers_ru.length, `${item.id}: триггеры речи`);
    assert.ok(PORTS.has(item.port), `${item.id}: port ${item.port}`);
    assert.ok(PLACEMENTS.has(item.placement), `${item.id}: placement ${item.placement}`);
    assert.ok(FORMATS.has(item.formats), `${item.id}: formats ${item.formats}`);
    assert.ok(item.routes.length && item.routes.every((route) => ROUTES.has(route)), `${item.id}: routes`);
    assert.ok(Number.isInteger(item.score) && item.score >= 1 && item.score <= 5, `${item.id}: score`);
    if (item.port === 'needs-3d') assert.ok(item.fallback_2d_ru?.trim(), `${item.id}: нет 2D-замены`);
    assert.ok(item.examples.length >= 1 && item.examples.length <= 4, `${item.id}: примеры`);
    for (const example of item.examples) assert.ok(item.members.includes(example.slug), `${item.id}: пример ${example.slug} не в members`);
  }
});

test('motion-library: каждая запись библиотеки ровно один раз – в приёме или в пропуске', () => {
  const seen = new Map();
  const add = (slug, where) => {
    assert.ok(!seen.has(slug), `${slug}: и в ${seen.get(slug)}, и в ${where}`);
    seen.set(slug, where);
  };
  for (const item of catalog.techniques) for (const slug of item.members) add(slug, item.id);
  for (const entry of catalog.skip) {
    assert.ok(entry.reason_ru?.trim(), `${entry.slug}: нет причины пропуска`);
    add(entry.slug, 'skip');
  }
  assert.equal(seen.size, 703);
});

test('motion-library: Markdown – разделы на месте, примеры ведут на skillry, в карте есть каждое семейство', () => {
  for (const heading of ['## Как предлагать приёмы автору', '## 3D-приёмы', '## Правила переноса в Remotion']) {
    assert.ok(doc.includes(heading), heading);
  }
  for (const family of catalog.families) assert.ok(doc.includes(family.name_ru), `нет семейства «${family.name_ru}»`);
  assert.match(doc, /\]\(https:\/\/skillry\.dev\/ai-videos\/opus-5-5\/[a-z0-9-]+\)/);
});

test('motion-library: без личных путей и длинного тире', () => {
  for (const text of [doc, JSON.stringify(catalog)]) {
    assert.ok(!text.includes(String.fromCodePoint(0x2014)), 'длинное тире');
    assert.doesNotMatch(text, /\/Users\/|\/home\/|\/tmp\/|projects\/20\d\d/u);
  }
});

test('motion-library: на каталог ссылаются навыки motion и AGENTS.md, ссылки живые', () => {
  for (const file of [
    `${DIR}/creative-motion.md`, `${DIR}/motion-craft.md`, 'skills/reel-turnkey/SKILL.md', 'skills/motion-reel/SKILL.md',
    'skills/ai-promo/SKILL.md', 'skills/reel-from-donor/SKILL.md', 'docs/MOTION-KIT.md', 'AGENTS.md',
  ]) {
    const links = [...read(file).matchAll(/\]\(([^)\s]*motion-library\.md)(?:#[^)\s]*)?\)/gu)].map((match) => match[1]);
    assert.ok(links.length > 0, `${file}: нет ссылки на motion-library.md`);
    for (const link of links) assert.ok(fs.existsSync(path.resolve(ROOT, path.dirname(file), link)), `${file}: ${link}`);
  }
});
