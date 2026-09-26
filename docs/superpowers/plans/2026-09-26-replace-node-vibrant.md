# Замена node-vibrant в --autotheme (#33) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `--autotheme` получает цвета без `node-vibrant`; уязвимая цепочка `file-type@16.5.4`
уходит из зависимостей, временное исключение в `SECURITY.md` и его проверка снимаются.

**Architecture:** `scripts/palette.js` берёт те же до 20 характерных кадров через ffmpeg, но сразу
как сырые пиксели (`-f rawvideo -pix_fmt rgb24` в stdout, без временных PNG), в рамке не больше
320×320, и квантует их `QuantizerCelebi` из уже подключённой `@material/material-color-utilities`.
Взвешенное HCT-усреднение seed и сборка токенов темы не меняются. Новых зависимостей нет.

**Tech Stack:** Node.js 20+, `node:test`, ffmpeg, `@material/material-color-utilities` 0.4.0.

## Факты, собранные до плана

- `node-vibrant` нужен только `scripts/palette.js` (`--autotheme`); `build.js` берёт из вывода
  JSON до строки `// ── diagnostics` и при ошибке пишет предупреждение и продолжает обычной темой.
- Прототип на реальном вертикальном ролике: Vibrant дал seed hue 80.9, chroma 14.0, tone 57.3.
  Среднее по пикселям через `QuantizerCelebi(64)` – hue 87.7, chroma 14.2, tone 36.9; в рамке
  320×320 – hue 87.3, chroma 14.1. Тон seed на токены не влияет: `themeFromSourceColor` берёт hue
  и chroma, фон и текст строятся от hue. Вариант с `Score` уводит hue к 95–98 и при пустом отборе
  подставляет запасной синий `#4285F4`, поэтому `Score` не используем.
- ffmpeg + квантизация занимают около 0,5 с; объём пикселей ограничен 20 × 320 × 320 × 3 байт.
- Проверка `checkSecurityException` в `scripts/check-release.js` срабатывает только при
  `node-vibrant` в `dependencies`. После замены она мертва: её удаляем вместе с
  `installedNodeVibrantChain`, `resolveInstalledDependency`, опцией `now` и тестами. Историю
  хранит Git; настоящую защиту даёт регрессионный тест на `package-lock.json`.

## Файлы

- Create: `tests/palette.test.js` – поведение палитры на синтетических видео.
- Create: `tests/palette-security.test.js` – регрессия уязвимости (payload + легитимный ввод).
- Modify: `scripts/palette.js` – кадры через rawvideo, квантизация MCU, диагностика пикселей.
- Modify: `package.json`, `package-lock.json` – `npm uninstall node-vibrant`.
- Modify: `scripts/check-release.js`, `tests/release-hygiene.test.js`, `SECURITY.md` – снять исключение.
- Modify: `CHANGELOG.md`, `DECISIONS.md`, `TESTING.md`, `README.md`.

Общие правила: в добавленных строках только «–», не длинное тире; без личных путей и имён
клиентских проектов; pre-commit hook не обходить (`--no-verify` запрещён); без push.

---

### Task 1: Характеризующие тесты палитры (зелёные на текущем коде)

**Files:**
- Create: `tests/palette.test.js`

- [ ] **Step 1: Написать тесты**

```js
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;
const SKIP = !HAS_FFMPEG && 'ffmpeg is not installed';
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-palette-'));
after(() => fs.rmSync(WORK, { recursive: true, force: true }));

const THEME_KEYS = ['name', 'colors', 'fonts', 'radius', 'cardShadow', 'cardBorder', 'motion'];
const COLOR_KEYS = ['bg', 'cardBg', 'cardBg2', 'milk', 'accent', 'accentDark', 'text', 'textSoft'];

function solidVideo(hex, size = '320x240') {
  const file = path.join(WORK, `solid-${hex}-${size}.mp4`);
  if (fs.existsSync(file)) return file;
  const result = spawnSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x${hex}:s=${size}:d=1:r=5`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return file;
}

function runPalette(video, extra = []) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/palette.js'), video, ...extra], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const [json, diagnostics = ''] = result.stdout.split('// ── diagnostics');
  const seedHex = /seed\(video\):.*hex=(#[0-9a-f]{6})/i.exec(diagnostics)?.[1];
  return { theme: JSON.parse(json.trim()), seedHex, diagnostics };
}

function channels(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = channels(hex).map((c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('autotheme palette keeps the theme token format and the exact brand accent at brandLock 1', { skip: SKIP }, () => {
  const { theme } = runPalette(solidVideo('2255cc'));
  assert.deepEqual(Object.keys(theme), THEME_KEYS);
  assert.deepEqual(Object.keys(theme.colors), COLOR_KEYS);
  for (const key of COLOR_KEYS) assert.match(theme.colors[key], /^#[0-9a-f]{6}$/i, key);
  assert.equal(theme.name, 'craft');
  assert.equal(theme.colors.accent, '#CC785C');
});

test('autotheme palette uses a custom brand accent', { skip: SKIP }, () => {
  const { theme } = runPalette(solidVideo('2255cc'), ['--brandLock', '1', '--brandAccent', '#3366FF']);
  assert.equal(theme.colors.accent, '#3366FF');
});

test('autotheme palette seed follows a known solid frame color', { skip: SKIP }, () => {
  for (const hex of ['2255cc', 'd2691e', '2e8b57']) {
    const { seedHex } = runPalette(solidVideo(hex), ['--brandLock', '0']);
    assert.ok(seedHex, `seed is printed for ${hex}`);
    const distance = Math.max(...channels(seedHex).map((c, i) => Math.abs(c - channels(hex)[i])));
    assert.ok(distance <= 16, `seed ${seedHex} is far from #${hex} (${distance})`);
  }
});

test('autotheme palette keeps WCAG 4.5:1 text contrast for light, dark and gray sources', { skip: SKIP }, () => {
  for (const hex of ['f0e8d0', '101010', '808080']) {
    for (const brandLock of ['0', '0.5']) {
      const { theme } = runPalette(solidVideo(hex), ['--brandLock', brandLock]);
      const { text, textSoft, cardBg } = theme.colors;
      assert.ok(contrast(text, cardBg) >= 4.5, `text on cardBg for #${hex} at ${brandLock}`);
      assert.ok(contrast(textSoft, cardBg) >= 4.5, `textSoft on cardBg for #${hex} at ${brandLock}`);
    }
  }
});
```

- [ ] **Step 2: Прогнать на текущем коде с Vibrant**

Run: `node --test tests/palette.test.js`
Expected: PASS, 4/4. Это характеризующие тесты: они фиксируют поведение до замены. Если какой-то
падает на текущем коде – остановиться и сообщить (NEEDS_CONTEXT) с выводом, порог не подгонять.

- [ ] **Step 3: Commit**

```bash
git add tests/palette.test.js
git commit -m "test: characterize the autotheme palette on synthetic videos"
```

---

### Task 2: Регрессия уязвимости и замена Vibrant

**Files:**
- Create: `tests/palette-security.test.js`
- Modify: `scripts/palette.js`
- Modify: `package.json`, `package-lock.json` (через `npm uninstall`)

- [ ] **Step 1: Написать падающие security-тесты**

```js
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;
const SKIP = !HAS_FFMPEG && 'ffmpeg is not installed';
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-palette-security-'));
after(() => fs.rmSync(WORK, { recursive: true, force: true }));

// GHSA-5v7r-6r5c-r473: file-type 13.0.0 – 21.3.0 зависает на испорченном ASF.
const FIXED_FILE_TYPE = [21, 3, 1];
const MAX_PALETTE_PIXELS = 20 * 320 * 320;

function versionBelow(version, minimum) {
  const parts = String(version).split(/[.+-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((parts[i] || 0) !== minimum[i]) return (parts[i] || 0) < minimum[i];
  }
  return false;
}

function vulnerableLockEntries(lock) {
  return Object.entries(lock.packages || {})
    .filter(([name, meta]) => (
      /(^|\/)node_modules\/(node-vibrant|@vibrant\/[^/]+)$/.test(name)
      || (/(^|\/)node_modules\/file-type$/.test(name) && versionBelow(meta.version, FIXED_FILE_TYPE))
    ))
    .map(([name, meta]) => `${name}@${meta.version}`);
}

function video(name, source) {
  const file = path.join(WORK, name);
  const result = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', source,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return file;
}

function runPalette(input) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts/palette.js'), input, '--brandLock', '0'], {
    cwd: ROOT, encoding: 'utf8', timeout: 60_000,
  });
}

test('lockfile check flags the vulnerable node-vibrant chain and accepts the fixed file-type', () => {
  const payload = { packages: {
    '': { dependencies: { 'node-vibrant': '^4.0.4' } },
    'node_modules/node-vibrant': { version: '4.0.4' },
    'node_modules/@vibrant/image-node': { version: '4.0.4' },
    'node_modules/@jimp/core/node_modules/file-type': { version: '16.5.4' },
  } };
  assert.deepEqual(vulnerableLockEntries(payload), [
    'node_modules/node-vibrant@4.0.4',
    'node_modules/@vibrant/image-node@4.0.4',
    'node_modules/@jimp/core/node_modules/file-type@16.5.4',
  ]);
  const legitimate = { packages: {
    '': {},
    'node_modules/file-type': { version: '21.3.1' },
    'node_modules/vibrant-colors-docs': { version: '1.0.0' },
  } };
  assert.deepEqual(vulnerableLockEntries(legitimate), []);
});

test('installed dependencies carry no node-vibrant chain or vulnerable file-type', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    assert.equal(Object.hasOwn(pkg[field] || {}, 'node-vibrant'), false, field);
  }
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.deepEqual(vulnerableLockEntries(lock), []);
});

test('autotheme palette never loads a JavaScript image decoder', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/palette.js'), 'utf8');
  assert.doesNotMatch(source, /node-vibrant|jimp|file-type/i);
});

test('autotheme palette fails fast on a malformed ASF payload and still reads a real video', { skip: SKIP }, () => {
  const asfHeader = Buffer.from('3026b2758e66cf11a6d900aa0062ce6c', 'hex');
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const payload = path.join(WORK, 'malformed.asf');
  // Заголовок ASF с одним вложенным объектом нулевой длины – форма, на которой зависал file-type.
  fs.writeFileSync(payload, Buffer.concat([
    asfHeader, u64(54), Buffer.from([1, 0, 0, 0, 1, 2]), Buffer.alloc(16, 0x41), u64(0),
  ]));
  const hostile = runPalette(payload);
  assert.equal(hostile.error, undefined, String(hostile.error));
  assert.notEqual(hostile.status, 0);
  assert.doesNotMatch(hostile.stdout, /"colors"/);

  const legitimate = runPalette(video('legit.mp4', 'color=c=0x2255cc:s=320x240:d=1:r=5'));
  assert.equal(legitimate.status, 0, legitimate.stderr);
});

test('autotheme palette bounds the pixels it reads for extreme aspect ratios', { skip: SKIP }, () => {
  const result = runPalette(video('tall.mp4', 'color=c=0x2e8b57:s=16x4096:d=1:r=5'));
  assert.equal(result.status, 0, result.stderr);
  const pixels = Number(/pixels: (\d+)/.exec(result.stdout)?.[1]);
  assert.ok(pixels > 0 && pixels <= MAX_PALETTE_PIXELS, `pixels=${pixels}`);
});

test('autotheme palette passes a hostile file name to ffmpeg as one literal argument', { skip: SKIP }, () => {
  const hostile = path.join(WORK, `- clip ' " $(touch pwned) ;.mp4`);
  fs.copyFileSync(video('plain.mp4', 'color=c=0xd2691e:s=320x240:d=1:r=5'), hostile);
  const result = runPalette(hostile);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(ROOT, 'pwned')), false);
});
```

- [ ] **Step 2: Убедиться, что тесты падают по нужным причинам**

Run: `node --test tests/palette-security.test.js`
Expected FAIL:
- `installed dependencies…` – в lock есть `node_modules/node-vibrant@4.0.4` и `file-type@16.5.4`;
- `never loads a JavaScript image decoder` – в `palette.js` есть `node-vibrant`;
- `bounds the pixels` – в выводе нет строки `pixels:`.
PASS уже сейчас (проверено до плана): проверка самого `vulnerableLockEntries` (payload и
легитимный lock), `malformed ASF` (текущий код тоже падает быстро: ffmpeg возвращает ошибку,
`execFileSync` бросает) и hostile file name. Они фиксируют, что замена не ухудшит поведение.

- [ ] **Step 3: Заменить Vibrant в `scripts/palette.js`**

Шапка файла: в строке «Зависимости» вместо `node-vibrant (перцептивные свотчи по кадрам)` –
`ffmpeg (до 20 характерных кадров сырыми rgb24-пикселями)`, а `ESM-only пакеты (node-vibrant,
MCU)` → `ESM-only MCU`. Импорты `node:fs`, `node:os`, `node:path` больше не нужны – удалить.

Константы после `lerp`:

```js
// Не больше 20 кадров в рамке 320×320: объём сырых пикселей ограничен до разбора.
const FRAME_LIMIT = 20;
const FRAME_BOX = 320;
const MAX_PIXELS = FRAME_LIMIT * FRAME_BOX * FRAME_BOX;
const QUANTIZE_COLORS = 64;
```

В `main()`: из MCU дополнительно взять `QuantizerCelebi, argbFromRgb`, строку
`const { Vibrant } = await import('node-vibrant/node');` удалить. `extractFrames` и
`seedFromFrames` заменить на:

```js
  // ───────────────────── Пиксели кадров ─────────────────────

  // thumbnail=100 – ffmpeg сам выбирает «характерные» кадры из окон по 100 фреймов.
  // Пиксели идут сразу в stdout: ни временных файлов, ни JS-декодера картинок.
  function framePixels(video) {
    const raw = execFileSync('ffmpeg', [
      '-v', 'error', '-nostdin', '-i', video, '-an',
      '-vf', `thumbnail=100,scale=${FRAME_BOX}:${FRAME_BOX}:force_original_aspect_ratio=decrease`,
      '-frames:v', String(FRAME_LIMIT), '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ], { maxBuffer: MAX_PIXELS * 3, stdio: ['ignore', 'pipe', 'pipe'] });
    if (raw.length < 3) throw new Error('ffmpeg не извлёк ни одного кадра из видео');
    const pixels = new Array(Math.floor(raw.length / 3));
    for (let i = 0; i < pixels.length; i += 1) {
      pixels[i] = argbFromRgb(raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]);
    }
    return pixels;
  }

  // ───────────────────── Seed-цвет из видео ─────────────────────

  // Квантуем пиксели всех кадров (QuantizerCelebi) и усредняем цвета В ПЕРЦЕПТИВНОМ
  // пространстве HCT, взвешенно по числу пикселей, а не в сыром RGB.
  // Hue усредняем циркулярно (через синус/косинус).
  function seedFromPixels(pixels) {
    let sx = 0, sy = 0, sChroma = 0, sTone = 0, w = 0;
    for (const [argb, population] of QuantizerCelebi.quantize(pixels, QUANTIZE_COLORS)) {
      if (population <= 0) continue;
      const hct = Hct.fromInt(argb);
      // Приглушаем вклад почти-серых цветов: у них hue шумный.
      const weight = population * (0.3 + 0.7 * Math.min(1, hct.chroma / 40));
      const rad = (hct.hue * Math.PI) / 180;
      sx += Math.cos(rad) * weight;
      sy += Math.sin(rad) * weight;
      sChroma += hct.chroma * weight;
      sTone += hct.tone * weight;
      w += weight;
    }
    if (w === 0) {
      return { hue: 40, chroma: 8, tone: 50, hex: hctToHex(40, 8, 50) };
    }
    let hue = (Math.atan2(sy, sx) * 180) / Math.PI;
    if (hue < 0) hue += 360;
    const chroma = sChroma / w;
    const tone = sTone / w;
    return { hue, chroma, tone, hex: hctToHex(hue, chroma, tone) };
  }
```

Блок прогона вместо `extractFrames`/`try…finally`:

```js
  const pixels = framePixels(args.video);
  const seed = seedFromPixels(pixels);
  const theme = buildTheme(seed, args.brandLock, args.brandAccent);
```

затем прежние `crText`/`crSoft`/`crMilkOnAccent` и вывод без изменений, а после строки
`// seed(video): …` добавить:

```js
    console.log(`// pixels: ${pixels.length} from ffmpeg rgb24 frames (limit ${MAX_PIXELS})`);
```

Блок `finally` с `unlinkSync`/`rmdirSync` удалить – временных файлов больше нет.

- [ ] **Step 4: Удалить зависимость**

```bash
npm uninstall node-vibrant
grep -c '"node_modules/node-vibrant"' package-lock.json   # 0
npm ls file-type                                          # пусто или только >= 21.3.1
npm audit                                                 # found 0 vulnerabilities
```

Если `npm audit` показывает что-то ещё – записать в отчёт как есть, не чинить в этой задаче.

- [ ] **Step 5: Тесты зелёные**

Run: `node --test tests/palette-security.test.js tests/palette.test.js tests/build-security.test.js`
Expected: PASS, 0 fail (характеризующие тесты Task 1 продолжают проходить на новом коде).

- [ ] **Step 6: Commit**

```bash
git add tests/palette-security.test.js scripts/palette.js package.json package-lock.json
git commit -m "fix: build the autotheme palette without node-vibrant"
```

---

### Task 3: Снять исключение безопасности и мёртвую проверку

Выполнять только если `grep -c "node-vibrant" package-lock.json` выдаёт `0`.

**Files:**
- Modify: `scripts/check-release.js` – удалить `resolveInstalledDependency`,
  `installedNodeVibrantChain`, `checkSecurityException`, её вызов в `checkRelease` и опцию
  `now = new Date()` (она нужна только этой проверке). `parseUtcCalendarDate` оставить – ею
  пользуется проверка CHANGELOG.
- Modify: `tests/release-hygiene.test.js` – удалить хелперы `securityException`,
  `writeSecurityException`, `enableNodeVibrant`, тест `repository dependency exception is reviewed
  for the 1.9.0 release window` и все тесты `node-vibrant …` (их 11); строку фикстуры
  `'- temporary exception is recorded in SECURITY.md.',` оставить – это просто текст CHANGELOG.
- Modify: `SECURITY.md` – удалить раздел `## Temporary dependency exception` целиком.

- [ ] **Step 1: Удалить код, тесты и раздел** (как перечислено выше).
- [ ] **Step 2: Проверить**

```bash
git grep -n -i "vibrant\|security-exception\|revisitBy" -- scripts tests SECURITY.md   # пусто
node --test tests/release-hygiene.test.js tests/test-temp-hygiene.test.js
npm run check:release -- --base origin/main
```

Expected: 0 fail; `release check passed`.

- [ ] **Step 3: Commit**

```bash
git add scripts/check-release.js tests/release-hygiene.test.js SECURITY.md
git commit -m "fix: drop the node-vibrant security exception and its release check"
```

---

### Task 4: Документация

**Files:** `CHANGELOG.md`, `DECISIONS.md`, `TESTING.md`, `README.md`

- [ ] **Step 1: CHANGELOG** – в `## [Unreleased]` добавить подраздел (перед `### Исправлено`, если он есть):

```markdown
### Безопасность

- `--autotheme` больше не использует `node-vibrant`: ffmpeg отдаёт до 20 характерных кадров
  сырыми пикселями в рамке 320×320, а цвета выбирает `QuantizerCelebi` из уже подключённой
  `@material/material-color-utilities`. Уязвимая цепочка с `file-type@16.5.4`
  (GHSA-5v7r-6r5c-r473) ушла из зависимостей, `npm audit` без находок, временное исключение в
  `SECURITY.md` и его проверка в `check:release` сняты. Кадры больше не пишутся во временные
  PNG-файлы (#33).
```

- [ ] **Step 2: DECISIONS.md** – новая запись в конец, в формате соседних (`## D-032 – …`,
  `**Дата:** 2026-09-26`, `**Статус:** принято`), по содержанию:
  - решение: пиксели кадров через ffmpeg rawvideo в рамке 320×320 + `QuantizerCelebi(64)` +
    прежнее HCT-усреднение; без новых зависимостей;
  - отвергнуто: продлевать исключение каждый месяц; `node-vibrant` 3.x (та же линия Jimp);
    `overrides` на `file-type` 21 (ESM-only, ломает Jimp 0.22); `Score` для seed (hue уходит
    к акцентам, при пустом отборе запасной синий);
  - проверку исключения в `check-release.js` удалили, а не оставили спящей: она была жёстко
    привязана к одной цепочке; от возврата уязвимости защищает `tests/palette-security.test.js`;
  - сдвиг цвета на реальном ролике: hue seed 80.9 → 87.3, chroma 14.0 → 14.1 (набор цветов до и
    после – в описании PR).

- [ ] **Step 3: TESTING.md**
  - раздел 8: в перечне current-tree правил убрать `security exception`, удалить предложение
    про исключение `node-vibrant` и его `json security-exception` fence (до конца этого предложения);
  - раздел 9: абзац «Полный `npm audit` сейчас должен показывать ровно пять moderate записей…»
    заменить на: полный `npm audit` должен быть без находок; `tests/palette-security.test.js`
    не даёт вернуть `node-vibrant` и `file-type` ниже 21.3.1;
  - раздел 1, список «Проверяются»: добавить пункт про палитру `--autotheme` (формат токенов,
    brand accent, seed на синтетических видео, контраст 4.5:1, ограничение пикселей, быстрый
    отказ на испорченном файле).

- [ ] **Step 4: README.md** – абзац про `npm audit --audit-level=high` (около строки 795):
  оставить первое предложение, остальное про пять moderate записей и исключение заменить на
  «Полный `npm audit` сейчас без находок.»

- [ ] **Step 5: Проверки и commit**

```bash
npm test
npm run check:release -- --base origin/main
git add CHANGELOG.md DECISIONS.md TESTING.md README.md
git commit -m "docs: record the node-vibrant replacement"
```

## Итог исполнения

Код отличается от плана по итогам ревью: в `tests/palette.test.js` добавлены тесты смешения двух
цветов по площади и приглушения серого (без них проходили замены, игнорирующие площадь или вес
серого), пропуск по наличию ffmpeg с libx264 и видимая причина таймаута. Ревью нашло старую
ошибку выборки кадров – ffmpeg повторял первый thumbnail 20 раз; она исправлена флагом
`-fps_mode passthrough` с регрессионным тестом. Вместе с проверкой исключения удалена ставшая
ненужной `releaseDateForVersion`; в `SECURITY.md` переписаны две фразы, ссылавшиеся на
исключение. Итоговый сдвиг seed на реальном ролике: hue 80.9 → 92.2, chroma 14.0 → 13.6.
