# Тестирование AutoMontage-Agent

Проверки идут слоями: быстрые тесты ловят логику, демо проверяет сборку, а контрольные
кадры и медиапроверка подтверждают, что ролик действительно можно отдавать человеку.

## 1. Быстрый обязательный уровень

```bash
npm ci
npm test
```

`npm test` использует встроенный Node test runner и запускает `tests/*.test.js`.
Проверяются, среди прочего:

- draft/approved-гейт и неизменность source/theme/aspect;
- геометрия source/vertical/horizontal;
- нормализация и валидация lesson brief;
- глобальный таймкод видео между сценами;
- музыкальный gain, fade, стартовый фрагмент и скорость;
- создание project-папки, транслитерация, локальный транскрипт и повторное открытие;
- schema-контракт project manifest, миграция legacy `transcript`, traversal/Windows-path
  payload, dangling symlink на final/intermediate component и safe slug/id: каждый сохранённый
  или generated путь обязан остаться внутри своего workspace/outdir;
- общий lesson/Dynamic export: реальный existing/dangling final symlink и symlinked/non-directory
  parent отклоняются без изменения внешнего sentinel, а новый вложенный `--outdir` создаётся;
- единый cross-process project mutation lease для Save/approval/brief/render, сохранность
  live/foreign owner, reclaim умершего PID, persisted-snapshot CAS manifest-last и atomic
  no-replace для исторических draft/approved JSON/Markdown;
- lifecycle `started → failed/complete`, сохранность прежнего final и атомарную публикацию;
- CLI-правила `--project`, `--project-dir` и `--version-label`;
- process regression matrix: leading `-`, пробелы, кавычки, `$()`, `;`, newline и Unicode;
- Review waveform: буквальный ffmpeg argv, cache reuse/invalidation, очистка partial temp,
  отказ от regular/symlink/dangling-symlink подмен, включая замену `previews/` на runner boundary,
  и неизменность manifest/approved brief;
- Review security: random token на каждом `/api/*` и `/media/*`, same-session Origin для POST,
  read-only `405`, traversal/symlink, oversized body, unknown command, свежий disk state,
  source/asset identity expiry, secure `0600` handoff без token в CLI-логе и его cleanup при
  `SIGINT`/`SIGTERM` с восстановлением process listeners; реальные subprocess-регрессии прерывают
  partial upload и actual ffmpeg для прямого CLI, а также import через публичный wrapper, проверяя
  exit 130/143 только после удаления lease/quarantine и успешный следующий запуск;
- Review edit contract: только adjacent boundary и allowlisted image/video b-roll, отсутствие
  global ripple, opaque asset handles, fit/start/audio commands, покадровый clip overrun,
  frame/word timing reasons, межпроцессный project lease, in-memory undo/redo, новая draft-пара
  на Save, manifest-last visibility и byte-identical approved;
- discovery B-roll: draft-only intent и заглушка preview, официальный Pexels photo/video contract
  через локальный mock HTTP server, HTTPS/DNS pinning/redirect SSRF, ограниченный поток/MIME,
  timeout/abort/truncation, отсутствие ключа и отсутствие его утечки в ошибках/карточках;
- candidate allowlist: session/scene/query/generation/TTL, cross-session и подменённые ID,
  preview без скачивания полного файла, загрузка только выбранной rendition, stale Save/import;
- provenance v3 с сохранением v1/v2, NFKC/UTF-8 bounds, нативный OCR изображения и трёх кадров,
  недоступный OCR, поздняя отмена, hash-bound разрешение текста и его сброс при замене;
- обязательный текущий полный preview для discovery approval, отказ excerpt/stale/tampered
  preview, явное подтверждение просмотра, OCR/intent gate и race перед публикацией;
- media import: exact-length streaming в owned quarantine, type/size/geometry/duration/disk
  limits, separate visual/audio stream timing without container fallback, even padding after
  autorotate, encoder/output/copy quotas, phase `statfs`, abort/semaphore, real ffprobe/decode,
  WebP/H.264 master + WebM proxy, UUID publication,
  отсутствие auto-select, browser path/hash privacy, общий project lease, durable owner journal,
  hard-exit recovery, late-syscall replacement/tombstone, shutdown escalation и identity-only
  immutable cleanup boundaries;
- approval/render media: descriptor probe/hash, normalized metadata/proxy, silent/audio rules,
  repeated asset/custom face dedup, authoritative faceSrc matching, одноразовый render bundle,
  trusted source-alias contract, безопасный полный rehash при File Provider `ctime`-only drift,
  same-inode source identity, owner-only isolated Remotion `--public-dir`, bounded retry при drift
  во время hash, strict whole-render callback mutation + restore, foreign-root cleanup refusal,
  fail-closed same-size/append/overwrite и `Img`/`OffthreadVideo` envelopes;
- portable opened-media probe: реальные PNG/JPEG/WebP, H.264 MP4 с `moov` в конце и WebM идут
  через opened descriptor + `pipe:0` без host path; Windows-mode filesystem отвергает POSIX
  flags/modes, но всё равно требует regular type, containment, identity и совпадающие bytes;
  отдельный behavioral test доказывает, что directory fsync управляется собственной capability,
  а не `posixPermissions`, и на Windows пропускается только неподдерживаемый directory-handle fsync;
- fail-closed ошибки ENOENT, non-zero, signal и некорректный ffprobe JSON;
- timing regression: NTSC `30000/1001` и `24000/1001` FPS не округляются, число кадров
  считается через `ceil`, а положительный целый `--frames` не превышает длину source;
- повторный ffprobe после reframe и tighten обновляет FPS, по которому строятся props;
- уникальный public media lease каждого render, его cleanup и запрет symlink-escape;
- cache identity: изменение Remotion-кода, lockfile, обычного public resource path или его bytes
  отменяет reuse; меняющийся generated source lease с теми же bytes сохраняет key также без
  расширения и с непривычным расширением;
- safe-zone длинных денежных подписей;
- анимации CTA, воронки, градиента и маркеров соцсетей.

Любое исправление бага должно добавлять регрессионный тест его причины.

### Пропорциональная проверка монтажа

Для изменения cut-list, brief или draft-preview сначала запускай только быстрый контур:

```bash
npm run test:video-edit
npm run qa:preview -- --project-dir <project>
```

Focused engine tests нужны при изменении общего `scripts/`, `src/` или `schema/`. Полный
`npm test` запускается один раз после завершения согласованного этапа, а `check:release` и
`smoke:release` - только перед выпуском или merge. Brief-only правка клиентского ролика не должна
сама по себе запускать весь repository gate.

Для waveform и защищённого process boundary отдельно можно запустить:

```bash
node --test tests/review-waveform.test.js tests/process-security.test.js
node --test tests/project-mutation-transaction.test.js
node --test tests/filesystem-capabilities.test.js tests/opened-media-probe.test.js \
  tests/project-workspace.test.js \
  tests/review-draft-save.test.js
node --test tests/review-import-ownership.test.js tests/review-media-import.test.js \
  tests/review-imported-assets.test.js tests/review-server-security.test.js
npm run test:review-ui
```

Project transaction suite запускает независимые Node-процессы для Save против approval и
approval против render writer, убивает владельца после lease/Markdown/JSON/manifest boundaries
и проверяет, что currentBrief всегда указывает на существующий JSON. Отдельно фиксируются
foreign destination collision, stale snapshot conflict и сохранность live/foreign owner bytes.
Также проверяются два initial-draft publisher процесса, обязательный expected snapshot для raw
manifest update и ошибки `readFileSync`/`lstatSync` сразу после manifest rename.

Chromium suite поднимает настоящий loopback-сервер и проверяет read-only/edit DOM, token/origin,
waveform fallback, word-snap drag, накопительное frame-only Arrow movement, Home/End и достижимые
frame-inset slider limits после validate/Undo/Redo, реальные
JPEG/MP4/MOV/M4V/WebM uploads, authenticated proxy playback, отсутствие auto-select, русские
fit/start/audio controls, сохранение preview playhead, derived used interval, silent-video
ограничения, keyboard Tab-order без скрытого file input, реальные Enter/Space file chooser
imports, точную `aria-invalid` boundary-подсветку, pending `aria-busy`, 360px media scroll,
undo/redo, save confirmation, committed-201 refresh failure и внешний `409` с настоящей
перезагрузкой/блокировкой мутаций. Browser DOM дополнительно проверяется на отсутствие project
path, canonical media reference и SHA-256.
Она не заменяет `npm test`: browser и Node suites обязательны отдельно.

Для золотого пути свежего клона отдельно проверь:

```bash
git clone https://github.com/mcdenil-skills/AutoMontage-Agent.git
cd AutoMontage-Agent
npm ci
npm run doctor
npm run demo
```

Одна папка checkout допускает только одну активную сборку: lesson media изолированы в owner-only
`os.tmpdir()` и передаются Remotion абсолютным `--public-dir`, но `tmp/` и legacy-пути остаются
общими. Параллельные проверки запускай в отдельных clone/worktree. Unit и integration tests также
проверяют, что leases не пересекаются, cleanup идемпотентен и удаляет источник после успеха или
ошибки рендера.

Для host filesystem path тест проверяет абсолютный отдельный argv. Ссылки Remotion/public
остаются web-relative и не преобразуются в host path. Capture разрешён только для коротких
ffprobe/JSON-результатов с явным `maxBuffer`.

Job `portable-media-windows` на настоящем `windows-latest` дополнительно запускает переносимые
owner-файлы probe/filesystem/render bundle и точные Windows/real-media подмножества import,
recovery, handoff, final publication и безопасного логирования. Отдельные шаги сохраняют
переносимые подмножества duration/geometry, project transaction и import ownership. POSIX-only
mode/umask, signal/hard-exit границы и rename открытого файла намеренно не выдаются за
Windows-проверку. Import ownership отдельно воспроизводит временные `EPERM`/`EBUSY`/`ENOTEMPTY`:
повтор разрешён только для identity-проверенных пустых tombstone и quarantine root, а чужой или
недоказанный остаток должен сохраниться. Отдельная матрица использует NTFS-подобные inode выше
`2^53`: собственные setup entries очищаются по точному BigInt id, а соседние округляемые id
сохраняются. Локально проверяются команды и YAML; hosted Windows run
остаётся обязательным pre-merge gate.

Статический guard для `scripts/build.js` запрещает `execSync` и `shell: true`. Опции
`--frames`, `--max`, `--beatSec`, `--brandLock` и `--reframe` проверяются до ffprobe.
Та же граница действует для `finish.js`, `mix-music.js` и `pack-tg.js`: filter values,
FPS, bitrate и resolution имеют конечные диапазоны, а пути остаются отдельными argv.
`tighten.js` и `cut-pauses.js` дополнительно валидируют word/keep intervals; временный
ffmpeg filter script удаляется через `finally` и при успешном, и при аварийном завершении.
Chunk-render проверяет positive integer `totalFrames/--chunk`, рендерит part во временный
соседний MP4 и публикует его rename только после успешного Remotion exit.
Resume cache v2 адресуется SHA-256 от composition, канонизированных props, source/audio
identities, диапазонов, Remotion options, всего `src/`, `package.json` и `package-lock.json`.
Тесты меняют JSX byte, referenced b-roll и package metadata, проверяют, что каждый случай
инвалидирует key, а неиспользуемый `public/` файл – нет. Для public media фиксируются только
contained regular files, отсортированные по JSON pointer; traversal не читается, symlink в
`src/` или на любом сегменте public media отклоняется. Descriptor сохраняет порядок ключей,
который получает Remotion, поэтому перестановка props тоже меняет key. Одинаковые bytes в разных
generated `.automontage/<lease>/source.<ext>` дают одинаковый resume key, но byte-identical
обычные b-roll A и B сохраняют разную наблюдаемую path identity.
Manifest разрешает reuse только при совпадении range/hash/size/frames.

## 2. Проверка окружения

```bash
npm run doctor
```

Команда проверяет Node.js 20+, Python 3, ffmpeg и установленные зависимости. Для Review import
она отдельно ищет `libwebp`, `libx264`, `libvpx`, `libopus` и AAC. Если системная сборка не
содержит нужный encoder, базовые поддерживаемые операции остаются доступны, но полный acceptance
запускать нельзя. На macOS полную сборку можно выбрать без удаления системной:

```bash
brew install ffmpeg-full
AUTOMONTAGE_FFMPEG_DIR="$(brew --prefix ffmpeg-full)/bin" npm run doctor
```

Chromium нужен только для browser tests и пересборки PNG через Playwright, не для обычного
рендера.

## 3. Воспроизводимый демо-рендер

```bash
npm run demo
```

Демо пишет MP4, transcript и captions только в игнорируемый `out/`. После прогона
`git status --short` не должен показывать новые изменения в `src/data/`.

Демо использует небольшие файлы из `examples/`, не требует API-ключей и не скачивает
Whisper-модель. Проверить, что созданный MP4 открывается и содержит звук.

## 4. Проверка монтажных листов

Для Dynamic до Remotion:

```bash
node scripts/validate.js path/to/scenario.json
node scripts/quality-gate.js path/to/scenario.json
node scripts/dynamic-gate.js path/to/scenario.json path/to/transcript.json
```

В обычном `scripts/build.js` эти гейты вызываются автоматически. Ошибку схемы или
качества нужно исправлять до полного рендера.

## 5. Проверка lesson-процесса

Пользовательский маршрут по Review Workbench и финальному MP4 описан в
[docs/REVIEW-WORKBENCH.md](docs/REVIEW-WORKBENCH.md); ниже - техническая проверка того же контура.

1. Запустить `--template lesson --project "Test lesson"` без `--brief`.
2. Убедиться, что созданы project-папка, локальный транскрипт, Markdown и JSON со статусом
   `draft`, а Remotion не стартовал.
3. Проверить исправления распознавания, сцены, тексты, таймкоды и кадрирование.
4. Собрать настоящий draft-preview командой `automontage preview`, проверить H.264/AAC,
   половинную геометрию, точный FPS, полный decode, метку «ЧЕРНОВИК» и full/excerpt range.
   Искусственный сбой Remotion/finish/music обязан сохранить прежний `current-preview.mp4`.
5. В Review проверить отдельные плееры **«ИСХОДНИК»** и **«СМОНТИРОВАННЫЙ ПРЕДПРОСМОТР»**;
   `/media/current-preview` требует token, поддерживает Range и отклоняет hash/symlink replacement.
6. Только после явного утверждения создать approved-копию через
   `scripts/project/approve-brief.js`.
7. Рендерить локальным исходником через `--project-dir`, `--brief` и `--version-label`.
8. Отдельно проверить, что draft, другой source, тема или аспект блокируются финальным render.

Для реальной проверки Review используй только копию fixture/project workspace. До запуска сними
SHA-256 `project.json`, всех brief и approved-файлов. Read-only сессию закрой и подтверди те же
bytes. В `--edit` перенеси одну общую границу, загрузи image, silent video и audio video, проверь,
что upload ничего не выбрал сам, назначь четыре b-roll сцены (`image`, `mute`, `mix`, повторный
`replace`) и Save; должны появиться одна новая draft Markdown/JSON-пара и одна manifest entry,
а approved hash остаться прежним.
Утверждай новую draft отдельным явным действием в Review либо через `approve-brief.js`, затем
рендери `--brief` и выполни полный decode, ffprobe и визуальную проверку контрольных кадров.
Для discovery нужен текущий полный preview и подтверждение просмотра. Поиск, импорт и Save
никогда не запускают approval или final render.
7. Убедиться, что повторный рендер создаёт новый `renders/vNN-<label>/`, не стирая прошлый.
8. Убедиться, что `final/<slug>.mp4` совпадает с последним успешным рендером.
9. При искусственном сбое render/finish/music/publish проверить статус `failed`, прежние
   `latestRender` и canonical final.

Полные команды – в `docs/TEMPLATES.md`.

### Фокусная матрица video b-roll

```bash
node --test \
  tests/media-duration-geometry.test.js \
  tests/media-probe.test.js \
  tests/review-media-import.test.js \
  tests/review-media-process.test.js \
  tests/review-commands.test.js \
  tests/review-draft-save.test.js \
  tests/lesson-brief.test.js \
  tests/render-media-bundle.test.js \
  tests/scene-broll-media.test.js \
  tests/scene-media-sync.test.js

npm run test:review-ui -- --grep \
  "preview position|used interval|boundary slider|committed import|large media|pending validation|m4v|failed media import"
node --test tests/video-broll-e2e.test.js
AUTOMONTAGE_FFMPEG_DIR=/opt/homebrew/opt/ffmpeg-full/bin \
  node --test tests/custom-face-media-real.test.js
```

`custom-face-media-real.test.js` создаёт main video с тоном 440 Hz и двухцветный custom video
с собственным тоном 880 Hz. Три последовательных двухсценовых CLI/Remotion render на реальном
File Provider обязаны показать вторую половину custom video по глобальному таймкоду, сохранить
440 Hz через обе сцены, не добавить 880 Hz и удалить каждый одноразовый bundle. В обычном
`npm test` этот тяжёлый acceptance честно skipped; перед завершением изменения его запускают
отдельной командой без skip.

`media-duration-geometry.test.js` создаёт настоящие пары video 1 s/audio 3 s и video 3 s/audio
1 s, нечётные landscape/portrait и rotation fixture. Проверка требует visual `durationSec`,
отдельный `audioDurationSec`, trim длинного audio, сохранение короткого audio и even geometry
без crop/distortion. Она также доказывает, что короткий audio отклоняет только overrun
`replace` до новой revision/render, а допустимый interval проходит Save → approval → короткий
Remotion render. Тест использует `AUTOMONTAGE_FFMPEG_DIR`, ffmpeg-full на macOS или системные
ffmpeg/ffprobe и пропускается только если этих бинарников действительно нет.

Реальные importer-регрессии генерируют JPEG и VP8/Opus WebM локально в временной папке,
проверяют полный decode нормализованных master/proxy и SHA-256. Настоящий WebM, переименованный
в JPEG, отклоняется по содержимому. Нужна полная сборка FFmpeg с `libwebp`, `libx264`, `libvpx`
и `libopus`: урезанный бинарник FFmpeg внутри Remotion не заменяет зависимость для импорта.

`review-media-import.test.js` отдельно проходит каждую границу свободного места: initial,
master, proxy, preview publication и canonical publication. Для каждой ожидаются один `507`,
owned cleanup и успешный retry; exact quota boundary проходит, превышение после close даёт
`MEDIA_IMPORT_OUTPUT_QUOTA_EXCEEDED`, а опасная арифметика отклоняется до запуска encoder.

Последняя команда — обязательный локальный acceptance без mock ffmpeg, Remotion, Review server,
Save, approval или render bundle. Она сама создаёт маленькие JPEG/silent/audio fixtures и
временный project под `tmp/video-broll-acceptance/`, проходит настоящий браузерный upload,
Save → Approve → Render, полностью декодирует итог, делает ffprobe, измеряет тоны до/внутри/после
`replace`, сверяет старые bytes/manifest entries и пишет `evidence/contact-sheet.png` +
`evidence/result.json`. Успешный dedicated run обязан показать `1 pass, 0 fail, 0 skip`; отсутствие
`libwebp` является ошибкой окружения, а не основанием пропустить acceptance.

Тяжёлый E2E-файл намеренно отмечается skipped только внутри общего `npm test`, чтобы обычный
Node CI не требовал Chromium/Remotion render и Homebrew-сборку ffmpeg. Это не completion gate:
перед завершением feature его всегда запускают отдельной командой выше.

## 6. Визуальная и медиапроверка финала

Для заметного изменения сцен или пайплайна:

- сделать still/короткий рендер до полного;
- посмотреть начало, каждую смену сцены, середину и финал;
- проверить обе ориентации, если менялась адаптивная раскладка;
- убедиться, что лицо, текст и маркеры соцсетей внутри safe-zone;
- сравнить A/V-синхрон в начале, середине и конце;
- декодировать итог целиком через ffmpeg и проверить параметры через ffprobe;
- проверить громкость и отсутствие обрыва музыки/голоса.

`pack-tg.js` требует video и audio stream с конечными start/duration. Разница start или
duration в 80 мс и больше является ошибкой с ненулевым exit code; 79 мс ещё проходит.

Готовность означает не только зелёные тесты: итоговый MP4 должен открываться, полностью
декодироваться и визуально соответствовать утверждённому монтажному листу.
Для chunk-render отдельно сверяется `nb_read_frames`: он должен точно равняться запрошенному
`totalFrames`, включая последний неполный chunk.

Для локальной миграции существующего ролика дополнительно проверяется наличие исходника,
истории brief, всех перенесённых версий рендера, превью и принятого финала в одной игнорируемой
project-папке. Старые артефакты в `out/` при миграции не удаляются.

### Preview/final equivalence и benchmark

```bash
npm run test:video-edit
node --test tests/preview-final-equivalence.test.js
node scripts/benchmark-preview.js \
  --fixture 'horizontal-60s::/absolute/horizontal.props.json::/absolute/horizontal/public' \
  --fixture 'vertical-60s::/absolute/vertical.props.json::/absolute/vertical/public' \
  --output /tmp/automontage-preview-benchmark.json
```

Каждый benchmark выполняет cold preview, второй warm preview и final через одну композицию
`ReelScenes` и одинаковый `finish.js`; в preview меняются только утверждённые scale 0.5, CRF 28
и watermark. Поля времени измеряют wall clock именно Remotion render-фазы: общий finishing всё
равно выполняется и его результат участвует в equivalence, но почти постоянная аудиообработка не
выдаётся за ускорение графического рендера. `previewToFinalRatio` равен
`previewWarmMs / finalMs`, поэтому критерий «не менее чем вдвое быстрее» означает значение
`<= 0.5` отдельно для horizontal и vertical 60-second fixture. JSON с машинными временами
остаётся локальным и не коммитится.

Для трёх контрольных таймкодов preview масштабируется до final geometry алгоритмом Lanczos.
На обоих кадрах чёрным закрывается только документированная верхняя правая зона watermark:
30% ширины × 16% высоты; всё остальное сравнивается через FFmpeg SSIM. Порог `0.965` учитывает
половинный raster и H.264, но достаточно строг, чтобы падать при другой раскладке, тексте,
шрифте, b-roll frame или цветах темы. Любой один кадр ниже порога делает gate красным.

## 7. CI

`.github/workflows/ci.yml` сохраняет обычный Node 20 job с `npm ci`, `npm run check:privacy`,
`npm test` и `npm run check:release` на pull request и push в `main`. Отдельный browser job выполняет
`npm ci --no-audit --no-fund`, устанавливает Playwright Chromium и запускает
`npm run test:review-ui`. Оба Linux job явно устанавливают системный FFmpeg, проверяют
`ffmpeg`, `ffprobe`, `libwebp`, `libx264`, `libvpx`, `libopus` и AAC до тестов: отсутствие
реального media toolchain является ошибкой окружения, а не скрытым skip. Поэтому browser setup
не может скрыть обычную Node-регрессию. Windows job ставит фиксированный FFmpeg 7.1.1 с
обязательной проверкой checksum и запускает только переносимые probe/import/recovery/Save/
approval/final-publication tests; полный POSIX-контракт остаётся в Linux `npm test`.
Release-checker проверяет committed current tree без base и работает с shallow checkout.
Отдельный job устанавливает закреплённый Gitleaks CLI и сканирует полную Git-историю на секреты
без отдельной лицензии GitHub App для организации.
Полные рендеры в CI не запускаются: им нужны тяжёлые медиа, ffmpeg/Whisper-модели и
иногда приватные темы. Их проверяют локально по разделам выше.

## 8. Release candidate

```bash
npm run check:release
npm run check:release -- --tree HEAD --base origin/main
npm run check:release -- --release
npm run smoke:release
npm run test:review-ui
npm pack --dry-run
```

Перед commit можно проверить именно staged candidate, а не рабочую папку:

```bash
CANDIDATE_TREE="$(git write-tree)"
node scripts/check-release.js --tree "$CANDIDATE_TREE" --base <release-base>
# Для публикации добавь --release и заранее опустоши [Unreleased].
```

`check:release` читает файлы через `git ls-tree`/`git show`, поэтому проверяет точный
Git-объект и игнорирует незакоммиченные пользовательские файлы. Обычный development-check
разрешает pending notes в `[Unreleased]`; флаг `--release` включает строгую проверку кандидата.
Current-tree правила
сверяют версию, Node engines, env-декларации, локальные Markdown-ссылки, приватные id,
версионные release notes, security exception и полный бинарный инвентарь `ASSETS.md`. Для release candidate
`CHANGELOG.md` обязан содержать ровно одну dated-секцию текущей версии вида
`## [X.Y.Z] - YYYY-MM-DD` с реальной UTC-календарной датой; `[Unreleased]` в этот момент полностью пуст.
В version section нужны хотя бы один `###` подраздел и bullet, а для patch-версии – `### Исправлено`.
Каждый tracked public binary (изображение, видео, аудио или шрифт) требует полную строку с repo-relative
путём в `ASSETS.md`. Исключение `node-vibrant` должно содержать ровно один machine-readable
`json security-exception` fence с проверяемыми `reviewedAt` (реальная календарная дата) и `reviewedFor`,
в точности равным текущей версии `package.json`. `reviewedAt` не может быть будущей или перенесённой
со старой даты релиза; chain содержит ровно пять записей и выводится повторно из candidate
`package-lock.json`, а не принимается только со слов `SECURITY.md`.
При наличии `--base` добавляется diff-проверка
публичной пунктуации; если history/ref недоступен, ошибка содержит команду fetch.

`smoke:release` с удалённым из дочернего окружения `THEMES_EXT` рендерит 75 кадров
`examples/lesson-neutral-approved.json`, затем через project API создаёт отдельный Dynamic
workspace и рендерит его через `--project-dir`. Для обоих финалов обязательны video/audio,
A/V drift меньше 80 мс, ровно 75 кадров и полный decode. У project-финала SHA-256 должен
совпасть с `renders[]`-версией, выбранной `latestRender`. Скрипт оставляет артефакты для
осмотра, печатает два абсолютных final path и подтверждает неизменность защищённых
`src/data/captions.js` и `src/data/transcript.json`.

### Чистый клон кандидата

Финальная проверка выполняется не в рабочей папке, а из нового локального clone без hardlinks:

```bash
RELEASE_CHECK_DIR="$(mktemp -d)"
git clone --local --no-hardlinks . "$RELEASE_CHECK_DIR/AutoMontage-Agent"
cd "$RELEASE_CHECK_DIR/AutoMontage-Agent"
npm ci --no-audit --no-fund
npm run doctor
npm run check:privacy
npm run check:release
npm audit --audit-level=high
npm test
npm run demo
npm run smoke:release
npm pack --dry-run
```

`tests/package-privacy.test.js` отдельно читает реальный npm packlist: публичные CLI, batch-guide,
skill и `.env.example` обязаны присутствовать, а `docs/superpowers/`, project workspace, рендеры
и локальная память обязаны отсутствовать. Это закрывает файлы, которые не отслеживаются Git, но
физически лежат рядом с checkout и без `.npmignore` могли бы попасть в архив.

Проверь начало, середину и конец neutral demo: в кадре и звуке не должно быть человека,
клиентского скриншота, частной темы или логотипа без строки в `ASSETS.md`. В отчёт релиза
попадают только общие результаты команд; локальные каталоги, имена исходников и hashes клиентов
не копируются.

## 9. Проверка секретов и зависимостей

```bash
npm run check:privacy                         # всё отслеживаемое публичное дерево
node scripts/check-public-privacy.js --staged # точные bytes будущего коммита
gitleaks git --staged --redact=100      # что готовится в ближайший коммит
gitleaks git . --log-opts=--all --redact=100  # вся история и все локальные ветки
npm audit                               # известные проблемы зависимостей
```

`check:privacy` блокирует клиентские project/output/memory-файлы, приватные `.env`, абсолютные
локальные пути и бинарные медиа без полной шестиколоночной записи в `ASSETS.md`. Режим
`--staged` читает содержимое прямо из Git index, поэтому безопасная незакоммиченная копия файла
не может скрыть утечку в staged blob. Gitleaks решает другую задачу: ищет API-ключи, токены и
пароли. Перед публичным коммитом обязательны обе независимые проверки.

Перед публикацией npm-архива дополнительно запускай `npm pack --dry-run` и
`node --test tests/package-privacy.test.js`: Git privacy gate проверяет репозиторий, но не является
списком содержимого package tarball.

Локальный `.githooks/pre-commit` сначала выполняет staged privacy-check, затем Gitleaks.
Активировать hook один раз: `git config core.hooksPath .githooks`. Реальное совпадение нельзя добавлять в
allowlist: сначала удалить секрет из staged-файлов и немедленно перевыпустить ключ, если
он уже успел попасть в коммит или удалённый репозиторий.

CI блокирует high/critical уязвимости командой `npm audit --audit-level=high`.
Dependabot еженедельно проверяет npm-пакеты и используемые GitHub Actions. Все actions в
workflow закреплены по неизменяемому commit SHA, чтобы плавающий тег нельзя было незаметно
подменить.

Полный `npm audit` сейчас должен показывать ровно пять moderate записей по одной цепочке
`node-vibrant -> @vibrant/image-node -> @jimp/custom -> @jimp/core -> file-type` и ноль
high/critical. Исключение действительно только в форме, описанной в
[`SECURITY.md`](SECURITY.md), и автоматически истекает по `revisitBy`. После изменения
dependency tree, advisory severity или входа `--autotheme` документ и release gate нужно
пересмотреть вместе. `npm audit fix --force`, major override и downgrade на 3.x не являются
проверенным исправлением для этого релиза.


## 10. B-roll Discovery: локальный acceptance

Все быстрые контракты работают без ключа Pexels. HTTP fixtures проверяют официальный формат
ответа через явно внедрённый тестовый transport; production host/DNS admission остаётся включён.
В CI нет live-поиска, ключей и платных вызовов.

```bash
node --test tests/broll-intent.test.js
node --test tests/broll-remote.test.js tests/broll-pexels.test.js tests/broll-candidates.test.js tests/broll-config.test.js
node --test tests/broll-provenance.test.js tests/broll-text-scan.test.js tests/review-imported-assets.test.js tests/review-media-import.test.js tests/review-media-process.test.js
node --test tests/broll-discovery.test.js tests/broll-review-security.test.js tests/broll-approval.test.js
node --test tests/broll-preview-approval.test.js
node --test tests/broll-render-env-security.test.js tests/env.test.js
npm run test:review-ui
node --test --test-concurrency=1 tests/broll-preview-e2e.test.js tests/video-broll-e2e.test.js tests/custom-face-media-real.test.js
node scripts/broll/live-acceptance.js
```

Нужна полная сборка FFmpeg с WebP/H.264/VP8/Opus/AAC, а для нативного OCR - Tesseract с локальным
`eng` language pack. На Ubuntu CI устанавливает `ffmpeg tesseract-ocr tesseract-ocr-eng`.
Отсутствующий OCR не препятствует поиску/Save/preview, но даёт `unavailable` и требует явного
разрешения после просмотра перед approval. Проверка отсутствующего инструмента выполняется
отдельным тестом всегда; пропуск нативного OCR-теста должен быть явно отражён в отчёте.

`npm run test:review-ui` включает прежний ручной импорт и новую полку. Настоящий E2E отдельно
проверяет выбранный локальный asset, сохранение draft, excerpt/full Remotion, явный approval,
final render и полный decode. Такие рендеры запускаются последовательно, чтобы не делить legacy
render временные файлы. Успех mock-плеера не засчитывается как Remotion acceptance.

Live-команда без ключа печатает ровно `SKIPPED: PEXELS_API_KEY is not configured`.
Это единственный пропуск внешнего acceptance; локальные unit, HTTP contract и браузерные проверки
продолжаются. При ключе команда выполняет бесплатный поиск фото/видео и ограниченный preview.
Полную rendition она импортирует только при явном `--select image:<id>` или `--select video:<id>`
и `--project-dir <fixture-project>`. Она не утверждает brief и не рендерит финал.

Для необязательного semantic reranker есть отдельный [воспроизводимый эксперимент](docs/research/2026-09-08-broll-reranking-benchmark.md).
Его Python/model dependencies не входят в основной монтаж или CI; текущий default - релевантность
провайдера. Openverse-эксперимент не заменяет live acceptance Pexels.

## MotionReel: сцены, тайминг и кириллица

Быстрые проверки без браузера:

```bash
node --test tests/motion-brief.test.js tests/motion-timing.test.js tests/motion-render.test.js
```

Проверяются metadata из narration props, единственный root Audio, глобальные Sequence,
локальная последовательность node → connector → node, точное завершение счётчика,
однокадровые сцены, семь контрактов на максимальной длине кириллицы, caption opt-in,
watermark и media trim/mute/replace.

Обязательная при изменении motion-layout проверка настоящим Remotion/Chromium:

```bash
AUTOMONTAGE_TEST_MOTION_RENDER=1 \
AUTOMONTAGE_MOTION_FRAMES_DIR="$PWD/out/motion-frames" \
node --test tests/motion-render.test.js
```

На macOS перед запуском использовать полный FFmpeg:
`PATH=/opt/homebrew/opt/ffmpeg-full/bin:$PATH` и
`AUTOMONTAGE_FFMPEG_DIR=/opt/homebrew/opt/ffmpeg-full/bin`.
Тест генерирует локальные PNG/WAV fixtures без ключей, получает реальную metadata MotionReel,
рендерит все семь сцен с максимальным текстом и ещё раз с длинными непрерывными `Щ` и
явной подписью. Проверяет DOM-границы текста, caption и safe-zone, а также одну строку
для числа. Дополнительные кадры показывают ранний hook, шаги/connector, середину счётчика
и вход CTA. PNG и `layout-measurements.json` остаются в указанной игнорируемой папке;
без неё артефакты временные. Проверка отключена в обычном Node suite, чтобы тот не требовал
Chromium и полного FFmpeg; перед завершением renderer-задачи её запускают отдельно.


## Motion workflow: audio → preview → approval → final

```bash
node --test tests/motion-workflow.test.js tests/review-compatibility.test.js tests/qa-preview.test.js tests/cli.test.js
AUTOMONTAGE_TEST_MOTION_WORKFLOW=1 node --test tests/motion-workflow-media.test.js
```

На macOS media-проверки запускаются с FFmpeg, содержащим нужные codecs:
`PATH=/opt/homebrew/opt/ffmpeg-full/bin:$PATH` и
`AUTOMONTAGE_FFMPEG_DIR=/opt/homebrew/opt/ffmpeg-full/bin`.

Быстрые проверки покрывают CLI, local transcription scaffold, draft watermark, stored-kind
маршрутизацию, обязательный полный просмотр, hashes narration/draft/preview, byte-immutable
approved JSON, labels/history, rollback, stale QA/Review, media symlink/hash и защищённую музыку.
Регрессии гонок проверяют narration A→B→A при копировании preview и поздние правки approved/draft
во время последнего narration hash, fsync MP4, rename MP4 и fsync manifest. При отказе сохраняются
прежний final и `latestRender`, а созданные staging/backup-файлы удаляются.
Motion Review дополнительно проверяется через настоящий HTTP server: audio MIME, безопасный
state и отказ от неподдержанных edit-команд. Legacy lesson tests остаются обязательными.

Opt-in media regression создаёт WAV и MP4 локально, вызывает настоящие CLI preview/approval/final
и проверяет все семь типов сцен, 1080×1920/30 FPS/9 sec, полное декодирование и narration audio.
Цвет пикселя доказывает `trimStartSec=1`; спектр 440/880 Hz проверяет mute/mix/replace и возврат
озвучки после replace. Девять контрольных кадров и draft watermark сохраняются при заданном
`AUTOMONTAGE_MOTION_E2E_DIR` (каталог должен существовать); без него временные файлы удаляются.
Никаких provider calls, ключей или личных медиа этот тест не требует.

## Необязательная ElevenLabs-озвучка

```bash
node --test tests/elevenlabs-voice.test.js tests/public-privacy.test.js tests/broll-render-env-security.test.js tests/cli.test.js
```

Тесты ElevenLabs обращаются только к локальному mock HTTP server: проверяются официальный путь
и request shape, base64, кириллица/Unicode, canonical word timing, ключ кэша, отсутствие повторного
запроса при cache hit, явное согласие на расходы, timeout до headers/во время body, HTTP/network
ошибки без секретов, redirects и конкурирующие запросы. Готовый кэш проверяет hashes аудио/слов;
испорченный или незавершённый кэш останавливает работу. Подмена workspace и удаление `.gitignore`
во время ответа не позволяют опубликовать provider output. Privacy tests читают staged bytes,
ловят непустые настройки в env/JSON и оставляют пустые примеры рабочими. Реальный Remotion env
loader проверяет отсутствие ElevenLabs key/voice ID в браузере. Live API и оплаченных тестов нет.

Cache security-регрессии подменяют cache directory на symlink перед temp open, удаляют ignore
при записи аудио, при публикации receipt и последнем directory fsync. Отказ не оставляет
provider outputs снаружи или незавершённые опубликованные файлы внутри. Instrumented filesystem
проверяет fsync полной новой цепочки, parent entries, ignore и attempt до fetch и каталога кэша
после final links (directory fsync применяется на POSIX). Отдельная подмена кэшированного аудио
на первом probe не допускает words/draft с чужой записью. Staged privacy проверяет многострочные
YAML values и TOML triple-quoted strings рядом с пустыми значениями и placeholders.

## Офлайн motion-reel demo и публичный навык

```bash
node --test tests/motion-demo.test.js tests/neutral-fixtures.test.js tests/public-privacy.test.js
automontage demo --motion
automontage preview --project-dir projects/motion-demo --brief brief/v01-draft.motion.json
node scripts/qa-preview.js --project-dir projects/motion-demo
```

Демо генерирует 27 секунд mono PCM WAV (тестовые тоны, не речь), нейтральную PNG и
иллюстративные таймкоды. JSON проходит настоящую motion schema; порядок содержит ровно
`kinetic-title`, `card`, `steps`, `list`, `counter`, `media`, `cta`. Команда создаёт только
audio-only draft, без Whisper, API, approval и final. Существующий workspace не изменяется;
для нового прогона передай `--project-dir projects/motion-demo-2`.

Регрессии проверяют, что копируемая подсказка для POSIX shell сохраняет обычные имена, пробелы,
апострофы, буквальные `$()`, backticks и `$VARIABLE` как один аргумент. Строка не исполняется
внутри движка или тестов: реальная CLI получает argv. Отдельный тест использует настоящие
renderer-функции и требует минимум 0,75 секунды полной видимости всех nodes/connectors/items
перед концом демо-сцен `steps` (5 секунд) и `list` (7 секунд).

Тесты также проверяют hash сгенерированного media, детерминизм текстовых/binary fixtures,
одинаковые SKILL.md/reference в `skills/`, `.agents/skills/`, `.codex/skills/`, раннюю маршрутизацию
из `reel-turnkey` и ссылки на команды/сцены в документации. Медиа не добавляются в Git.

Проверка реального публичного CLI от demo до final (только нейтральные fixtures; тест сам
выполняет отдельный approval как тестовый сценарий):

```bash
AUTOMONTAGE_TEST_MOTION_DEMO=1 node --test tests/motion-demo.test.js
```

В обычной работе после просмотра полного preview требуется явное утверждение пользователя:

```bash
node scripts/project/approve-brief.js projects/motion-demo brief/v01-draft.motion.json --confirm-preview-viewed
automontage motion --project-dir projects/motion-demo --brief brief/v01-approved.motion.json --version-label reviewed
ffprobe -v error -show_streams -show_format -of json projects/motion-demo/final/neutral-motion-demo.mp4
ffmpeg -v error -i projects/motion-demo/final/neutral-motion-demo.mp4 -f null -
```

Ожидание: H.264/AAC, 1080×1920, 30 FPS, 27 секунд и ровно один аудиопоток; полный decode без
ошибок. Проверь кадры каждой сцены, чтение кириллицы, постепенные steps, точный counter и CTA,
watermark только в preview. Синтетические тоны проверяют целостность аудиопути; они не доказывают
качество реальной речи. Клиентский final нужно дополнительно смотреть/слушать целиком.
Для сохранения артефактов E2E установи `AUTOMONTAGE_MOTION_DEMO_DIR` в существующий локальный
игнорируемый каталог; без переменной временные файлы очищаются.

Node packages, FFmpeg и Remotion browser должны быть установлены заранее. Первая загрузка
browser может требовать интернет; после подготовки тест/демо не обращаются к провайдерам,
не используют `.env` и не скачивают Whisper. На Windows переменные opt-in задаются обычным
синтаксисом PowerShell (`$env:AUTOMONTAGE_TEST_MOTION_DEMO = '1'`). Расписание и автопубликация
не тестируются: это будущий отдельный слой за пределами движка.
