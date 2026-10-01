# Лид-магнит 1B-1 – сервер пульта: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Научить сервер «Пульта роликов» работать с лид-магнитами: сводка в карточках, состояние
для экрана, решения «Разработать / Уже есть готовый / Нет», загрузка референсов, показ страницы
«за стеклом», правки к блокам со снимком, утверждение человеком и «Показать в папке».

**Architecture:** Вся логика лид-магнита в пульте – в двух новых модулях: `scripts/pult/lead-magnet-view.js`
(сводки для карточек и экрана) и `scripts/pult/lead-magnet-routes.js` (HTTP-маршруты). `server.js`
только подключает их в четырёх местах. Страница лид-магнита отдаётся отдельным маршрутом `/lm/page`
по одноразовому пропуску (HMAC от id, номера ревизии и SHA-256 страницы), со своим CSP: `sandbox
allow-scripts`, без сети (`connect-src 'none'`), встраивание только в сам пульт. Главный ключ пульта
в адрес страницы не попадает. Правило «ревизию можно утверждать» выносится из `approve.js` в общую
функцию, чтобы пульт и движок не разошлись.

**Tech Stack:** Node.js 20+ (CommonJS), `node:test`, `node:http`, ffmpeg (вырезка снимка), модуль
`scripts/lead-magnet/` из части 1A.

**Спецификация:** `docs/superpowers/specs/2026-09-30-lead-magnet-design.md` (F2, F3, F4, F9–F14, раздел
«Безопасность»). **Общий план:** `docs/superpowers/plans/2026-09-30-lead-magnet-stage1.md`. **Задача:** #63.
**Следом:** `2026-10-01-lead-magnet-1b2-pult-screens.md` (экраны) опирается на маршруты этого плана.

---

## Подготовка

- [ ] Ветка от ветки с планами (в ней уже есть влитая часть 1A, merge `3c783af`). Работай в основной
  папке проекта: 1C идёт параллельно в отдельной копии (`git worktree`), в эту папку она не заходит.

```bash
git switch docs/lead-magnet-1b-1c-plans && git switch -c feat/lead-magnet-pult-server
git config core.hooksPath .githooks
```

- [ ] Базовая линия: `npm test` – зелёный (≈2,5 мин, `which ffmpeg` → полная сборка
  `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg`).

## Карта файлов

| Файл | Что меняется |
|---|---|
| `scripts/lead-magnet/readiness.js` | **новый:** общее правило «ревизию можно утверждать» |
| `scripts/lead-magnet/approve.js` | использует `revisionReadiness` вместо своей копии правила |
| `scripts/pult/lead-magnet-view.js` | **новый:** индекс библиотеки, сводка лид-магнита, сводка по папке ролика, лёгкая сводка для карточки |
| `scripts/pult/cards.js` | раздел карточки – самое срочное из видео и лид-магнита; `leadMagnetAsk` |
| `scripts/pult/http.js` | `readRawBody` для загрузки файла |
| `scripts/pult/media-cache.js` | `cropImage` – вырезка снимка правки из скриншота проверки |
| `scripts/pult/lead-magnet-routes.js` | **новый:** все маршруты лид-магнита |
| `scripts/pult/server.js` | подключение: `browserCards`, `browserVariant`, `handleMedia`, `route`, параметр `env` |
| `tests/helpers/lead-magnet-fixtures.js` | `publishCheckedRevision`, `addVideoWithOffer`, `PNG_BYTES` |
| `tests/lead-magnet-readiness.test.js` | **новый** |
| `tests/pult-lead-magnet-view.test.js` | **новый** |
| `tests/pult-lead-magnet-server.test.js` | **новый**, пополняется в задачах 3, 5–8 |
| `tests/pult-cards.test.js`, `tests/pult-http.test.js`, `tests/pult-media-cache.test.js` | новые тесты |

**Контракт с частью 1B-2 (экраны).** Экраны пользуются только маршрутами ниже и полями ответов,
описанными в задачах 3 и 5–8:

| Маршрут | Назначение |
|---|---|
| `GET /api/cards` | у варианта – `leadMagnet: { ask, status, nextStep } \| null`; у карточки – `leadMagnetAsk` |
| `GET /api/lead-magnet?key=` | полное состояние для вкладки и окна |
| `POST /api/lead-magnet/decision` | «Разработать», «Нет», «Вернуть вопрос», «Уже есть готовый», «Обновить / Оставить», «Проверить воронку» |
| `POST /api/lead-magnet/reference?key=` | загрузка референса сырыми байтами (`application/octet-stream`) |
| `POST /api/lead-magnet/comment`, `…/comment/delete` | правки к блоку или тексту |
| `POST /api/lead-magnet/approve` | утверждение по пропуску |
| `POST /api/lead-magnet/reveal` | «Показать в папке» для файлов ревизии |
| `GET /lm/page?id=&rev=&ticket=` | страница «за стеклом» (без ключа пульта) |
| `GET /media/lm-snapshot?id=&comment=&token=` | снимок места правки |

Для каждого `magnet` в `GET /api/lead-magnet` поле `promise` содержит
`{ quote, startSec, sourceFolder, current: { state, quote, offerId } }`. `sourceFolder` —
только безопасное имя папки ролика-источника, без пути; для небезопасного значения в паспорте
публичный ответ отдаёт `null` и состояние `unknown`. `current.state` принимает `same`, `changed`,
`missing` или `unknown`. Для `missing` и `unknown` текущие `quote` и `offerId` равны `null`:
`missing` означает читаемый `offers.json` без исходного обещания, `unknown` — недоступный
ролик-источник или файл обещаний. Решения `promise-refresh` и `promise-keep` записываются
только по ключу ролика-источника; `promise-keep` принимает `offerId: null` лишь для
подтверждённого `missing`. Это уточнение контракта одобрено владельцем для задачи 1B-2/6.

---

### Task 1: Общее правило готовности ревизии

**Files:**
- Create: `scripts/lead-magnet/readiness.js`
- Modify: `scripts/lead-magnet/approve.js`
- Modify: `tests/helpers/lead-magnet-fixtures.js`
- Test: `tests/lead-magnet-readiness.test.js`; регрессия – `tests/lead-magnet-approve.test.js` без изменений

- [ ] **Step 1: Extend the fixtures**

В `tests/helpers/lead-magnet-fixtures.js` добавь импорты рядом с существующими:

```js
const { inputFingerprint } = require('../../scripts/lead-magnet/check');
const { addOffer } = require('../../scripts/lead-magnet/offers');
const { hashFile } = require('../../scripts/pult/files');
const { addDraftProject } = require('./pult-projects');
```

и перед строкой `module.exports` добавь:

```js
// Настоящий PNG 1×1: снимкам правок нужна сигнатура PNG, а не текст.
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const CHECK_IDS = ['promise', 'cta', 'phone-width', 'copy-buttons', 'logo', 'header', 'self-contained', 'blocks', 'texts', 'facts'];

// Публикует ревизию с отчётом проверки, записанным вручную: тестам пульта и утверждения
// нужна логика, а не настоящий Chromium (его проверяет tests/lead-magnet-check.test.js).
function publishCheckedRevision(projectsDir, id, { ok = true, facts = [], page } = {}) {
  const { n, dir } = library.startRevision(projectsDir, id);
  writeRevision(dir, page === undefined ? { facts } : { facts, page });
  for (const shot of ['desktop.png', 'phone-390.png']) fs.writeFileSync(path.join(dir, 'qa', shot), PNG_BYTES);
  const pageSha256 = hashFile(path.join(dir, 'page.html'));
  const factsSha256 = hashFile(path.join(dir, 'facts.json'));
  fs.writeFileSync(path.join(dir, 'qa', 'check.json'), JSON.stringify({
    version: 1,
    checkedAt: '2026-10-01T12:00:00.000Z',
    pageSha256,
    factsSha256,
    inputSha256: inputFingerprint(projectsDir, dir, library.readLeadMagnet(projectsDir, id)),
    ok,
    items: CHECK_IDS.map((itemId) => ({ id: itemId, ok, message: 'проверено' })),
  }));
  library.publishRevision(projectsDir, id, n);
  return { n, dir, pageSha256 };
}

// Ролик пульта (настоящий project.json с preview) и обещание из сценария: расшифровка тестам
// пульта не нужна, поэтому источник обещания – script.txt внутри папки ролика.
function addVideoWithOffer(projectsDir, { folder, name = folder, approve = false, final = false, codeWord = 'ГАЙД' } = {}) {
  addDraftProject(projectsDir, { folder, name, approve, final });
  const projectDir = path.join(projectsDir, folder);
  fs.writeFileSync(path.join(projectDir, 'script.txt'), `Финал ролика. ${QUOTE}.`);
  addOffer(projectDir, {
    codeWord, kind: 'comment-keyword', quote: QUOTE, units: UNITS, sourceKind: 'script', scriptPath: 'script.txt', audience: 'новички',
  });
  return projectDir;
}

// Лид-магнит, привязанный к ролику пульта.
function addLeadMagnetFor(projectsDir, folder) {
  return library.createLeadMagnet(projectsDir, {
    codeWord: 'ГАЙД', title: 'Сайт без кода',
    promise: { quote: QUOTE, startSec: null, endSec: null, sourceFolder: folder },
    units: UNITS, params: PARAMS, videoFolder: folder,
  }).id;
}
```

Замени строку `module.exports` на:

```js
module.exports = {
  PARAMS, PNG_BYTES, QUOTE, UNITS, WORDS,
  addLeadMagnetFor, addVideoWithOffer, goodPage, makeLeadMagnet, makeVideoProject, publishCheckedRevision, writeRevision,
};
```

Если `library` в хелпере уже импортирован под этим именем (задача 8 части 1A) – не дублируй импорт.

- [ ] **Step 2: Write the failing test**

```js
// tests/lead-magnet-readiness.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const library = require('../scripts/lead-magnet/library');
const { revisionReadiness } = require('../scripts/lead-magnet/readiness');
const { makeLeadMagnet, publishCheckedRevision } = require('./helpers/lead-magnet-fixtures');

test('a fresh green report of the shown page is ready', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const { n, pageSha256 } = publishCheckedRevision(projectsDir, id);
  const readiness = revisionReadiness(projectsDir, library.readLeadMagnet(projectsDir, id), n);
  assert.equal(readiness.ok, true);
  assert.equal(readiness.pageSha256, pageSha256);
  assert.equal(readiness.items.length, 10);
});

test('changed texts after the check, a red report and a missing page are not ready', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const { n, dir } = publishCheckedRevision(projectsDir, id);
  fs.writeFileSync(path.join(dir, 'texts', 'dm.txt'), 'Текст поменяли после проверки');
  assert.equal(revisionReadiness(projectsDir, library.readLeadMagnet(projectsDir, id), n).ok, false);

  const red = makeLeadMagnet(t);
  const redRevision = publishCheckedRevision(red.projectsDir, red.id, { ok: false });
  const redReadiness = revisionReadiness(red.projectsDir, library.readLeadMagnet(red.projectsDir, red.id), redRevision.n);
  assert.equal(redReadiness.ok, false);
  assert.equal(redReadiness.items.every((item) => item.ok === false), true);

  fs.rmSync(path.join(redRevision.dir, 'page.html'));
  const missing = revisionReadiness(red.projectsDir, library.readLeadMagnet(red.projectsDir, red.id), redRevision.n);
  assert.deepEqual([missing.ok, missing.pageSha256], [false, null]);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/lead-magnet-readiness.test.js`
Expected: FAIL – `Cannot find module '../scripts/lead-magnet/readiness'`.

- [ ] **Step 4: Write `readiness.js`**

```js
// scripts/lead-magnet/readiness.js
const { createHash } = require('node:crypto');
const Ajv = require('ajv');

const checkSchema = require('../../schema/lead-magnet-check.schema.json');
const { inputFingerprint, readChecked } = require('./check');
const { readFacts } = require('./facts');
const { revisionDir } = require('./library');

const validateCheck = new Ajv({ allErrors: true }).compile(checkSchema);
const REQUIRED_CHECKS = new Set(['promise', 'cta', 'phone-width', 'copy-buttons', 'logo', 'header',
  'self-contained', 'blocks', 'texts', 'facts']);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Единое правило «ревизию можно утверждать»: им пользуются и approveLeadMagnet, и пульт.
// Две копии правила рано или поздно разошлись бы – кнопка «Утверждаю» горела бы там,
// где движок откажет.
function revisionReadiness(projectsDir, passport, n) {
  const dir = revisionDir(projectsDir, passport.id, n);
  const pageBytes = readChecked(projectsDir, dir, 'page.html');
  if (pageBytes === null) return { ok: false, pageSha256: null, items: [] };
  const pageSha256 = digest(pageBytes);
  let report = null;
  let facts;
  let factsSha256;
  try {
    report = JSON.parse(readChecked(projectsDir, dir, 'qa/check.json'));
    const factsBytes = readChecked(projectsDir, dir, 'facts.json');
    facts = readFacts(dir, factsBytes);
    if (facts.ok) factsSha256 = digest(factsBytes);
    if (report.inputSha256 !== inputFingerprint(projectsDir, dir, passport)) throw new Error('stale inputs');
  } catch (_) {
    return { ok: false, pageSha256, items: report && Array.isArray(report.items) ? report.items : [] };
  }
  const items = Array.isArray(report.items) ? report.items : [];
  const ok = validateCheck(report) && report.ok === true && report.pageSha256 === pageSha256
    && facts.ok && report.factsSha256 === factsSha256
    && items.length === REQUIRED_CHECKS.size
    && items.every((item) => item.ok === true && REQUIRED_CHECKS.has(item.id))
    && new Set(items.map((item) => item.id)).size === REQUIRED_CHECKS.size;
  return { ok, pageSha256, items };
}

module.exports = { REQUIRED_CHECKS, revisionReadiness };
```

- [ ] **Step 5: Make `approve.js` use it**

Замени содержимое `scripts/lead-magnet/approve.js` целиком:

```js
const { countNewLeadMagnetComments } = require('./comments');
const { readLeadMagnet, savePassport } = require('./library');
const { revisionReadiness } = require('./readiness');

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
  const readiness = revisionReadiness(projectsDir, passport, revision);
  if (readiness.pageSha256 !== expectedPageSha256 || readiness.pageSha256 !== current.pageSha256) {
    throw fail('PAGE_CHANGED', 'Страница изменилась – откройте её заново');
  }
  if (!readiness.ok) throw fail('CHECK_FAILED', 'Проверка каркаса или фактов не пройдена – агент исправит');
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

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test tests/lead-magnet-readiness.test.js tests/lead-magnet-approve.test.js`
Expected: PASS – 2 новых теста и все прежние тесты утверждения без изменений. Если какой-то
прежний тест утверждения ждал другой код ошибки (например, `CHECK_FAILED` там, где теперь
`PAGE_CHANGED` из-за пропавшей страницы), не меняй тест – верни в `approveLeadMagnet` прежний
порядок проверок для этого случая и запиши отклонение.

- [ ] **Step 7: Commit**

```bash
git add scripts/lead-magnet/readiness.js scripts/lead-magnet/approve.js tests/helpers/lead-magnet-fixtures.js tests/lead-magnet-readiness.test.js
git commit -m "refactor(lead-magnet): share the revision readiness rule with the pult

Refs #63"
```

---

### Task 2: Сводка лид-магнитов для пульта

**Files:**
- Create: `scripts/pult/lead-magnet-view.js`
- Test: `tests/pult-lead-magnet-view.test.js`

Правила сводки:
- обещание без решения → `state: 'ask'` (метка «🎁 Лид-магнит?»), раздел карточки не меняет;
- запрос «Разработать», по которому агент ещё не создал лид-магнит (нет паспорта с
  `request.decisionId` этого запроса) → «Агент готовит лид-магнит» (`working`);
- привязанный лид-магнит → его статус из `deriveLeadMagnetStatus`; готовность ревизии –
  только через `revisionReadiness`;
- «обещание изменилось» сравнивается только с роликом-источником (`promise.sourceFolder`);
- повреждённый файл не роняет пульт: сводка получает `error`, карточка – «файл повреждён».

- [ ] **Step 1: Write the failing test**

```js
// tests/pult-lead-magnet-view.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { addOffer } = require('../scripts/lead-magnet/offers');
const { addDecision } = require('../scripts/lead-magnet/requests');
const { attachLeadMagnets, buildLeadMagnetIndex, folderLeadMagnet } = require('../scripts/pult/lead-magnet-view');
const { addDraftProject, makePultRoot } = require('./helpers/pult-projects');
const {
  PARAMS, QUOTE, UNITS, addLeadMagnetFor, addVideoWithOffer, publishCheckedRevision,
} = require('./helpers/lead-magnet-fixtures');

const view = (projectsDir, folder = 'clip') => folderLeadMagnet(projectsDir, folder, buildLeadMagnetIndex(projectsDir));

test('an offer asks; «Нет» hides it; «Разработать» waits for the agent', (t) => {
  const { projectsDir } = makePultRoot(t);
  const projectDir = addVideoWithOffer(projectsDir, { folder: 'clip' });
  let current = view(projectsDir);
  assert.deepEqual(current.offers.map((offer) => [offer.codeWord, offer.state]), [['ГАЙД', 'ask']]);
  assert.equal(current.offers[0].quote, QUOTE);
  assert.equal(current.status, null);
  assert.equal(JSON.stringify(current).includes(projectsDir), false);
  addDecision(projectDir, { type: 'decline', offerId: 'o-gayd', codeWord: 'ГАЙД' });
  assert.equal(view(projectsDir).offers[0].state, 'declined');
  addDecision(projectDir, { type: 'reopen', offerId: 'o-gayd', codeWord: 'ГАЙД' });
  addDecision(projectDir, { type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: PARAMS });
  current = view(projectsDir);
  assert.deepEqual(current.pending, ['ГАЙД']);
  assert.deepEqual([current.status, current.nextStep], ['working', 'Агент готовит лид-магнит']);
});

test('a linked lead magnet reports its status, readiness and a changed promise', (t) => {
  const { projectsDir } = makePultRoot(t);
  const projectDir = addVideoWithOffer(projectsDir, { folder: 'clip' });
  const id = addLeadMagnetFor(projectsDir, 'clip');
  assert.deepEqual(view(projectsDir).magnets.map((magnet) => [magnet.id, magnet.status]), [[id, 'working']]);
  publishCheckedRevision(projectsDir, id);
  let current = view(projectsDir);
  assert.deepEqual([current.status, current.magnets[0].approvable], ['waiting', true]);
  fs.writeFileSync(path.join(projectDir, 'script.txt'), 'Финал. и я пришлю пошаговую инструкцию и семь промптов.');
  addOffer(projectDir, {
    codeWord: 'ГАЙД', kind: 'comment-keyword', quote: 'и я пришлю пошаговую инструкцию и семь промптов',
    units: UNITS, sourceKind: 'script', scriptPath: 'script.txt',
  });
  current = view(projectsDir);
  assert.equal(current.magnets[0].promiseChanged, true);
  assert.equal(current.nextStep, 'Обещание в ролике изменилось – проверьте лид-магнит');
});

test('a red check keeps the lead magnet on the agent side', (t) => {
  const { projectsDir } = makePultRoot(t);
  addVideoWithOffer(projectsDir, { folder: 'clip' });
  const id = addLeadMagnetFor(projectsDir, 'clip');
  publishCheckedRevision(projectsDir, id, { ok: false });
  const [magnet] = view(projectsDir).magnets;
  assert.deepEqual([magnet.status, magnet.approvable], ['working', false]);
});

test('a broken decision file is reported instead of thrown', (t) => {
  const { projectsDir } = makePultRoot(t);
  const projectDir = addVideoWithOffer(projectsDir, { folder: 'clip' });
  fs.mkdirSync(path.join(projectDir, 'pult'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'pult', 'lead-magnet.json'), '{');
  const current = view(projectsDir);
  assert.match(current.error, /повреждён/);
  assert.deepEqual(current.offers, []);
  assert.equal(current.status, 'working');
});

test('cards get a light summary only where there is something to show', (t) => {
  const { projectsDir } = makePultRoot(t);
  addVideoWithOffer(projectsDir, { folder: 'clip' });
  addDraftProject(projectsDir, { folder: 'plain' });
  const [clip, plain] = attachLeadMagnets(projectsDir, [{ folder: 'clip', status: 'working' }, { folder: 'plain', status: 'waiting' }]);
  assert.deepEqual(clip.leadMagnet, { ask: true, status: null, nextStep: null });
  assert.equal(Object.hasOwn(plain, 'leadMagnet'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/pult-lead-magnet-view.test.js`
Expected: FAIL – `Cannot find module '../scripts/pult/lead-magnet-view'`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/pult/lead-magnet-view.js
const path = require('node:path');

const { countNewLeadMagnetComments } = require('../lead-magnet/comments');
const { listLeadMagnets } = require('../lead-magnet/library');
const { readOffers } = require('../lead-magnet/offers');
const { revisionReadiness } = require('../lead-magnet/readiness');
const { offerStates, readDecisions } = require('../lead-magnet/requests');
const { deriveLeadMagnetStatus } = require('../lead-magnet/status');
const { STATUS_ORDER } = require('./status');

const PENDING_STEP = 'Агент готовит лид-магнит';
const BROKEN_STEP = 'Лид-магнит: файл повреждён – попросите агента проверить';
const BROKEN_FOLDER = 'Файл обещаний или решений лид-магнита повреждён – попросите агента проверить';

// Один проход по библиотеке на запрос: какие лид-магниты привязаны к какой папке ролика.
function buildLeadMagnetIndex(projectsDir) {
  const { entries } = listLeadMagnets(projectsDir);
  const byFolder = new Map();
  for (const passport of entries) {
    for (const folder of passport.videos) {
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      byFolder.get(folder).push(passport);
    }
  }
  return { entries, byFolder };
}

// undefined – сравнивать не с чем (не ролик-источник, нет обещаний); null – обещание с этим
// словом из ролика-источника пропало; строка – текущая цитата.
function currentQuoteFor(projectsDir, passport) {
  const folder = passport.promise.sourceFolder;
  if (!folder || !passport.promise.quote) return undefined;
  let offers;
  try {
    offers = readOffers(path.join(projectsDir, folder));
  } catch (_) {
    return undefined;
  }
  if (!offers.length) return undefined;
  const match = offers.find((offer) => passport.codeWords.includes(offer.codeWord));
  return match ? match.quote : null;
}

function magnetSummary(projectsDir, passport) {
  const base = {
    id: passport.id, title: passport.title, codeWords: passport.codeWords, current: passport.current, approved: passport.approved,
  };
  try {
    const newComments = countNewLeadMagnetComments(projectsDir, passport.id);
    const needsCheck = passport.current !== null && passport.current !== passport.approved;
    const checkOk = needsCheck ? revisionReadiness(projectsDir, passport, passport.current).ok : false;
    const status = deriveLeadMagnetStatus({ passport, newComments, checkOk, currentQuote: currentQuoteFor(projectsDir, passport) });
    return { ...base, newComments, error: false, ...status, promiseChanged: Boolean(status.promiseChanged) };
  } catch (_) {
    return { ...base, newComments: 0, error: true, status: 'working', nextStep: BROKEN_STEP, approvable: false, promiseChanged: false };
  }
}

function offerForBrowser({ offer, state, leadMagnetId }) {
  return {
    offerId: offer.id, codeWord: offer.codeWord, kind: offer.kind, quote: offer.quote,
    startSec: offer.startSec, endSec: offer.endSec, units: offer.units, suggest: offer.suggest, state, leadMagnetId,
  };
}

function folderLeadMagnet(projectsDir, folder, index) {
  const projectDir = path.join(projectsDir, folder);
  let states = [];
  let decisions = [];
  let error = null;
  try {
    states = offerStates(projectDir);
    decisions = readDecisions(projectDir);
  } catch (_) {
    states = [];
    decisions = [];
    error = BROKEN_FOLDER;
  }
  const linked = index.byFolder.get(folder) || [];
  const magnets = linked.map((passport) => magnetSummary(projectsDir, passport));
  // Запрос «Разработать» ждёт агента, пока по нему не создан паспорт (create идемпотентен
  // и записывает request.decisionId).
  const created = new Set(index.entries
    .filter((passport) => passport.request && passport.request.folder === folder)
    .map((passport) => passport.request.decisionId));
  const pending = decisions
    .filter((decision) => decision.type === 'create' && decision.status === 'new' && !created.has(decision.id))
    .map((decision) => decision.codeWord);
  const candidates = magnets.map((magnet) => ({ status: magnet.status, nextStep: magnet.nextStep }));
  if (pending.length) candidates.push({ status: 'working', nextStep: PENDING_STEP });
  if (error) candidates.push({ status: 'working', nextStep: BROKEN_STEP });
  const top = candidates.sort((left, right) => STATUS_ORDER[left.status] - STATUS_ORDER[right.status])[0] || null;
  return {
    offers: states.map(offerForBrowser),
    pending,
    magnets,
    error,
    status: top ? top.status : null,
    nextStep: top ? top.nextStep : null,
  };
}

// Лёгкая сводка для /api/cards: только то, что нужно лицу карточки и выбору раздела.
function attachLeadMagnets(projectsDir, entries) {
  let index;
  try {
    index = buildLeadMagnetIndex(projectsDir);
  } catch (_) {
    index = { entries: [], byFolder: new Map() };
  }
  const byFolder = new Map();
  return entries.map((entry) => {
    if (!byFolder.has(entry.folder)) {
      const folderView = folderLeadMagnet(projectsDir, entry.folder, index);
      const ask = folderView.offers.some((offer) => offer.state === 'ask');
      byFolder.set(entry.folder, ask || folderView.status
        ? { ask, status: folderView.status, nextStep: folderView.nextStep }
        : null);
    }
    const leadMagnet = byFolder.get(entry.folder);
    return leadMagnet ? { ...entry, leadMagnet } : entry;
  });
}

module.exports = { attachLeadMagnets, buildLeadMagnetIndex, folderLeadMagnet, magnetSummary };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/pult-lead-magnet-view.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/pult/lead-magnet-view.js tests/pult-lead-magnet-view.test.js
git commit -m "feat(pult): summarize lead magnets per video folder

Refs #63"
```

---

### Task 3: Карточки учитывают лид-магнит

**Files:**
- Modify: `scripts/pult/cards.js`
- Modify: `scripts/pult/server.js` (функции `browserCards`, `browserVariant`)
- Test: `tests/pult-cards.test.js` (новый тест), `tests/pult-lead-magnet-server.test.js` (создать)

Правило F12: карточка встаёт в раздел **самого срочного** из двух дел – видео и лид-магнита.
Статус и подпись самого видео у варианта не меняются: их показывает вкладка «Видео».

- [ ] **Step 1: Write the failing cards test**

Добавь в конец `tests/pult-cards.test.js`:

```js
test('a lead magnet moves the card to its more urgent section without touching the video', () => {
  const sections = buildCards(scan([
    entry({ folder: 'done', leadMagnet: { ask: false, status: 'waiting', nextStep: 'Лид-магнит: посмотрите и утвердите' } }),
    entry({ folder: 'busy', status: 'working', nextStep: 'Агент готовит preview', leadMagnet: { ask: true, status: null, nextStep: null } }),
    entry({ folder: 'calm', leadMagnet: { ask: false, status: 'ready', nextStep: 'Лид-магнит утверждён' } }),
  ]));
  const done = sections.waiting.find((card) => card.id === 'folder:done');
  assert.equal(done.nextStep, 'Лид-магнит: посмотрите и утвердите');
  assert.equal(done.variants[0].status, 'ready');
  const busy = sections.working.find((card) => card.id === 'folder:busy');
  assert.equal(busy.leadMagnetAsk, true);
  assert.equal(busy.nextStep, 'Агент готовит preview');
  const calm = sections.ready.find((card) => card.id === 'folder:calm');
  assert.equal(calm.nextStep, 'Готов – можно забирать');
  assert.equal(calm.leadMagnetAsk, false);
});
```

- [ ] **Step 2: Write the failing server test (new file)**

```js
// tests/pult-lead-magnet-server.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { addDecision } = require('../scripts/lead-magnet/requests');
const { startPultServer } = require('../scripts/pult/server');
const { makePultRoot } = require('./helpers/pult-projects');
const { PARAMS, PNG_BYTES, addVideoWithOffer } = require('./helpers/lead-magnet-fixtures');

function fakeCapture(command, args) {
  if (command === 'ffprobe') {
    return { stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 1080, height: 1920, r_frame_rate: '25/1' }], format: { duration: '4' } }) };
  }
  fs.writeFileSync(args.at(-1), args.at(-1).endsWith('.png') ? PNG_BYTES : 'jpg');
  return { stdout: '' };
}

async function start(t, projectsDir, overrides = {}) {
  const calls = { reveal: [], logs: [] };
  const session = await startPultServer({
    projectsDir,
    idleMs: 0,
    env: {},
    captureImpl: fakeCapture,
    logger: { error: (message) => { calls.logs.push(String(message)); } },
    revealImpl: async (target) => { calls.reveal.push(target); },
    openWindowImpl: async () => {},
    ...overrides,
  });
  t.after(() => session.close());
  return { session, calls };
}

function request(session, pathname, { method = 'GET', token = session.token, origin, json, raw, contentType, headers = {} } = {}) {
  const allHeaders = { ...headers };
  if (token) allHeaders.authorization = `Bearer ${token}`;
  if (origin) allHeaders.origin = origin;
  let payload = null;
  if (json !== undefined || raw !== undefined) {
    payload = raw !== undefined ? Buffer.from(raw) : Buffer.from(JSON.stringify(json));
    allHeaders['content-type'] = contentType || (raw !== undefined ? 'application/octet-stream' : 'application/json');
    allHeaders['content-length'] = payload.length;
  }
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: '127.0.0.1', port: session.server.address().port, path: pathname, method, headers: allHeaders,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        let parsed = null;
        try { parsed = JSON.parse(body.toString('utf8')); } catch (_) { parsed = null; }
        resolve({ status: response.statusCode, headers: response.headers, body, json: parsed });
      });
    });
    outgoing.on('error', reject);
    if (payload) outgoing.write(payload);
    outgoing.end();
  });
}

const get = (session, pathname) => request(session, pathname);
const post = (session, pathname, json) => request(session, pathname, { method: 'POST', origin: session.origin, json });

function root(t, options = {}) {
  const { projectsDir } = makePultRoot(t);
  addVideoWithOffer(projectsDir, { folder: 'clip', name: 'Сайт за вечер', ...options });
  return projectsDir;
}

test('cards carry a light lead magnet summary without paths', async (t) => {
  const projectsDir = root(t, { approve: true, final: true });
  const { session } = await start(t, projectsDir);
  let cards = (await get(session, '/api/cards')).json;
  const ready = cards.ready.find((card) => card.id === 'folder:clip');
  assert.equal(ready.leadMagnetAsk, true);
  assert.deepEqual(ready.variants[0].leadMagnet, { ask: true, status: null, nextStep: null });
  addDecision(path.join(projectsDir, 'clip'), { type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: PARAMS });
  cards = (await get(session, '/api/cards')).json;
  const working = cards.working.find((card) => card.id === 'folder:clip');
  assert.equal(working.nextStep, 'Агент готовит лид-магнит');
  assert.equal(working.variants[0].status, 'ready');
  assert.equal(JSON.stringify(cards).includes(projectsDir), false);
});

module.exports = { get, post, request, root, start };
```

`module.exports` в тест-файле нужен только чтобы следующие задачи дописывали тесты в этот же
файл, пользуясь теми же помощниками; `node --test` его не читает.

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/pult-cards.test.js tests/pult-lead-magnet-server.test.js`
Expected: FAIL – у карточки нет `leadMagnetAsk`, раздел не меняется; `startPultServer` пока не знает `env`.

- [ ] **Step 4: Update `scripts/pult/cards.js`**

После функции `byUrgency` добавь:

```js
// Лид-магнит – вторая работа по тому же ролику: карточка встаёт в раздел самого срочного
// из двух дел, но статус и подпись самого видео у варианта не меняются.
function urgencyOf(variant) {
  const leadStatus = variant.leadMagnet && variant.leadMagnet.status;
  return leadStatus && STATUS_ORDER[leadStatus] < STATUS_ORDER[variant.status] ? leadStatus : variant.status;
}
```

В `buildCards` замени вычисление `status`, `lead` и поле `nextStep`:

```js
    const status = variants
      .map(urgencyOf)
      .sort((left, right) => STATUS_ORDER[left] - STATUS_ORDER[right])[0];
    const lead = variants.find((variant) => urgencyOf(variant) === status);
    // Видео той же срочности важнее подписи лид-магнита: его подпись и показываем.
    const leadNext = lead.status === status ? lead.nextStep : lead.leadMagnet.nextStep;
```

и в объекте карточки:

```js
      nextStep: variants.length > 1 ? `${lead.variantLabel}: ${leadNext}` : leadNext,
      leadMagnetAsk: variants.some((variant) => Boolean(variant.leadMagnet && variant.leadMagnet.ask)),
```

- [ ] **Step 5: Wire it into `scripts/pult/server.js`**

5a. Импорт рядом с остальными:

```js
const { attachLeadMagnets } = require('./lead-magnet-view');
```

5b. В параметры `startPultServer` после `logger = console,` добавь `env = process.env,`
(используется в задаче 5).

5c. В `browserVariant` в возвращаемый объект после `history: …` добавь:

```js
      // Лёгкая сводка лид-магнита (lead-magnet-view.js): без путей и хешей.
      leadMagnet: entry.leadMagnet || null,
```

5d. В `browserCards` замени первую строку

```js
    const sections = buildCards(scanProjects({ projectsDir: resolvedProjectsDir }), {
```

на

```js
    const scan = scanProjects({ projectsDir: resolvedProjectsDir });
    const sections = buildCards({ ...scan, entries: attachLeadMagnets(resolvedProjectsDir, scan.entries) }, {
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test tests/pult-cards.test.js tests/pult-lead-magnet-server.test.js tests/pult-server.test.js`
Expected: PASS – новые тесты и все прежние тесты карточек и сервера.

- [ ] **Step 7: Commit**

```bash
git add scripts/pult/cards.js scripts/pult/server.js tests/pult-cards.test.js tests/pult-lead-magnet-server.test.js
git commit -m "feat(pult): place cards by the more urgent of video and lead magnet

Refs #63"
```

---

### Task 4: Чтение файла из запроса и вырезка снимка

**Files:**
- Modify: `scripts/pult/http.js` (`readRawBody`)
- Modify: `scripts/pult/media-cache.js` (`cropImage`)
- Test: `tests/pult-http.test.js`, `tests/pult-media-cache.test.js` (новые тесты в конце)

- [ ] **Step 1: Write the failing tests**

В конец `tests/pult-http.test.js` (импорт `readRawBody` добавь к существующему `require('../scripts/pult/http')`):

```js
const { Readable } = require('node:stream');

function rawRequest(chunks, headers) {
  const request = Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
  request.headers = headers;
  return request;
}

test('a raw upload is read as bytes under the limit', async () => {
  const bytes = await readRawBody(rawRequest(['ab', 'cd'], { 'content-type': 'application/octet-stream' }), 10);
  assert.deepEqual(bytes, Buffer.from('abcd'));
});

test('a raw upload rejects other types, oversize and empty bodies', async () => {
  const octet = { 'content-type': 'application/octet-stream' };
  await assert.rejects(readRawBody(rawRequest(['x'], { 'content-type': 'application/json' }), 10), { status: 415 });
  await assert.rejects(readRawBody(rawRequest(['x'], { ...octet, 'content-length': '11' }), 10), { status: 413 });
  await assert.rejects(readRawBody(rawRequest(['123456', '78901'], octet), 10), { status: 413 });
  await assert.rejects(readRawBody(rawRequest([], octet), 10), { status: 400 });
});
```

В конец `tests/pult-media-cache.test.js` (импорт `cropImage` добавь к существующему
`require('../scripts/pult/media-cache')`; `fs`, `os`, `path` в файле уже есть – иначе добавь):

```js
function snapshotDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-crop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('cropImage cuts a clamped rectangle and scales it down', (t) => {
  const dir = snapshotDir(t);
  const calls = [];
  const out = path.join(dir, 'snap.png');
  const ok = cropImage(path.join(dir, 'shot.png'), { x: -5, y: 10.4, w: 5000, h: 300 }, out, {
    captureImpl: (command, args) => { calls.push(args); fs.writeFileSync(args.at(-1), 'png'); return { stdout: '' }; },
  });
  assert.equal(ok, true);
  assert.equal(calls[0][calls[0].indexOf('-vf') + 1], "crop='min(1280,iw-0)':'min(300,ih-10)':0:10,scale='min(640,iw)':-2");
});

test('cropImage refuses tiny or invalid rectangles and cleans up after a failure', (t) => {
  const dir = snapshotDir(t);
  const out = path.join(dir, 'snap.png');
  const never = () => { throw new Error('ffmpeg must not run'); };
  assert.equal(cropImage(path.join(dir, 'shot.png'), { x: 0, y: 0, w: 2, h: 2 }, out, { captureImpl: never }), false);
  assert.equal(cropImage(path.join(dir, 'shot.png'), { x: Number.NaN, y: 0, w: 100, h: 100 }, out, { captureImpl: never }), false);
  const failing = (command, args) => { fs.writeFileSync(args.at(-1), 'half'); throw new Error('ffmpeg failed'); };
  assert.equal(cropImage(path.join(dir, 'shot.png'), { x: 0, y: 0, w: 100, h: 100 }, out, { captureImpl: failing }), false);
  assert.equal(fs.existsSync(out), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/pult-http.test.js tests/pult-media-cache.test.js`
Expected: FAIL – `readRawBody is not a function`, `cropImage is not a function`.

- [ ] **Step 3: Implement `readRawBody`**

В `scripts/pult/http.js` после функции `readJsonBody`:

```js
const RAW_CONTENT_TYPE = /^application\/octet-stream$/i;

// Загрузка файла (референс лид-магнита): тело – сырые байты. Заявленный размер проверяется
// до чтения, фактический – по ходу, чтобы 30-мегабайтный предел не превратился в память без дна.
function readRawBody(request, limit) {
  const type = String(request.headers['content-type'] || '');
  if (!RAW_CONTENT_TYPE.test(type)) {
    request.resume();
    return Promise.reject(new PultRequestError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Ожидался файл'));
  }
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    request.resume();
    return Promise.reject(new PultRequestError(413, 'BODY_TOO_LARGE', 'Файл слишком большой'));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    request.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new PultRequestError(413, 'BODY_TOO_LARGE', 'Файл слишком большой'));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (failed) return;
      if (size === 0) {
        reject(new PultRequestError(400, 'EMPTY_BODY', 'Пустой файл'));
        return;
      }
      resolve(Buffer.concat(chunks, size));
    });
    request.on('error', () => {
      if (failed) return;
      failed = true;
      reject(new PultRequestError(400, 'BODY_ERROR', 'Запрос прерван'));
    });
  });
}
```

Добавь `readRawBody` в `module.exports` файла.

- [ ] **Step 4: Implement `cropImage`**

В `scripts/pult/media-cache.js` после `extractFrame`:

```js
// Снимок места правки лид-магнита: вырезает прямоугольник из скриншота проверки (qa/*.png).
// Размер ограничен, крупный кусок уменьшается до 640 px по ширине; провал – без мусора на диске.
function cropImage(sourcePath, rect, outPath, { captureImpl = captureToolResult } = {}) {
  const values = [rect && rect.x, rect && rect.y, rect && rect.w, rect && rect.h];
  if (!values.every(Number.isFinite)) return false;
  const [x, y] = values.slice(0, 2).map((value) => Math.max(0, Math.round(value)));
  const w = Math.min(Math.round(values[2]), 1280);
  const h = Math.min(Math.round(values[3]), 1600);
  if (w < 4 || h < 4) return false;
  try {
    captureImpl('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', path.resolve(sourcePath),
      '-vf', `crop='min(${w},iw-${x})':'min(${h},ih-${y})':${x}:${y},scale='min(640,iw)':-2`,
      '-frames:v', '1',
      outPath,
    ], { maxBuffer: 1024 * 1024, stage: 'pult snapshot', timeout: TOOL_TIMEOUT_MS });
    const ok = fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
    if (!ok) fs.rmSync(outPath, { force: true });
    return ok;
  } catch (_) {
    fs.rmSync(outPath, { force: true });
    return false;
  }
}
```

Добавь `cropImage` в `module.exports` файла.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/pult-http.test.js tests/pult-media-cache.test.js`
Expected: PASS – новые и прежние тесты.

- [ ] **Step 6: Commit**

```bash
git add scripts/pult/http.js scripts/pult/media-cache.js tests/pult-http.test.js tests/pult-media-cache.test.js
git commit -m "feat(pult): read raw uploads and crop review snapshots

Refs #63"
```

---

### Task 5: Маршруты: состояние и решения

**Files:**
- Create: `scripts/pult/lead-magnet-routes.js`
- Modify: `scripts/pult/server.js` (создание маршрутов и одна ветка в `route`)
- Test: `tests/pult-lead-magnet-server.test.js` (дописать)

- [ ] **Step 1: Write the failing tests**

Допиши в `tests/pult-lead-magnet-server.test.js` перед строкой `module.exports` (импорты – в шапку
файла: `const library = require('../scripts/lead-magnet/library');`,
`const { approveLeadMagnet } = require('../scripts/lead-magnet/approve');`,
`const { buildLeadMagnetInbox } = require('../scripts/lead-magnet/inbox');`,
`const { readDecisions } = require('../scripts/lead-magnet/requests');` и расширь импорт фикстур:
`addLeadMagnetFor, publishCheckedRevision, QUOTE`):

```js
function approvedMagnet(projectsDir, folder) {
  addVideoWithOffer(projectsDir, { folder });
  const id = addLeadMagnetFor(projectsDir, folder);
  const { n, pageSha256 } = publishCheckedRevision(projectsDir, id);
  approveLeadMagnet(projectsDir, id, { revision: n, expectedPageSha256: pageSha256, confirmViewed: true });
  return id;
}

test('the video state lists the offer, brand defaults and the approved library, without paths', async (t) => {
  const projectsDir = root(t);
  const libraryId = approvedMagnet(projectsDir, 'other');
  const { session } = await start(t, projectsDir);
  const response = await get(session, '/api/lead-magnet?key=clip');
  assert.equal(response.status, 200);
  const state = response.json;
  assert.deepEqual(state.offers.map((offer) => [offer.codeWord, offer.state, offer.quote]), [['ГАЙД', 'ask', QUOTE]]);
  assert.deepEqual(state.brand, { source: 'neutral', name: 'Нейтральный', logoRequired: false, defaultTake: { composition: true, colors: true, fonts: true } });
  assert.deepEqual(state.library.map((item) => item.id), [libraryId]);
  assert.deepEqual(state.magnets, []);
  assert.equal(JSON.stringify(state).includes(projectsDir), false);
  assert.equal((await get(session, '/api/lead-magnet?key=nope')).status, 404);
});

test('decisions need exact bodies; create reaches the inbox, decline does not', async (t) => {
  const projectsDir = root(t);
  const { session } = await start(t, projectsDir);
  const create = { key: 'clip', type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: PARAMS };
  const created = await post(session, '/api/lead-magnet/decision', create);
  assert.equal(created.status, 201);
  assert.equal(created.json.decision.status, 'new');
  assert.equal(buildLeadMagnetInbox({ projectsDir }).decisions.length, 1);
  const declined = await post(session, '/api/lead-magnet/decision', { key: 'clip', type: 'decline', offerId: 'o-gayd', codeWord: 'ГАЙД' });
  assert.equal(declined.json.decision.status, 'accepted');
  assert.equal(buildLeadMagnetInbox({ projectsDir }).decisions.length, 1);
  assert.equal((await post(session, '/api/lead-magnet/decision', { ...create, extra: 1 })).status, 400);
  const unconfirmed = await post(session, '/api/lead-magnet/decision', { ...create, params: { ...PARAMS, promiseConfirmed: false } });
  assert.equal(unconfirmed.status, 400);
  assert.match(unconfirmed.json.message, /подтвердите/);
  const unknown = await post(session, '/api/lead-magnet/decision', { key: 'clip', type: 'link', offerId: 'o-gayd', codeWord: 'ГАЙД', leadMagnetId: '2026.01.01_net' });
  assert.equal(unknown.status, 400);
  assert.equal((await request(session, '/api/lead-magnet/decision', { method: 'POST', json: create })).status, 403);
  assert.equal((await request(session, '/api/lead-magnet/decision', { method: 'POST', origin: session.origin, token: null, json: create })).status, 401);
  assert.equal(readDecisions(path.join(projectsDir, 'clip')).length, 2);
});

test('«Уже есть готовый» attaches the video to the chosen lead magnet at once', async (t) => {
  const projectsDir = root(t);
  const libraryId = approvedMagnet(projectsDir, 'other');
  const { session } = await start(t, projectsDir);
  const linked = await post(session, '/api/lead-magnet/decision', {
    key: 'clip', type: 'link', offerId: 'o-gayd', codeWord: 'ГАЙД', leadMagnetId: libraryId,
  });
  assert.equal(linked.status, 201);
  assert.deepEqual(library.readLeadMagnet(projectsDir, libraryId).videos, ['other', 'clip']);
  const state = (await get(session, '/api/lead-magnet?key=clip')).json;
  assert.equal(state.offers[0].state, 'linked');
  assert.deepEqual(state.magnets.map((magnet) => [magnet.id, magnet.status]), [[libraryId, 'ready']]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/pult-lead-magnet-server.test.js`
Expected: FAIL – `/api/lead-magnet` отвечает 404/405.

- [ ] **Step 3: Write `scripts/pult/lead-magnet-routes.js` (состояние и решения)**

Файл растёт в задачах 6–8; здесь – его основа.

```js
// scripts/pult/lead-magnet-routes.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, createHmac, randomBytes } = require('node:crypto');

const { approveLeadMagnet } = require('../lead-magnet/approve');
const { defaultTake, resolveBrand } = require('../lead-magnet/brand');
const { checkedFile, readChecked } = require('../lead-magnet/check');
const { addLeadMagnetComment, deleteLeadMagnetComment, readLeadMagnetComments } = require('../lead-magnet/comments');
const { LEAD_MAGNET_ID, LM_COMMENT_ID, TEXT_FILES, TEXT_LIMITS } = require('../lead-magnet/constants');
const { readFacts } = require('../lead-magnet/facts');
const { readFunnelState } = require('../lead-magnet/funnel');
const { leadMagnetDir, readLeadMagnet, revisionDir } = require('../lead-magnet/library');
const { revisionReadiness } = require('../lead-magnet/readiness');
const { REFERENCE_LIMITS, storeReference } = require('../lead-magnet/references');
const { addDecision } = require('../lead-magnet/requests');
const {
  PultRequestError, readJsonBody, readRawBody, safeTokenEqual, send, sendError, sendJson,
} = require('./http');
const { buildLeadMagnetIndex, folderLeadMagnet } = require('./lead-magnet-view');
const { cropImage } = require('./media-cache');

const DECISION_KEYS = {
  create: ['key', 'type', 'offerId', 'codeWord', 'params'],
  decline: ['key', 'type', 'offerId', 'codeWord'],
  reopen: ['key', 'type', 'offerId', 'codeWord'],
  link: ['key', 'type', 'offerId', 'codeWord', 'leadMagnetId'],
  'promise-refresh': ['key', 'type', 'offerId', 'leadMagnetId'],
  'promise-keep': ['key', 'type', 'offerId', 'leadMagnetId'],
  'funnel-check': ['key', 'type', 'leadMagnetId'],
};
const REVEAL_FILES = ['page.html', 'page.pdf', ...Object.values(TEXT_FILES)];
const MAX_REFERENCE = Math.max(...Object.values(REFERENCE_LIMITS));

const bad = () => new PultRequestError(400, 'INVALID_REQUEST', 'Неверный запрос');
const notFound = () => new PultRequestError(404, 'NOT_FOUND', 'Не найдено');
const changed = () => new PultRequestError(409, 'LM_CHANGED', 'Лид-магнит изменился – посмотрите новую версию');
const broken = () => new PultRequestError(409, 'LM_BROKEN', 'Файл лид-магнита повреждён – попросите агента проверить');
const messageOf = (error) => (error && typeof error.message === 'string' ? error.message : '');

function exactKeys(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const actual = Object.keys(body);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function createLeadMagnetRoutes({
  projectsDir, getOrigin, findEntry, projectDirOf, mediaOptions = {}, revealImpl, logger, errorName, env = process.env,
}) {
  const approvalSecret = randomBytes(32);
  const pageSecret = randomBytes(32);
  const sign = (secret, ...parts) => createHmac('sha256', secret).update(parts.join('\0')).digest('base64url');
  const pageTicket = (id, n, sha) => sign(pageSecret, 'page', id, String(n), sha);
  const approvalTicket = (id, n, sha) => sign(approvalSecret, 'approve', id, String(n), sha);

  function passportOr404(id) {
    if (typeof id !== 'string' || !LEAD_MAGNET_ID.test(id)) throw notFound();
    try {
      return readLeadMagnet(projectsDir, id);
    } catch (error) {
      if (/не найден/.test(messageOf(error))) throw notFound();
      throw broken();
    }
  }

  function brandView() {
    try {
      const resolved = resolveBrand({ env });
      return {
        source: resolved.source, name: resolved.brand.name, logoRequired: resolved.brand.logoRequired, defaultTake: defaultTake(resolved),
      };
    } catch (_) {
      return { source: 'error', name: null, logoRequired: false, defaultTake: { composition: true, colors: true, fonts: true } };
    }
  }

  function filesView(passport) {
    const n = passport.approved ?? passport.current;
    if (n === null) return { revision: null, list: [] };
    const dir = revisionDir(projectsDir, passport.id, n);
    const list = REVEAL_FILES.filter((file) => {
      try {
        return fs.existsSync(checkedFile(projectsDir, dir, file));
      } catch (_) {
        return false;
      }
    });
    return { revision: n, list };
  }

  function revisionView(passport, summary) {
    const n = passport.current;
    if (n === null) return null;
    const dir = revisionDir(projectsDir, passport.id, n);
    const readiness = revisionReadiness(projectsDir, passport, n);
    const texts = passport.params.texts.map((kind) => {
      const bytes = readChecked(projectsDir, dir, TEXT_FILES[kind]);
      const text = bytes ? bytes.toString('utf8') : '';
      return { kind, text, length: [...text].length, limit: TEXT_LIMITS[kind] };
    });
    const facts = readFacts(dir, readChecked(projectsDir, dir, 'facts.json'));
    const sha = readiness.pageSha256;
    const revision = passport.revisions.find((item) => item.n === n);
    return {
      n,
      status: revision.status,
      ready: readiness.ok,
      items: readiness.items,
      facts: { ok: facts.ok, message: facts.message, count: facts.items.length },
      texts,
      pageUrl: sha ? `/lm/page?id=${encodeURIComponent(passport.id)}&rev=${n}&ticket=${pageTicket(passport.id, n, sha)}` : null,
      approvalTicket: sha && summary.approvable && readiness.ok ? approvalTicket(passport.id, n, sha) : null,
    };
  }

  function magnetView(passport, summary) {
    let comments = null;
    try {
      comments = readLeadMagnetComments(projectsDir, passport.id);
    } catch (_) {
      comments = null;
    }
    let funnel = null;
    try {
      funnel = readFunnelState(projectsDir, passport.id);
    } catch (_) {
      funnel = null;
    }
    return {
      ...summary,
      promise: { quote: passport.promise.quote, startSec: passport.promise.startSec },
      revision: revisionView(passport, summary),
      files: filesView(passport),
      commentsBroken: comments === null,
      comments: (comments || []).map((comment) => ({
        id: comment.id,
        createdAt: comment.createdAt,
        revision: comment.revision,
        target: comment.target,
        text: comment.text,
        status: comment.status,
        snapshotUrl: comment.snapshot
          ? `/media/lm-snapshot?id=${encodeURIComponent(passport.id)}&comment=${encodeURIComponent(comment.id)}`
          : null,
      })),
      funnel: funnel && {
        provider: funnel.provider, exists: funnel.exists, automationName: funnel.automationName, checkedAt: funnel.checkedAt,
      },
    };
  }

  function stateFor(entry) {
    const index = buildLeadMagnetIndex(projectsDir);
    const view = folderLeadMagnet(projectsDir, entry.folder, index);
    const passports = new Map(index.entries.map((passport) => [passport.id, passport]));
    return {
      brand: brandView(),
      status: view.status,
      nextStep: view.nextStep,
      error: view.error,
      offers: view.offers,
      pending: view.pending,
      magnets: view.magnets.map((summary) => (summary.error ? summary : magnetView(passports.get(summary.id), summary))),
      library: index.entries
        .filter((passport) => passport.approved !== null)
        .map((passport) => ({
          id: passport.id, title: passport.title, codeWords: passport.codeWords, createdAt: passport.createdAt, videos: passport.videos.length,
        })),
    };
  }

  async function postDecision(request, response) {
    const body = await readJsonBody(request);
    const keys = body && typeof body === 'object' ? DECISION_KEYS[body.type] : null;
    if (!keys || !exactKeys(body, keys)) throw bad();
    const entry = findEntry(body.key);
    if (!entry) throw notFound();
    const { key, ...input } = body;
    let decision;
    try {
      decision = addDecision(projectDirOf(entry), input);
    } catch (error) {
      const message = messageOf(error);
      if (/неверный формат|не читается|неверный JSON/.test(message)) throw broken();
      if (/^(лид-магнит|кодовое слово|ссылка на референс)/.test(message)) throw new PultRequestError(400, 'LM_INVALID', message);
      throw error;
    }
    sendJson(response, 201, { decision: { id: decision.id, type: decision.type, status: decision.status } });
  }

  const POST_ROUTES = new Map([
    ['/api/lead-magnet/decision', (url, request, response) => postDecision(request, response)],
  ]);

  async function handleApi(pathname, url, request, response) {
    if (pathname === '/api/lead-magnet' && (request.method === 'GET' || request.method === 'HEAD')) {
      const entry = findEntry(url.searchParams.get('key'));
      if (!entry) throw notFound();
      sendJson(response, 200, stateFor(entry));
      return;
    }
    const handler = request.method === 'POST' ? POST_ROUTES.get(pathname) : null;
    if (!handler) {
      request.resume();
      throw request.method === 'POST' ? notFound() : new PultRequestError(405, 'METHOD_NOT_ALLOWED', 'Метод не поддерживается');
    }
    await handler(url, request, response);
  }

  return { handleApi, POST_ROUTES, internals: { approvalTicket, pageTicket, passportOr404, sign } };
}

module.exports = { DECISION_KEYS, REVEAL_FILES, createLeadMagnetRoutes, exactKeys };
```

Неиспользуемые пока импорты (`os`, `createHash`, `approveLeadMagnet`, комментарии, `storeReference`,
`cropImage`, `send`, `sendError`, `leadMagnetDir`, `LM_COMMENT_ID`, `MAX_REFERENCE`) понадобятся в
задачах 6–8 – оставь их сразу, чтобы задачи не правили шапку файла.

- [ ] **Step 4: Wire the routes into `scripts/pult/server.js`**

4a. Импорт: `const { createLeadMagnetRoutes } = require('./lead-magnet-routes');`

4b. Сразу после функции `findEntry` (её и `projectDirOf` маршруты получают как зависимости):

```js
  // Лид-магниты – отдельный модуль маршрутов (lead-magnet-routes.js); сервер только
  // передаёт ему свои проверенные функции поиска ролика.
  const leadMagnet = createLeadMagnetRoutes({
    projectsDir: resolvedProjectsDir,
    getOrigin: () => origin,
    findEntry,
    projectDirOf,
    mediaOptions,
    revealImpl,
    logger,
    errorName,
    env,
  });
```

4c. В `route()` перед проверкой `if (request.method !== 'POST') {` вставь:

```js
    if (pathname === '/api/lead-magnet' || pathname.startsWith('/api/lead-magnet/')) {
      await leadMagnet.handleApi(pathname, url, request, response);
      return;
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/pult-lead-magnet-server.test.js tests/pult-server.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/pult/lead-magnet-routes.js scripts/pult/server.js tests/pult-lead-magnet-server.test.js
git commit -m "feat(pult): serve lead magnet state and record decisions

Refs #63"
```

---

### Task 6: Загрузка референса

**Files:**
- Modify: `scripts/pult/lead-magnet-routes.js`
- Test: `tests/pult-lead-magnet-server.test.js` (дописать)

- [ ] **Step 1: Write the failing tests**

```js
test('a design reference is uploaded as bytes, stored by hash and usable in a create decision', async (t) => {
  const projectsDir = root(t);
  const { session } = await start(t, projectsDir);
  const uploaded = await request(session, '/api/lead-magnet/reference?key=clip', { method: 'POST', origin: session.origin, raw: PNG_BYTES });
  assert.equal(uploaded.status, 201);
  const { reference } = uploaded.json;
  assert.match(reference.path, /^pult\/lead-magnet-refs\/[a-f0-9]{64}\.png$/);
  assert.ok(fs.existsSync(path.join(projectsDir, 'clip', ...reference.path.split('/'))));
  const params = { ...PARAMS, design: { ...PARAMS.design, mode: 'reference', references: [reference, { kind: 'url', url: 'https://example.com/guide' }] } };
  const created = await post(session, '/api/lead-magnet/decision', { key: 'clip', type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params });
  assert.equal(created.status, 201);
});

test('reference upload refuses spoofed types, wrong content type, oversize, foreign origin and unknown video', async (t) => {
  const projectsDir = root(t);
  const { session } = await start(t, projectsDir);
  const upload = (options) => request(session, '/api/lead-magnet/reference?key=clip', { method: 'POST', origin: session.origin, ...options });
  const spoofed = await upload({ raw: Buffer.from('MZ\u0090\u0000 not an image') });
  assert.deepEqual([spoofed.status, spoofed.json.code], [400, 'REFERENCE_INVALID']);
  assert.equal((await upload({ raw: PNG_BYTES, contentType: 'image/png' })).status, 415);
  const huge = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(30 * 1024 * 1024)]);
  assert.equal((await upload({ raw: huge })).status, 413);
  assert.equal((await request(session, '/api/lead-magnet/reference?key=clip', { method: 'POST', raw: PNG_BYTES })).status, 403);
  assert.equal((await request(session, '/api/lead-magnet/reference?key=nope', { method: 'POST', origin: session.origin, raw: PNG_BYTES })).status, 404);
  assert.equal(fs.existsSync(path.join(projectsDir, 'clip', 'pult', 'lead-magnet-refs')), false);
});

test('an uploaded HTML reference is stored but never served by the pult', async (t) => {
  const projectsDir = root(t);
  const { session } = await start(t, projectsDir);
  const html = Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>');
  const { reference } = (await request(session, '/api/lead-magnet/reference?key=clip', { method: 'POST', origin: session.origin, raw: html })).json;
  assert.match(reference.path, /\.html$/);
  assert.equal((await get(session, `/${reference.path}`)).status, 404);
  assert.equal((await get(session, `/clip/${reference.path}`)).status, 404);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/pult-lead-magnet-server.test.js`
Expected: FAIL – маршрут `/api/lead-magnet/reference` отвечает 404.

- [ ] **Step 3: Implement the route**

В `createLeadMagnetRoutes` перед `const POST_ROUTES` добавь:

```js
  // Ролик выбирается ключом из адреса до чтения тела: неизвестный ролик не стоит 30 МБ трафика.
  async function postReference(url, request, response) {
    const entry = findEntry(url.searchParams.get('key'));
    if (!entry) {
      request.resume();
      throw notFound();
    }
    const bytes = await readRawBody(request, MAX_REFERENCE);
    let reference;
    try {
      reference = storeReference(projectDirOf(entry), bytes);
    } catch (error) {
      if (/^референс:/.test(messageOf(error))) throw new PultRequestError(400, 'REFERENCE_INVALID', messageOf(error));
      throw error;
    }
    sendJson(response, 201, { reference });
  }
```

и в `POST_ROUTES` добавь строку:

```js
    ['/api/lead-magnet/reference', (url, request, response) => postReference(url, request, response)],
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/pult-lead-magnet-server.test.js`
Expected: PASS. Тест на 30 МБ выполняется за доли секунды: отказ по заявленному размеру.

- [ ] **Step 5: Commit**

```bash
git add scripts/pult/lead-magnet-routes.js tests/pult-lead-magnet-server.test.js
git commit -m "feat(pult): upload design references for lead magnets

Refs #63"
```

---

### Task 7: Страница «за стеклом», правки и снимки

**Files:**
- Modify: `scripts/pult/lead-magnet-routes.js`
- Modify: `scripts/pult/server.js` (`route`: `/lm/page` и закрытие; `handleMedia`: `/media/lm-snapshot`)
- Test: `tests/pult-lead-magnet-server.test.js` (дописать)

Страница отдаётся **без ключа пульта**, по пропуску от id, номера ревизии и SHA-256 страницы.
Поменялся хоть байт – пропуск недействителен (404). Заголовки страницы:
- CSP `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:;
  font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none';
  frame-ancestors 'self'; sandbox allow-scripts` – страница исполняет свои скрипты (кнопки
  «Скопировать», галочки), но не видит ни пульт, ни интернет, а встроить её может только пульт;
- сервер добавляет при выдаче (в файл не пишет) маленький скрипт: в «режиме правок» клик по
  блоку `data-lm-block` отправляет пульту `{ type: 'lm-block', blockId, rect }`; клик по ссылке
  не уводит страницу, а сообщает пульту адрес (`lm-link`). Сообщения уходят только на origin пульта.

- [ ] **Step 1: Write the failing tests**

```js
async function publishedMagnet(t) {
  const projectsDir = root(t);
  const id = addLeadMagnetFor(projectsDir, 'clip');
  const published = publishCheckedRevision(projectsDir, id);
  const { session, calls } = await start(t, projectsDir);
  const state = (await get(session, '/api/lead-magnet?key=clip')).json;
  return { projectsDir, id, session, calls, state, ...published };
}

test('the page is served only by its own ticket, sandboxed and offline', async (t) => {
  const { session, state, dir } = await publishedMagnet(t);
  const { pageUrl } = state.magnets[0].revision;
  const page = await request(session, pageUrl, { token: null });
  assert.equal(page.status, 200);
  const csp = page.headers['content-security-policy'];
  for (const directive of ["default-src 'none'", "connect-src 'none'", "frame-ancestors 'self'", 'sandbox allow-scripts']) {
    assert.ok(csp.includes(directive), directive);
  }
  const html = page.body.toString('utf8');
  assert.match(html, /data-lm-block="hero"/);
  // Скрипт правок встроен сервером перед </body>; само слово data-lm-block есть и в странице,
  // поэтому ищем именно строку сообщения скрипта.
  const injected = html.indexOf("type: 'lm-block'");
  assert.ok(injected > 0);
  assert.ok(injected < html.lastIndexOf('</body>'));
  assert.equal((await request(session, pageUrl.replace(/ticket=[^&]+/, 'ticket=wrong'), { token: null })).status, 404);
  assert.equal((await request(session, pageUrl, { method: 'POST', token: null, origin: session.origin, json: {} })).status, 405);
  fs.appendFileSync(path.join(dir, 'page.html'), '<!-- changed -->');
  assert.equal((await request(session, pageUrl, { token: null })).status, 404);
});

test('a block comment gets a snapshot from the QA screenshot; a text comment has none', async (t) => {
  const { id, n, session } = await publishedMagnet(t);
  const block = { kind: 'block', blockId: 'steps', view: 'phone', rect: { x: 0, y: 10, w: 300, h: 200 } };
  const added = await post(session, '/api/lead-magnet/comment', { id, revision: n, target: block, text: 'короче' });
  assert.equal(added.status, 201);
  await post(session, '/api/lead-magnet/comment', { id, revision: n, target: { kind: 'text', text: 'dm' }, text: 'без смайлов' });
  const [onBlock, onText] = (await get(session, '/api/lead-magnet?key=clip')).json.magnets[0].comments;
  assert.ok(onBlock.snapshotUrl);
  assert.equal(onText.snapshotUrl, null);
  const snapshot = await request(session, `${onBlock.snapshotUrl}&token=${encodeURIComponent(session.token)}`, { token: null });
  assert.deepEqual([snapshot.status, snapshot.headers['content-type']], [200, 'image/png']);
  assert.equal((await request(session, onBlock.snapshotUrl, { token: null })).status, 401);
  assert.equal((await post(session, '/api/lead-magnet/comment', { id, revision: 9, target: block, text: 'x' })).status, 400);
  assert.equal((await post(session, '/api/lead-magnet/comment/delete', { id, commentId: onBlock.id })).status, 200);
  assert.equal((await post(session, '/api/lead-magnet/comment/delete', { id, commentId: 'c-zzzzzzzz' })).status, 400);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/pult-lead-magnet-server.test.js`
Expected: FAIL – `/lm/page` отвечает 404, маршрута правок нет.

- [ ] **Step 3: Add the page, snapshot and comment handlers**

В `scripts/pult/lead-magnet-routes.js` над `function createLeadMagnetRoutes` добавь:

```js
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  'sandbox allow-scripts',
].join('; ');

// Выполняется ВНУТРИ страницы лид-магнита (в песочнице, без доступа к пульту). Сервер
// добавляет его при выдаче, в файл ревизии он не пишется.
function reviewScript(pultOrigin) {
  let reviewing = false;
  const style = document.createElement('style');
  style.textContent = '[data-lm-review] [data-lm-block]:hover{outline:2px dashed #f5a524;outline-offset:2px;cursor:crosshair}';
  document.head.append(style);
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || !event.data || event.data.type !== 'lm-review') return;
    reviewing = Boolean(event.data.on);
    document.documentElement.toggleAttribute('data-lm-review', reviewing);
  });
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (link && !link.getAttribute('href').startsWith('#')) {
      event.preventDefault();
      window.parent.postMessage({ type: 'lm-link', href: link.href }, pultOrigin);
      return;
    }
    if (!reviewing) return;
    const block = event.target.closest('[data-lm-block]');
    if (!block) return;
    event.preventDefault();
    event.stopPropagation();
    const box = block.getBoundingClientRect();
    window.parent.postMessage({
      type: 'lm-block',
      blockId: block.getAttribute('data-lm-block'),
      rect: { x: Math.max(0, box.left + window.scrollX), y: Math.max(0, box.top + window.scrollY), w: box.width, h: box.height },
    }, pultOrigin);
  }, true);
}

function injectReview(html, pultOrigin) {
  const tag = `<script>(${reviewScript.toString()})(${JSON.stringify(pultOrigin)});</script>`;
  const at = html.toLowerCase().lastIndexOf('</body>');
  return at === -1 ? `${html}${tag}` : `${html.slice(0, at)}${tag}${html.slice(at)}`;
}
```

Внутри `createLeadMagnetRoutes` перед `const POST_ROUTES` добавь:

```js
  // Страница «за стеклом»: без ключа пульта, только по пропуску, привязанному к байтам страницы.
  function handlePage(url, request, response) {
    const head = request.method === 'HEAD';
    if (request.method !== 'GET' && !head) {
      request.resume();
      sendError(response, 405);
      return;
    }
    const id = url.searchParams.get('id') || '';
    const rawRevision = url.searchParams.get('rev') || '';
    const n = /^\d{1,2}$/.test(rawRevision) ? Number(rawRevision) : 0;
    let html;
    try {
      if (!LEAD_MAGNET_ID.test(id) || n < 1) throw new Error('bad page');
      const passport = readLeadMagnet(projectsDir, id);
      const revision = passport.revisions.find((item) => item.n === n);
      if (!revision || revision.status === 'building') throw new Error('bad page');
      const bytes = readChecked(projectsDir, revisionDir(projectsDir, id, n), 'page.html');
      if (!bytes) throw new Error('bad page');
      const sha = createHash('sha256').update(bytes).digest('hex');
      if (!safeTokenEqual(url.searchParams.get('ticket'), pageTicket(id, n, sha))) throw new Error('bad page');
      html = injectReview(bytes.toString('utf8'), getOrigin());
    } catch (_) {
      sendError(response, 404, head);
      return;
    }
    send(response, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP }, head);
  }

  // Путь снимка правки для /media/lm-snapshot или null (тогда 404).
  function snapshotFile(url) {
    const id = url.searchParams.get('id');
    const commentId = url.searchParams.get('comment');
    if (typeof id !== 'string' || !LEAD_MAGNET_ID.test(id) || typeof commentId !== 'string' || !LM_COMMENT_ID.test(commentId)) return null;
    try {
      const comment = readLeadMagnetComments(projectsDir, id).find((item) => item.id === commentId);
      return comment && comment.snapshot ? checkedFile(projectsDir, leadMagnetDir(projectsDir, id), comment.snapshot) : null;
    } catch (_) {
      return null;
    }
  }

  // Снимок места правки – кусок скриншота проверки той же ревизии и того же вида.
  function snapshotBytes(id, n, target) {
    const shot = target.view === 'phone' ? 'qa/phone-390.png' : 'qa/desktop.png';
    let source;
    try {
      source = checkedFile(projectsDir, revisionDir(projectsDir, id, n), shot);
    } catch (_) {
      return null;
    }
    if (!fs.existsSync(source)) return null;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-lm-snapshot-'));
    try {
      const out = path.join(tmp, 'snapshot.png');
      return cropImage(source, target.rect, out, mediaOptions) ? fs.readFileSync(out) : null;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  async function postComment(request, response) {
    const body = await readJsonBody(request);
    if (!exactKeys(body, ['id', 'revision', 'target', 'text'])) throw bad();
    const passport = passportOr404(body.id);
    const { target } = body;
    const published = Number.isInteger(body.revision) && passport.revisions.some((item) => item.n === body.revision && item.status !== 'building');
    const snapshot = published && target && target.kind === 'block' && target.rect ? snapshotBytes(passport.id, body.revision, target) : null;
    let comment;
    try {
      comment = addLeadMagnetComment(projectsDir, passport.id, { revision: body.revision, target, text: body.text, snapshotBytes: snapshot });
    } catch (error) {
      const message = messageOf(error);
      if (/неверный формат/.test(message)) throw broken();
      if (/^правк/.test(message)) throw new PultRequestError(400, 'LM_COMMENT_INVALID', message);
      throw error;
    }
    sendJson(response, 201, { comment: { id: comment.id, status: comment.status } });
  }

  async function postCommentDelete(request, response) {
    const body = await readJsonBody(request);
    if (!exactKeys(body, ['id', 'commentId']) || typeof body.commentId !== 'string' || !LM_COMMENT_ID.test(body.commentId)) throw bad();
    passportOr404(body.id);
    try {
      deleteLeadMagnetComment(projectsDir, body.id, body.commentId);
    } catch (error) {
      const message = messageOf(error);
      if (/принят/.test(message)) throw new PultRequestError(409, 'COMMENT_ACCEPTED', 'Правка уже принята агентом');
      if (/не найдена/.test(message)) throw notFound();
      throw broken();
    }
    sendJson(response, 200, { deleted: true });
  }
```

В `POST_ROUTES` добавь:

```js
    ['/api/lead-magnet/comment', (url, request, response) => postComment(request, response)],
    ['/api/lead-magnet/comment/delete', (url, request, response) => postCommentDelete(request, response)],
```

и верни из `createLeadMagnetRoutes` ещё две функции:
`return { handleApi, handlePage, snapshotFile, POST_ROUTES, internals: { … } };`

Если `addLeadMagnetComment` части 1A отвечает на неопубликованную ревизию сообщением не на
«правк…», приведи проверку в `postComment` к его фактическому тексту и запиши отклонение –
тест ждёт `400`.

- [ ] **Step 4: Wire `/lm/page` and `/media/lm-snapshot` into `server.js`**

4a. В `route()` замени условие закрывающегося пульта

```js
    if (closing && (pathname.startsWith('/api/') || pathname.startsWith('/media/'))) {
```

на

```js
    if (closing && (pathname.startsWith('/api/') || pathname.startsWith('/media/') || pathname.startsWith('/lm/'))) {
```

4b. Сразу после блока `/api/health` вставь:

```js
    // Страница лид-магнита для iframe: без ключа пульта, по собственному пропуску
    // (lead-magnet-routes.js, handlePage). Проверка Host выше уже пройдена.
    if (pathname === '/lm/page') {
      leadMagnet.handlePage(url, request, response);
      return;
    }
```

4c. В начале `handleMedia` после `const head = …;` вставь:

```js
    if (url.pathname === '/media/lm-snapshot') {
      const snapshot = leadMagnet.snapshotFile(url);
      if (!snapshot) {
        sendError(response, 404, head);
        return;
      }
      serveFile(request, response, snapshot);
      return;
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/pult-lead-magnet-server.test.js tests/pult-server.test.js tests/pult-http.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/pult/lead-magnet-routes.js scripts/pult/server.js tests/pult-lead-magnet-server.test.js
git commit -m "feat(pult): serve the sandboxed lead magnet page and take block comments

Refs #63"
```

---

### Task 8: Утверждение и «Показать в папке»

**Files:**
- Modify: `scripts/pult/lead-magnet-routes.js`
- Test: `tests/pult-lead-magnet-server.test.js` (дописать)

- [ ] **Step 1: Write the failing tests**

```js
test('approval needs the checkbox and the ticket of the viewed revision', async (t) => {
  const { projectsDir, id, n, session, state } = await publishedMagnet(t);
  const ticket = state.magnets[0].revision.approvalTicket;
  assert.ok(ticket);
  const approve = (body) => post(session, '/api/lead-magnet/approve', { id, ticket, confirmViewed: true, ...body });
  assert.equal((await approve({ confirmViewed: false })).status, 400);
  const stale = await approve({ ticket: 'stale' });
  assert.deepEqual([stale.status, stale.json.code], [409, 'LM_CHANGED']);
  assert.equal((await approve({})).status, 201);
  assert.equal(library.readLeadMagnet(projectsDir, id).approved, n);
  const after = (await get(session, '/api/lead-magnet?key=clip')).json.magnets[0];
  assert.deepEqual([after.status, after.revision.approvalTicket], ['ready', null]);
  assert.equal((await approve({})).status, 409);
});

test('a comment that arrives before approval and a red check both block it', async (t) => {
  const { id, n, session, state } = await publishedMagnet(t);
  const { approvalTicket: ticket } = state.magnets[0].revision;
  await post(session, '/api/lead-magnet/comment', { id, revision: n, target: { kind: 'text', text: 'dm' }, text: 'короче' });
  const pending = await post(session, '/api/lead-magnet/approve', { id, ticket, confirmViewed: true });
  assert.deepEqual([pending.status, pending.json.code], [409, 'LM_PENDING_COMMENTS']);

  const projectsDir = root(t);
  const redId = addLeadMagnetFor(projectsDir, 'clip');
  publishCheckedRevision(projectsDir, redId, { ok: false });
  const red = await start(t, projectsDir);
  const redState = (await get(red.session, '/api/lead-magnet?key=clip')).json.magnets[0];
  assert.equal(redState.revision.approvalTicket, null);
  assert.equal(redState.revision.ready, false);
  assert.equal((await post(red.session, '/api/lead-magnet/approve', { id: redId, ticket: 'x', confirmViewed: true })).status, 409);
});

test('«Показать в папке» opens only whitelisted files of the shown revision', async (t) => {
  const { id, session, calls, state } = await publishedMagnet(t);
  assert.deepEqual(state.magnets[0].files, {
    revision: 1, list: ['page.html', 'page.pdf', 'texts/dm.txt', 'texts/telegram.txt', 'texts/instagram.txt'],
  });
  assert.equal((await post(session, '/api/lead-magnet/reveal', { id, file: 'page.pdf' })).status, 200);
  assert.match(calls.reveal[0], /v01[\\/]page\.pdf$/);
  assert.equal((await post(session, '/api/lead-magnet/reveal', { id, file: '../lead-magnet.json' })).status, 400);
  assert.equal((await post(session, '/api/lead-magnet/reveal', { id: '2026.01.01_net', file: 'page.pdf' })).status, 404);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/pult-lead-magnet-server.test.js`
Expected: FAIL – маршрутов `approve` и `reveal` нет.

- [ ] **Step 3: Implement the handlers**

Внутри `createLeadMagnetRoutes` перед `const POST_ROUTES`:

```js
  // Утверждение – только по пропуску той ревизии, которую показала страница, и только после
  // галочки. Пропуск выдаётся лишь для зелёной ревизии в статусе «посмотрите и утвердите».
  async function postApprove(request, response) {
    const body = await readJsonBody(request);
    if (!exactKeys(body, ['id', 'ticket', 'confirmViewed'])) throw bad();
    if (body.confirmViewed !== true) {
      throw new PultRequestError(400, 'CONFIRMATION_REQUIRED', 'Отметьте, что посмотрели страницу и тексты');
    }
    const passport = passportOr404(body.id);
    const n = passport.current;
    if (n === null) throw changed();
    const readiness = revisionReadiness(projectsDir, passport, n);
    const expected = readiness.pageSha256 ? approvalTicket(passport.id, n, readiness.pageSha256) : null;
    if (!expected || !safeTokenEqual(body.ticket, expected)) throw changed();
    try {
      approveLeadMagnet(projectsDir, passport.id, { revision: n, expectedPageSha256: readiness.pageSha256, confirmViewed: true });
    } catch (error) {
      const code = error && error.code;
      if (code === 'REVISION_CHANGED' || code === 'PAGE_CHANGED') throw changed();
      if (code === 'CHECK_FAILED') throw new PultRequestError(422, 'LM_CHECK_FAILED', 'Проверка каркаса или фактов не пройдена – агент исправит');
      if (code === 'PENDING_COMMENTS') throw new PultRequestError(409, 'LM_PENDING_COMMENTS', 'Есть правки, которые ждут агента');
      logger.error(`Пульт: лид-магнит не утверждён (${errorName(error)})`);
      throw error;
    }
    sendJson(response, 201, { ok: true });
  }

  async function postReveal(request, response) {
    const body = await readJsonBody(request);
    if (!exactKeys(body, ['id', 'file']) || !REVEAL_FILES.includes(body.file)) throw bad();
    const passport = passportOr404(body.id);
    const { revision, list } = filesView(passport);
    if (revision === null || !list.includes(body.file)) throw notFound();
    const target = checkedFile(projectsDir, revisionDir(projectsDir, passport.id, revision), body.file);
    try {
      await revealImpl(target);
    } catch (error) {
      logger.error(`Пульт: не удалось открыть папку лид-магнита (${errorName(error)})`);
      throw new PultRequestError(409, 'REVEAL_FAILED', 'Не удалось открыть папку');
    }
    sendJson(response, 200, { ok: true });
  }
```

В `POST_ROUTES`:

```js
    ['/api/lead-magnet/approve', (url, request, response) => postApprove(request, response)],
    ['/api/lead-magnet/reveal', (url, request, response) => postReveal(request, response)],
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/pult-lead-magnet-server.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/pult/lead-magnet-routes.js tests/pult-lead-magnet-server.test.js
git commit -m "feat(pult): approve lead magnets by ticket and reveal their files

Refs #63"
```

---

### Task 9: Документация и полный прогон

**Files:**
- Modify: `ARCHITECTURE.md` (раздел «Лид-магниты» – подраздел «Пульт»), `DECISIONS.md` (D-042),
  `CHANGELOG.md` (`[Unreleased]` → «Добавлено»), `TESTING.md`, `docs/LEAD-MAGNET.md`
  (абзац «Пульт» – что умеет сервер; экраны – в 1B-2)

- [ ] **Step 1: Write the docs**

- `ARCHITECTURE.md`: модули `scripts/pult/lead-magnet-view.js` и `scripts/pult/lead-magnet-routes.js`,
  таблица маршрутов из раздела «Контракт с частью 1B-2» этого плана, правило «раздел карточки –
  самое срочное из видео и лид-магнита», `revisionReadiness` как единое правило готовности.
- `DECISIONS.md`, **D-042 «Страница лид-магнита в пульте – за стеклом по своему пропуску»**:
  контекст (страницу собирает агент, в ней скрипты; главный ключ пульта нельзя класть в адрес
  iframe), решение (`/lm/page` по HMAC-пропуску, CSP `sandbox allow-scripts` + `connect-src 'none'`
  + `frame-ancestors 'self'`, скрипт правок добавляется при выдаче), альтернативы (скриншоты вместо
  живой страницы; открыть в обычном браузере), последствия (кнопки страницы проверяются руками;
  ссылки страницы в пульте не открываются, а показываются).
- `CHANGELOG.md`: «Пульт: сервер лид-магнитов – сводка в карточках, загрузка референсов,
  страница за стеклом, правки к блокам со снимком, утверждение по пропуску (экраны – следующей
  частью)».
- `TESTING.md`: новые тест-файлы `lead-magnet-readiness`, `pult-lead-magnet-view`,
  `pult-lead-magnet-server`.

- [ ] **Step 2: Full verification**

```bash
npm test
node scripts/check-public-privacy.js --tracked
```

Expected: всё зелёное, включая прежние `pult-*` и `lead-magnet-*`; privacy check passed.

- [ ] **Step 3: Commit**

```bash
git add ARCHITECTURE.md DECISIONS.md CHANGELOG.md TESTING.md docs/LEAD-MAGNET.md
git commit -m "docs(pult): document the lead magnet server routes

Refs #63"
```

- [ ] **Step 4: Issue и PR (только по просьбе владельца)**

Комментарий в #63: что умеет сервер, как проверено, отклонения от плана. Push и PR – только после
явного «да». В описании PR: `Refs #63`.

---

## Self-review (выполнено при написании)

- **Покрытие спецификации (серверная часть):**
  - F2 (метка, решения) → задачи 2, 3, 5;
  - F3 (параметры) → задача 5, проверка самих параметров – `addDecision` из 1A;
  - F4 (референсы) → задача 6;
  - F9 (вкладка: состояние, тексты, файлы, воронка) → задачи 5, 8;
  - F10 (правки к блоку со снимком) → задачи 4, 7;
  - F11 (утверждение по пропуску) → задачи 1, 8;
  - F12 (разделы) → задачи 2, 3;
  - F13 (обещание изменилось) → задача 2, решения `promise-refresh` и `promise-keep` – задача 5;
  - F16 (воронка, чтение) → задача 5, поле `funnel`;
  - «Безопасность» → задачи 4, 6, 7, 8.

  Экраны всех этих пунктов – план 1B-2.
- **Имена сверены с кодом 1A:**
  - `readChecked`, `checkedFile` и `inputFingerprint` из `check.js`;
  - `readFacts(dir, bytes)`;
  - `createLeadMagnet(…, { request })` – необязательно;
  - `passport.request.decisionId`;
  - `addDecision` (исполняет `link` и `promise-keep` сам);
  - `countNewLeadMagnetComments(projectsDir, id, revision?)`;
  - `deriveLeadMagnetStatus`;
  - `STATUS_ORDER` из `scripts/pult/status.js`.
- **Открытое для исполнителя:**
  - текст ошибки `addLeadMagnetComment` на неопубликованную ревизию (задача 7, шаг 3);
  - порядок кодов ошибки утверждения при пропавшей странице (задача 1, шаг 6).

  В обоих случаях ориентир – существующие тесты 1A; любое изменение – в «Отклонения от плана».
