# Чистка старых роликов – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Команда `automontage clean` освобождает диск от промежуточных файлов готовых роликов и не трогает финалы, ТЗ и исходные материалы.

**Architecture:** Чистый планировщик (`planProjectCleanup`) по правилам решает, какие файлы готового проекта можно удалить, и возвращает список с размерами. CLI по умолчанию только показывает отчёт (dry-run). Удаляет только с `--yes`: перед удалением проект проверяется повторно, удаляются только обычные файлы внутри проекта.

**Tech Stack:** Node.js 20 (CommonJS), `node:fs`, `node:test`.

**Spec:** аудит 2026-10-02 (`knowledge/montage-speed-audit-2026-10-02.md`, локально) + просьба Дмитрия: «почистить диск от старых копий, которые больше не нужны, – именно готовые старые ролики, старые рендеры». Замер в тот день: свободно 17 ГБ из 460 (97 %); 47 готовых проектов занимают ~39 ГБ, из них сами финалы – 2,9 ГБ.

## Global Constraints

- По умолчанию – только отчёт. Удаление – только с `--yes`.
- В проекте может быть удалено только то, что перечислено в правилах уровня; всё остальное не трогается.
- Только готовые проекты: в `project.json` есть `final`, файл существует и не пустой.
- Пропускать: проекты с `.project-mutation.lock`; проекты, где `project.json` или финал изменялись меньше `--min-age-days` дней назад (по умолчанию 3); папки на `.` (`.archive`, `.lead-magnets`, `.library`, `.pult`) и папки без `project.json`.
- Удалять только обычные файлы (`lstat`, симлинки не трогать и не проходить), чей реальный путь лежит внутри папки проекта; после этого убирать опустевшие папки только внутри целевых папок.
- Никогда не удалять: `final/`, `project.json`, `pult-card.json`, `brief/`, `transcript/`, `edit/`, `pult/`, `lead-magnet/`, `qa/`, `motion-v*/src/`, `motion-v*/layer.json`, `assets/music/`, `assets/generated/`, исходник `source.originalLocalPath`, файл `currentPreview.filePath` и все видео из `pult-card.json` → `legacy.variants[].video`.
- Реальный запуск с `--yes` на рабочей папке `projects/` – действие из красного списка: только после явного «да» Дмитрия на показанный отчёт.
- Ветка `feat/clean-old-renders`, не `main`. Push и merge – только по явной просьбе.

**Уровень `renders` (по умолчанию) – то, что движок пересоберёт заново:**
`renders/**/*.{mp4,mov}`, `previews/**/*.{mp4,mov,webm}`, `tmp/**`, `motion-v*/renders/**`, `motion-v*/previews/**`, `motion-v*/out/**`, `motion-v*/checks/**`, `motion-v*/public/speaker*.mp4`, `motion-v*/speaker*.mp4`.

**Уровень `archive` – `renders` плюс то, что восстанавливается из оригинала и правок:**
`input/source-v[0-9]*.*` (ревизии нарезки, кроме `originalLocalPath`), `assets/broll/**/*.{mp4,mov,webm}`.

## Review Focus

1. Пульт после чистки: карточка готового ролика открывает финал, а не битую ссылку на удалённое превью – правило «не трогать `currentPreview.filePath` и `legacy.variants[].video`», тест в Task 1.
2. Проект, который сейчас монтируется (свежий или с lock), не попадает в план – тест в Task 1.
3. Симлинк внутри проекта, указывающий наружу (например, `tmp/link -> ~/Movies`), не удаляется и не проходится – тест в Task 1.
4. Проект поменялся между отчётом и удалением (появился lock) – с `--yes` пропускается при повторной проверке – тест в Task 2.
5. Повреждённый `project.json` – проект пропускается с причиной, команда не падает – тест в Task 1.

---

### Task 1: Планировщик чистки одного проекта

**Files:**
- Create: `scripts/project/clean.js`
- Test: `tests/project-clean.test.js`

**Interfaces:**
- Produces:
  - `CLEAN_LEVELS: ['renders', 'archive']`
  - `planProjectCleanup(projectDir: string, { level = 'renders', minAgeDays = 3, now = new Date(), fileSystem = fs } = {}) -> { projectDir, status: 'eligible' | 'skipped', reason: string | null, files: Array<{ path: string /* относительный */, bytes: number }>, bytes: number }`
  - Значения `reason` для `skipped`: `'нет project.json'`, `'project.json не читается'`, `'нет финала'`, `'идёт работа (lock)'`, `'менялся N дн. назад'`.

- [ ] **Step 1: Падающие тесты** (временные папки через `fs.mkdtempSync`, файлы по несколько байт):
  - готовый проект старше 3 дней → `eligible`; в `files` есть `renders/v01-x/raw.mp4`, `motion-v01/renders/layer-01.mp4`, `motion-v01/public/speaker.mp4`, `tmp/a.wav`, `previews/v01-draft-full.mp4`; нет `final/x.mp4`, `brief/…`, `motion-v01/src/Root.jsx`, `input/source.mp4`, `input/source-v02.mp4` (уровень `renders`);
  - тот же проект, `level: 'archive'` → дополнительно `input/source-v02.mp4` и `assets/broll/video/<id>/media.mp4`, но не `input/source.mp4` и не `assets/music/m.wav`;
  - `currentPreview.filePath = 'previews/current-preview.mp4'` и `pult-card.json` с `legacy.variants[0].video = 'renders/v01-x/final.mp4'` → оба файла не в `files`;
  - нет файла финала → `skipped`, `'нет финала'`; есть `.project-mutation.lock` → `'идёт работа (lock)'`; `project.json` изменён вчера → `'менялся 1 дн. назад'`; битый JSON → `'project.json не читается'`;
  - симлинк `tmp/out -> <внешняя папка с файлом>` → ни симлинк, ни внешний файл не в `files`;
  - `bytes` равен сумме `files[].bytes`.
- [ ] **Step 2: Запустить – падают.**
- [ ] **Step 3: Реализовать `planProjectCleanup`.** Обход через `readdirSync({ withFileTypes: true })` без перехода по симлинкам; совпадение с правилами уровня по относительному пути (собственная маленькая функция сопоставления; новых зависимостей не добавлять); исключения из Global Constraints проверяются после совпадения.
- [ ] **Step 4: Запустить – PASS.**
- [ ] **Step 5: Commit** `feat: plan cleanup of finished project intermediates`

---

### Task 2: Команда `automontage clean`

**Files:**
- Modify: `scripts/project/clean.js` – `planCleanup`, `applyCleanup`, `main`
- Modify: `scripts/cli.js` – подкоманда `clean` (по образцу `master`, ~L196) и строка в справке
- Test: `tests/project-clean.test.js`

**Interfaces:**
- Consumes: `planProjectCleanup` (Task 1).
- Produces:
  - `planCleanup(projectsDir, options) -> { projects: ProjectPlan[], bytes: number }`
  - `applyCleanup(plan, { fileSystem = fs, ...options }) -> { removedFiles: number, freedBytes: number, skipped: Array<{ projectDir, reason }> }` – для каждого проекта заново вызывает `planProjectCleanup` и удаляет только файлы, которые есть и в старом, и в новом плане.
  - CLI: `automontage clean [--projects-dir projects] [--level renders|archive] [--min-age-days 3] [--yes]`.

- [ ] **Step 1: Падающие тесты:**
  - `planCleanup` на папке с двумя готовыми проектами и одним `.archive` → два проекта, `.archive` не упомянут;
  - `main([...])` без `--yes` → ни один файл не удалён; в выводе `Можно освободить:` и `Чтобы удалить, повторите с --yes`;
  - `applyCleanup` → файлы из плана удалены, `final/` и `brief/` на месте, опустевшая `motion-v01/renders/` удалена, `motion-v01/` осталась;
  - между `planCleanup` и `applyCleanup` в проект кладётся `.project-mutation.lock` → проект в `skipped`, его файлы на месте;
  - `--level zip` → ошибка `неизвестный уровень`, код выхода 1.
- [ ] **Step 2: Запустить – падают.**
- [ ] **Step 3: Реализовать.** Отчёт: таблица «проект – сколько МБ – пропущен/почему», внизу итог в ГБ; с `--yes` – итог «Удалено N файлов, освобождено X ГБ». Размеры – в МБ/ГБ с одним знаком после запятой.
- [ ] **Step 4: Запустить – PASS; `npm test` – всё зелёное.**
- [ ] **Step 5: Commit** `feat: automontage clean command (dry-run by default)`

---

### Task 3: Документация

**Files:**
- Modify: `README.md` (команда и предупреждение «по умолчанию только отчёт»), `ARCHITECTURE.md` (модуль `scripts/project/clean.js`), `TESTING.md` (новый тест), `CHANGELOG.md` `[Unreleased]`, `docs/PULT.md` (если пульт описывает архив – одна строка: после `clean` у архивных роликов остаются финал и ТЗ).
- Modify: `AGENTS.md`, таблица «Команды»: `automontage clean  # отчёт, что можно удалить у готовых роликов; --yes удаляет`.

- [ ] **Step 1:** Внести правки.
- [ ] **Step 2: Commit** `docs: automontage clean`

---

### Task 4: Чистка рабочей папки (с согласия Дмитрия)

- [ ] **Step 1:** `df -h /System/Volumes/Data` – записать свободное место до чистки.
- [ ] **Step 2:** `automontage clean` (без `--yes`) – показать Дмитрию отчёт: какие ролики, сколько ГБ, кого пропустили и почему. Ожидание по замеру 2026-10-02: уровень `renders` ≈ 15–19 ГБ, `archive` – ещё ≈ 8–10 ГБ.
- [ ] **Step 3:** СТОП. Спросить: «Удаляю промежуточные файлы N готовых роликов (X ГБ); финалы, ТЗ и исходники остаются, удалённое движок пересоберёт из исходника. Можно?» Ждать явного «да». Уровень `archive` – только отдельным вопросом.
- [ ] **Step 4:** После «да»: `automontage clean --yes` (и `--level archive --yes`, если согласовано отдельно). `df -h` после, разница – в итоговое сообщение и в дневник.
- [ ] **Step 5:** Открыть пульт, вкладку «Архив»: карточки готовых роликов открывают финал.
