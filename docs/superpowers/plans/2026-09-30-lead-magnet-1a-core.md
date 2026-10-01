# Лид-магнит 1A – данные и команды движка: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать движку данные и команды лид-магнита: обещание с дословной цитатой, решения пульта,
референсы, библиотеку, ревизии, правки, бренд-пак, автопроверку каркаса и фактов, утверждение
(функцию), статусы, состояние воронки, входящие и CLI `automontage lead-magnet`.

**Architecture:** Новый модуль `scripts/lead-magnet/` с узкими файлами по ответственности и JSON
Schema в `schema/`. Хранилище – обычные JSON-файлы с атомарной записью (`writeJsonAtomic`) и чтением
без симлинков (`readJsonIfExists`), как у пульта. Проверка страницы – Playwright/Chromium без сети.
Утверждение – функция движка без CLI-команды: вызвать её сможет только сервер пульта (часть 1B).

**Tech Stack:** Node.js 20+ (CommonJS), `node:test`, `ajv` 8, `playwright` (Chromium), существующие
`scripts/pult/files.js` и `scripts/project/workspace.js`.

**Спецификация:** `docs/superpowers/specs/2026-09-30-lead-magnet-design.md`. **Общий план:**
`docs/superpowers/plans/2026-09-30-lead-magnet-stage1.md`. **Задача:** #63.

---

## Подготовка

- [ ] **Ветка.** От ветки со спецификацией:

```bash
git switch docs/lead-magnet-spec && git switch -c feat/lead-magnet-core
git config core.hooksPath .githooks
```

- [ ] **Доска.** Перевести #63 в «В работе»:

```bash
ITEM=$(gh project item-list 1 --owner mcdenil-skills --format json --jq '.items[] | select(.content.number==63) | .id')
gh project item-edit --id "$ITEM" --project-id PVT_kwDOE1M5Tc4BlHhK --field-id PVTSSF_lADOE1M5Tc4BlHhKzhj1lxM --single-select-option-id f39763b5
```

- [ ] **Окружение.** `which ffmpeg` должен указывать на полную сборку, а Chromium для Playwright
должен быть установлен (`npx playwright install chromium`). Базовая линия: `npm test` – зелёный.

## Карта файлов

| Файл | Ответственность |
|---|---|
| `scripts/lead-magnet/constants.js` | форматы, тексты и лимиты, шаблоны id, кодовое слово, сообщения ajv |
| `scripts/lead-magnet/text.js` | нормализация текста и поиск цитаты в `words.json` |
| `scripts/lead-magnet/offers.js` | `lead-magnet/offers.json` ролика: обещания с цитатой и таймкодом |
| `scripts/lead-magnet/references.js` | проверка и сохранение референсов (сигнатура, размер, SHA-256), ссылки |
| `scripts/lead-magnet/requests.js` | `pult/lead-magnet.json` ролика: решения пульта и состояние обещаний |
| `scripts/lead-magnet/library.js` | библиотека `projects/.lead-magnets/`: паспорт, ревизии, связи с роликами |
| `scripts/lead-magnet/comments.js` | правки к блокам и текстам лид-магнита |
| `scripts/lead-magnet/brand.js` | поиск и проверка бренд-пака, нейтральный бренд, галочки «что взять» |
| `scripts/lead-magnet/facts.js` | отчёт проверки фактов `facts.json` |
| `scripts/lead-magnet/check.js` | автопроверка каркаса и самодостаточности в Chromium, скриншоты |
| `scripts/lead-magnet/approve.js` | утверждение ревизии (только для сервера пульта) |
| `scripts/lead-magnet/status.js` | статус лид-магнита для карточки |
| `scripts/lead-magnet/funnel.js` | `funnel.json`: состояние воронки у поставщика |
| `scripts/lead-magnet/inbox.js` | строки входящих про лид-магниты |
| `scripts/lead-magnet/cli.js` | `automontage lead-magnet …` для агента |
| `schema/lead-magnet-*.schema.json` | схемы: offers, requests, passport, brand, comments, facts, check, funnel |
| `templates/lead-magnet/neutral/brand.json` | нейтральный бренд без логотипа |
| `tests/helpers/lead-magnet-fixtures.js` | общие фикстуры тестов |
| `tests/lead-magnet-*.test.js` | тесты по модулям |

---

### Task 1: Константы и поиск цитаты

**Files:**
- Create: `scripts/lead-magnet/constants.js`
- Create: `scripts/lead-magnet/text.js`
- Test: `tests/lead-magnet-text.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/lead-magnet-text.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeCodeWord } = require('../scripts/lead-magnet/constants');
const { findQuoteInSegments, normalizeText, tokenize } = require('../scripts/lead-magnet/text');

const SEGMENTS = [
  { start: 0, end: 2, text: 'Opus 5.5 умеет всё.', words: [
    { w: ' Opus', s: 0.2, e: 0.6 }, { w: ' 5', s: 0.6, e: 0.8 }, { w: '.5', s: 0.8, e: 1.0 },
    { w: ' умеет', s: 1.0, e: 1.4 }, { w: ' всё.', s: 1.4, e: 1.9 },
  ] },
  { start: 60, end: 64, text: 'Напишите ГАЙД, и я пришлю всё.', words: [
    { w: ' Напишите', s: 60.1, e: 60.6 }, { w: ' ГАЙД,', s: 60.6, e: 61.0 }, { w: ' и', s: 61.0, e: 61.1 },
    { w: ' я', s: 61.1, e: 61.2 }, { w: ' пришлю', s: 61.2, e: 61.7 }, { w: ' всё.', s: 61.7, e: 62.2 },
  ] },
];

test('normalizeText ignores case, ё and punctuation', () => {
  assert.equal(normalizeText('  Всё — ГАЙД!  '), 'все гайд');
  assert.deepEqual(tokenize('Opus 5.5'), ['opus', '5', '5']);
});

test('quote is found with the global timecode of its first and last word', () => {
  assert.deepEqual(findQuoteInSegments(SEGMENTS, 'напишите «гайд» — и я пришлю ВСЕ'), [{ startSec: 60.1, endSec: 62.2 }]);
  assert.deepEqual(findQuoteInSegments(SEGMENTS, 'Opus 5.5 умеет'), [{ startSec: 0.2, endSec: 1.4 }]);
});

test('missing quote returns no matches, too short quote is rejected', () => {
  assert.deepEqual(findQuoteInSegments(SEGMENTS, 'напишите слово промпт'), []);
  assert.throws(() => findQuoteInSegments(SEGMENTS, 'гайд'), /не меньше трёх слов/);
});

test('broken words.json is rejected', () => {
  assert.throws(() => findQuoteInSegments([{ words: [{ w: 'x' }] }], 'a b c'), /words\.json/);
  assert.throws(() => findQuoteInSegments({}, 'a b c'), /words\.json/);
});

test('code word is normalized and validated', () => {
  assert.equal(normalizeCodeWord('  гайд '), 'ГАЙД');
  assert.equal(normalizeCodeWord('ai  агент'), 'AI АГЕНТ');
  assert.throws(() => normalizeCodeWord('<script>'), /кодовое слово/);
  assert.throws(() => normalizeCodeWord(''), /кодовое слово/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lead-magnet-text.test.js`
Expected: FAIL – `Cannot find module '../scripts/lead-magnet/constants'`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/lead-magnet/constants.js
const FORMATS = ['guide', 'prompts', 'checklist', 'cheatsheet'];
const TEXT_KINDS = ['dm', 'telegram', 'instagram'];
// Лимиты площадок: личка, подпись к видео в Telegram, подпись Instagram.
const TEXT_LIMITS = { dm: 1000, telegram: 1024, instagram: 2200 };
const TEXT_FILES = { dm: 'texts/dm.txt', telegram: 'texts/telegram.txt', instagram: 'texts/instagram.txt' };
const LIBRARY_DIR = '.lead-magnets';
const LEAD_MAGNET_ID = /^\d{4}\.\d{2}\.\d{2}_[a-z0-9-]{1,80}$/;
const DECISION_ID = /^r-[a-f0-9]{8}$/;
const LM_COMMENT_ID = /^c-[a-f0-9]{8}$/;
const CODE_WORD = /^[A-ZА-ЯЁ0-9][A-ZА-ЯЁ0-9 -]{0,39}$/u;

// Кодовое слово печатается агенту в терминал и попадает в имя папки библиотеки:
// только буквы, цифры, пробел и дефис.
function normalizeCodeWord(value) {
  if (typeof value !== 'string') throw new Error('кодовое слово: нужен текст');
  const word = value.normalize('NFC').trim().replace(/\s+/g, ' ').toUpperCase();
  if (!CODE_WORD.test(word)) {
    throw new Error('кодовое слово: только буквы, цифры, пробел и дефис, до 40 символов');
  }
  return word;
}

function formatAjvErrors(errors) {
  return (errors || []).map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ');
}

module.exports = {
  CODE_WORD,
  DECISION_ID,
  FORMATS,
  LEAD_MAGNET_ID,
  LIBRARY_DIR,
  LM_COMMENT_ID,
  TEXT_FILES,
  TEXT_KINDS,
  TEXT_LIMITS,
  formatAjvErrors,
  normalizeCodeWord,
};
```

```js
// scripts/lead-magnet/text.js
// Сравнение цитаты с речью: регистр, «ё/е», пунктуация и пробелы не важны,
// порядок и состав слов – важны.
function normalizeText(value) {
  return String(value)
    .normalize('NFC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function tokenize(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.split(' ') : [];
}

function invalidTranscript() {
  return new Error('transcript: неверный формат words.json');
}

// words.json: [{ start, end, text, words: [{ w, s, e }] }]. Whisper дробит «5.5» на « 5» и «.5»,
// поэтому одно слово Whisper даёт 0..n токенов с таймкодом этого слова.
function flattenWords(segments) {
  if (!Array.isArray(segments)) throw invalidTranscript();
  const tokens = [];
  for (const segment of segments) {
    if (!segment || !Array.isArray(segment.words)) throw invalidTranscript();
    for (const word of segment.words) {
      if (!word || typeof word.w !== 'string' || !Number.isFinite(word.s) || !Number.isFinite(word.e)) {
        throw invalidTranscript();
      }
      for (const token of tokenize(word.w)) tokens.push({ token, s: word.s, e: word.e });
    }
  }
  return tokens;
}

function findQuoteInSegments(segments, quote) {
  const needle = tokenize(quote);
  if (needle.length < 3) throw new Error('цитата обещания слишком короткая: нужно не меньше трёх слов');
  const tokens = flattenWords(segments);
  const matches = [];
  for (let start = 0; start + needle.length <= tokens.length; start += 1) {
    let same = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (tokens[start + offset].token !== needle[offset]) { same = false; break; }
    }
    if (same) matches.push({ startSec: tokens[start].s, endSec: tokens[start + needle.length - 1].e });
  }
  return matches;
}

module.exports = { findQuoteInSegments, normalizeText, tokenize };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lead-magnet-text.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/lead-magnet/constants.js scripts/lead-magnet/text.js tests/lead-magnet-text.test.js
git commit -m "feat(lead-magnet): add quote locator and shared constants

Refs #63"
```

---

### Task 2: Обещания ролика (`offers.json`)

**Files:**
- Create: `schema/lead-magnet-offers.schema.json`
- Create: `scripts/lead-magnet/offers.js`
- Create: `tests/helpers/lead-magnet-fixtures.js`
- Test: `tests/lead-magnet-offers.test.js`

- [ ] **Step 1: Write the schema**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Lead magnet offers found in a video project",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "offers"],
  "properties": {
    "version": { "const": 1 },
    "offers": { "type": "array", "maxItems": 20, "items": { "$ref": "#/definitions/offer" } }
  },
  "definitions": {
    "unit": {
      "type": "object",
      "additionalProperties": false,
      "required": ["key", "count", "label"],
      "properties": {
        "key": { "type": "string", "pattern": "^[a-z][a-z0-9-]{0,30}$" },
        "count": { "type": ["integer", "null"], "minimum": 1, "maximum": 500 },
        "label": { "type": "string", "minLength": 1, "maxLength": 80 }
      }
    },
    "offer": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "codeWord", "kind", "quote", "source", "startSec", "endSec", "units", "suggest", "detectedAt"],
      "properties": {
        "id": { "type": "string", "pattern": "^o-[a-z0-9-]{1,60}$" },
        "codeWord": { "type": "string", "pattern": "^[A-ZА-ЯЁ0-9][A-ZА-ЯЁ0-9 -]{0,39}$" },
        "kind": { "enum": ["comment-keyword", "dm"] },
        "quote": { "type": "string", "minLength": 5, "maxLength": 600 },
        "source": {
          "type": "object",
          "additionalProperties": false,
          "required": ["kind", "path", "sha256"],
          "properties": {
            "kind": { "enum": ["transcript", "script"] },
            "path": { "type": "string", "minLength": 1, "maxLength": 300 },
            "sha256": { "type": "string", "pattern": "^[a-f0-9]{64}$" }
          }
        },
        "startSec": { "type": ["number", "null"], "minimum": 0 },
        "endSec": { "type": ["number", "null"], "minimum": 0 },
        "units": { "type": "array", "minItems": 1, "maxItems": 10, "items": { "$ref": "#/definitions/unit" } },
        "suggest": {
          "type": "object",
          "additionalProperties": false,
          "required": ["format", "audience"],
          "properties": {
            "format": { "enum": ["guide", "prompts", "checklist", "cheatsheet"] },
            "audience": { "type": "string", "maxLength": 200 }
          }
        },
        "detectedAt": { "type": "string", "minLength": 1 }
      }
    }
  }
}
```

Save as `schema/lead-magnet-offers.schema.json`.

- [ ] **Step 2: Write the shared fixtures**

```js
// tests/helpers/lead-magnet-fixtures.js
const fs = require('node:fs');
const path = require('node:path');

const { makePultRoot } = require('./pult-projects');

const WORDS = [
  { start: 58, end: 64, text: 'Напишите ГАЙД в комментариях, и я пришлю пошаговую инструкцию и пять промптов.', words: [
    ' Напишите', ' ГАЙД', ' в', ' комментариях,', ' и', ' я', ' пришлю', ' пошаговую', ' инструкцию',
    ' и', ' пять', ' промптов.',
  ].map((w, index) => ({ w, s: 58 + index * 0.5, e: 58.25 + index * 0.5 })) },
];
const QUOTE = 'и я пришлю пошаговую инструкцию и пять промптов';
const UNITS = [
  { key: 'step', count: null, label: 'пошаговая инструкция' },
  { key: 'prompt', count: 5, label: 'промптов' },
];

// Папка ролика с минимальным паспортом: offers.js читает из него только transcript.words.
function makeVideoProject(t, folder = '2026.09.30_sayt-za-vecher') {
  const { base, projectsDir } = makePultRoot(t);
  const projectDir = path.join(projectsDir, folder);
  fs.mkdirSync(path.join(projectDir, 'transcript'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'transcript', 'words.json'), JSON.stringify(WORDS));
  fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify({
    version: 1, transcript: { words: 'transcript/words.json', captions: 'transcript/captions.js' },
  }));
  return { base, projectsDir, projectDir, folder };
}

module.exports = { QUOTE, UNITS, WORDS, makeVideoProject };
```

- [ ] **Step 3: Write the failing test**

```js
// tests/lead-magnet-offers.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { addOffer, readOffers } = require('../scripts/lead-magnet/offers');
const { QUOTE, UNITS, makeVideoProject } = require('./helpers/lead-magnet-fixtures');

const NOW = () => new Date('2026-09-30T10:00:00.000Z');

test('offer stores the verbatim quote with the transcript timecode', (t) => {
  const { projectDir } = makeVideoProject(t);
  const offer = addOffer(projectDir, {
    codeWord: 'гайд', kind: 'comment-keyword', quote: QUOTE, units: UNITS, format: 'guide', audience: 'новички',
  }, { now: NOW });
  assert.equal(offer.id, 'o-gayd');
  assert.equal(offer.codeWord, 'ГАЙД');
  assert.equal(offer.startSec, 60);
  assert.equal(offer.endSec, 63.75);
  assert.equal(offer.source.kind, 'transcript');
  assert.equal(offer.source.path, 'transcript/words.json');
  assert.match(offer.source.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(readOffers(projectDir), [offer]);
});

test('re-detecting the same code word replaces the offer instead of duplicating it', (t) => {
  const { projectDir } = makeVideoProject(t);
  addOffer(projectDir, { codeWord: 'ГАЙД', kind: 'comment-keyword', quote: QUOTE, units: UNITS }, { now: NOW });
  addOffer(projectDir, { codeWord: 'гайд', kind: 'dm', quote: QUOTE, units: UNITS }, { now: NOW });
  const offers = readOffers(projectDir);
  assert.equal(offers.length, 1);
  assert.equal(offers[0].kind, 'dm');
});

test('a quote that is not in the speech is rejected and nothing is written', (t) => {
  const { projectDir } = makeVideoProject(t);
  assert.throws(
    () => addOffer(projectDir, { codeWord: 'ГАЙД', kind: 'comment-keyword', quote: 'пришлю тринадцать промптов бесплатно', units: UNITS }),
    /цитата не найдена/,
  );
  assert.equal(fs.existsSync(path.join(projectDir, 'lead-magnet', 'offers.json')), false);
});

test('script source verifies the quote in the script and leaves timecodes empty', (t) => {
  const { projectDir } = makeVideoProject(t);
  fs.writeFileSync(path.join(projectDir, 'script.txt'), `Финал. ${QUOTE.toUpperCase()}!`);
  const offer = addOffer(projectDir, {
    codeWord: 'ГАЙД', kind: 'comment-keyword', quote: QUOTE, units: UNITS, sourceKind: 'script', scriptPath: 'script.txt',
  }, { now: NOW });
  assert.equal(offer.startSec, null);
  assert.equal(offer.source.kind, 'script');
  assert.throws(() => addOffer(projectDir, {
    codeWord: 'ГАЙД', kind: 'comment-keyword', quote: QUOTE, units: UNITS, sourceKind: 'script', scriptPath: '../outside.txt',
  }), /источник обещания/);
});

test('invalid units and tampered offers.json are rejected', (t) => {
  const { projectDir } = makeVideoProject(t);
  assert.throws(() => addOffer(projectDir, {
    codeWord: 'ГАЙД', kind: 'comment-keyword', quote: QUOTE, units: [{ key: 'Bad Key', count: 1, label: 'x' }],
  }), /схеме/);
  fs.mkdirSync(path.join(projectDir, 'lead-magnet'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'lead-magnet', 'offers.json'), JSON.stringify({ version: 1, offers: [{ id: 'x' }] }));
  assert.throws(() => readOffers(projectDir), /неверный формат/);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node --test tests/lead-magnet-offers.test.js`
Expected: FAIL – `Cannot find module '../scripts/lead-magnet/offers'`.

- [ ] **Step 5: Write minimal implementation**

```js
// scripts/lead-magnet/offers.js
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');

const schema = require('../../schema/lead-magnet-offers.schema.json');
const { resolveProjectPath, slugifyProjectName } = require('../project/workspace');
const { hashFile, readJsonIfExists, writeJsonAtomic } = require('../pult/files');
const { formatAjvErrors, normalizeCodeWord } = require('./constants');
const { findQuoteInSegments, normalizeText, tokenize } = require('./text');

const OFFERS_LABEL = 'lead-magnet/offers.json';
const validateOffers = new Ajv({ allErrors: true }).compile(schema);

function offersPath(projectDir) {
  return path.join(projectDir, 'lead-magnet', 'offers.json');
}

function readOffers(projectDir) {
  const value = readJsonIfExists(offersPath(projectDir), OFFERS_LABEL);
  if (value === undefined) return [];
  if (!validateOffers(value)) throw new Error(`${OFFERS_LABEL}: неверный формат`);
  return value.offers;
}

function transcriptWordsPath(projectDir) {
  const manifest = readJsonIfExists(path.join(projectDir, 'project.json'), 'project.json');
  const stored = manifest && manifest.transcript && manifest.transcript.words;
  if (typeof stored !== 'string') throw new Error('у ролика нет расшифровки: сначала транскрибируй исходник');
  return stored;
}

function resolveSource(projectDir, sourceKind, stored) {
  try {
    return resolveProjectPath(projectDir, stored, { label: 'source', mustExist: true, type: 'file' });
  } catch (_) {
    throw new Error(`источник обещания (${sourceKind}) не найден внутри папки ролика`);
  }
}

// Агент не придумывает цитату: она обязана дословно (с точностью до регистра и
// пунктуации) найтись в расшифровке или в утверждённом сценарии. Иначе запись не пишется.
function addOffer(projectDir, input, { now = () => new Date() } = {}) {
  const codeWord = normalizeCodeWord(input.codeWord);
  const sourceKind = input.sourceKind || 'transcript';
  if (sourceKind !== 'transcript' && sourceKind !== 'script') {
    throw new Error('источник обещания: transcript или script');
  }
  const stored = sourceKind === 'transcript' ? transcriptWordsPath(projectDir) : input.scriptPath;
  const absolute = resolveSource(projectDir, sourceKind, stored);
  const quote = String(input.quote || '').trim();
  let startSec = null;
  let endSec = null;
  if (sourceKind === 'transcript') {
    const matches = findQuoteInSegments(JSON.parse(fs.readFileSync(absolute, 'utf8')), quote);
    if (!matches.length) throw new Error('цитата не найдена в расшифровке: скопируй её из words.json дословно');
    // Призыв обычно звучит в концовке: при повторе фразы берём последнее вхождение.
    ({ startSec, endSec } = matches[matches.length - 1]);
  } else {
    if (tokenize(quote).length < 3) throw new Error('цитата обещания слишком короткая: нужно не меньше трёх слов');
    const haystack = ` ${normalizeText(fs.readFileSync(absolute, 'utf8'))} `;
    if (!haystack.includes(` ${normalizeText(quote)} `)) {
      throw new Error('цитата не найдена в сценарии: скопируй её дословно');
    }
  }
  const offer = {
    id: `o-${slugifyProjectName(codeWord)}`,
    codeWord,
    kind: input.kind,
    quote,
    source: { kind: sourceKind, path: stored, sha256: hashFile(absolute) },
    startSec,
    endSec,
    units: input.units,
    suggest: { format: input.format || 'guide', audience: input.audience || '' },
    detectedAt: now().toISOString(),
  };
  const value = { version: 1, offers: [...readOffers(projectDir).filter((item) => item.id !== offer.id), offer] };
  if (!validateOffers(value)) {
    throw new Error(`обещание не соответствует схеме: ${formatAjvErrors(validateOffers.errors)}`);
  }
  writeJsonAtomic(offersPath(projectDir), value);
  return offer;
}

module.exports = { addOffer, offersPath, readOffers };
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test tests/lead-magnet-offers.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 7: Commit**

```bash
git add schema/lead-magnet-offers.schema.json scripts/lead-magnet/offers.js tests/helpers/lead-magnet-fixtures.js tests/lead-magnet-offers.test.js
git commit -m "feat(lead-magnet): record promises with a verbatim quote and timecode

Refs #63"
```

---

### Task 3: Референсы

**Files:**
- Create: `scripts/lead-magnet/references.js`
- Test: `tests/lead-magnet-references.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/lead-magnet-references.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { REFERENCE_LIMITS, normalizeReferenceUrl, sniffReference, storeReference } = require('../scripts/lead-magnet/references');
const { makeVideoProject } = require('./helpers/lead-magnet-fixtures');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpg-body')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const PDF = Buffer.from('%PDF-1.7\n...');
const HTML = Buffer.from('﻿  <!DOCTYPE html><html><body>ref</body></html>');

test('file type is detected by signature, not by name', () => {
  assert.equal(sniffReference(PNG).ext, 'png');
  assert.equal(sniffReference(JPG).ext, 'jpg');
  assert.equal(sniffReference(WEBP).ext, 'webp');
  assert.equal(sniffReference(PDF).ext, 'pdf');
  assert.equal(sniffReference(HTML).ext, 'html');
  assert.equal(sniffReference(Buffer.from('MZ\x90\x00 fake exe')), null);
  assert.equal(sniffReference(Buffer.from('<html>\u0000binary')), null);
});

test('stored reference gets a content-addressed name inside the project', (t) => {
  const { projectDir } = makeVideoProject(t);
  const stored = storeReference(projectDir, PNG);
  assert.match(stored.path, /^pult\/lead-magnet-refs\/[a-f0-9]{64}\.png$/);
  assert.equal(stored.kind, 'file');
  assert.equal(stored.mime, 'image/png');
  assert.deepEqual(fs.readFileSync(path.join(projectDir, ...stored.path.split('/'))), PNG);
  assert.deepEqual(storeReference(projectDir, PNG), stored);
});

test('unsupported, empty and oversized files are rejected without writing', (t) => {
  const { projectDir } = makeVideoProject(t);
  assert.throws(() => storeReference(projectDir, Buffer.alloc(0)), /пустой/);
  assert.throws(() => storeReference(projectDir, Buffer.from('MZ fake')), /не поддерживается/);
  const huge = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(REFERENCE_LIMITS.pdf)]);
  assert.throws(() => storeReference(projectDir, huge), /больше 30 МБ/);
  assert.equal(fs.existsSync(path.join(projectDir, 'pult', 'lead-magnet-refs')), false);
});

test('a symlinked refs folder is refused', (t) => {
  const { base, projectDir } = makeVideoProject(t);
  fs.mkdirSync(path.join(projectDir, 'pult'), { recursive: true });
  fs.mkdirSync(path.join(base, 'elsewhere'));
  fs.symlinkSync(path.join(base, 'elsewhere'), path.join(projectDir, 'pult', 'lead-magnet-refs'));
  assert.throws(() => storeReference(projectDir, PNG));
  assert.deepEqual(fs.readdirSync(path.join(base, 'elsewhere')), []);
});

test('only plain http(s) links are accepted', () => {
  assert.equal(normalizeReferenceUrl(' https://example.com/guide '), 'https://example.com/guide');
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pass@example.com', 'https://exa\u0007mple.com', 'не ссылка', `https://e.com/${'a'.repeat(2100)}`]) {
    assert.throws(() => normalizeReferenceUrl(bad), /ссылка/);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lead-magnet-references.test.js`
Expected: FAIL – `Cannot find module '../scripts/lead-magnet/references'`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/lead-magnet/references.js
const fs = require('node:fs');
const path = require('node:path');

const { resolveProjectPath } = require('../project/workspace');
const { ensureDirectory, hashBytes, hashFile } = require('../pult/files');

const MB = 1024 * 1024;
const REFERENCE_LIMITS = { png: 15 * MB, jpg: 15 * MB, webp: 15 * MB, pdf: 30 * MB, html: 5 * MB };
const REFS_DIR = 'pult/lead-magnet-refs';
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

function looksLikeHtml(bytes) {
  if (bytes.includes(0)) return false;
  const head = bytes.subarray(0, 2048).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

// Тип определяется по первым байтам: расширение и MIME из браузера подделать легко.
function sniffReference(bytes) {
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC)) return { ext: 'png', mime: 'image/png' };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' };
  }
  if (bytes.length >= 5 && bytes.toString('latin1', 0, 5) === '%PDF-') return { ext: 'pdf', mime: 'application/pdf' };
  if (looksLikeHtml(bytes)) return { ext: 'html', mime: 'text/html' };
  return null;
}

// Референс хранится по SHA-256 содержимого: повторная загрузка того же файла не плодит копий,
// а имя файла никогда не приходит от пользователя.
function storeReference(projectDir, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error('референс: пустой файл');
  const type = sniffReference(bytes);
  if (!type) throw new Error('референс: такой тип файла не поддерживается – нужны PNG, JPG, WebP, PDF или HTML');
  if (bytes.length > REFERENCE_LIMITS[type.ext]) {
    throw new Error(`референс: файл больше ${REFERENCE_LIMITS[type.ext] / MB} МБ`);
  }
  const sha256 = hashBytes(bytes);
  const relative = `${REFS_DIR}/${sha256}.${type.ext}`;
  const target = resolveProjectPath(projectDir, relative, { label: 'reference', mustExist: false, type: 'file' });
  ensureDirectory(path.join(projectDir, 'pult'));
  ensureDirectory(path.dirname(target));
  try {
    fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o644 });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
    if (fs.lstatSync(target).isSymbolicLink() || hashFile(target) !== sha256) {
      throw new Error('референс: на месте файла лежит чужое содержимое');
    }
  }
  return { kind: 'file', path: relative, sha256, mime: type.mime, bytes: bytes.length };
}

function normalizeReferenceUrl(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 2048 || CONTROL_CHARS.test(text)) throw new Error('ссылка на референс: неверный адрес');
  let url;
  try {
    url = new URL(text);
  } catch (_) {
    throw new Error('ссылка на референс: неверный адрес');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    throw new Error('ссылка на референс: нужен обычный адрес http или https');
  }
  return url.href;
}

module.exports = { REFERENCE_LIMITS, REFS_DIR, normalizeReferenceUrl, sniffReference, storeReference };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lead-magnet-references.test.js`
Expected: PASS, 5 tests. Если тест символической ссылки падает с `EPERM` на Windows, это ожидаемо:
тест-хелпер `tests/helpers/windows-filesystem.js` уже используется в соседних тестах, пропускай тест
так же, как они.

- [ ] **Step 5: Commit**

```bash
git add scripts/lead-magnet/references.js tests/lead-magnet-references.test.js
git commit -m "feat(lead-magnet): store design references by signature and hash

Refs #63"
```

---

### Task 4: Решения пульта (`pult/lead-magnet.json`)

**Files:**
- Create: `schema/lead-magnet-requests.schema.json`
- Create: `scripts/lead-magnet/requests.js`
- Test: `tests/lead-magnet-requests.test.js`

Правило: решения, которые не требуют работы агента (`decline`, `reopen`, `link`, `promise-keep`),
записываются сразу со статусом `accepted`. Во входящие попадают только `create`, `promise-refresh`
и `funnel-check`.

- [ ] **Step 1: Write the schema**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Lead magnet decisions written by the pult",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "decisions"],
  "properties": {
    "version": { "const": 1 },
    "decisions": { "type": "array", "maxItems": 500, "items": { "$ref": "#/definitions/decision" } }
  },
  "definitions": {
    "reference": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["kind", "path", "sha256", "mime", "bytes"],
          "properties": {
            "kind": { "const": "file" },
            "path": { "type": "string", "pattern": "^pult/lead-magnet-refs/[a-f0-9]{64}\\.(png|jpg|webp|pdf|html)$" },
            "sha256": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
            "mime": { "enum": ["image/png", "image/jpeg", "image/webp", "application/pdf", "text/html"] },
            "bytes": { "type": "integer", "minimum": 1 }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["kind", "url"],
          "properties": { "kind": { "const": "url" }, "url": { "type": "string", "minLength": 8, "maxLength": 2048 } }
        }
      ]
    },
    "params": {
      "type": "object",
      "additionalProperties": false,
      "required": ["format", "audience", "design", "texts", "wishes", "promiseConfirmed"],
      "properties": {
        "format": { "enum": ["guide", "prompts", "checklist", "cheatsheet"] },
        "audience": { "type": "string", "maxLength": 200 },
        "design": {
          "type": "object",
          "additionalProperties": false,
          "required": ["mode", "take", "likeId", "note", "references"],
          "properties": {
            "mode": { "enum": ["brand", "reference", "new", "like"] },
            "take": {
              "type": "object",
              "additionalProperties": false,
              "required": ["composition", "colors", "fonts"],
              "properties": { "composition": { "type": "boolean" }, "colors": { "type": "boolean" }, "fonts": { "type": "boolean" } }
            },
            "likeId": { "type": ["string", "null"], "pattern": "^\\d{4}\\.\\d{2}\\.\\d{2}_[a-z0-9-]{1,80}$" },
            "note": { "type": "string", "maxLength": 500 },
            "references": { "type": "array", "maxItems": 5, "items": { "$ref": "#/definitions/reference" } }
          }
        },
        "texts": {
          "type": "array",
          "uniqueItems": true,
          "maxItems": 3,
          "items": { "enum": ["dm", "telegram", "instagram"] }
        },
        "wishes": { "type": "string", "maxLength": 1000 },
        "promiseConfirmed": { "type": "boolean" }
      }
    },
    "decision": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "type", "createdAt", "status"],
      "properties": {
        "id": { "type": "string", "pattern": "^r-[a-f0-9]{8}$" },
        "type": { "enum": ["create", "decline", "reopen", "link", "promise-refresh", "promise-keep", "funnel-check"] },
        "createdAt": { "type": "string", "minLength": 1 },
        "status": { "enum": ["new", "accepted"] },
        "acceptedAt": { "type": "string", "minLength": 1 },
        "offerId": { "type": ["string", "null"], "pattern": "^o-[a-z0-9-]{1,60}$" },
        "codeWord": { "type": ["string", "null"], "pattern": "^[A-ZА-ЯЁ0-9][A-ZА-ЯЁ0-9 -]{0,39}$" },
        "leadMagnetId": { "type": "string", "pattern": "^\\d{4}\\.\\d{2}\\.\\d{2}_[a-z0-9-]{1,80}$" },
        "params": { "$ref": "#/definitions/params" }
      }
    }
  }
}
```

Save as `schema/lead-magnet-requests.schema.json`.

- [ ] **Step 2: Write the failing test**

```js
// tests/lead-magnet-requests.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { addOffer } = require('../scripts/lead-magnet/offers');
const { storeReference } = require('../scripts/lead-magnet/references');
const { acceptDecision, addDecision, offerStates, readDecisions } = require('../scripts/lead-magnet/requests');
const { QUOTE, UNITS, makeVideoProject } = require('./helpers/lead-magnet-fixtures');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('x')]);
const NOW = () => new Date('2026-09-30T11:00:00.000Z');
let counter = 0;
const ID = () => `r-${String(counter += 1).padStart(8, '0')}`;

function params(overrides = {}) {
  return {
    format: 'guide',
    audience: 'новички',
    design: { mode: 'brand', take: { composition: true, colors: false, fonts: false }, likeId: null, note: '', references: [] },
    texts: ['dm', 'telegram', 'instagram'],
    wishes: '',
    promiseConfirmed: true,
    ...overrides,
  };
}

function withOffer(t) {
  const context = makeVideoProject(t);
  addOffer(context.projectDir, { codeWord: 'ГАЙД', kind: 'comment-keyword', quote: QUOTE, units: UNITS });
  return context;
}

test('offer states follow the decisions: ask → declined → ask → requested', (t) => {
  const { projectDir } = withOffer(t);
  assert.equal(offerStates(projectDir)[0].state, 'ask');
  addDecision(projectDir, { type: 'decline', offerId: 'o-gayd', codeWord: 'ГАЙД' }, { now: NOW, id: ID });
  assert.equal(offerStates(projectDir)[0].state, 'declined');
  addDecision(projectDir, { type: 'reopen', offerId: 'o-gayd', codeWord: 'ГАЙД' }, { now: NOW, id: ID });
  assert.equal(offerStates(projectDir)[0].state, 'ask');
  const create = addDecision(projectDir, { type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: params() }, { now: NOW, id: ID });
  assert.equal(create.status, 'new');
  assert.equal(offerStates(projectDir)[0].state, 'requested');
});

test('automatic decisions are accepted at once, agent work stays new', (t) => {
  const { projectDir } = withOffer(t);
  const decline = addDecision(projectDir, { type: 'decline', offerId: 'o-gayd', codeWord: 'ГАЙД' }, { now: NOW, id: ID });
  assert.equal(decline.status, 'accepted');
  assert.equal(decline.acceptedAt, decline.createdAt);
  const link = addDecision(projectDir, { type: 'link', offerId: 'o-gayd', codeWord: 'ГАЙД', leadMagnetId: '2026.09.12_gayd' }, { now: NOW, id: ID });
  assert.equal(link.status, 'accepted');
  assert.deepEqual(offerStates(projectDir)[0], { offer: offerStates(projectDir)[0].offer, state: 'linked', leadMagnetId: '2026.09.12_gayd' });
  const refresh = addDecision(projectDir, { type: 'promise-refresh', offerId: 'o-gayd', leadMagnetId: '2026.09.12_gayd' }, { now: NOW, id: ID });
  assert.equal(refresh.status, 'new');
  acceptDecision(projectDir, refresh.id, { now: NOW });
  assert.equal(readDecisions(projectDir).find((item) => item.id === refresh.id).status, 'accepted');
});

test('create requires a confirmed promise, references for reference mode and a like id', (t) => {
  const { projectDir } = withOffer(t);
  const create = (p) => addDecision(projectDir, { type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: p }, { now: NOW, id: ID });
  assert.throws(() => create(params({ promiseConfirmed: false })), /обещание/);
  assert.throws(() => create(params({ design: { ...params().design, mode: 'reference' } })), /референс/);
  assert.throws(() => create(params({ design: { ...params().design, mode: 'like' } })), /образец/);
  const ref = storeReference(projectDir, PNG);
  const ok = create(params({ design: { ...params().design, mode: 'reference', references: [ref, { kind: 'url', url: 'https://example.com/' }] } }));
  assert.equal(ok.params.design.references.length, 2);
});

test('unknown offer, missing reference file and unsafe url are rejected', (t) => {
  const { projectDir } = withOffer(t);
  assert.throws(() => addDecision(projectDir, { type: 'decline', offerId: 'o-other', codeWord: 'ДРУГОЕ' }), /обещани/);
  const ghost = { kind: 'file', path: `pult/lead-magnet-refs/${'a'.repeat(64)}.png`, sha256: 'a'.repeat(64), mime: 'image/png', bytes: 1 };
  assert.throws(() => addDecision(projectDir, {
    type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: params({ design: { ...params().design, mode: 'reference', references: [ghost] } }),
  }), /референс/);
  assert.throws(() => addDecision(projectDir, {
    type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: params({ design: { ...params().design, mode: 'reference', references: [{ kind: 'url', url: 'javascript:alert(1)' }] } }),
  }), /ссылка/);
  assert.equal(fs.existsSync(path.join(projectDir, 'pult', 'lead-magnet.json')), false);
});

test('manual create without an offer is allowed and a tampered file is unreadable', (t) => {
  const { projectDir } = withOffer(t);
  const manual = addDecision(projectDir, { type: 'create', offerId: null, codeWord: null, params: params({ promiseConfirmed: false }) }, { now: NOW, id: ID });
  assert.equal(manual.offerId, null);
  fs.writeFileSync(path.join(projectDir, 'pult', 'lead-magnet.json'), JSON.stringify({ version: 1, decisions: [{ id: 'r-00000001', type: 'create', createdAt: 'x', status: 'new' }] }));
  assert.throws(() => readDecisions(projectDir), /неверный формат/);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/lead-magnet-requests.test.js`
Expected: FAIL – `Cannot find module '../scripts/lead-magnet/requests'`.

- [ ] **Step 4: Write minimal implementation**

```js
// scripts/lead-magnet/requests.js
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const Ajv = require('ajv');

const schema = require('../../schema/lead-magnet-requests.schema.json');
const { resolveProjectPath } = require('../project/workspace');
const { readJsonIfExists, writeJsonAtomic } = require('../pult/files');
const { formatAjvErrors, normalizeCodeWord } = require('./constants');
const { readOffers } = require('./offers');
const { normalizeReferenceUrl } = require('./references');

const LABEL = 'pult/lead-magnet.json';
const validateFile = new Ajv({ allErrors: true }).compile(schema);
// Эти решения не требуют работы агента: пульт или движок исполняют их сразу.
const AUTO_ACCEPTED = new Set(['decline', 'reopen', 'link', 'promise-keep']);
const REQUIRED_BY_TYPE = {
  create: ['offerId', 'codeWord', 'params'],
  decline: ['offerId', 'codeWord'],
  reopen: ['offerId', 'codeWord'],
  link: ['offerId', 'codeWord', 'leadMagnetId'],
  'promise-refresh': ['offerId', 'leadMagnetId'],
  'promise-keep': ['offerId', 'leadMagnetId'],
  'funnel-check': ['leadMagnetId'],
};

function decisionsPath(projectDir) {
  return path.join(projectDir, 'pult', 'lead-magnet.json');
}

function hasRequiredFields(decision) {
  return (REQUIRED_BY_TYPE[decision.type] || []).every((field) => Object.hasOwn(decision, field));
}

function readDecisions(projectDir) {
  const value = readJsonIfExists(decisionsPath(projectDir), LABEL);
  if (value === undefined) return [];
  if (!validateFile(value)) throw new Error(`${LABEL}: неверный формат`);
  const seen = new Set();
  for (const decision of value.decisions) {
    if (!hasRequiredFields(decision) || seen.has(decision.id)) throw new Error(`${LABEL}: неверный формат`);
    seen.add(decision.id);
  }
  return value.decisions;
}

function checkParams(projectDir, params, { hasOffer }) {
  if (hasOffer && params.promiseConfirmed !== true) {
    throw new Error('лид-магнит: подтвердите, что делаем ровно под обещание из ролика');
  }
  const { design } = params;
  if (design.mode === 'reference' && design.references.length === 0) {
    throw new Error('лид-магнит: для дизайна по референсу приложите хотя бы один референс');
  }
  if (design.mode === 'like' && !design.likeId) {
    throw new Error('лид-магнит: выберите образец – прошлый лид-магнит');
  }
  return {
    ...params,
    design: {
      ...design,
      references: design.references.map((reference) => {
        if (reference.kind === 'url') return { kind: 'url', url: normalizeReferenceUrl(reference.url) };
        try {
          resolveProjectPath(projectDir, reference.path, { label: 'reference', mustExist: true, type: 'file' });
        } catch (_) {
          throw new Error('лид-магнит: файл референса не найден – загрузите его заново');
        }
        return reference;
      }),
    },
  };
}

function addDecision(projectDir, input, { now = () => new Date(), id = () => `r-${randomBytes(4).toString('hex')}` } = {}) {
  if (!REQUIRED_BY_TYPE[input.type]) throw new Error('лид-магнит: неизвестное решение');
  const createdAt = now().toISOString();
  const decision = { id: id(), type: input.type, createdAt, status: 'new' };
  for (const field of REQUIRED_BY_TYPE[input.type]) decision[field] = input[field];
  if (Object.hasOwn(decision, 'codeWord') && decision.codeWord !== null) decision.codeWord = normalizeCodeWord(decision.codeWord);
  if (Object.hasOwn(decision, 'offerId') && decision.offerId !== null) {
    if (!readOffers(projectDir).some((offer) => offer.id === decision.offerId)) {
      throw new Error('лид-магнит: такого обещания у ролика нет');
    }
  }
  if (decision.type === 'create') {
    decision.params = checkParams(projectDir, input.params, { hasOffer: decision.offerId !== null });
  }
  if (AUTO_ACCEPTED.has(decision.type)) {
    decision.status = 'accepted';
    decision.acceptedAt = createdAt;
  }
  const value = { version: 1, decisions: [...readDecisions(projectDir), decision] };
  if (!validateFile(value)) throw new Error(`лид-магнит: решение не соответствует схеме: ${formatAjvErrors(validateFile.errors)}`);
  writeJsonAtomic(decisionsPath(projectDir), value);
  return decision;
}

function acceptDecision(projectDir, decisionId, { now = () => new Date() } = {}) {
  const decisions = readDecisions(projectDir);
  const decision = decisions.find((item) => item.id === decisionId);
  if (!decision) throw new Error(`решение ${decisionId} не найдено`);
  if (decision.status === 'accepted') return decision;
  decision.status = 'accepted';
  decision.acceptedAt = now().toISOString();
  writeJsonAtomic(decisionsPath(projectDir), { version: 1, decisions });
  return decision;
}

// Состояние каждого обещания по последнему значимому решению:
// ask – спросить; declined – «Нет»; requested – «Разработать»; linked – «Уже есть готовый».
function offerStates(projectDir) {
  const decisions = readDecisions(projectDir);
  return readOffers(projectDir).map((offer) => {
    let state = 'ask';
    let leadMagnetId = null;
    for (const decision of decisions) {
      if (decision.offerId !== offer.id) continue;
      if (decision.type === 'decline') { state = 'declined'; leadMagnetId = null; }
      if (decision.type === 'reopen') { state = 'ask'; leadMagnetId = null; }
      if (decision.type === 'create') { state = 'requested'; leadMagnetId = null; }
      if (decision.type === 'link') { state = 'linked'; leadMagnetId = decision.leadMagnetId; }
    }
    return { offer, state, leadMagnetId };
  });
}

module.exports = { acceptDecision, addDecision, decisionsPath, offerStates, readDecisions };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/lead-magnet-requests.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add schema/lead-magnet-requests.schema.json scripts/lead-magnet/requests.js tests/lead-magnet-requests.test.js
git commit -m "feat(lead-magnet): record pult decisions and derive offer states

Refs #63"
```

---

### Task 5: Библиотека и ревизии

**Files:**
- Create: `schema/lead-magnet.schema.json`
- Create: `scripts/lead-magnet/library.js`
- Test: `tests/lead-magnet-library.test.js`

Ревизия проходит путь `building` → `draft` → `approved`. `publishRevision` требует все файлы
ревизии и `qa/check.json` с тем же SHA-256 страницы: агент не может показать страницу, которую не
проверил. Упала ли проверка — пульт покажет красные пункты, а утвердить не даст (Task 9).

- [ ] **Step 1: Write the schema**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Lead magnet passport",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "id", "title", "codeWords", "promise", "units", "params", "videos", "revisions", "current", "approved", "createdAt", "updatedAt"],
  "properties": {
    "version": { "const": 1 },
    "id": { "type": "string", "pattern": "^\\d{4}\\.\\d{2}\\.\\d{2}_[a-z0-9-]{1,80}$" },
    "title": { "type": "string", "minLength": 1, "maxLength": 160 },
    "codeWords": {
      "type": "array", "uniqueItems": true, "maxItems": 10,
      "items": { "type": "string", "pattern": "^[A-ZА-ЯЁ0-9][A-ZА-ЯЁ0-9 -]{0,39}$" }
    },
    "promise": {
      "type": "object",
      "additionalProperties": false,
      "required": ["quote", "startSec", "endSec", "sourceFolder", "acknowledged"],
      "properties": {
        "quote": { "type": ["string", "null"], "maxLength": 600 },
        "startSec": { "type": ["number", "null"], "minimum": 0 },
        "endSec": { "type": ["number", "null"], "minimum": 0 },
        "sourceFolder": { "type": ["string", "null"], "minLength": 1, "maxLength": 255 },
        "acknowledged": { "type": "array", "maxItems": 20, "items": { "type": "string", "maxLength": 600 } }
      }
    },
    "units": {
      "type": "array", "maxItems": 10,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["key", "count", "label"],
        "properties": {
          "key": { "type": "string", "pattern": "^[a-z][a-z0-9-]{0,30}$" },
          "count": { "type": ["integer", "null"], "minimum": 1, "maximum": 500 },
          "label": { "type": "string", "minLength": 1, "maxLength": 80 }
        }
      }
    },
    "params": { "$ref": "lead-magnet-requests.schema.json#/definitions/params" },
    "videos": { "type": "array", "uniqueItems": true, "maxItems": 50, "items": { "type": "string", "minLength": 1, "maxLength": 255 } },
    "revisions": {
      "type": "array", "maxItems": 99,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["n", "dir", "status", "pageSha256", "createdAt"],
        "properties": {
          "n": { "type": "integer", "minimum": 1, "maximum": 99 },
          "dir": { "type": "string", "pattern": "^v\\d{2}$" },
          "status": { "enum": ["building", "draft", "approved"] },
          "pageSha256": { "type": ["string", "null"], "pattern": "^[a-f0-9]{64}$" },
          "createdAt": { "type": "string", "minLength": 1 },
          "publishedAt": { "type": "string", "minLength": 1 },
          "approvedAt": { "type": "string", "minLength": 1 }
        }
      }
    },
    "current": { "type": ["integer", "null"], "minimum": 1 },
    "approved": { "type": ["integer", "null"], "minimum": 1 },
    "createdAt": { "type": "string", "minLength": 1 },
    "updatedAt": { "type": "string", "minLength": 1 }
  }
}
```

Save as `schema/lead-magnet.schema.json`. Ajv связывает `$ref` на другую схему через `addSchema`
(см. реализацию: схема запросов регистрируется под своим `$id`-именем файла).

- [ ] **Step 2: Write the failing test**

```js
// tests/lead-magnet-library.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const library = require('../scripts/lead-magnet/library');
const { QUOTE, UNITS, makeVideoProject } = require('./helpers/lead-magnet-fixtures');

const NOW = () => new Date('2026-09-30T12:00:00.000Z');
const PARAMS = {
  format: 'guide', audience: 'новички',
  design: { mode: 'brand', take: { composition: true, colors: false, fonts: false }, likeId: null, note: '', references: [] },
  texts: ['dm'], wishes: '', promiseConfirmed: true,
};

function create(projectsDir, folder, codeWord = 'ГАЙД') {
  return library.createLeadMagnet(projectsDir, {
    codeWord, title: 'Сайт без кода', promise: { quote: QUOTE, startSec: 60, endSec: 63.9, sourceFolder: folder },
    units: UNITS, params: PARAMS, videoFolder: folder,
  }, { now: NOW });
}

function writeRevisionFiles(dir, { withCheck = true } = {}) {
  fs.writeFileSync(path.join(dir, 'page.html'), '<!doctype html><html><body>ok</body></html>');
  fs.writeFileSync(path.join(dir, 'page.pdf'), '%PDF-1.7');
  fs.writeFileSync(path.join(dir, 'content.md'), '# ok');
  fs.writeFileSync(path.join(dir, 'texts', 'dm.txt'), 'Привет');
  fs.writeFileSync(path.join(dir, 'facts.json'), JSON.stringify({ version: 1, checkedAt: 'x', items: [] }));
  if (withCheck) {
    const pageSha256 = require('../scripts/pult/files').hashFile(path.join(dir, 'page.html'));
    fs.writeFileSync(path.join(dir, 'qa', 'check.json'), JSON.stringify({ version: 1, checkedAt: 'x', pageSha256, ok: true, items: [] }));
  }
}

test('lead magnet gets a dated id, a passport and a link to its video', (t) => {
  const { projectsDir, folder } = makeVideoProject(t);
  const passport = create(projectsDir, folder);
  assert.equal(passport.id, '2026.09.30_gayd');
  assert.deepEqual(passport.codeWords, ['ГАЙД']);
  assert.deepEqual(passport.videos, [folder]);
  assert.equal(passport.current, null);
  assert.deepEqual(library.readLeadMagnet(projectsDir, passport.id), passport);
  assert.equal(create(projectsDir, folder).id, '2026.09.30_gayd-2');
});

test('find by code word and link another video', (t) => {
  const { projectsDir, folder } = makeVideoProject(t);
  const { id } = create(projectsDir, folder);
  create(projectsDir, folder, 'ПРОМПТЫ');
  assert.deepEqual(library.findByCodeWord(projectsDir, 'гайд').map((item) => item.id), [id]);
  const linked = library.linkVideo(projectsDir, id, { folder: 'другой-ролик', codeWord: 'ГАЙД 2' }, { now: NOW });
  assert.deepEqual(linked.videos, [folder, 'другой-ролик']);
  assert.deepEqual(linked.codeWords, ['ГАЙД', 'ГАЙД 2']);
  assert.throws(() => library.linkVideo(projectsDir, id, { folder: '../x', codeWord: 'ГАЙД' }), /папк/);
});

test('revision goes building → draft only with all files and a matching check report', (t) => {
  const { projectsDir, folder } = makeVideoProject(t);
  const { id } = create(projectsDir, folder);
  const { n, dir } = library.startRevision(projectsDir, id, { now: NOW });
  assert.equal(n, 1);
  assert.equal(path.basename(dir), 'v01');
  assert.throws(() => library.publishRevision(projectsDir, id, 1, { now: NOW }), /не хватает файла/);
  writeRevisionFiles(dir, { withCheck: false });
  assert.throws(() => library.publishRevision(projectsDir, id, 1, { now: NOW }), /проверку/);
  writeRevisionFiles(dir);
  const passport = library.publishRevision(projectsDir, id, 1, { now: NOW });
  assert.equal(passport.current, 1);
  assert.equal(passport.revisions[0].status, 'draft');
  assert.match(passport.revisions[0].pageSha256, /^[a-f0-9]{64}$/);
  assert.equal(library.startRevision(projectsDir, id, { now: NOW }).n, 2);
});

test('broken passports are listed separately and a promise can be acknowledged or updated', (t) => {
  const { projectsDir, folder } = makeVideoProject(t);
  const { id } = create(projectsDir, folder);
  fs.mkdirSync(path.join(projectsDir, '.lead-magnets', '2026.09.01_bad'));
  fs.writeFileSync(path.join(projectsDir, '.lead-magnets', '2026.09.01_bad', 'lead-magnet.json'), '{');
  const list = library.listLeadMagnets(projectsDir);
  assert.deepEqual(list.entries.map((item) => item.id), [id]);
  assert.equal(list.broken[0].id, '2026.09.01_bad');
  const acknowledged = library.acknowledgePromise(projectsDir, id, 'Новая цитата из ролика', { now: NOW });
  assert.deepEqual(acknowledged.promise.acknowledged, ['новая цитата из ролика']);
  const updated = library.updatePromise(projectsDir, id, { quote: 'и я пришлю семь промптов', startSec: 61, endSec: 63, sourceFolder: folder }, { now: NOW });
  assert.equal(updated.promise.quote, 'и я пришлю семь промптов');
  assert.deepEqual(updated.promise.acknowledged, []);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/lead-magnet-library.test.js`
Expected: FAIL – `Cannot find module '../scripts/lead-magnet/library'`.

- [ ] **Step 4: Write minimal implementation**

```js
// scripts/lead-magnet/library.js
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');

const passportSchema = require('../../schema/lead-magnet.schema.json');
const requestsSchema = require('../../schema/lead-magnet-requests.schema.json');
const { slugifyProjectName } = require('../project/workspace');
const { ensureDirectory, hashFile, readJsonIfExists, writeJsonAtomic } = require('../pult/files');
const { isSafeName } = require('../pult/names');
const { LEAD_MAGNET_ID, LIBRARY_DIR, TEXT_FILES, formatAjvErrors, normalizeCodeWord } = require('./constants');
const { normalizeText } = require('./text');

const ajv = new Ajv({ allErrors: true });
ajv.addSchema(requestsSchema, 'lead-magnet-requests.schema.json');
const validatePassport = ajv.compile(passportSchema);
const PASSPORT = 'lead-magnet.json';

function libraryRoot(projectsDir) {
  return path.join(projectsDir, LIBRARY_DIR);
}

function leadMagnetDir(projectsDir, id) {
  if (typeof id !== 'string' || !LEAD_MAGNET_ID.test(id)) throw new Error('лид-магнит: неверный id');
  return path.join(libraryRoot(projectsDir), id);
}

function revisionDir(projectsDir, id, n) {
  return path.join(leadMagnetDir(projectsDir, id), `v${String(n).padStart(2, '0')}`);
}

function readLeadMagnet(projectsDir, id) {
  const value = readJsonIfExists(path.join(leadMagnetDir(projectsDir, id), PASSPORT), PASSPORT);
  if (value === undefined) throw new Error(`лид-магнит ${id} не найден`);
  if (!validatePassport(value) || value.id !== id) throw new Error(`${PASSPORT}: не соответствует схеме`);
  return value;
}

function savePassport(projectsDir, passport, now) {
  const next = { ...passport, updatedAt: now().toISOString() };
  if (!validatePassport(next)) throw new Error(`${PASSPORT}: ${formatAjvErrors(validatePassport.errors)}`);
  writeJsonAtomic(path.join(leadMagnetDir(projectsDir, next.id), PASSPORT), next);
  return next;
}

function datePrefix(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
}

function assertFolder(folder) {
  if (!isSafeName(folder)) throw new Error('лид-магнит: неверная папка ролика');
  return folder;
}

function createLeadMagnet(projectsDir, input, { now = () => new Date() } = {}) {
  const codeWord = normalizeCodeWord(input.codeWord);
  const createdAt = now();
  ensureDirectory(libraryRoot(projectsDir));
  const base = `${datePrefix(createdAt)}_${slugifyProjectName(codeWord)}`;
  let id = base;
  for (let attempt = 2; ; attempt += 1) {
    try {
      fs.mkdirSync(leadMagnetDir(projectsDir, id));
      break;
    } catch (error) {
      if (!error || error.code !== 'EEXIST' || attempt > 99) throw error;
      id = `${base}-${attempt}`;
    }
  }
  const passport = {
    version: 1,
    id,
    title: input.title,
    codeWords: [codeWord],
    promise: { ...input.promise, acknowledged: [] },
    units: input.units,
    params: input.params,
    videos: [assertFolder(input.videoFolder)],
    revisions: [],
    current: null,
    approved: null,
    createdAt: createdAt.toISOString(),
    updatedAt: createdAt.toISOString(),
  };
  try {
    return savePassport(projectsDir, passport, () => createdAt);
  } catch (error) {
    fs.rmSync(leadMagnetDir(projectsDir, id), { recursive: true, force: true });
    throw error;
  }
}

function listLeadMagnets(projectsDir) {
  let dirents;
  try {
    dirents = fs.readdirSync(libraryRoot(projectsDir), { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return { entries: [], broken: [] };
    throw error;
  }
  const entries = [];
  const broken = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || !LEAD_MAGNET_ID.test(dirent.name)) continue;
    try {
      entries.push(readLeadMagnet(projectsDir, dirent.name));
    } catch (error) {
      broken.push({ id: dirent.name, error: error.message });
    }
  }
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { entries, broken };
}

// Утверждённые – первыми: именно их предлагает кнопка «Уже есть готовый».
function findByCodeWord(projectsDir, codeWord) {
  const word = normalizeCodeWord(codeWord);
  return listLeadMagnets(projectsDir).entries
    .filter((item) => item.codeWords.includes(word))
    .sort((a, b) => Number(b.approved !== null) - Number(a.approved !== null));
}

function linkVideo(projectsDir, id, { folder, codeWord }, { now = () => new Date() } = {}) {
  const passport = readLeadMagnet(projectsDir, id);
  const word = normalizeCodeWord(codeWord);
  assertFolder(folder);
  return savePassport(projectsDir, {
    ...passport,
    videos: passport.videos.includes(folder) ? passport.videos : [...passport.videos, folder],
    codeWords: passport.codeWords.includes(word) ? passport.codeWords : [...passport.codeWords, word],
  }, now);
}

function startRevision(projectsDir, id, { now = () => new Date() } = {}) {
  const passport = readLeadMagnet(projectsDir, id);
  const n = passport.revisions.length + 1;
  const dir = revisionDir(projectsDir, id, n);
  fs.mkdirSync(dir);
  fs.mkdirSync(path.join(dir, 'texts'));
  fs.mkdirSync(path.join(dir, 'qa'));
  savePassport(projectsDir, {
    ...passport,
    revisions: [...passport.revisions, { n, dir: path.basename(dir), status: 'building', pageSha256: null, createdAt: now().toISOString() }],
  }, now);
  return { n, dir };
}

function requiredRevisionFiles(passport) {
  return ['page.html', 'page.pdf', 'content.md', 'facts.json', ...passport.params.texts.map((kind) => TEXT_FILES[kind])];
}

function publishRevision(projectsDir, id, n, { now = () => new Date() } = {}) {
  const passport = readLeadMagnet(projectsDir, id);
  const revision = passport.revisions.find((item) => item.n === n);
  if (!revision || revision.status !== 'building') throw new Error(`ревизия ${n} не собирается сейчас`);
  const dir = revisionDir(projectsDir, id, n);
  for (const relative of requiredRevisionFiles(passport)) {
    const stat = fs.lstatSync(path.join(dir, ...relative.split('/')), { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) throw new Error(`ревизии не хватает файла ${relative}`);
  }
  const pageSha256 = hashFile(path.join(dir, 'page.html'));
  const report = readJsonIfExists(path.join(dir, 'qa', 'check.json'), 'qa/check.json');
  if (!report || report.pageSha256 !== pageSha256) {
    throw new Error('сначала запусти проверку: automontage lead-magnet check');
  }
  const publishedAt = now().toISOString();
  return savePassport(projectsDir, {
    ...passport,
    current: n,
    revisions: passport.revisions.map((item) => (item.n === n ? { ...item, status: 'draft', pageSha256, publishedAt } : item)),
  }, now);
}

// «Оставить как есть» при изменившемся обещании: новая цитата больше не считается расхождением.
function acknowledgePromise(projectsDir, id, quote, { now = () => new Date() } = {}) {
  const passport = readLeadMagnet(projectsDir, id);
  const normalized = normalizeText(quote);
  const acknowledged = passport.promise.acknowledged.includes(normalized)
    ? passport.promise.acknowledged
    : [...passport.promise.acknowledged, normalized];
  return savePassport(projectsDir, { ...passport, promise: { ...passport.promise, acknowledged } }, now);
}

// «Обновить под новое»: агент переносит новую цитату в паспорт перед новой ревизией.
function updatePromise(projectsDir, id, promise, { now = () => new Date() } = {}) {
  const passport = readLeadMagnet(projectsDir, id);
  return savePassport(projectsDir, { ...passport, promise: { ...promise, acknowledged: [] } }, now);
}

module.exports = {
  acknowledgePromise,
  createLeadMagnet,
  findByCodeWord,
  leadMagnetDir,
  libraryRoot,
  linkVideo,
  listLeadMagnets,
  publishRevision,
  readLeadMagnet,
  requiredRevisionFiles,
  revisionDir,
  savePassport,
  startRevision,
  updatePromise,
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/lead-magnet-library.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add schema/lead-magnet.schema.json scripts/lead-magnet/library.js tests/lead-magnet-library.test.js
git commit -m "feat(lead-magnet): add the lead magnet library with revisions

Refs #63"
```

---

### Task 6: Правки к лид-магниту

**Files:**
- Create: `schema/lead-magnet-comments.schema.json`
- Create: `scripts/lead-magnet/comments.js`
- Test: `tests/lead-magnet-comments.test.js`

- [ ] **Step 1: Write the schema**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Lead magnet review comments",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "comments"],
  "properties": {
    "version": { "const": 1 },
    "comments": {
      "type": "array", "maxItems": 1000,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "createdAt", "revision", "target", "text", "snapshot", "status"],
        "properties": {
          "id": { "type": "string", "pattern": "^c-[a-f0-9]{8}$" },
          "createdAt": { "type": "string", "minLength": 1 },
          "revision": { "type": "integer", "minimum": 1, "maximum": 99 },
          "target": {
            "oneOf": [
              {
                "type": "object",
                "additionalProperties": false,
                "required": ["kind", "blockId", "view", "rect"],
                "properties": {
                  "kind": { "const": "block" },
                  "blockId": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,60}$" },
                  "view": { "enum": ["desktop", "phone"] },
                  "rect": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["x", "y", "w", "h"],
                    "properties": {
                      "x": { "type": "number", "minimum": 0 }, "y": { "type": "number", "minimum": 0 },
                      "w": { "type": "number", "minimum": 0 }, "h": { "type": "number", "minimum": 0 }
                    }
                  }
                }
              },
              {
                "type": "object",
                "additionalProperties": false,
                "required": ["kind", "text"],
                "properties": { "kind": { "const": "text" }, "text": { "enum": ["dm", "telegram", "instagram"] } }
              }
            ]
          },
          "text": { "type": "string", "minLength": 1, "maxLength": 1000 },
          "snapshot": { "type": ["string", "null"], "pattern": "^pult/frames/c-[a-f0-9]{8}\\.png$" },
          "status": { "enum": ["new", "accepted"] },
          "acceptedAt": { "type": "string", "minLength": 1 }
        }
      }
    }
  }
}
```

- [ ] **Step 2: Write the failing test**

```js
// tests/lead-magnet-comments.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const comments = require('../scripts/lead-magnet/comments');
const library = require('../scripts/lead-magnet/library');
const { QUOTE, UNITS, makeVideoProject } = require('./helpers/lead-magnet-fixtures');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('shot')]);
const NOW = () => new Date('2026-09-30T13:00:00.000Z');
const BLOCK = { kind: 'block', blockId: 'step-2', view: 'phone', rect: { x: 10, y: 400, w: 370, h: 180 } };

function setup(t) {
  const { projectsDir, folder } = makeVideoProject(t);
  const { id } = library.createLeadMagnet(projectsDir, {
    codeWord: 'ГАЙД', title: 'Сайт', promise: { quote: QUOTE, startSec: 60, endSec: 63.9, sourceFolder: folder }, units: UNITS,
    params: { format: 'guide', audience: '', design: { mode: 'brand', take: { composition: true, colors: false, fonts: false }, likeId: null, note: '', references: [] }, texts: ['dm'], wishes: '', promiseConfirmed: true },
    videoFolder: folder,
  });
  return { projectsDir, id };
}

test('block comment keeps revision, block, view, rect and a PNG snapshot', (t) => {
  const { projectsDir, id } = setup(t);
  const comment = comments.addLeadMagnetComment(projectsDir, id, { revision: 1, target: BLOCK, text: '  короче  ', snapshotBytes: PNG }, { now: NOW, id: () => 'c-0000000a' });
  assert.equal(comment.text, 'короче');
  assert.equal(comment.snapshot, 'pult/frames/c-0000000a.png');
  assert.deepEqual(fs.readFileSync(path.join(library.leadMagnetDir(projectsDir, id), 'pult', 'frames', 'c-0000000a.png')), PNG);
  assert.deepEqual(comments.readLeadMagnetComments(projectsDir, id), [comment]);
});

test('text comment has no snapshot; a non-PNG snapshot is dropped', (t) => {
  const { projectsDir, id } = setup(t);
  const onText = comments.addLeadMagnetComment(projectsDir, id, { revision: 1, target: { kind: 'text', text: 'dm' }, text: 'убери смайлы' }, { now: NOW });
  assert.equal(onText.snapshot, null);
  const fake = comments.addLeadMagnetComment(projectsDir, id, { revision: 1, target: BLOCK, text: 'x', snapshotBytes: Buffer.from('<svg/>') }, { now: NOW });
  assert.equal(fake.snapshot, null);
});

test('only new comments can be deleted; accept keeps history', (t) => {
  const { projectsDir, id } = setup(t);
  const first = comments.addLeadMagnetComment(projectsDir, id, { revision: 1, target: BLOCK, text: 'a', snapshotBytes: PNG }, { now: NOW, id: () => 'c-00000001' });
  const second = comments.addLeadMagnetComment(projectsDir, id, { revision: 1, target: BLOCK, text: 'b' }, { now: NOW, id: () => 'c-00000002' });
  comments.acceptLeadMagnetComment(projectsDir, id, second.id, { now: NOW });
  assert.throws(() => comments.deleteLeadMagnetComment(projectsDir, id, second.id), /принят/);
  comments.deleteLeadMagnetComment(projectsDir, id, first.id);
  assert.equal(fs.existsSync(path.join(library.leadMagnetDir(projectsDir, id), 'pult', 'frames', 'c-00000001.png')), false);
  assert.deepEqual(comments.readLeadMagnetComments(projectsDir, id).map((item) => item.id), ['c-00000002']);
  assert.equal(comments.countNewLeadMagnetComments(projectsDir, id), 0);
});

test('invalid input is rejected without writing', (t) => {
  const { projectsDir, id } = setup(t);
  for (const input of [
    { revision: 0, target: BLOCK, text: 'x' },
    { revision: 1, target: { ...BLOCK, blockId: '../x' }, text: 'x' },
    { revision: 1, target: BLOCK, text: '   ' },
    { revision: 1, target: BLOCK, text: 'x'.repeat(1001) },
  ]) {
    assert.throws(() => comments.addLeadMagnetComment(projectsDir, id, input), /правк/);
  }
  assert.deepEqual(comments.readLeadMagnetComments(projectsDir, id), []);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/lead-magnet-comments.test.js`
Expected: FAIL – `Cannot find module '../scripts/lead-magnet/comments'`.

- [ ] **Step 4: Write minimal implementation**

```js
// scripts/lead-magnet/comments.js
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const Ajv = require('ajv');

const schema = require('../../schema/lead-magnet-comments.schema.json');
const { ensureDirectory, readJsonIfExists, writeJsonAtomic } = require('../pult/files');
const { leadMagnetDir, readLeadMagnet } = require('./library');

const LABEL = 'pult/comments.json лид-магнита';
const MAX_SNAPSHOT = 4 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const validateFile = new Ajv({ allErrors: true }).compile(schema);

function commentsPath(projectsDir, id) {
  return path.join(leadMagnetDir(projectsDir, id), 'pult', 'comments.json');
}

function snapshotPathFor(commentId) {
  return `pult/frames/${commentId}.png`;
}

function readLeadMagnetComments(projectsDir, id) {
  const value = readJsonIfExists(commentsPath(projectsDir, id), LABEL);
  if (value === undefined) return [];
  if (!validateFile(value)) throw new Error(`${LABEL}: неверный формат`);
  const seen = new Set();
  for (const comment of value.comments) {
    if (seen.has(comment.id) || (comment.snapshot !== null && comment.snapshot !== snapshotPathFor(comment.id))) {
      throw new Error(`${LABEL}: неверный формат`);
    }
    seen.add(comment.id);
  }
  return value.comments;
}

function writeComments(projectsDir, id, comments) {
  const value = { version: 1, comments };
  if (!validateFile(value)) throw new Error('правка лид-магнита: неверные данные');
  writeJsonAtomic(commentsPath(projectsDir, id), value);
}

function isPng(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length > PNG_MAGIC.length && bytes.length <= MAX_SNAPSHOT
    && bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
}

function addLeadMagnetComment(projectsDir, id, input, { now = () => new Date(), id: makeId = () => `c-${randomBytes(4).toString('hex')}` } = {}) {
  readLeadMagnet(projectsDir, id);
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  const comment = {
    id: makeId(),
    createdAt: now().toISOString(),
    revision: input.revision,
    target: input.target,
    text,
    snapshot: null,
    status: 'new',
  };
  const comments = readLeadMagnetComments(projectsDir, id);
  const next = [...comments, comment];
  if (!validateFile({ version: 1, comments: next })) throw new Error('правка лид-магнита: неверные данные');
  // Снимок – подсказка агенту «где это». Не PNG или слишком большой – правка остаётся без снимка.
  if (input.target && input.target.kind === 'block' && isPng(input.snapshotBytes)) {
    const framesDir = path.join(leadMagnetDir(projectsDir, id), 'pult', 'frames');
    ensureDirectory(path.join(leadMagnetDir(projectsDir, id), 'pult'));
    ensureDirectory(framesDir);
    fs.writeFileSync(path.join(framesDir, `${comment.id}.png`), input.snapshotBytes, { flag: 'wx', mode: 0o644 });
    comment.snapshot = snapshotPathFor(comment.id);
  }
  writeComments(projectsDir, id, next);
  return comment;
}

function deleteLeadMagnetComment(projectsDir, id, commentId) {
  const comments = readLeadMagnetComments(projectsDir, id);
  const comment = comments.find((item) => item.id === commentId);
  if (!comment) throw new Error('правка не найдена');
  if (comment.status !== 'new') throw new Error('принятую агентом правку удалить нельзя');
  writeComments(projectsDir, id, comments.filter((item) => item.id !== commentId));
  if (comment.snapshot) fs.rmSync(path.join(leadMagnetDir(projectsDir, id), ...comment.snapshot.split('/')), { force: true });
}

function acceptLeadMagnetComment(projectsDir, id, commentId, { now = () => new Date() } = {}) {
  const comments = readLeadMagnetComments(projectsDir, id);
  const comment = comments.find((item) => item.id === commentId);
  if (!comment) throw new Error(`правка ${commentId} не найдена`);
  if (comment.status === 'new') {
    comment.status = 'accepted';
    comment.acceptedAt = now().toISOString();
    writeComments(projectsDir, id, comments);
  }
  return comment;
}

function countNewLeadMagnetComments(projectsDir, id, revision = null) {
  return readLeadMagnetComments(projectsDir, id)
    .filter((item) => item.status === 'new' && (revision === null || item.revision === revision)).length;
}

module.exports = {
  acceptLeadMagnetComment,
  addLeadMagnetComment,
  countNewLeadMagnetComments,
  deleteLeadMagnetComment,
  readLeadMagnetComments,
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/lead-magnet-comments.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add schema/lead-magnet-comments.schema.json scripts/lead-magnet/comments.js tests/lead-magnet-comments.test.js
git commit -m "feat(lead-magnet): store block and text comments with snapshots

Refs #63"
```

---

### Task 7: Бренд-пак и нейтральный бренд

**Files:**
- Create: `schema/lead-magnet-brand.schema.json`
- Create: `templates/lead-magnet/neutral/brand.json`
- Create: `scripts/lead-magnet/brand.js`
- Test: `tests/lead-magnet-brand.test.js`

Правило поиска: явный `LEAD_MAGNET_BRAND` обязан быть рабочим (ошибка, если его нет или он битый — как
явный внешний id темы). Иначе смотрим папку `lead-magnet/` рядом с `THEMES_EXT`. Иначе —
нейтральный бренд движка без логотипа.

- [ ] **Step 1: Write the schema**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Lead magnet brand pack",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "name", "logoRequired", "logo", "tokens", "fontFiles", "cta", "voice", "examples"],
  "properties": {
    "version": { "const": 1 },
    "name": { "type": "string", "minLength": 1, "maxLength": 80 },
    "logoRequired": { "type": "boolean" },
    "logo": { "type": ["string", "null"], "pattern": "^[A-Za-z0-9_./-]{1,120}\\.(svg|png)$" },
    "tokens": {
      "type": "object",
      "additionalProperties": false,
      "required": ["colors", "fonts"],
      "properties": {
        "colors": {
          "type": "object",
          "additionalProperties": false,
          "required": ["background", "surface", "text", "muted", "accent"],
          "properties": {
            "background": { "type": "string", "pattern": "^#[0-9A-Fa-f]{6}$" },
            "surface": { "type": "string", "pattern": "^#[0-9A-Fa-f]{6}$" },
            "text": { "type": "string", "pattern": "^#[0-9A-Fa-f]{6}$" },
            "muted": { "type": "string", "pattern": "^#[0-9A-Fa-f]{6}$" },
            "accent": { "type": "string", "pattern": "^#[0-9A-Fa-f]{6}$" }
          }
        },
        "fonts": {
          "type": "object",
          "additionalProperties": false,
          "required": ["heading", "body", "mono"],
          "properties": {
            "heading": { "type": "string", "minLength": 1, "maxLength": 80 },
            "body": { "type": "string", "minLength": 1, "maxLength": 80 },
            "mono": { "type": "string", "minLength": 1, "maxLength": 80 }
          }
        }
      }
    },
    "fontFiles": { "type": "array", "maxItems": 12, "items": { "type": "string", "pattern": "^[A-Za-z0-9_./-]{1,120}\\.(ttf|otf|woff2?)$" } },
    "cta": {
      "type": "object",
      "additionalProperties": false,
      "required": ["title", "text", "buttons", "utm"],
      "properties": {
        "title": { "type": "string", "minLength": 1, "maxLength": 120 },
        "text": { "type": "string", "maxLength": 400 },
        "buttons": {
          "type": "array", "maxItems": 6,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["label", "url"],
            "properties": {
              "label": { "type": "string", "minLength": 1, "maxLength": 60 },
              "url": { "type": "string", "pattern": "^https://", "maxLength": 500 }
            }
          }
        },
        "utm": { "type": ["string", "null"], "pattern": "^\\?utm_[A-Za-z0-9_=&{}.-]{1,200}$" }
      }
    },
    "voice": {
      "type": "object",
      "additionalProperties": false,
      "required": ["skills", "rulesFile"],
      "properties": {
        "skills": { "type": "array", "maxItems": 5, "items": { "type": "string", "pattern": "^[a-z0-9-]{1,60}$" } },
        "rulesFile": { "type": ["string", "null"], "pattern": "^[A-Za-z0-9_./-]{1,120}\\.md$" }
      }
    },
    "examples": { "type": "array", "maxItems": 10, "items": { "type": "string", "pattern": "^\\d{4}\\.\\d{2}\\.\\d{2}_[a-z0-9-]{1,80}$" } }
  }
}
```

- [ ] **Step 2: Write the neutral brand**

```json
{
  "version": 1,
  "name": "Нейтральный",
  "logoRequired": false,
  "logo": null,
  "tokens": {
    "colors": { "background": "#F7F5F0", "surface": "#FFFFFF", "text": "#1C1C1E", "muted": "#6B6B70", "accent": "#2F6FEB" },
    "fonts": { "heading": "Onest", "body": "Onest", "mono": "JetBrains Mono" }
  },
  "fontFiles": [],
  "cta": {
    "title": "Понравилось?",
    "text": "Сохраните страницу и подпишитесь, чтобы не пропустить следующие материалы.",
    "buttons": [],
    "utm": null
  },
  "voice": { "skills": [], "rulesFile": null },
  "examples": []
}
```

Save as `templates/lead-magnet/neutral/brand.json`.

- [ ] **Step 3: Write the failing test**

```js
// tests/lead-magnet-brand.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { defaultTake, resolveBrand } = require('../scripts/lead-magnet/brand');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-brand-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writePack(dir, overrides = {}) {
  const neutral = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', 'lead-magnet', 'neutral', 'brand.json'), 'utf8'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(dir, 'brand.json'), JSON.stringify({ ...neutral, name: 'Мой', logoRequired: true, logo: 'logo.svg', ...overrides }));
}

test('without any pack the neutral brand has no logo', () => {
  const brand = resolveBrand({ env: {} });
  assert.equal(brand.source, 'neutral');
  assert.equal(brand.brand.logoRequired, false);
  assert.deepEqual(defaultTake(brand), { composition: true, colors: true, fonts: true });
});

test('LEAD_MAGNET_BRAND wins; a pack next to THEMES_EXT is found', (t) => {
  const base = tmp(t);
  writePack(path.join(base, 'explicit'));
  writePack(path.join(base, 'pack', 'lead-magnet'), { name: 'Рядом' });
  fs.mkdirSync(path.join(base, 'pack', 'themes'));
  assert.equal(resolveBrand({ env: { LEAD_MAGNET_BRAND: path.join(base, 'explicit') } }).brand.name, 'Мой');
  const sibling = resolveBrand({ env: { THEMES_EXT: path.join(base, 'pack', 'themes') } });
  assert.equal(sibling.source, 'pack');
  assert.equal(sibling.brand.name, 'Рядом');
  assert.equal(sibling.logoPath, path.join(base, 'pack', 'lead-magnet', 'logo.svg'));
  assert.deepEqual(defaultTake(sibling), { composition: true, colors: false, fonts: false });
});

test('an explicit broken pack is an error, a missing sibling falls back to neutral', (t) => {
  const base = tmp(t);
  assert.throws(() => resolveBrand({ env: { LEAD_MAGNET_BRAND: path.join(base, 'nope') } }), /бренд-пак/);
  writePack(path.join(base, 'bad'), { logo: '../../etc/logo.svg' });
  assert.throws(() => resolveBrand({ env: { LEAD_MAGNET_BRAND: path.join(base, 'bad') } }), /бренд-пак/);
  writePack(path.join(base, 'nologo'), { logo: 'missing.svg' });
  assert.throws(() => resolveBrand({ env: { LEAD_MAGNET_BRAND: path.join(base, 'nologo') } }), /логотип/);
  fs.mkdirSync(path.join(base, 'only-themes', 'themes'), { recursive: true });
  assert.equal(resolveBrand({ env: { THEMES_EXT: path.join(base, 'only-themes', 'themes') } }).source, 'neutral');
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node --test tests/lead-magnet-brand.test.js`
Expected: FAIL – `Cannot find module '../scripts/lead-magnet/brand'`.

- [ ] **Step 5: Write minimal implementation**

```js
// scripts/lead-magnet/brand.js
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');

const schema = require('../../schema/lead-magnet-brand.schema.json');
const { resolveProjectPath } = require('../project/workspace');
const { readJsonIfExists } = require('../pult/files');
const { formatAjvErrors } = require('./constants');

const NEUTRAL_DIR = path.resolve(__dirname, '..', '..', 'templates', 'lead-magnet', 'neutral');
const validateBrand = new Ajv({ allErrors: true }).compile(schema);

function loadPack(dir) {
  const brand = readJsonIfExists(path.join(dir, 'brand.json'), 'brand.json бренд-пака');
  if (brand === undefined) throw new Error(`бренд-пак лид-магнитов не найден: ${dir}`);
  if (!validateBrand(brand)) throw new Error(`бренд-пак лид-магнитов: ${formatAjvErrors(validateBrand.errors)}`);
  const inside = (stored, label) => {
    try {
      return resolveProjectPath(dir, stored, { label, mustExist: true, type: 'file' });
    } catch (_) {
      throw new Error(`бренд-пак лид-магнитов: ${label} не найден внутри пакета`);
    }
  };
  if (brand.logoRequired && !brand.logo) throw new Error('бренд-пак лид-магнитов: логотип обязателен, но не указан');
  return {
    brand,
    logoPath: brand.logo ? inside(brand.logo, 'логотип') : null,
    fontPaths: brand.fontFiles.map((file) => inside(file, 'шрифт')),
    rulesPath: brand.voice.rulesFile ? inside(brand.voice.rulesFile, 'файл голоса') : null,
  };
}

// Приватный пакет пользователя никогда не копируется в репозиторий: движок только читает его.
function resolveBrand({ env = process.env } = {}) {
  if (env.LEAD_MAGNET_BRAND) {
    const dir = path.resolve(env.LEAD_MAGNET_BRAND);
    return { source: 'pack', dir, ...loadPack(dir) };
  }
  if (env.THEMES_EXT) {
    const dir = path.join(path.dirname(path.resolve(env.THEMES_EXT)), 'lead-magnet');
    if (fs.existsSync(path.join(dir, 'brand.json'))) return { source: 'pack', dir, ...loadPack(dir) };
  }
  return { source: 'neutral', dir: NEUTRAL_DIR, ...loadPack(NEUTRAL_DIR) };
}

// Решение интервью: есть свой стиль – из референса по умолчанию берём только композицию;
// своего стиля нет – берём всё. Пользователь может переключить галочки в окне.
function defaultTake(resolved) {
  const own = resolved.source === 'pack';
  return { composition: true, colors: !own, fonts: !own };
}

module.exports = { NEUTRAL_DIR, defaultTake, resolveBrand };
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test tests/lead-magnet-brand.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 7: Commit**

```bash
git add schema/lead-magnet-brand.schema.json templates/lead-magnet/neutral/brand.json scripts/lead-magnet/brand.js tests/lead-magnet-brand.test.js
git commit -m "feat(lead-magnet): resolve a private brand pack or the neutral brand

Refs #63"
```

---

### Task 8: Факты и автопроверка каркаса

**Files:**
- Create: `schema/lead-magnet-facts.schema.json`
- Create: `schema/lead-magnet-check.schema.json`
- Create: `scripts/lead-magnet/facts.js`
- Create: `scripts/lead-magnet/check.js`
- Modify: `tests/helpers/lead-magnet-fixtures.js` (добавить `makeLeadMagnet`, `goodPage`, `writeRevision`)
- Test: `tests/lead-magnet-check.test.js`

- [ ] **Step 1: Write the schemas**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Lead magnet fact check report",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "checkedAt", "items"],
  "properties": {
    "version": { "const": 1 },
    "checkedAt": { "type": "string", "minLength": 1 },
    "items": {
      "type": "array", "maxItems": 300,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["claim", "source", "status"],
        "properties": {
          "claim": { "type": "string", "minLength": 1, "maxLength": 400 },
          "source": { "type": "string", "minLength": 1, "maxLength": 600 },
          "status": { "enum": ["verified", "failed", "unverifiable"] },
          "note": { "type": "string", "maxLength": 400 }
        }
      }
    }
  }
}
```

Save as `schema/lead-magnet-facts.schema.json`.

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Lead magnet automatic check report",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "checkedAt", "pageSha256", "ok", "items"],
  "properties": {
    "version": { "const": 1 },
    "checkedAt": { "type": "string", "minLength": 1 },
    "pageSha256": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
    "ok": { "type": "boolean" },
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "ok", "message"],
        "properties": {
          "id": { "type": "string", "pattern": "^[a-z-]{1,40}$" },
          "ok": { "type": "boolean" },
          "message": { "type": "string", "maxLength": 400 }
        }
      }
    }
  }
}
```

Save as `schema/lead-magnet-check.schema.json`.

- [ ] **Step 2: Extend the fixtures**

Append to `tests/helpers/lead-magnet-fixtures.js` (and extend its `module.exports`):

```js
const library = require('../../scripts/lead-magnet/library');

const PARAMS = {
  format: 'guide',
  audience: 'новички',
  design: { mode: 'brand', take: { composition: true, colors: false, fonts: false }, likeId: null, note: '', references: [] },
  texts: ['dm', 'telegram', 'instagram'],
  wishes: '',
  promiseConfirmed: true,
};

// Страница, которая проходит все пункты каркаса. Тесты ломают её по одному пункту.
function goodPage({ quote = QUOTE, prompts = 5, cta = true, copy = true, logo = false, extra = '', wide = false, title = 'Сайт без кода' } = {}) {
  const items = Array.from({ length: prompts }, (_, index) => `
    <div data-lm-code data-lm-item="prompt"><pre>Промпт ${index + 1}</pre>${copy ? '<button data-lm-copy>Скопировать</button>' : ''}</div>`).join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{margin:0;font-family:sans-serif} pre{white-space:pre-wrap}</style></head><body>
<header data-lm-block="hero">${logo ? '<span data-lm="logo"><svg width="10" height="10"></svg></span>' : ''}<h1>${title}</h1><p>«${quote}»</p></header>
<section data-lm-block="steps"><h2>Шаги</h2><p data-lm-item="step">Шаг 1</p>${items}</section>
${wide ? '<div style="width:900px">широко</div>' : ''}${extra}
${cta ? '<section data-lm-block="cta" data-lm="cta"><h2>Понравилось?</h2></section>' : ''}
</body></html>`;
}

function makeLeadMagnet(t) {
  const context = makeVideoProject(t);
  const passport = library.createLeadMagnet(context.projectsDir, {
    codeWord: 'ГАЙД', title: 'Сайт без кода',
    promise: { quote: QUOTE, startSec: 60, endSec: 63.9, sourceFolder: context.folder },
    units: UNITS, params: PARAMS, videoFolder: context.folder,
  });
  return { ...context, id: passport.id };
}

function writeRevision(dir, { page = goodPage(), texts = { dm: 'Привет', telegram: 'Пост', instagram: 'Подпись' }, facts = [] } = {}) {
  fs.writeFileSync(path.join(dir, 'page.html'), page);
  fs.writeFileSync(path.join(dir, 'page.pdf'), '%PDF-1.7');
  fs.writeFileSync(path.join(dir, 'content.md'), '# Сайт без кода');
  for (const [kind, text] of Object.entries(texts)) fs.writeFileSync(path.join(dir, 'texts', `${kind}.txt`), text);
  fs.writeFileSync(path.join(dir, 'facts.json'), JSON.stringify({ version: 1, checkedAt: '2026-09-30T12:00:00.000Z', items: facts }));
}
```

Добавь в конец файла: `module.exports = { PARAMS, QUOTE, UNITS, WORDS, goodPage, makeLeadMagnet, makeVideoProject, writeRevision };`
(замени прежнюю строку `module.exports`).

- [ ] **Step 3: Write the failing test**

```js
// tests/lead-magnet-check.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const { checkRevision } = require('../scripts/lead-magnet/check');
const library = require('../scripts/lead-magnet/library');
const { goodPage, makeLeadMagnet, writeRevision } = require('./helpers/lead-magnet-fixtures');

let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser.close(); });
const launch = async () => ({ newContext: (options) => browser.newContext(options), close: async () => {} });

async function run(t, revisionOptions = {}, env = {}) {
  const { projectsDir, id } = makeLeadMagnet(t);
  const { n, dir } = library.startRevision(projectsDir, id);
  writeRevision(dir, revisionOptions);
  const report = await checkRevision(projectsDir, id, n, { env, launch });
  const byId = Object.fromEntries(report.items.map((item) => [item.id, item]));
  return { report, byId, dir };
}

test('a good page passes every item and gets screenshots', async (t) => {
  const { report, dir } = await run(t);
  assert.equal(report.ok, true, JSON.stringify(report.items.filter((item) => !item.ok)));
  assert.ok(fs.statSync(path.join(dir, 'qa', 'desktop.png')).size > 0);
  assert.ok(fs.statSync(path.join(dir, 'qa', 'phone-390.png')).size > 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'qa', 'check.json'), 'utf8')), report);
});

test('each carcass rule fails on its own defect', async (t) => {
  const cases = [
    [{ page: goodPage({ quote: 'другие слова совсем' }) }, 'promise'],
    [{ page: goodPage({ prompts: 4 }) }, 'promise'],
    [{ page: goodPage({ cta: false }) }, 'cta'],
    [{ page: goodPage({ extra: '<section data-lm="cta"><h2>Второй</h2></section>' }) }, 'cta'],
    [{ page: goodPage({ wide: true }) }, 'phone-width'],
    [{ page: goodPage({ copy: false }) }, 'copy-buttons'],
    [{ page: goodPage({ title: 'Лид-магнит: сайт' }) }, 'header'],
    [{ page: goodPage({ extra: '<img src="https://example.com/x.png">' }) }, 'self-contained'],
    [{ texts: { dm: 'я'.repeat(1001), telegram: 'x', instagram: 'x' } }, 'texts'],
    [{ facts: [{ claim: 'Ссылка работает', source: 'https://example.com', status: 'failed' }] }, 'facts'],
  ];
  for (const [options, id] of cases) {
    const { report, byId } = await run(t, options);
    assert.equal(report.ok, false, id);
    assert.equal(byId[id].ok, false, `${id}: ${JSON.stringify(byId[id])}`);
  }
});

test('the logo is required only when the brand pack says so', async (t) => {
  const packDir = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lm-pack-')), 'lead-magnet');
  t.after(() => fs.rmSync(path.dirname(packDir), { recursive: true, force: true }));
  fs.mkdirSync(packDir);
  const neutral = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', 'lead-magnet', 'neutral', 'brand.json'), 'utf8'));
  fs.writeFileSync(path.join(packDir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(packDir, 'brand.json'), JSON.stringify({ ...neutral, logoRequired: true, logo: 'logo.svg' }));
  const without = await run(t, {}, { LEAD_MAGNET_BRAND: packDir });
  assert.equal(without.byId.logo.ok, false);
  const withLogo = await run(t, { page: goodPage({ logo: true }) }, { LEAD_MAGNET_BRAND: packDir });
  assert.equal(withLogo.byId.logo.ok, true);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node --test tests/lead-magnet-check.test.js`
Expected: FAIL – `Cannot find module '../scripts/lead-magnet/check'`.

- [ ] **Step 5: Write `facts.js`**

```js
// scripts/lead-magnet/facts.js
const path = require('node:path');
const Ajv = require('ajv');

const schema = require('../../schema/lead-magnet-facts.schema.json');
const { readJsonIfExists } = require('../pult/files');

const validateFacts = new Ajv({ allErrors: true }).compile(schema);

// Стоп-кран: любой статус, кроме verified, блокирует утверждение.
function readFacts(revisionPath) {
  const value = readJsonIfExists(path.join(revisionPath, 'facts.json'), 'facts.json');
  if (value === undefined) return { ok: false, message: 'нет отчёта проверки фактов facts.json', items: [] };
  if (!validateFacts(value)) return { ok: false, message: 'facts.json не соответствует схеме', items: [] };
  const bad = value.items.filter((item) => item.status !== 'verified');
  return {
    ok: bad.length === 0,
    message: bad.length ? `не подтверждено: ${bad.map((item) => item.claim).join('; ')}` : `проверено утверждений: ${value.items.length}`,
    items: value.items,
  };
}

module.exports = { readFacts };
```

- [ ] **Step 6: Write `check.js`**

```js
// scripts/lead-magnet/check.js
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const Ajv = require('ajv');

const schema = require('../../schema/lead-magnet-check.schema.json');
const { hashFile, writeJsonAtomic } = require('../pult/files');
const { resolveBrand } = require('./brand');
const { TEXT_FILES, TEXT_LIMITS } = require('./constants');
const { readFacts } = require('./facts');
const { readLeadMagnet, revisionDir } = require('./library');
const { normalizeText } = require('./text');

const validateReport = new Ajv({ allErrors: true }).compile(schema);
const PHONE_WIDTH = 390;

// Выполняется внутри страницы: только чтение DOM, без изменений.
function inspectPage() {
  const items = {};
  for (const element of document.querySelectorAll('[data-lm-item]')) {
    const key = element.getAttribute('data-lm-item');
    items[key] = (items[key] || 0) + 1;
  }
  const ctas = [...document.querySelectorAll('[data-lm="cta"]')];
  const blocks = [...document.querySelectorAll('[data-lm-block]')];
  const ctaIsLast = ctas.length === 1 && blocks.every((block) => block === ctas[0] || block.contains(ctas[0])
    || Boolean(block.compareDocumentPosition(ctas[0]) & Node.DOCUMENT_POSITION_FOLLOWING));
  const pres = [...document.querySelectorAll('pre')];
  const withoutCopy = pres.filter((pre) => {
    const holder = pre.closest('[data-lm-code]');
    return !holder || !holder.querySelector('[data-lm-copy]');
  }).length;
  const heading = document.querySelector('[data-lm-block="hero"], header, h1');
  return {
    text: document.body.innerText,
    items,
    ctaCount: ctas.length,
    ctaIsLast,
    blockIds: blocks.map((block) => block.getAttribute('data-lm-block')),
    pres: pres.length,
    withoutCopy,
    hasLogo: Boolean(document.querySelector('[data-lm="logo"] svg, [data-lm="logo"] img, svg[data-lm="logo"], img[data-lm="logo"]')),
    headerText: `${document.title} ${heading ? heading.textContent : ''}`,
  };
}

function item(id, ok, message) {
  return { id, ok, message };
}

async function checkRevision(projectsDir, id, n, {
  env = process.env,
  now = () => new Date(),
  launch = () => require('playwright').chromium.launch({ headless: true }),
} = {}) {
  const passport = readLeadMagnet(projectsDir, id);
  const dir = revisionDir(projectsDir, id, n);
  const pagePath = path.join(dir, 'page.html');
  const pageUrl = pathToFileURL(pagePath).href;
  const pageSha256 = hashFile(pagePath);
  const { brand } = resolveBrand({ env });
  const external = [];
  const browser = await launch();
  let desktop;
  let phoneWidth;
  try {
    const open = async (viewport, shot) => {
      const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
      try {
        // Самодостаточность: страница не должна тянуть ничего, кроме себя самой и data:/blob:.
        await context.route('**/*', (route) => {
          const url = route.request().url();
          if (url === pageUrl || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
          external.push(url);
          return route.abort();
        });
        const page = await context.newPage();
        await page.goto(pageUrl, { waitUntil: 'load' });
        await page.screenshot({ path: path.join(dir, 'qa', shot), fullPage: true });
        return { info: await page.evaluate(inspectPage), width: await page.evaluate(() => document.documentElement.scrollWidth) };
      } finally {
        await context.close();
      }
    };
    desktop = (await open({ width: 1280, height: 900 }, 'desktop.png')).info;
    phoneWidth = (await open({ width: PHONE_WIDTH, height: 844 }, 'phone-390.png')).width;
  } finally {
    await browser.close();
  }

  const pageText = ` ${normalizeText(desktop.text)} `;
  const quoteOk = !passport.promise.quote || pageText.includes(` ${normalizeText(passport.promise.quote)} `);
  const missingUnits = passport.units.filter((unit) => (desktop.items[unit.key] || 0) < (unit.count || 1));
  const textProblems = passport.params.texts.flatMap((kind) => {
    const file = path.join(dir, ...TEXT_FILES[kind].split('/'));
    const length = fs.existsSync(file) ? [...fs.readFileSync(file, 'utf8')].length : -1;
    if (length < 0) return [`${kind}: нет файла`];
    return length > TEXT_LIMITS[kind] ? [`${kind}: ${length} из ${TEXT_LIMITS[kind]}`] : [];
  });
  const duplicateBlocks = desktop.blockIds.filter((value, index, all) => all.indexOf(value) !== index);
  const facts = readFacts(dir);

  const items = [
    item('promise', quoteOk && missingUnits.length === 0, quoteOk
      ? (missingUnits.length ? `не хватает: ${missingUnits.map((unit) => `${unit.label} (${desktop.items[unit.key] || 0} из ${unit.count || 1})`).join(', ')}` : 'обещание выполнено')
      : 'на странице нет цитаты обещания'),
    item('cta', desktop.ctaCount === 1 && desktop.ctaIsLast, desktop.ctaCount === 1
      ? (desktop.ctaIsLast ? 'блок призыва в конце' : 'блок призыва не последний')
      : `блоков призыва: ${desktop.ctaCount}, нужен ровно один`),
    item('phone-width', phoneWidth <= PHONE_WIDTH, `ширина на телефоне ${phoneWidth} из ${PHONE_WIDTH} px`),
    item('copy-buttons', desktop.withoutCopy === 0, desktop.withoutCopy ? `без кнопки «Скопировать»: ${desktop.withoutCopy}` : `кнопки у всех ${desktop.pres} блоков`),
    item('logo', !brand.logoRequired || desktop.hasLogo, brand.logoRequired ? (desktop.hasLogo ? 'логотип есть' : 'бренд-пак требует логотип') : 'логотип не требуется'),
    item('header', !/лид[\s-]?магнит/i.test(desktop.headerText), 'в шапке нельзя писать «лид-магнит»'),
    item('self-contained', external.length === 0, external.length ? `внешние запросы: ${external.slice(0, 3).join(', ')}` : 'страница самодостаточна'),
    item('blocks', desktop.blockIds.length > 0 && duplicateBlocks.length === 0 && desktop.blockIds.every((value) => /^[a-z0-9][a-z0-9-]{0,60}$/.test(value)),
      duplicateBlocks.length ? `повторяются блоки: ${duplicateBlocks.join(', ')}` : `блоков: ${desktop.blockIds.length}`),
    item('texts', textProblems.length === 0, textProblems.length ? textProblems.join('; ') : 'тексты в лимитах'),
    item('facts', facts.ok, facts.message),
  ];
  const report = { version: 1, checkedAt: now().toISOString(), pageSha256, ok: items.every((entry) => entry.ok), items };
  if (!validateReport(report)) throw new Error('check: отчёт не соответствует схеме');
  writeJsonAtomic(path.join(dir, 'qa', 'check.json'), report);
  return report;
}

module.exports = { PHONE_WIDTH, checkRevision };
```

- [ ] **Step 7: Run test to verify it passes**

Run: `node --test tests/lead-magnet-check.test.js`
Expected: PASS, 3 tests (около 20–40 секунд: реальный Chromium). Если падает `self-contained`
на хорошей странице – проверь, что в `goodPage` нет внешних ресурсов и что сравнение идёт по
`pageUrl` из `pathToFileURL`, а не по пути.

- [ ] **Step 8: Commit**

```bash
git add schema/lead-magnet-facts.schema.json schema/lead-magnet-check.schema.json scripts/lead-magnet/facts.js scripts/lead-magnet/check.js tests/helpers/lead-magnet-fixtures.js tests/lead-magnet-check.test.js
git commit -m "feat(lead-magnet): check the page carcass, self-containment and facts

Refs #63"
```

---

### Task 9: Утверждение ревизии

**Files:**
- Create: `scripts/lead-magnet/approve.js`
- Test: `tests/lead-magnet-approve.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/lead-magnet-approve.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { approveLeadMagnet } = require('../scripts/lead-magnet/approve');
const { addLeadMagnetComment } = require('../scripts/lead-magnet/comments');
const library = require('../scripts/lead-magnet/library');
const { hashFile } = require('../scripts/pult/files');
const { makeLeadMagnet, writeRevision } = require('./helpers/lead-magnet-fixtures');

// Отчёт проверки пишем вручную: здесь проверяется логика утверждения, а не Chromium.
function publish(projectsDir, id, { ok = true } = {}) {
  const { n, dir } = library.startRevision(projectsDir, id);
  writeRevision(dir);
  const pageSha256 = hashFile(path.join(dir, 'page.html'));
  fs.writeFileSync(path.join(dir, 'qa', 'check.json'), JSON.stringify({ version: 1, checkedAt: 'x', pageSha256, ok, items: [] }));
  library.publishRevision(projectsDir, id, n);
  return { n, dir, pageSha256 };
}

function codeOf(fn) {
  try { fn(); } catch (error) { return error.code; }
  return null;
}

test('approval marks the viewed revision approved', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const { n, pageSha256 } = publish(projectsDir, id);
  const passport = approveLeadMagnet(projectsDir, id, { revision: n, expectedPageSha256: pageSha256, confirmViewed: true, now: () => new Date('2026-09-30T15:00:00.000Z') });
  assert.equal(passport.approved, 1);
  assert.equal(passport.revisions[0].status, 'approved');
  assert.equal(passport.revisions[0].approvedAt, '2026-09-30T15:00:00.000Z');
});

test('guards: confirmation, current revision, unchanged page, green check, no pending comments', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const { n, dir, pageSha256 } = publish(projectsDir, id);
  const approve = (overrides = {}) => approveLeadMagnet(projectsDir, id, { revision: n, expectedPageSha256: pageSha256, confirmViewed: true, ...overrides });
  assert.equal(codeOf(() => approve({ confirmViewed: false })), 'CONFIRMATION_REQUIRED');
  assert.equal(codeOf(() => approve({ revision: 2 })), 'REVISION_CHANGED');
  assert.equal(codeOf(() => approve({ expectedPageSha256: 'f'.repeat(64) })), 'PAGE_CHANGED');
  addLeadMagnetComment(projectsDir, id, { revision: n, target: { kind: 'text', text: 'dm' }, text: 'короче' });
  assert.equal(codeOf(() => approve()), 'PENDING_COMMENTS');
  fs.appendFileSync(path.join(dir, 'page.html'), '<!-- changed -->');
  assert.equal(codeOf(() => approve()), 'PAGE_CHANGED');
});

test('a red check blocks approval', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const { n, pageSha256 } = publish(projectsDir, id, { ok: false });
  assert.equal(codeOf(() => approveLeadMagnet(projectsDir, id, { revision: n, expectedPageSha256: pageSha256, confirmViewed: true })), 'CHECK_FAILED');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lead-magnet-approve.test.js`
Expected: FAIL – `Cannot find module '../scripts/lead-magnet/approve'`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/lead-magnet/approve.js
const path = require('node:path');

const { hashFile, readJsonIfExists } = require('../pult/files');
const { countNewLeadMagnetComments } = require('./comments');
const { readLeadMagnet, revisionDir, savePassport } = require('./library');

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Утверждение – решение человека. Эту функцию вызывает только сервер пульта после галочки
// «Я просмотрел страницу и тексты»; у CLI агента команды утверждения нет (tests/lead-magnet-cli.test.js).
function approveLeadMagnet(projectsDir, id, { revision, expectedPageSha256, confirmViewed, now = () => new Date() }) {
  if (confirmViewed !== true) throw fail('CONFIRMATION_REQUIRED', 'Отметьте, что посмотрели страницу и тексты');
  const passport = readLeadMagnet(projectsDir, id);
  const current = passport.revisions.find((item) => item.n === passport.current);
  if (!current || current.n !== revision || current.status !== 'draft') {
    throw fail('REVISION_CHANGED', 'Агент выпустил новую версию – посмотрите её перед утверждением');
  }
  const dir = revisionDir(projectsDir, id, revision);
  const actual = hashFile(path.join(dir, 'page.html'));
  if (actual !== expectedPageSha256 || actual !== current.pageSha256) {
    throw fail('PAGE_CHANGED', 'Страница изменилась – откройте её заново');
  }
  const report = readJsonIfExists(path.join(dir, 'qa', 'check.json'), 'qa/check.json');
  if (!report || report.ok !== true || report.pageSha256 !== actual) {
    throw fail('CHECK_FAILED', 'Проверка каркаса или фактов не пройдена – агент исправит');
  }
  if (countNewLeadMagnetComments(projectsDir, id, revision) > 0) {
    throw fail('PENDING_COMMENTS', 'Есть правки, которые ждут агента');
  }
  const approvedAt = now().toISOString();
  return savePassport(projectsDir, {
    ...passport,
    approved: revision,
    revisions: passport.revisions.map((item) => (item.n === revision ? { ...item, status: 'approved', approvedAt } : item)),
  }, now);
}

module.exports = { approveLeadMagnet };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lead-magnet-approve.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/lead-magnet/approve.js tests/lead-magnet-approve.test.js
git commit -m "feat(lead-magnet): approve a viewed revision behind hash and check guards

Refs #63"
```

---

### Task 10: Статус для карточки

**Files:**
- Create: `scripts/lead-magnet/status.js`
- Test: `tests/lead-magnet-status.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/lead-magnet-status.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const { deriveLeadMagnetStatus } = require('../scripts/lead-magnet/status');

const QUOTE = 'и я пришлю пошаговую инструкцию';
function passport(overrides = {}) {
  return {
    current: null, approved: null, revisions: [],
    promise: { quote: QUOTE, startSec: 1, endSec: 2, sourceFolder: 'clip', acknowledged: [] },
    ...overrides,
  };
}
const draft = { current: 1, revisions: [{ n: 1, status: 'draft' }] };
const approved = { current: 1, approved: 1, revisions: [{ n: 1, status: 'approved' }] };

test('status order: promise changed → comments → approved → draft → building', () => {
  const base = { newComments: 0, checkOk: true, currentQuote: QUOTE };
  assert.deepEqual(deriveLeadMagnetStatus({ ...base, passport: passport() }), { status: 'working', nextStep: 'Агент готовит лид-магнит', approvable: false });
  assert.deepEqual(deriveLeadMagnetStatus({ ...base, passport: passport(draft) }), { status: 'waiting', nextStep: 'Лид-магнит: посмотрите и утвердите', approvable: true });
  assert.equal(deriveLeadMagnetStatus({ ...base, checkOk: false, passport: passport(draft) }).nextStep, 'Лид-магнит: проверка не пройдена – агент исправляет');
  assert.deepEqual(deriveLeadMagnetStatus({ ...base, passport: passport(approved) }), { status: 'ready', nextStep: 'Лид-магнит утверждён', approvable: false });
  assert.deepEqual(deriveLeadMagnetStatus({ ...base, newComments: 2, passport: passport(draft) }), { status: 'working', nextStep: 'Лид-магнит: ждёт агента, правок: 2', approvable: false });
  const changed = deriveLeadMagnetStatus({ ...base, newComments: 2, currentQuote: 'и я пришлю семь промптов', passport: passport(approved) });
  assert.deepEqual(changed, { status: 'waiting', nextStep: 'Обещание в ролике изменилось – проверьте лид-магнит', approvable: false, promiseChanged: true });
});

test('a missing promise counts as changed; acknowledged and punctuation-only changes do not', () => {
  const base = { newComments: 0, checkOk: true, passport: passport(approved) };
  assert.equal(deriveLeadMagnetStatus({ ...base, currentQuote: null }).promiseChanged, true);
  assert.equal(deriveLeadMagnetStatus({ ...base, currentQuote: 'И я пришлю — пошаговую инструкцию!' }).status, 'ready');
  const acknowledged = passport({ ...approved, promise: { ...passport().promise, acknowledged: ['и я пришлю семь промптов'] } });
  assert.equal(deriveLeadMagnetStatus({ ...base, passport: acknowledged, currentQuote: 'и я пришлю семь промптов' }).status, 'ready');
  assert.equal(deriveLeadMagnetStatus({ ...base, currentQuote: undefined }).status, 'ready');
});
```

`currentQuote: undefined` означает «ролик-источник не проверялся» (например, лид-магнит создан без
обещания) – расхождения нет. `null` – обещание у ролика пропало.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lead-magnet-status.test.js`
Expected: FAIL – `Cannot find module '../scripts/lead-magnet/status'`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/lead-magnet/status.js
const { normalizeText } = require('./text');

function promiseChanged(passport, currentQuote) {
  if (currentQuote === undefined || !passport.promise.quote) return false;
  if (currentQuote === null) return true;
  const current = normalizeText(currentQuote);
  return current !== normalizeText(passport.promise.quote) && !passport.promise.acknowledged.includes(current);
}

// Статусы – те же три раздела, что у видео: waiting (ход пользователя), working (ход агента), ready.
function deriveLeadMagnetStatus({ passport, newComments, checkOk, currentQuote }) {
  if (promiseChanged(passport, currentQuote)) {
    return { status: 'waiting', nextStep: 'Обещание в ролике изменилось – проверьте лид-магнит', approvable: false, promiseChanged: true };
  }
  if (newComments > 0) {
    return { status: 'working', nextStep: `Лид-магнит: ждёт агента, правок: ${newComments}`, approvable: false };
  }
  if (passport.approved !== null && passport.approved === passport.current) {
    return { status: 'ready', nextStep: 'Лид-магнит утверждён', approvable: false };
  }
  if (passport.current !== null) {
    return checkOk
      ? { status: 'waiting', nextStep: 'Лид-магнит: посмотрите и утвердите', approvable: true }
      : { status: 'working', nextStep: 'Лид-магнит: проверка не пройдена – агент исправляет', approvable: false };
  }
  return { status: 'working', nextStep: 'Агент готовит лид-магнит', approvable: false };
}

module.exports = { deriveLeadMagnetStatus };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lead-magnet-status.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/lead-magnet/status.js tests/lead-magnet-status.test.js
git commit -m "feat(lead-magnet): derive the card status including a changed promise

Refs #63"
```

---

### Task 11: Состояние воронки

**Files:**
- Create: `schema/lead-magnet-funnel.schema.json`
- Create: `scripts/lead-magnet/funnel.js`
- Test: `tests/lead-magnet-funnel.test.js`

- [ ] **Step 1: Write the schema**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Auto-reply funnel state for a lead magnet",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "provider", "codeWord", "exists", "automationName", "checkedAt"],
  "properties": {
    "version": { "const": 1 },
    "provider": { "enum": ["chatplace"] },
    "codeWord": { "type": "string", "pattern": "^[A-ZА-ЯЁ0-9][A-ZА-ЯЁ0-9 -]{0,39}$" },
    "exists": { "type": "boolean" },
    "automationName": { "type": ["string", "null"], "maxLength": 120 },
    "checkedAt": { "type": "string", "minLength": 1 }
  }
}
```

- [ ] **Step 2: Write the failing test**

```js
// tests/lead-magnet-funnel.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const { readFunnelState, setFunnelState } = require('../scripts/lead-magnet/funnel');
const { makeLeadMagnet } = require('./helpers/lead-magnet-fixtures');

test('funnel state is written by the agent and read by the pult', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  assert.equal(readFunnelState(projectsDir, id), null);
  const state = setFunnelState(projectsDir, id, { provider: 'chatplace', codeWord: 'гайд', exists: true, automationName: 'Гайд → личка' }, { now: () => new Date('2026-09-30T16:00:00.000Z') });
  assert.deepEqual(readFunnelState(projectsDir, id), state);
  assert.equal(state.codeWord, 'ГАЙД');
});

test('unknown provider and control characters are rejected', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  assert.throws(() => setFunnelState(projectsDir, id, { provider: 'other', codeWord: 'ГАЙД', exists: false, automationName: null }), /воронк/);
  assert.throws(() => setFunnelState(projectsDir, id, { provider: 'chatplace', codeWord: 'ГАЙД', exists: true, automationName: 'x\u001b[31m' }), /воронк/);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/lead-magnet-funnel.test.js`
Expected: FAIL – `Cannot find module '../scripts/lead-magnet/funnel'`.

- [ ] **Step 4: Write minimal implementation**

```js
// scripts/lead-magnet/funnel.js
const path = require('node:path');
const Ajv = require('ajv');

const schema = require('../../schema/lead-magnet-funnel.schema.json');
const { readJsonIfExists, writeJsonAtomic } = require('../pult/files');
const { normalizeCodeWord } = require('./constants');
const { leadMagnetDir, readLeadMagnet } = require('./library');

const validateFunnel = new Ajv({ allErrors: true }).compile(schema);
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

function funnelPath(projectsDir, id) {
  return path.join(leadMagnetDir(projectsDir, id), 'funnel.json');
}

// Этап 1 – только чтение: агент проверяет воронку через MCP поставщика и записывает, что увидел.
// Движок сам в сервис не ходит и ключей не читает.
function setFunnelState(projectsDir, id, input, { now = () => new Date() } = {}) {
  readLeadMagnet(projectsDir, id);
  const state = {
    version: 1,
    provider: input.provider,
    codeWord: normalizeCodeWord(input.codeWord),
    exists: input.exists,
    automationName: input.automationName ?? null,
    checkedAt: now().toISOString(),
  };
  if (!validateFunnel(state) || (state.automationName && CONTROL_CHARS.test(state.automationName))) {
    throw new Error('состояние воронки: неверные данные');
  }
  writeJsonAtomic(funnelPath(projectsDir, id), state);
  return state;
}

function readFunnelState(projectsDir, id) {
  const value = readJsonIfExists(funnelPath(projectsDir, id), 'funnel.json');
  if (value === undefined) return null;
  if (!validateFunnel(value)) throw new Error('funnel.json: неверный формат');
  return value;
}

module.exports = { readFunnelState, setFunnelState };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/lead-magnet-funnel.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add schema/lead-magnet-funnel.schema.json scripts/lead-magnet/funnel.js tests/lead-magnet-funnel.test.js
git commit -m "feat(lead-magnet): record the read-only funnel state

Refs #63"
```

---

### Task 12: Входящие агента

**Files:**
- Create: `scripts/lead-magnet/inbox.js`
- Modify: `scripts/pult/inbox.js` (функции `formatInbox`, `parseInboxOptions`, `main`)
- Test: `tests/lead-magnet-inbox.test.js`
- Test (regression): `tests/pult-inbox.test.js` – должен остаться зелёным без изменений

- [ ] **Step 1: Write the failing test**

```js
// tests/lead-magnet-inbox.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { addLeadMagnetComment } = require('../scripts/lead-magnet/comments');
const { buildLeadMagnetInbox, formatLeadMagnetInbox } = require('../scripts/lead-magnet/inbox');
const { addOffer } = require('../scripts/lead-magnet/offers');
const { addDecision, readDecisions } = require('../scripts/lead-magnet/requests');
const { main } = require('../scripts/pult/inbox');
const { PARAMS, QUOTE, UNITS, makeLeadMagnet } = require('./helpers/lead-magnet-fixtures');

function setup(t) {
  const context = makeLeadMagnet(t);
  addOffer(context.projectDir, { codeWord: 'ГАЙД', kind: 'comment-keyword', quote: QUOTE, units: UNITS });
  return context;
}

test('agent work appears in the inbox, automatic decisions do not', (t) => {
  const { projectsDir, projectDir, folder, id } = setup(t);
  addDecision(projectDir, { type: 'decline', offerId: 'o-gayd', codeWord: 'ГАЙД' });
  const create = addDecision(projectDir, { type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: { ...PARAMS, wishes: 'добавь \u001b[31mошибки' } });
  addLeadMagnetComment(projectsDir, id, { revision: 1, target: { kind: 'block', blockId: 'step-2', view: 'phone', rect: { x: 0, y: 0, w: 1, h: 1 } }, text: 'короче' });
  const inbox = buildLeadMagnetInbox({ projectsDir });
  assert.deepEqual(inbox.decisions.map((item) => [item.folder, item.decision.id]), [[folder, create.id]]);
  assert.equal(inbox.comments.length, 1);
  const text = formatLeadMagnetInbox(inbox, { projectsDir, cwd: path.dirname(projectsDir) });
  assert.match(text, /Лид-магнит: запрос `r-[a-f0-9]{8}` на слово «ГАЙД»/);
  assert.match(text, /формат: гайд по шагам/);
  assert.match(text, /к блоку «step-2» \(телефон\): «короче»/);
  assert.doesNotMatch(text, /\u001b/);
});

test('inbox --accept-lead accepts a decision by folder and a comment by lead magnet id', (t) => {
  const { projectsDir, projectDir, folder, id } = setup(t);
  const create = addDecision(projectDir, { type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: PARAMS });
  const comment = addLeadMagnetComment(projectsDir, id, { revision: 1, target: { kind: 'text', text: 'dm' }, text: 'x' });
  const lines = [];
  assert.equal(main(['--projects-dir', projectsDir, '--accept-lead', folder, create.id], { write: (line) => lines.push(line) }), 0);
  assert.equal(readDecisions(projectDir)[0].status, 'accepted');
  assert.equal(main(['--projects-dir', projectsDir, '--accept-lead', id, comment.id], { write: (line) => lines.push(line) }), 0);
  assert.equal(main(['--projects-dir', projectsDir, '--accept-lead', '../x', create.id], { write: (line) => lines.push(line) }), 1);
  assert.equal(buildLeadMagnetInbox({ projectsDir }).comments.length, 0);
});

test('a broken lead-magnet.json of a video is reported, not skipped', (t) => {
  const { projectsDir, projectDir } = setup(t);
  fs.mkdirSync(path.join(projectDir, 'pult'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'pult', 'lead-magnet.json'), '{');
  const inbox = buildLeadMagnetInbox({ projectsDir });
  assert.equal(inbox.broken.length, 1);
  assert.match(formatLeadMagnetInbox(inbox, { projectsDir }), /повреждён/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lead-magnet-inbox.test.js`
Expected: FAIL – `Cannot find module '../scripts/lead-magnet/inbox'`.

- [ ] **Step 3: Write `scripts/lead-magnet/inbox.js`**

```js
// scripts/lead-magnet/inbox.js
const fs = require('node:fs');
const path = require('node:path');

const { isSafeName } = require('../pult/names');
const { readLeadMagnetComments } = require('./comments');
const { listLeadMagnets } = require('./library');
const { readDecisions } = require('./requests');

const FORMAT_NAMES = { guide: 'гайд по шагам', prompts: 'набор промптов', checklist: 'чек-лист', cheatsheet: 'шпаргалка' };
const DESIGN_NAMES = { brand: 'мой стиль', reference: 'по референсу', new: 'новый под тему', like: 'как прошлый' };
const TEXT_NAMES = { dm: 'личка', telegram: 'Telegram', instagram: 'Instagram' };

function strip(value) {
  return String(value).replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ').trim();
}

function videoFolders(projectsDir) {
  let dirents;
  try {
    dirents = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  return dirents.filter((dirent) => dirent.isDirectory() && !dirent.name.startsWith('.') && isSafeName(dirent.name)).map((dirent) => dirent.name);
}

function buildLeadMagnetInbox({ projectsDir }) {
  const decisions = [];
  const broken = [];
  for (const folder of videoFolders(projectsDir)) {
    const file = path.join(projectsDir, folder, 'pult', 'lead-magnet.json');
    if (!fs.existsSync(file)) continue;
    try {
      for (const decision of readDecisions(path.join(projectsDir, folder))) {
        if (decision.status === 'new') decisions.push({ folder, decision });
      }
    } catch (error) {
      broken.push({ where: `${folder}/pult/lead-magnet.json`, error: error.message });
    }
  }
  const comments = [];
  const library = listLeadMagnets(projectsDir);
  for (const problem of library.broken) broken.push({ where: `.lead-magnets/${problem.id}/lead-magnet.json`, error: problem.error });
  for (const passport of library.entries) {
    try {
      for (const comment of readLeadMagnetComments(projectsDir, passport.id)) {
        if (comment.status === 'new') comments.push({ id: passport.id, title: passport.title, comment });
      }
    } catch (error) {
      broken.push({ where: `.lead-magnets/${passport.id}/pult/comments.json`, error: error.message });
    }
  }
  return { decisions, comments, broken };
}

function describeParams(params) {
  const references = params.design.references.map((reference) => (reference.kind === 'url' ? reference.url : reference.path));
  return [
    `формат: ${FORMAT_NAMES[params.format]}`,
    `для кого: «${strip(params.audience) || 'не указано'}»`,
    `дизайн: ${DESIGN_NAMES[params.design.mode]}${params.design.likeId ? ` (${params.design.likeId})` : ''}`,
    references.length ? `референсы: ${references.map((item) => `\`${strip(item)}\``).join(', ')}` : null,
    params.design.mode === 'reference' ? `взять: ${Object.entries(params.design.take).filter(([, on]) => on).map(([key]) => key).join(', ')}` : null,
    params.design.note ? `что нравится: «${strip(params.design.note)}»` : null,
    `тексты: ${params.texts.map((kind) => TEXT_NAMES[kind]).join(', ') || 'нет'}`,
    params.wishes ? `пожелания: «${strip(params.wishes)}»` : null,
  ].filter(Boolean).join('; ');
}

function formatLeadMagnetInbox(inbox, { projectsDir }) {
  const lines = [];
  if (!inbox.decisions.length && !inbox.comments.length && !inbox.broken.length) return '';
  lines.push('## Лид-магниты', '');
  for (const problem of inbox.broken) {
    lines.push(`- Файл лид-магнита повреждён: \`${strip(problem.where)}\` (${strip(problem.error)}). Почини его, затем продолжай.`);
  }
  for (const { folder, decision } of inbox.decisions) {
    const where = `\`${strip(path.join(path.basename(projectsDir), folder))}\``;
    if (decision.type === 'create') {
      const word = decision.codeWord ? `на слово «${strip(decision.codeWord)}»` : 'без обещания в ролике';
      lines.push(`- Лид-магнит: запрос \`${decision.id}\` ${word} из ${where}. ${describeParams(decision.params)}. Собери черновик по навыку lead-magnet.`);
    } else if (decision.type === 'promise-refresh') {
      lines.push(`- Лид-магнит \`${decision.leadMagnetId}\`: обнови под новое обещание из ${where} (\`${decision.id}\`).`);
    } else if (decision.type === 'funnel-check') {
      lines.push(`- Лид-магнит \`${decision.leadMagnetId}\`: проверь воронку автоответа у поставщика (\`${decision.id}\`).`);
    }
  }
  for (const { id, comment } of inbox.comments) {
    const target = comment.target.kind === 'block'
      ? `к блоку «${strip(comment.target.blockId)}» (${comment.target.view === 'phone' ? 'телефон' : 'компьютер'})`
      : `к тексту «${TEXT_NAMES[comment.target.text]}»`;
    const snapshot = comment.snapshot ? ` Снимок: \`${strip(path.join(path.basename(projectsDir), '.lead-magnets', id, comment.snapshot))}\`.` : '';
    lines.push(`- Лид-магнит \`${id}\` v${String(comment.revision).padStart(2, '0')}: правка \`${comment.id}\` ${target}: «${strip(comment.text)}».${snapshot}`);
  }
  lines.push('', 'Запрос или правку лид-магнита после выполнения отметь: `automontage inbox --accept-lead <папка ролика или id лид-магнита> <id>`.');
  return lines.join('\n');
}

module.exports = { buildLeadMagnetInbox, formatLeadMagnetInbox };
```

- [ ] **Step 4: Wire it into `scripts/pult/inbox.js`**

Прочитай файл перед правкой. Внеси четыре точечные замены.

4a. Импорты – после строки `const { readPultState } = require('./state');` добавь:

```js
const { acceptLeadMagnetComment } = require('../lead-magnet/comments');
const { DECISION_ID, LEAD_MAGNET_ID, LM_COMMENT_ID } = require('../lead-magnet/constants');
const { buildLeadMagnetInbox, formatLeadMagnetInbox } = require('../lead-magnet/inbox');
const { acceptDecision } = require('../lead-magnet/requests');
```

4b. В `parseInboxOptions` начальное значение – `{ projectsDir: …, accept: null, acceptLead: null }`,
и перед строкой `throw new Error(\`неизвестная опция ${argument}\`);` вставь:

```js
    if (argument === '--accept-lead') {
      const owner = argv[index + 1];
      const id = argv[index + 2];
      if (typeof id !== 'string' || !(DECISION_ID.test(id) || LM_COMMENT_ID.test(id))) {
        throw new Error('--accept-lead: неверный id запроса или правки');
      }
      const ownerOk = DECISION_ID.test(id) ? isSafeName(owner) : (typeof owner === 'string' && LEAD_MAGNET_ID.test(owner));
      if (!ownerOk) throw new Error('--accept-lead: неверная папка ролика или id лид-магнита');
      options.acceptLead = { owner, id };
      index += 2;
      continue;
    }
```

4c. В `main`, сразу после блока `if (options.accept) { … }`, вставь:

```js
    if (options.acceptLead) {
      const { owner, id } = options.acceptLead;
      if (DECISION_ID.test(id)) {
        const projectDir = path.join(options.projectsDir, owner);
        const stat = fs.lstatSync(projectDir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('папка ролика не найдена');
        acceptDecision(projectDir, id);
      } else {
        acceptLeadMagnetComment(options.projectsDir, owner, id);
      }
      write(`Лид-магнит: ${id} отмечен принятым.`);
      return 0;
    }
```

4d. Там же замени строку вывода

```js
    write(formatInbox(buildInbox({ projectsDir: options.projectsDir }), { projectsDir: options.projectsDir, cwd }));
```

на

```js
    const videoText = formatInbox(buildInbox({ projectsDir: options.projectsDir }), { projectsDir: options.projectsDir, cwd });
    const leadText = formatLeadMagnetInbox(buildLeadMagnetInbox({ projectsDir: options.projectsDir }), { projectsDir: options.projectsDir });
    if (!leadText) write(videoText);
    else write(videoText === 'Во входящих пульта пусто.' ? `# Входящие пульта\n\n${leadText}` : `${videoText}\n\n${leadText}`);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/lead-magnet-inbox.test.js tests/pult-inbox.test.js`
Expected: PASS – новые 3 теста и все прежние тесты входящих без изменений.

- [ ] **Step 6: Commit**

```bash
git add scripts/lead-magnet/inbox.js scripts/pult/inbox.js tests/lead-magnet-inbox.test.js
git commit -m "feat(lead-magnet): show lead magnet requests and comments in the agent inbox

Refs #63"
```

---

### Task 13: CLI `automontage lead-magnet`

**Files:**
- Create: `scripts/lead-magnet/cli.js`
- Modify: `scripts/cli.js` (справка и маршрутизация рядом с `pult`/`inbox`)
- Test: `tests/lead-magnet-cli.test.js`

Команды: `offer add`, `create`, `revision start`, `check`, `revision publish`, `link`,
`promise update`, `funnel set`, `list`, `brand`. **Команды утверждения нет и не будет.**

- [ ] **Step 1: Write the failing test**

```js
// tests/lead-magnet-cli.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { main } = require('../scripts/lead-magnet/cli');
const library = require('../scripts/lead-magnet/library');
const { addDecision } = require('../scripts/lead-magnet/requests');
const { PARAMS, QUOTE, UNITS, makeVideoProject } = require('./helpers/lead-magnet-fixtures');

async function run(argv) {
  const lines = [];
  const code = await main(argv, { write: (line) => lines.push(line) });
  return { code, out: lines.join('\n') };
}

test('agent flow: offer → create from request → revision start → link → list', async (t) => {
  const { projectsDir, projectDir, folder } = makeVideoProject(t);
  const P = ['--projects-dir', projectsDir];
  let result = await run(['offer', 'add', '--project-dir', projectDir, '--code-word', 'гайд', '--kind', 'comment-keyword', '--quote', QUOTE, '--units', JSON.stringify(UNITS)]);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /o-gayd.*1:00/);
  const request = addDecision(projectDir, { type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: PARAMS });
  result = await run(['create', ...P, '--from', folder, request.id, '--title', 'Сайт без кода']);
  assert.equal(result.code, 0, result.out);
  const [passport] = library.listLeadMagnets(projectsDir).entries;
  assert.equal(passport.promise.quote, QUOTE);
  assert.equal(passport.promise.startSec, 60);
  result = await run(['revision', 'start', ...P, '--id', passport.id]);
  assert.match(result.out, /v01/);
  result = await run(['link', ...P, '--id', passport.id, '--folder', 'второй', '--code-word', 'ГАЙД']);
  assert.equal(result.code, 0, result.out);
  result = await run(['list', ...P, '--code-word', 'гайд']);
  assert.match(result.out, new RegExp(passport.id));
});

test('funnel set and brand report work; bad input fails with a message', async (t) => {
  const { projectsDir, projectDir, folder } = makeVideoProject(t);
  const P = ['--projects-dir', projectsDir];
  await run(['offer', 'add', '--project-dir', projectDir, '--code-word', 'ГАЙД', '--kind', 'dm', '--quote', QUOTE, '--units', JSON.stringify(UNITS)]);
  const request = addDecision(projectDir, { type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: PARAMS });
  await run(['create', ...P, '--from', folder, request.id, '--title', 'Сайт']);
  const [{ id }] = library.listLeadMagnets(projectsDir).entries;
  assert.equal((await run(['funnel', 'set', ...P, '--id', id, '--provider', 'chatplace', '--exists', 'yes', '--name', 'Гайд'])).code, 0);
  assert.match((await run(['brand'])).out, /нейтральный|бренд-пак/i);
  const bad = await run(['offer', 'add', '--project-dir', projectDir, '--code-word', 'ГАЙД', '--kind', 'dm', '--quote', 'такого не было сказано', '--units', JSON.stringify(UNITS)]);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /❌ lead-magnet: цитата не найдена/);
});

test('there is no approve command and the CLI never loads the approve module', async () => {
  const result = await run(['approve', '--id', '2026.09.30_gayd']);
  assert.equal(result.code, 1);
  assert.match(result.out, /неизвестная команда/);
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lead-magnet', 'cli.js'), 'utf8');
  assert.doesNotMatch(source, /approve/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lead-magnet-cli.test.js`
Expected: FAIL – `Cannot find module '../scripts/lead-magnet/cli'`.

- [ ] **Step 3: Write minimal implementation**

```js
#!/usr/bin/env node
// scripts/lead-magnet/cli.js
const path = require('node:path');

const { resolveBrand } = require('./brand');
const { checkRevision } = require('./check');
const { setFunnelState } = require('./funnel');
const library = require('./library');
const { addOffer, readOffers } = require('./offers');
const { readDecisions } = require('./requests');

const ROOT = path.resolve(__dirname, '../..');

const HELP = `automontage lead-magnet – команды агента для лид-магнитов

  offer add --project-dir <папка> --code-word <слово> --kind comment-keyword|dm --quote "<цитата>"
            --units '<JSON>' [--format guide|prompts|checklist|cheatsheet] [--audience "<кто>"]
            [--source script --script <файл в папке ролика>]
  create --from <папка ролика> <r-id> --title "<название>"
  revision start --id <id>          revision publish --id <id> --revision <n>
  check --id <id> --revision <n>
  link --id <id> --folder <папка ролика> --code-word <слово>
  promise update --id <id> --from <папка ролика>
  funnel set --id <id> --provider chatplace --exists yes|no [--name "<автоматизация>"]
  list [--code-word <слово>]        brand

Общий флаг: --projects-dir <путь> (по умолчанию projects/ движка).
Утверждает лид-магнит только человек в пульте – такой команды здесь нет.`;

function parseFlags(argv) {
  const flags = { positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith('--')) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${argument} требует значение`);
      flags[argument.slice(2)] = value;
      index += 1;
    } else {
      flags.positional.push(argument);
    }
  }
  flags.projectsDir = path.resolve(flags['projects-dir'] || path.join(ROOT, 'projects'));
  return flags;
}

function need(flags, name) {
  if (!flags[name]) throw new Error(`нужен флаг --${name}`);
  return flags[name];
}

function formatTime(seconds) {
  if (seconds === null) return 'из сценария';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function offerFor(projectsDir, folder, codeWord) {
  const offers = readOffers(path.join(projectsDir, folder));
  return offers.find((offer) => offer.codeWord === codeWord) || null;
}

const COMMANDS = {
  'offer add': (flags, write) => {
    const offer = addOffer(path.resolve(need(flags, 'project-dir')), {
      codeWord: need(flags, 'code-word'),
      kind: need(flags, 'kind'),
      quote: need(flags, 'quote'),
      units: JSON.parse(need(flags, 'units')),
      format: flags.format,
      audience: flags.audience,
      sourceKind: flags.source,
      scriptPath: flags.script,
    });
    write(`Обещание ${offer.id} «${offer.codeWord}» на ${formatTime(offer.startSec)}: «${offer.quote}».`);
  },
  create: (flags, write) => {
    const folder = need(flags, 'from');
    const [decisionId] = flags.positional;
    const decision = readDecisions(path.join(flags.projectsDir, folder)).find((item) => item.id === decisionId && item.type === 'create');
    if (!decision) throw new Error(`запрос ${decisionId} не найден в ${folder}`);
    const offer = decision.offerId ? readOffers(path.join(flags.projectsDir, folder)).find((item) => item.id === decision.offerId) : null;
    const passport = library.createLeadMagnet(flags.projectsDir, {
      codeWord: decision.codeWord || need(flags, 'code-word'),
      title: need(flags, 'title'),
      promise: offer
        ? { quote: offer.quote, startSec: offer.startSec, endSec: offer.endSec, sourceFolder: folder }
        : { quote: null, startSec: null, endSec: null, sourceFolder: folder },
      units: offer ? offer.units : [],
      params: decision.params,
      videoFolder: folder,
    });
    write(`Создан лид-магнит ${passport.id}. Дальше: automontage lead-magnet revision start --id ${passport.id}`);
  },
  'revision start': (flags, write) => {
    const { n, dir } = library.startRevision(flags.projectsDir, need(flags, 'id'));
    write(`Ревизия ${n}: ${dir}`);
  },
  'revision publish': (flags, write) => {
    const passport = library.publishRevision(flags.projectsDir, need(flags, 'id'), Number(need(flags, 'revision')));
    write(`Ревизия ${passport.current} показана в пульте.`);
  },
  check: async (flags, write) => {
    const report = await checkRevision(flags.projectsDir, need(flags, 'id'), Number(need(flags, 'revision')));
    for (const item of report.items) write(`${item.ok ? '✓' : '✕'} ${item.id}: ${item.message}`);
    write(report.ok ? 'Каркас и факты: всё зелёное.' : 'Есть красные пункты – исправь до показа.');
  },
  link: (flags, write) => {
    const passport = library.linkVideo(flags.projectsDir, need(flags, 'id'), { folder: need(flags, 'folder'), codeWord: need(flags, 'code-word') });
    write(`Ролик привязан к ${passport.id}: ${passport.videos.join(', ')}`);
  },
  'promise update': (flags, write) => {
    const id = need(flags, 'id');
    const folder = need(flags, 'from');
    const passport = library.readLeadMagnet(flags.projectsDir, id);
    const offer = passport.codeWords.map((word) => offerFor(flags.projectsDir, folder, word)).find(Boolean);
    if (!offer) throw new Error(`у ролика ${folder} нет обещания со словом лид-магнита`);
    library.updatePromise(flags.projectsDir, id, { quote: offer.quote, startSec: offer.startSec, endSec: offer.endSec, sourceFolder: folder });
    write(`Обещание обновлено: «${offer.quote}». Собери новую ревизию.`);
  },
  'funnel set': (flags, write) => {
    const exists = need(flags, 'exists');
    if (exists !== 'yes' && exists !== 'no') throw new Error('--exists: yes или no');
    const id = need(flags, 'id');
    const passport = library.readLeadMagnet(flags.projectsDir, id);
    const state = setFunnelState(flags.projectsDir, id, {
      provider: need(flags, 'provider'), codeWord: passport.codeWords[0], exists: exists === 'yes', automationName: flags.name || null,
    });
    write(`Воронка на слово ${state.codeWord}: ${state.exists ? 'есть' : 'нет'}.`);
  },
  list: (flags, write) => {
    const entries = flags['code-word'] ? library.findByCodeWord(flags.projectsDir, flags['code-word']) : library.listLeadMagnets(flags.projectsDir).entries;
    if (!entries.length) write('Лид-магнитов нет.');
    for (const item of entries) {
      write(`${item.id} · ${item.codeWords.join(', ')} · ${item.approved !== null ? 'утверждён' : 'в работе'} · роликов: ${item.videos.length}`);
    }
  },
  brand: (flags, write) => {
    const resolved = resolveBrand();
    write(resolved.source === 'pack'
      ? `Бренд-пак «${resolved.brand.name}»: ${resolved.dir}. Логотип ${resolved.brand.logoRequired ? 'обязателен' : 'не обязателен'}.`
      : 'Бренд-пака нет – нейтральный стиль движка, без логотипа.');
  },
};

async function main(argv = process.argv.slice(2), { write = (line) => console.log(line) } = {}) {
  try {
    if (!argv.length || argv[0] === '--help') { write(HELP); return 0; }
    const twoWords = `${argv[0]} ${argv[1] || ''}`;
    const name = COMMANDS[twoWords] ? twoWords : argv[0];
    if (!COMMANDS[name]) throw new Error(`неизвестная команда «${argv[0]}». Справка: automontage lead-magnet --help`);
    await COMMANDS[name](parseFlags(argv.slice(name.split(' ').length)), write);
    return 0;
  } catch (error) {
    write(`❌ lead-magnet: ${error.message}`);
    return 1;
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { main };
```

- [ ] **Step 4: Route it from `scripts/cli.js`**

Прочитай файл. В справке после строки `automontage inbox …` добавь строку:

```text
  automontage lead-magnet --help      лид-магниты: обещание, сборка, проверка (для агента)
```

В условии маршрутизации замени

```js
  if (argv[0] === 'pult' || argv[0] === 'inbox') {
    const script = argv[0] === 'pult' ? 'cli.js' : 'inbox.js';
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'pult', script), ...argv.slice(1)], {
```

на

```js
  if (argv[0] === 'pult' || argv[0] === 'inbox' || argv[0] === 'lead-magnet') {
    const script = {
      pult: ['pult', 'cli.js'],
      inbox: ['pult', 'inbox.js'],
      'lead-magnet': ['lead-magnet', 'cli.js'],
    }[argv[0]];
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', ...script), ...argv.slice(1)], {
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/lead-magnet-cli.test.js tests/cli.test.js && node scripts/cli.js lead-magnet --help`
Expected: PASS; справка печатается и заканчивается строкой «Утверждает лид-магнит только человек в пульте…».

- [ ] **Step 6: Commit**

```bash
git add scripts/lead-magnet/cli.js scripts/cli.js tests/lead-magnet-cli.test.js
git commit -m "feat(lead-magnet): add the agent CLI without an approve command

Refs #63"
```

---

### Task 14: Документация, полный прогон, Issue

**Files:**
- Create: `docs/LEAD-MAGNET.md` (часть 1A: данные и команды; навык и пульт допишут 1B/1C)
- Modify: `ARCHITECTURE.md` (новый раздел «Лид-магниты»), `CHANGELOG.md` (`[Unreleased]` → «Добавлено»),
  `DECISIONS.md` (D-041), `TESTING.md` (тесты `lead-magnet-*`, Chromium для `check`), `README.md`
  (строка команды и переменная `LEAD_MAGNET_BRAND`), `.env.example` (`LEAD_MAGNET_BRAND=` с комментарием)

- [ ] **Step 1: Write `docs/LEAD-MAGNET.md`**

Содержание (простым языком, без личных путей):
1. Что такое лид-магнит в движке и где он живёт — таблица файлов из раздела «Где что лежит» спецификации.
2. Путь агента командами: `offer add` → (пользователь в пульте) → `inbox` → `create` → `revision start`
   → сборка файлов → `check` → `revision publish` → правки → `inbox --accept-lead`.
3. Разметка страницы для проверки: `data-lm-block`, `data-lm="cta"`, `data-lm="logo"`,
   `data-lm-code` + `data-lm-copy` вокруг каждого `<pre>`, `data-lm-item="<ключ>"`.
4. Бренд-пак: `LEAD_MAGNET_BRAND` или папка `lead-magnet/` рядом с `THEMES_EXT`; поля `brand.json`;
   нейтральный бренд без логотипа.
5. Пункты каркаса `check` и что делать при каждом красном пункте.
6. Утверждение — только человек в пульте; у CLI команды нет.

- [ ] **Step 2: Update the living docs**

- `ARCHITECTURE.md`: раздел «Лид-магниты» — модуль `scripts/lead-magnet/`, поток «обещание → решение
  пульта → библиотека → ревизия → check → publish → approve (пульт)», таблица схем.
- `CHANGELOG.md`, `[Unreleased]` → «Добавлено»: «Лид-магниты (часть 1: данные и команды движка):
  обещание с дословной цитатой и таймкодом, библиотека лид-магнитов, автопроверка каркаса и фактов,
  входящие и `automontage lead-magnet`. Экраны пульта и навык агента – в следующих частях.»
- `DECISIONS.md`, D-041 «Лид-магнит: библиотека по кодовому слову и утверждение без CLI» — контекст
  (интервью 2026-09-30), решение, альтернативы (папка внутри ролика; утверждение из чата), последствия.
- `TESTING.md`: `node --test tests/lead-magnet-*.test.js`; тест `check` запускает реальный Chromium
  (`npx playwright install chromium`).
- `README.md` и `.env.example`: `LEAD_MAGNET_BRAND` — необязательный путь к приватному бренд-паку
  лид-магнитов.

- [ ] **Step 3: Full verification**

```bash
npm test
node scripts/check-public-privacy.js --tracked
node scripts/cli.js lead-magnet --help
```

Expected: все тесты зелёные (включая прежние `pult-*`); privacy check passed; справка печатается.

- [ ] **Step 4: Commit**

```bash
git add docs/LEAD-MAGNET.md ARCHITECTURE.md CHANGELOG.md DECISIONS.md TESTING.md README.md .env.example
git commit -m "docs(lead-magnet): document the engine data layer and agent commands

Refs #63"
```

- [ ] **Step 5: Issue и PR (только по просьбе владельца)**

- Комментарий в #63: что сделано в 1A, как проверено (число тестов, Chromium-проверка), что дальше (1B, 1C).
- Push и PR — только после явной просьбы. В описании PR: `Refs #63` (не `Fixes`: задача закрывается после
  выпуска 1.11.0 и живой проверки).

---

## Self-review (выполнено при написании)

- **Покрытие спецификации (часть 1A):** F1 → Task 1–2; F2/F3 (данные решений и окна) → Task 4;
  F4 (данные референсов) → Task 3; F5 → Task 5; F7 → Task 8; F8 → Task 8 (`facts.js`); F10 (данные
  правок) → Task 6; F11 (функция) → Task 9; F12 → Task 10; F13 (данные) → Task 5 (`acknowledgePromise`,
  `updatePromise`) + Task 10; F14 → Task 12; F15 → Task 7; F16 (данные) → Task 11; CLI для F6 → Task 13.
  Экраны F2/F3/F9/F10/F11, маршруты сервера, песочница – часть 1B; навык сборки F6, шаблоны форматов и
  инструкции поставщика Chatplace – часть 1C.
- **Имена сверены:** `readLeadMagnet`, `savePassport`, `revisionDir`, `startRevision`, `publishRevision`,
  `countNewLeadMagnetComments`, `deriveLeadMagnetStatus`, `buildLeadMagnetInbox`, `formatLeadMagnetInbox`
  используются одинаково во всех задачах; `PARAMS`, `QUOTE`, `UNITS`, `goodPage`, `makeLeadMagnet`,
  `writeRevision` экспортируются хелпером с Task 8.
- **Порядок зависимостей:** хелпер `makeVideoProject` появляется в Task 2, `makeLeadMagnet` – в Task 8;
  задачи 6, 7 используют только `makeVideoProject` и собственный код.
