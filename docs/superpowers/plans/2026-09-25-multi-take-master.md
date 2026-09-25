# Multi-take Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** собрать один ролик из лучших кусков нескольких дублей: импорт и локальная расшифровка дублей, компактная сводка фраз для выбора, `edit/vNN-takes.json` и `automontage master`, который выпускает новую immutable source revision.

**Architecture:** дубли становятся зарегистрированными файлами проекта (`project.json.takes`), а выбор кусков – ещё одним видом входа для существующей data-boundary `automontage master` (D-021). Склейка идёт одним FFmpeg filter graph с несколькими входами, границы выравниваются по кадрам, публикация переиспользует ту же транзакцию, что и обычный source-edit. Всё после master (draft, Review, preview, approval, final) не меняется.

**Tech Stack:** Node.js 20 CommonJS, Ajv (JSON Schema draft-07), FFmpeg/FFprobe 6.x-9.x, локальный faster-whisper через `scripts/transcribe.py`, Node test runner.

**Идея взята из:** `browser-use/video-use` (MIT): упакованная сводка фраз дублей и бриф «лучший дубль на смысловой блок». Их склейщик не переносится (см. «Факты», пункт F6).

---

## Что получит пользователь

Пользователь присылает три дубля одного Reels. Агент создаёт проект из первого файла,
командой `automontage takes add` добавляет остальные и локально расшифровывает все,
читает сводку `automontage takes pack`, выбирает лучший дубль для каждого смыслового блока,
сохраняет выбор в `edit/v02-takes.json` и собирает `automontage master`. Дальше обычный маршрут:
draft, preview, в пакете согласования таблица «блок → дубль → причина», утверждение, final.

## Факты, на которых построен план

Каждый пункт проверен чтением кода или реальным запуском 2026-09-25.

- **F1. Текущий `automontage master` не работает на FFmpeg 9.** `scripts/trim-media.js:64`
  передаёт `-filter_complex_script`. FFmpeg 9.0.1 (Homebrew `ffmpeg` и `ffmpeg-full`) отвечает
  `Unrecognized option 'filter_complex_script'` и exit 8. Замена `-/filter_complex <file>` работает
  на 9.0.1 и 7.1.5; синтаксис `-/opt <path>` появился в FFmpeg 7.0 (FFmpeg Changelog, раздел
  `version 7.0`). CI ставит FFmpeg из apt на `ubuntu-latest` (6.x) и 7.1.1 через choco на Windows,
  поэтому CI поломку не видит. Та же функция `runTrim()` используется в `tighten.js` и
  `cut-pauses.js`.
- **F2. Поворот.** `probeVideo()` возвращает закодированный размер (для файла с поворотом 90° –
  1280x720), а FFmpeg автоматически поворачивает кадр перед фильтрами (вход приходит как 720x1280).
  Поэтому проверка `outputProbe.width !== sourceProbe.width` в `build-master.js:256` отклонит
  вертикальный исходник с метаданными поворота. `probeOpenedMedia()` отдаёт `rotation`,
  `hasAudio`, `audioSampleRate`, `audioChannels`, `videoDurationSec`, `audioDurationSec`.
- **F3. Несовместимые дубли.** Опыт с одним filter graph и несколькими `-i`:
  другой размер кадра, другой поворот и отсутствие звука – FFmpeg падает (exit 234);
  другой FPS (30 или 29.97 рядом с 25) – FFmpeg молча выдаёт файл с переменным FPS и ошибками
  `non monotonically increasing dts`; другой sample rate или mono – FFmpeg сам вставляет
  `aresample`. С `fps=<rate>` и `aformat=...` в цепочке каждого куска все эти случаи дают
  точные 25/1, одинаковую длину видео и звука и чистое декодирование.
- **F4. Длина куска в целых кадрах обязательна.** Если длина куска не кратна кадру, видео
  округляется вверх до кадра, а звук остаётся точным: 8 кусков дали видео 6.28 с при звуке 6.20 с.
  То же уже верно для одного входа. Поэтому границы выравниваются по кадрам до склейки.
- **F5. Ненулевой `start_time`.** Без `-copyts` FFmpeg сдвигает все потоки на `start_time`
  контейнера (самый ранний поток), `trim` считает время от него. Извлечение звука для Whisper
  (`build-commands.js:29-34`) даёт ту же ось, поэтому слова и `trim` согласованы. Сдвиг
  `setpts=PTS-STARTPTS` перед `trim` звук не меняет и видео сдвигает на кадр – не добавлять.
- **F6. Почему не склейщик video-use.** Их `render.py` извлекает каждый кусок отдельным ffmpeg и
  склеивает `-c copy`. В их открытых PR описаны последствия: накопление рассинхрона звука и видео
  (#62, до -570 мс на 37 кусках), дрейф субтитров (#161), щелчки AAC на каждом стыке (#162).
  Один filter graph с одним перекодированием этих проблем не имеет. Проверки EDL у них нет.
- **F7. Манифест строгий.** `schema/project.schema.json` имеет `additionalProperties:false` на
  верхнем уровне и в `source.history[]`; новое поле `takes` без правки схемы отклоняется.
  Все писатели манифеста делают полную копию (`structuredClone` или JSON-копия), поле не теряется.
- **F8. Готовой JS-функции «расшифровать видео в JSON» нет.** `build.js` вызывает
  `audioExtractionCommand()` + `scripts/transcribe.py <wav> <json> <model>`; формат результата –
  массив `{start,end,text,words:[{w,s,e}]}`; `collectWords()` из `tighten.js` проверяет слова.
- **F9. Кадровые хелперы.** `scripts/review/media-time.js` экспортирует `frameRateFromFps`,
  `secondsToFrame(seconds, rate, 'floor'|'ceil'|'round')`, `frameToSeconds`; 29.97/23.976/59.94
  переводятся в точные дроби.
- **F10. Ограничения публичного репозитория.** `scripts/check-release.js` отклоняет длинное тире
  U+2014 в изменённых публичных текстах; `check-public-privacy.js` отклоняет абсолютные личные
  пути и медиа без записи в `ASSETS.md`. Тестовые медиа генерируются через lavfi во временной папке.

## Глобальные ограничения

- Формат `edit/vNN-source.json` и его поведение не меняются.
- Дубли поддерживаются только для `projectKind: video`.
- Никаких provider API: Whisper, FFmpeg и выбор дублей работают локально по подписке.
- В публичных файлах нет длинного тире U+2014 и абсолютных личных путей.
- FFmpeg 6.x, 7.x и 9.x должны проходить одинаковые тесты.
- Каждая задача заканчивается коммитом в ветке `feat/multi-take-master`. Push и PR только по
  явной просьбе владельца. Pre-commit hook (privacy + Gitleaks) не обходить.
- На macOS с Homebrew полный `npm test` запускать как
  `PATH="/opt/homebrew/opt/ffmpeg-full/bin:$PATH" npm test` (без этого B-roll тесты зависают).

## Слияние с параллельной работой

- Ветка стартует от `origin/main` и не зависит от других открытых веток (на момент плана это
  `feat/pult-rolikov` в папке `../AutoMontage-Agent-pult`).
- Первой в `main` вливается ветка, которая готова раньше, через PR с зелёным CI. Вторая перед своим
  PR выполняет `git fetch origin && git merge origin/main`, разрешает конфликты и заново прогоняет
  полный `npm test`.
- Ожидаемые конфликты с `feat/pult-rolikov` (её план меняет те же файлы) и правило разрешения –
  **оставить обе стороны**:
  - `scripts/cli.js`: оба блока маршрутизации стоят между `master` и `review`; справка содержит
    строки обеих команд;
  - `package.json`: разные скрипты (`test:video-edit` здесь, `test:review-ui` там);
  - `CHANGELOG.md`: пункты обеих веток в `[Unreleased]`;
  - `DECISIONS.md`: записи идут подряд с уникальными номерами (см. Task 13 Step 7);
  - `README.md`, `ARCHITECTURE.md`, `TESTING.md`, `skills/reel-turnkey/SKILL.md`: оба текста.
- Локальная память проекта (`MEMORY.md`, `memory/`) не версионируется и живёт только в основной
  папке `../AutoMontage-Agent/`; записи о работе делаются туда, а не в worktree.

## Карта файлов

**Новые модули**

- `scripts/project/source-revision.js` – общая публикация source revision и помощники, вынесенные из `build-master.js`.
- `scripts/project/takes.js` – описание и совместимость дублей, локальная расшифровка, `addTakes()`.
- `scripts/project/takes-pack.js` – группировка слов во фразы и Markdown-сводка.
- `scripts/project/takes-edit.js` – проверка `edit/vNN-takes.json`, выравнивание по кадрам, пересчёт слов, план входов.
- `scripts/project/build-takes-master.js` – сборка master из дублей.
- `scripts/project/takes-cli.js` – `automontage takes add|pack`.
- `schema/takes-edit.schema.json` – контракт выбора дублей.
- `skills/reel-turnkey/references/takes-selection.md` – маршрут и бриф выбора дублей для агента.

**Изменяемые файлы**

- `scripts/trim-media.js` – опция filter script по версии FFmpeg, склейка нескольких входов.
- `scripts/media-probe.js` – `displayDimensions()`, `probeMediaPath()`.
- `scripts/project/build-master.js` – вынос публикации, учёт поворота, dispatch на дубли.
- `schema/project.schema.json`, `scripts/project/workspace.js` – поле `takes`.
- `scripts/cli.js`, `package.json` – команда `takes`, справка, быстрый набор тестов.
- `skills/reel-turnkey/SKILL.md`, `references/brief-package.md`, `references/qa-checklist.md`, `evals/evals.json`.
- `README.md`, `docs/TEMPLATES.md`, `docs/MONTAGE-GUIDE.md`, `docs/REVIEW-WORKBENCH.md`, `ARCHITECTURE.md`, `TESTING.md`, `DECISIONS.md`, `CHANGELOG.md`.

**Тесты**

- Изменить: `tests/trimming-security.test.js`, `tests/source-edit.test.js`, `tests/cli.test.js`.
- Создать: `tests/trim-media-real.test.js`, `tests/media-display.test.js`,
  `tests/project-takes-manifest.test.js`, `tests/project-takes.test.js`, `tests/takes-pack.test.js`,
  `tests/takes-edit.test.js`, `tests/takes-master.test.js`, `tests/takes-cli.test.js`,
  `tests/takes-master-media.test.js`.

---

### Task 0: Отдельная рабочая папка от свежего main и базовая проверка

**Files:** нет изменений кода.

Параллельная разработка идёт в других папках (`git worktree list`). Эта задача работает только в
своей папке `../AutoMontage-Agent-takes` на ветке `feat/multi-take-master`, созданной от `origin/main`,
и не опирается на другие незавершённые ветки.

- [ ] **Step 1: Создать worktree** (пропустить, если `git worktree list` уже показывает
  `AutoMontage-Agent-takes` с веткой `feat/multi-take-master`)

```bash
# из основной папки проекта, где лежит незакоммиченный план
git fetch origin
git worktree add --no-track -b feat/multi-take-master ../AutoMontage-Agent-takes origin/main
mv docs/superpowers/plans/2026-09-25-multi-take-master.md ../AutoMontage-Agent-takes/docs/superpowers/plans/
cd ../AutoMontage-Agent-takes
npm ci
```

Expected: `git worktree list` показывает новую папку; `git config core.hooksPath` равен `.githooks`.
Все следующие команды плана выполняются из `../AutoMontage-Agent-takes`.

- [ ] **Step 2: Закоммитить план в ветку**

```bash
git add docs/superpowers/plans/2026-09-25-multi-take-master.md
git commit -m "docs: add multi-take master plan"
```

Expected: `git status --short` пуст.

- [ ] **Step 3: Зафиксировать базовое состояние**

```bash
npm run test:video-edit
node --test tests/trimming-security.test.js tests/project-workspace.test.js
ffmpeg -hide_banner -version | head -1
```

Expected: оба набора PASS; версия FFmpeg записана в заметки выполнения (нужна для Task 1).

---

### Task 1: FFmpeg 7+ читает filter script через `-/filter_complex` (исправление F1)

**Files:**
- Modify: `scripts/trim-media.js`
- Modify: `tests/trimming-security.test.js`
- Create: `tests/trim-media-real.test.js`

- [ ] **Step 1: Обновить импорт и существующую проверку argv в `tests/trimming-security.test.js`**

Заменить блок импорта `trim-media`:

```js
const {
  buildConcatFilter,
  detectFilterScriptOption,
  filterScriptOptionForVersion,
  runTrim,
  trimCommand,
} = require('../scripts/trim-media');
```

В тесте `trim command keeps hostile input, output and filter paths as literal argv` заменить
`command.args.indexOf('-filter_complex_script')` на `command.args.indexOf('-/filter_complex')`.

- [ ] **Step 2: Добавить падающие unit-тесты в конец `tests/trimming-security.test.js`**

```js
test('ffmpeg 7+ and unversioned builds read filter scripts through -/filter_complex', () => {
  for (const banner of [
    'ffmpeg version 9.0.1 Copyright (c) 2000-2026 the FFmpeg developers',
    'ffmpeg version 7.1.1-full_build-www.gyan.dev Copyright (c) 2000-2025',
    'ffmpeg version n7.0.2 Copyright (c) 2000-2024',
    'ffmpeg version N-118123-g0123456789 Copyright (c) 2000-2026',
  ]) {
    assert.equal(filterScriptOptionForVersion(banner), '-/filter_complex', banner);
  }
  for (const banner of [
    'ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023',
    'ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright (c) 2000-2021',
  ]) {
    assert.equal(filterScriptOptionForVersion(banner), '-filter_complex_script', banner);
  }
});

test('runTrim passes the detected filter script option to ffmpeg', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-trim-option-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  runTrim({
    input: path.join(dir, 'in.mp4'),
    output: path.join(dir, 'out.mp4'),
    intervals: [[0, 1]],
    filterPath: path.join(dir, 'filter.txt'),
  }, {
    run(command, args) { calls.push(args); },
    detectOption: () => '-filter_complex_script',
  });
  assert.equal(calls[0].includes('-filter_complex_script'), true);
  assert.equal(calls[0].includes('-/filter_complex'), false);
  assert.equal(
    detectFilterScriptOption({ capture: () => 'ffmpeg version 9.0.1 Copyright' }),
    '-/filter_complex',
  );
  assert.equal(
    detectFilterScriptOption({ capture: () => { throw new Error('ENOENT'); } }),
    '-/filter_complex',
  );
});
```

- [ ] **Step 3: Создать регрессионный тест с настоящим FFmpeg `tests/trim-media-real.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  ffmpegEncoderAvailable,
  runTool: runFixture,
  toolAvailable,
} = require('./helpers/media-fixtures');
const { runTrim } = require('../scripts/trim-media');

test('real runTrim encodes with the installed ffmpeg major version', { timeout: 120_000 }, (t) => {
  if (!toolAvailable('ffmpeg') || !toolAvailable('ffprobe') || !ffmpegEncoderAvailable('libx264')) {
    t.skip('real trim requires ffmpeg, ffprobe and libx264');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-trim-real-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'input.mp4');
  const output = path.join(dir, 'output.mp4');
  runFixture('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', input,
  ], dir);

  runTrim({ input, output, intervals: [[0.2, 1], [1.6, 2.4]], audioFadeSec: 0.04, precision: 6 });

  const probe = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', output,
  ], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  assert.ok(Math.abs(Number(probe.stdout) - 1.6) < 0.1, probe.stdout);
});
```

- [ ] **Step 4: Убедиться, что тесты падают**

Run: `node --test tests/trimming-security.test.js tests/trim-media-real.test.js`
Expected: FAIL `filterScriptOptionForVersion is not a function`; на FFmpeg 9 реальный тест падает
с ошибкой стадии `trim encode` (exit 8); на FFmpeg 6/7 реальный тест проходит.

- [ ] **Step 5: Реализовать выбор опции в `scripts/trim-media.js`**

Заменить строку импорта `process`:

```js
const { captureTool, hostPath, runTool } = require('./process');

const MODERN_FILTER_SCRIPT_OPTION = '-/filter_complex';
const LEGACY_FILTER_SCRIPT_OPTION = '-filter_complex_script';
```

Заменить функции `trimCommand` и `runTrim` (от `function trimCommand` до конца `runTrim`) на:

```js
// FFmpeg 7.0 добавил синтаксис `-/option <file>`, а FFmpeg 9 удалил `-filter_complex_script`.
// Сборки без номера версии (git master) новее 7.0, поэтому получают современную форму.
function filterScriptOptionForVersion(versionOutput) {
  const match = /^ffmpeg version n?(\d+)\./m.exec(String(versionOutput || ''));
  if (match && Number(match[1]) < 7) return LEGACY_FILTER_SCRIPT_OPTION;
  return MODERN_FILTER_SCRIPT_OPTION;
}

function detectFilterScriptOption({ capture = captureTool } = {}) {
  try {
    return filterScriptOptionForVersion(capture('ffmpeg', ['-hide_banner', '-version'], {
      stage: 'ffmpeg version',
      maxBuffer: 1024 * 1024,
    }));
  } catch (_) {
    // Сам запуск ffmpeg ниже сообщит понятную ошибку об отсутствии инструмента.
    return MODERN_FILTER_SCRIPT_OPTION;
  }
}

function trimCommand(input, output, filterPath, {
  filterScriptOption = MODERN_FILTER_SCRIPT_OPTION,
} = {}) {
  if (![MODERN_FILTER_SCRIPT_OPTION, LEGACY_FILTER_SCRIPT_OPTION].includes(filterScriptOption)) {
    throw new Error('неизвестная опция filter script для ffmpeg');
  }
  return {
    command: 'ffmpeg',
    args: [
      '-y',
      '-i', hostPath(input),
      filterScriptOption, hostPath(filterPath),
      '-map', '[vout]',
      '-map', '[aout]',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-c:a', 'aac',
      hostPath(output),
    ],
  };
}

function runTrim({
  input,
  output,
  intervals,
  audioFadeSec = 0,
  precision = null,
  filterPath = path.join(os.tmpdir(), `automontage-trim-${randomUUID()}.txt`),
}, {
  fileSystem = fs,
  run = runTool,
  filterScriptOption = null,
  detectOption = detectFilterScriptOption,
} = {}) {
  const filter = buildConcatFilter(intervals, { audioFadeSec, precision });
  const resolvedFilterPath = hostPath(filterPath);
  try {
    fileSystem.writeFileSync(resolvedFilterPath, filter);
    const command = trimCommand(input, output, resolvedFilterPath, {
      filterScriptOption: filterScriptOption || detectOption(),
    });
    run(command.command, command.args, { stage: 'trim encode' });
    return command;
  } finally {
    if (fileSystem.existsSync(resolvedFilterPath)) fileSystem.unlinkSync(resolvedFilterPath);
  }
}
```

Заменить `module.exports`:

```js
module.exports = {
  LEGACY_FILTER_SCRIPT_OPTION,
  MODERN_FILTER_SCRIPT_OPTION,
  buildConcatFilter,
  detectFilterScriptOption,
  filterScriptOptionForVersion,
  runTrim,
  trimCommand,
  validateIntervals,
};
```

- [ ] **Step 6: Проверить**

Run: `node --test tests/trimming-security.test.js tests/trim-media-real.test.js tests/source-edit.test.js`
Expected: PASS. Если локально установлен FFmpeg 7 (`/opt/homebrew/opt/ffmpeg@7/bin`), дополнительно:
`PATH="/opt/homebrew/opt/ffmpeg@7/bin:$PATH" node --test tests/trim-media-real.test.js` → PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/trim-media.js tests/trimming-security.test.js tests/trim-media-real.test.js
git commit -m "fix: pass ffmpeg filter scripts through -/filter_complex on ffmpeg 7+"
```

---

### Task 2: Склейка кусков из нескольких входов в `trim-media.js`

**Files:**
- Modify: `scripts/trim-media.js`
- Modify: `tests/trimming-security.test.js`

- [ ] **Step 1: Добавить характеризационный тест текущей строки фильтра** (проходит до рефакторинга)

Добавить в конец `tests/trimming-security.test.js`:

```js
test('single-input concat filter keeps its exact published shape', () => {
  assert.equal(
    buildConcatFilter([[0, 1], [2, 3]], { audioFadeSec: 0.04, precision: 6 }),
    '[0:v]trim=0.000000:1.000000,setpts=PTS-STARTPTS[v0];'
      + '[0:a]atrim=0.000000:1.000000,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.04,afade=t=out:st=0.960000:d=0.04[a0];'
      + '[0:v]trim=2.000000:3.000000,setpts=PTS-STARTPTS[v1];'
      + '[0:a]atrim=2.000000:3.000000,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.04,afade=t=out:st=0.960000:d=0.04[a1];'
      + '[v0][v1]concat=n=2:v=1:a=0[vout];[a0][a1]concat=n=2:v=0:a=1[aout]',
  );
});
```

Run: `node --test tests/trimming-security.test.js` → PASS (фиксирует поведение до изменения).

- [ ] **Step 2: Добавить падающие тесты нескольких входов**

Заменить блок импорта `trim-media` на:

```js
const {
  buildConcatFilter,
  buildSegmentsConcatFilter,
  detectFilterScriptOption,
  filterScriptCommand,
  filterScriptOptionForVersion,
  runSegmentsTrim,
  runTrim,
  trimCommand,
} = require('../scripts/trim-media');
```

Добавить в конец файла:

```js
test('multi-input filter normalizes FPS and audio format per segment', () => {
  assert.equal(
    buildSegmentsConcatFilter([
      { input: 1, start: 0.5, end: 2.5 },
      { input: 0, start: 1, end: 3 },
    ], {
      inputCount: 2,
      audioFadeSec: 0.04,
      precision: 6,
      fps: '25/1',
      audioFormat: { sampleRate: 48000, channelLayout: 'stereo' },
    }),
    '[1:v]trim=0.500000:2.500000,setpts=PTS-STARTPTS,fps=25/1[v0];'
      + '[1:a]atrim=0.500000:2.500000,asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,'
      + 'afade=t=in:st=0:d=0.04,afade=t=out:st=1.960000:d=0.04[a0];'
      + '[0:v]trim=1.000000:3.000000,setpts=PTS-STARTPTS,fps=25/1[v1];'
      + '[0:a]atrim=1.000000:3.000000,asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,'
      + 'afade=t=in:st=0:d=0.04,afade=t=out:st=1.960000:d=0.04[a1];'
      + '[v0][v1]concat=n=2:v=1:a=0[vout];[a0][a1]concat=n=2:v=0:a=1[aout]',
  );
});

test('multi-input filter rejects unknown inputs and filter injection', () => {
  const segment = [{ input: 0, start: 0, end: 1 }];
  assert.throws(() => buildSegmentsConcatFilter([{ input: 2, start: 0, end: 1 }], { inputCount: 2 }), /входн/);
  assert.throws(() => buildSegmentsConcatFilter([{ input: 0, start: 1, end: 1 }], { inputCount: 1 }), /end > start/);
  assert.throws(() => buildSegmentsConcatFilter([], { inputCount: 1 }), /сегмент/);
  assert.throws(() => buildSegmentsConcatFilter(segment, { inputCount: 1, fps: '25;[0:v]null' }), /FPS/);
  assert.throws(() => buildSegmentsConcatFilter(segment, {
    inputCount: 1, audioFormat: { sampleRate: 48000, channelLayout: '5.1' },
  }), /mono или stereo/);
  assert.throws(() => buildSegmentsConcatFilter(segment, {
    inputCount: 1, audioFormat: { sampleRate: '48000,volume=9', channelLayout: 'stereo' },
  }), /sample rate/);
});

test('multi-input command keeps every hostile input path as literal argv', () => {
  const first = path.join(os.tmpdir(), hostile, 'take-01.mp4');
  const second = path.join(os.tmpdir(), hostile, 'take-02.mov');
  const filter = path.join(os.tmpdir(), hostile, 'filter.txt');
  const output = path.join(os.tmpdir(), hostile, 'out.mp4');
  const command = filterScriptCommand([first, second], output, filter, {
    filterScriptOption: '-/filter_complex',
  });
  assert.deepEqual(command.args.slice(0, 7), [
    '-y', '-i', path.resolve(first), '-i', path.resolve(second), '-/filter_complex', path.resolve(filter),
  ]);
  assert.equal(command.args.at(-1), path.resolve(output));
  assert.throws(() => filterScriptCommand([], output, filter), /входной файл/);
});

test('runSegmentsTrim removes its filter script after a failed encode', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-segments-cleanup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filterPath = path.join(dir, 'filter.txt');
  const stages = [];
  assert.throws(() => runSegmentsTrim({
    inputs: [path.join(dir, 'a.mp4'), path.join(dir, 'b.mp4')],
    output: path.join(dir, 'out.mp4'),
    segments: [{ input: 1, start: 0, end: 1 }, { input: 0, start: 0, end: 1 }],
    filterPath,
  }, {
    run(command, args, options) { stages.push(options.stage); throw new Error('encode failed'); },
    detectOption: () => '-/filter_complex',
  }), /encode failed/);
  assert.deepEqual(stages, ['takes encode']);
  assert.equal(fs.existsSync(filterPath), false);
});
```

Run: `node --test tests/trimming-security.test.js`
Expected: FAIL `buildSegmentsConcatFilter is not a function`.

- [ ] **Step 3: Заменить `scripts/trim-media.js` целиком на итоговую версию**

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { finiteNumber } = require('./build-options');
const { captureTool, hostPath, runTool } = require('./process');

const MODERN_FILTER_SCRIPT_OPTION = '-/filter_complex';
const LEGACY_FILTER_SCRIPT_OPTION = '-filter_complex_script';
const FILTER_RATE = /^[1-9]\d{0,9}\/[1-9]\d{0,9}$/;
const CHANNEL_LAYOUTS = new Set(['mono', 'stereo']);

function validateIntervals(intervals) {
  if (!Array.isArray(intervals) || intervals.length === 0) {
    throw new Error('нужен хотя бы один keep-интервал');
  }
  let previousEnd = -1;
  return intervals.map((interval) => {
    if (!Array.isArray(interval) || interval.length !== 2) {
      throw new Error('keep-интервал должен содержать start и end');
    }
    const start = Number(interval[0]);
    const end = Number(interval[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new Error('keep-интервал должен быть конечным и иметь end > start >= 0');
    }
    if (start < previousEnd) throw new Error('keep-интервалы пересекаются');
    previousEnd = end;
    return [start, end];
  });
}

function validateSegments(segments, inputCount) {
  if (!Number.isSafeInteger(inputCount) || inputCount < 1) {
    throw new Error('нужен хотя бы один входной файл');
  }
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('нужен хотя бы один сегмент');
  }
  return segments.map((segment) => {
    const input = Number(segment?.input);
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    if (!Number.isSafeInteger(input) || input < 0 || input >= inputCount) {
      throw new Error('сегмент ссылается на несуществующий входной файл');
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new Error('сегмент должен быть конечным и иметь end > start >= 0');
    }
    return { input, start, end };
  });
}

function time(value, precision) {
  return precision == null ? String(value) : value.toFixed(precision);
}

function buildSegmentsConcatFilter(segments, {
  inputCount = 1,
  audioFadeSec = 0,
  precision = null,
  fps = null,
  audioFormat = null,
} = {}) {
  const list = validateSegments(segments, inputCount);
  const fade = finiteNumber(audioFadeSec, 'audio fade', { min: 0, max: 1 });
  if (fps !== null && !FILTER_RATE.test(String(fps))) {
    throw new Error('FPS для склейки должен быть дробью вида 30000/1001');
  }
  if (audioFormat !== null) {
    if (typeof audioFormat.sampleRate !== 'number') {
      throw new Error('audio sample rate должен быть числом');
    }
    finiteNumber(audioFormat.sampleRate, 'audio sample rate', { min: 8000, max: 384000, integer: true });
    if (!CHANNEL_LAYOUTS.has(audioFormat.channelLayout)) {
      throw new Error('раскладка каналов должна быть mono или stereo');
    }
  }
  let filter = '';
  let videoInputs = '';
  let audioInputs = '';
  list.forEach(({ input, start, end }, index) => {
    const startText = time(start, precision);
    const endText = time(end, precision);
    filter += `[${input}:v]trim=${startText}:${endText},setpts=PTS-STARTPTS`;
    if (fps !== null) filter += `,fps=${fps}`;
    filter += `[v${index}];`;
    filter += `[${input}:a]atrim=${startText}:${endText},asetpts=PTS-STARTPTS`;
    if (audioFormat !== null) {
      filter += `,aformat=sample_rates=${audioFormat.sampleRate}:channel_layouts=${audioFormat.channelLayout}`;
    }
    if (fade > 0) {
      const fadeOutStart = Math.max(0, end - start - fade);
      filter += `,afade=t=in:st=0:d=${fade},afade=t=out:st=${time(fadeOutStart, precision)}:d=${fade}`;
    }
    filter += `[a${index}];`;
    videoInputs += `[v${index}]`;
    audioInputs += `[a${index}]`;
  });
  return `${filter}${videoInputs}concat=n=${list.length}:v=1:a=0[vout];${audioInputs}concat=n=${list.length}:v=0:a=1[aout]`;
}

function buildConcatFilter(intervals, {
  audioFadeSec = 0,
  precision = null,
} = {}) {
  const keep = validateIntervals(intervals);
  return buildSegmentsConcatFilter(
    keep.map(([start, end]) => ({ input: 0, start, end })),
    { inputCount: 1, audioFadeSec, precision },
  );
}

// FFmpeg 7.0 добавил синтаксис `-/option <file>`, а FFmpeg 9 удалил `-filter_complex_script`.
// Сборки без номера версии (git master) новее 7.0, поэтому получают современную форму.
function filterScriptOptionForVersion(versionOutput) {
  const match = /^ffmpeg version n?(\d+)\./m.exec(String(versionOutput || ''));
  if (match && Number(match[1]) < 7) return LEGACY_FILTER_SCRIPT_OPTION;
  return MODERN_FILTER_SCRIPT_OPTION;
}

function detectFilterScriptOption({ capture = captureTool } = {}) {
  try {
    return filterScriptOptionForVersion(capture('ffmpeg', ['-hide_banner', '-version'], {
      stage: 'ffmpeg version',
      maxBuffer: 1024 * 1024,
    }));
  } catch (_) {
    // Сам запуск ffmpeg ниже сообщит понятную ошибку об отсутствии инструмента.
    return MODERN_FILTER_SCRIPT_OPTION;
  }
}

function filterScriptCommand(inputs, output, filterPath, {
  filterScriptOption = MODERN_FILTER_SCRIPT_OPTION,
} = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error('нужен хотя бы один входной файл');
  }
  if (![MODERN_FILTER_SCRIPT_OPTION, LEGACY_FILTER_SCRIPT_OPTION].includes(filterScriptOption)) {
    throw new Error('неизвестная опция filter script для ffmpeg');
  }
  return {
    command: 'ffmpeg',
    args: [
      '-y',
      ...inputs.flatMap((input) => ['-i', hostPath(input)]),
      filterScriptOption, hostPath(filterPath),
      '-map', '[vout]',
      '-map', '[aout]',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-c:a', 'aac',
      hostPath(output),
    ],
  };
}

function trimCommand(input, output, filterPath, options = {}) {
  return filterScriptCommand([input], output, filterPath, options);
}

function defaultFilterPath() {
  return path.join(os.tmpdir(), `automontage-trim-${randomUUID()}.txt`);
}

function runFilterScript({ inputs, output, filter, filterPath, stage }, {
  fileSystem = fs,
  run = runTool,
  filterScriptOption = null,
  detectOption = detectFilterScriptOption,
} = {}) {
  const resolvedFilterPath = hostPath(filterPath);
  try {
    fileSystem.writeFileSync(resolvedFilterPath, filter);
    const command = filterScriptCommand(inputs, output, resolvedFilterPath, {
      filterScriptOption: filterScriptOption || detectOption(),
    });
    run(command.command, command.args, { stage });
    return command;
  } finally {
    if (fileSystem.existsSync(resolvedFilterPath)) fileSystem.unlinkSync(resolvedFilterPath);
  }
}

function runTrim({
  input,
  output,
  intervals,
  audioFadeSec = 0,
  precision = null,
  filterPath = defaultFilterPath(),
}, dependencies = {}) {
  const filter = buildConcatFilter(intervals, { audioFadeSec, precision });
  return runFilterScript({
    inputs: [input], output, filter, filterPath, stage: 'trim encode',
  }, dependencies);
}

function runSegmentsTrim({
  inputs,
  output,
  segments,
  audioFadeSec = 0,
  precision = null,
  fps = null,
  audioFormat = null,
  filterPath = defaultFilterPath(),
}, dependencies = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error('нужен хотя бы один входной файл');
  }
  const filter = buildSegmentsConcatFilter(segments, {
    inputCount: inputs.length, audioFadeSec, precision, fps, audioFormat,
  });
  return runFilterScript({
    inputs, output, filter, filterPath, stage: 'takes encode',
  }, dependencies);
}

module.exports = {
  LEGACY_FILTER_SCRIPT_OPTION,
  MODERN_FILTER_SCRIPT_OPTION,
  buildConcatFilter,
  buildSegmentsConcatFilter,
  detectFilterScriptOption,
  filterScriptCommand,
  filterScriptOptionForVersion,
  runSegmentsTrim,
  runTrim,
  trimCommand,
  validateIntervals,
};
```

- [ ] **Step 4: Проверить**

Run: `node --test tests/trimming-security.test.js tests/trim-media-real.test.js tests/source-edit.test.js`
Expected: PASS, включая характеризационный тест из Step 1 без изменений.

- [ ] **Step 5: Commit**

```bash
git add scripts/trim-media.js tests/trimming-security.test.js
git commit -m "feat: concat trimmed segments from several ffmpeg inputs"
```

---

### Task 3: Размер кадра с учётом поворота и probe по пути

**Files:**
- Modify: `scripts/media-probe.js`
- Create: `tests/media-display.test.js`

- [ ] **Step 1: Написать падающие тесты `tests/media-display.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { toolAvailable } = require('./helpers/media-fixtures');
const { displayDimensions, probeMediaPath } = require('../scripts/media-probe');

test('quarter-turn rotation swaps displayed dimensions', () => {
  assert.deepEqual(displayDimensions({ width: 1920, height: 1080, rotation: 90 }), { width: 1080, height: 1920 });
  assert.deepEqual(displayDimensions({ width: 1920, height: 1080, rotation: 270 }), { width: 1080, height: 1920 });
  assert.deepEqual(displayDimensions({ width: 1920, height: 1080, rotation: 180 }), { width: 1920, height: 1080 });
  assert.deepEqual(displayDimensions({ width: 1920, height: 1080 }), { width: 1920, height: 1080 });
});

test('probeMediaPath passes an opened descriptor and closes it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-probe-path-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'clip.mp4');
  fs.writeFileSync(file, 'MEDIA');
  let seen = null;
  const result = probeMediaPath(file, {
    stage: 'take probe',
    probeOpenedMediaImpl({ fileDescriptor, stage }) {
      seen = { fileDescriptor, stage };
      return { width: 1, height: 2, rotation: 0 };
    },
  });
  assert.deepEqual(result, { width: 1, height: 2, rotation: 0 });
  assert.equal(seen.stage, 'take probe');
  assert.throws(() => fs.fstatSync(seen.fileDescriptor), /EBADF/);
  if (process.platform !== 'win32') {
    const link = path.join(dir, 'link.mp4');
    fs.symlinkSync(file, link);
    assert.throws(
      () => probeMediaPath(link, { probeOpenedMediaImpl: () => ({}) }),
      /symbolic link/,
    );
  }
});

test('real rotated clip reports displayed portrait dimensions', { timeout: 60_000 }, (t) => {
  if (!toolAvailable('ffmpeg') || !toolAvailable('ffprobe')) {
    t.skip('rotation probe requires ffmpeg and ffprobe');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-rotation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = path.join(dir, 'base.mp4');
  const rotated = path.join(dir, 'rotated.mp4');
  const encode = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=0.4', '-pix_fmt', 'yuv420p', base], { encoding: 'utf8' });
  assert.equal(encode.status, 0, encode.stderr);
  const rotate = spawnSync('ffmpeg', ['-y', '-v', 'error', '-display_rotation', '90', '-i', base, '-c', 'copy', rotated], { encoding: 'utf8' });
  if (rotate.status !== 0) {
    t.skip('ffmpeg lacks -display_rotation fixture support');
    return;
  }
  const media = probeMediaPath(rotated, { stage: 'rotation probe' });
  assert.equal(media.rotation, 90);
  assert.deepEqual(displayDimensions(media), { width: 90, height: 160 });
});
```

Run: `node --test tests/media-display.test.js`
Expected: FAIL `displayDimensions is not a function`.

- [ ] **Step 2: Реализовать в `scripts/media-probe.js`**

Добавить первой строкой файла:

```js
const fs = require('node:fs');
```

Добавить перед `module.exports`:

```js
function displayDimensions({ width, height, rotation = 0 }) {
  return rotation === 90 || rotation === 270
    ? { width: height, height: width }
    : { width, height };
}

function probeMediaPath(filePath, {
  stage = 'media probe',
  fileSystem = fs,
  probeOpenedMediaImpl = probeOpenedMedia,
} = {}) {
  const resolved = hostPath(filePath);
  const stat = fileSystem.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${stage}: media must be a regular file, not a symbolic link`);
  }
  const descriptor = fileSystem.openSync(resolved, openReadOnlyFlags(fileSystem));
  try {
    return probeOpenedMediaImpl({ fileDescriptor: descriptor, stage });
  } finally {
    fileSystem.closeSync(descriptor);
  }
}
```

В `module.exports` добавить `displayDimensions` (перед `fileSystemCapabilities`) и `probeMediaPath` (перед `probeOpenedAudio`), сохранив алфавитный порядок.

- [ ] **Step 3: Проверить**

Run: `node --test tests/media-display.test.js tests/opened-media-probe.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/media-probe.js tests/media-display.test.js
git commit -m "feat: probe media by path with rotation-aware display size"
```

---

### Task 4: Общая публикация source revision и учёт поворота в master (исправление F2)

**Files:**
- Create: `scripts/project/source-revision.js`
- Modify: `scripts/project/build-master.js` (итоговое содержимое ниже)
- Modify: `tests/source-edit.test.js`

- [ ] **Step 1: Подготовить существующие тесты и добавить падающий регрессионный тест**

В `tests/source-edit.test.js` в оба вызова `buildMaster` (тесты `master publication preserves...` и
`failed master encode...`) добавить в объект зависимостей после `probeVideoImpl`:

```js
    probeMediaPathImpl() {
      return { width: 1920, height: 1080, rotation: 0 };
    },
```

Добавить в конец файла:

```js
test('master accepts an auto-rotated portrait source whose output is stored upright', (t) => {
  const fixture = makeProject(t);
  const result = buildMaster({
    projectDir: fixture.workspace.dir,
    editPath: fixture.editPath,
  }, {
    runTrimImpl(options) {
      fs.writeFileSync(options.output, 'ROTATED-MASTER');
    },
    runToolImpl() {},
    probeVideoImpl(filename) {
      return filename.endsWith('source.mp4')
        ? { duration: 8, fps: 25, width: 1920, height: 1080 }
        : { duration: 6, fps: 25, width: 1080, height: 1920 };
    },
    probeMediaPathImpl() {
      return { width: 1920, height: 1080, rotation: 90 };
    },
    now: () => new Date('2026-08-23T13:00:00.000Z'),
    temporaryId: () => 'rotated-master',
  });
  assert.equal(result.revision, 2);
  assert.equal(readProjectManifest(fixture.workspace.dir).source.localPath, 'input/source-v02.mp4');
});
```

Run: `node --test tests/source-edit.test.js`
Expected: FAIL только новый тест: `master output does not match the source edit`.

- [ ] **Step 2: Создать `scripts/project/source-revision.js`**

Функции от `roundedTime` до `normalizeSourceMetadata` переносятся из `build-master.js` без изменений;
`publishSourceRevision` – это бывшая вторая половина `buildMaster` с параметрами.

```js
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { probeVideo } = require('../media-probe');
const { runTool } = require('../process');
const { resolveProjectPath, withProjectMutation } = require('./workspace');

const SAFE_TOKEN = /^[A-Za-z0-9_-]+$/;

function roundedTime(value, fps) {
  const precision = Math.max(3, Math.ceil(Math.log10(fps || 1)) + 2);
  return Number(value.toFixed(precision));
}

function remapTranscriptWords(words, keepRanges, fps) {
  if (!Array.isArray(words) || !Array.isArray(keepRanges) || !keepRanges.length) {
    throw new Error('transcript remap requires words and keep ranges');
  }
  const ranges = keepRanges.map(({ start, end }) => ({ start: Number(start), end: Number(end) }));
  const prefix = [];
  let kept = 0;
  for (const range of ranges) {
    prefix.push(kept);
    kept += range.end - range.start;
  }
  const mapped = [];
  for (const word of words) {
    const start = Number(word.s);
    const end = Number(word.e);
    const overlaps = ranges
      .map((range, index) => ({
        index,
        start: Math.max(start, range.start),
        end: Math.min(end, range.end),
      }))
      .filter((overlap) => overlap.end > overlap.start);
    if (!overlaps.length) continue;
    const first = overlaps[0];
    const last = overlaps.at(-1);
    const mappedStart = prefix[first.index] + first.start - ranges[first.index].start;
    const mappedEnd = prefix[last.index] + last.end - ranges[last.index].start;
    mapped.push({
      ...word,
      s: roundedTime(mappedStart, fps),
      e: roundedTime(mappedEnd, fps),
    });
  }
  return mapped.sort((left, right) => left.s - right.s || left.e - right.e);
}

function projectRelative(projectDir, target) {
  const relative = path.relative(projectDir, path.resolve(target));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw new Error('master path must stay inside the project workspace');
  }
  return relative.split(path.sep).join('/');
}

function safeToken(temporaryId) {
  const value = String(temporaryId());
  if (!SAFE_TOKEN.test(value)) throw new Error('master temporary id is unsafe');
  return value;
}

function statRegular(fileSystem, target) {
  const stat = fileSystem.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('master stage must be a regular file');
  return stat;
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function removeOwned(fileSystem, target, expected) {
  try {
    const current = fileSystem.lstatSync(target);
    if (!current.isSymbolicLink() && current.isFile() && sameIdentity(current, expected)) {
      fileSystem.unlinkSync(target);
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

function fsyncFile(fileSystem, target) {
  const descriptor = fileSystem.openSync(target, 'r+');
  try {
    const stat = fileSystem.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('master stage must be a regular file');
    fileSystem.fsyncSync(descriptor);
    return stat;
  } finally {
    fileSystem.closeSync(descriptor);
  }
}

function writeExclusiveStage(fileSystem, target, bytes) {
  const descriptor = fileSystem.openSync(target, 'wx', 0o600);
  try {
    fileSystem.writeFileSync(descriptor, bytes);
    fileSystem.fsyncSync(descriptor);
    return fileSystem.fstatSync(descriptor);
  } finally {
    fileSystem.closeSync(descriptor);
  }
}

function normalizeSourceMetadata(source) {
  return {
    ...source,
    originalLocalPath: source.originalLocalPath || source.localPath,
    revision: Number.isSafeInteger(source.revision) ? source.revision : 1,
    history: Array.isArray(source.history) ? source.history : [],
  };
}

function publishSourceRevision({
  workspace,
  source,
  editRelative,
  words,
  duration,
  fps,
  expected,
  encode,
}, {
  fileSystem = fs,
  runToolImpl = runTool,
  probeVideoImpl = probeVideo,
  now = () => new Date(),
  temporaryId = randomUUID,
} = {}) {
  const nextRevision = source.revision + 1;
  const suffix = `v${String(nextRevision).padStart(2, '0')}`;
  const sourceRelative = `input/source-${suffix}.mp4`;
  const transcriptRelative = `transcript/words-${suffix}.json`;
  const destination = resolveProjectPath(workspace.dir, sourceRelative, {
    label: 'master revision path', fileSystem, mustExist: false, type: 'file',
  });
  const transcriptDestination = resolveProjectPath(workspace.dir, transcriptRelative, {
    label: 'master transcript path', fileSystem, mustExist: false, type: 'file',
  });
  if (fileSystem.existsSync(destination) || fileSystem.existsSync(transcriptDestination)) {
    throw new Error('master revision already exists');
  }
  const transcriptBytes = Buffer.from(`${JSON.stringify([{
    start: 0,
    end: roundedTime(duration, fps),
    text: words.map((word) => word.w).join(' '),
    words,
  }], null, 2)}\n`);
  const token = safeToken(temporaryId);
  const sourceStage = resolveProjectPath(workspace.dir, `input/.source-${suffix}-${token}.tmp.mp4`, {
    label: 'master source stage', fileSystem, mustExist: false, type: 'file',
  });
  const transcriptStage = resolveProjectPath(
    workspace.dir,
    `transcript/.words-${suffix}-${token}.tmp.json`,
    { label: 'master transcript stage', fileSystem, mustExist: false, type: 'file' },
  );
  let sourceStageIdentity = null;
  let transcriptStageIdentity = null;
  let sourceCommittedIdentity = null;
  let transcriptCommittedIdentity = null;
  try {
    return withProjectMutation(workspace, (transaction) => {
      const active = normalizeSourceMetadata(transaction.manifest.source);
      if (active.revision !== source.revision || active.localPath !== source.localPath) {
        throw new Error('source revision changed before master publication');
      }
      encode(sourceStage);
      sourceStageIdentity = fsyncFile(fileSystem, sourceStage);
      runToolImpl('ffmpeg', ['-v', 'error', '-i', sourceStage, '-f', 'null', '-'], {
        stage: 'master decode',
      });
      const outputProbe = probeVideoImpl(sourceStage, { stage: 'master output probe' });
      if (Math.abs(outputProbe.duration - duration) > Math.max(0.08, 1 / fps)
        || Math.abs(outputProbe.fps - fps) > 1e-6
        || outputProbe.width !== expected.width || outputProbe.height !== expected.height) {
        throw new Error('master output does not match the source edit');
      }
      transcriptStageIdentity = writeExclusiveStage(fileSystem, transcriptStage, transcriptBytes);
      fileSystem.linkSync(sourceStage, destination);
      sourceCommittedIdentity = statRegular(fileSystem, destination);
      fileSystem.linkSync(transcriptStage, transcriptDestination);
      transcriptCommittedIdentity = statRegular(fileSystem, transcriptDestination);

      const entry = {
        revision: nextRevision,
        localPath: sourceRelative,
        editPath: editRelative,
        transcriptPath: transcriptRelative,
      };
      const nextManifest = structuredClone(transaction.manifest);
      nextManifest.source = {
        ...active,
        localPath: sourceRelative,
        revision: nextRevision,
        history: [...active.history, entry],
      };
      nextManifest.transcript.words = transcriptRelative;
      nextManifest.currentPreview = null;
      nextManifest.updatedAt = now().toISOString();
      workspace.manifest = transaction.commitManifest(nextManifest, { purpose: 'master-manifest' });
      return {
        revision: nextRevision,
        sourcePath: destination,
        transcriptPath: transcriptDestination,
      };
    }, { fileSystem, temporaryId });
  } catch (error) {
    if (transcriptCommittedIdentity) removeOwned(fileSystem, transcriptDestination, transcriptCommittedIdentity);
    if (sourceCommittedIdentity) removeOwned(fileSystem, destination, sourceCommittedIdentity);
    throw error;
  } finally {
    if (transcriptStageIdentity) removeOwned(fileSystem, transcriptStage, transcriptStageIdentity);
    if (sourceStageIdentity) removeOwned(fileSystem, sourceStage, sourceStageIdentity);
  }
}

module.exports = {
  fsyncFile,
  normalizeSourceMetadata,
  projectRelative,
  publishSourceRevision,
  remapTranscriptWords,
  removeOwned,
  roundedTime,
  safeToken,
  sameIdentity,
  statRegular,
  writeExclusiveStage,
};
```

- [ ] **Step 3: Заменить `scripts/project/build-master.js` на итоговую версию этой задачи**

```js
#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Ajv = require('ajv');

const sourceEditSchema = require('../../schema/source-edit.schema.json');
const { configureMediaToolPath } = require('../env');
const { displayDimensions, probeMediaPath, probeVideo } = require('../media-probe');
const { runTool } = require('../process');
const { collectWords } = require('../tighten');
const { runTrim } = require('../trim-media');
const {
  normalizeSourceMetadata,
  projectRelative,
  publishSourceRevision,
  remapTranscriptWords,
  roundedTime,
} = require('./source-revision');
const { readProjectManifest, resolveProjectPath } = require('./workspace');

const validateSchema = new Ajv({ allErrors: true }).compile(sourceEditSchema);

function formatSchemaError(error) {
  const suffix = error.keyword === 'required' ? `.${error.params.missingProperty}` : '';
  return `source edit${error.instancePath || ''}${suffix}: ${error.message}`;
}

function isFrameBoundary(value, fps) {
  return Math.abs((value * fps) - Math.round(value * fps)) <= 1e-6;
}

function validateSourceEdit(edit, { sourceRevision, sourceDuration } = {}) {
  if (!validateSchema(edit)) {
    throw new Error((validateSchema.errors || []).map(formatSchemaError).join('\n'));
  }
  if (!Number.isSafeInteger(sourceRevision) || edit.sourceRevision !== sourceRevision) {
    throw new Error('source edit revision does not match the active source revision');
  }
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) {
    throw new Error('source duration is invalid');
  }
  let previousEnd = -1;
  for (const [index, range] of edit.keep.entries()) {
    if (range.end <= range.start) throw new Error(`keep[${index}] must have end > start`);
    if (range.start < previousEnd) throw new Error(`keep[${index}] overlaps the previous range`);
    if (range.end > sourceDuration + 1e-6) {
      throw new Error(`keep[${index}] exceeds source duration`);
    }
    if (!isFrameBoundary(range.start, edit.fps) || !isFrameBoundary(range.end, edit.fps)) {
      throw new Error(`keep[${index}] must use exact frame boundaries`);
    }
    previousEnd = range.end;
  }
  return structuredClone(edit);
}

function resolveRequestedEdit(workspace, requested, fileSystem) {
  const stored = path.isAbsolute(requested) ? projectRelative(workspace.dir, requested) : requested;
  return resolveProjectPath(workspace.dir, stored, {
    label: 'source edit path', fileSystem, mustExist: true, type: 'file',
  });
}

function buildMaster({ projectDir, editPath }, dependencies = {}) {
  const fileSystem = dependencies.fileSystem || fs;
  const runTrimImpl = dependencies.runTrimImpl || runTrim;
  const probeVideoImpl = dependencies.probeVideoImpl || probeVideo;
  const probeMediaPathImpl = dependencies.probeMediaPathImpl || probeMediaPath;
  const publishDependencies = {
    fileSystem,
    runToolImpl: dependencies.runToolImpl || runTool,
    probeVideoImpl,
    now: dependencies.now || (() => new Date()),
    temporaryId: dependencies.temporaryId || randomUUID,
  };
  const resolvedProjectDir = path.resolve(projectDir || '');
  if (!projectDir || !editPath) throw new Error('master requires --project-dir and --edit');
  const manifest = readProjectManifest(resolvedProjectDir);
  const workspace = { dir: resolvedProjectDir, manifest };
  const editAbsolute = resolveRequestedEdit(workspace, editPath, fileSystem);
  const edit = JSON.parse(fileSystem.readFileSync(editAbsolute, 'utf8'));
  const editRelative = projectRelative(workspace.dir, editAbsolute);
  const source = normalizeSourceMetadata(manifest.source);
  const sourcePath = resolveProjectPath(workspace.dir, source.localPath, {
    label: 'active source path', fileSystem, mustExist: true, type: 'file',
  });
  const sourceProbe = probeVideoImpl(sourcePath, { stage: 'master source probe' });
  const normalizedEdit = validateSourceEdit(edit, {
    sourceRevision: source.revision,
    sourceDuration: sourceProbe.duration,
  });
  if (Math.abs(sourceProbe.fps - normalizedEdit.fps) > 1e-6) {
    throw new Error('source edit FPS does not match the active source');
  }
  const transcriptPath = resolveProjectPath(workspace.dir, manifest.transcript.words, {
    label: 'active transcript path', fileSystem, mustExist: true, type: 'file',
  });
  const words = collectWords(JSON.parse(fileSystem.readFileSync(transcriptPath, 'utf8')));
  const remapped = remapTranscriptWords(words, normalizedEdit.keep, normalizedEdit.fps);
  const duration = normalizedEdit.keep.reduce((sum, range) => sum + range.end - range.start, 0);
  // FFmpeg поворачивает кадр до фильтров, поэтому результат хранится в отображаемом размере.
  const sourceMedia = probeMediaPathImpl(sourcePath, { stage: 'master source media probe' });
  const result = publishSourceRevision({
    workspace,
    source,
    editRelative,
    words: remapped,
    duration,
    fps: normalizedEdit.fps,
    expected: displayDimensions(sourceMedia),
    encode(output) {
      runTrimImpl({
        input: sourcePath,
        output,
        intervals: normalizedEdit.keep.map(({ start, end }) => [start, end]),
        audioFadeSec: 0.04,
        precision: 6,
      });
    },
  }, publishDependencies);
  return {
    ...result,
    kind: 'source',
    duration: roundedTime(duration, normalizedEdit.fps),
    removedDuration: roundedTime(sourceProbe.duration - duration, normalizedEdit.fps),
  };
}

function parseMasterOptions(argv) {
  const options = { projectDir: null, editPath: null };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    if (key === '--project-dir') options.projectDir = value;
    else if (key === '--edit') options.editPath = value;
    else throw new Error(`unknown master option: ${key}`);
  }
  if (!options.projectDir || !options.editPath) {
    throw new Error('master requires --project-dir and --edit');
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  try {
    configureMediaToolPath();
    const result = buildMaster(parseMasterOptions(argv));
    console.log(`✅ source revision: ${result.revision}`);
    console.log(`   duration: ${result.duration.toFixed(2)} sec`);
    console.log(`   removed: ${result.removedDuration.toFixed(2)} sec`);
    console.log(`   transcript: ${result.transcriptPath}`);
  } catch (error) {
    console.error(`❌ master отменён: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  buildMaster,
  main,
  parseMasterOptions,
  remapTranscriptWords,
  validateSourceEdit,
};
```

- [ ] **Step 4: Проверить**

Run: `node --test tests/source-edit.test.js tests/trimming-security.test.js tests/project-workspace.test.js tests/project-mutation-transaction.test.js`
Expected: PASS, включая новый тест поворота.

- [ ] **Step 5: Commit**

```bash
git add scripts/project/source-revision.js scripts/project/build-master.js tests/source-edit.test.js
git commit -m "fix: share source revision publication and accept rotated master sources"
```

---

### Task 5: Поле `takes` в манифесте проекта

**Files:**
- Modify: `schema/project.schema.json`
- Modify: `scripts/project/workspace.js` (функция `validateProjectManifest`)
- Create: `tests/project-takes-manifest.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createOrOpenProject,
  validateProjectManifest,
} = require('../scripts/project/workspace');

test('manifest accepts registered takes and rejects duplicates, bad ids and escaping paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-takes-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'take1.mp4');
  fs.writeFileSync(source, 'TAKE');
  const workspace = createOrOpenProject({
    projectDir: path.join(root, 'project'),
    name: 'Takes manifest',
    sourcePath: source,
    now: new Date('2026-09-25T10:00:00.000Z'),
  });
  const take = (overrides = {}) => ({
    id: 'take-01',
    originalPath: source,
    localPath: 'input/source.mp4',
    transcriptPath: 'transcript/takes/take-01.json',
    ...overrides,
  });
  const withTakes = (takes) => ({ ...structuredClone(workspace.manifest), takes });
  const options = { projectDir: workspace.dir };

  assert.deepEqual(validateProjectManifest(withTakes([
    take(),
    take({ id: 'take-02', localPath: 'input/takes/take-02.mov', transcriptPath: 'transcript/takes/take-02.json' }),
  ]), options).takes.map((item) => item.id), ['take-01', 'take-02']);
  assert.throws(() => validateProjectManifest(withTakes([take(), take()]), options), /unique/);
  assert.throws(() => validateProjectManifest(withTakes([take({ id: 'take-1' })]), options), /takes\/0\/id/);
  assert.throws(
    () => validateProjectManifest(withTakes([take({ localPath: '../escape.mp4' })]), options),
    /canonical relative path/,
  );
  assert.throws(
    () => validateProjectManifest(withTakes([take({ extra: true })]), options),
    /additional properties/,
  );
});
```

Run: `node --test tests/project-takes-manifest.test.js`
Expected: FAIL `manifest.takes: must NOT have additional properties`.

- [ ] **Step 2: Добавить схему** – в `schema/project.schema.json` перед строкой `    "briefs": {` вставить:

```json
    "takes": {
      "type": "array",
      "maxItems": 99,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "originalPath", "localPath", "transcriptPath"],
        "properties": {
          "id": {"type": "string", "pattern": "^take-(0[1-9]|[1-9][0-9])$"},
          "originalPath": {"type": "string", "minLength": 1},
          "localPath": {"$ref": "#/definitions/projectPath"},
          "transcriptPath": {"$ref": "#/definitions/projectPath"}
        }
      }
    },
```

- [ ] **Step 3: Добавить проверки в `validateProjectManifest`** (`scripts/project/workspace.js`)

Сразу после проверки `manifest.latestRender must match ...` и перед `if (!projectDir) return migratedManifest;`:

```js
  const takeIds = (migratedManifest.takes || []).map((take) => take.id);
  if (new Set(takeIds).size !== takeIds.length) {
    throw new Error('manifest.takes ids must be unique');
  }
```

Сразу после цикла `migratedManifest.source.history.forEach(...)` и перед `for (const [label, storedPath] of paths)`:

```js
  (migratedManifest.takes || []).forEach((take, index) => {
    paths.push(
      [`manifest.takes[${index}].localPath`, take.localPath],
      [`manifest.takes[${index}].transcriptPath`, take.transcriptPath],
    );
  });
```

- [ ] **Step 4: Проверить**

Run: `node --test tests/project-takes-manifest.test.js tests/project-workspace.test.js tests/project-build-context.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add schema/project.schema.json scripts/project/workspace.js tests/project-takes-manifest.test.js
git commit -m "feat: register project takes in the manifest"
```

---

### Task 6: Импорт и локальная расшифровка дублей `addTakes()`

**Files:**
- Create: `scripts/project/takes.js`
- Create: `tests/project-takes.test.js`

- [ ] **Step 1: Написать падающие тесты `tests/project-takes.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { addTakes } = require('../scripts/project/takes');
const {
  createOrOpenProject,
  readProjectManifest,
} = require('../scripts/project/workspace');

function media(overrides = {}) {
  return {
    mediaKind: 'video',
    width: 1920,
    height: 1080,
    rotation: 0,
    hasAudio: true,
    audioSampleRate: 48000,
    audioChannels: 2,
    videoDurationSec: 10,
    audioDurationSec: 10,
    ...overrides,
  };
}

function makeProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-takes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, 'take1.mp4');
  const second = path.join(root, 'take2.MOV');
  fs.writeFileSync(original, 'TAKE-ONE');
  fs.writeFileSync(second, 'TAKE-TWO');
  const workspace = createOrOpenProject({
    projectDir: path.join(root, 'project'),
    name: 'Takes',
    sourcePath: original,
    now: new Date('2026-09-25T10:00:00.000Z'),
  });
  return { root, original, second, dir: workspace.dir };
}

function fakes(overrides = {}) {
  const transcribed = [];
  return {
    transcribed,
    deps: {
      probeVideoImpl: () => ({ width: 1920, height: 1080, fps: 25, duration: 10 }),
      probeMediaPathImpl: () => media(),
      transcribeImpl({ videoPath }) {
        transcribed.push(path.basename(videoPath));
        return [{ start: 0, end: 1, text: 'слово', words: [{ w: 'слово', s: 0.2, e: 0.6 }] }];
      },
      now: () => new Date('2026-09-25T11:00:00.000Z'),
      temporaryId: () => 'takes-test',
      ...overrides,
    },
  };
}

test('takes add registers the original as take-01 and copies new takes without touching the source', (t) => {
  const fixture = makeProject(t);
  const { deps, transcribed } = fakes();
  const result = addTakes({ projectDir: fixture.dir, files: [fixture.second] }, deps);
  const manifest = readProjectManifest(fixture.dir);

  assert.deepEqual(manifest.takes, [
    {
      id: 'take-01',
      originalPath: fixture.original,
      localPath: 'input/source.mp4',
      transcriptPath: 'transcript/takes/take-01.json',
    },
    {
      id: 'take-02',
      originalPath: fixture.second,
      localPath: 'input/takes/take-02.mov',
      transcriptPath: 'transcript/takes/take-02.json',
    },
  ]);
  assert.deepEqual(result.takes.map((take) => take.id), ['take-01', 'take-02']);
  assert.deepEqual(transcribed, ['source.mp4', 'take-02.mov']);
  assert.equal(fs.readFileSync(path.join(fixture.dir, 'input', 'takes', 'take-02.mov'), 'utf8'), 'TAKE-TWO');
  assert.equal(fs.readFileSync(fixture.second, 'utf8'), 'TAKE-TWO');
  assert.equal(manifest.source.localPath, 'input/source.mp4');
  assert.equal(manifest.source.revision, 1);
  assert.equal(JSON.parse(fs.readFileSync(
    path.join(fixture.dir, 'transcript', 'takes', 'take-02.json'), 'utf8',
  ))[0].words[0].w, 'слово');
});

test('a second takes add appends without re-transcribing registered takes', (t) => {
  const fixture = makeProject(t);
  addTakes({ projectDir: fixture.dir, files: [fixture.second] }, fakes().deps);
  const third = path.join(fixture.root, 'take3.mp4');
  fs.writeFileSync(third, 'TAKE-THREE');
  const { deps, transcribed } = fakes();
  addTakes({ projectDir: fixture.dir, files: [third] }, deps);
  assert.deepEqual(readProjectManifest(fixture.dir).takes.map((take) => take.id), ['take-01', 'take-02', 'take-03']);
  assert.deepEqual(transcribed, ['take-03.mp4']);
});

test('incompatible takes are rejected before anything is copied', (t) => {
  const fixture = makeProject(t);
  for (const [label, overrides, pattern] of [
    ['fps', { probeVideoImpl: (file) => ({ width: 1920, height: 1080, fps: file.endsWith('take2.MOV') ? 30 : 25, duration: 10 }) }, /FPS/],
    ['size', { probeMediaPathImpl: (file) => (file.endsWith('take2.MOV') ? media({ width: 1280, height: 720 }) : media()) }, /frame size/],
    ['audio', { probeMediaPathImpl: (file) => (file.endsWith('take2.MOV') ? media({ hasAudio: false, audioSampleRate: null, audioChannels: null, audioDurationSec: null }) : media()) }, /no usable audio/],
  ]) {
    assert.throws(() => addTakes({ projectDir: fixture.dir, files: [fixture.second] }, fakes(overrides).deps), pattern, label);
    assert.equal(readProjectManifest(fixture.dir).takes, undefined, label);
    assert.equal(fs.existsSync(path.join(fixture.dir, 'input', 'takes', 'take-02.mov')), false, label);
  }
});

test('a rotated take with the same displayed size is compatible', (t) => {
  const fixture = makeProject(t);
  const { deps } = fakes({
    probeMediaPathImpl: (file) => (file.endsWith('take2.MOV')
      ? media({ width: 1080, height: 1920, rotation: 90 })
      : media()),
  });
  addTakes({ projectDir: fixture.dir, files: [fixture.second] }, deps);
  assert.equal(readProjectManifest(fixture.dir).takes.length, 2);
});

test('failed transcription removes copied files and leaves the manifest unchanged', (t) => {
  const fixture = makeProject(t);
  const { deps } = fakes({
    transcribeImpl({ videoPath }) {
      if (videoPath.endsWith('take-02.mov')) throw new Error('whisper failed');
      return [{ start: 0, end: 1, text: 'слово', words: [{ w: 'слово', s: 0.2, e: 0.6 }] }];
    },
  });
  assert.throws(() => addTakes({ projectDir: fixture.dir, files: [fixture.second] }, deps), /whisper failed/);
  assert.equal(readProjectManifest(fixture.dir).takes, undefined);
  assert.equal(fs.existsSync(path.join(fixture.dir, 'input', 'takes', 'take-02.mov')), false);
  assert.equal(fs.existsSync(path.join(fixture.dir, 'transcript', 'takes', 'take-01.json')), false);
});

test('takes are refused for motion-reel projects and missing files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-takes-motion-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const narration = path.join(root, 'narration.wav');
  fs.writeFileSync(narration, 'NARRATION');
  const motion = createOrOpenProject({
    projectDir: path.join(root, 'motion'),
    name: 'Motion takes',
    sourcePath: narration,
    projectKind: 'motion-reel',
  });
  assert.throws(() => addTakes({ projectDir: motion.dir, files: [narration] }, fakes().deps), /only for video projects/);

  const fixture = makeProject(t);
  assert.throws(
    () => addTakes({ projectDir: fixture.dir, files: [path.join(fixture.root, 'missing.mp4')] }, fakes().deps),
    /take file not found/,
  );
});
```

Run: `node --test tests/project-takes.test.js`
Expected: FAIL `Cannot find module '../scripts/project/takes'`.

- [ ] **Step 2: Создать `scripts/project/takes.js`**

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { audioExtractionCommand } = require('../build-commands');
const { python } = require('../env');
const { displayDimensions, probeMediaPath, probeVideo } = require('../media-probe');
const { runTool } = require('../process');
const { collectWords } = require('../tighten');
const { removeOwned } = require('./source-revision');
const {
  copyProjectFileNoReplace,
  readProjectManifest,
  resolveProjectPath,
  withProjectMutation,
  writeFilesNoReplace,
} = require('./workspace');

const ROOT = path.resolve(__dirname, '..', '..');
const MAX_TAKES = 99;
const TAKE_EXTENSION = /^\.[a-z0-9]{1,8}$/;

function takeId(number) {
  return `take-${String(number).padStart(2, '0')}`;
}

function describeTake(id, { filePath, video, media }) {
  if (media.mediaKind !== 'video') throw new Error(`${id} must be a video file`);
  const display = displayDimensions(media);
  const durations = [media.videoDurationSec, media.audioDurationSec].filter(Number.isFinite);
  if (!durations.length) throw new Error(`${id} has no measurable duration`);
  return {
    id,
    filePath,
    fps: video.fps,
    width: display.width,
    height: display.height,
    hasAudio: media.hasAudio,
    audioSampleRate: media.audioSampleRate,
    audioChannels: media.audioChannels,
    // Кусок не может быть длиннее самого короткого потока, иначе звук и видео разъедутся.
    duration: Math.min(...durations),
  };
}

// FFmpeg падает на разном размере кадра и отсутствии звука, а разный FPS молча превращает
// результат в файл с переменной частотой кадров. Поэтому несовместимые дубли отклоняются.
function assertCompatibleTakes(takes) {
  if (!takes.length) throw new Error('at least one take is required');
  const [first] = takes;
  for (const take of takes) {
    if (!take.hasAudio || !take.audioSampleRate || !take.audioChannels) {
      throw new Error(`${take.id} has no usable audio stream`);
    }
    if (Math.abs(take.fps - first.fps) > 1e-6) {
      throw new Error(`${take.id} FPS ${take.fps} differs from ${first.id} FPS ${first.fps}`);
    }
    if (take.width !== first.width || take.height !== first.height) {
      throw new Error(`${take.id} frame size ${take.width}x${take.height} differs from `
        + `${first.id} frame size ${first.width}x${first.height}`);
    }
  }
}

function probeTake(id, filePath, { probeVideoImpl, probeMediaPathImpl }) {
  return describeTake(id, {
    filePath,
    video: probeVideoImpl(filePath, { stage: `${id} probe` }),
    media: probeMediaPathImpl(filePath, { stage: `${id} media probe` }),
  });
}

function transcribeTakeFile({ videoPath, model = 'large-v3-turbo', prompt = null }, {
  fileSystem = fs,
  runToolImpl = runTool,
  pythonCommand = null,
} = {}) {
  const directory = fileSystem.mkdtempSync(path.join(os.tmpdir(), 'automontage-take-words-'));
  try {
    const audioPath = path.join(directory, 'audio.wav');
    const wordsPath = path.join(directory, 'words.json');
    const extraction = audioExtractionCommand(videoPath, audioPath);
    runToolImpl(extraction.command, extraction.args, { stage: 'take audio extraction' });
    const args = [path.join(ROOT, 'scripts', 'transcribe.py'), audioPath, wordsPath, model];
    if (prompt) args.push('--prompt', String(prompt));
    runToolImpl(pythonCommand || python(), args, { cwd: ROOT, stage: 'take transcription' });
    const segments = JSON.parse(fileSystem.readFileSync(wordsPath, 'utf8'));
    collectWords(segments);
    return segments;
  } finally {
    fileSystem.rmSync(directory, { recursive: true, force: true });
  }
}

function ensureProjectDirectory(projectDir, relative, fileSystem) {
  const target = resolveProjectPath(projectDir, relative, {
    label: relative, fileSystem, mustExist: false, type: 'directory',
  });
  fileSystem.mkdirSync(target, { recursive: true });
  return resolveProjectPath(projectDir, relative, {
    label: relative, fileSystem, mustExist: true, type: 'directory',
  });
}

function planTakes(manifest, files, fileSystem = fs) {
  const existing = manifest.takes || [];
  const planned = [];
  if (!existing.length) {
    planned.push({
      id: takeId(1),
      originalPath: manifest.source.originalPath,
      localPath: manifest.source.originalLocalPath || manifest.source.localPath,
      copyFrom: null,
    });
  }
  let number = existing.length + planned.length;
  for (const file of files) {
    number += 1;
    if (number > MAX_TAKES) throw new Error(`a project supports at most ${MAX_TAKES} takes`);
    const originalPath = path.resolve(file);
    if (!fileSystem.existsSync(originalPath)) throw new Error(`take file not found: ${originalPath}`);
    const extension = path.extname(originalPath).toLowerCase() || '.mp4';
    if (!TAKE_EXTENSION.test(extension)) throw new Error(`unsupported take extension: ${extension}`);
    planned.push({
      id: takeId(number),
      originalPath,
      localPath: `input/takes/${takeId(number)}${extension}`,
      copyFrom: originalPath,
    });
  }
  return { existing, planned };
}

function addTakes({
  projectDir,
  files,
  model = 'large-v3-turbo',
  prompt = null,
}, dependencies = {}) {
  const fileSystem = dependencies.fileSystem || fs;
  const probes = {
    probeVideoImpl: dependencies.probeVideoImpl || probeVideo,
    probeMediaPathImpl: dependencies.probeMediaPathImpl || probeMediaPath,
  };
  const transcribeImpl = dependencies.transcribeImpl || transcribeTakeFile;
  const now = dependencies.now || (() => new Date());
  const temporaryId = dependencies.temporaryId || randomUUID;
  if (!projectDir) throw new Error('takes add requires --project-dir');
  if (!Array.isArray(files) || !files.length) throw new Error('takes add requires at least one --file');
  const dir = path.resolve(projectDir);
  const manifest = readProjectManifest(dir);
  if ((manifest.projectKind || 'video') !== 'video' || (manifest.source.mediaKind || 'video') !== 'video') {
    throw new Error('takes are supported only for video projects');
  }
  const { existing, planned } = planTakes(manifest, files, fileSystem);
  const referenceEntry = existing[0] || planned[0];
  const referencePath = resolveProjectPath(dir, referenceEntry.localPath, {
    label: `${referenceEntry.id} path`, fileSystem, mustExist: true, type: 'file',
  });
  const reference = probeTake(referenceEntry.id, referencePath, probes);
  const incoming = planned
    .filter((take) => take.copyFrom)
    .map((take) => probeTake(take.id, take.copyFrom, probes));
  assertCompatibleTakes([reference, ...incoming]);
  ensureProjectDirectory(dir, 'input/takes', fileSystem);
  ensureProjectDirectory(dir, 'transcript/takes', fileSystem);

  const workspace = { dir, manifest };
  const created = [];
  try {
    return withProjectMutation(workspace, (transaction) => {
      const current = transaction.manifest.takes || [];
      if (current.length !== existing.length) throw new Error('takes changed before registration');
      const entries = [];
      for (const take of planned) {
        if (take.copyFrom) {
          const copied = copyProjectFileNoReplace({
            projectDir: dir,
            sourcePath: take.copyFrom,
            storedPath: take.localPath,
            fileSystem,
            temporaryId,
          });
          created.push({ target: copied, identity: fileSystem.lstatSync(copied) });
        }
        const videoPath = resolveProjectPath(dir, take.localPath, {
          label: `${take.id} path`, fileSystem, mustExist: true, type: 'file',
        });
        const transcriptRelative = `transcript/takes/${take.id}.json`;
        const transcriptPath = resolveProjectPath(dir, transcriptRelative, {
          label: `${take.id} transcript path`, fileSystem, mustExist: false, type: 'file',
        });
        const segments = transcribeImpl({ videoPath, model, prompt });
        collectWords(segments);
        writeFilesNoReplace([{
          destination: transcriptPath,
          data: `${JSON.stringify(segments, null, 2)}\n`,
          purpose: 'take-words',
        }], { fileSystem, temporaryId });
        created.push({ target: transcriptPath, identity: fileSystem.lstatSync(transcriptPath) });
        entries.push({
          id: take.id,
          originalPath: take.originalPath,
          localPath: take.localPath,
          transcriptPath: transcriptRelative,
        });
      }
      const nextManifest = structuredClone(transaction.manifest);
      nextManifest.takes = [...current, ...entries];
      nextManifest.updatedAt = now().toISOString();
      workspace.manifest = transaction.commitManifest(nextManifest, { purpose: 'takes-manifest' });
      return { takes: entries };
    }, { fileSystem, temporaryId });
  } catch (error) {
    for (const item of [...created].reverse()) removeOwned(fileSystem, item.target, item.identity);
    throw error;
  }
}

module.exports = {
  MAX_TAKES,
  addTakes,
  assertCompatibleTakes,
  describeTake,
  planTakes,
  probeTake,
  takeId,
  transcribeTakeFile,
};
```

- [ ] **Step 3: Проверить**

Run: `node --test tests/project-takes.test.js tests/project-takes-manifest.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/project/takes.js tests/project-takes.test.js
git commit -m "feat: import and locally transcribe project takes"
```

---

### Task 7: Сводка фраз всех дублей `packTakes()`

**Files:**
- Create: `scripts/project/takes-pack.js`
- Create: `tests/takes-pack.test.js`

- [ ] **Step 1: Написать падающие тесты**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { addTakes } = require('../scripts/project/takes');
const {
  formatTakesMarkdown,
  groupIntoPhrases,
  packTakes,
} = require('../scripts/project/takes-pack');
const { createOrOpenProject } = require('../scripts/project/workspace');

test('words group into phrases on pauses of at least the threshold', () => {
  assert.deepEqual(groupIntoPhrases([
    { w: 'Привет', s: 0.5, e: 0.9 },
    { w: 'мир', s: 1.0, e: 1.25 },
    { w: ',', s: 1.25, e: 1.3 },
    { w: 'это', s: 1.8, e: 2.0 },
    { w: 'дубль', s: 2.1, e: 2.4 },
  ], 0.5), [
    { start: 0.5, end: 1.3, text: 'Привет мир,' },
    { start: 1.8, end: 2.4, text: 'это дубль' },
  ]);
  assert.equal(groupIntoPhrases([
    { w: 'раз', s: 0, e: 0.5 },
    { w: 'два', s: 0.99, e: 1.2 },
  ], 0.5).length, 1);
});

test('packed markdown lists every take with fixed-width time ranges', () => {
  assert.equal(formatTakesMarkdown([{
    id: 'take-02',
    phrases: [
      { start: 0.5, end: 1.3, text: 'Привет мир,' },
      { start: 1.8, end: 2.4, text: 'это дубль' },
    ],
  }], 0.5), [
    '# Дубли проекта',
    '',
    'Фразы разделены паузами от 0.5 с. Время указано в секундах от начала файла дубля.',
    'Диапазоны для edit/vNN-takes.json записывай как take + start/end из этих строк.',
    '',
    '## take-02  (речь 1.9 с, фраз: 2)',
    '  [000.50-001.30] Привет мир,',
    '  [001.80-002.40] это дубль',
    '',
  ].join('\n'));
});

test('packTakes reads registered take transcripts from the project', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-takes-pack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'take1.mp4');
  const second = path.join(root, 'take2.mp4');
  fs.writeFileSync(first, 'ONE');
  fs.writeFileSync(second, 'TWO');
  const workspace = createOrOpenProject({ projectDir: path.join(root, 'project'), name: 'Pack', sourcePath: first });
  assert.throws(() => packTakes({ projectDir: workspace.dir }), /takes add/);
  addTakes({ projectDir: workspace.dir, files: [second] }, {
    probeVideoImpl: () => ({ width: 160, height: 90, fps: 25, duration: 3 }),
    probeMediaPathImpl: () => ({
      mediaKind: 'video', width: 160, height: 90, rotation: 0, hasAudio: true,
      audioSampleRate: 48000, audioChannels: 2, videoDurationSec: 3, audioDurationSec: 3,
    }),
    transcribeImpl: () => [{ start: 0, end: 1, text: 'слово', words: [{ w: 'слово', s: 0.2, e: 0.6 }] }],
  });
  const markdown = packTakes({ projectDir: workspace.dir, silence: 0.4 });
  assert.match(markdown, /Фразы разделены паузами от 0\.4 с/);
  assert.match(markdown, /## take-01 {2}\(речь 0\.4 с, фраз: 1\)\n {2}\[000\.20-000\.60\] слово/);
  assert.match(markdown, /## take-02 /);
  assert.throws(() => packTakes({ projectDir: workspace.dir, silence: 9 }), /silence/);
});
```

Run: `node --test tests/takes-pack.test.js`
Expected: FAIL `Cannot find module '../scripts/project/takes-pack'`.

- [ ] **Step 2: Создать `scripts/project/takes-pack.js`**

```js
const fs = require('node:fs');
const path = require('node:path');

const { finiteNumber } = require('../build-options');
const { collectWords } = require('../tighten');
const { readProjectManifest, resolveProjectPath } = require('./workspace');

const SILENCE_EPSILON = 1e-9;

function packTime(seconds) {
  return seconds.toFixed(2).padStart(6, '0');
}

function groupIntoPhrases(words, silence = 0.5) {
  const ordered = [...words].sort((left, right) => left.s - right.s || left.e - right.e);
  const phrases = [];
  let current = null;
  for (const word of ordered) {
    if (current && word.s - current.end >= silence - SILENCE_EPSILON) {
      phrases.push(current);
      current = null;
    }
    if (!current) current = { start: word.s, end: word.e, parts: [] };
    current.parts.push(word.w);
    current.end = Math.max(current.end, word.e);
  }
  if (current) phrases.push(current);
  return phrases.map(({ start, end, parts }) => ({
    start,
    end,
    text: parts.join(' ').replace(/\s+([,.!?;:])/g, '$1'),
  }));
}

function formatTakesMarkdown(entries, silence = 0.5) {
  const lines = [
    '# Дубли проекта',
    '',
    `Фразы разделены паузами от ${silence.toFixed(1)} с. Время указано в секундах от начала файла дубля.`,
    'Диапазоны для edit/vNN-takes.json записывай как take + start/end из этих строк.',
    '',
  ];
  for (const { id, phrases } of entries) {
    const speech = phrases.length ? phrases.at(-1).end - phrases[0].start : 0;
    lines.push(`## ${id}  (речь ${speech.toFixed(1)} с, фраз: ${phrases.length})`);
    for (const phrase of phrases) {
      lines.push(`  [${packTime(phrase.start)}-${packTime(phrase.end)}] ${phrase.text}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function packTakes({ projectDir, silence = 0.5 }, { fileSystem = fs } = {}) {
  if (!projectDir) throw new Error('takes pack requires --project-dir');
  const threshold = finiteNumber(silence, 'silence', { min: 0.1, max: 5 });
  const dir = path.resolve(projectDir);
  const manifest = readProjectManifest(dir);
  const takes = manifest.takes || [];
  if (!takes.length) throw new Error('project has no registered takes; run automontage takes add first');
  const entries = takes.map((take) => {
    const transcriptPath = resolveProjectPath(dir, take.transcriptPath, {
      label: `${take.id} transcript path`, fileSystem, mustExist: true, type: 'file',
    });
    const words = collectWords(JSON.parse(fileSystem.readFileSync(transcriptPath, 'utf8')));
    return { id: take.id, phrases: groupIntoPhrases(words, threshold) };
  });
  return formatTakesMarkdown(entries, threshold);
}

module.exports = {
  formatTakesMarkdown,
  groupIntoPhrases,
  packTakes,
};
```

- [ ] **Step 3: Проверить**

Run: `node --test tests/takes-pack.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/project/takes-pack.js tests/takes-pack.test.js
git commit -m "feat: pack take transcripts into phrase-level markdown"
```

---

### Task 8: Контракт `edit/vNN-takes.json` и чистая логика выбора

**Files:**
- Create: `schema/takes-edit.schema.json`
- Create: `scripts/project/takes-edit.js`
- Create: `tests/takes-edit.test.js`

- [ ] **Step 1: Написать падающие тесты**

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertTakesEditShape,
  isTakesEdit,
  remapTakeRangesTranscript,
  snapTakeRanges,
  takesTrimPlan,
  validateTakeRanges,
} = require('../scripts/project/takes-edit');

function takesEdit(overrides = {}) {
  return {
    version: 1,
    kind: 'takes',
    sourceRevision: 1,
    ranges: [
      { take: 'take-02', start: 1.02, end: 2.51, beat: 'HOOK', reason: 'чистая подача' },
      { take: 'take-01', start: 4, end: 6, beat: 'CTA', reason: 'единственный полный призыв' },
    ],
    ...overrides,
  };
}

const takes = new Map([
  ['take-01', { id: 'take-01', filePath: 'take-01.mp4', duration: 8 }],
  ['take-02', { id: 'take-02', filePath: 'take-02.mov', duration: 5 }],
]);

test('takes edit shape requires kind, reasons, id format and the active revision', () => {
  assert.equal(isTakesEdit(takesEdit()), true);
  assert.equal(isTakesEdit({ version: 1, keep: [] }), false);
  assert.equal(assertTakesEditShape(takesEdit(), { sourceRevision: 1 }).ranges.length, 2);
  const missingReason = takesEdit();
  delete missingReason.ranges[0].reason;
  for (const [label, edit, pattern] of [
    ['kind', takesEdit({ kind: 'source' }), /kind/],
    ['reason', missingReason, /reason/],
    ['id', takesEdit({ ranges: [{ take: 'take-1', start: 0, end: 1, beat: 'HOOK', reason: 'x' }] }), /pattern/],
    ['extra', takesEdit({ fps: 25 }), /additional properties/],
    ['revision', takesEdit({ sourceRevision: 2 }), /revision/],
  ]) {
    assert.throws(() => assertTakesEditShape(edit, { sourceRevision: 1 }), pattern, label);
  }
});

test('take ranges must reference registered takes and stay inside the usable duration', () => {
  assert.doesNotThrow(() => validateTakeRanges(takesEdit().ranges, takes));
  assert.doesNotThrow(() => validateTakeRanges([{ take: 'take-02', start: 4.5, end: 5.2 }], takes));
  assert.throws(() => validateTakeRanges([{ take: 'take-07', start: 0, end: 1 }], takes), /unknown take take-07/);
  assert.throws(() => validateTakeRanges([{ take: 'take-02', start: 2, end: 2 }], takes), /end > start/);
  assert.throws(() => validateTakeRanges([{ take: 'take-02', start: 4, end: 5.3 }], takes), /usable duration/);
  assert.throws(() => validateTakeRanges([{ take: 'take-02', start: 5, end: 5.1 }], takes), /usable duration/);
});

test('ranges snap outward to whole frames and clamp to the take end', () => {
  const snapped = snapTakeRanges([
    ...takesEdit().ranges,
    { take: 'take-02', start: 4.5, end: 5.2, beat: 'TAIL', reason: 'хвост' },
  ], { fps: 25, takes });
  assert.deepEqual(
    snapped.map(({ take, start, end, startFrame, endFrame }) => [take, start, end, startFrame, endFrame]),
    [
      ['take-02', 1, 2.52, 25, 63],
      ['take-01', 4, 6, 100, 150],
      ['take-02', 4.48, 5, 112, 125],
    ],
  );
  assert.equal(snapped[0].reason, 'чистая подача');
});

test('NTSC ranges snap to exact 30000/1001 frame boundaries', () => {
  const [range] = snapTakeRanges(
    [{ take: 'take-01', start: 1, end: 2, beat: 'HOOK', reason: 'x' }],
    { fps: 30000 / 1001, takes },
  );
  assert.deepEqual([range.startFrame, range.endFrame], [29, 60]);
  assert.equal(range.start, 29 * 1001 / 30000);
  assert.equal(range.end, 60 * 1001 / 30000);
});

test('snapped ranges from one take must not overlap and must keep at least one frame', () => {
  assert.throws(() => snapTakeRanges([
    { take: 'take-02', start: 1, end: 2, beat: 'A', reason: 'x' },
    { take: 'take-02', start: 1.99, end: 3, beat: 'B', reason: 'y' },
  ], { fps: 25, takes }), /overlaps ranges\[0\]/);
  const shortTakes = new Map([['take-01', { id: 'take-01', filePath: 'a.mp4', duration: 1.01 }]]);
  assert.throws(() => snapTakeRanges(
    [{ take: 'take-01', start: 1, end: 1.01, beat: 'A', reason: 'x' }],
    { fps: 25, takes: shortTakes },
  ), /one frame/);
  assert.doesNotThrow(() => snapTakeRanges([
    { take: 'take-02', start: 1, end: 2, beat: 'A', reason: 'x' },
    { take: 'take-01', start: 1, end: 2, beat: 'B', reason: 'y' },
  ], { fps: 25, takes }));
});

test('words from each take move onto the assembled timeline', () => {
  const ranges = snapTakeRanges(takesEdit().ranges, { fps: 25, takes });
  const words = remapTakeRangesTranscript(ranges, new Map([
    ['take-02', [{ w: 'привет', s: 1.1, e: 1.5 }, { w: 'лишнее', s: 3, e: 3.4 }]],
    ['take-01', [{ w: 'пока', s: 4.5, e: 5 }, { w: 'хвост', s: 5.9, e: 6.3 }]],
  ]), 25);
  assert.deepEqual(words, [
    { w: 'привет', s: 0.1, e: 0.5 },
    { w: 'пока', s: 2.02, e: 2.52 },
    { w: 'хвост', s: 3.42, e: 3.52 },
  ]);
});

test('trim plan lists each take once in order of first use', () => {
  const ranges = snapTakeRanges([
    ...takesEdit().ranges,
    { take: 'take-02', start: 3, end: 4, beat: 'PROOF', reason: 'z' },
  ], { fps: 25, takes });
  assert.deepEqual(takesTrimPlan(ranges, takes), {
    inputs: ['take-02.mov', 'take-01.mp4'],
    segments: [
      { input: 0, start: 1, end: 2.52 },
      { input: 1, start: 4, end: 6 },
      { input: 0, start: 3, end: 4 },
    ],
  });
});
```

Run: `node --test tests/takes-edit.test.js`
Expected: FAIL `Cannot find module '../scripts/project/takes-edit'`.

- [ ] **Step 2: Создать `schema/takes-edit.schema.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://automontage.local/schema/takes-edit.schema.json",
  "title": "AutoMontage Takes Edit",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "kind", "sourceRevision", "ranges"],
  "properties": {
    "version": {"const": 1},
    "kind": {"const": "takes"},
    "sourceRevision": {"type": "integer", "minimum": 1},
    "ranges": {
      "type": "array",
      "minItems": 1,
      "maxItems": 500,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["take", "start", "end", "beat", "reason"],
        "properties": {
          "take": {"type": "string", "pattern": "^take-(0[1-9]|[1-9][0-9])$"},
          "start": {"type": "number", "minimum": 0},
          "end": {"type": "number", "exclusiveMinimum": 0},
          "beat": {"type": "string", "minLength": 1, "maxLength": 80},
          "quote": {"type": "string", "minLength": 1, "maxLength": 500},
          "reason": {"type": "string", "minLength": 1, "maxLength": 500}
        }
      }
    }
  }
}
```

- [ ] **Step 3: Создать `scripts/project/takes-edit.js`**

```js
const Ajv = require('ajv');

const takesEditSchema = require('../../schema/takes-edit.schema.json');
const { frameRateFromFps, frameToSeconds, secondsToFrame } = require('../review/media-time');
const { remapTranscriptWords, roundedTime } = require('./source-revision');

const validateSchema = new Ajv({ allErrors: true }).compile(takesEditSchema);
// Запас после последнего слова, который агент добавляет по брифу; хвост обрезается по концу дубля.
const MAX_END_OVERRUN_SEC = 0.25;

function formatSchemaError(error) {
  const suffix = error.keyword === 'required' ? `.${error.params.missingProperty}` : '';
  return `takes edit${error.instancePath || ''}${suffix}: ${error.message}`;
}

function isTakesEdit(edit) {
  return Boolean(edit && typeof edit === 'object' && edit.kind === 'takes');
}

function assertTakesEditShape(edit, { sourceRevision } = {}) {
  if (!validateSchema(edit)) {
    throw new Error((validateSchema.errors || []).map(formatSchemaError).join('\n'));
  }
  if (!Number.isSafeInteger(sourceRevision) || edit.sourceRevision !== sourceRevision) {
    throw new Error('takes edit revision does not match the active source revision');
  }
  return structuredClone(edit);
}

function validateTakeRanges(ranges, takes) {
  ranges.forEach((range, index) => {
    const take = takes.get(range.take);
    if (!take) throw new Error(`ranges[${index}] references unknown take ${range.take}`);
    if (range.end <= range.start) throw new Error(`ranges[${index}] must have end > start`);
    if (range.start >= take.duration || range.end > take.duration + MAX_END_OVERRUN_SEC) {
      throw new Error(`ranges[${index}] is outside ${range.take} usable duration ${take.duration}`);
    }
  });
}

// Кусок из нецелого числа кадров удлиняет видео до следующего кадра, а звук остаётся точным.
// Поэтому начало округляется вниз, конец вверх, и оба ограничены последним целым кадром дубля.
function snapTakeRanges(ranges, { fps, takes }) {
  const rate = frameRateFromFps(fps);
  const snapped = ranges.map((range, index) => {
    const take = takes.get(range.take);
    const lastFrame = secondsToFrame(take.duration, rate, 'floor');
    const startFrame = secondsToFrame(range.start, rate, 'floor');
    const endFrame = Math.min(secondsToFrame(range.end, rate, 'ceil'), lastFrame);
    if (endFrame <= startFrame) {
      throw new Error(`ranges[${index}] is shorter than one frame after snapping`);
    }
    return {
      ...range,
      startFrame,
      endFrame,
      start: frameToSeconds(startFrame, rate),
      end: frameToSeconds(endFrame, rate),
    };
  });
  const byTake = new Map();
  snapped.forEach((range, index) => {
    const previous = byTake.get(range.take) || [];
    for (const other of previous) {
      if (range.startFrame < other.range.endFrame && other.range.startFrame < range.endFrame) {
        throw new Error(`ranges[${index}] overlaps ranges[${other.index}] in ${range.take}`);
      }
    }
    previous.push({ range, index });
    byTake.set(range.take, previous);
  });
  return snapped;
}

function remapTakeRangesTranscript(ranges, wordsByTake, fps) {
  const words = [];
  let offset = 0;
  for (const range of ranges) {
    const local = remapTranscriptWords(wordsByTake.get(range.take), [range], fps);
    for (const word of local) {
      words.push({
        ...word,
        s: roundedTime(word.s + offset, fps),
        e: roundedTime(word.e + offset, fps),
      });
    }
    offset += range.end - range.start;
  }
  return words;
}

function takesTrimPlan(ranges, takes) {
  const inputs = [];
  const inputIndex = new Map();
  const segments = ranges.map((range) => {
    if (!inputIndex.has(range.take)) {
      inputIndex.set(range.take, inputs.length);
      inputs.push(takes.get(range.take).filePath);
    }
    return { input: inputIndex.get(range.take), start: range.start, end: range.end };
  });
  return { inputs, segments };
}

module.exports = {
  assertTakesEditShape,
  isTakesEdit,
  remapTakeRangesTranscript,
  snapTakeRanges,
  takesTrimPlan,
  validateTakeRanges,
};
```

- [ ] **Step 4: Проверить**

Run: `node --test tests/takes-edit.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add schema/takes-edit.schema.json scripts/project/takes-edit.js tests/takes-edit.test.js
git commit -m "feat: validate and frame-snap take selections"
```

---

### Task 9: `automontage master` собирает master из дублей

**Files:**
- Create: `scripts/project/build-takes-master.js`
- Modify: `scripts/project/build-master.js`
- Create: `tests/takes-master.test.js`

- [ ] **Step 1: Написать падающие тесты**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildMaster } = require('../scripts/project/build-master');
const { addTakes } = require('../scripts/project/takes');
const {
  createOrOpenProject,
  readProjectManifest,
} = require('../scripts/project/workspace');

function media(overrides = {}) {
  return {
    mediaKind: 'video', width: 1920, height: 1080, rotation: 0, hasAudio: true,
    audioSampleRate: 48000, audioChannels: 2, videoDurationSec: 10, audioDurationSec: 10,
    ...overrides,
  };
}

function setupTakes(t, { register = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-takes-master-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'take1.mp4');
  const second = path.join(root, 'take2.mov');
  fs.writeFileSync(first, 'TAKE-ONE');
  fs.writeFileSync(second, 'TAKE-TWO');
  const workspace = createOrOpenProject({
    projectDir: path.join(root, 'project'),
    name: 'Takes master',
    sourcePath: first,
    now: new Date('2026-09-25T10:00:00.000Z'),
  });
  if (register) {
    const words = {
      'source.mp4': [{ w: 'пока', s: 4.5, e: 5 }, { w: 'хвост', s: 5.9, e: 6.3 }],
      'take-02.mov': [{ w: 'привет', s: 1.1, e: 1.5 }, { w: 'лишнее', s: 3, e: 3.4 }],
    };
    addTakes({ projectDir: workspace.dir, files: [second] }, {
      probeVideoImpl: () => ({ width: 1920, height: 1080, fps: 25, duration: 10 }),
      probeMediaPathImpl: () => media(),
      transcribeImpl: ({ videoPath }) => [{
        start: 0, end: 10, text: 'x', words: words[path.basename(videoPath)],
      }],
      now: () => new Date('2026-09-25T10:30:00.000Z'),
      temporaryId: () => 'takes-setup',
    });
  }
  return { root, dir: workspace.dir };
}

function writeEdit(dir, overrides = {}) {
  const edit = {
    version: 1,
    kind: 'takes',
    sourceRevision: 1,
    ranges: [
      { take: 'take-02', start: 1.02, end: 2.51, beat: 'HOOK', reason: 'самый уверенный хук' },
      { take: 'take-01', start: 4, end: 6, beat: 'CTA', reason: 'единственный полный призыв' },
    ],
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, 'edit', 'v02-takes.json'), `${JSON.stringify(edit, null, 2)}\n`);
  return 'edit/v02-takes.json';
}

function masterDependencies(calls, overrides = {}) {
  return {
    runSegmentsTrimImpl(options) {
      calls.push(['trim', options]);
      fs.writeFileSync(options.output, 'TAKES-MASTER');
    },
    runToolImpl(command, args, options) { calls.push([options.stage]); },
    probeVideoImpl(filename) {
      return path.basename(filename).startsWith('.source-v')
        ? { width: 1920, height: 1080, fps: 25, duration: 3.52 }
        : { width: 1920, height: 1080, fps: 25, duration: 10 };
    },
    probeMediaPathImpl: () => media(),
    now: () => new Date('2026-09-25T11:00:00.000Z'),
    temporaryId: () => 'takes-master',
    ...overrides,
  };
}

test('takes master assembles ranges from several takes into a new immutable source revision', (t) => {
  const fixture = setupTakes(t);
  const editPath = writeEdit(fixture.dir);
  const calls = [];
  const result = buildMaster({ projectDir: fixture.dir, editPath }, masterDependencies(calls));

  const [, trim] = calls[0];
  assert.deepEqual(trim.inputs, [
    path.join(fixture.dir, 'input', 'takes', 'take-02.mov'),
    path.join(fixture.dir, 'input', 'source.mp4'),
  ]);
  assert.deepEqual(trim.segments, [
    { input: 0, start: 1, end: 2.52 },
    { input: 1, start: 4, end: 6 },
  ]);
  assert.equal(trim.fps, '25/1');
  assert.deepEqual(trim.audioFormat, { sampleRate: 48000, channelLayout: 'stereo' });
  assert.equal(trim.audioFadeSec, 0.04);
  assert.equal(calls.some(([stage]) => stage === 'master decode'), true);

  const manifest = readProjectManifest(fixture.dir);
  assert.equal(manifest.source.originalLocalPath, 'input/source.mp4');
  assert.equal(manifest.source.localPath, 'input/source-v02.mp4');
  assert.equal(manifest.source.revision, 2);
  assert.deepEqual(manifest.source.history, [{
    revision: 2,
    localPath: 'input/source-v02.mp4',
    editPath: 'edit/v02-takes.json',
    transcriptPath: 'transcript/words-v02.json',
  }]);
  assert.equal(manifest.transcript.words, 'transcript/words-v02.json');
  assert.equal(manifest.takes.length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(
    path.join(fixture.dir, 'transcript', 'words-v02.json'), 'utf8',
  ))[0].words, [
    { w: 'привет', s: 0.1, e: 0.5 },
    { w: 'пока', s: 2.02, e: 2.52 },
    { w: 'хвост', s: 3.42, e: 3.52 },
  ]);
  assert.equal(result.kind, 'takes');
  assert.equal(result.duration, 3.52);
  assert.deepEqual(result.takes, ['take-02', 'take-01']);
  assert.deepEqual(result.ranges, [
    { take: 'take-02', start: 1, end: 2.52, beat: 'HOOK' },
    { take: 'take-01', start: 4, end: 6, beat: 'CTA' },
  ]);
});

test('takes master rejects stale, unknown, unregistered and incompatible selections', (t) => {
  const fixture = setupTakes(t);
  const before = fs.readFileSync(path.join(fixture.dir, 'project.json'));
  for (const [label, edit, overrides, pattern] of [
    ['stale', { sourceRevision: 2 }, {}, /revision/],
    ['unknown', { ranges: [{ take: 'take-07', start: 0, end: 1, beat: 'HOOK', reason: 'x' }] }, {}, /unknown take take-07/],
    ['size', {}, {
      probeMediaPathImpl: (file) => (file.includes('take-02') ? media({ width: 1280, height: 720 }) : media()),
    }, /frame size/],
  ]) {
    const editPath = writeEdit(fixture.dir, edit);
    assert.throws(() => buildMaster({ projectDir: fixture.dir, editPath }, masterDependencies([], overrides)), pattern, label);
    assert.deepEqual(fs.readFileSync(path.join(fixture.dir, 'project.json')), before, label);
  }

  const empty = setupTakes(t, { register: false });
  const editPath = writeEdit(empty.dir, {
    ranges: [{ take: 'take-01', start: 0, end: 1, beat: 'HOOK', reason: 'x' }],
  });
  assert.throws(() => buildMaster({ projectDir: empty.dir, editPath }, masterDependencies([])), /takes add/);
});

test('failed takes encode leaves the active source and manifest unchanged', (t) => {
  const fixture = setupTakes(t);
  const editPath = writeEdit(fixture.dir);
  const before = fs.readFileSync(path.join(fixture.dir, 'project.json'));
  assert.throws(() => buildMaster({ projectDir: fixture.dir, editPath }, masterDependencies([], {
    runSegmentsTrimImpl() { throw new Error('encode failed'); },
  })), /encode failed/);
  assert.deepEqual(fs.readFileSync(path.join(fixture.dir, 'project.json')), before);
  assert.equal(fs.existsSync(path.join(fixture.dir, 'input', 'source-v02.mp4')), false);
  assert.equal(fs.existsSync(path.join(fixture.dir, 'transcript', 'words-v02.json')), false);
});
```

Run: `node --test tests/takes-master.test.js`
Expected: FAIL со схемной ошибкой `source edit.fps: must have required property 'fps'` (без dispatch файл уходит в проверку v1).

- [ ] **Step 2: Создать `scripts/project/build-takes-master.js`**

```js
const fs = require('node:fs');

const { frameRateFromFps } = require('../review/media-time');
const { collectWords } = require('../tighten');
const { publishSourceRevision, roundedTime } = require('./source-revision');
const { assertCompatibleTakes, describeTake } = require('./takes');
const {
  assertTakesEditShape,
  remapTakeRangesTranscript,
  snapTakeRanges,
  takesTrimPlan,
  validateTakeRanges,
} = require('./takes-edit');
const { resolveProjectPath } = require('./workspace');

function channelLayout(channels) {
  return channels === 1 ? 'mono' : 'stereo';
}

function buildTakesMaster({ workspace, edit, editRelative, source }, dependencies) {
  const {
    fileSystem = fs,
    probeVideoImpl,
    probeMediaPathImpl,
    runSegmentsTrimImpl,
  } = dependencies;
  const normalized = assertTakesEditShape(edit, { sourceRevision: source.revision });
  const registry = workspace.manifest.takes || [];
  if (!registry.length) {
    throw new Error('project has no registered takes; run automontage takes add first');
  }
  const takes = new Map();
  for (const range of normalized.ranges) {
    if (takes.has(range.take)) continue;
    const entry = registry.find((take) => take.id === range.take);
    if (!entry) throw new Error(`takes edit references unknown take ${range.take}`);
    const filePath = resolveProjectPath(workspace.dir, entry.localPath, {
      label: `${entry.id} path`, fileSystem, mustExist: true, type: 'file',
    });
    const transcriptPath = resolveProjectPath(workspace.dir, entry.transcriptPath, {
      label: `${entry.id} transcript path`, fileSystem, mustExist: true, type: 'file',
    });
    const take = describeTake(entry.id, {
      filePath,
      video: probeVideoImpl(filePath, { stage: `${entry.id} probe` }),
      media: probeMediaPathImpl(filePath, { stage: `${entry.id} media probe` }),
    });
    takes.set(entry.id, { ...take, transcriptPath });
  }
  const used = [...takes.values()];
  assertCompatibleTakes(used);
  validateTakeRanges(normalized.ranges, takes);
  const [first] = used;
  const ranges = snapTakeRanges(normalized.ranges, { fps: first.fps, takes });
  const wordsByTake = new Map(used.map((take) => [
    take.id,
    collectWords(JSON.parse(fileSystem.readFileSync(take.transcriptPath, 'utf8'))),
  ]));
  const words = remapTakeRangesTranscript(ranges, wordsByTake, first.fps);
  const duration = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
  const rate = frameRateFromFps(first.fps);
  const { inputs, segments } = takesTrimPlan(ranges, takes);
  const result = publishSourceRevision({
    workspace,
    source,
    editRelative,
    words,
    duration,
    fps: first.fps,
    expected: { width: first.width, height: first.height },
    encode(output) {
      runSegmentsTrimImpl({
        inputs,
        output,
        segments,
        audioFadeSec: 0.04,
        precision: 6,
        fps: `${rate.numerator}/${rate.denominator}`,
        audioFormat: {
          sampleRate: first.audioSampleRate,
          channelLayout: channelLayout(first.audioChannels),
        },
      });
    },
  }, dependencies);
  return {
    ...result,
    kind: 'takes',
    duration: roundedTime(duration, first.fps),
    takes: used.map((take) => take.id),
    ranges: ranges.map(({ take, start, end, beat }) => ({
      take,
      start: roundedTime(start, first.fps),
      end: roundedTime(end, first.fps),
      beat,
    })),
  };
}

module.exports = { buildTakesMaster };
```

- [ ] **Step 3: Подключить dispatch в `scripts/project/build-master.js`**

Заменить импорт `trim-media` и добавить два импорта после блока `./source-revision`:

```js
const { runSegmentsTrim, runTrim } = require('../trim-media');
```

```js
const { buildTakesMaster } = require('./build-takes-master');
const { isTakesEdit } = require('./takes-edit');
```

В `buildMaster` сразу после строки `const source = normalizeSourceMetadata(manifest.source);` вставить:

```js
  if (isTakesEdit(edit)) {
    return buildTakesMaster({ workspace, edit, editRelative, source }, {
      ...publishDependencies,
      probeMediaPathImpl,
      runSegmentsTrimImpl: dependencies.runSegmentsTrimImpl || runSegmentsTrim,
    });
  }
```

В `main` заменить строку `console.log(`   removed: ...`)` на:

```js
    if (result.kind === 'takes') {
      console.log(`   takes: ${result.takes.join(', ')}`);
      console.log(`   ranges: ${result.ranges.length}`);
    } else {
      console.log(`   removed: ${result.removedDuration.toFixed(2)} sec`);
    }
```

- [ ] **Step 4: Проверить**

Run: `node --test tests/takes-master.test.js tests/source-edit.test.js tests/takes-edit.test.js tests/project-takes.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/project/build-takes-master.js scripts/project/build-master.js tests/takes-master.test.js
git commit -m "feat: build a source revision from the best ranges of several takes"
```

---

### Task 10: Команда `automontage takes` и справка

**Files:**
- Create: `scripts/project/takes-cli.js`
- Modify: `scripts/cli.js`
- Modify: `package.json`
- Create: `tests/takes-cli.test.js`
- Modify: `tests/cli.test.js`

- [ ] **Step 1: Написать падающие тесты `tests/takes-cli.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseTakesOptions } = require('../scripts/project/takes-cli');

const ROOT = path.join(__dirname, '..');

test('takes options keep repeated files in order and reject foreign flags', () => {
  assert.deepEqual(parseTakesOptions([
    'add', '--project-dir', 'p', '--file', 'a.mp4', '--file', 'b.mov', '--model', 'small',
  ]), {
    action: 'add', projectDir: 'p', files: ['a.mp4', 'b.mov'], model: 'small', prompt: null, silence: 0.5,
  });
  assert.deepEqual(parseTakesOptions(['pack', '--project-dir', 'p', '--silence', '0.4']), {
    action: 'pack', projectDir: 'p', files: [], model: 'large-v3-turbo', prompt: null, silence: 0.4,
  });
  for (const [argv, pattern] of [
    [['cut', '--project-dir', 'p'], /usage/],
    [['add', '--file', 'a.mp4'], /--project-dir/],
    [['add', '--project-dir', 'p'], /--file/],
    [['pack', '--project-dir', 'p', '--file', 'a.mp4'], /unknown takes option/],
    [['pack', '--project-dir', 'p', '--silence', '9'], /silence/],
    [['add', '--project-dir'], /requires a value/],
  ]) {
    assert.throws(() => parseTakesOptions(argv), pattern, argv.join(' '));
  }
});

test('takes and master modules contain no shell execution escape hatch', () => {
  for (const file of [
    'build-master.js', 'build-takes-master.js', 'source-revision.js',
    'takes.js', 'takes-cli.js', 'takes-edit.js', 'takes-pack.js',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, 'scripts', 'project', file), 'utf8');
    assert.doesNotMatch(source, /\bexecSync\b|shell\s*:\s*true/, file);
  }
});
```

Добавить в конец `tests/cli.test.js`:

```js
test('public CLI advertises multi-take commands and routes takes to its own script', () => {
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.match(help.stdout, /automontage takes add --project-dir/);
  assert.match(help.stdout, /automontage takes pack --project-dir/);
  assert.match(help.stdout, /edit\/v02-takes\.json/);
  const usage = spawnSync(process.execPath, [cli, 'takes'], { encoding: 'utf8' });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage: automontage takes add\|pack/);
  assert.doesNotMatch(usage.stderr, /build\.js|ENOENT/);
});
```

Run: `node --test tests/takes-cli.test.js tests/cli.test.js`
Expected: FAIL `Cannot find module '../scripts/project/takes-cli'`.

- [ ] **Step 2: Создать `scripts/project/takes-cli.js`**

```js
#!/usr/bin/env node
const { configureMediaToolPath } = require('../env');
const { addTakes } = require('./takes');
const { packTakes } = require('./takes-pack');

const USAGE = 'usage: automontage takes add|pack --project-dir <dir> '
  + '[--file <video> ...] [--model <id>] [--prompt <text>] [--silence <sec>]';

function parseTakesOptions(argv) {
  const [action, ...rest] = argv;
  if (!['add', 'pack'].includes(action)) throw new Error(USAGE);
  const options = {
    action,
    projectDir: null,
    files: [],
    model: 'large-v3-turbo',
    prompt: null,
    silence: 0.5,
  };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} requires a value`);
    if (key === '--project-dir') options.projectDir = value;
    else if (key === '--file' && action === 'add') options.files.push(value);
    else if (key === '--model' && action === 'add') options.model = value;
    else if (key === '--prompt' && action === 'add') options.prompt = value;
    else if (key === '--silence' && action === 'pack') options.silence = Number(value);
    else throw new Error(`unknown takes option: ${key}`);
  }
  if (!options.projectDir) throw new Error('takes requires --project-dir');
  if (action === 'add' && !options.files.length) throw new Error('takes add requires at least one --file');
  if (action === 'pack' && (!Number.isFinite(options.silence)
    || options.silence < 0.1 || options.silence > 5)) {
    throw new Error('--silence must be between 0.1 and 5 seconds');
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  try {
    configureMediaToolPath();
    const options = parseTakesOptions(argv);
    if (options.action === 'add') {
      const result = addTakes(options);
      for (const take of result.takes) {
        console.log(`✅ ${take.id}: ${take.localPath} -> ${take.transcriptPath}`);
      }
    } else {
      process.stdout.write(packTakes(options));
    }
  } catch (error) {
    console.error(`❌ takes отменён: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { main, parseTakesOptions };
```

- [ ] **Step 3: Подключить команду в `scripts/cli.js`**

В `help()` заменить две строки про master на:

```
  automontage takes add --project-dir . --file take2.mp4 [--file take3.mp4]
                                      добавить дубли одного ролика и локально расшифровать каждый
  automontage takes pack --project-dir .
                                      сводка фраз всех дублей для выбора лучших кусков
  automontage master --project-dir . --edit edit/v02-source.json
                                      собрать новую source-ревизию без повторного Whisper
  automontage master --project-dir . --edit edit/v02-takes.json
                                      собрать ролик из лучших кусков разных дублей
```

После блока `if (argv[0] === 'master') { ... }` добавить:

```js
// дубли одного ролика: импорт, локальная расшифровка и сводка фраз для выбора
if (argv[0] === 'takes') {
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'project', 'takes-cli.js'), ...argv.slice(1)], {
      stdio: 'inherit', cwd: process.cwd(), shell: false,
    });
  } catch (e) { process.exit(e.status || 1); }
  process.exit(0);
}
```

- [ ] **Step 4: Расширить быстрый набор в `package.json`**

```json
"test:video-edit": "node --test tests/lesson-preview.test.js tests/source-edit.test.js tests/qa-preview.test.js tests/takes-edit.test.js tests/takes-master.test.js tests/project-takes.test.js tests/takes-pack.test.js",
```

- [ ] **Step 5: Проверить**

Run: `node --test tests/takes-cli.test.js tests/cli.test.js && npm run test:video-edit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/project/takes-cli.js scripts/cli.js package.json tests/takes-cli.test.js tests/cli.test.js
git commit -m "feat: add automontage takes add and pack commands"
```

---

### Task 11: Сквозной тест с настоящим FFmpeg

**Files:**
- Create: `tests/takes-master-media.test.js`

- [ ] **Step 1: Написать тест**

Второй дубль намеренно в 44.1 кГц mono и стоит вторым куском: звук приводится к формату первого
куска (48 кГц stereo). Границы целые, чтобы ожидаемые числа не зависели от выравнивания по кадрам.

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  ffmpegEncoderAvailable,
  runTool: runFixture,
  toolAvailable,
} = require('./helpers/media-fixtures');
const { buildMaster } = require('../scripts/project/build-master');
const { addTakes } = require('../scripts/project/takes');
const { createOrOpenProject, readProjectManifest } = require('../scripts/project/workspace');

function streams(file) {
  const result = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,duration,r_frame_rate,width,height,sample_rate,channels',
    '-of', 'json', file,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).streams;
}

test('real takes master joins two generated takes with matching audio and video length', {
  timeout: 180_000,
}, (t) => {
  if (!toolAvailable('ffmpeg') || !toolAvailable('ffprobe') || !ffmpegEncoderAvailable('libx264')) {
    t.skip('real takes master requires ffmpeg, ffprobe and libx264');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-takes-real-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'take1.mp4');
  const second = path.join(root, 'take2.mp4');
  runFixture('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=3',
    '-ac', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', first,
  ], root);
  runFixture('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'smptebars=s=160x90:r=25:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100:d=3',
    '-ac', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', second,
  ], root);

  const workspace = createOrOpenProject({
    projectDir: path.join(root, 'project'), name: 'Real takes', sourcePath: first,
  });
  addTakes({ projectDir: workspace.dir, files: [second] }, {
    transcribeImpl: ({ videoPath }) => [{
      start: 0,
      end: 3,
      text: path.basename(videoPath),
      words: [{ w: path.basename(videoPath, path.extname(videoPath)), s: 0.6, e: 1.2 }],
    }],
  });
  fs.writeFileSync(path.join(workspace.dir, 'edit', 'v02-takes.json'), `${JSON.stringify({
    version: 1,
    kind: 'takes',
    sourceRevision: 1,
    ranges: [
      { take: 'take-01', start: 0, end: 1, beat: 'HOOK', reason: 'проверка первого дубля' },
      { take: 'take-02', start: 1, end: 2, beat: 'CTA', reason: 'проверка второго дубля' },
    ],
  }, null, 2)}\n`);

  const result = buildMaster({ projectDir: workspace.dir, editPath: 'edit/v02-takes.json' });

  const output = streams(result.sourcePath);
  const video = output.find((stream) => stream.codec_type === 'video');
  const audio = output.find((stream) => stream.codec_type === 'audio');
  assert.equal(video.r_frame_rate, '25/1');
  assert.deepEqual([video.width, video.height], [160, 90]);
  assert.ok(Math.abs(Number(video.duration) - 2) < 0.02, video.duration);
  assert.ok(Math.abs(Number(audio.duration) - Number(video.duration)) < 0.03, `${audio.duration} vs ${video.duration}`);
  assert.equal(audio.sample_rate, '48000');
  assert.equal(audio.channels, 2);
  assert.equal(readProjectManifest(workspace.dir).source.localPath, 'input/source-v02.mp4');
  const words = JSON.parse(fs.readFileSync(result.transcriptPath, 'utf8'))[0].words;
  assert.deepEqual(words.map((word) => [word.w, word.s, word.e]), [
    ['source', 0.6, 1],
    ['take-02', 1, 1.2],
  ]);
});
```

- [ ] **Step 2: Прогнать на всех доступных FFmpeg**

Run: `node --test tests/takes-master-media.test.js tests/trim-media-real.test.js`
Expected: PASS на FFmpeg из `PATH`. Если установлен FFmpeg 7:
`PATH="/opt/homebrew/opt/ffmpeg@7/bin:$PATH" node --test tests/takes-master-media.test.js tests/trim-media-real.test.js` → PASS.
Linux CI (FFmpeg 6.x) проверит третью ветку автоматически в `npm test`.

- [ ] **Step 3: Commit**

```bash
git add tests/takes-master-media.test.js
git commit -m "test: cover multi-take master with real ffmpeg"
```

---

### Task 12: Навык `reel-turnkey`

**Files:**
- Create: `skills/reel-turnkey/references/takes-selection.md`
- Modify: `skills/reel-turnkey/SKILL.md`
- Modify: `skills/reel-turnkey/references/brief-package.md`
- Modify: `skills/reel-turnkey/references/qa-checklist.md`
- Modify: `skills/reel-turnkey/evals/evals.json`

- [ ] **Step 1: Создать `skills/reel-turnkey/references/takes-selection.md`**

````markdown
# Выбор лучших дублей

Используй этот маршрут, когда пользователь прислал несколько попыток одного ролика: хук записан
несколько раз, середина повторена, CTA переснят. Результат один: новая source revision из лучших
кусков разных дублей. Разные ролики или несколько выходов относятся к пакетному режиму из
`docs/BATCH-REELS-WORKFLOW.md`. Если по запросу нельзя понять, дубли это или разные ролики, задай
один вопрос.

## Команды

1. Создай workspace из первого файла через `createOrOpenProject()`, как обычно.
2. Добавь остальные дубли. Команда копирует их в `input/takes/`, локально расшифровывает все файлы,
   включая первый, и регистрирует их в `project.json`:

   ```bash
   automontage takes add --project-dir projects/<id> --file take2.mp4 --file take3.mp4
   ```

   Дубли должны совпадать по FPS и размеру кадра с учётом поворота и иметь звук. Иначе команда
   остановится до копирования; перекодировать чужие файлы без просьбы пользователя нельзя.
3. Получи сводку фраз всех дублей:

   ```bash
   automontage takes pack --project-dir projects/<id> > projects/<id>/edit/takes-packed.md
   ```

4. Выбери дубли по брифу ниже: сам или одним отдельным субагентом.
5. Сохрани выбор в `edit/vNN-takes.json`, где `sourceRevision` равен активной ревизии из
   `project.json`, а `NN` равен следующей ревизии. Собери master:

   ```bash
   automontage master --project-dir projects/<id> --edit edit/v02-takes.json
   ```

6. Активный транскрипт уже пересчитан master. Не запускай Whisper заново: готовь draft по новой
   source revision и дальше иди обычным маршрутом.

Чтобы поменять выбор, создай новый `edit/vNN-takes.json` с текущей `sourceRevision`. Master всегда
собирает куски из исходных дублей, а не из прошлой сборки.

## Бриф выбора дублей

```text
Ты монтируешь один ролик из нескольких дублей. Выбери лучший дубль для каждого смыслового блока
и собери блоки в порядке смысла, а не в порядке файлов.

Вход:
- edit/takes-packed.md: фразы всех дублей с таймкодами от начала файла дубля;
- цель ролика и главная мысль: <два предложения из запроса>;
- ожидаемая структура: хук -> проблема -> решение -> польза -> пример -> CTA, или своя;
- оговорки, которых нужно избежать: <список из предварительного прохода по сводке>;
- целевая длительность: <секунды>.

Правила:
- start и end стоят на границах слов из сводки, слово не режется;
- добавь запас 0.03-0.2 с перед первым и после последнего слова куска;
- предпочитай резать в паузах от 0.4 с;
- каждую мысль бери один раз; куски одного дубля не пересекаются;
- неизбежную оговорку оставь, если лучшего дубля нет, и напиши это в reason;
- если сумма длиннее цели, убери блок или хвосты и пересчитай сумму.

Выход: только JSON-массив ranges и одна строка с итоговой длительностью:
[{"take": "take-02", "start": 1.02, "end": 4.51, "beat": "HOOK",
  "quote": "...", "reason": "..."}]
```

## Что показать пользователю

В пакете preview добавь таблицу из `references/brief-package.md`: блок, дубль, время в дубле и
причина из `reason`. Выбор дублей не отдельная точка согласования: пользователь меняет его в том же
списке правок, что и остальной preview.
````

- [ ] **Step 2: Подключить маршрут в `skills/reel-turnkey/SKILL.md`**

После абзаца, который заканчивается строкой `Не определяй повтор только по похожим строкам транскрипта.`, вставить:

```markdown

### Несколько дублей одного ролика

Если пользователь прислал несколько попыток одного ролика, до brief собери master из лучших кусков
по [`references/takes-selection.md`](references/takes-selection.md): `automontage takes add`,
`automontage takes pack`, выбор по смысловым блокам и `automontage master` с
`edit/vNN-takes.json`. Master уже пересчитывает транскрипт, поэтому шаг 3 не запускает Whisper
заново. Выбор дублей покажи в пакете preview таблицей «блок → дубль → причина». Разные ролики и
несколько выходов остаются пакетным режимом.
```

- [ ] **Step 3: Добавить таблицу в `skills/reel-turnkey/references/brief-package.md`**

Перед строкой `## Пакет и варианты хуков` вставить:

````markdown
## Выбор дублей

Если master собран из нескольких дублей, добавь таблицу выбора из активного `edit/vNN-takes.json`.
Пользователь может поменять дубль любого блока в том же списке правок.

```markdown
| Блок | Дубль | Время в дубле | Почему этот дубль |
|---|---|---|---|
| HOOK | take-03 | 0.42-4.90 | <reason> |
```

````

- [ ] **Step 4: Добавить раздел в `skills/reel-turnkey/references/qa-checklist.md`**

Заменить заголовок `## 9. Приватность и выдача` на `## 10. Приватность и выдача` и перед ним вставить:

```markdown
## 9. Стыки дублей

- Каждый стык между разными дублями просмотрен в полном preview: нет скачка кадра, щелчка,
  обрезанного первого или последнего слова и повторённой мысли.
- Свет, громкость и положение спикера на соседних дублях не прыгают сильнее обычной смены сцены.
- Таблица выбора дублей в пакете совпадает с `edit/vNN-takes.json` активной source revision.

```

- [ ] **Step 5: Добавить eval в `skills/reel-turnkey/evals/evals.json`**

После последнего объекта массива `evals` поставить запятую и добавить:

```json
    {
      "id": 10,
      "prompt": "Вот три дубля одного Reels: hook-1.mp4, hook-2.mp4 и full.mp4. В каждом я где-то сбился. Собери из лучших кусков один ролик, стиль реши сам.",
      "expected_output": "Агент понимает, что это дубли одного ролика, а не пакет из трёх выходов. Создаёт проект из первого файла, добавляет остальные через automontage takes add, читает automontage takes pack, выбирает лучший дубль для каждого смыслового блока и собирает master через edit/vNN-takes.json. Draft и preview строятся по новой source revision, выбор показан в пакете таблицей с причинами, final не публикуется без утверждения.",
      "files": [],
      "expectations": [
        "Три файла не превращаются в три отдельных проекта или выхода.",
        "Все дубли расшифрованы локально, без provider API.",
        "Для каждого смыслового блока выбран один дубль, причина записана в reason.",
        "Границы кусков стоят на границах слов с небольшим запасом и не режут слово.",
        "Пакет preview содержит таблицу «блок → дубль → причина»."
      ]
    }
```

- [ ] **Step 6: Проверить**

Run: `node -e "JSON.parse(require('fs').readFileSync('skills/reel-turnkey/evals/evals.json','utf8'))" && node --test tests/creative-motion-instructions.test.js tests/batch-workflow-docs.test.js tests/reel-from-donor-skill.test.js`
Expected: команда без вывода, тесты PASS.

- [ ] **Step 7: Commit**

```bash
git add skills/reel-turnkey
git commit -m "docs: teach reel-turnkey to pick the best take per beat"
```

---

### Task 13: Документация

**Files:** `README.md`, `docs/TEMPLATES.md`, `docs/MONTAGE-GUIDE.md`, `docs/REVIEW-WORKBENCH.md`, `ARCHITECTURE.md`, `TESTING.md`, `DECISIONS.md`, `CHANGELOG.md`

- [ ] **Step 1: `README.md`**

В блоке `### Быстрый маршрут lesson-монтажа` после строки
`automontage master --project-dir projects/<id> --edit edit/vNN-source.json` вставить:

```bash

# Если прислано несколько дублей одного ролика, до режиссуры:
automontage takes add --project-dir projects/<id> --file take2.mp4 --file take3.mp4
automontage takes pack --project-dir projects/<id> > projects/<id>/edit/takes-packed.md
automontage master --project-dir projects/<id> --edit edit/vNN-takes.json
```

После абзаца, который заканчивается `старый draft нельзя незаметно утвердить или отправить в final.`, вставить:

````markdown
Если один ролик записан несколькими дублями, агент собирает master из лучших кусков разных дублей.
Первый файл становится проектом как обычно, остальные добавляет `automontage takes add`: команда
копирует их в `input/takes/`, локально расшифровывает каждый дубль, включая первый, и регистрирует
их в `project.json`. `automontage takes pack` печатает фразы всех дублей с таймкодами. По ним агент
выбирает лучший дубль для каждого смыслового блока и сохраняет `edit/v02-takes.json`:

```json
{
  "version": 1,
  "kind": "takes",
  "sourceRevision": 1,
  "ranges": [
    {"take": "take-03", "start": 0.42, "end": 4.9, "beat": "HOOK", "reason": "самая уверенная подача"},
    {"take": "take-01", "start": 12.1, "end": 31.6, "beat": "PROBLEM", "reason": "без оговорок"}
  ]
}
```

`automontage master --project-dir <проект> --edit edit/v02-takes.json` собирает куски в новую
source revision. Границы выравниваются по кадрам автоматически; дубли должны совпадать по FPS и
размеру кадра и иметь звук. Дальше маршрут не меняется: draft, Review, preview и утверждение
работают с новой source revision.
````

- [ ] **Step 2: `docs/TEMPLATES.md`** – после абзаца, который заканчивается `следующий draft должен
ссылаться на активную source revision.`, вставить:

```markdown

Если ролик записан несколькими дублями, вместо `edit/vNN-source.json` используй
`edit/vNN-takes.json`: сначала `automontage takes add --project-dir <проект> --file <дубль>` и
`automontage takes pack --project-dir <проект>`, затем тот же `automontage master`. Master
собирает лучшие куски разных дублей в новую source revision; формат описан в README и
`schema/takes-edit.schema.json`.
```

- [ ] **Step 3: `docs/MONTAGE-GUIDE.md`** – после абзаца `Агент создаст отдельную папку `projects/<id>/`...` в разделе `## 3. Передать видео агенту` вставить:

```markdown

Если ролик записан несколькими дублями, передай агенту все файлы и напиши, что это дубли одного
ролика. Агент расшифрует каждый дубль, выберет лучший вариант для каждого смыслового блока и
соберёт из них один исходник до draft. Выбор появится в пакете preview таблицей
«блок → дубль → причина», поэтому его можно поправить вместе с остальными замечаниями.
```

- [ ] **Step 4: `docs/REVIEW-WORKBENCH.md`** – после абзаца, который заканчивается `и только затем открывай браузер.`, вставить:

```markdown

Монтаж из нескольких дублей устроен так же: `automontage master` с `edit/vNN-takes.json`
выпускает новую source revision до draft, поэтому Review открывается уже по собранному исходнику.
```

- [ ] **Step 5: `ARCHITECTURE.md`**

1. Строку 3 заменить на `Актуально на <результат date +%F>. Документ описывает существующий код, а не будущую дорожную карту.`
2. В диаграмме `### 3.2` заменить `A --> M["Опциональный source-edit"]` на
   `A --> M["Опциональный source-edit или takes-edit"]` и добавить строку
   `  T["Дубли: input/takes + transcript/takes"] --> M`.
3. После абзаца, который заканчивается `новую source revision.` (абзац про `build-master.js`), вставить:

```markdown

Монтаж из нескольких дублей использует ту же границу. `scripts/project/takes.js` импортирует
дубли в `input/takes/`, расшифровывает каждый в `transcript/takes/take-NN.json` и регистрирует их в
`project.json.takes`; первым дублем становится исходный файл проекта. `scripts/project/takes-pack.js`
печатает фразы всех дублей для выбора. `edit/vNN-takes.json` (`schema/takes-edit.schema.json`)
перечисляет куски в порядке смысла. `scripts/project/build-takes-master.js` проверяет, что дубли
совпадают по FPS и размеру кадра с учётом поворота и имеют звук, выравнивает границы по кадрам,
собирает куски одним FFmpeg filter graph через `runSegmentsTrim()` и публикует результат тем же
`publishSourceRevision()` из `scripts/project/source-revision.js`, что и обычный source-edit.
`scripts/trim-media.js` выбирает `-/filter_complex` для FFmpeg 7+ и `-filter_complex_script` для 6.x.
```

4. В таблицу `## 5. Скрипты и ответственность` после строки `| Папки и версии роликов | ... |` добавить:

```markdown
| Source revisions и дубли | `scripts/project/build-master.js`, `scripts/project/source-revision.js`, `scripts/project/takes.js`, `scripts/project/takes-pack.js`, `scripts/project/takes-edit.js`, `scripts/project/build-takes-master.js`, `scripts/trim-media.js` |
```

5. В `## 6. Данные и артефакты` после пункта про `project.json` добавить:

```markdown
- `input/takes/take-NN.<ext>` и `transcript/takes/take-NN.json` – неизменяемые копии дублей и их
  локальные транскрипты; `edit/vNN-source.json` и `edit/vNN-takes.json` – входы `automontage master`,
  а `input/source-vNN.mp4` и `transcript/words-vNN.json` – опубликованные source revisions.
```

- [ ] **Step 6: `TESTING.md`** – после абзаца, который заканчивается `и при успешном, и при аварийном завершении.`, вставить:

```markdown
`trim-media.js` выбирает форму filter script по версии FFmpeg: `-/filter_complex` для 7+ и
неизвестных git-сборок, `-filter_complex_script` для 6.x. `tests/trim-media-real.test.js` и
`tests/takes-master-media.test.js` запускают настоящий FFmpeg на сгенерированных роликах и
пропускаются без `ffmpeg`, `ffprobe` или `libx264`. Перед изменением склейки прогони их с FFmpeg 7
и FFmpeg 9 в `PATH`; Linux CI добавляет FFmpeg 6.x. Контракт дублей закрывают
`tests/takes-edit.test.js`, `tests/takes-master.test.js`, `tests/project-takes.test.js` и
`tests/takes-pack.test.js`; они входят в `npm run test:video-edit`.
```

- [ ] **Step 7: `DECISIONS.md`** – добавить в конец файла. Номер `D-031`: `D-030` уже занят планом
  ветки `feat/pult-rolikov`. Если к моменту выполнения в `main` есть номер выше, взять следующий
  свободный (`grep -n '^## D-' DECISIONS.md`).

```markdown

## D-031 – Монтаж из нескольких дублей – ещё одна source revision

**Дата:** <результат date +%F>
**Статус:** принято

Несколько попыток одного ролика выбираются до режиссуры, как и паузы в D-021. Дубли копируются в
`input/takes/`, каждый расшифровывается локальным Whisper в `transcript/takes/take-NN.json` и
регистрируется в `project.json.takes`. Первым дублем становится исходный файл проекта; его транскрипт
создаётся заново, потому что активный `words.json` мог быть пересчитан `--tighten` или master и
больше не совпадает с оригиналом. Агент читает сводку фраз `automontage takes pack`, выбирает лучший
дубль для каждого смыслового блока и сохраняет `edit/vNN-takes.json`. `automontage master` собирает
выбранные куски одним FFmpeg filter graph в новую immutable source revision и пересчитывает слова
без повторного Whisper. Всё после master (draft, Review, preview, approval, final) не меняется.

Границы кусков выравниваются по кадрам внутри master: начало вниз, конец вверх, с обрезкой по концу
более короткого потока дубля. Кусок нецелого числа кадров удлиняет видео до следующего кадра, а звук
остаётся точным; на восьми кусках это давало расхождение 0.08 с. Дубли обязаны совпадать по FPS и
размеру кадра с учётом поворота и иметь звук: иначе FFmpeg либо падает, либо молча выдаёт файл с
переменным FPS. Звук приводится к формату первого куска через `aformat`, видео к CFR через `fps`.

Отклонены: склейщик по образцу browser-use/video-use (отдельное извлечение каждого куска и
`-c copy` concat), потому что в их открытых PR #62, #161 и #162 он накапливает рассинхрон и даёт
щелчки AAC на стыках; расширение `source-edit.schema.json`, потому что его диапазоны принадлежат
одной активной ревизии и требуют точных кадров от автора; облачная расшифровка, потому что она
противоречит локальной политике проекта. Смешение HDR и SDR дублей в первой версии не проверяется:
общий probe не читает `color_transfer`.
```

- [ ] **Step 8: `CHANGELOG.md`** – в `## [Unreleased]`:

В конец раздела `### Добавлено` добавить:

```markdown
- Монтаж из нескольких дублей одного ролика: `automontage takes add` импортирует дубли и локально
  расшифровывает каждый, `automontage takes pack` выдаёт сводку фраз для выбора, а
  `automontage master` с `edit/vNN-takes.json` собирает лучшие куски разных дублей в новую
  immutable source revision с пересчитанными словами. Навык `reel-turnkey` выбирает дубль для
  каждого смыслового блока и показывает выбор в пакете preview.
```

В конец раздела `### Исправлено` добавить:

```markdown
- `automontage master`, `--tighten` и вырезание пауз снова работают с FFmpeg 9: filter script
  передаётся через `-/filter_complex` для FFmpeg 7+ и через `-filter_complex_script` для 6.x.
- `automontage master` принимает исходник с метаданными поворота: ожидаемый размер результата
  учитывает автоповорот FFmpeg.
```

- [ ] **Step 9: Проверить публичные тексты**

Run: `git diff -U0 origin/main...HEAD | grep '^+' | grep -n "$(printf '\342\200\224')" ; npm run check:privacy`
Expected: `grep` ничего не находит в добавленных строках (в старом тексте `SKILL.md` длинное тире уже
есть, и `check-release.js` проверяет только добавленные строки), privacy-check PASS.

- [ ] **Step 10: Commit**

```bash
git add README.md docs/TEMPLATES.md docs/MONTAGE-GUIDE.md docs/REVIEW-WORKBENCH.md ARCHITECTURE.md TESTING.md DECISIONS.md CHANGELOG.md
git commit -m "docs: document multi-take master and ffmpeg filter script compatibility"
```

---

### Task 14: Итоговая проверка и живая проба

**Files:** нет новых публичных файлов.

- [ ] **Step 1: Полный набор тестов**

Run (macOS с Homebrew): `PATH="/opt/homebrew/opt/ffmpeg-full/bin:$PATH" npm test`
Run (Linux): `npm test`
Expected: PASS, новые реальные тесты не пропущены (в выводе нет `# SKIP` у `trim-media-real` и `takes-master-media`).

- [ ] **Step 2: Релизные проверки**

Run: `npm run check:privacy && npm run check:release`
Expected: PASS.

- [ ] **Step 3: Живая проба на настоящих дублях** (нужны 2-3 реальных дубля от владельца; не коммитить)

```bash
node -e "const w=require('./scripts/project/workspace');console.log(w.createOrOpenProject({baseDir:'projects',name:'takes smoke',sourcePath:process.argv[1]}).dir)" <дубль-1>
automontage takes add --project-dir <папка из вывода> --file <дубль-2> --file <дубль-3>
automontage takes pack --project-dir <папка> > <папка>/edit/takes-packed.md
```

Составить `edit/v02-takes.json` по брифу из `skills/reel-turnkey/references/takes-selection.md`, затем:

```bash
automontage master --project-dir <папка> --edit edit/v02-takes.json
```

Expected: `✅ source revision: 2`; в `input/source-v02.mp4` на каждом стыке нет щелчка, скачка
кадра и обрезанного слова; три случайных слова из `transcript/words-v02.json` звучат в указанное время.

- [ ] **Step 4: Память проекта** (локальные файлы основной папки `../AutoMontage-Agent/`, в Git не идут)

Дописать итог в `../AutoMontage-Agent/memory/<дата>.md` и одной строкой в
`../AutoMontage-Agent/MEMORY.md` (раздел «Продуктовые инварианты»):
дубли регистрируются в `project.json.takes`, выбор хранится в `edit/vNN-takes.json`, master собирает
их одним filter graph; FFmpeg 9 требует `-/filter_complex`.

- [ ] **Step 5: Завершение ветки** – навык `superpowers:finishing-a-development-branch`. Push и PR только по явной просьбе владельца.

---

## Самопроверка плана

- **Покрытие требований:** импорт и расшифровка дублей (Task 6), сводка (Task 7), выбор и
  проверка (Task 8), сборка master (Task 9), команды (Task 10), реальный FFmpeg (Task 11), навык
  агента (Task 12), документация (Task 13). Найденные при исследовании поломки: FFmpeg 9 (Task 1),
  поворот (Tasks 3-4).
- **Сквозные имена:** `runSegmentsTrim` / `runSegmentsTrimImpl`, `probeMediaPath` /
  `probeMediaPathImpl`, `publishSourceRevision`, `describeTake`, `assertCompatibleTakes`,
  `snapTakeRanges`, `takesTrimPlan`, `remapTakeRangesTranscript`, `isTakesEdit` определены в задачах
  2-9 и используются с теми же сигнатурами.
- **Вне объёма первой версии:** проверка HDR/SDR, выбор звуковой дорожки у многодорожечных файлов
  (берётся дорожка по умолчанию, как в `build.js`), визуальные киноленты стыков.
