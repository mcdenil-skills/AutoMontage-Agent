# Уборка временных файлов тестов (#31) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm test` перестаёт оставлять записи `automontage-*` и `.automontage-*` в `os.tmpdir()`.

**Architecture:** Один регрессионный тест `tests/test-temp-hygiene.test.js` запускает затронутые
файлы тестов во вложенном `node --test` с отдельной временной папкой (`TMPDIR`/`TEMP`/`TMP`) и
требует, чтобы после прогона она была пустой. Каждая задача добавляет в его список один файл
(красный), чинит источник утечки (зелёный) и коммитит. Движок не меняется: удержание «чужого»
файла в надгробии `.…remove-…` – правильная защита `scripts/project/owned-removal.js`.

**Tech Stack:** Node.js 20+, встроенный `node:test`, CommonJS.

## Найденные причины (systematic-debugging, воспроизведено по одному файлу)

| Остаток за один прогон | Источник | Причина |
|---|---|---|
| 30 × `automontage-release-check-*` | `tests/release-hygiene.test.js`, `makeRepository()` | 29 вызовов, очистки нет |
| 1 × `automontage-smoke-guard-*` | там же, тест `smoke guard detects any protected-file mutation` | очистки нет |
| 1 × `automontage-media-import-*` (пустая) | `tests/review-media-import.test.js:249` | `tempProject({ after() {} })` – заглушка вместо `t` выбрасывает очистку |
| 2 × `.automontage-<uuid>.lesson.json.remove-*` + 1 × `automontage-<uuid>.lesson.json.owned-race` | `tests/lesson-build.test.js`, тесты `preserves a foreign replacement…` и `preserves foreign bytes swapped…` | `scripts/build.js --project` пишет временный план в корень `os.tmpdir()`. Тесты подменяют его «чужим» файлом, движок по праву оставляет надгробие с чужими байтами, а тесты чистят только сам файл – надгробие и `.owned-race` остаются |

## Файлы

- Create: `tests/test-temp-hygiene.test.js` – регрессионный тест чистоты временной папки.
- Modify: `tests/release-hygiene.test.js` – `makeRepository(t)` + 29 вызовов, тест smoke guard.
- Modify: `tests/review-media-import.test.js:244-257` – настоящий `t` вместо заглушки.
- Modify: `tests/lesson-build.test.js:20-105, 447-492` – у дочернего `build.js` своя временная папка.
- Modify: `CHANGELOG.md` (`[Unreleased]` → `### Исправлено`), `TESTING.md` (раздел 1).

Общие правила: в добавленных строках только короткое тире «–», не длинное; без личных путей;
pre-commit hook (privacy-check + Gitleaks) не обходить, `--no-verify` запрещён.

---

### Task 1: Регрессионный тест + release-hygiene

**Files:**
- Create: `tests/test-temp-hygiene.test.js`
- Modify: `tests/release-hygiene.test.js:143-144` (`makeRepository`), все 29 вызовов, `:687-688` (smoke guard)

- [ ] **Step 1: Написать падающий регрессионный тест**

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

// Файлы, которые раньше оставляли мусор в os.tmpdir() (#31).
const HYGIENE_FILES = [
  'tests/release-hygiene.test.js',
];

test('affected test files leave nothing behind in their temporary directory', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-temp-hygiene-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const temporary = path.join(parent, 'tmp');
  fs.mkdirSync(temporary);
  const env = { ...process.env, TMPDIR: temporary, TEMP: temporary, TMP: temporary };
  // Вложенный runner иначе решит, что он дочерний процесс внешнего runner.
  delete env.NODE_TEST_CONTEXT;

  const result = spawnSync(process.execPath, ['--test', ...HYGIENE_FILES], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.slice(-4000));
  assert.deepEqual(fs.readdirSync(temporary).sort(), []);
});
```

- [ ] **Step 2: Убедиться, что тест падает по нужной причине**

Run: `node --test tests/test-temp-hygiene.test.js`
Expected: FAIL на `deepEqual`, в списке 30 `automontage-release-check-*` и 1 `automontage-smoke-guard-*`.
Если падает на `status` – разобрать вывод, а не ослаблять проверку.

- [ ] **Step 3: Починить `makeRepository` и smoke guard**

```js
function makeRepository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-release-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-q']);
  // …остальное тело без изменений
```

Во всех 29 вызовах `makeRepository()` → `makeRepository(t)`; у каждого охватывающего теста
колбэк принимает `t` (`() => {` → `(t) => {`, `async () => {` → `async (t) => {`).

```js
test('smoke guard detects any protected-file mutation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-smoke-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
```

Проверить, что в файле не осталось `mkdtempSync` без очистки:
`grep -n "mkdtempSync" tests/release-hygiene.test.js` – рядом с каждым есть `t.after(... rmSync ...)`.

- [ ] **Step 4: Тесты зелёные**

Run: `node --test tests/test-temp-hygiene.test.js tests/release-hygiene.test.js`
Expected: PASS, 0 fail; `grep -c "makeRepository()" tests/release-hygiene.test.js` → `0`.

- [ ] **Step 5: Commit**

```bash
git add tests/test-temp-hygiene.test.js tests/release-hygiene.test.js
git commit -m "fix: remove release-check temp repositories after each test"
```

---

### Task 2: review-media-import

**Files:**
- Modify: `tests/test-temp-hygiene.test.js` (список `HYGIENE_FILES`)
- Modify: `tests/review-media-import.test.js:244-257`

- [ ] **Step 1: Добавить файл в регрессионный тест**

```js
const HYGIENE_FILES = [
  'tests/release-hygiene.test.js',
  'tests/review-media-import.test.js',
];
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test tests/test-temp-hygiene.test.js`
Expected: FAIL, в списке ровно одна `automontage-media-import-*`.

- [ ] **Step 3: Передать настоящий контекст теста**

```js
test('disk reserve is checked before reading a request byte', async (t) => {
  let reads = 0;
  const request = new Readable({ read() { reads += 1; this.push(Buffer.from('x')); this.push(null); } });
  await assert.rejects(importReviewMedia({
    request,
    projectDir: tempProject(t),
```

- [ ] **Step 4: Тесты зелёные**

Run: `node --test tests/test-temp-hygiene.test.js tests/review-media-import.test.js`
Expected: PASS, 0 fail; `grep -rn "after() {}" tests` → пусто.

- [ ] **Step 5: Commit**

```bash
git add tests/test-temp-hygiene.test.js tests/review-media-import.test.js
git commit -m "fix: clean up the disk-reserve media import test project"
```

---

### Task 3: lesson-build – своя временная папка у дочернего build.js

**Files:**
- Modify: `tests/test-temp-hygiene.test.js` (список `HYGIENE_FILES`)
- Modify: `tests/lesson-build.test.js` – `runLessonBuildWithIntercept` (строки ~20-105) и два теста
  `project lesson planning preserves a foreign replacement…` / `project lesson cleanup preserves foreign bytes…`

- [ ] **Step 1: Добавить файл в регрессионный тест**

```js
const HYGIENE_FILES = [
  'tests/release-hygiene.test.js',
  'tests/review-media-import.test.js',
  'tests/lesson-build.test.js',
];
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test tests/test-temp-hygiene.test.js`
Expected: FAIL, в списке 2 `.automontage-<uuid>.lesson.json.remove-*` и 1 `automontage-<uuid>.lesson.json.owned-race`.

- [ ] **Step 3: Изолировать временную папку дочернего процесса**

В `runLessonBuildWithIntercept` сразу после `const calls = path.join(directory, 'calls.jsonl');`:

```js
  // build.js кладёт временный план в os.tmpdir(); держим его внутри directory,
  // чтобы надгробия защищённого удаления исчезали вместе с ней.
  const temporary = path.join(directory, 'tmp');
  fs.mkdirSync(temporary);
```

В `env` вызова `spawnSync` добавить три переменные:

```js
    env: {
      ...process.env,
      TMPDIR: temporary,
      TEMP: temporary,
      TMP: temporary,
      AUTOMONTAGE_LESSON_CAPTURE: calls,
```

Существующий `t.after(() => fs.rmSync(directory, { recursive: true, force: true }))` теперь
удаляет и план, и надгробие `.…remove-…`, и `.owned-race`. Поэтому ручные `t.after`-циклы
`unlinkSync` в двух тестах гонки больше не нужны – удалить их целиком (в тесте замены – блок
по `[jsonPath, \`${jsonPath}.original\`, markdownPath]`, в тесте гонки – блок по
`entry.raceTarget`). Утверждения тестов не менять.

- [ ] **Step 4: Тесты зелёные**

Run: `node --test tests/test-temp-hygiene.test.js tests/lesson-build.test.js`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add tests/test-temp-hygiene.test.js tests/lesson-build.test.js
git commit -m "fix: keep lesson-build test temp plans inside their fixture"
```

---

### Task 4: Документация и приёмка

**Files:**
- Modify: `CHANGELOG.md` – в `## [Unreleased]` добавить подраздел
- Modify: `TESTING.md` – раздел «1. Быстрый обязательный уровень», список «Проверяются»

- [ ] **Step 1: CHANGELOG**

```markdown
## [Unreleased]

### Исправлено

- Тесты больше не оставляют временные git-репозитории, проекты и надгробия удаления в
  системной временной папке: раньше каждый `npm test` добавлял около 35 записей
  `automontage-*`. Новый `tests/test-temp-hygiene.test.js` прогоняет затронутые файлы в
  отдельной временной папке и падает, если после них что-то осталось (#31).
```

- [ ] **Step 2: TESTING.md** – в конец списка «Проверяются, среди прочего» раздела 1:

```markdown
- чистота временной папки: `tests/test-temp-hygiene.test.js` запускает тесты, которые раньше
  оставляли мусор, с отдельными `TMPDIR`/`TEMP`/`TMP` и требует, чтобы папка осталась пустой;
  новый файл с такими фикстурами добавляй в его список `HYGIENE_FILES`;
```

- [ ] **Step 3: Полная проверка**

```bash
npm test
npm run check:release -- --base origin/main
```

Expected: 0 fail; `check:release` без ошибок (в том числе нет длинного тире в добавленных строках).

- [ ] **Step 4: Приёмка из задачи** – два прогона подряд не добавляют записей:

```bash
T=$(node -p "require('os').tmpdir()")
ls -A "$T" | grep -cE '^\.?automontage'   # до
npm test >/dev/null && npm test >/dev/null
ls -A "$T" | grep -cE '^\.?automontage'   # после: столько же
```

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md TESTING.md
git commit -m "docs: note the test temp directory cleanup"
```
