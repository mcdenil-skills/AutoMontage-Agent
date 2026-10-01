# Лид-магнит – приёмка этапа 1: план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement tasks A–C. Task D is a live run with the owner, not code. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Закрыть этап 1 (Issue #63):
- значок пульта передаёт путь к бренд-паку;
- проверено, что кнопки «Скопировать» работают на странице «за стеклом»;
- прибрано за параллельной работой;
- один настоящий лид-магнит прошёл весь путь от обещания в ролике до «Утверждаю» владельца.

**Architecture:** Код – две маленькие правки (значок пульта и браузерный тест). Остальное –
документация и живой прогон по навыку `skills/lead-magnet/SKILL.md` на реальном ролике.

**Tech Stack:** Node.js 20+, `node:test`, Playwright, `automontage lead-magnet`, «Пульт роликов».

**Опирается на:** части 1A, 1B, 1C в `main` (PR #64, #66, #68). Задачи 3 и 8 плана
`2026-10-01-lead-magnet-1c-agent-skill.md` входят сюда как задачи B и D. **Задача:** #63.

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

### Task C: уборка после параллельной работы

- [ ] Копия папки части 1C `../AutoMontage-Agent-lm-1c` больше не нужна: её ветка влита (PR #66).
  Проверь `git -C ../AutoMontage-Agent-lm-1c status --short` (пусто) и **спроси владельца**
  перед `git worktree remove ../AutoMontage-Agent-lm-1c`.
- [ ] Локальные ветки `feat/lead-magnet-core`, `feat/lead-magnet-agent-skill`,
  `feat/lead-magnet-pult-server`, `docs/lead-magnet-spec`, `docs/lead-magnet-1b-1c-plans` влиты.
  Удаляй только безопасной `git branch -d` (откажет, если что-то не влито), `-D` не используй.
- [ ] `CHANGELOG.md` → `[Unreleased]`: строка про значок (задача A).
- [ ] Полный прогон: `npm test`, `npm run test:review-ui`, `node scripts/check-public-privacy.js --tracked`.
  Затем push и PR – только по «да» владельца; в PR `Refs #63`.

---

### Task D: живой прогон (после слияния A–C и настройки бренд-пака)

Не код. Агент работает по навыку `skills/lead-magnet/SKILL.md`, владелец – в пульте.

**Перед стартом:**
- бренд-пак владельца подключён: `automontage lead-magnet brand` показывает его;
- значок пересоздан: `automontage pult --install-shortcut`.

| # | Кто | Что | Как понять, что прошло |
|---|---|---|---|
| 1 | Агент | Выбрать с владельцем реальный ролик с кодовым словом. По разделу навыка «Обещание в ролике» выполнить `offer add` по расшифровке | Цитата найдена с таймкодом; придуманная формулировка отклоняется |
| 2 | Владелец | Пульт: метка «🎁 Лид-магнит?» → «Разработать новый» → окно параметров (по желанию с референсом) → «Отправить агенту» | Во входящих строка «Лид-магнит: запрос r-…» |
| 3 | Агент | Навык целиком: `brand` → `create` → `revision start` → референсы → `revision scaffold` → `content.md` → страница → факты вживую → тексты голосом бренд-пака → `pdf` → `check` → `revision publish` → `inbox --accept-lead` | `check` зелёный без ручных правок разметки; ни одного `data-lm-todo` |
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
