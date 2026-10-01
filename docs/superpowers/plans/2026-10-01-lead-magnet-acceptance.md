# Лид-магнит – приёмка этапа 1: план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement tasks A–D. Task E is a live run with the owner, not code. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Закрыть этап 1 (Issue #63):
- значок пульта передаёт путь к бренд-паку;
- проверено, что кнопки «Скопировать» работают на странице «за стеклом»;
- главная кнопка в конце лид-магнита выбирается в окне параметров (своя ссылка, призыв
  бренд-пака или без призыва), а соцсети из бренд-пака стоят внизу всегда;
- прибрано за параллельной работой;
- один настоящий лид-магнит прошёл весь путь от обещания в ролике до «Утверждаю» владельца.

**Architecture:** Код – две маленькие правки (значок пульта и браузерный тест). Остальное –
документация и живой прогон по навыку `skills/lead-magnet/SKILL.md` на реальном ролике.

**Tech Stack:** Node.js 20+, `node:test`, Playwright, `automontage lead-magnet`, «Пульт роликов».

**Опирается на:** части 1A, 1B, 1C в `main` (PR #64, #66, #68). Задачи 3 и 8 плана
`2026-10-01-lead-magnet-1c-agent-skill.md` входят сюда как задачи B и E. **Задача:** #63.

---

## Подготовка

- [ ] Ветка от свежего `main`:

```bash
git switch docs/lead-magnet-acceptance-plan && git switch -c feat/lead-magnet-acceptance
git config core.hooksPath .githooks
```

- [ ] Базовая линия: `npm test`, `npm run test:review-ui` – зелёные.

---

### Task A: значок пульта передаёт путь к бренд-паку

Значок macOS запускает пульт не из терминала и видит только то, что записано в скрипт значка
(`PATH`, `AUTOMONTAGE_FFMPEG_DIR`). Без `LEAD_MAGNET_BRAND`/`THEMES_EXT` пульт, открытый значком,
считает, что бренд-пака нет: подсказка «что взять из референса» в окне параметров будет как у
новичка.

**Files:**
- Modify: `scripts/pult/shortcut.js` (`macShortcutFiles`)
- Test: `tests/pult-shortcut.test.js`
- Docs: `docs/PULT.md` (раздел «Как открыть»), `docs/LEAD-MAGNET.md` (раздел «Свой бренд-пак»)

- [ ] **Step 1: Write the failing test** (в конец `tests/pult-shortcut.test.js`; импорт
  `macShortcutFiles` в файле уже есть)

```js
test('the mac shortcut keeps the brand pack paths for the lead magnet screens', () => {
  const { files } = macShortcutFiles({
    root: '/r/AutoMontage',
    nodePath: '/n/node',
    homeDir: '/tmp/home-u',
    env: { PATH: '/usr/bin', LEAD_MAGNET_BRAND: '/b/pack/lead-magnet', THEMES_EXT: '/b/pack/themes' },
  });
  const script = files.find((file) => file.relative === 'Contents/MacOS/pult').content;
  assert.ok(script.includes("export LEAD_MAGNET_BRAND='/b/pack/lead-magnet'\n"));
  assert.ok(script.includes("export THEMES_EXT='/b/pack/themes'\n"));
});
```

- [ ] **Step 2: Run to verify it fails** – `node --test tests/pult-shortcut.test.js` → FAIL.

- [ ] **Step 3: Implement.** В `macShortcutFiles` замени строку с `AUTOMONTAGE_FFMPEG_DIR` на:

```js
  // Пути, которые пульт читает из окружения: ffmpeg и приватный бренд-пак (темы, лид-магниты).
  for (const name of ['AUTOMONTAGE_FFMPEG_DIR', 'LEAD_MAGNET_BRAND', 'THEMES_EXT']) {
    if (env[name]) lines.push(`export ${name}=${shellQuote(env[name])}`);
  }
```

  Существующий тест со строкой скрипта целиком не меняется: в его `env` новых переменных нет.

- [ ] **Step 4: Docs.**
  - `docs/PULT.md`: «Настроили бренд-пак (`LEAD_MAGNET_BRAND` или `THEMES_EXT`) – пересоздайте
    значок той же командой».
  - `docs/LEAD-MAGNET.md`: то же одной строкой.
  - Windows-ярлык переменные не хранит – там переменную задают в настройках пользователя Windows.

- [ ] **Step 5: Run & commit**

```bash
node --test tests/pult-shortcut.test.js
git add scripts/pult/shortcut.js tests/pult-shortcut.test.js docs/PULT.md docs/LEAD-MAGNET.md
git commit -m "fix(pult): keep brand pack paths in the mac shortcut

Refs #63"
```

---

### Task B: кнопки «Скопировать» работают за стеклом (задача 3 плана 1C)

Выполни задачу 3 плана `2026-10-01-lead-magnet-1c-agent-skill.md` без изменений:
тест `copy buttons of a scaffolded page work inside the sandbox` в `tests/pult-lead-magnet-ui.spec.js`
(помощники `startWith`, `openLeadTab`, `addLeadMagnetFor`, `publishCheckedRevision` уже есть в spec).

Если `navigator.clipboard` в песочнице отказан и резервный `execCommand('copy')` тоже не сработал:
- запиши текст ошибки браузера;
- **остановись** – выбор за владельцем.

Ослаблять песочницу (`allow-same-origin`) нельзя.

```bash
npx playwright test tests/pult-lead-magnet-ui.spec.js --project=chromium -g "copy buttons"
git add tests/pult-lead-magnet-ui.spec.js scripts/lead-magnet/scaffold.js
git commit -m "test(pult): copy buttons work inside the sandboxed lead magnet page

Refs #63"
```

---

### Task C: призыв в конце – своя кнопка и соцсети

Решение владельца (2026-10-01):
- Внизу каждого лид-магнита **всегда** стоят ссылки на соцсети автора со значками – они
  постоянные и живут в бренд-паке (`socials`).
- Главная кнопка «куда ведём» – **своя у каждого лид-магнита** и выбирается в окне параметров:
  - `brand` – призыв по умолчанию из бренд-пака (`cta`), например «Telegram-канал»;
  - `link` – своя ссылка с заголовком и надписью кнопки (практикум, вебинар; адреса часто
    меняются), к ней добавляется UTM бренд-пака;
  - `none` – без призыва, только соцсети.
- Окно подставляет последнюю использованную свою ссылку.
- Правило проверки `cta` не меняется: блок `data-lm="cta"` – это нижний блок со ссылками, он есть
  всегда.

**Files:**
- Modify:
  - `schema/lead-magnet-brand.schema.json` (`socials`);
  - `templates/lead-magnet/neutral/brand.json` (`"socials": []`);
  - `schema/lead-magnet-requests.schema.json` (`params.cta`, необязательное);
  - `scripts/lead-magnet/requests.js` (`checkParams`);
  - `scripts/lead-magnet/scaffold.js` (`ctaHtml`, значки, стили);
  - `scripts/pult/lead-magnet-routes.js` (`brandView`, `lastLink`);
  - `pult/lead-magnet.js` (пункт 8 окна);
  - `scripts/lead-magnet/inbox.js` (`describeParams`);
  - `skills/lead-magnet/references/texts.md`.
- Docs:
  - `docs/LEAD-MAGNET.md` (бренд-пак: `socials`; окно: пункт 8);
  - `docs/PULT.md`;
  - спецификация (F3 – пункт 8, F7 – что считается блоком призыва, F15 – `socials`);
  - `CHANGELOG.md`.
- Test:
  - `tests/lead-magnet-requests.test.js`, `tests/lead-magnet-brand.test.js`;
  - `tests/lead-magnet-scaffold.test.js`, `tests/lead-magnet-scaffold-check.test.js`;
  - `tests/pult-lead-magnet-server.test.js`, `tests/pult-lead-magnet-ui.spec.js`.

- [ ] **Step 1: Write the failing tests**

`tests/lead-magnet-requests.test.js` (помощники `params`, `withOffer`, `NOW`, `ID` этого файла):

```js
test('the closing call is optional; a custom link needs a title, a label and an https address', (t) => {
  const { projectDir } = withOffer(t);
  const create = (cta) => addDecision(projectDir, { type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: params({ cta }) }, { now: NOW, id: ID });
  const link = create({ mode: 'link', title: 'Хочешь глубже?', label: 'Практикум', url: 'https://example.com/p' });
  assert.deepEqual(link.params.cta, { mode: 'link', title: 'Хочешь глубже?', label: 'Практикум', url: 'https://example.com/p' });
  assert.deepEqual(create({ mode: 'none', title: 'x', label: 'y', url: 'z' }).params.cta, { mode: 'none', title: '', label: '', url: '' });
  assert.throws(() => create({ mode: 'link', title: 'Глубже', label: 'Практикум', url: 'http://example.com' }), /https/);
  assert.throws(() => create({ mode: 'link', title: '', label: 'Практикум', url: 'https://example.com' }), /заголов/);
  assert.equal(create(undefined).params.cta, undefined);
});
```

(Если помощник `params()` не принимает `cta: undefined` как «нет поля» – убери ключ при `undefined`.)

`tests/lead-magnet-scaffold.test.js` (помощник `pack(t, overrides)` этого файла; добавь в нём
`socials` по умолчанию: Telegram, Instagram, YouTube с вымышленными адресами `https://t.me/example`,
`https://instagram.com/example`, `https://youtube.com/@example`):

```js
function scaffoldWith(t, cta, env) {
  const { projectsDir, id } = makeLeadMagnet(t);
  const passport = library.readLeadMagnet(projectsDir, id);
  library.savePassport(projectsDir, { ...passport, params: { ...passport.params, ...(cta ? { cta } : {}) } }, () => new Date());
  const { n, dir } = library.startRevision(projectsDir, id);
  writeScaffold(projectsDir, id, n, { env });
  return fs.readFileSync(path.join(dir, 'page.html'), 'utf8');
}

test('socials from the brand pack are always at the bottom, with icons', (t) => {
  const env = { LEAD_MAGNET_BRAND: pack(t) };
  for (const cta of [undefined, { mode: 'none', title: '', label: '', url: '' }]) {
    const html = scaffoldWith(t, cta, env);
    for (const network of ['telegram', 'instagram', 'youtube']) assert.match(html, new RegExp(`data-lm-social="${network}"[^>]*><svg`));
    assert.match(html, /data-lm="cta"/);
  }
});

test('the main call follows the chosen mode', (t) => {
  const env = { LEAD_MAGNET_BRAND: pack(t) };
  const link = scaffoldWith(t, { mode: 'link', title: 'Хочешь собрать проект с нуля?', label: 'Бесплатный практикум', url: 'https://example.com/p' }, env);
  assert.ok(link.includes('href="https://example.com/p?utm_source=youtube&amp;utm_campaign=gayd"'));
  assert.match(link, /Хочешь собрать проект с нуля\?/);
  assert.match(scaffoldWith(t, undefined, env), /Практикум/, 'brand: кнопка бренд-пака');
  assert.doesNotMatch(scaffoldWith(t, { mode: 'none', title: '', label: '', url: '' }, env), /lm-cta__button/);
});
```

`tests/lead-magnet-brand.test.js`: битый адрес в `socials` (`http://…` или `javascript:`) – бренд-пак
отклоняется с ошибкой «бренд-пак».

`tests/lead-magnet-scaffold-check.test.js`: тот же сценарий «заполненная заготовка проходит все
правила», но с `params.cta = { mode: 'none', … }` и бренд-паком с соцсетями – `cta` зелёный.

`tests/pult-lead-magnet-server.test.js`:

```js
test('the state offers the last custom link and the brand call', async (t) => {
  const projectsDir = root(t);
  const id = addLeadMagnetFor(projectsDir, 'clip');
  const passport = library.readLeadMagnet(projectsDir, id);
  library.savePassport(projectsDir, { ...passport, params: { ...passport.params, cta: { mode: 'link', title: 'Глубже?', label: 'Практикум', url: 'https://example.com/p' } } }, () => new Date());
  const { session } = await start(t, projectsDir);
  const state = (await get(session, '/api/lead-magnet?key=clip')).json;
  assert.deepEqual(state.lastLink, { title: 'Глубже?', label: 'Практикум', url: 'https://example.com/p' });
  assert.deepEqual(Object.keys(state.brand.call).sort(), ['buttons', 'title']);
  assert.ok(Array.isArray(state.brand.socials));
});
```

`tests/pult-lead-magnet-ui.spec.js`:

```js
test('the wizard sends the chosen closing call and prefills the last custom link', async ({ page }) => {
  await startWith((dir) => {
    const id = addLeadMagnetFor(dir, 'clip');
    const passport = library.readLeadMagnet(dir, id);
    library.savePassport(dir, { ...passport, params: { ...passport.params, cta: { mode: 'link', title: 'Глубже?', label: 'Практикум', url: 'https://example.com/p' } } }, () => new Date());
    return { id };
  });
  await openClip(page);
  await page.locator('.actions button', { hasText: '🎁 Лид-магнит' }).click();
  const wizard = page.locator('[data-lm-wizard]');
  await wizard.locator('[data-lm-code-word]').fill('ГАЙД');
  await wizard.locator('.lm-choice', { hasText: 'Своя ссылка' }).click();
  await expect(wizard.locator('[data-lm-cta-url]')).toHaveValue('https://example.com/p');
  await wizard.locator('[data-lm-cta-url]').fill('http://bad');
  await expect(wizard.locator('[data-lm-send]')).toBeDisabled();
  await wizard.locator('[data-lm-cta-url]').fill('https://example.com/new');
  await wizard.locator('[data-lm-send]').click();
  await expect(wizard).toHaveCount(0);
  const create = readDecisions(path.join(projectsDir, 'clip')).find((decision) => decision.type === 'create');
  expect(create.params.cta).toEqual({ mode: 'link', title: 'Глубже?', label: 'Практикум', url: 'https://example.com/new' });
});
```

- [ ] **Step 2: Run to verify they fail** – `node --test` по пяти файлам и `npx playwright test
  tests/pult-lead-magnet-ui.spec.js --project=chromium -g "closing call"` → FAIL.

- [ ] **Step 3: Schemas and params**

`schema/lead-magnet-brand.schema.json`: `socials` добавь в `required` и в `properties`:

```json
"socials": {
  "type": "array", "maxItems": 8,
  "items": {
    "type": "object",
    "additionalProperties": false,
    "required": ["network", "label", "url"],
    "properties": {
      "network": { "enum": ["telegram", "instagram", "youtube", "vk", "site"] },
      "label": { "type": "string", "minLength": 1, "maxLength": 40 },
      "url": { "type": "string", "pattern": "^https://", "maxLength": 500 }
    }
  }
}
```

`templates/lead-magnet/neutral/brand.json`: `"socials": []`.

`schema/lead-magnet-requests.schema.json`, `definitions.params.properties` (в `required` не добавляй –
старые запросы без поля остаются валидными):

```json
"cta": {
  "type": "object",
  "additionalProperties": false,
  "required": ["mode", "title", "label", "url"],
  "properties": {
    "mode": { "enum": ["brand", "link", "none"] },
    "title": { "type": "string", "maxLength": 120 },
    "label": { "type": "string", "maxLength": 60 },
    "url": { "type": "string", "maxLength": 500 }
  }
}
```

`scripts/lead-magnet/requests.js`, в `checkParams` перед `return`:

```js
  let cta;
  if (params.cta) {
    if (params.cta.mode === 'link') {
      const title = String(params.cta.title || '').trim();
      const label = String(params.cta.label || '').trim();
      if (!title || !label) throw new Error('лид-магнит: для своей ссылки нужны заголовок и надпись кнопки');
      let url;
      try { url = new URL(String(params.cta.url || '').trim()); } catch (_) { url = null; }
      if (!url || url.protocol !== 'https:' || url.username || url.password) {
        throw new Error('лид-магнит: своя ссылка должна начинаться с https://');
      }
      cta = { mode: 'link', title, label, url: url.href };
    } else {
      cta = { mode: params.cta.mode, title: '', label: '', url: '' };
    }
  }
```

и в возвращаемый объект добавь `...(cta ? { cta } : {})`. Если `checkParams` уже строже
(Codex усилил его в 1A), сохрани прежние проверки и добавь эту рядом.

- [ ] **Step 4: Scaffold**

В `scripts/lead-magnet/scaffold.js`:

```js
// Простые значки соцсетей (currentColor), чтобы страница оставалась самодостаточной.
const SOCIAL_ICONS = {
  telegram: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21.5 3.6 2.9 10.8c-1.3.5-1.3 1.3-.2 1.6l4.8 1.5 1.8 5.6c.2.6.4.8.9.8.4 0 .6-.2.9-.4l2.3-2.2 4.7 3.5c.9.5 1.5.2 1.7-.8l3.1-14.7c.3-1.3-.5-1.9-1.4-1.5ZM9.4 14.3l8.7-5.5c.4-.3.8-.1.5.2l-7.2 6.5-.3 3.1-1.7-4.3Z"/></svg>',
  instagram: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.3" cy="6.7" r="1.2" fill="currentColor"/></svg>',
  youtube: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="4" fill="currentColor"/><path d="M10 9v6l5-3-5-3Z" fill="var(--text)"/></svg>',
  vk: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="6" fill="currentColor"/><path d="M6.5 8.5h2.2c.1 2.9 1.4 4.1 2.4 4.4V8.5h2.1v2.5c1-.1 2-1.3 2.4-2.5h2.1c-.3 1.6-1.5 2.8-2.4 3.3.9.4 2.2 1.5 2.7 3.4h-2.3c-.5-1.5-1.6-2.6-2.5-2.7v2.7h-.3c-4.4 0-6.9-3-7-8Z" fill="var(--text)"/></svg>',
  site: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
};
```

`ctaHtml` перепиши так (вынеси прежнее добавление UTM в `withUtm`, логику Codex для ссылок с
параметрами сохрани):

```js
function withUtm(rawUrl, utm) {
  if (!utm) return rawUrl;
  const url = new URL(rawUrl);
  for (const [key, value] of new URLSearchParams(utm.slice(1))) url.searchParams.set(key, value);
  return url.href;
}

function ctaHtml(brand, passport) {
  const call = passport.params.cta || { mode: 'brand' };
  const utm = brand.cta.utm ? brand.cta.utm.replace('{campaign}', slugifyProjectName(passport.codeWords[0])) : '';
  const button = (label, url) => `<a class="lm-cta__button" href="${escapeHtml(withUtm(url, utm))}">${escapeHtml(label)}</a>`;
  let head = '';
  if (call.mode === 'link') {
    head = `<h2>${escapeHtml(call.title)}</h2>\n<div class="lm-cta__buttons">${button(call.label, call.url)}</div>`;
  } else if (call.mode === 'brand') {
    const buttons = brand.cta.buttons.map((item) => button(item.label, item.url)).join('');
    head = `<h2>${escapeHtml(brand.cta.title)}</h2>\n${brand.cta.text ? `<p>${escapeHtml(brand.cta.text)}</p>` : ''}\n${buttons ? `<div class="lm-cta__buttons">${buttons}</div>` : ''}`;
  }
  const socials = brand.socials.map((item) => `<a class="lm-social" data-lm-social="${item.network}" href="${escapeHtml(item.url)}">${SOCIAL_ICONS[item.network]}<span>${escapeHtml(item.label)}</span></a>`).join('');
  const body = head || socials ? head : '<p>Сохраните страницу – она пригодится.</p>';
  return `<section class="lm-cta" data-lm-block="cta" data-lm="cta">
${body}
${socials ? `<nav class="lm-socials" aria-label="Соцсети">${socials}</nav>` : ''}
</section>`;
}
```

В `pageCss` добавь:

```css
.lm-socials{display:flex;flex-wrap:wrap;gap:14px;justify-content:center;margin-top:18px}
.lm-social{display:inline-flex;gap:6px;align-items:center;color:var(--bg);text-decoration:none;font-weight:600}
.lm-social svg{width:22px;height:22px;flex:none}
```

`scaffoldPage` теперь передаёт в `ctaHtml` бренд с `socials` (`resolved.brand` уже содержит поле).

- [ ] **Step 5: Server state**

В `scripts/pult/lead-magnet-routes.js`:
- `brandView` добавляет поля:
  - `call: { title: resolved.brand.cta.title, buttons: resolved.brand.cta.buttons.map((item) => item.label) }`;
  - `socials: resolved.brand.socials.map((item) => item.label)`;
  - в ветке ошибки – `call: { title: '', buttons: [] }`, `socials: []`.
- В `stateFor` добавь поле `lastLink`: первый паспорт из `index.entries` (они уже от новых к
  старым) с `params.cta && params.cta.mode === 'link'` → `{ title, label, url }`, иначе `null`.

- [ ] **Step 6: Wizard – пункт 8 «Куда ведём в конце»**

В `pult/lead-magnet.js`, в `lmOpenWizard` после пункта 7:

```js
  const brandCall = leadState.brand.call.buttons.length
    ? `Призыв бренд-пака: ${leadState.brand.call.buttons.join(', ')}`
    : 'Призыв бренд-пака';
  const calls = [
    lmChoice('radio', 'lm-cta', 'brand', brandCall, true),
    lmChoice('radio', 'lm-cta', 'link', 'Своя ссылка (практикум, вебинар)', false),
    lmChoice('radio', 'lm-cta', 'none', 'Без призыва – только соцсети', false),
  ];
  const last = leadState.lastLink || { title: 'Хочешь разобраться глубже?', label: 'Бесплатный практикум', url: '' };
  const ctaTitle = lmTextInput(last.title, 'Заголовок над кнопкой', { maxLength: 120 });
  const ctaLabel = lmTextInput(last.label, 'Надпись на кнопке', { maxLength: 60 });
  const ctaUrl = lmTextInput(last.url, 'Ссылка', { maxLength: 500 });
  ctaUrl.placeholder = 'https://…';
  ctaUrl.dataset.lmCtaUrl = '';
  const linkPanel = el('div', 'lm-reference');
  linkPanel.hidden = true;
  linkPanel.append(ctaTitle, ctaLabel, ctaUrl, el('p', 'hint', 'К ссылке добавятся UTM-метки бренд-пака.'));
  const callMode = () => calls.find((item) => item.input.checked).input.value;
  calls.forEach((item) => item.input.addEventListener('change', () => { linkPanel.hidden = callMode() !== 'link'; }));
  const socialsHint = leadState.brand.socials.length
    ? `Внизу всегда: ${leadState.brand.socials.join(' · ')}`
    : 'Соцсети внизу страницы задаются в бренд-паке.';
  body.append(lmFieldset(8, 'Куда ведём в конце', [lmChoices(calls), linkPanel, el('p', 'hint', socialsHint)]));
```

В `validate` добавь условие:
`|| (callMode() === 'link' && (!ctaTitle.value.trim() || !ctaLabel.value.trim() || !/^https:\/\/\S+$/i.test(ctaUrl.value.trim())))`.

В `params` при отправке:
`cta: { mode: callMode(), title: ctaTitle.value.trim(), label: ctaLabel.value.trim(), url: ctaUrl.value.trim() }`.
Пустые поля для `brand`/`none` сервер обнулит сам.

- [ ] **Step 7: Inbox, skill, docs**

- `describeParams` (`scripts/lead-magnet/inbox.js`) – элемент
  `params.cta ? `призыв: ${params.cta.mode === 'link' ? `«${prose(params.cta.label)}» → ${code(params.cta.url)}` : params.cta.mode === 'none' ? 'без призыва' : 'по бренд-паку'}` : null`.
- `skills/lead-magnet/references/texts.md`: «Главная ссылка в текстах для раздачи – из
  `params.cta`: `link` – её адрес; `brand` – первая кнопка бренд-пака; `none` – первая соцсеть
  бренд-пака».
- `docs/LEAD-MAGNET.md` (пример `brand.json` с `socials`, пункт 8 окна), `docs/PULT.md`
  (пункт 8), спецификация (F3, F7, F15), `CHANGELOG.md`.

- [ ] **Step 8: Run & commit**

```bash
node --test tests/lead-magnet-requests.test.js tests/lead-magnet-brand.test.js tests/lead-magnet-scaffold.test.js tests/lead-magnet-scaffold-check.test.js tests/pult-lead-magnet-server.test.js tests/lead-magnet-inbox.test.js
npx playwright test tests/pult-lead-magnet-ui.spec.js --project=chromium
git add -A schema templates scripts pult skills docs CHANGELOG.md tests
git commit -m "feat(lead-magnet): choose the closing call per lead magnet and keep socials

Refs #63"
```

---

### Task D: уборка после параллельной работы

- [ ] Копия папки части 1C `../AutoMontage-Agent-lm-1c` больше не нужна: её ветка влита (PR #66).
  Проверь `git -C ../AutoMontage-Agent-lm-1c status --short` (пусто) и **спроси владельца**
  перед `git worktree remove ../AutoMontage-Agent-lm-1c`.
- [ ] Локальные ветки `feat/lead-magnet-core`, `feat/lead-magnet-agent-skill`,
  `feat/lead-magnet-pult-server`, `docs/lead-magnet-spec`, `docs/lead-magnet-1b-1c-plans` влиты.
  Удаляй только безопасной `git branch -d` (откажет, если что-то не влито), `-D` не используй.
- [ ] `CHANGELOG.md` → `[Unreleased]`: строки про значок (задача A) и призыв в конце (задача C).
- [ ] Полный прогон: `npm test`, `npm run test:review-ui`, `node scripts/check-public-privacy.js --tracked`.
  Затем push и PR – только по «да» владельца; в PR `Refs #63`.

---

### Task E: живой прогон (после слияния A–D и настройки бренд-пака)

Не код. Агент работает по навыку `skills/lead-magnet/SKILL.md`, владелец – в пульте.

**Перед стартом:**
- бренд-пак владельца подключён: `automontage lead-magnet brand` показывает его;
- значок пересоздан: `automontage pult --install-shortcut`.

| # | Кто | Что | Как понять, что прошло |
|---|---|---|---|
| 1 | Агент | Выбрать с владельцем реальный ролик с кодовым словом. По разделу навыка «Обещание в ролике» выполнить `offer add` по расшифровке | Цитата найдена с таймкодом; придуманная формулировка отклоняется |
| 2 | Владелец | Пульт: метка «🎁 Лид-магнит?» → «Разработать новый» → окно параметров (по желанию с референсом; в пункте «Куда ведём в конце» – своя ссылка) → «Отправить агенту» | Во входящих строка «Лид-магнит: запрос r-…» с призывом |
| 3 | Агент | Навык целиком (главная кнопка и соцсети – из заготовки): `brand` → `create` → `revision start` → референсы → `revision scaffold` → `content.md` → страница → факты вживую → тексты голосом бренд-пака → `pdf` → `check` → `revision publish` → `inbox --accept-lead` | `check` зелёный без ручных правок разметки; ни одного `data-lm-todo` |
| 4 | Владелец | Вкладка «Лид-магнит»: «Компьютер» и «Телефон 390», кнопки «Скопировать», 1–2 правки кликом по блоку и к тексту | Правки во входящих со снимками места |
| 5 | Агент | Новая ревизия по правкам, `check`, `publish`, `accept-lead` каждой правки | Правки «приняты агентом», статус «посмотрите и утвердите» |
| 6 | Владелец | «Я просмотрел…» → «Утверждаю лид-магнит» | Статус «Лид-магнит утверждён», файлы в блоке «Файлы» |
| 7 | Оба | Второй ролик с тем же словом, если есть: «Уже есть готовый» → выбрать утверждённый | Ролик привязан без работы агента |

**Итог – комментарий в #63** (без личных данных, путей и названий клиентских роликов):
- сколько заняло каждое звено;
- что агент сделал не по навыку;
- что пришлось чинить руками;
- оценка владельца по сравнению с ручным лид-магнитом.

Каждая системная находка – отдельная Issue через форму. После этого – выпуск 1.11.0 по правилам
`AGENTS.md`, только по просьбе владельца, и закрытие #63 после выпуска.
