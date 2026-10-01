# Лид-магнит 1B-2 – экраны пульта: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать человеку экраны лид-магнита в «Пульте роликов»:
- метка «🎁 Лид-магнит?» и плашка с вопросом;
- «Уже есть готовый» и «Нет»;
- окно параметров с загрузкой референса;
- вкладка проверки с живой страницей «за стеклом» и переключателем «Компьютер / Телефон 390»;
- правки кликом по блоку;
- утверждение;
- файлы, воронка, «обещание изменилось».

**Architecture:** Всё новое – в отдельном файле `pult/lead-magnet.js` (функции с приставкой `lm`),
он подключается до `app.js` и пользуется его помощниками (`el`, `button`, `api`, `notify`,
`mediaUrl`, `refresh`, `token`, `state`) только во время работы, не при загрузке. В `app.js` – шесть
точек подключения: метка на карточке, слот плашки, кнопка в действиях, вкладки «Видео | Лид-магнит»,
отрисовка вкладки, фоновое обновление. Сервер не меняется: только маршруты плана 1B-1.

**Tech Stack:** браузерный JavaScript без сборки (как `pult/app.js`), CSS пульта, Playwright
(`tests/pult-lead-magnet-ui.spec.js`).

**Опирается на:** `2026-10-01-lead-magnet-1b1-pult-server.md` – раздел «Контракт с частью 1B-2».
**Спецификация:** F2, F3, F4, F9–F13, F16 и макеты `docs/superpowers/specs/2026-09-30-lead-magnet-mockups.html`.
**Задача:** #63.

---

## Подготовка

- [ ] Продолжай в той же ветке `feat/lead-magnet-pult-server` сразу после задачи 9 плана 1B-1:
  экраны опираются на её маршруты, а часть 1B уходит одним PR (сервер + экраны).

```bash
git switch feat/lead-magnet-pult-server
```

- [ ] Базовая линия: `npm test` и `npm run test:review-ui` – зелёные (Chromium установлен:
  `npx playwright install chromium`).

## Карта файлов

| Файл | Что меняется |
|---|---|
| `pult/lead-magnet.js` | **новый:** все экраны лид-магнита |
| `pult/index.html` | `<script src="/lead-magnet.js">` перед `app.js` |
| `scripts/pult/http.js` | `/lead-magnet.js` в списке статических файлов |
| `pult/app.js` | шесть точек подключения (задачи 1, 2, 4, 6) |
| `pult/styles.css` | стили `lm-*` и вкладок карточки |
| `package.json` | новый spec в `test:review-ui` |
| `tests/pult-lead-magnet-ui.spec.js` | **новый**, пополняется в каждой задаче |
| `tests/pult-lead-magnet-server.test.js` | один тест: статический файл отдаётся |

---

### Task 1: Модуль подключён, метка на карточке

**Files:**
- Create: `pult/lead-magnet.js`
- Modify: `pult/index.html`, `scripts/pult/http.js`, `pult/app.js`, `pult/styles.css`, `package.json`
- Test: `tests/pult-lead-magnet-ui.spec.js` (создать), `tests/pult-lead-magnet-server.test.js` (дописать)

- [ ] **Step 1: Write the failing tests**

Сервер – в `tests/pult-lead-magnet-server.test.js` перед `module.exports`:

```js
test('the lead magnet screen script is served like the rest of the pult', async (t) => {
  const { session } = await start(t, root(t));
  const script = await request(session, '/lead-magnet.js', { token: null });
  assert.equal(script.status, 200);
  assert.match(script.headers['content-type'], /^text\/javascript/);
  assert.match(script.body.toString('utf8'), /function lmCardTag/);
});
```

Браузер – новый файл:

```js
// tests/pult-lead-magnet-ui.spec.js
const fs = require('node:fs');
const path = require('node:path');

const { test, expect } = require('playwright/test');

const { approveLeadMagnet } = require('../scripts/lead-magnet/approve');
const library = require('../scripts/lead-magnet/library');
const { addOffer } = require('../scripts/lead-magnet/offers');
const { readDecisions } = require('../scripts/lead-magnet/requests');
const { startPultServer } = require('../scripts/pult/server');
const { makePultRoot } = require('./helpers/pult-projects');
const {
  PNG_BYTES, QUOTE, UNITS, addLeadMagnetFor, addVideoWithOffer, goodPage, publishCheckedRevision,
} = require('./helpers/lead-magnet-fixtures');

let session = null;
let calls;
let projectsDir;
const cleanups = [];
const registrar = { after: (fn) => cleanups.push(fn) };

function fakeCapture(command, args) {
  if (command === 'ffprobe') {
    return { stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 1080, height: 1920, r_frame_rate: '25/1' }], format: { duration: '60' } }) };
  }
  fs.writeFileSync(args.at(-1), args.at(-1).endsWith('.png') ? PNG_BYTES : 'jpg');
  return { stdout: '' };
}

// Каждый тест получает свежую projects/ с роликом «Сайт за вечер» (preview ждёт автора,
// в сценарии – обещание «ГАЙД») и при необходимости – свои добавки.
async function startWith(extra = () => ({})) {
  ({ projectsDir } = makePultRoot(registrar));
  addVideoWithOffer(projectsDir, { folder: 'clip', name: 'Сайт за вечер' });
  const context = extra(projectsDir);
  calls = { reveal: [] };
  session = await startPultServer({
    projectsDir,
    idleMs: 0,
    env: {},
    captureImpl: fakeCapture,
    revealImpl: async (target) => { calls.reveal.push(target); },
    openWindowImpl: async () => {},
  });
  return context;
}

test.afterEach(async () => {
  if (session) await session.close();
  session = null;
  while (cleanups.length) cleanups.pop()();
});

function approvedIn(dir, folder) {
  const id = addLeadMagnetFor(dir, folder);
  const { n, pageSha256 } = publishCheckedRevision(dir, id);
  approveLeadMagnet(dir, id, { revision: n, expectedPageSha256: pageSha256, confirmViewed: true });
  return id;
}

function withLibrary(dir) {
  addVideoWithOffer(dir, { folder: 'other', name: 'Другой ролик' });
  return { libraryId: approvedIn(dir, 'other') };
}

async function openClip(page) {
  await page.goto(session.url);
  await page.locator('.card', { hasText: 'Сайт за вечер' }).click();
  await expect(page.locator('[data-view="detail"]')).toBeVisible();
}

test('a promise puts a tag on the card without moving it to another section', async ({ page }) => {
  await startWith();
  await page.goto(session.url);
  const card = page.locator('[data-section="waiting"] .card', { hasText: 'Сайт за вечер' });
  await expect(card.locator('[data-lm-tag]')).toHaveText('🎁 Лид-магнит?');
});
```

В `package.json` добавь `tests/pult-lead-magnet-ui.spec.js` в конец списка файлов скрипта
`test:review-ui`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/pult-lead-magnet-server.test.js && npx playwright test tests/pult-lead-magnet-ui.spec.js --project=chromium`
Expected: FAIL – `/lead-magnet.js` отвечает 404, метки нет.

- [ ] **Step 3: Create `pult/lead-magnet.js`**

```js
'use strict';

// Экраны лид-магнита в пульте (план 1B-2). Файл подключается ДО app.js и пользуется его
// помощниками только во время работы: el, button, api, notify, mediaUrl, refresh, token и
// state. Все свои имена – с приставкой lm, чтобы не столкнуться с app.js. Сервер – маршруты
// scripts/pult/lead-magnet-routes.js; браузер не получает ни путей, ни хешей.

const LM_STATUS_LABELS = { waiting: 'Ждёт меня', working: 'В работе', ready: 'Готов' };
const LM_FORMAT_LABELS = {
  guide: 'Гайд по шагам', prompts: 'Набор промптов', checklist: 'Чек-лист', cheatsheet: 'Шпаргалка на один экран',
};
const LM_DESIGN_LABELS = {
  brand: 'Мой стиль', reference: 'По референсу', new: 'Новый дизайн под тему', like: 'Как прошлый лид-магнит',
};
const LM_TEXT_LABELS = { dm: 'Сообщение в личку', telegram: 'Пост в Telegram', instagram: 'Подпись Instagram' };

function lmClock(seconds) {
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function lmRevisionLabel(n) {
  return `v${String(n).padStart(2, '0')}`;
}

function lmUnitsText(units) {
  return units.map((unit) => (unit.count ? `${unit.count} ${unit.label}` : unit.label)).join(' + ');
}

function lmLoadState(variant) {
  return api(`/api/lead-magnet?key=${encodeURIComponent(variant.key)}`);
}

// Решение человека: сервер записывает его (и сразу исполняет «Нет», «Уже есть готовый»,
// «Оставить как есть»), а пульт перерисовывает карточку по свежим данным.
async function lmDecide(variant, body) {
  await api('/api/lead-magnet/decision', { method: 'POST', body: { key: variant.key, ...body } });
  await refresh();
}

function lmCardTag(card) {
  if (!card.leadMagnetAsk) return null;
  const tag = el('span', 'lm-tag', '🎁 Лид-магнит?');
  tag.dataset.lmTag = '';
  return tag;
}
```

- [ ] **Step 4: Serve and load it**

- `scripts/pult/http.js`, в `STATIC_FILES` после строки `/app.js`:
  `['/lead-magnet.js', { dir: ['pult'], file: 'lead-magnet.js' }],`
- `pult/index.html`: перед `<script src="/app.js"></script>` добавь
  `<script src="/lead-magnet.js"></script>`.
- `pult/app.js`, в `renderCard` сразу после строки
  `body.append(el('span', 'card__title', card.title), meta, el('span', 'card__next', card.nextStep));`:

```js
  const leadTag = lmCardTag(card);
  if (leadTag) body.append(leadTag);
```

- `pult/styles.css`, перед блоком `@media (max-width: 860px)`:

```css
/* Лид-магнит (pult/lead-magnet.js). */
.lm-tag { display: inline-block; margin-top: 0.4rem; padding: 0.1rem 0.55rem; border-radius: 999px; font-size: 0.8rem; background: hsl(var(--amber-soft)); color: hsl(var(--amber)); }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/pult-lead-magnet-server.test.js && npx playwright test tests/pult-lead-magnet-ui.spec.js tests/pult-ui.spec.js --project=chromium`
Expected: PASS – новый тест и все прежние тесты пульта.

- [ ] **Step 6: Commit**

```bash
git add pult/lead-magnet.js pult/index.html pult/app.js pult/styles.css scripts/pult/http.js package.json tests/pult-lead-magnet-ui.spec.js tests/pult-lead-magnet-server.test.js
git commit -m "feat(pult): load the lead magnet screens and tag cards with a promise

Refs #63"
```

---

### Task 2: Плашка вопроса, «Нет», «Уже есть готовый», кнопка в действиях

**Files:**
- Modify: `pult/lead-magnet.js` (дописать в конец), `pult/app.js`, `pult/styles.css`
- Test: `tests/pult-lead-magnet-ui.spec.js` (дописать)

- [ ] **Step 1: Write the failing tests**

```js
test('the offer banner quotes the promise and suggests the approved one with the same word', async ({ page }) => {
  await startWith(withLibrary);
  await openClip(page);
  const banner = page.locator('[data-lm-offer="ГАЙД"]');
  await expect(banner).toContainText(QUOTE);
  await expect(banner).toContainText('уже есть готовый');
  await expect(page.locator('[data-variant-status]')).toHaveText('Ждёт меня');
});

test('«Нет» hides the question and «🎁 Лид-магнит» brings it back', async ({ page }) => {
  await startWith();
  await openClip(page);
  await page.locator('[data-lm-offer] button', { hasText: 'Нет' }).click();
  await expect(page.locator('[data-lm-offer]')).toHaveCount(0);
  await page.locator('.actions button', { hasText: '🎁 Лид-магнит' }).click();
  await expect(page.locator('[data-lm-offer="ГАЙД"]')).toBeVisible();
});

test('«Уже есть готовый» links the approved lead magnet in one click', async ({ page }) => {
  const { libraryId } = await startWith(withLibrary);
  await openClip(page);
  await page.locator('[data-lm-offer] button', { hasText: 'Уже есть готовый' }).click();
  const pick = page.locator('[data-lm-picker] .lm-pick').first();
  await expect(pick).toHaveClass(/lm-pick--match/);
  await pick.click();
  await expect(page.locator('[data-lm-offer]')).toHaveCount(0);
  expect(library.readLeadMagnet(projectsDir, libraryId).videos).toEqual(['other', 'clip']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx playwright test tests/pult-lead-magnet-ui.spec.js --project=chromium`
Expected: FAIL – плашки нет.

- [ ] **Step 3: Add the banner code to `pult/lead-magnet.js`**

```js
// Плашка «Разработать лид-магнит?» над статусом видео. Раздел карточки она не меняет.
async function lmRenderBanner(slot, variant, getVideo) {
  if (!variant.leadMagnet || !variant.leadMagnet.ask) return;
  let leadState;
  try {
    leadState = await lmLoadState(variant);
  } catch (error) {
    notify(error.message, 'error');
    return;
  }
  for (const offer of leadState.offers.filter((item) => item.state === 'ask')) {
    slot.append(lmOfferBanner(variant, leadState, offer, getVideo));
  }
}

function lmOfferBanner(variant, leadState, offer, getVideo) {
  const box = el('div', 'lm-offer');
  box.dataset.lmOffer = offer.codeWord;
  box.append(el('h3', '', `🎁 В ролике есть обещание${offer.startSec === null ? '' : ` · ${lmClock(offer.startSec)}`}`));
  box.append(el('blockquote', 'lm-quote', `«${offer.quote}»`));
  const facts = el('div', 'lm-row');
  if (offer.startSec !== null) {
    facts.append(button('▶ послушать', async () => {
      const video = getVideo();
      if (!video) return;
      video.currentTime = offer.startSec;
      await video.play();
    }, 'link-button'));
  }
  facts.append(el('span', 'hint', `кодовое слово: ${offer.codeWord}`));
  box.append(facts);
  const matches = leadState.library.filter((item) => item.codeWords.includes(offer.codeWord));
  if (matches.length) {
    box.append(el('p', 'lm-hint', `Для слова ${offer.codeWord} уже есть готовый лид-магнит «${matches[0].title}» – можно не делать заново.`));
  }
  box.append(el('strong', '', 'Разработать лид-магнит для этого ролика?'));
  const picker = lmLibraryPicker(variant, leadState, offer);
  const choices = el('div', 'lm-row');
  choices.append(
    button('Разработать новый', async () => { lmOpenWizard(variant, leadState, offer); }, 'primary'),
    button('Уже есть готовый ▾', async () => { picker.hidden = !picker.hidden; }, 'secondary'),
    button('Нет', () => lmDecide(variant, { type: 'decline', offerId: offer.offerId, codeWord: offer.codeWord }), 'secondary'),
  );
  box.append(choices, picker, el('p', 'hint', `«Нет» больше не спрашивает про слово ${offer.codeWord}. Передумаете – кнопка «🎁 Лид-магнит» в действиях.`));
  return box;
}

// Утверждённые лид-магниты библиотеки; совпадения по кодовому слову – первыми.
function lmLibraryPicker(variant, leadState, offer) {
  const box = el('div', 'lm-picker');
  box.hidden = true;
  box.dataset.lmPicker = '';
  if (!leadState.library.length) {
    box.append(el('p', 'hint', 'Утверждённых лид-магнитов пока нет.'));
    return box;
  }
  const search = el('input');
  search.type = 'search';
  search.placeholder = 'Найти лид-магнит';
  search.setAttribute('aria-label', 'Найти лид-магнит');
  const list = el('ul', 'lm-picker__list');
  const isMatch = (item) => item.codeWords.includes(offer.codeWord);
  const ordered = [...leadState.library].sort((left, right) => Number(isMatch(right)) - Number(isMatch(left)));
  const draw = () => {
    const query = search.value.trim().toLowerCase();
    list.replaceChildren();
    for (const item of ordered.filter((entry) => !query || `${entry.title} ${entry.codeWords.join(' ')}`.toLowerCase().includes(query))) {
      const row = el('li');
      row.append(button(`${item.codeWords.join(', ')} · «${item.title}» · роликов: ${item.videos}`,
        () => lmDecide(variant, { type: 'link', offerId: offer.offerId, codeWord: offer.codeWord, leadMagnetId: item.id }),
        isMatch(item) ? 'lm-pick lm-pick--match' : 'lm-pick'));
      list.append(row);
    }
  };
  search.addEventListener('input', draw);
  draw();
  box.append(search, list, el('p', 'hint', 'Выбор сразу привязывает ролик к лид-магниту – агенту ничего делать не нужно.'));
  return box;
}

// Кнопка в «Действиях»: вернуть вопрос после «Нет» или заказать лид-магнит без обещания.
function lmActionButton(variant) {
  return button('🎁 Лид-магнит', async () => {
    const leadState = await lmLoadState(variant);
    const declined = leadState.offers.find((offer) => offer.state === 'declined');
    if (declined) {
      await lmDecide(variant, { type: 'reopen', offerId: declined.offerId, codeWord: declined.codeWord });
      notify('Вопрос про лид-магнит вернулся в карточку.');
      return;
    }
    lmOpenWizard(variant, leadState, null);
  });
}

// Окно параметров – задача 3. До неё кнопка честно говорит, что окна ещё нет.
function lmOpenWizard() {
  notify('Окно параметров появится в следующей задаче.', 'error');
}
```

- [ ] **Step 4: Connect it in `pult/app.js`**

4a. В `actionsBlock` перед кнопкой архива (`box.append(button(card.archived ? …`):

```js
  box.append(lmActionButton(variant));
```

4b. В `renderDetail` в начале блока боковой колонки (сразу после `const side = el('div', 'detail__side');`):

```js
  // Плашка «Разработать лид-магнит?» – над статусом видео (pult/lead-magnet.js).
  const offerSlot = el('div', 'lm-offer-slot');
  offerSlot.dataset.lmOfferSlot = '';
```

и в `side.append(` первым аргументом поставь `offerSlot,`. Сразу после этого `side.append(…);` добавь:

```js
  lmRenderBanner(offerSlot, variant, getVideo);
```

- [ ] **Step 5: Styles**

В `pult/styles.css` после строки `.lm-tag …`:

```css
.lm-offer-slot:empty { display: none; }
.lm-offer-slot { display: flex; flex-direction: column; gap: 1rem; }
.lm-offer, .lm-panel { display: flex; flex-direction: column; gap: 0.6rem; padding: 1rem; background: hsl(var(--card)); border: 1px solid hsl(var(--border)); border-radius: var(--radius); }
.lm-offer { border-color: hsl(var(--amber) / 0.7); }
.lm-offer h3, .lm-panel h3 { margin: 0; font-size: 1rem; }
.lm-quote { margin: 0; padding: 0.55rem 0.75rem; background: hsl(var(--card-raised)); border: 1px solid hsl(var(--amber) / 0.35); border-radius: 0.5rem; font-style: italic; }
.lm-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
.lm-hint { margin: 0; padding: 0.45rem 0.65rem; border-radius: 0.45rem; background: hsl(var(--teal-soft)); font-size: 0.88rem; }
.lm-offer .hint { margin: 0; font-size: 0.85rem; }
.lm-picker { display: flex; flex-direction: column; gap: 0.4rem; }
.lm-picker input, .lm-field input[type="text"], .lm-field textarea, .lm-field select, .lm-comments textarea {
  width: 100%; padding: 0.5rem 0.65rem; background: hsl(var(--card-raised)); border: 1px solid hsl(var(--border)); border-radius: 0.5rem;
}
.lm-picker__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
.lm-pick { width: 100%; text-align: left; padding: 0.45rem 0.6rem; border-radius: 0.45rem; border: 1px solid hsl(var(--border)); background: hsl(var(--card-raised)); cursor: pointer; }
.lm-pick--match { border-color: hsl(var(--amber)); }
.lm-error { margin: 0; color: hsl(var(--danger)); }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx playwright test tests/pult-lead-magnet-ui.spec.js tests/pult-ui.spec.js --project=chromium`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add pult/lead-magnet.js pult/app.js pult/styles.css tests/pult-lead-magnet-ui.spec.js
git commit -m "feat(pult): ask about a lead magnet and link an existing one

Refs #63"
```

---

### Task 3: Окно параметров и загрузка референса

**Files:**
- Modify: `pult/lead-magnet.js` (заменить заглушку `lmOpenWizard`, дописать функции), `pult/styles.css`
- Test: `tests/pult-lead-magnet-ui.spec.js` (дописать)

Окно – нативный `<dialog>` без `<form>` (CSP пульта запрещает отправку форм: `form-action 'none'`).
Ошибки показываются **внутри окна**: строка уведомлений пульта прячется за затемнением.
Кодовое слово обещания в окне только читается – движок отклоняет запрос со словом, отличным от
обещания ролика.

- [ ] **Step 1: Write the failing test**

```js
test('the wizard needs the promise checkbox and sends parameters with an uploaded reference', async ({ page }) => {
  await startWith();
  await openClip(page);
  await page.locator('[data-lm-offer] button', { hasText: 'Разработать новый' }).click();
  const wizard = page.locator('[data-lm-wizard]');
  await expect(wizard).toBeVisible();
  await expect(wizard.locator('[data-lm-code-word]')).toHaveValue('ГАЙД');
  const send = wizard.locator('[data-lm-send]');
  await expect(send).toBeDisabled();
  await wizard.locator('[data-lm-promise]').check();
  await expect(send).toBeEnabled();
  await wizard.locator('.lm-choice', { hasText: 'По референсу' }).click();
  await expect(wizard.locator('[data-lm-reference]')).toBeVisible();
  await expect(send).toBeDisabled();
  await wizard.locator('[data-lm-file]').setInputFiles({ name: 'ref.png', mimeType: 'image/png', buffer: PNG_BYTES });
  await expect(wizard.locator('[data-lm-chips]')).toContainText('ref.png');
  await expect(send).toBeEnabled();
  await wizard.locator('[data-lm-wishes]').fill('Добавь блок «частые ошибки»');
  await send.click();
  await expect(wizard).toHaveCount(0);
  const create = readDecisions(path.join(projectsDir, 'clip')).find((decision) => decision.type === 'create');
  expect(create.params.design.mode).toBe('reference');
  expect(create.params.design.references[0].path).toMatch(/^pult\/lead-magnet-refs\/[a-f0-9]{64}\.png$/);
  expect(create.params.wishes).toBe('Добавь блок «частые ошибки»');
  expect(create.params.promiseConfirmed).toBe(true);
});

test('a broken upload is explained inside the wizard', async ({ page }) => {
  await startWith();
  await openClip(page);
  await page.locator('[data-lm-offer] button', { hasText: 'Разработать новый' }).click();
  const wizard = page.locator('[data-lm-wizard]');
  await wizard.locator('.lm-choice', { hasText: 'По референсу' }).click();
  await wizard.locator('[data-lm-file]').setInputFiles({ name: 'virus.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ not an image') });
  await expect(wizard.locator('[data-lm-wizard-error]')).toContainText('не поддерживается');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx playwright test tests/pult-lead-magnet-ui.spec.js --project=chromium`
Expected: FAIL – окна нет (заглушка).

- [ ] **Step 3: Replace the stub with the wizard**

Удали заглушку `function lmOpenWizard() { … }` и добавь в конец файла:

```js
const LM_REFERENCE_LIMITS_MB = { 'image/png': 15, 'image/jpeg': 15, 'image/webp': 15, 'application/pdf': 30, 'text/html': 5 };
const LM_MAX_REFERENCES = 5;

function lmChoice(type, name, value, label, checked) {
  const wrap = el('label', 'lm-choice');
  const input = el('input');
  input.type = type;
  input.name = name;
  input.value = value;
  input.checked = checked;
  wrap.append(input, el('span', '', label));
  return { wrap, input };
}

function lmChoices(items) {
  const row = el('div', 'lm-choices');
  row.append(...items.map((item) => item.wrap));
  return row;
}

function lmFieldset(number, legend, children) {
  const box = el('fieldset', 'lm-field');
  box.append(el('legend', '', number ? `${number}. ${legend}` : legend), ...children);
  return box;
}

function lmTextInput(value, label, { multiline = false, maxLength = 0 } = {}) {
  const input = el(multiline ? 'textarea' : 'input');
  if (multiline) input.rows = 2;
  else input.type = 'text';
  input.value = value || '';
  if (maxLength) input.maxLength = maxLength;
  input.setAttribute('aria-label', label);
  return input;
}

// Референс уходит сырыми байтами: сервер сам определяет тип по сигнатуре и хранит файл по SHA-256.
async function lmUploadReference(variant, file) {
  const limit = LM_REFERENCE_LIMITS_MB[file.type];
  if (limit && file.size > limit * 1024 * 1024) throw new Error(`файл больше ${limit} МБ`);
  let response;
  try {
    response = await fetch(`/api/lead-magnet/reference?key=${encodeURIComponent(variant.key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: file,
    });
  } catch (_) {
    throw new Error('пульт не отвечает – откройте его снова значком «Пульт роликов»');
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error((payload && payload.message) || 'файл не загрузился');
  return payload.reference;
}

function lmOpenWizard(variant, leadState, offer) {
  const dialog = el('dialog', 'lm-dialog');
  dialog.dataset.lmWizard = '';
  const references = [];
  const errorLine = el('p', 'lm-error');
  errorLine.dataset.lmWizardError = '';
  const say = (message) => { errorLine.textContent = message; };
  const body = el('div', 'lm-dialog__body');

  let promise = null;
  if (offer) {
    promise = lmChoice('checkbox', 'lm-promise', 'yes', `Делаем ровно под это обещание: ${lmUnitsText(offer.units)}`, false);
    promise.input.dataset.lmPromise = '';
    body.append(lmFieldset(1, `Обещание из ролика${offer.startSec === null ? '' : ` · ${lmClock(offer.startSec)}`}`,
      [el('blockquote', 'lm-quote', `«${offer.quote}»`), promise.wrap]));
  }
  const codeWord = lmTextInput(offer ? offer.codeWord : '', 'Кодовое слово', { maxLength: 40 });
  codeWord.readOnly = Boolean(offer);
  codeWord.dataset.lmCodeWord = '';
  body.append(lmFieldset(2, 'Кодовое слово', [codeWord]));

  const suggested = offer ? offer.suggest.format : 'guide';
  const formats = Object.entries(LM_FORMAT_LABELS).map(([value, label]) => lmChoice('radio', 'lm-format', value, label, value === suggested));
  const formatParts = [lmChoices(formats)];
  if (offer) formatParts.push(el('p', 'lm-hint', `Агент советует «${LM_FORMAT_LABELS[suggested]}».`));
  body.append(lmFieldset(3, 'Формат', formatParts));

  const audience = lmTextInput(offer ? offer.suggest.audience : '', 'Для кого', { maxLength: 200 });
  body.append(lmFieldset(4, 'Для кого', [audience]));

  const designs = Object.entries(LM_DESIGN_LABELS).map(([value, label]) => lmChoice('radio', 'lm-design', value, label, value === 'brand'));
  const designMode = () => designs.find((item) => item.input.checked).input.value;

  const referencePanel = el('div', 'lm-reference');
  referencePanel.hidden = true;
  referencePanel.dataset.lmReference = '';
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.accept = '.png,.jpg,.jpeg,.webp,.pdf,.html,.htm';
  fileInput.dataset.lmFile = '';
  fileInput.setAttribute('aria-label', 'Файл референса');
  const drop = el('div', 'lm-drop');
  drop.append(el('span', '', 'Перетащите картинку, PDF или HTML-файл'), el('span', 'hint', 'PNG, JPG, WebP до 15 МБ · PDF до 30 МБ · HTML до 5 МБ'), fileInput);
  const urlInput = lmTextInput('', 'Ссылка на референс', { maxLength: 2048 });
  urlInput.placeholder = 'https://…';
  const chips = el('ul', 'lm-chips');
  chips.dataset.lmChips = '';
  const take = {
    composition: lmChoice('checkbox', 'lm-take', 'composition', 'Композицию и подачу', leadState.brand.defaultTake.composition),
    colors: lmChoice('checkbox', 'lm-take', 'colors', 'Цвета', leadState.brand.defaultTake.colors),
    fonts: lmChoice('checkbox', 'lm-take', 'fonts', 'Шрифты', leadState.brand.defaultTake.fonts),
  };
  const takeHint = el('p', 'hint', leadState.brand.source === 'pack'
    ? 'У вас свой стиль, поэтому по умолчанию берём только композицию. Логотип, блок призыва, кнопки «Скопировать» и мобильная вёрстка останутся в любом случае.'
    : 'Своего стиля нет – берём из референса всё. Блок призыва, кнопки «Скопировать» и мобильная вёрстка останутся в любом случае.');
  const note = lmTextInput('', 'Что нравится в референсе', { multiline: true, maxLength: 500 });

  const likePanel = el('div', 'lm-like');
  likePanel.hidden = true;
  const likeSelect = el('select');
  likeSelect.setAttribute('aria-label', 'Образец');
  likeSelect.append(new Option('Выберите утверждённый лид-магнит', ''), ...leadState.library.map((item) => new Option(`${item.codeWords.join(', ')} · ${item.title}`, item.id)));
  likePanel.append(leadState.library.length ? likeSelect : el('p', 'hint', 'Утверждённых лид-магнитов пока нет.'));

  const texts = Object.entries(LM_TEXT_LABELS).map(([value, label]) => lmChoice('checkbox', 'lm-texts', value, label, true));
  const wishes = lmTextInput('', 'Пожелания', { multiline: true, maxLength: 1000 });
  wishes.placeholder = 'Например: добавить блок «частые ошибки»';
  wishes.dataset.lmWishes = '';

  const send = el('button', 'primary', 'Отправить агенту');
  send.type = 'button';
  send.dataset.lmSend = '';
  const validate = () => {
    const mode = designMode();
    send.disabled = Boolean(offer && !promise.input.checked) || !codeWord.value.trim()
      || (mode === 'reference' && !references.length) || (mode === 'like' && !likeSelect.value);
  };
  const drawChips = () => {
    chips.replaceChildren(...references.map((item, index) => {
      const chip = el('li', 'lm-chip');
      chip.append(el('span', '', item.label), button('✕', async () => { references.splice(index, 1); drawChips(); validate(); }, 'link-button'));
      return chip;
    }));
  };
  const addFiles = async (files) => {
    for (const file of files) {
      if (references.length >= LM_MAX_REFERENCES) {
        say(`Можно приложить до ${LM_MAX_REFERENCES} референсов.`);
        break;
      }
      try {
        references.push({ reference: await lmUploadReference(variant, file), label: `📎 ${file.name}` });
        say('');
      } catch (error) {
        say(`${file.name}: ${error.message}`);
      }
    }
    drawChips();
    validate();
  };
  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    addFiles(files);
  });
  drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.dataset.over = ''; });
  drop.addEventListener('dragleave', () => { delete drop.dataset.over; });
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    delete drop.dataset.over;
    addFiles([...event.dataTransfer.files]);
  });
  const addUrl = button('Добавить ссылку', async () => {
    const value = urlInput.value.trim();
    if (!/^https?:\/\/\S+$/i.test(value)) { say('Нужна ссылка вида https://…'); return; }
    if (references.length >= LM_MAX_REFERENCES) { say(`Можно приложить до ${LM_MAX_REFERENCES} референсов.`); return; }
    references.push({ reference: { kind: 'url', url: value }, label: `🔗 ${value}` });
    urlInput.value = '';
    say('');
    drawChips();
    validate();
  }, 'secondary');
  const urlRow = el('div', 'lm-row');
  urlRow.append(urlInput, addUrl);
  referencePanel.append(drop, urlRow, chips,
    lmFieldset(null, 'Что взять из референса', [lmChoices(Object.values(take)), takeHint]),
    lmFieldset(null, 'Что нравится', [note]));
  designs.forEach((item) => item.input.addEventListener('change', () => {
    referencePanel.hidden = designMode() !== 'reference';
    likePanel.hidden = designMode() !== 'like';
  }));
  body.append(lmFieldset(5, 'Дизайн', [lmChoices(designs), referencePanel, likePanel]));
  body.append(lmFieldset(6, 'Тексты для раздачи', [lmChoices(texts)]));
  body.append(lmFieldset(7, 'Пожелания (необязательно)', [wishes]));

  const close = () => { if (dialog.open) dialog.close(); dialog.remove(); };
  send.addEventListener('click', async () => {
    send.disabled = true;
    const mode = designMode();
    const params = {
      format: formats.find((item) => item.input.checked).input.value,
      audience: audience.value.trim(),
      design: {
        mode,
        take: { composition: take.composition.input.checked, colors: take.colors.input.checked, fonts: take.fonts.input.checked },
        likeId: mode === 'like' ? likeSelect.value : null,
        note: mode === 'reference' ? note.value.trim() : '',
        references: mode === 'reference' ? references.map((item) => item.reference) : [],
      },
      texts: texts.filter((item) => item.input.checked).map((item) => item.input.value),
      wishes: wishes.value.trim(),
      promiseConfirmed: Boolean(promise && promise.input.checked),
    };
    try {
      await api('/api/lead-magnet/decision', {
        method: 'POST',
        body: {
          key: variant.key, type: 'create', offerId: offer ? offer.offerId : null, codeWord: offer ? offer.codeWord : codeWord.value.trim(), params,
        },
      });
      close();
      notify('Запрос отправлен агенту. Скопируйте фразу для агента – он соберёт черновик.');
      await refresh();
    } catch (error) {
      say(error.message);
      validate();
    }
  });

  const head = el('div', 'lm-dialog__head');
  head.append(el('h3', '', offer ? `Лид-магнит «${offer.codeWord}»` : 'Новый лид-магнит'), button('✕', async () => close(), 'link-button'));
  const foot = el('div', 'lm-dialog__foot');
  foot.append(errorLine, button('Отмена', async () => close(), 'secondary'), send);
  dialog.append(head, body, foot);
  dialog.addEventListener('input', validate);
  dialog.addEventListener('change', validate);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  validate();
  dialog.showModal();
  return dialog;
}
```

- [ ] **Step 4: Styles**

```css
.lm-dialog { width: min(46rem, calc(100vw - 2rem)); max-height: calc(100vh - 2rem); padding: 0; color: inherit; background: hsl(var(--card)); border: 1px solid hsl(var(--border)); border-radius: 1rem; }
.lm-dialog::backdrop { background: hsl(0 0% 0% / 0.6); }
.lm-dialog__head, .lm-dialog__foot { display: flex; align-items: center; gap: 0.6rem; padding: 0.9rem 1.1rem; }
.lm-dialog__head { justify-content: space-between; border-bottom: 1px solid hsl(var(--border)); }
.lm-dialog__head h3 { margin: 0; }
.lm-dialog__foot { justify-content: flex-end; border-top: 1px solid hsl(var(--border)); }
.lm-dialog__foot .lm-error { margin-right: auto; }
.lm-dialog__body { display: flex; flex-direction: column; gap: 1rem; padding: 1rem 1.1rem; }
.lm-field { display: flex; flex-direction: column; gap: 0.45rem; margin: 0; padding: 0; border: 0; min-width: 0; }
.lm-field legend { padding: 0; margin-bottom: 0.45rem; font-weight: 600; font-size: 0.92rem; }
.lm-choices { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.lm-choice { display: inline-flex; gap: 0.4rem; align-items: center; padding: 0.35rem 0.7rem; border: 1px solid hsl(var(--border)); border-radius: 999px; cursor: pointer; font-size: 0.9rem; }
.lm-choice:has(input:checked) { border-color: hsl(var(--amber)); background: hsl(var(--amber-soft)); }
.lm-choice input { accent-color: hsl(var(--amber)); }
.lm-reference, .lm-like { display: flex; flex-direction: column; gap: 0.6rem; padding: 0.8rem; background: hsl(var(--background)); border: 1px solid hsl(var(--border)); border-radius: 0.7rem; }
.lm-drop { display: flex; flex-direction: column; align-items: center; gap: 0.4rem; padding: 1rem; text-align: center; border: 1.5px dashed hsl(var(--muted-foreground) / 0.6); border-radius: 0.7rem; }
.lm-drop[data-over] { border-color: hsl(var(--amber)); }
.lm-chips { display: flex; flex-wrap: wrap; gap: 0.4rem; list-style: none; margin: 0; padding: 0; }
.lm-chip { display: inline-flex; gap: 0.4rem; align-items: center; padding: 0.25rem 0.55rem; border-radius: 0.45rem; background: hsl(var(--card-raised)); font-size: 0.85rem; }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx playwright test tests/pult-lead-magnet-ui.spec.js --project=chromium`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add pult/lead-magnet.js pult/styles.css tests/pult-lead-magnet-ui.spec.js
git commit -m "feat(pult): lead magnet parameters window with design references

Refs #63"
```

---

### Task 4: Вкладка «Лид-магнит»: страница за стеклом, проверка, тексты, файлы, утверждение

**Files:**
- Modify: `pult/lead-magnet.js`, `pult/app.js`, `pult/styles.css`
- Test: `tests/pult-lead-magnet-ui.spec.js` (дописать)

Вид «Компьютер» показывает страницу в настоящую ширину 1280 px, уменьшенную до колонки пульта:
тогда клик по блоку попадает в те же координаты, что и скриншот проверки, из которого сервер
вырезает снимок правки. «Телефон 390» – ширина 390 px.

- [ ] **Step 1: Write the failing tests**

```js
function withDraft(dir, options = {}) {
  const id = addLeadMagnetFor(dir, 'clip');
  publishCheckedRevision(dir, id, options);
  return { id };
}

async function openLeadTab(page) {
  await openClip(page);
  await page.locator('[data-detail-tabs] button', { hasText: 'Лид-магнит' }).click();
}

test('the lead tab shows the sandboxed page on desktop and phone width', async ({ page }) => {
  await startWith(withDraft);
  await openLeadTab(page);
  const frame = page.frameLocator('[data-lm-frame]');
  await expect(frame.locator('h1')).toHaveText('Сайт без кода');
  await expect(page.locator('[data-lm-frame]')).toHaveAttribute('data-view', 'desktop');
  await page.locator('[data-lm-view="phone"]').click();
  await expect(page.locator('[data-lm-frame]')).toHaveAttribute('data-view', 'phone');
  expect(await page.locator('[data-lm-frame]').evaluate((node) => node.style.width)).toBe('390px');
  await expect(page.locator('[data-lm-status]')).toHaveText('Лид-магнит: посмотрите и утвердите');
  await expect(page.locator('[data-lm-text="dm"]')).toContainText('6 / 1000');
});

test('approval needs the checkbox and then shows the files', async ({ page }) => {
  await startWith(withDraft);
  await openLeadTab(page);
  const approveBox = page.locator('[data-lm-approve]');
  const approve = approveBox.locator('button', { hasText: 'Утверждаю лид-магнит' });
  await expect(approve).toBeDisabled();
  await approveBox.locator('input[type="checkbox"]').check();
  await approve.click();
  await expect(page.locator('[data-lm-status]')).toHaveText('Лид-магнит утверждён');
  const pdf = page.locator('[data-lm-files] li', { hasText: 'PDF' });
  await pdf.locator('button').click();
  await expect.poll(() => calls.reveal.at(-1) || '').toMatch(/v01[\\/]page\.pdf$/);
});

test('a red check shows its items and offers no approval', async ({ page }) => {
  await startWith((dir) => withDraft(dir, { ok: false }));
  await openLeadTab(page);
  await expect(page.locator('[data-lm-checks] [data-ok="false"]').first()).toBeVisible();
  await expect(page.locator('[data-lm-approve] button', { hasText: 'Утверждаю' })).toHaveCount(0);
});

test('the sandboxed page reaches neither the pult, nor its parent, nor storage', async ({ page }) => {
  const probe = '<p id="probe">…</p><script>(async () => { const out = [];'
    + "try { await fetch('/api/cards'); out.push('fetch-open'); } catch (e) { out.push('fetch-blocked'); }"
    + "try { void parent.document.title; out.push('parent-open'); } catch (e) { out.push('parent-blocked'); }"
    + "try { void localStorage.length; out.push('storage-open'); } catch (e) { out.push('storage-blocked'); }"
    + "document.getElementById('probe').textContent = out.join(' '); })();</script>";
  await startWith((dir) => withDraft(dir, { page: goodPage({ extra: probe }) }));
  await openLeadTab(page);
  await expect(page.frameLocator('[data-lm-frame]').locator('#probe')).toHaveText('fetch-blocked parent-blocked storage-blocked');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx playwright test tests/pult-lead-magnet-ui.spec.js --project=chromium`
Expected: FAIL – вкладок нет.

- [ ] **Step 3: Add the tab code to `pult/lead-magnet.js`**

```js
const LM_CHECK_LABELS = {
  promise: 'Обещание выполнено',
  cta: 'Блок призыва в конце',
  'phone-width': 'Телефон 390 px',
  'copy-buttons': 'Кнопки «Скопировать»',
  logo: 'Логотип',
  header: 'Шапка без слова «лид-магнит»',
  'self-contained': 'Страница без интернета',
  blocks: 'Разметка блоков',
  texts: 'Тексты в лимитах',
  facts: 'Факты проверены',
};
const LM_FILE_LABELS = {
  'page.html': 'Страница (HTML)',
  'page.pdf': 'PDF',
  'texts/dm.txt': 'Текст в личку',
  'texts/telegram.txt': 'Пост в Telegram',
  'texts/instagram.txt': 'Подпись Instagram',
};
// Какой лид-магнит открыт во вкладке, если у ролика их несколько (разные кодовые слова).
const lmChosen = new Map();
// Активная страница за стеклом: только её сообщения принимаются (задача 5).
let lmActive = null;

async function lmCopyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    notify('Скопировано.');
  } catch (_) {
    notify('Не удалось скопировать – выделите текст и нажмите ⌘C / Ctrl+C', 'error');
  }
}

async function lmRenderTab(container, variant) {
  container.replaceChildren(el('p', 'hint', 'Загружаю лид-магнит…'));
  let leadState;
  try {
    leadState = await lmLoadState(variant);
  } catch (error) {
    container.replaceChildren(el('p', 'lm-error', error.message));
    return;
  }
  lmActive = null;
  container.replaceChildren();
  if (leadState.error) container.append(el('p', 'lm-error', leadState.error));
  for (const broken of leadState.magnets.filter((magnet) => magnet.error)) {
    container.append(el('p', 'lm-error', `«${broken.title}»: ${broken.nextStep}`));
  }
  const magnets = leadState.magnets.filter((magnet) => !magnet.error);
  if (!magnets.length) {
    const word = leadState.pending.find(Boolean);
    const text = leadState.pending.length ? `Агент готовит лид-магнит${word ? ` «${word}»` : ''}.` : 'Лид-магнита у этого ролика пока нет.';
    const next = el('p', 'detail__next', text);
    next.dataset.lmStatus = '';
    container.append(next, lmHandoff(variant, null));
    return;
  }
  const magnet = magnets.find((item) => item.id === lmChosen.get(variant.key)) || magnets[0];
  if (magnets.length > 1) {
    const pills = el('div', 'variant-tabs');
    for (const option of magnets) {
      const pill = el('button', 'variant-tab', option.codeWords.join(', '));
      pill.type = 'button';
      pill.setAttribute('aria-pressed', String(option.id === magnet.id));
      pill.addEventListener('click', () => { lmChosen.set(variant.key, option.id); lmRenderTab(container, variant); });
      pills.append(pill);
    }
    container.append(pills);
  }
  const layout = el('div', 'detail');
  const main = el('div', 'lm-main');
  const side = el('div', 'detail__side');
  const comments = lmCommentsPanel(magnet);
  main.append(lmViewer(magnet, (target) => comments.setTarget(target)), lmTextsPanel(magnet, comments));
  const badge = el('p', `badge badge--${magnet.status}`, LM_STATUS_LABELS[magnet.status]);
  const next = el('p', 'detail__next', magnet.nextStep);
  next.dataset.lmStatus = '';
  side.append(badge, next);
  if (magnet.promiseChanged) side.append(lmPromisePanel(variant, leadState, magnet));
  side.append(lmChecksPanel(magnet), comments.box, lmApprovePanel(magnet), lmFilesPanel(magnet));
  if (magnet.funnel) side.append(lmFunnelPanel(variant, magnet));
  side.append(lmHandoff(variant, magnet));
  layout.append(main, side);
  container.append(layout);
}

function lmViewer(magnet, onBlock) {
  const box = el('div', 'lm-viewer');
  const { revision } = magnet;
  if (!revision || !revision.pageUrl) {
    const empty = el('div', 'player player--empty');
    empty.append(el('p', 'player__label', 'Страница появится, когда агент покажет первую версию.'));
    box.append(empty);
    return box;
  }
  let view = 'desktop';
  let reviewing = false;
  const wrap = el('div', 'lm-frame-wrap');
  const frame = el('iframe', 'lm-frame');
  frame.title = 'Страница лид-магнита';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('allow', 'clipboard-write');
  frame.referrerPolicy = 'no-referrer';
  frame.dataset.lmFrame = '';
  frame.dataset.view = view;
  frame.src = revision.pageUrl;
  wrap.append(frame);
  const layoutFrame = () => {
    const width = view === 'phone' ? 390 : 1280;
    const available = wrap.clientWidth || width;
    const scale = Math.min(1, available / width);
    frame.style.width = `${width}px`;
    frame.style.height = `${Math.round((wrap.clientHeight || 600) / scale)}px`;
    frame.style.transform = `scale(${scale})`;
    frame.style.left = `${Math.max(0, (available - width * scale) / 2)}px`;
    frame.dataset.view = view;
  };
  const sendReview = () => {
    // Страница в песочнице без своего origin: адресовать сообщение можно только '*'.
    if (frame.contentWindow) frame.contentWindow.postMessage({ type: 'lm-review', on: reviewing }, '*');
  };
  const bar = el('div', 'lm-row');
  const views = el('div', 'detail-tabs');
  const viewButtons = [['desktop', '🖥 Компьютер'], ['phone', '📱 Телефон 390']].map(([key, label]) => {
    const tab = el('button', 'detail-tab', label);
    tab.type = 'button';
    tab.dataset.lmView = key;
    tab.setAttribute('aria-pressed', String(key === view));
    tab.addEventListener('click', () => {
      view = key;
      viewButtons.forEach((other) => other.setAttribute('aria-pressed', String(other === tab)));
      layoutFrame();
    });
    return tab;
  });
  views.append(...viewButtons);
  const reviewToggle = lmChoice('checkbox', 'lm-review', 'on', 'Режим правок – кликните по блоку', false);
  reviewToggle.input.dataset.lmReviewMode = '';
  reviewToggle.input.addEventListener('change', () => { reviewing = reviewToggle.input.checked; sendReview(); });
  frame.addEventListener('load', sendReview);
  bar.append(views, reviewToggle.wrap, el('span', 'hint', `Версия ${lmRevisionLabel(revision.n)}`));
  box.append(bar, wrap);
  new ResizeObserver(layoutFrame).observe(wrap);
  layoutFrame();
  lmActive = { frame, view: () => view, onBlock };
  return box;
}

function lmTextsPanel(magnet, comments) {
  const box = el('div', 'lm-texts');
  if (!magnet.revision) return box;
  for (const item of magnet.revision.texts) {
    const card = el('div', 'lm-text');
    card.dataset.lmText = item.kind;
    const meter = el('div', 'lm-meter');
    const fill = el('i');
    fill.style.width = `${Math.min(100, Math.round((item.length / item.limit) * 100))}%`;
    meter.append(fill);
    if (item.length > item.limit) meter.dataset.over = '';
    const row = el('div', 'lm-row');
    row.append(
      button('Скопировать', () => lmCopyText(item.text), 'secondary'),
      button('Правка к тексту', async () => comments.setTarget({ kind: 'text', text: item.kind }), 'link-button'),
    );
    card.append(el('strong', '', LM_TEXT_LABELS[item.kind]), meter, el('span', 'hint', `${item.length} / ${item.limit}`),
      el('p', 'lm-text__body', item.text || '—'), row);
    box.append(card);
  }
  return box;
}

function lmChecksPanel(magnet) {
  const box = el('div', 'lm-panel');
  box.append(el('h3', '', 'Проверка'));
  const { revision } = magnet;
  if (!revision) {
    box.append(el('p', 'hint', 'Агент ещё не показал первую версию.'));
    return box;
  }
  const list = el('ul', 'lm-checks');
  list.dataset.lmChecks = '';
  for (const item of revision.items) {
    const row = el('li', '', `${item.ok ? '✓' : '✕'} ${LM_CHECK_LABELS[item.id] || item.id}: ${item.message}`);
    row.dataset.ok = String(item.ok);
    list.append(row);
  }
  if (!revision.items.length) list.append(el('li', 'hint', 'Отчёта проверки нет – агент запустит её.'));
  box.append(list, el('p', revision.facts.ok ? 'hint' : 'lm-error', `Факты: ${revision.facts.message}`));
  return box;
}

function lmApprovePanel(magnet) {
  const box = el('div', 'lm-panel');
  box.dataset.lmApprove = '';
  box.append(el('h3', '', 'Утверждение'));
  if (magnet.status === 'ready') {
    box.append(el('p', 'hint', 'Лид-магнит утверждён. Файлы – в блоке ниже.'));
    return box;
  }
  const ticket = magnet.revision && magnet.revision.approvalTicket;
  if (!ticket) {
    box.append(el('p', 'hint', 'Утвердить можно, когда проверка зелёная и нет правок, которые ждут агента.'));
    return box;
  }
  const viewed = lmChoice('checkbox', 'lm-viewed', 'yes', 'Я просмотрел страницу на компьютере и телефоне и все тексты', false);
  const approve = el('button', 'primary', 'Утверждаю лид-магнит');
  approve.type = 'button';
  approve.disabled = true;
  viewed.input.addEventListener('change', () => { approve.disabled = !viewed.input.checked; });
  approve.addEventListener('click', async () => {
    approve.disabled = true;
    try {
      await api('/api/lead-magnet/approve', { method: 'POST', body: { id: magnet.id, ticket, confirmViewed: true } });
      notify('Лид-магнит утверждён. Файлы и тексты – в блоке «Файлы».');
      await refresh();
    } catch (error) {
      if (error.code === 'LM_CHANGED') {
        await refresh();
        notify('Появилась новая версия лид-магнита – посмотрите её перед утверждением.', 'error');
        return;
      }
      notify(error.message, 'error');
      approve.disabled = !viewed.input.checked;
    }
  });
  box.append(viewed.wrap, approve);
  return box;
}

function lmFilesPanel(magnet) {
  const box = el('div', 'lm-panel');
  box.dataset.lmFiles = '';
  box.append(el('h3', '', magnet.files.revision ? `Файлы · ${lmRevisionLabel(magnet.files.revision)}` : 'Файлы'));
  if (!magnet.files.list.length) {
    box.append(el('p', 'hint', 'Файлов пока нет.'));
    return box;
  }
  const list = el('ul', 'plain-list');
  for (const file of magnet.files.list) {
    const row = el('li', 'plain-list__row');
    row.append(el('span', '', LM_FILE_LABELS[file] || file),
      button('Показать в папке', () => api('/api/lead-magnet/reveal', { method: 'POST', body: { id: magnet.id, file } }), 'link-button'));
    list.append(row);
  }
  box.append(list);
  return box;
}

function lmFunnelPanel(variant, magnet) {
  const box = el('div', 'lm-panel');
  const { funnel } = magnet;
  const provider = funnel.provider === 'chatplace' ? 'Chatplace' : funnel.provider;
  box.append(el('h3', '', 'Воронка автоответа'),
    el('p', '', `${provider}: на слово ${magnet.codeWords[0]} воронка ${funnel.exists ? 'есть' : 'не найдена'}${funnel.automationName ? ` («${funnel.automationName}»)` : ''} · проверено ${new Date(funnel.checkedAt).toLocaleString('ru-RU')}`),
    button('Проверить ещё раз', () => lmDecide(variant, { type: 'funnel-check', leadMagnetId: magnet.id }), 'secondary'));
  return box;
}

function lmHandoff(variant, magnet) {
  const label = state.data ? state.data.projectsLabel : 'projects';
  const phrase = magnet
    ? `Продолжи лид-магнит «${magnet.title}» (${label}/.lead-magnets/${magnet.id}) для ролика ${label}/${variant.folder}: выполни automontage inbox и обработай входящие.`
    : `Подготовь лид-магнит для ролика ${label}/${variant.folder}: выполни automontage inbox и обработай входящие.`;
  const box = el('div', 'agent-handoff');
  const field = el('textarea', 'phrase');
  field.rows = 3;
  field.readOnly = true;
  field.value = phrase;
  field.dataset.lmAgentPhrase = '';
  field.setAttribute('aria-label', 'Фраза для агента');
  box.append(el('h3', '', 'Передать агенту'), el('p', 'hint', 'Скопируйте фразу и вставьте её в чат с агентом.'), field,
    button('Скопировать для агента', () => lmCopyText(phrase), 'primary'));
  return box;
}

// Правки (задача 5) и «обещание изменилось» (задача 6) – пока заглушки с тем же интерфейсом.
function lmCommentsPanel() {
  const box = el('div', 'lm-panel lm-comments');
  box.append(el('h3', '', 'Правки'));
  return { box, setTarget() {} };
}

function lmPromisePanel() {
  return el('div');
}
```

- [ ] **Step 4: Tabs in `pult/app.js`**

4a. Начальное состояние: в объекте `state` добавь поле `detailTab: 'video'`, в объекте
`shownDetail` – поле `leadSignature: ''`.

4b. В `openCard` после строки `state.openCardId = cardId;` добавь `state.detailTab = 'video';`.

4c. Перед функцией `renderDetail` добавь:

```js
// Вкладки «Видео | Лид-магнит» – когда у ролика есть работа по лид-магниту (запрос, черновик,
// утверждённый). Одного вопроса «Разработать?» для них мало: он живёт плашкой на вкладке «Видео».
function detailTabs(variant) {
  if (!variant.leadMagnet || !variant.leadMagnet.status) return null;
  const tabs = el('div', 'detail-tabs');
  tabs.dataset.detailTabs = '';
  for (const [key, label] of [['video', 'Видео'], ['lead', 'Лид-магнит 🎁']]) {
    const tab = el('button', 'detail-tab', label);
    tab.type = 'button';
    tab.setAttribute('aria-pressed', String(state.detailTab === key));
    tab.addEventListener('click', () => {
      state.detailTab = key;
      renderDetail();
    });
    tabs.append(tab);
  }
  return tabs;
}
```

4d. В `renderDetail` сразу перед строкой `const layout = el('div', 'detail');` вставь:

```js
  const leadTabs = detailTabs(variant);
  shownDetail.leadSignature = JSON.stringify(variant.leadMagnet || null);
  if (!leadTabs) state.detailTab = 'video';
  if (leadTabs) view.append(leadTabs);
  if (leadTabs && state.detailTab === 'lead') {
    const container = el('div', 'lm-tab');
    view.append(container);
    lmRenderTab(container, variant);
    shownDetail.key = variant.key;
    shownDetail.videoUrl = variant.video ? variant.video.url : '';
    shownDetail.ticket = variant.approvalTicket || '';
    return;
  }
```

4e. В `syncDetail` сразу после блока `if (variant.key !== shownDetail.key) { … }` вставь:

```js
  // Лид-магнит изменился (агент выпустил версию, правку приняли, утвердили вне пульта).
  // Вкладку лид-магнита и смену набора вкладок перерисовываем целиком; на вкладке «Видео»
  // меняем только плашку, чтобы не сбить плеер.
  const leadSignature = JSON.stringify(variant.leadMagnet || null);
  if (leadSignature !== shownDetail.leadSignature) {
    const tabsShown = Boolean(document.querySelector('[data-detail-tabs]'));
    if (state.detailTab === 'lead' || tabsShown !== Boolean(variant.leadMagnet && variant.leadMagnet.status)) {
      rerenderDetailKeepingDraft();
      if (state.detailTab === 'lead') notify('Лид-магнит обновился.');
      return;
    }
    const slot = document.querySelector('[data-lm-offer-slot]');
    if (slot) {
      slot.replaceChildren();
      lmRenderBanner(slot, variant, () => document.querySelector('[data-player]'));
    }
    shownDetail.leadSignature = leadSignature;
  }
  if (state.detailTab === 'lead') return;
```

- [ ] **Step 5: Styles**

```css
.detail-tabs { display: inline-flex; margin-bottom: 1rem; border: 1px solid hsl(var(--border)); border-radius: 999px; overflow: hidden; }
.detail-tab { padding: 0.45rem 0.9rem; border: 0; background: transparent; cursor: pointer; }
.detail-tab[aria-pressed="true"] { background: hsl(var(--amber-soft)); }
.lm-main { display: flex; flex-direction: column; gap: 0.8rem; min-width: 0; }
.lm-viewer { display: flex; flex-direction: column; gap: 0.6rem; }
.lm-viewer .detail-tabs { margin-bottom: 0; }
.lm-frame-wrap { position: relative; height: 70vh; overflow: hidden; border-radius: var(--radius); background: hsl(var(--card-raised)); }
.lm-frame { position: absolute; top: 0; left: 0; border: 0; background: #fff; transform-origin: 0 0; }
.lm-texts { display: grid; gap: 0.6rem; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); }
.lm-text { display: flex; flex-direction: column; gap: 0.35rem; padding: 0.7rem; background: hsl(var(--card)); border: 1px solid hsl(var(--border)); border-radius: 0.6rem; font-size: 0.88rem; }
.lm-text .hint { margin: 0; }
.lm-text__body { margin: 0; max-height: 9rem; overflow: auto; white-space: pre-wrap; color: hsl(var(--muted-foreground)); }
.lm-meter { height: 0.35rem; border-radius: 999px; background: hsl(var(--border)); overflow: hidden; }
.lm-meter > i { display: block; height: 100%; background: hsl(var(--teal)); }
.lm-meter[data-over] > i { background: hsl(var(--danger)); }
.lm-checks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.9rem; }
.lm-checks [data-ok="false"] { color: hsl(var(--danger)); }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx playwright test tests/pult-lead-magnet-ui.spec.js tests/pult-ui.spec.js --project=chromium`
Expected: PASS. Если тест «песочница» показывает `storage-open`, проверь, что у iframe стоит
`sandbox="allow-scripts"` **без** `allow-same-origin` и что заголовок страницы содержит
`sandbox allow-scripts` (план 1B-1, задача 7).

- [ ] **Step 7: Commit**

```bash
git add pult/lead-magnet.js pult/app.js pult/styles.css tests/pult-lead-magnet-ui.spec.js
git commit -m "feat(pult): lead magnet tab with the sandboxed page, checks, texts and approval

Refs #63"
```

---

### Task 5: Правки кликом по блоку и к текстам

**Files:**
- Modify: `pult/lead-magnet.js` (заменить заглушку `lmCommentsPanel`, дописать обработчик сообщений), `pult/styles.css`
- Test: `tests/pult-lead-magnet-ui.spec.js` (дописать)

- [ ] **Step 1: Write the failing tests**

```js
test('a click on a block in review mode becomes a comment with a snapshot', async ({ page }) => {
  await startWith(withDraft);
  await openLeadTab(page);
  await page.locator('[data-lm-view="phone"]').click();
  await page.locator('[data-lm-review-mode]').check();
  await page.frameLocator('[data-lm-frame]').locator('[data-lm-block="steps"] h2').click();
  await expect(page.locator('[data-lm-target]')).toHaveText('К блоку «steps» · телефон');
  await page.locator('[data-lm-comment-text]').fill('Промпт не помещается в строку');
  await page.locator('.lm-comments button', { hasText: 'Добавить правку' }).click();
  const item = page.locator('[data-lm-comments] .comment').first();
  await expect(item).toContainText('Промпт не помещается в строку');
  await expect(item).toContainText('блок «steps» · телефон');
  await expect(item.locator('img.comment__frame')).toBeVisible();
  await expect(page.locator('[data-lm-status]')).toHaveText('Лид-магнит: ждёт агента, правок: 1');
});

test('a text gets its own comment, and a waiting comment can be deleted', async ({ page }) => {
  await startWith(withDraft);
  await openLeadTab(page);
  await page.locator('[data-lm-text="telegram"] button', { hasText: 'Правка к тексту' }).click();
  await expect(page.locator('[data-lm-target]')).toHaveText('К тексту «Пост в Telegram»');
  await page.locator('[data-lm-comment-text]').fill('Короче на треть');
  await page.locator('.lm-comments button', { hasText: 'Добавить правку' }).click();
  await expect(page.locator('[data-lm-comments] .comment')).toHaveCount(1);
  await page.locator('[data-lm-comments] .comment button', { hasText: 'Удалить' }).click();
  await expect(page.locator('[data-lm-comments] .comment')).toHaveCount(0);
});

test('outside review mode a click on the page does not start a comment, links are announced', async ({ page }) => {
  const link = '<p><a data-lm-link href="https://example.com/practicum">Практикум</a></p>';
  await startWith((dir) => withDraft(dir, { page: goodPage({ extra: link }) }));
  await openLeadTab(page);
  await page.frameLocator('[data-lm-frame]').locator('[data-lm-block="steps"] h2').click();
  await expect(page.locator('[data-lm-target]')).toContainText('Включите «Режим правок»');
  await page.frameLocator('[data-lm-frame]').locator('[data-lm-link]').click();
  await expect(page.locator('[data-notice]')).toContainText('https://example.com/practicum');
  await expect(page.frameLocator('[data-lm-frame]').locator('h1')).toHaveText('Сайт без кода');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx playwright test tests/pult-lead-magnet-ui.spec.js --project=chromium`
Expected: FAIL – правок нет.

- [ ] **Step 3: Replace the stub `lmCommentsPanel`**

Удали заглушку `function lmCommentsPanel() { … }` и добавь в конец файла:

```js
const LM_BLOCK_ID = /^[a-z0-9][a-z0-9-]{0,60}$/;

function lmTargetName(target) {
  return target.kind === 'block'
    ? `блок «${target.blockId}» · ${target.view === 'phone' ? 'телефон' : 'компьютер'}`
    : `текст «${LM_TEXT_LABELS[target.text]}»`;
}

function lmTargetTo(target) {
  return target.kind === 'block'
    ? `К блоку «${target.blockId}» · ${target.view === 'phone' ? 'телефон' : 'компьютер'}`
    : `К тексту «${LM_TEXT_LABELS[target.text]}»`;
}

function lmCommentsPanel(magnet) {
  const box = el('div', 'lm-panel lm-comments');
  box.append(el('h3', '', 'Правки'));
  let target = null;
  const where = el('p', 'hint', 'Включите «Режим правок» и кликните по блоку страницы или нажмите «Правка к тексту».');
  where.dataset.lmTarget = '';
  const text = lmTextInput('', 'Текст правки', { multiline: true, maxLength: 1000 });
  text.placeholder = 'Что поправить?';
  text.dataset.lmCommentText = '';
  const save = el('button', 'secondary', 'Добавить правку');
  save.type = 'button';
  save.disabled = true;
  const canSave = () => { save.disabled = !target || !text.value.trim() || !magnet.revision; };
  text.addEventListener('input', canSave);
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await api('/api/lead-magnet/comment', {
        method: 'POST', body: { id: magnet.id, revision: magnet.revision.n, target, text: text.value.trim() },
      });
      notify('Правка сохранена. Когда закончите, скопируйте фразу для агента.');
      await refresh();
    } catch (error) {
      notify(error.message, 'error');
      canSave();
    }
  });
  const form = el('div', 'comment-form');
  form.append(where, text, save);
  const list = el('ul', 'comment-list');
  list.dataset.lmComments = '';
  const comments = magnet.comments || [];
  if (magnet.commentsBroken) list.append(el('li', 'lm-error', 'Файл правок лид-магнита повреждён – попросите агента проверить.'));
  else if (!comments.length) list.append(el('li', 'hint', 'Правок пока нет.'));
  comments.forEach((comment, index) => {
    const item = el('li', `comment comment--${comment.status}`);
    item.append(el('span', 'comment__status',
      `№${index + 1} · ${lmRevisionLabel(comment.revision)} · ${lmTargetName(comment.target)} · ${comment.status === 'new' ? 'ждёт агента' : 'принята агентом'}`));
    if (comment.snapshotUrl) {
      const image = el('img', 'comment__frame');
      image.alt = '';
      image.src = mediaUrl(comment.snapshotUrl);
      item.append(image);
    }
    item.append(el('p', 'comment__text', comment.text));
    if (comment.status === 'new') {
      item.append(button('Удалить', async () => {
        await api('/api/lead-magnet/comment/delete', { method: 'POST', body: { id: magnet.id, commentId: comment.id } });
        await refresh();
      }, 'link-button'));
    }
    list.append(item);
  });
  box.append(form, list);
  return {
    box,
    setTarget(next) {
      target = next;
      where.textContent = lmTargetTo(next);
      canSave();
      text.focus();
    },
  };
}

// Сообщения страницы за стеклом. Принимаем только от активного iframe и только известной формы:
// страницу собирал агент, её содержимое – данные, а не команды пульту.
function lmHandleMessage(event) {
  if (!lmActive || !lmActive.frame.isConnected || event.source !== lmActive.frame.contentWindow) return;
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'lm-link' && typeof data.href === 'string') {
    notify(`Ссылка на странице: ${data.href.slice(0, 300)} – зритель откроет её после публикации.`);
    return;
  }
  const { rect } = data;
  const rectOk = rect && typeof rect === 'object' && ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(rect[key]) && rect[key] >= 0);
  if (data.type !== 'lm-block' || typeof data.blockId !== 'string' || !LM_BLOCK_ID.test(data.blockId) || !rectOk) return;
  lmActive.onBlock({
    kind: 'block', blockId: data.blockId, view: lmActive.view(), rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
  });
}

window.addEventListener('message', lmHandleMessage);
```

- [ ] **Step 4: Styles**

```css
.lm-comments textarea { resize: vertical; }
.lm-comments .comment-form .hint { margin: 0; }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx playwright test tests/pult-lead-magnet-ui.spec.js --project=chromium`
Expected: PASS. Клик по `h2` внутри блока, а не по самому `section`, – так проверяется поиск
ближайшего `data-lm-block` скриптом правок (план 1B-1, задача 7).

- [ ] **Step 6: Commit**

```bash
git add pult/lead-magnet.js pult/styles.css tests/pult-lead-magnet-ui.spec.js
git commit -m "feat(pult): comment on a lead magnet block or text from the review tab

Refs #63"
```

---

### Task 6: «Обещание изменилось»

**Files:**
- Modify: `pult/lead-magnet.js` (заменить заглушку `lmPromisePanel`), `pult/styles.css`
- Test: `tests/pult-lead-magnet-ui.spec.js` (дописать)

- [ ] **Step 1: Write the failing test**

```js
test('a changed promise shows both quotes and «Оставить как есть» settles it', async ({ page }) => {
  await startWith((dir) => {
    const id = approvedIn(dir, 'clip');
    const clipDir = path.join(dir, 'clip');
    fs.writeFileSync(path.join(clipDir, 'script.txt'), 'Финал. и я пришлю пошаговую инструкцию и семь промптов.');
    addOffer(clipDir, {
      codeWord: 'ГАЙД', kind: 'comment-keyword', quote: 'и я пришлю пошаговую инструкцию и семь промптов',
      units: UNITS, sourceKind: 'script', scriptPath: 'script.txt',
    });
    return { id };
  });
  await openLeadTab(page);
  const warning = page.locator('[data-lm-promise-changed]');
  await expect(warning).toContainText(`Было: «${QUOTE}»`);
  await expect(warning).toContainText('Стало: «и я пришлю пошаговую инструкцию и семь промптов»');
  await warning.locator('button', { hasText: 'Оставить как есть' }).click();
  await expect(page.locator('[data-lm-status]')).toHaveText('Лид-магнит утверждён');
  await expect(page.locator('[data-lm-promise-changed]')).toHaveCount(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test tests/pult-lead-magnet-ui.spec.js --project=chromium`
Expected: FAIL – блока нет (заглушка).

- [ ] **Step 3: Replace the stub `lmPromisePanel`**

Удали заглушку `function lmPromisePanel() { … }` и добавь в конец файла:

```js
// Обещание в ролике изменилось после того, как лид-магнит сделан. Агент сам ничего не
// переделывает: решение – кнопка человека.
function lmPromisePanel(variant, leadState, magnet) {
  const box = el('div', 'lm-panel lm-warning');
  box.dataset.lmPromiseChanged = '';
  const offer = leadState.offers.find((item) => magnet.codeWords.includes(item.codeWord));
  box.append(
    el('h3', '', '⚠️ Обещание в ролике изменилось'),
    el('p', 'hint', 'Лид-магнит сделан под прежнюю цитату.'),
    el('blockquote', 'lm-quote lm-quote--old', `Было: «${magnet.promise.quote}»`),
    el('blockquote', 'lm-quote', offer ? `Стало: «${offer.quote}»` : 'Стало: обещания в ролике больше нет'),
  );
  if (offer) {
    const row = el('div', 'lm-row');
    row.append(
      button('Обновить под новое', () => lmDecide(variant, { type: 'promise-refresh', offerId: offer.offerId, leadMagnetId: magnet.id }), 'primary'),
      button('Оставить как есть', () => lmDecide(variant, { type: 'promise-keep', offerId: offer.offerId, leadMagnetId: magnet.id }), 'secondary'),
    );
    box.append(row, el('p', 'hint', 'Агент сам ничего не переделывает: ваша кнопка – его задание.'));
  }
  return box;
}
```

- [ ] **Step 4: Styles**

```css
.lm-warning { border-color: hsl(var(--danger) / 0.6); }
.lm-quote--old { opacity: 0.7; text-decoration: line-through; }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx playwright test tests/pult-lead-magnet-ui.spec.js tests/pult-ui.spec.js --project=chromium`
Expected: PASS – весь spec лид-магнита и прежние тесты пульта.

- [ ] **Step 6: Commit**

```bash
git add pult/lead-magnet.js pult/styles.css tests/pult-lead-magnet-ui.spec.js
git commit -m "feat(pult): settle a changed promise from the lead magnet tab

Refs #63"
```

---

### Task 7: Документация, живая проверка и полный прогон

**Files:**
- Modify: `docs/PULT.md` (новый раздел «Лид-магнит»), `docs/LEAD-MAGNET.md` (раздел «Пульт»),
  `CHANGELOG.md`, `TESTING.md`, `ARCHITECTURE.md` (одна строка про `pult/lead-magnet.js`)

- [ ] **Step 1: Write the user docs**

`docs/PULT.md`, новый раздел «Лид-магнит» после «Работа с роликом», простым языком:
1. **Метка и плашка.** Что значит «🎁 Лид-магнит?» и три кнопки. «Нет» можно отменить кнопкой
   «🎁 Лид-магнит» в действиях.
2. **Окно параметров.** Галочка обещания, четыре варианта дизайна. Референс: что можно
   приложить, лимиты, что значат галочки «что взять».
3. **Вкладка «Лид-магнит».**
   - «Компьютер / Телефон 390»;
   - почему страница «за стеклом»: кнопки на ней работают, ссылки в пульте не открываются, а
     показываются строкой сверху;
   - режим правок;
   - правки к текстам.
4. **Утверждение.** Почему кнопки нет, пока проверка красная или есть правки.
5. **«Обещание изменилось».**
6. **Файлы и «Скопировать для агента».**

Добавь строки в таблицу «Если что-то не так»:
- «Лид-магнит изменился – посмотрите новую версию»;
- «Файл лид-магнита повреждён»;
- «Ссылка на странице: …».

- [ ] **Step 2: Living docs**

- `docs/LEAD-MAGNET.md`: раздел «Пульт» – что видит человек и какие решения попадают агенту.
- `CHANGELOG.md`: «Пульт: экраны лид-магнита – вопрос с цитатой обещания, окно параметров с
  референсами, вкладка проверки со страницей за стеклом, правки кликом, утверждение».
- `TESTING.md`: `tests/pult-lead-magnet-ui.spec.js` в составе `npm run test:review-ui`.
- `ARCHITECTURE.md`: `pult/lead-magnet.js` – экраны лид-магнита, подключаются до `app.js`.

- [ ] **Step 3: Live check (screenshots)**

Запусти пульт на временной копии с фикстурами задачи 4 (или на реальной папке с лид-магнитом,
если она есть) и сними снимки:
- плашки;
- окна параметров с референсом;
- вкладки на компьютере и в виде телефона.

Сравни с макетами `docs/superpowers/specs/2026-09-30-lead-magnet-mockups.html`. Несовпадения
вёрстки исправь, отличия по смыслу запиши в «Отклонения от плана».

- [ ] **Step 4: Full verification**

```bash
npm test
npm run test:review-ui
node scripts/check-public-privacy.js --tracked
```

Expected: всё зелёное.

- [ ] **Step 5: Commit**

```bash
git add docs/PULT.md docs/LEAD-MAGNET.md CHANGELOG.md TESTING.md ARCHITECTURE.md
git commit -m "docs(pult): document the lead magnet screens

Refs #63"
```

- [ ] **Step 6: Issue и PR (только по просьбе владельца)** – как в 1B-1.

---

## Self-review (выполнено при написании)

- **Покрытие (экраны):**
  - F2 (метка, плашка, три кнопки, «Нет» с возвратом) → задачи 1, 2;
  - F3 (окно параметров) → задача 3;
  - F4 (референсы: файлы, ссылки, «что взять», «что нравится») → задача 3;
  - F9 (вкладка: компьютер / телефон, проверка, тексты, файлы, агент) → задача 4;
  - F10 (правки кликом и к текстам, снимок) → задача 5;
  - F11 (утверждение с галочкой) → задача 4;
  - F12 (вкладки и разделы) → задачи 1, 4 + сервер 1B-1;
  - F13 → задача 6;
  - F16 (воронка, чтение) → задача 4 (`lmFunnelPanel`).
- **Безопасность:**
  - песочница без сети, родителя и хранилища – тест задачи 4;
  - сообщения только от активного iframe и известной формы – задача 5;
  - ссылки страницы не уводят – задача 5;
  - ошибки загрузки показываются в окне – задача 3.
- **Имена сверены с планом 1B-1:**
  - `leadMagnet`, `leadMagnetAsk`;
  - поля `/api/lead-magnet`: `offers`, `pending`, `magnets[].revision.{n, items, facts, texts, pageUrl, approvalTicket}`, `files.{revision, list}`, `comments[].snapshotUrl`, `funnel`, `brand.defaultTake`, `library`;
  - коды `LM_CHANGED`.
- **Открытый вопрос спецификации №1 (копирование внутри песочницы):** iframe получает
  `allow="clipboard-write"`, но сами кнопки «Скопировать» на странице делает шаблон части 1C – там
  же и проверяется, что копирование работает в пульте.
