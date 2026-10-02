# Очередь тяжёлых задач и меньше перекодирований – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** тяжёлые задачи движка на одной машине идут по очереди, а итерация «правка → preview» делает на три полных перекодирования видео меньше (≈ −4 мин на ролик 95 с в 1080p).

**Architecture:** машинная очередь – N слотов-папок, каждый занимается существующим `acquireProjectMutationLease`; `layer render`, `layer import`, `preview`, финалы (`build.js`, `motion/build.js`) и `master` берут слот до блокировки проекта. Remotion рендерит слой сразу в limited range (`ffmpegOverride` по переменной окружения), поэтому нормализация трогает только звук. Импорт проверенного слоя переупаковывает файл вместо перекодирования и кодирует прокси VP8 в 4 потока.

**Tech Stack:** Node.js 20 CommonJS, Remotion 4.0.504 (`Config.overrideFfmpegCommand`), ffmpeg, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-02-heavy-queue-and-fewer-encodes-design.md` (замеры и проверки эквивалентности – там).

## Global Constraints

- Очередь: папка `process.env.AUTOMONTAGE_HEAVY_DIR || path.join(os.tmpdir(), 'automontage-heavy')`; слоты `slot-0` … `slot-(N-1)`; `AUTOMONTAGE_HEAVY_SLOTS` – целое 1–8, по умолчанию 1; `AUTOMONTAGE_HEAVY_WAIT_MS` – целое ≥ 0, по умолчанию `3 * 3600_000`; опрос раз в 5000 мс.
- Ошибка занятой очереди: `error.code === 'HEAVY_QUEUE_BUSY'`, текст начинается с `машина занята: `.
- Label слота – `<задача> <имя папки проекта>[/<слой>]`, только `path.basename` проекта: label может попасть в браузер Review, а там скрывается лишь путь текущего проекта.
- Слот берётся до `acquireProjectMutationLease` проекта и отпускается в `finally`.
- Override Remotion включается только при `AUTOMONTAGE_LAYER_LIMITED_RANGE=1`; его ставит только `layer render`, окружение передаётся как `{ ...process.env, AUTOMONTAGE_LAYER_LIMITED_RANGE: '1' }` (`runTool` отдаёт `env` в `spawnSync`, который заменяет окружение целиком).
- `scripts/remotion-ffmpeg-override.js` не требует npm-модулей: `remotion.config.js` собирается esbuild CLI Remotion.
- Переупаковка мастера – только `masterStrategy: 'remux-if-conforming'` из `scripts/layer/import.js`; HTTP-импорт Review не меняется (тест `review-media-import.test.js` L687 «video process argv relies on cross-version default autorotation…» остаётся зелёным без правок).
- `--no-wait` у `layer render` меняет смысл: было «запустить сразу, не проверяя машину», станет «не ждать очередь: занято – сразу ошибка».
- Новых npm-зависимостей нет. Сообщения пользователю – по-русски.
- Ветка `feat/heavy-queue`, не `main`; push/merge – по явной просьбе владельца.
- Перед началом найти или создать Issue через форму `.github/ISSUE_TEMPLATE/` (правило `AGENTS.md`).
- **До Task 3** (на `main`, до любых правок) отрендерить эталонный слой для сравнения: `node scripts/cli.js layer render` на временной копии готового 1080p-проекта; сохранить `motion-vNN/renders/layer-01.mp4` как `tmp/baseline-layer.mp4` (папка `tmp/` в `.gitignore`).

## Review Focus

1. Процесс с занятым слотом упал (kill -9): следующий запуск на этом хосте забирает слот, а не ждёт 3 ч – тест в Task 1.
2. Remotion выбрал параллельное кодирование (`pre-stitcher` кодирует libx264, `stitcher` делает `-c:v copy`): override не добавляет `-vf` к копированию – тест в Task 3.
3. Слой с моно-звуком или 29,97 fps: импорт либо переупаковывает (стерео, точный fps), либо честно перекодирует – тесты в Task 3 и Task 4.
4. Review preview при занятой машине: отказ за секунды с причиной «машина занята», а не убитое по таймауту задание – тест в Task 5.
5. Параллельный прогон тестовых файлов (`npm test`, Windows CI) не делит одну очередь и не встаёт в реальную очередь машины – проверка в Task 1.

---

### Task 1: Модуль очереди и изоляция тестов

**Files:**
- Create: `scripts/heavy-queue.js`, `tests/heavy-queue.test.js`, `tests/helpers/heavy-queue-isolation.cjs`
- Modify: `package.json` (скрипты `test`, `test:video-edit`), `playwright.config.js`, `.github/workflows/ci.yml` (Windows-задача L101–146 вызывает `node --test <файлы>` напрямую)

**Interfaces:**
- Produces:
  - `heavyQueueConfig(env = process.env) -> { dir, slots, waitMs, pollMs: 5000 }` – неверные значения → `Error` с именем переменной.
  - `tryAcquireHeavySlot({ label, config, leaseOptions = {} }) -> HeavySlot | null`
  - `acquireHeavySlotSync({ label, config, log, sleepSync, now }) -> HeavySlot` (ожидание блокирует поток: `Atomics.wait` на `SharedArrayBuffer`, работает в основном потоке Node 20/26)
  - `acquireHeavySlot({ label, config, log, sleep, now }) -> Promise<HeavySlot>`
  - `HeavySlot = { index, waited: boolean, release() }`; `release` идемпотентен.
  - `listHeavySlots(config) -> Array<{ index, busy, label, pid, acquiredAt }>` – слот с мёртвым владельцем (`kill(pid, 0)` → ESRCH) показывается свободным.
  - `HEAVY_QUEUE_BUSY = 'HEAVY_QUEUE_BUSY'`

- [ ] **Step 1: Хелпер изоляции.** `tests/helpers/heavy-queue-isolation.cjs`: если `process.env.NODE_TEST_CONTEXT` задан (процесс отдельного тестового файла) или `AUTOMONTAGE_HEAVY_DIR` не задан – `process.env.AUTOMONTAGE_HEAVY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-heavy-test-'))`, а на `process.on('exit')` – `fs.rmSync(dir, { recursive: true, force: true })` для папки, созданной этим процессом. (Хелпер выполняется и в родительском процессе раннера; без условия по `NODE_TEST_CONTEXT` все файлы делили бы одну папку.)
- [ ] **Step 2: Падающие тесты** (каждый тест – своя `mkdtemp`-папка в `config.dir`):
  - `slots: 1` → второй `tryAcquireHeavySlot` возвращает `null`; после `release()` – снова слот; `slots: 2` → два слота, третий `null`.
  - владелец умер: дочерний `node -e ''` завершён, в `slot-0/.project-mutation.lock` записан `{"version":1,"token":"<randomUUID>","pid":<его pid>,"hostname":os.hostname(),"acquiredAt":"<ISO>"}` → `tryAcquireHeavySlot` забирает слот.
  - живые процессы: дочерний `node -e` занимает слот и ждёт сигнала; родитель получает `null`; после выхода ребёнка – слот.
  - ожидание: занят слот; `sleepSync` на первом вызове освобождает его → `acquireHeavySlotSync` возвращает `waited: true`, `log` вызван ровно один раз со строкой, содержащей `очередь тяжёлых задач занята` и label держателя.
  - `waitMs: 0` и занятый слот → ошибка `code === 'HEAVY_QUEUE_BUSY'`, текст `/^машина занята: .*layer render demo/`.
  - таймаут: `now` прибавляет 6000 мс за вызов, `waitMs: 10000` → `HEAVY_QUEUE_BUSY` после третьего опроса.
  - `listHeavySlots`: занятый слот – `busy: true`, `label`, `pid`; слот мёртвого владельца и свободный – `busy: false`.
  - `heavyQueueConfig({ AUTOMONTAGE_HEAVY_SLOTS: '9' })` → бросает `/AUTOMONTAGE_HEAVY_SLOTS/`.
  - изоляция: `process.env.AUTOMONTAGE_HEAVY_DIR` начинается с `path.join(os.tmpdir(), 'automontage-heavy-test-')`.
- [ ] **Step 3:** `node --require ./tests/helpers/heavy-queue-isolation.cjs --test tests/heavy-queue.test.js` → FAIL «Cannot find module '../scripts/heavy-queue'».
- [ ] **Step 4: Реализовать.** Слот: `fs.mkdirSync(slotDir, { recursive: true })`, затем `acquireProjectMutationLease(slotDir)`; `PROJECT_MANIFEST_CONFLICT` → слот занят. После захвата – `holder.json` `{ label, pid, acquiredAt }` рядом (best-effort, удаляется в `release` до снятия lease). Лог ожидания – только при смене держателя.
- [ ] **Step 5:** `package.json`: `"test": "node --require ./tests/helpers/heavy-queue-isolation.cjs --test tests/*.test.js"`, так же для `test:video-edit`; первая строка `playwright.config.js` – `require('./tests/helpers/heavy-queue-isolation.cjs');`; в `.github/workflows/ci.yml` каждой Windows-команде `node --test …` добавить `--require ./tests/helpers/heavy-queue-isolation.cjs` и включить `tests/heavy-queue.test.js` в её список файлов.
- [ ] **Step 6:** тот же запуск → PASS; `npm test` – стартует без ожидания очереди.
- [ ] **Step 7: Commit** `feat: machine-wide heavy job queue`

---

### Task 2: `layer render` встаёт в очередь вместо опроса `ps`

**Files:**
- Modify: `scripts/layer/render.js` (`run` L103–152, `FLAGS` L29), `scripts/layer/cli.js` (справка `--no-wait`, L7)
- Delete: `scripts/layer/busy.js`, `tests/layer-busy.test.js`
- Test: `tests/layer-render.test.js` – переписать тесты L374 «a plan edited while waiting for a free machine is checked again before the render» и L387 «without waiting (the machine is already free) layer check runs once»; хелпер `scaffold`/`run` (L48) по умолчанию подставляет фейковый `deps.acquireSlot` (`async () => ({ index: 0, waited: false, release() {} })`), чтобы `'no-wait': true` не зависел от общей очереди.

**Interfaces:**
- Consumes: `acquireHeavySlot`, `heavyQueueConfig` (Task 1).
- Produces: `deps.acquireSlot` с контрактом `acquireHeavySlot`.

- [ ] **Step 1: Падающие тесты:**
  - «a plan edited while waiting in the queue is checked again before the render»: `acquireSlot` → `{ waited: true }` → `checkImpl` вызван 2 раза; при отказе второй проверки рендер не запускается.
  - «a free queue means one layer check»: `waited: false` → 1 проверка, 1 рендер.
  - «the slot is held until the report is written»: `release` вызывается после записи `qa/layer-*-render-NN.json` и при исключении Remotion.
  - «--no-wait does not wait in the queue»: `acquireSlot` получил `config.waitMs === 0`.
  - label: `acquireSlot` получил `label === 'layer render <basename проекта>/motion-v01'`.
- [ ] **Step 2:** `node --require ./tests/helpers/heavy-queue-isolation.cjs --test tests/layer-render.test.js` → новые FAIL.
- [ ] **Step 3: Реализовать.** Слот берётся после первой `layer check` и держится до конца `renderClaimed`; при `waited` – сообщение «Очередь освободилась – проверяю план слоя ещё раз: за время ожидания его могли поправить» и повторная проверка. Удалить импорт `busy.js` (L26), файл и его тест.
- [ ] **Step 4:** тот же запуск → PASS; `grep -rn "busy.js\|waitUntilFree\|busyRenders" scripts tests` → пусто.
- [ ] **Step 5: Commit** `feat: layer render waits in the heavy queue instead of polling ps`

---

### Task 3: Слой кодируется один раз

**Files:**
- Create: `scripts/remotion-ffmpeg-override.js`, `tests/remotion-ffmpeg-override.test.js`
- Modify: `remotion.config.js`, `scripts/layer/render.js` (`normalizeArgs` L94–99, вызовы Remotion L170 и нормализации L172 в `renderClaimed`)
- Test: `tests/layer-render.test.js` (фейковый Remotion L24–38)

**Interfaces:**
- Produces:
  - `LIMITED_RANGE_ENV = 'AUTOMONTAGE_LAYER_LIMITED_RANGE'`, `shouldOverride(env) -> boolean` (`env[LIMITED_RANGE_ENV] === '1'`).
  - `limitedRangeOverride({ type, args }) -> Array` – если в `args` есть пара `'-c:v', 'libx264'`, вставляет `'-vf', 'scale=out_range=tv,format=yuv420p', '-color_range', 'tv'` перед последним элементом (выходной путь) и перед `'-y'`, если `'-y'` стоит прямо перед ним; иначе возвращает `args` без изменений. Элементы `args` могут быть числами (`['-r', 30]` в pre-stitcher) – сравнивать через `String(arg)`.
  - `normalizeAudioArgs(raw, out, samples) -> string[]` в `render.js` – аргументы `normalizeArgs`, где вместо `'-vf', 'scale=out_range=tv,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '14'` стоит `'-c:v', 'copy'`.
  - `normalizeArgs` и `normalizeAudioArgs` содержат `'-ac', '2'`.

- [ ] **Step 1: Падающие тесты:**
  - override: stitcher-аргументы Remotion 4.0.504 (`['-r', 30, '-f', 'image2', '-s', '1080x1920', '-start_number', 0, '-i', 'el-%02d.jpeg', '-i', 'a.aac', '-c:a', 'copy', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-video_track_timescale', 90000, '-crf', 18, '-movflags', 'faststart', '-map_metadata', '-1', '-metadata', 'comment=Made with Remotion 4.0.504', '-y', 'out.mp4']`) → `-vf …` и `-color_range tv` стоят перед `'-y'`; без `'-y'` – перед `'out.mp4'`; аргументы с `'-c:v', 'copy'` → `deepEqual` исходным.
  - `shouldOverride({ AUTOMONTAGE_LAYER_LIMITED_RANGE: '1' }) === true`, `shouldOverride({}) === false`; `remotion.config.js` вызывает `Config.overrideFfmpegCommand` только при `shouldOverride(process.env)` (проверка: строка-условие в конфиге через `fs.readFileSync` + регулярное выражение, т. к. конфиг исполняется только внутри CLI Remotion).
  - layer render передаёт Remotion `options.env` с `AUTOMONTAGE_LAYER_LIMITED_RANGE === '1'` и `PATH === process.env.PATH` (фейк записывает полученный `options.env`).
  - фейк Remotion отдаёт limited range (`-pix_fmt yuv420p -color_range tv -colorspace bt470bg`; без `-colorspace` ffmpeg 9 пишет `color_range=unknown`) → md5 видеопотока слоя (`ffmpeg -i X -map 0:v -c copy -f md5 -`) равен md5 сырого (сырой посчитать в хуке фейка до удаления заявки); звук обрезан точно (как в существующем тесте на 6,0 с при 60 fps).
  - фейк отдаёт full range (как сейчас) → полная нормализация: `pix_fmt yuv420p`, `color_range tv`, минимум яркости ≥ 16 (существующий тест L89–101 зелёный), в выводе `Remotion отдал full range – перекодирую видео`.
  - моно-звук у фейка → у слоя 2 канала в обеих ветках.
- [ ] **Step 2:** `node --require ./tests/helpers/heavy-queue-isolation.cjs --test tests/remotion-ffmpeg-override.test.js tests/layer-render.test.js` → FAIL.
- [ ] **Step 3: Реализовать.** Ветка выбирается по `ffprobe -v error -select_streams v:0 -show_entries stream=pix_fmt,color_range -of json` сырого файла (`captureTool`): `yuv420p` + `tv` → `normalizeAudioArgs`, иначе `normalizeArgs` с предупреждением.
- [ ] **Step 4:** тот же запуск → PASS.
- [ ] **Step 5: Настоящий Remotion** (машина без других рендеров): `node scripts/cli.js layer render` на той же временной копии проекта, что и эталон → в выводе нет `Remotion отдал full range`; `ffprobe`: `yuv420p`, `color_range=tv`; G6/G7 зелёные; `ffmpeg -i <новый слой> -i tmp/baseline-layer.mp4 -lavfi psnr -f null -` → average ≥ 45 дБ.
- [ ] **Step 6: Commit** `perf: render the motion layer in limited range and normalize audio only`

---

### Task 4: Импорт слоя – очередь, переупаковка, быстрый прокси

**Files:**
- Modify: `scripts/review/media-import.js` (`importReviewMedia` L1767, `normalizeIntoQuarantine` L956, `videoMasterInvocation` L889, `videoProxyInvocation` L918)
- Modify: `scripts/layer/import.js` (`run` L145, `importLayerFile` L103 – сейчас жёстко передаёт `runMediaProcessImpl: runMediaProcess` на L126; принимать подмену через параметр)
- Test: `tests/layer-import.test.js` (реальный `importReviewMedia` и ffmpeg), `tests/review-media-import.test.js`

**Interfaces:**
- Consumes: `acquireHeavySlot` (Task 1).
- Produces:
  - параметр `importReviewMedia({ …, masterStrategy = 'encode' })`, значения `'encode' | 'remux-if-conforming'`; иное → `Error`.
  - `remuxConformity(source, outputFps) -> { ok: boolean, reason: string | null }` – `ok`, если `source.videoCodec === 'h264'`, `source.pixelFormat === 'yuv420p'`, `source.rotation === 0`, `width`/`height` чётные, `Math.abs(source.fps - outputFps) <= 1e-6` (`source.fps` – из `avg_frame_rate`), и при `source.hasAudio` – `audioCodec === 'aac'`, `audioSampleRate === 48000`, `audioChannels === 2`.
  - `videoRemuxInvocation(owned, source, signal, quota)`: `-hide_banner -loglevel error -i <upload> -map 0:v:0 [-map 0:a:0 при hasAudio] -map_metadata -1 -c copy -t <source.durationSec> -movflags +faststart -fs <quota> -y <canonical>`, тот же таймаут и лимиты вывода, что у мастера.
  - `videoProxyInvocation(owned, source, outputFps, signal, quota, { fast = false } = {})` – при `fast` вместо `'-threads', '1'` стоит `'-threads', '4', '-cpu-used', '4'`.
  - `importLayerFile({ …, runMediaProcessImpl = runMediaProcess })`; `run(options, deps)` пробрасывает `deps.runMediaProcessImpl` и использует `deps.acquireSlot` (по умолчанию `acquireHeavySlot`).

- [ ] **Step 1: Падающие тесты:**
  - `remuxConformity`: подходит h264/yuv420p/30 fps/AAC 48 кГц стерео; не подходит – по одному полю: hevc, yuv444p, поворот 90, нечётная ширина, fps 29.97 при `outputFps` 30, моно, 44,1 кГц (у каждого `reason` не `null`).
  - layer import настоящего слоя: `makeLayerProject(t, { seconds: 2, fps: 30 })`; аудио фикстуры – `sine` с `sample_rate=48000` и `-ac 2` (сейчас 44,1 кГц моно); видео `-pix_fmt yuv420p -color_range tv -colorspace bt470bg`. Шпион `runMediaProcessImpl` записывает аргументы: у мастера есть `'-c', 'copy'` и нет `libx264`; у прокси – `'-threads', '4', '-cpu-used', '4'`; md5 видеопотока опубликованного `media.mp4` равен md5 видеопотока слоя; ассет проходит `inspectImportedAssetBundle`; в выводе – `мастер: переупаковка без перекодирования`.
  - тот же слой с моно-звуком → у мастера `libx264`, у прокси быстрые флаги, импорт успешен, звук мастера стерео, в выводе `мастер: перекодирование – `.
  - `importReviewMedia` без `masterStrategy` → аргументы как раньше (тест L687 без правок).
  - `masterStrategy: 'zip'` → ошибка.
  - порядок: `deps.acquireSlot` вызван раньше `importImpl`, `release` – после, в том числе при ошибке импорта; label `layer import <basename проекта>`.
- [ ] **Step 2:** `node --require ./tests/helpers/heavy-queue-isolation.cjs --test tests/layer-import.test.js tests/review-media-import.test.js` → FAIL.
- [ ] **Step 3: Реализовать.** В `normalizeIntoQuarantine` – выбор мастера по `masterStrategy` и `remuxConformity`; прокси `fast: masterStrategy !== 'encode'`; `verifyNormalizedOutputs` не меняется. Слот берётся в `run` после `checkedReport` и до `importLayerFile`.
- [ ] **Step 4:** тот же запуск → PASS.
- [ ] **Step 5: Commit** `perf: trusted layer import remuxes the master and encodes the proxy in 4 threads`

---

### Task 5: Preview, финалы и master встают в очередь

**Files:**
- Modify: `scripts/preview.js` (`runPreview` L126–285, `main` L287), `scripts/review/preview-jobs.js` (окружение ребёнка L137), `review/app.js` (текст отказа preview, L504), `scripts/build.js` (оба `runRenderLifecycle`: lesson L448 и Dynamic L637), `scripts/motion/build.js` (`runRenderLifecycle` L166), `scripts/project/build-master.js` (`main`)
- Test: `tests/lesson-preview.test.js`, `tests/broll-preview-approval.test.js` (тесты `createPreviewJobs` L154–275; `barrierReason` не экспортирован – проверять через `job.reason` с фейковым `spawnImpl`, как на L237–270), `tests/source-edit.test.js`

**Interfaces:**
- Consumes: `acquireHeavySlotSync`, `heavyQueueConfig`, `HEAVY_QUEUE_BUSY` (Task 1).
- Produces: `dependencies.acquireSlotSync` в `runPreview` и `buildMaster` для тестов.

- [ ] **Step 1: Падающие тесты:**
  - `runPreview` с занятым слотом при `AUTOMONTAGE_HEAVY_WAIT_MS=0` → `HEAVY_QUEUE_BUSY`, Remotion не вызывался, `currentPreview` не изменился.
  - `main` preview при `HEAVY_QUEUE_BUSY` печатает в stderr `preview не опубликован: машина занята: …` и ставит код 1 (сейчас `main` печатает `❌ preview отменён: …`, а Review ищет `preview не опубликован:`).
  - `createPreviewJobs` запускает ребёнка с `env.AUTOMONTAGE_HEAVY_WAIT_MS === '0'`; фейковый ребёнок пишет в stderr `preview не опубликован: машина занята: layer render demo` и выходит с 1 → `job.error === 'PREVIEW_BLOCKED'`, `job.reason === 'машина занята: layer render demo'`.
  - `buildMaster` берёт слот раньше блокировки проекта для обеих веток (дубли и обычная нарезка); при ошибке encode слот освобождён.
- [ ] **Step 2:** запуск этих файлов с `--require` хелпера → FAIL.
- [ ] **Step 3: Реализовать.** Labels: `preview <проект>`, `final <проект>`, `motion final <проект>`, `master <проект>`. Слот держится от сборки медиа-бандла до проверки декодирования (preview) и до копирования финала (`build.js`, `motion/build.js`). В `review/app.js` для причины, начинающейся с `машина занята`, показывать «Машина занята другой задачей (<причина>). Повторите preview позже.» вместо «…исправьте и повторите».
- [ ] **Step 4:** тот же запуск → PASS.
- [ ] **Step 5: Commit** `feat: preview, final renders and master wait in the heavy queue`

---

### Task 6: `automontage queue` и проверка громкости без видео

**Files:**
- Modify: `scripts/cli.js` (ветка `if (argv[0] === 'queue')` в цепочке L164–249, до `SIGNAL_FORWARDING`; строка справки), `scripts/finish.js` (`loudnessCommand` L89–94)
- Test: `tests/heavy-queue.test.js`, `tests/media-finalization-security.test.js` (рядом с L123)

- [ ] **Step 1: Падающие тесты:** `node scripts/cli.js queue` при свободной очереди печатает `Очередь тяжёлых задач: свободно (слотов: 1)` и строку `Папка очереди: <dir>`; при занятом слоте – label, pid и время начала; `loudnessCommand('x.mp4').args` содержит `'-vn'` перед `'-af'`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Реализовать.
- [ ] **Step 4:** PASS; затем `npm test` целиком – всё зелёное, кроме известного #76 (если ещё открыт).
- [ ] **Step 5: Commit** `feat: automontage queue status; loudness check skips video decode`

---

### Task 7: Документация и решения

**Files:** `DECISIONS.md` (D-044 «Машинная очередь тяжёлых задач» – отменяет ожидание через опрос `ps` из D-039; D-045 «Слой кодируется один раз, импорт проверенного слоя – переупаковка»), `docs/MOTION-KIT.md` (L121, L560–564, L676–677), `ARCHITECTURE.md` (L829–831, L983), `README.md`, `.env.example` (`AUTOMONTAGE_HEAVY_SLOTS`, `AUTOMONTAGE_HEAVY_DIR`, `AUTOMONTAGE_HEAVY_WAIT_MS`), `TESTING.md` (L886 про `layer-busy.test.js`; хелпер изоляции; новые тесты), `CHANGELOG.md` `[Unreleased]` (в том числе новый смысл `--no-wait`), `AGENTS.md` (таблица команд: `automontage queue`), навыки `skills/reel-turnkey/SKILL.md`, `skills/motion-reel/SKILL.md`, `skills/reel-from-donor/SKILL.md` (L221 «ждёт свободную машину»), `skills/reel-turnkey/references/motion-layer-brief.md` (L151 `--no-wait`): тяжёлые команды – в фоне; при ожидании смотреть `automontage queue`.

- [ ] **Step 1:** Внести правки; `grep -rn "жду 30 с\|раз в 30 с\|busy.js\|свободную машину" README.md ARCHITECTURE.md TESTING.md AGENTS.md docs skills --exclude-dir=superpowers` → пусто.
- [ ] **Step 2:** `node scripts/check-release.js` → `release check passed`.
- [ ] **Step 3: Commit** `docs: heavy queue and single-encode layer pipeline`

---

### Task 8: Приёмка на живом ролике

- [ ] **Step 1:** Временная копия готового проекта 1080p (`projects/<дата>_bench-queue/`, с `motion-vNN/src`, без `renders/`; та же, что для эталона), машина без других рендеров.
- [ ] **Step 2:** `time automontage layer render …`, `time automontage layer import …`, `time automontage preview …`. Ориентиры по спецификации: слой ≈ 6–6,5 мин (было 7:40), импорт ≤ 1 мин (было 2:42), preview ≈ 3–3,5 мин; в выводе импорта – `мастер: переупаковка без перекодирования`.
- [ ] **Step 3:** Два `layer render` разных проектов одновременно: второй печатает `очередь тяжёлых задач занята: layer render …` и стартует после первого; `uptime` во время рендера < 12.
- [ ] **Step 4:** `automontage queue`, запущенный из Claude Code и из Codex, показывает одну и ту же `Папку очереди` (иначе – задать `AUTOMONTAGE_HEAVY_DIR` в общем env и записать это в README).
- [ ] **Step 5:** Контрольные кадры preview: субтитры, вставки, цвет кожи не отличаются от прежнего preview того же ролика.
- [ ] **Step 6:** Замеры – в Issue и в `knowledge/montage-speed-audit-2026-10-02.md`; Issue → «Проверка». Временную папку удалить с согласия владельца.
