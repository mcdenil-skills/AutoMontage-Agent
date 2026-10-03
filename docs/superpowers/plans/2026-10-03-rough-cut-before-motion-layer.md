# Черновая нарезка до motion-слоя – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** автор смотрит черновую нарезку без графики в пульте и отмечает оговорки до motion-слоя, поэтому правка «вырежи оговорку» больше не вызывает новый слой и полный перерендер.

**Architecture:** новая команда `automontage roughcut` собирает лёгкую копию 720p прямо из активного исходника по обычному source-edit `edit/roughcut-vNN.json` (тот же граф фильтров, что у master) и записывает `project.json.roughCut` без новой ревизии исходника. Пульт показывает её отдельным этапом с правками и кнопкой «Нарезка готова»; входящие переводят секунду нарезки в секунду исходника. `master` и `layer new` отказывают, пока нарезка ждёт автора; после подтверждения master собирается один раз из оригинала.

**Tech Stack:** Node.js 20 CommonJS, ffmpeg/ffprobe, Ajv (схема `project.json`), браузерный JS пульта, `node:test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-03-rough-cut-before-motion-layer-design.md` (факты, замеры, сравнение вариантов – там).

## Global Constraints

- Issue #82 уже создана и стоит на доске в «Бэклог»; перед началом перевести её в Status «В работе» (правило `AGENTS.md`, `memory/feedback_task-board.md`). Ветка `feat/rough-cut` от `main`; push/PR – только по просьбе владельца, сливает владелец.
- Имена: список кусков – `edit/roughcut-vNN.json`, регулярное выражение `^edit/roughcut-v(\d{2,3})\.json$`; копия – `previews/roughcut-vNN.mp4` с тем же `NN`.
- Копия: граф фильтров `buildConcatFilter(intervals, { audioFadeSec: 0.04, precision: 6, scale })`, как у master; размер – короткая сторона 720 от `workingSize(display, '1080p')`, без увеличения, чётные стороны; аргументы кодирования ровно `-c:v libx264 -preset ultrafast -crf 26 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart`.
- Слот очереди: label `roughcut <path.basename(projectDir)>`, берётся до блокировки проекта, отпускается в `finally` (как master, D-044).
- `project.json.roughCut`: `null` или объект с полями `editPath, filePath, sourceRevision, sourceDuration, editSha256, sha256, duration, width, height, fps, createdAt, status` (`review` | `confirmed`), у `confirmed` ещё `confirmedAt` и `confirmedBy` (`pult` | `chat`). Этап активен, пока `roughCut.sourceRevision === source.revision` (ревизия по умолчанию 1).
- Тексты пульта ровно: статус «Черновая нарезка – посмотрите и отметьте оговорки», «Нарезка подтверждена – агент собирает слой»; подпись видео «Черновая нарезка без графики»; флажок «Я посмотрел нарезку целиком»; кнопка «Нарезка готова».
- Коды ошибок API: `ROUGHCUT_CHANGED` (409: нарезка сменилась или уже не ждёт автора), `ROUGHCUT_DAMAGED` (409: байты копии или списка ≠ паспорту), `CONFIRMATION_REQUIRED` (400), существующий `PROJECT_BUSY` (409).
- Правки к подтверждённой нарезке: `edit/roughcut-vNN.json` после подтверждения не меняется; агент копирует его в `edit/vNN-source.json` (тот же `sourceRevision`), вносит вырезы по секундам исходника из `automontage inbox`, собирает master из копии, затем `inbox --accept`. Фраза автора «режь сам» после показа нарезки – явное подтверждение в чате (`automontage roughcut confirm`).
- Тестовые команды: одиночные прогоны – с `node --require ./tests/helpers/heavy-queue-isolation.cjs --test …` (`TESTING.md`); прогоны, куда входят `tests/lead-magnet-*.test.js`, и `npm test` – с префиксом `env -u LEAD_MAGNET_BRAND` (известный баг #76).
- Связанные Issue: #83 – фаза 2 (`roughcut suggest`, дословная расшифровка), #84 – падение master на слове нулевой длины Whisper; в этом плане не делаются.
- Браузер не получает путей и SHA-256; заметки `note` выводятся через `textContent`, обрезаются до 500 знаков.
- Агент никогда не вызывает `/api/roughcut/confirm`; `automontage roughcut confirm` – только по явным словам автора в чате.
- Сообщения пользователю – по-русски. В навыках, `AGENTS.md` и документах – тире «–», не длинное тире (U+2014) (тесты запрещают длинное тире (U+2014) в части блоков).
- Новых npm-зависимостей нет. Клиентские `projects/<id>/` не трогать; приёмка – на копии в `tmp/`.
- Документация синхронно с кодом по таблице `AGENTS.md` («Документация – держать в синхроне»); заметные изменения – в `CHANGELOG.md` `[Unreleased]`.

## Review Focus

1. На экране черновая нарезка, статус «Ждёт меня» – пульт не должен показывать «Утверждаю» и выдавать билет утверждения (`approvable` ложно) – тест в Task 4 и Task 5.
2. Ночная сессия запускает `master` или `layer new`, пока нарезка ждёт автора, или `layer new` после подтверждения, но до master – отказ до слота очереди и до создания папки слоя – тесты в Task 3.
3. Телефонная запись с поворотом 90° (кадр 1920×1080, показ 1080×1920) – копия 720×1280, а не 1280×720, и размер копии сверяется после кодирования – тесты в Task 2 (фейк с уменьшением и настоящий ffmpeg без уменьшения).
4. Агент поправил `edit/roughcut-v02.json` уже после сборки копии – подтверждение отказывает («список кусков изменился»), пульт отвечает `ROUGHCUT_DAMAGED`, а не обещает «новую нарезку» – тесты в Task 2 и Task 5.
5. Автор оставил правки к нарезке v02, агент собрал v03 – старые правки во входящих помечены «к прежней версии видео» и всё равно получают секунду исходника по списку v02 – тест в Task 7.

---

### Task 1: Модель черновой нарезки и поле `roughCut` в паспорте

**Files:**
- Create: `scripts/project/rough-cut-model.js`, `tests/rough-cut-model.test.js`
- Modify: `schema/project.schema.json` (новое свойство `roughCut` рядом с `currentPreview`), `scripts/project/workspace.js:493-562` (`validateProjectManifest`: проверки `roughCut`), `ARCHITECTURE.md` (схема паспорта)

**Interfaces:**
- Produces (`scripts/project/rough-cut-model.js`, без зависимостей от `workspace.js`, чтобы не было цикла):
  - `ROUGH_CUT_EDIT = /^edit\/roughcut-v(\d{2,3})\.json$/`
  - `roughCutPaths(editRelative: string) -> { editPath, filePath, version: number }` – неверное имя → `Error('черновая нарезка: имя списка кусков – edit/roughcut-vNN.json')`
  - `editPathForRoughCutVideo(videoPath: string) -> string | null` – `previews/roughcut-v02.mp4` → `edit/roughcut-v02.json`, иначе `null`
  - `roughCutTimeToSource(keep: Array<{start,end}>, timeSec: number) -> number` – секунда нарезки → секунда исходника; за концом – конец последнего куска
  - `removedRanges(keep, sourceDuration: number) -> Array<{ atSec, sourceStart, sourceEnd, removedSec, note }>` – вырезы до первого куска, между кусками и после последнего (если `sourceDuration - lastEnd > 0.001`); `atSec` – место стыка в нарезке; `note` – `note ?? null` следующего куска (у хвоста – `null`); вырезы короче 0,001 с не включаются; все секунды округлены до 0,001 (`Number(x.toFixed(3))`), чтобы 1,9999999 не показывалось как «0:01»
  - `roughCutSize({ width, height }) -> { width, height }` – короткая сторона 720, без увеличения, чётные стороны (вход – уже рабочий размер 1080p)
  - `activeRoughCut(manifest) -> object | null` – `manifest.roughCut`, если `sourceRevision` равна `manifest.source?.revision ?? 1`
  - `assertRoughCutSettled(manifest, action: 'master' | 'layer new', { projectDir }) -> void` – ошибка с `code === 'ROUGH_CUT_PENDING'`, тексты – Task 3

- [ ] **Step 1: Падающие тесты** `tests/rough-cut-model.test.js`:
  - `roughCutPaths('edit/roughcut-v02.json')` → `{ editPath: 'edit/roughcut-v02.json', filePath: 'previews/roughcut-v02.mp4', version: 2 }`; `'edit/v02-source.json'`, `'edit/roughcut-v2.json'`, `'../edit/roughcut-v02.json'` → бросают `/edit\/roughcut-vNN\.json/`.
  - `editPathForRoughCutVideo('previews/roughcut-v105.mp4') === 'edit/roughcut-v105.json'`; `editPathForRoughCutVideo('previews/v02-draft-full.mp4') === null`.
  - keep `[{start:1,end:3,note:'хук'},{start:5,end:9,note:'вырезан повтор'}]`: `roughCutTimeToSource(keep, 0) === 1`, `(keep, 2) === 3`, `(keep, 2.5) === 5.5`, `(keep, 100) === 9`.
  - `removedRanges(keep, 10)` → `[{atSec:0, sourceStart:0, sourceEnd:1, removedSec:1, note:'хук'}, {atSec:2, sourceStart:3, sourceEnd:5, removedSec:2, note:'вырезан повтор'}, {atSec:6, sourceStart:9, sourceEnd:10, removedSec:1, note:null}]`; кусок без `note` даёт `note: null`; с `keep[0].start === 0` и `sourceDuration === 9` – один элемент; keep `[{start:0,end:0.6666666667},{start:1,end:2}]` даёт `atSec: 0.667`.
  - `roughCutSize({width:1080,height:1920})` → `{720,1280}`; `({1920,1080})` → `{1280,720}`; `({540,960})` → `{540,960}`; `({1080,1350})` → `{720,900}`.
  - `activeRoughCut({ source: { revision: 2 }, roughCut: { sourceRevision: 1 } }) === null`; без `source.revision` и с `sourceRevision: 1` – объект; без `roughCut` – `null`.
  - `validateProjectManifest` (из `workspace.js`) на паспорте `createOrOpenProject` + `roughCut` из Global Constraints: проходит со `status: 'review'`; бросает при `status: 'confirmed'` без `confirmedAt`, при `confirmedAt` у `review`, при `filePath`, не соответствующем `editPath` (`previews/roughcut-v03.mp4` для `edit/roughcut-v02.json`), при `editPath: '../x.json'`; паспорт без поля и с `roughCut: null` проходит.
- [ ] **Step 2:** `node --require ./tests/helpers/heavy-queue-isolation.cjs --test tests/rough-cut-model.test.js` → FAIL «Cannot find module '../scripts/project/rough-cut-model'».
- [ ] **Step 3: Реализовать.** Схема: объект `additionalProperties: false`, обязательные поля из Global Constraints, `status` enum `["review","confirmed"]`, `confirmedBy` enum `["pult","chat"]`, `sha256`/`editSha256` – `^[a-f0-9]{64}$`, `sourceRevision` целое ≥ 1, `duration`/`sourceDuration`/`fps` > 0, `width`/`height` целые ≥ 1; `anyOf` с `null`. В `validateProjectManifest` – согласованность `status`↔`confirmedAt/confirmedBy` и `roughCutPaths(editPath).filePath === filePath` **до** строки `if (!projectDir) return migratedManifest;` (`workspace.js:514`), а оба пути – в список `paths` для `resolveProjectPath` после неё.
- [ ] **Step 4:** тот же запуск → PASS; `node --require ./tests/helpers/heavy-queue-isolation.cjs --test tests/project-*.test.js tests/source-edit.test.js` → PASS (старые паспорта без поля не сломались).
- [ ] **Step 5: Commit** `feat: rough cut model and project.json roughCut`

### Task 2: Команда `automontage roughcut`

**Files:**
- Create: `scripts/project/rough-cut.js`, `scripts/project/rough-cut-cli.js`, `tests/helpers/rough-cut-project.js`, `tests/rough-cut.test.js`, `tests/rough-cut-media.test.js`
- Modify: `scripts/trim-media.js:148-213` (параметр кодирования в `filterScriptCommand`, `runFilterScript` `:182-199` и `runTrim`), `scripts/cli.js:53-57` (справка) и `:200-207` (маршрут рядом с `master`), `tests/cli.test.js`, `package.json` (`test:video-edit` += `tests/rough-cut.test.js tests/rough-cut-media.test.js`), `.github/workflows/ci.yml:144-146` (дописать `tests/rough-cut-media.test.js` в ту же строку `run:` шага «Проверить склейку дублей на настоящем FFmpeg 7»: `check-release.js` требует одну команду без `;&|`), `README.md` (команда), `ARCHITECTURE.md` (модуль и поток), `TESTING.md` (новые файлы в `test:video-edit` и в Windows-шаге)

**Interfaces:**
- Consumes: Task 1 (`roughCutPaths`, `roughCutSize`, `activeRoughCut`, `removedRanges`); `validateSourceEdit` из `scripts/project/build-master.js`; `normalizeSourceMetadata`, `fsyncFile`, `projectRelative`, `removeOwned`, `safeToken`, `statRegular` из `scripts/project/source-revision.js`; `withProjectMutation`, `readProjectManifest`, `resolveProjectPath` из `workspace.js`; `workingSize`, `orientedSampleAspectRatio` из `scripts/working-quality.js`; `displayDimensions`, `probeMediaPath`, `probeVideo` из `scripts/media-probe.js`; `runTool` из `scripts/process.js`; `runTrim` из `scripts/trim-media.js`; `hashFile` из `scripts/pult/files.js`; `acquireHeavySlotSync`, `heavyQueueConfig` из `scripts/heavy-queue.js`.
- Produces:
  - `scripts/trim-media.js`: `filterScriptCommand(inputs, output, filterPath, { filterScriptOption, encoder = 'master' })`, `runFilterScript({ …, encoder = 'master' }, deps)`, `runTrim({ …, encoder = 'master' }, deps)`; `encoder: 'proxy'` подставляет ровно аргументы из Global Constraints вместо `-c:v libx264 -preset veryfast -crf 20 -c:a aac`, выходной файл остаётся последним аргументом; неизвестное значение → `Error('неизвестный режим кодирования')`.
  - `buildRoughCut({ projectDir, editPath }, deps = {}) -> { editPath, filePath, duration, removedSec, cuts, width, height, fps }` – `deps`: `fileSystem, runTrimImpl, runToolImpl, probeVideoImpl, probeMediaPathImpl, acquireSlotSync, now, temporaryId, log`. `editPath` может быть абсолютным: сначала `projectRelative`, потом `roughCutPaths` (как master принимает `--edit`).
  - `tests/helpers/rough-cut-project.js`: `makeRoughCutSourceProject(t, { fps = 25 } = {}) -> { root, workspace, projectDir, writeEdit(name, edit) }` – проект как `makeProject` в `tests/source-edit.test.js` (копия логики, не `require` тестового файла), слова 0–8 с; `writeEdit` пишет `edit/<name>` и возвращает относительный путь.
  - `confirmRoughCut(workspace, { expectedSha256 = null, by: 'pult' | 'chat', now }) -> roughCut` – ошибки с `code`: `ROUGH_CUT_MISSING` (нет активной нарезки в `review`), `ROUGH_CUT_CHANGED` (байты копии ≠ `sha256`, или `expectedSha256` задан и ≠ `sha256`, или байты списка ≠ `editSha256`).
  - `scripts/project/rough-cut-cli.js`: `parseRoughCutOptions(argv) -> { command: 'build' | 'confirm', projectDir, editPath }`, `main(argv)`.

- [ ] **Step 1: Падающие тесты** `tests/rough-cut.test.js` (проект – `makeRoughCutSourceProject`, зависимости – фейки; вывод только через внедрённый `log`: под Node 20 строка в stdout теста ломает раннер, см. комментарий в `tests/layer-new.test.js:21-23`):
  - `filterScriptCommand([…], out, f, { encoder: 'proxy' }).args` содержит подряд `'-preset','ultrafast','-crf','26','-pix_fmt','yuv420p'` и `'-b:a','128k','-movflags','+faststart'`; без `encoder` – прежние `'-preset','veryfast','-crf','20'`; `encoder: 'x'` бросает.
  - телефонная запись: `probeMediaPathImpl` → `{ width: 1920, height: 1080, rotation: 90 }` → `runTrimImpl` получил `scale {width:720,height:1280}`; фейк `probeVideoImpl` для копии отвечает 1280×720 → сборка отказывает `/размер/`, паспорт не изменился (копия сверяется по ширине и высоте, как master в `source-revision.js:182-185`).
  - `buildRoughCut` с `edit/roughcut-v01.json` (fps 25, два куска 0–2 и 4–8; `probeVideoImpl` отвечает 8 с для исходника и 6 с, 720×1280 для копии, `runToolImpl` – no-op для проверки декодированием, `runTrimImpl` пишет байты в `output`): `runTrimImpl` получил `encoder: 'proxy'`, `audioFadeSec: 0.04`, `precision: 6`, `intervals [[0,2],[4,8]]`, `scale {width:720,height:1280}` при `probeMediaPathImpl` 1080×1920 без поворота (размер показа – как в `buildMaster`: `displayDimensions` из `scripts/media-probe.js` + `orientedSampleAspectRatio` → `workingSize(…, '1080p')` → `roughCutSize`); результат `{ filePath: 'previews/roughcut-v01.mp4', duration: 6, removedSec: 2, cuts: 1 }`; в `project.json` – `roughCut.status === 'review'`, `sourceRevision === 1`, `sourceDuration === 8`, `editSha256` равен SHA-256 байтов списка; `source.revision` и `source.localPath` не изменились.
  - порядок: `acquireSlotSync` вызван до блокировки проекта, `release` – и при ошибке `runTrimImpl` (как тест «heavy slot before the project lease» в `source-edit.test.js`); label `roughcut project`.
  - отказы без записи в паспорт: имя `edit/v02-source.json`; `sourceRevision: 2` при активной 1 (`/source edit revision/`); уже существующий `previews/roughcut-v01.mp4` → `/edit\/roughcut-v02\.json/`; несовпадение FPS → `/FPS/`.
  - повторная сборка `edit/roughcut-v02.json` после `confirmRoughCut` снова даёт `status: 'review'` без `confirmedAt`.
  - `confirmRoughCut(workspace, { by: 'chat' })` → `status: 'confirmed'`, `confirmedBy: 'chat'`, `confirmedAt` из `now`; второй вызов → `code: 'ROUGH_CUT_MISSING'`; после правки байтов списка → `code: 'ROUGH_CUT_CHANGED'`; `expectedSha256: 'f'.repeat(64)` → `ROUGH_CUT_CHANGED`.
  - `parseRoughCutOptions(['--project-dir','p','--edit','edit/roughcut-v01.json'])` → `build`; `(['confirm','--project-dir','p'])` → `confirm`; `confirm --edit …` и пустой argv бросают.
  - абсолютный `--edit` внутри проекта (`<projectDir>/edit/roughcut-v01.json`) принимается так же, как относительный.
  - итоговая строка склоняет «место»: 1 вырез – «в 1 месте», 2 – «в 2 местах», 21 – «в 21 месте».
- [ ] **Step 2: Падающий медиа-тест** `tests/rough-cut-media.test.js` (`skip: !hasFfmpeg`, исходник – `makeLayerProject(t, { seconds: 6, size: '540x960' })` и `{ rotation: 90, size: '960x540' }`): настоящий `buildRoughCut` с куском 0–2 и 3–5 → файл `previews/roughcut-v01.mp4`, ffprobe: `h264`, `yuv420p`, длительность 4 ± 0,08, размер 540×960 (без увеличения) в обоих случаях – у повёрнутого источника тоже 540×960, а не 960×540; `moov` перед `mdat` (`+faststart`: смещение атома `moov` меньше `mdat` в первых байтах файла).
- [ ] **Step 3:** `node --require ./tests/helpers/heavy-queue-isolation.cjs --test tests/rough-cut.test.js tests/rough-cut-media.test.js` → FAIL «Cannot find module».
- [ ] **Step 4: Реализовать** по шагам сборки из спеки («Команда `automontage roughcut`», пп. 1–7): проверки до слота; кодирование во временный `previews/.roughcut-vNN-<token>.tmp.mp4` внутри `withProjectMutation` (как `publishSourceRevision`: сверить активные `revision`/`localPath` и SHA-256 байтов списка, `ffmpeg -v error -i <stage> -f null -`, `probeVideoImpl` – длительность в пределах `max(0.08, 1/fps)`, FPS, ширина и высота равны ожидаемому размеру копии, иначе `Error('черновая нарезка: размер, длительность или FPS копии не совпадают со списком кусков')`; несовпадение FPS списка и исходника до кодирования – тот же текст, что у master: `'source edit FPS does not match the active source'`), `linkSync` в итоговое имя, затем `transaction.commitManifest(next, { purpose: 'rough-cut-manifest' })`). Итоговая строка: `✅ черновая нарезка: previews/roughcut-vNN.mp4 – <длительность> с, вырезано <X> с в <N> местах. Дальше: автор смотрит её в пульте (automontage pult).` (с правильным склонением «месте/местах»). `confirm` печатает `✅ нарезка подтверждена по словам автора: <editPath>. Дальше: automontage master --project-dir "<p>" --edit <editPath> (правки автора к нарезке – в копию списка edit/vNN-source.json, секунды исходника – в automontage inbox)`. В `scripts/cli.js` – маршрут `argv[0] === 'roughcut'` через `execFileSync` на `rough-cut-cli.js` и две строки справки:

```text
  automontage roughcut --project-dir <p> --edit edit/roughcut-v01.json
                                      черновая нарезка без графики для пульта (до master и слоя)
  automontage roughcut confirm --project-dir <p>
                                      нарезка готова – только по явным словам автора в чате
```

- [ ] **Step 5:** `tests/cli.test.js` – в справке `/automontage roughcut --project-dir/` и `/automontage roughcut confirm/`; тот же запуск, что в Step 3, + `node --require ./tests/helpers/heavy-queue-isolation.cjs --test tests/cli.test.js tests/trimming-security.test.js tests/trim-media-real.test.js tests/trim-media-scale.test.js tests/source-edit.test.js tests/release-hygiene.test.js` → PASS; `npm run check:release` → без ошибок (дописанная строка Windows-шага).
- [ ] **Step 6: Commit** `feat: automontage roughcut builds a 720p rough cut from the source edit`

### Task 3: `master` и `layer new` ждут подтверждённую нарезку

**Files:**
- Create: `tests/rough-cut-guards.test.js`
- Modify: `scripts/project/rough-cut-model.js` (тексты `assertRoughCutSettled`), `scripts/project/build-master.js:84-94` (проверка после чтения паспорта, до слота), `scripts/layer/new.js:207-212` (проверка сразу после `projectFrom`), `docs/MOTION-KIT.md` («Рабочее качество перед motion-слоем» и «Что делать, если…»)

**Interfaces:**
- Consumes: Task 1 `activeRoughCut`, Task 2 `makeRoughCutSourceProject`, `buildRoughCut`/`confirmRoughCut` (для фикстур).
- Produces: тексты ошибок `assertRoughCutSettled` (`code === 'ROUGH_CUT_PENDING'`):
  - `review`, любое действие: `черновая нарезка <filePath> ждёт автора: подтверждение – кнопка «Нарезка готова» в пульте или явные слова автора в чате (automontage roughcut confirm)`
  - `confirmed`, `layer new`: `нарезка подтверждена, но master по ней ещё не собран: automontage master --project-dir "<projectDir>" --edit <editPath> (или ваш список с правками автора к этой нарезке)`
  - `confirmed`, `master` – без ошибки.

- [ ] **Step 1: Падающие тесты** (`roughCut` в паспорт пишется `writeProjectManifest(dir, next, { expectedManifest: current })` – без `expectedManifest` запись отказывает конфликтом, `workspace.js:609-623`; хелперы `quiet`/`useSfxDir`/`motionDirs` из `tests/layer-new.test.js` скопировать в новый файл, тестовые файлы не `require`):
  - `buildMaster` при `roughCut.status: 'review'` (проект `makeRoughCutSourceProject` из Task 2) → бросает `/ждёт автора/`, `acquireSlotSync` не вызван, `runTrimImpl` не вызван.
  - `buildMaster` при `confirmed` (фейки как в `tests/source-edit.test.js`) → вызывает `runTrimImpl`, после него `source.revision === 2`, а `activeRoughCut(manifest) === null`.
  - `newLayer.run({ 'project-dir': … })` на `makeLayerProject` с `roughCut` в `review` → отказ `/ждёт автора/`, папок `motion-v*` нет; с `confirmed` → отказ `/master по ней ещё не собран: automontage master --project-dir .* --edit edit\/roughcut-v01\.json/`; после настоящего `buildMaster` с одним куском на всю запись (ревизия 2, `roughCut.sourceRevision` 1) – слой создаётся (`skip: !hasFfmpeg`).
  - `assertRoughCutSettled(manifest, 'master', …)` без поля `roughCut` – без ошибки.
- [ ] **Step 2:** `node --require ./tests/helpers/heavy-queue-isolation.cjs --test tests/rough-cut-guards.test.js` → FAIL (проверок нет).
- [ ] **Step 3: Реализовать** вызовы `assertRoughCutSettled(manifest, 'master', { projectDir })` и `(…, 'layer new', …)`; в `MOTION-KIT.md` – абзац «Черновая нарезка до слоя» и пункт «layer new: черновая нарезка ждёт автора».
- [ ] **Step 4:** тот же запуск + `node --require ./tests/helpers/heavy-queue-isolation.cjs --test tests/source-edit.test.js tests/takes-master.test.js tests/layer-new.test.js` → PASS.
- [ ] **Step 5: Commit** `feat: master and layer new wait for the confirmed rough cut`

### Task 4: Статус и каталог пульта видят нарезку

**Files:**
- Modify: `scripts/pult/status.js:15-79`, `scripts/pult/catalog.js:108-140` (`standardEntry`) и `:169-190` (`legacyEntries`: `roughCut: null`, `roughCutConfirmable: false`, `roughCutCuts: []`), `scripts/pult/comments.js:9` (`VIDEO_KINDS`), `scripts/project/clean.js:155-172` (`pultBlocker`: активная нарезка – блокер «черновая нарезка ждёт автора»), `tests/helpers/pult-projects.js` (новые фикстуры), `tests/pult-status.test.js`, `tests/pult-catalog.test.js`, `tests/pult-comments.test.js`, `tests/project-clean.test.js`

**Interfaces:**
- Consumes: Task 1 `activeRoughCut`, `removedRanges`.
- Produces:
  - `deriveVariantStatus({ …прежние, roughCutExists = false })` дополнительно возвращает `roughCut: { editPath, sha256, status } | null` (активная нарезка) и `roughCutConfirmable: boolean`; видео нарезки – `{ kind: 'roughcut', path: roughCut.filePath, sha256: roughCut.sha256 }`.
  - `standardEntry` добавляет `roughCutCuts: Array<{ atSec, removedSec, note }>` (из `removedRanges(edit.keep, roughCut.sourceDuration)`, `note` обрезан до 500 знаков; список не читается – `[]`).
  - фикстура `addRoughCutProject(projectsDir, { folder, name = folder, status = 'review', videoBytes = null, keep = [{start:0,end:2,note:'хук'},{start:3,end:5,note:'вырезан повтор «Первое»'}], sourceDuration = 6 }) -> { projectDir }` – проект без brief, `edit/roughcut-v01.json` (fps 25, `sourceRevision: 1`), `previews/roughcut-v01.mp4` (байты `videoBytes` или заглушка), `roughCut` с настоящими SHA-256, записанный `writeProjectManifest(dir, next, { expectedManifest: current })`.
  - фикстура `republishRoughCut(projectDir, { version = 2, keep, videoBytes = null }) -> void` – новый `edit/roughcut-vNN.json`, `previews/roughcut-vNN.mp4` и `roughCut` в `review` (как будто агент собрал следующую нарезку); без ffmpeg.
  - фикстура `bumpSourceRevision(projectDir) -> void` – как будто прошёл master: файл-заглушка `input/source-v02.mp4`, `source.revision: 2`, `source.localPath` и запись в `source.history` (`editPath` – текущий `roughCut.editPath`, `transcriptPath: 'transcript/words-v02.json'`) той же записью паспорта с `expectedManifest`.

- [ ] **Step 1: Падающие тесты:**
  - `pult-status`: активная `review` + `roughCutExists: true` → `status 'waiting'`, `nextStep 'Черновая нарезка – посмотрите и отметьте оговорки'`, `video.kind 'roughcut'`, `approvable false`, `roughCutConfirmable true`; та же нарезка и `pendingComments: 2` → `'working'`, `'Ждёт агента: 2 правки'`, видео всё ещё `roughcut`, `roughCutConfirmable true`; `confirmed` → `'working'`, `'Нарезка подтверждена – агент собирает слой'`, `roughCutConfirmable false`; `roughCut.sourceRevision` меньше активной – прежний статус («Агент готовит черновик» без brief); нарезка в `review` вместе с draft-brief и свежим preview – статус нарезки, `approvable false`.
  - `pult-catalog`: `addRoughCutProject` → запись в `waiting`, `roughCutCuts` `[{atSec:2, removedSec:1, note:'вырезан повтор «Первое»'}, {atSec:4, removedSec:1, note:null}]`; `note` длиной 600 → 500 знаков; битый JSON списка → `roughCutCuts: []`, карточка всё равно в `waiting`; файла копии нет → нарезка не активна для пульта (`video` не `roughcut`).
  - `pult-comments`: `addComment` с `video.kind: 'roughcut'` сохраняется, `readComments` читает файл с такой правкой; вид `'rough'` по-прежнему отвергается.
  - `project-clean`: ролик с финалом и активной нарезкой в `review` – `clean` не считает его готовым и не трогает `previews/roughcut-v01.mp4`; после `bumpSourceRevision` – прежнее поведение.
- [ ] **Step 2:** `node --require ./tests/helpers/heavy-queue-isolation.cjs --test tests/pult-status.test.js tests/pult-catalog.test.js tests/pult-comments.test.js tests/project-clean.test.js` → FAIL.
- [ ] **Step 3: Реализовать.** Порядок проверок в `deriveVariantStatus` – как в спеке («Пульт», пп. 1–4); `approvable` = прежнее условие **и** `video.kind === 'preview'`.
- [ ] **Step 4:** тот же запуск + `env -u LEAD_MAGNET_BRAND node --require ./tests/helpers/heavy-queue-isolation.cjs --test tests/pult-*.test.js tests/lead-magnet-*.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(pult): rough cut stage in status and catalog`

### Task 5: Сервер пульта: подтверждение нарезки

**Files:**
- Modify: `scripts/pult/server.js` (коды ошибок рядом с `PREVIEW_DAMAGED` `:47-51`, `servedPreviewMatches`/`approvalTicket` `:141-159`, `browserVariant` `:204-237`, маршрут после `/api/approve` `:429-478`; опция `confirmRoughCutImpl` рядом с `approveBriefImpl` `:86`), `tests/pult-server.test.js`, `ARCHITECTURE.md` (раздел пульта: вид видео `roughcut`, маршрут `/api/roughcut/confirm`, билет нарезки)

**Interfaces:**
- Consumes: Task 2 `confirmRoughCut`; Task 4 поля записи (`roughCut`, `roughCutConfirmable`, `roughCutCuts`).
- Produces:
  - `browserVariant` добавляет `roughCutConfirmable` (и только если видео играет), `roughCutTicket` (HMAC от `` `${key}\0roughcut\0${roughCut.editPath}\0${roughCut.sha256}` `` на `ticketSecret`, `null`, если нельзя подтвердить), `roughCutCuts`.
  - `POST /api/roughcut/confirm`, тело ровно `{ key, ticket, confirmViewed }`: `confirmViewed !== true` → 400 `CONFIRMATION_REQUIRED` «Отметьте, что посмотрели нарезку целиком»; неверный/устаревший билет → 409 `ROUGHCUT_CHANGED` «Появилась новая черновая нарезка – посмотрите её»; байты отданного файла ≠ `roughCut.sha256` → 409 `ROUGHCUT_DAMAGED` «Файл нарезки не совпадает с паспортом – попросите агента пересобрать нарезку»; успех → 201 `{ ok: true }`, вызов `confirmRoughCut(workspace, { expectedSha256, by: 'pult' })`. Ошибка `confirmRoughCut`: сначала перепроверить билет текущей записи, как `/api/approve` (`server.js:458-464`) – билет сменился или `ROUGH_CUT_MISSING` → 409 `ROUGHCUT_CHANGED`; `ROUGH_CUT_CHANGED` → 409 `ROUGHCUT_DAMAGED`; `ENGINE_MANIFEST_CONFLICT` → 409 `PROJECT_BUSY`; остальное → прежняя 500 с логом только класса ошибки.

- [ ] **Step 1: Падающие тесты** (`startTest`, `addRoughCutProject`):
  - `/api/cards`: вариант нарезки – `roughCutConfirmable true`, `roughCutTicket` строка, `approvable false`, `approvalTicket null`, `roughCutCuts` из Task 4; `assertNoPathLeak` по всему ответу и дополнительно `assert.doesNotMatch(text, /roughcut-v\d|edit\/|"[a-f0-9]{64}"/)` (`assertNoPathLeak` ловит только абсолютный `projectsDir`).
  - подтверждение с билетом → 201, `project.json` `roughCut.status 'confirmed'`, `confirmedBy 'pult'`; повтор тем же билетом → 409 `ROUGHCUT_CHANGED`.
  - `confirmViewed: false` → 400 `CONFIRMATION_REQUIRED`; лишний ключ в теле → 400; чужой ключ → 404.
  - байты `previews/roughcut-v01.mp4` подменены после выдачи билета → 409 `ROUGHCUT_DAMAGED`, паспорт не изменился.
  - список кусков изменён после сборки → 409 `ROUGHCUT_DAMAGED`.
  - `confirmRoughCutImpl` бросает `code: 'ROUGH_CUT_MISSING'` (гонка с master) → 409 `ROUGHCUT_CHANGED`, не 500.
  - `POST /api/approve` с билетом нарезки → 409 `PREVIEW_CHANGED` (нарезку нельзя «утвердить»).
- [ ] **Step 2:** `node --require ./tests/helpers/heavy-queue-isolation.cjs --test tests/pult-server.test.js` → FAIL.
- [ ] **Step 3: Реализовать** по образцу `/api/approve` (проверка Origin, `exactKeys`, `safeTokenEqual`, лог только с классом ошибки).
- [ ] **Step 4:** тот же запуск → PASS.
- [ ] **Step 5: Commit** `feat(pult): confirm the rough cut with a ticket bound to the watched file`

### Task 6: Экран пульта: нарезка, список вырезов, «Нарезка готова»

**Files:**
- Modify: `pult/app.js` (`VIDEO_LABELS` `:5-9`, новый блок рядом с `approveBlock` `:399-451`, селектор режима Истории `applyHistoryMode` `:463-467` – добавить `.roughcut`, `side.append` `:764-772`, фоновое обновление открытой карточки: сверку `roughCutTicket` ставить **до** ранних выходов `if (!approveBox) return` и сравнения билета утверждения `:853-858`), `pult/styles.css`, `tests/pult-ui.spec.js`, `docs/PULT.md` (раздел «Работа с роликом» и «Как агент узнаёт о ваших решениях»: команда `automontage roughcut` и строка «Нарезка подтверждена»), `docs/reels-guide/05-pult.md` (шаг «Черновая нарезка» перед «Смотрим как зритель»)

**Interfaces:**
- Consumes: Task 5 поля `roughCutConfirmable`, `roughCutTicket`, `roughCutCuts`, маршрут `/api/roughcut/confirm`.
- Produces: `roughCutBlock(variant) -> HTMLElement` (класс `roughcut`, `dataset.ticket`, `setHistoryMode(active)`), `roughCutCutsBlock(variant, getVideo) -> HTMLElement`.

- [ ] **Step 1: Падающие Playwright-тесты** в `tests/pult-ui.spec.js` (`addRoughCutProject` с `videoBytes: playableVideoBytes` – в `projectsDir` теста до открытия страницы: пульт сканирует папку на каждый запрос, либо через существующий перезапуск сервера с новой папкой, как в соседних тестах):
  - «a rough cut waits for the author with its cut list and no approval»: карточка в «Ждёт меня» с текстом «Черновая нарезка – посмотрите и отметьте оговорки»; подпись видео «Черновая нарезка без графики»; кнопки «Утверждаю» нет; заголовок «Что вырезал агент (2 места, 2,0 с)»; клик по строке «0:02 – вырезано 1,0 с: вырезан повтор «Первое»» ставит `video.currentTime` в 1 ± 0,1.
  - «confirming the rough cut needs the full-view checkbox»: «Нарезка готова» неактивна до флажка «Я посмотрел нарезку целиком»; после клика – уведомление «Нарезка подтверждена…», карточка в «В работе» со статусом «Нарезка подтверждена – агент собирает слой», в `project.json` `confirmedBy: 'pult'`.
  - правка на секунде к нарезке сохраняется (как тест «an edit is saved at the current second…») и даёт «Ждёт агента: 1 правка», а «Нарезка готова» остаётся доступной.
- [ ] **Step 2:** `npx playwright test tests/pult-ui.spec.js --project=chromium` → новые тесты FAIL.
- [ ] **Step 3: Реализовать.** Подсказка в блоке: «Отметили оговорки – агент вырежет их и продолжит без повторного показа. Хотите посмотреть ещё раз – не нажимайте, оставьте правки». Уведомление успеха: «Нарезка подтверждена. Скопируйте фразу для агента – он соберёт слой.»; `ROUGHCUT_CHANGED` → `refresh()` и «Появилась новая черновая нарезка – посмотрите её.»; `ROUGHCUT_DAMAGED` → текст сервера без `refresh()`. Строка выреза: `${formatClockFloor(atSec)} – вырезано ${секунды с одной цифрой через запятую} с` + `: ${note}`, если есть (`formatClockFloor` – уже в `pult/app.js:118`; серверный `formatTime` из `inbox.js` в браузере недоступен); клик – `currentTime = Math.max(0, atSec - 1)`. В режиме Истории кнопка блокируется, как «Утверждаю». Числа в заголовке – с правильным склонением («1 место», «2 места», «5 мест»).
- [ ] **Step 4:** `npm run test:review-ui` → PASS.
- [ ] **Step 5: Commit** `feat(pult): rough cut screen with cut list and confirm button`

### Task 7: Входящие: правки к нарезке и «Нарезка подтверждена»

**Files:**
- Modify: `scripts/pult/inbox.js:42-163` (`buildInbox`, `formatInbox`), `tests/pult-inbox.test.js`, `ARCHITECTURE.md` (строки входящих)

**Interfaces:**
- Consumes: Task 1 `editPathForRoughCutVideo`, `roughCutTimeToSource`; Task 4 `entry.roughCut`, фикстуры `addRoughCutProject`, `republishRoughCut`, `bumpSourceRevision`.
- Produces: `formatSourceTime(seconds) -> string` (`31.2` → `0:31.20`, `75.5` → `1:15.50`); в элементах `buildInbox` – `roughCutConfirmed: string | null` (editPath) и у правок к нарезке `sourceTimeSec: number | null`, `sourceRevision: number | null` (из `sourceRevision` списка кусков).

- [ ] **Step 1: Падающие тесты:**
  - правка на 2,5 с к нарезке из `addRoughCutProject` → строка ровно `` - Правка `c-0001` к черновой нарезке на 0:02 (в исходнике ревизии 1: 0:03.50): «Оговорка». Видео: `previews/roughcut-v01.mp4`. Кадр: `…` `` (keep 0–2, 3–5).
  - нарезка v01 с правкой, затем `republishRoughCut(projectDir, { version: 2, keep: [{start:0,end:4}] })` → правка помечена «(к прежней версии видео)» и всё равно содержит «в исходнике ревизии 1: 0:03.50» по списку v01.
  - битый `edit/roughcut-v01.json` → строка без «в исходнике», остальное как прежде.
  - `confirmed` без master → строка `` - Нарезка подтверждена: `edit/roughcut-v01.json`. Если к ней есть правки – скопируй список в edit/vNN-source.json и внеси их по секундам исходника; затем собери master и переходи к слою. ``; после `bumpSourceRevision` строки нет; `review` без правок – папки во входящих нет.
  - управляющие символы в тексте правки вырезаются (как существующий тест).
- [ ] **Step 2:** `node --require ./tests/helpers/heavy-queue-isolation.cjs --test tests/pult-inbox.test.js` → FAIL.
- [ ] **Step 3: Реализовать.** Список кусков читать через `resolveProjectPath(…, { mustExist: true, type: 'file' })` в `try/catch`; путь и текст печатать через `stripControls`/`sanitizeText`.
- [ ] **Step 4:** тот же запуск + `env -u LEAD_MAGNET_BRAND node --require ./tests/helpers/heavy-queue-isolation.cjs --test tests/lead-magnet-inbox.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(pult): inbox maps rough cut edits to source time`

### Task 8: Навыки, правила агента и пользовательские документы

**Files:**
- Create: `skills/reel-turnkey/references/rough-cut.md`, указатели `.agents/skills/reel-turnkey/references/rough-cut.md` и `.codex/skills/reel-turnkey/references/rough-cut.md` (по образцу соседних `creative-motion.md`), `tests/rough-cut-instructions.test.js`
- Modify: `skills/reel-turnkey/SKILL.md` (шаг 2 «Черновая нарезка»: сюда переезжает транскрибация из шага 3 `:188-191`, шаг 3 берёт `transcript.words` из паспорта; строки `:162-168` про паузы и сомнительные повторы; блок «Motion-слой из kit» `:373-412`), `skills/reel-turnkey/references/creative-motion.md` (контракт автономности `:42-60`, «Project-local motion pack» `:125-129`), `skills/reel-turnkey/references/motion-layer-brief.md` («Вход»), `skills/reel-turnkey/references/qa-checklist.md` (пункт «нарезка подтверждена автором до слоя»), `skills/reel-from-donor/SKILL.md` (новый раздел «Подготовка до съёмки» перед «Шаг 4», блок «Motion-слой из kit»), `skills/motion-reel/SKILL.md` + `.agents/skills/motion-reel/SKILL.md` + `.codex/skills/motion-reel/SKILL.md` (одна строка в блоке «Motion-слой из kit», копии побайтно равны), `AGENTS.md` («Обязательный выбор монтажа в новом чате», «Пульт роликов», список «Команды»: `automontage roughcut`), `docs/MONTAGE-GUIDE.md` (шаг 3), `docs/reels-guide/03-source-video.md:135-136`, `docs/reels-guide/04-montage.md` (шаг 4), `README.md`, `DECISIONS.md` (D-046), `CHANGELOG.md` `[Unreleased]`

**Interfaces:**
- Consumes: команды и тексты Task 2–7.
- Produces: обязательные формулировки, которые проверяет тест:
  - `AGENTS.md` и `creative-motion.md`: «Обязательные пользовательские точки – три: один выбор маршрута в начале, подтверждение черновой нарезки (для записи с речью; «режь сам» его снимает) и явное утверждение просмотренного preview перед final.»
  - `AGENTS.md` «Пульт роликов»: строка «Нарезка подтверждена» во входящих означает: внеси правки к ней, собери master и переходи к слою; «никогда не вызывай `/api/roughcut/confirm`»; `automontage roughcut confirm` – только по явным словам автора в чате; правило правок к подтверждённой нарезке из Global Constraints («`edit/roughcut-vNN.json` не меняй, скопируй в `edit/vNN-source.json`…»); «режь сам» после показа нарезки – явное подтверждение.
  - блок «Motion-слой из kit» в трёх навыках (в `motion-reel` – одинаково в каноническом файле и обеих копиях `.agents/`, `.codex/`): «Перед `layer new` всегда соберите master из подтверждённой черновой нарезки» и «Таймингов ещё нет – слой не создаём» (точный регистр).
  - `skills/reel-turnkey/SKILL.md`: одной строкой «Сомнительный повтор оставляй и назови автору – он решит на нарезке.» – контракт `/сомнительн.*повтор.*остав/` из `tests/batch-workflow-docs.test.js:44` проверяет одну строку.
  - `rough-cut.md`: когда этап нужен и когда пропускается («режь сам» до показа); порядок поиска пауз и повторов из спеки (пп. 1–6, включая `vad_filter=False`, «пауза ≥ 1,2 с», «0,35 с», «≈ 0,2 с»); правило растянутого слова прямо в тексте, без ссылки на локальный `knowledge/` (он в `.gitignore`, ссылку завалит проверка markdown-ссылок): «слово длиннее 1 с – переслушать окнами 1–1,5 с с `condition_on_previous_text=False` и посмотреть огибающую RMS»; команды `automontage roughcut`, `automontage inbox`, `automontage roughcut confirm`, `automontage master … --edit edit/roughcut-vNN.json`; правило правок к подтверждённой нарезке; список подготовки до подтверждения (папка `prep/`: ДНК дизайна, `scenes.jsx`, карта вставок по фразам суфлёра без секунд; `assets/`; музыка; обещание лид-магнита); правило «план слоя – только на якорях слов, без `near`»; «Готовый стиль»: до подтверждения нарезки preview не собирать; ночной режим.
  - суфлёр (`reel-from-donor`) и `docs/reels-guide/03-source-video.md`: «оговорились – помолчите около 2 секунд и повторите фразу целиком».

- [ ] **Step 1: Падающий тест** `tests/rough-cut-instructions.test.js` (`read`/`words` как в `creative-motion-instructions.test.js`): все обязательные формулировки выше; `rough-cut.md` без длинного тире (U+2014), `\/Users\/`, `\/home\/` (как регулярные выражения), `projects/20\d\d`, `knowledge/`; оба указателя `rough-cut.md` в `.agents/` и `.codex/` ссылаются на `skills/reel-turnkey/references/rough-cut.md`; `skills/reel-turnkey/SKILL.md` ссылается на `references/rough-cut.md`; `reel-from-donor` содержит «Подготовка до съёмки» и ссылку на `rough-cut.md`; `README.md` и `docs/PULT.md` содержат `automontage roughcut` и «Нарезка готова»; `DECISIONS.md` содержит `## D-046`.
- [ ] **Step 2:** `node --require ./tests/helpers/heavy-queue-isolation.cjs --test tests/rough-cut-instructions.test.js` → FAIL.
- [ ] **Step 3: Написать тексты.** `DECISIONS.md` D-046 «Черновая нарезка до слоя: копия из оригинала по списку кусков, подтверждает человек» – альтернативы: нарезка в чате (вариант А), master как черновая нарезка (второе поколение сжатия, `knowledge/` урок про перерезку master), отрезать кусок из готового слоя; почему выбрано. `CHANGELOG.md` `[Unreleased]` (после выпуска 1.12.0 секция пустая) → новый подзаголовок «### Добавлено»: этап черновой нарезки, команда, защита `master`/`layer new`.
- [ ] **Step 4:** `node --require ./tests/helpers/heavy-queue-isolation.cjs --test tests/rough-cut-instructions.test.js tests/creative-motion-instructions.test.js tests/pult-agent-rules.test.js tests/reel-from-donor-skill.test.js tests/batch-workflow-docs.test.js tests/release-hygiene.test.js tests/package-privacy.test.js` → PASS.
- [ ] **Step 5: Commit** `docs: rough cut stage in skills, agent rules and guides`

### Task 9: Приёмка на копии реального проекта

**Files:**
- Modify: Issue #82 (комментарий с результатами), `TESTING.md` (ручная проверка этапа нарезки), локально – `knowledge/montage-speed-audit-2026-10-02.md` (итог)

**Interfaces:**
- Consumes: всё выше.

- [ ] **Step 1: Стенд.** Скопировать (`cp -c`) `input/source.mp4`, `transcript/words.json`, `edit/v02-source.json` любого законченного ролика с 4K или 1080p/50 исходником в `tmp/accept-roughcut/projects/<папка>/`; паспорт – ревизия 1, без brief (как стенд замеров спеки). Список переименовать в `edit/roughcut-v01.json`.
- [ ] **Step 2:** `time node scripts/cli.js roughcut --project-dir tmp/accept-roughcut/projects/<папка> --edit edit/roughcut-v01.json` → `✅ черновая нарезка…`; ожидание: ≤ 40 с на 100–120 с ролика при свободной очереди (замер спеки под нагрузкой – 27–36 с); ffprobe копии – 720×1280, `yuv420p`.
- [ ] **Step 3: Выполняет владелец, не агент.** Агент запускает `node scripts/cli.js pult --projects-dir tmp/accept-roughcut/projects` и просит владельца: проверить карточку «Черновая нарезка – посмотрите и отметьте оговорки», что видео играет и список вырезов совпадает со списком кусков; оставить правку на секунде, поставить флажок и нажать «Нарезка готова». Агент ждёт его сообщения. Нажимать кнопку самому (браузером, Playwright, `curl`) агенту запрещено – это то же правило, что для `/api/approve`; без владельца приёмку кнопки заменяет автоматический Playwright из Task 6.
- [ ] **Step 4:** `node scripts/cli.js inbox --projects-dir tmp/accept-roughcut/projects` → строка правки с секундой исходника и строка «Нарезка подтверждена»; вручную сверить секунду исходника на слух (`ffplay -ss <секунда> input/source.mp4`).
- [ ] **Step 5:** `node scripts/cli.js layer new --project-dir …` до master → отказ `нарезка подтверждена, но master по ней ещё не собран: …`; по правилу правок скопировать список в `edit/v02-source.json`, внести правку владельца; `time node scripts/cli.js master --project-dir … --edit edit/v02-source.json` → ревизия 2; `layer new` → `motion-v01`; inbox без строки «Нарезка подтверждена»; `inbox --accept` правки.
- [ ] **Step 6:** `env -u LEAD_MAGNET_BRAND npm test` и `npm run test:review-ui` → PASS; `node scripts/check-public-privacy.js --staged` и Gitleaks – чисто. Результаты и времена – комментарием в Issue (без имени клиентской папки и личных путей), Status «Проверка». Удалить `tmp/accept-roughcut/` после проверки.
- [ ] **Step 7: Commit** `docs: rough cut acceptance notes` (только `TESTING.md`).
