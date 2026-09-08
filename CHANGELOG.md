# История изменений

Формат близок к Keep a Changelog, версии следуют SemVer. Здесь только заметные изменения
поведения; полный журнал разработки остаётся в Git.

## [Unreleased]

### Добавлено

- Публичный `motion-reel` workflow: канонический навык и одинаковые adapters для Claude/Codex,
  маршрут без камеры из `reel-turnkey`, согласование script/озвучки, timed brief, preview,
  явное approval, final и QA. README, архитектура, templates, каталог и простой guide синхронизированы.
- `automontage demo --motion` создаёт credential-free audio-only draft со всеми семью motion-сценами,
  локально сгенерированными тестовыми тонами и нейтральной PNG. Существующие папки сохраняются;
  preview и approved-only final запускаются отдельно. Расписание и автопубликация остаются вне движка.

- Необязательная ElevenLabs-озвучка motion по `--script --voice elevenlabs --accept-provider-cost`:
  приватный голос без repository default, проверенный локальный кэш и таймкоды слов без Whisper.
  Timeout/неоднозначный сбой не повторяет платный запрос; privacy gate блокирует provider secrets,
  voice ID в конфигурации и опубликованные narration caches. Путь с готовым аудио остаётся без ключей.

- `automontage motion <audio> --project` создаёт локальный transcript/scaffold; continuation
  по approved brief рендерит отдельные версии MotionReel через общий finish/ducking и QA.
  Preview/Review выбирают композицию по stored kind. Motion approval обязателен после полного
  просмотра и связывает draft/preview/narration hashes; exact approved bytes закреплены в manifest.
  Read-only motion Review показывает scene copy без host paths, hashes и provider settings.
- Регрессия настоящего motion MP4 проверяет все семь типов сцен, video trim и audio mute/mix/replace.
  Dedicated audio probe теперь определяет duration WAV/MP3 больше 64 KiB через seekable cache.

- Camera-free композиция `MotionReel` с семью публичными сценами: kinetic title, card,
  steps, list, counter, media и CTA. Единая narration-дорожка, независимая нейтральная тема,
  покадровые анимации, opt-in captions и подгонка плотной кириллицы внутри сейф-зоны.

### Исправлено

- Инициализация motion из локального аудио теперь создаёт проект внутри `projects/` текущей
  папки, как ElevenLabs и demo; явный `--project-dir` сохраняет прежнее поведение.

- Усилены границы ElevenLabs cache: guard до записи provider bytes, rollback до последней
  проверки, fsync новых папок/ignore/receipt и сверка фактически скопированного narration с
  receipt до draft. Privacy gate также закрывает multiline YAML и TOML voice-ID assignments.

- Motion preview связывает narration hash с фактически скопированными bytes и отклоняет подмену
  аудио на время snapshot. Final повторяет общий контроль approved/draft/preview/narration
  после digest-проверок и при публикации; поздняя правка откатывает MP4 и сохраняет `latestRender`.

## [1.6.0] - 2026-09-08

### Добавлено

- Добавлены реальные синтетические JPEG/WebM-регрессии импорта и проверка отказа для видео,
  переименованного в JPEG; бинарные fixtures в репозиторий не добавляются.
- Поиск фото и видео через официальный Pexels API в Review Workbench: намерение B-roll в
  draft, полка кандидатов, ручной выбор, безопасный локальный импорт и provenance.
- Локальная OCR-проверка встроенного текста и подтверждение, привязанное к выбранному медиа.
- Для нового discovery-процесса обязательны актуальный полный Remotion-preview и явное
  подтверждение просмотра перед approval. Основной монтаж и ручной импорт сохраняются без ключей.
- Добавлена простая пошаговая инструкция от исходного видео до утверждения и final render,
  включая настройку Pexels, выбор B-roll и объяснение разницы между Save и preview.

### Безопасность

- Все engine-запуски Remotion явно используют пустой публичный env-файл: приватные поля
  `.env` и `.env.local`, включая ключ поиска Pexels, больше не попадают в браузер рендера.
  Проверены реальные preview/final и окружение установленного CLI для chunks/still.
- Удалённая загрузка B-roll принимает только HTTPS-хосты провайдера, перепроверяет DNS и каждый
  redirect, ограничивает размер и MIME, а выбранный файл публикует только через quarantine,
  полный decode, нормализацию и SHA-256. Браузер работает с opaque candidate ID, связанными
  с Review-сессией и ограниченными по времени.
- Release gate проверяет дату security-review по единой мировой календарной границе UTC+14,
  поэтому локальная подготовка после полуночи и проверка в UTC CI дают одинаковый результат.

### Исправлено

- Выбор найденного B-roll теперь показывает обновляемое время загрузки и локальной проверки,
  поэтому обработка большого видео не выглядит как зависший интерфейс.

## [1.5.0] - 2026-09-06

### Добавлено

- Добавлен публичный пакетный workflow для нескольких Reels и hook-family: отдельный workspace
  на каждый выход, параллельная подготовка, последовательный финальный рендер, единый пакет
  согласования и независимый QA каждой версии.
- Навык `reel-turnkey` теперь фиксирует практические правила вертикального Reels: спикер виден в
  первые 2–3 секунды, сомнительные дубли сохраняются, на ролик 2–3 минуты планируются 3–5
  поэтапных векторных объяснений, а сравнимые цифры показываются на общей шкале.
- Добавлен детерминированный генератор нейтральных transcript/captions/props fixtures, чтобы
  публичное демо можно было воспроизвести без клиентской речи и ручной правки данных.

### Безопасность

- Добавлен независимый privacy gate для tracked-дерева и точных staged blobs. Он блокирует
  клиентские project/output/memory-файлы, личные абсолютные пути, приватные `.env` и бинарные
  медиа без полной записи происхождения в `ASSETS.md`; проверка работает в pre-commit и CI.
- npm-архив получил отдельную allow-by-exclusion границу: локальные implementation plans,
  workspace, память и рендеры не попадают в пакет даже когда существуют только вне Git index.
- CI запускает закреплённый Gitleaks CLI без организационной лицензии и обновляет
  транзитивный `fast-uri` до исправленной версии 3.1.7.
- Умеренная transitive-уязвимость `file-type` повторно проверена для 1.5.0: high/critical
  findings отсутствуют, ограниченное исключение для локального `--autotheme` действует до
  2026-10-06 и не считается исправлением зависимости.

### Исправлено

- Исторические demo transcript, captions, props и scenario adapters заменены нейтральными
  синтетическими данными; из публичных архивных документов удалены клиентские упоминания.
- Legacy demo-композиции используют длительность нейтрального источника и больше не ссылаются
  на прежний реальный текст.
- Добавлен regression test содержимого `npm pack`, который требует публичный CLI, batch-guide и
  skill, но отклоняет локальные планы и артефакты.

## [1.4.0] - 2026-08-23

### Добавлено

- Стандартный монтаж под ключ теперь явно использует текущую подписку Claude Code/Codex и
  локальный faster-whisper: агент не запрашивает provider API-ключи для draft, preview, Review,
  approval, render или QA. OpenAI API остаётся только отдельным подтверждаемым opt-in для явно
  заказанной генерации изображений, когда текущая модель не умеет выполнить её сама.
- Команда `automontage master` выпускает immutable source/transcript revision из frame-aligned
  keep-ranges, сохраняет оригинал и пересчитывает таймкоды слов без повторного Whisper.
- Добавлены каталог возможностей семи официальных lesson-сцен и горизонтальный/вертикальный
  golden draft: они фиксируют варианты сцены, настоящий video b-roll, fit/trim/mute, безопасные
  зоны и финальный переход заголовка в центр.
- `npm run qa:preview` проверяет SHA-256, полный decode, формат, длительность, первый/последний
  кадр, отдельные уровни голоса и ducked music и неизменность final history.
- Локальный benchmark двух насыщенных 60-секундных `ReelScenes` fixtures измерил Remotion-фазу
  после текстовой правки: horizontal warm preview 25 768 мс против final 61 765 мс (ratio 0,417,
  ≈2,40×), vertical 35 316 мс против 93 025 мс (ratio 0,380, ≈2,63×). Finished-контрольные
  кадры после масштабирования и маски только watermark дали SSIM 0,968–0,992 при пороге 0,965.

- Отдельная команда `automontage preview` собирает текущий lesson draft настоящей композицией
  `ReelScenes` с теми же сценами, темой, шрифтами и аудиопорядком, но в половинном разрешении,
  с CRF 28 и отметкой «ЧЕРНОВИК». Полный ролик или точный фрагмент публикуется как immutable
  revision и один атомарный `previews/current-preview.mp4`, не затрагивая final render history.
- Review Workbench явно разделяет **«ИСХОДНИК»** и **«СМОНТИРОВАННЫЙ ПРЕДПРОСМОТР»**,
  показывает full/excerpt range и выдаёт preview только через token-protected, ranged,
  identity- и SHA-256-проверяемый media route.

- Горизонтальная lesson-сцена `fullscreen` получила вариант `side-overlay`: исходный кадр со
  спикером остаётся полноэкранным, а заголовок и лёгкая анимированная последовательность
  автоматически занимают свободную сторону напротив `facePos` без презентационной карточки.
- `side-overlay` поддерживает `stepStartsSec`, чтобы каждый пункт появлялся на точном смысловом
  таймкоде речи, а не обязательным быстрым каскадом в начале сцены.
- Lesson-сцена `broll` поддерживает `showSpeakerPip: false` для полноэкранного скринкаста без
  окна спикера; браузерный visual preview следует тому же флагу, что и Remotion renderer.
- Финальный `fullscreen/side-overlay` поддерживает `centerOnFade`: заголовок плавно переезжает
  из свободной стороны в центр кадра в течение последней секунды.

### Документация

- Добавлена полная пошаговая инструкция Review Workbench: создание draft, работа с монтажом и
  b-roll в браузере, Save новой ревизии, отдельные approval/render и проверка финального MP4.

### Исправлено

- Golden drafts различают project-local screencast и реально отслеживаемое публичное изображение,
  поэтому не ссылаются на отсутствующие assets репозитория.
- Генерация lesson-ТЗ через OpenAI использует минимальную глубину рассуждения GPT-5, чтобы
  структурный JSON успевал вернуться до 60-секундного idle reset в VPN-сетях.

## [1.3.0] - 2026-08-22

### Добавлено

- Approved lesson снова поддерживает локальный custom `scene.faceSrc` из project `assets/...`
  или repository `public/`: каждый video попадает в одноразовый render bundle, сохраняет
  глобальный таймкод и не меняет main audio.
- Review Workbench загружает AVIF/GIF/JPEG/PNG/WebP и MP4/MOV/M4V/WebM прямо в текущую
  project-папку, показывает authenticated image/video preview и не назначает новый asset сцене
  без отдельного выбора пользователя.
- Video b-roll поддерживает `contain`/`cover`, покадровый старт и режимы `mute`, `mix` и
  `replace`; один immutable ролик можно повторять в нескольких сценах с разными настройками.
- Browser import нормализует image/video master и отдельный video proxy, а approval и lesson
  render повторно проверяют hashes/identity и собирают один одноразовый media bundle перед
  Remotion `Img`/`OffthreadVideo`.
- `automontage doctor` проверяет `libwebp`; отдельную полную сборку ffmpeg можно безопасно
  выбрать через `AUTOMONTAGE_FFMPEG_DIR`, не заменяя системные инструменты.
- Реальный локальный acceptance проходит browser upload → Save → Approve → Render, полный
  decode/ffprobe, контрольные кадры, аудиозамеры и проверку неизменности прежних brief/renders.
- `check:release` разделяет обычную проверку development-дерева с pending `[Unreleased]` и
  строгий режим публикации `--release`, где этот раздел обязан быть пустым.
- Локальный Review Workbench открывает project lesson в read-only timeline с видео, словами,
  сценами и timing audit; token-protected loopback API не вызывает Remotion и не рендерит draft.
- Явный `--edit` разрешает только adjacent boundary и allowlisted b-roll, хранит undo/redo в
  памяти и сохраняет правки новой draft-ревизией без изменения approved.
- Локальный Review Workbench показывает необязательную waveform-дорожку исходника. PNG
  кэшируется внутри project workspace с повторной проверкой identity каталога после ffmpeg;
  отсутствие или ошибка ffmpeg не мешают открыть review.
- Отдельный Chromium job проверяет Review browser flow независимо от обычного Node CI.

### Безопасность

- Custom scene video сверяется с authoritative approved brief, открывается no-follow и проходит
  identity/hash/TOCTOU/File Provider barriers до и после render callback; unsafe path, URL,
  symlink, не-video extension и props mismatch отклоняются до Remotion.
- Main-source alias больше не выводится из props: builder передаёт trusted alias, same-inode
  dedup сверяет полную source identity + SHA-256, а owner-only isolated Remotion `--public-dir`
  позволяет зафиксировать baseline до render callback и запрещает любой последующий ctime drift,
  включая mutation + restore. Три последовательных real renders подтверждают отсутствие File
  Provider false-fail и второго render/history entry.
- Импорт потоково пишет только в owner-only quarantine, проверяет размер, тип, decode,
  геометрию, длительность, свободное место и symlink/file identity; браузер получает только
  opaque id и token-protected routes без project path или media SHA-256.
- Import publication и orphan cleanup теперь держат общий project mutation lease. Durable
  owner/publication records позволяют после hard exit удалить только identity-проверенные
  quarantine/stage/claim bytes; live/foreign/malformed/replaced и name-only UUID остаются нетронуты.
- Stage/claim/canonical identities теперь журналируются до записи bytes, cleanup переносит цель в
  private tombstone до проверки и удаления, а shutdown abort-ит import с bounded SIGTERM→SIGKILL.
- Прямой Review CLI и публичный `automontage review` теперь ждут tracked import-finalizers перед
  exit 130/143; wrapper пересылает сигнал дочернему серверу и не оставляет lease/quarantine orphan.
- Все Review API/media routes требуют случайный session token, POST также проверяет loopback
  Origin; traversal, symlink, oversized body, unknown command и stale session закрываются без
  раскрытия host paths или token.
- Review Save резервирует revision между процессами через exclusive no-follow lock; только один
  конкурент публикует согласованную Markdown/JSON-пару и manifest entry.
- `--no-open` и ошибка browser launch передают bearer URL через временный mode-`0600` файл,
  печатают только путь и очищают owned файл при закрытии сервера, обычном `SIGINT`/`SIGTERM`
  или через 10 минут.
- State, preview, validate и save сверяют исходный device/inode media snapshot; подмена не
  перепривязывает opaque handle к новым байтам.
- Transitive `nanoid` обновлён в lockfile с 3.3.16 до исправленной совместимой 3.3.18; high
  `GHSA-2v37-7h3g-55p8` устранён без direct dependency, override или обновления Remotion.

### Исправлено

- Windows cleanup повторяет только временные `EPERM`/`EBUSY`/`ENOTEMPTY` при удалении
  identity-проверенных пустых tombstone и quarantine root; чужие и недоказанные остатки
  сохраняются, а завершившийся `rmdir`, сообщивший ошибку, согласуется без ложного orphan.
  Rollback setup хранит точные BigInt device/inode, поэтому длинные NTFS file id не округляются
  и не блокируют очистку либо принятие соседнего чужого inode.
- Image и video master normalization полагаются на одинаково включённый по умолчанию
  autorotation, поэтому импорт работает и с системным FFmpeg 6.1, и с более новыми версиями.
- Video import предпочитает корректный `avg_frame_rate`, но безопасно использует
  `r_frame_rate`, когда среднее значение отсутствует, равно `0/0` или невалидно.
- Windows final publication открывает временную копию с правом записи для обязательного
  regular-file `fsync`, не ослабляя последующий atomic rename; внутренний Review logger скрывает
  абсолютный Windows path целиком, включая приватное имя файла после project root.
- Linux Node/Chromium CI явно устанавливает и проверяет полный системный FFmpeg toolchain, а
  Windows job запускает только переносимые media/filesystem cases без POSIX mode/umask/signal
  предположений.
- Legacy project/public изображения ограничены 25 MiB до потокового SHA-256; mutation во время
  чтения и авария setup quarantine больше не приводят к доверию изменённым bytes или удалению
  чужого дочернего файла.
- Review сохраняет позицию video preview при validate/Undo/Redo, показывает вычисленный
  используемый интервал и не сбрасывает плеер после выбора старта.
- Границы получили достижимые frame-inset slider limits, ArrowUp/Down и Home/End, а также точную
  `aria-invalid` подсветку по `sceneIndex`; pending validation объявляет `aria-busy` и блокирует
  все мутации, а длинная media lane прокручивается на 360 px.
- Успешный `201` больше не называется провалом импорта при ошибке следующего refresh: UI сообщает,
  что файл уже добавлен. Browser `.m4v` отправляется как `video/x-m4v`; скрытый file input больше
  не перехватывает Tab, а именованная кнопка сохраняет Enter/Space file chooser.
- Media import теперь считает `durationSec` только по видеопотоку, хранит отдельный
  `audioDurationSec`, обрезает длинный звук по картинке и не разрешает `replace` за концом
  короткого audio; container duration больше не расширяет trim.
- Нечётные и повёрнутые видео получают even padding без crop/distortion, а still image не
  наследует video ceiling 120 FPS.
- Encoder, output и publication copy ограничены рассчитанными budgets и absolute caps;
  свободное место проверяется перед каждой фазой, quota/disk boundary возвращает `507` с
  owned cleanup и безопасным retry.
- Metadata v2 переносит visual/audio durations через registry, Save, restart, approval и render;
  legacy v1 image остаётся совместимым, а неоднозначный v1 video требует переимпорта.
- Save и approval теперь проверяют открытый immutable media descriptor через общий portable
  `ffprobe pipe:0` adapter без `/dev/fd` или live pathname. Windows сохраняет identity/hash/
  containment barriers без ложной зависимости от POSIX mode bits; отдельный CI job проверяет
  реальные media fixtures и Windows filesystem behavior. Directory fsync имеет отдельную
  capability: POSIX сохраняет directory-entry durability flush, а Windows пропускает только
  неподдерживаемый Node open-directory + `fsyncSync` primitive.
- Save, approval и render/brief manifest writers теперь используют один recoverable
  project-wide lease: stale snapshot получает `409`, live/foreign owner не удаляется, а lease
  завершившегося локального PID восстанавливается. Исторические Markdown/JSON публикуются
  no-replace до manifest CAS, поэтому hard exit не оставляет `currentBrief` без JSON.
- Manifest rename теперь имеет однозначный committed outcome без post-rename probe; initial
  lesson/scenario draft выбирает ревизию под тем же lease, а raw manifest update требует expected
  snapshot, поэтому stale writer и destination race не перезаписывают историю.
- Project lesson planning очищает exact identity-pinned generated JSON/Markdown temp-пару после
  успеха и ошибки; foreign replacement сохраняется и завершает операцию fail closed.
- Transient lease-release ошибка повторяется ограниченно; persistent ошибка не маскирует исходный
  import failure и больше не оставляет локальный import controller занятым.
- Render bundle больше не принимает безопасное асинхронное обновление `ctime` от macOS iCloud
  File Provider за подмену файла: новый `ctime` фиксируется только после повторной проверки всех
  остальных identity-полей и стабильного полного SHA-256; digest при сдвиге `ctime` во время
  чтения отбрасывается, а реальные same-size/append/overwrite изменения по-прежнему отклоняются.
- AVIF с ISO-BMFF brand теперь распознаётся как изображение, а обычное AV1-видео, лишь
  переименованное в `.avif`, по-прежнему отклоняется; непрозрачный GIF больше не считается
  обязанным сохранить отсутствующий alpha-канал.
- Acceptance проверяет вложенные поля server log на произвольные host paths и неожиданные
  media/proxy SHA-256 и проходит реальный безопасно санитизированный ответ `500`.
- Убрана прозрачность 0 на первом кадре сцены: прежний fade-in без перекрытия создавал пустой
  тёмный кадр на каждом cut между b-roll-сценами.
- Save повторно проверяет manifest/base snapshot, блокирует controls на время commit и после
  успеха принимает только серверную ревизию; validate/save conflict немедленно очищает
  active/redo stacks и блокирует мутации до успешной загрузки fresh state и явного discard.
  Ошибка reload сохраняет quarantine без silent rebase, auto-retry или stale replay.
- Новая draft-ревизия публикуется как Markdown -> JSON -> manifest с повторным manifest CAS,
  поэтому reader не видит ссылку на ещё не опубликованный JSON; rollback не изменяет approved
  или исходный draft.
- `/api/state` перечитывает внешнюю draft-ревизию с диска, сохраняя id неизменных assets; после
  `409` браузер показывает свежую ревизию, а следующая команда не содержит устаревший replay.
- B-roll capability ограничена поддерживаемыми renderer изображениями; аудио/видео отклоняются
  API, approval и render validation, оставаясь доступными в общей preview lane.
- Финальный контракт 1.3.0 заменил это промежуточное image-only ограничение: нормализованный
  video b-roll проходит API, approval и render; неподдерживаемым остаётся audio-only asset.
- Timing audit выдаёт отдельные frame/word suggestions, drag сохраняет word snap, а Arrow
  накапливает покадровое движение и сохраняет focus/undo.

## [1.2.1] - 2026-08-05

### Исправлено

- Закрыт выход manifest-controlled путей, небезопасных slug/legacy id и `--outdir`-финала
  за разрешённые каталоги; path resolver отклоняет также dangling symlink на любом компоненте,
  а общий lesson/Dynamic export не следует static final или parent symlink.
- `project.json` публикуется через непредсказуемый exclusive temp, а утверждение brief атомарно
  согласует JSON, Markdown и manifest с cleanup/rollback при ошибке записи.
- Исходник каждого render получает отдельную public media lease вместо общего `public/source.mp4`;
  legacy scene-level `faceSrc` переводится на тот же lease, что top-level video/audio.
- Chunk cache инвалидируется при изменении Remotion-кода, lockfile, обычного public asset path
  или его байтов; случайный путь нормализуется только для generated source lease, включая
  источник без расширения и с непривычным расширением.
- Дробные FPS исходника, включая 30000/1001 и 24000/1001, передаются в Remotion без округления.
- Утверждённый Markdown brief регенерируется из approved JSON и больше не сохраняет статус draft.
- Release checker проверяет актуальную секцию версии, расширенный provenance бинарных файлов,
  свежую не будущую дату security review и точную dependency chain из candidate `package-lock.json`.

## [1.2.0] - 2026-08-05

### Добавлено

- Каноническая документация проекта: `AGENTS.md`, `ARCHITECTURE.md`, `TESTING.md`,
  `DECISIONS.md`, `.env.example` и CI.
- Локальные workspace-папки `projects/YYYY.MM.DD_<slug>/` с одним исходником, отдельным
  транскриптом, версиями brief/рендеров и каноническим final.
- Флаги `--project`, `--project-dir`, `--version-label` и команда фиксации approved brief.
- Project-режим для `lesson/ReelScenes` и `Dynamic` без изменения legacy-вывода в `out/`.
- Правила локальной трёхуровневой памяти для продолжения работы между сессиями.
- Двухслойная защита секретов: локальный pre-commit Gitleaks и полный Gitleaks-скан
  истории в GitHub Actions.
- GitHub Actions закреплены по commit SHA; Dependabot следит за npm и actions, а CI
  блокирует high/critical уязвимости зависимостей.
- В GitHub включены встроенные Secret Scanning, Push Protection и Dependabot Security Updates.
- Шаблон `lesson-presentation` с внешними темами и адаптивом 9:16/16:9.
- Библиотека из 7 официальных сцен и отдельный `ReelScenes`-режиссёр.
- Двухступенчатый процесс draft-ТЗ → явное утверждение → approved-рендер.
- Автоматический проруф, Markdown/JSON brief, словарь исправлений и проверенное кадрирование лица.
- Музыка в approved brief, выбор стартового фрагмента и скорости, анимации воронки,
  логотипов, CTA и живого градиента.
- `automontage doctor`, глобальный CLI и воспроизводимое демо без ключей.
- Общий checked process runner, строгий ffprobe parser и запуск локального Remotion CLI
  через текущий Node без `.cmd`, shell или fallback на скачивание через `npx`.
- Машинно проверяемый `ASSETS.md` с происхождением, лицензией и рецептом воспроизведения
  каждого публичного бинарного ассета, а также argv-only генераторы нейтральных fixtures.
- Object-aware `check:release` для точного Git-дерева и публичный smoke-runner двух путей
  рендера с медиапроверкой, manifest/hash-контролем и защитой transcript/captions.
- `SECURITY.md` с ограниченным по времени исключением для moderate advisory в optional
  `--autotheme`; release checker проверяет полноту записи и дату пересмотра.
- Публичные npm metadata: MIT license, repository/homepage/bugs и единый Node.js 20+
  contract в package и lock.

### Исправлено

- Публичный lesson-процесс теперь по умолчанию использует встроенную тему
  `lesson-neutral`; default Dynamic остаётся `craft`.
- Явная внешняя тема больше не подменяется молча на `craft`: отсутствующий pack,
  недопустимый id или повреждённый JSON останавливают сборку без раскрытия локального пути.
- Центральный `build.js` больше не собирает shell-строки из пользовательских путей и
  заранее отклоняет недопустимые numeric/reframe параметры.
- Сбой render, finish, music или публикации теперь фиксирует project-render как `failed`;
  canonical final заменяется атомарно только после успешной обработки.
- Finish, music mix и Telegram pack запускают ffmpeg без shell, валидируют filter/media
  параметры заранее; Telegram pack жёстко требует два потока и A/V drift меньше 80 мс.
- Нарезка пауз и filler-слов больше не интерполирует пути/тайминги в shell и очищает
  временный filter script даже после ошибки ffmpeg; positional maxGap/pad читаются верно.
- Порционный Remotion-рендер, покадровый concat и audio mux переведены на checked argv;
  незавершённый chunk больше не публикуется как готовый resume-файл.
- Resume cache порционного рендера теперь content-addressed и проверяет manifest,
  SHA-256, размер, диапазон и фактическое число кадров каждого chunk.
- Транскрипты разных роликов больше не перезаписывают общий `src/data/transcript.json` в
  project-режиме.
- Legacy-режим и `automontage demo` теперь хранят generated transcript/captions и demo MP4
  в игнорируемом `out/`, не затрагивая отслеживаемые `src/data/`.
- CLI не добавляет лишний `--outdir`, когда финалом владеет project-папка.
- Видеослой спикера теперь сохраняет глобальный таймкод при смене сцен.
- Компенсирована постоянная AAC-задержка после Remotion.
- Горизонтальные раскладки, safe-zone длинных метрик и тайминг коротких подписей.
- Защищён путь загрузки внешней темы от выхода за каталог `THEMES_EXT`.
- Рассинхрон звука и видео после вырезания пауз и тишина на месте слов-паразитов.
- Финишный проход ограничивает отфильтрованный AAC длительностью видео, чтобы хвост
  `loudnorm` не создавал A/V drift выше 80 мс на коротких рендерах.
- Публичный demo-preview заменён на нейтральный рендер без человека и сторонней музыки;
  персональные стоп-кадры удалены, а HTML-мокапы теперь строятся только средствами CSS.
- Удалены b-roll и логотипы без записанного источника распространения; архивные сценарии
  используют воспроизводимые CSS-мокапы, а названия соцсетей – нейтральные текстовые метки.

## [1.1.0] - 2026-08-02

### Добавлено

- Кросс-платформенная работа на Windows, macOS и Linux.
- `requirements.txt` для Python-зависимостей и глобальная команда `automontage`.

### Безопасность

- Remotion обновлён до 4.0.504; закрыты известные уязвимости предыдущей версии.

## [1.0.0] - 2026-08-01

### Добавлено

- Первая версия AutoMontage-Agent: Remotion-композиции, темы, блоки, монтажный лист,
  локальная транскрибация и ffmpeg-пайплайн.
