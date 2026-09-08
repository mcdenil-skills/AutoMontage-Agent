# Архитектурные решения

Здесь фиксируются решения, которые влияют на дальнейшую разработку. Новая запись не
переписывает историю: если решение изменилось, добавляется новая запись со ссылкой на старую.

## D-001 – Публичные документы, локальная память

**Дата:** 2026-08-05
**Статус:** принято

Репозиторий `Ntmib/AutoMontage-Agent` публичный. Общая техническая документация, тесты и
CI хранятся в Git, чтобы любой клон объяснял устройство проекта. `MEMORY.md`, `memory/`,
`knowledge/`, `instructions/memory-rules.md` и `_progress.md` остаются локальными: там могут
появляться личные пути, рабочие исходники, обратная связь и незавершённые решения.

Следствие: свежий клон работает без локальной памяти, а на основном Mac новые сессии
восстанавливают контекст из неё.

## D-002 – Тема, композиция и монтажный лист разделены

**Дата:** 2026-08-01
**Статус:** принято

Визуальные токены хранятся в теме, способ показа – в React-компонентах, смысл и тайминг –
в JSON. Это позволяет менять стиль без переписывания блоков и повторно использовать один
монтажный лист.

Альтернатива «генерировать новый дизайн кодом для каждого ролика» отклонена как хрупкая,
медленная и плохо проверяемая.

## D-003 – Lesson рендерится только после утверждённого brief

**Дата:** 2026-08-04
**Статус:** принято

Lesson-процесс разделён на `draft` и `approved`. До явного утверждения пользователь видит
проруф, тексты, тайминги, кадрирование и последовательность сцен. Рендер проверяет тот же
исходник, тему и аспект.

Причина: полный рендер дорог по времени, а ошибка смысла или текста дешевле исправляется в ТЗ.

## D-004 – Семь официальных lesson-сцен

**Дата:** 2026-08-04
**Статус:** принято

Автоматический режиссёр использует `fullscreen`, `split`, `bottom-diagram`, `blur-overlay`,
`text-only`, `stat`, `broll`. Экспериментальный `chart` в brief запрещён.

Новая официальная сцена требует адаптива 9:16 и 16:9, safe-zone, схемы, тестов и отдельного
пересмотра этого решения.

## D-005 – Геометрия исходника является значением по умолчанию

**Дата:** 2026-08-04
**Статус:** принято

`--aspect source` сохраняет ширину, высоту и FPS входного файла. `vertical` и `horizontal`
являются только явными переопределениями. Это не даёт движку самовольно превращать урок
в Reels или наоборот.

## D-006 – Приватные темы подключаются извне

**Дата:** 2026-08-04
**Статус:** принято

Публичный движок содержит нейтральные встроенные темы. Фирменный стиль хранится отдельным
бренд-паком и подключается через `THEMES_EXT/<theme-id>/theme.json`.

Загрузчик принимает только безопасный id, проверяет итоговый путь и не позволяет выйти за
корень `THEMES_EXT`.

## D-007 – Видео сцены живёт на глобальном таймкоде

**Дата:** 2026-08-04
**Статус:** принято

Новая Remotion `Sequence` обнуляет локальный frame, но видеослой спикера обязан начинаться
с соответствующего места исходника через `trimBefore`. Аудио остаётся единой дорожкой.

Причина: без этого после первой смены сцены изображение начиналось сначала, а голос
продолжался дальше. Регрессионная защита – `tests/scene-media-sync.test.js`.

## D-008 – Один ролик хранится в одном локальном workspace

**Дата:** 2026-08-05
**Статус:** принято

`projects/YYYY.MM.DD_<slug>/` является пользовательским локальным workspace: исходник,
транскрипт, brief, музыка, превью, версии рендера и финал хранятся вместе. `project.json`
фиксирует историю и текущие указатели. Папка целиком игнорируется Git.

`out/` и `src/data/` сохранены как legacy/cache-пути для обратной совместимости. Project-режим
является явным на уровне CLI, но обязательным для навыка `reel-turnkey`. Это не даёт двум
роликам перезаписать транскрипты и результаты друг друга и не позволяет медиа случайно попасть
в открытый репозиторий.

## D-009 – SemVer и версионная история

**Дата:** 2026-08-05
**Статус:** принято

Публичные версии следуют SemVer. Несовместимое изменение повышает major, новая обратно
совместимая возможность – minor, исправление – patch. Текущий номер одновременно хранится
в `package.json` и корневой записи `package-lock.json`.

Заметные изменения сначала добавляются в `[Unreleased]` файла `CHANGELOG.md`. При выпуске
они переносятся в секцию `X.Y.Z` с датой, номер обновляется в манифестах и README, а публичный
релиз помечается Git-тегом `vX.Y.Z`. Так номер, состав версии и Git-история не расходятся.

## D-010 – Пути из manifest не являются доверенными

**Дата:** 2026-08-05
**Статус:** принято

`project.json` – сохранённые данные, а не полномочие на доступ к файловой системе. Каждый
manifest-controlled путь проходит schema validation, канонизацию и containment в project
workspace; каждый существующий компонент проверяется через `lstat`, включая dangling symlink,
после чего `realpath` подтверждает containment. Slug, legacy id и внешний final имеют отдельные
token/containment-проверки. Общий lesson/Dynamic exporter дополнительно проверяет каждый
существующий компонент `--outdir` и final, создаёт родителей по одному и публикует через
exclusive sibling temp + atomic rename, поэтому статическая ссылка назначения не разыменовывается.

Отклонены варианты «доверять schema-valid относительному пути» и «проверять только строковый
prefix»: оба пропускают symlink escape. Descriptor-relative `openat` мог бы сузить локальное
TOCTOU-окно, но portable Node API его не даёт; конкурентный процесс с правом записи в workspace
или `--outdir` вне принятой модели угроз. Это защита от существующего состояния файловой системы,
а не обещание race immunity против hostile writer.

## D-011 – Identity cache включает реализацию рендера

**Дата:** 2026-08-05
**Статус:** принято

Resume cache учитывает не только props и media, но и весь `src/`, `package.json`,
`package-lock.json` и реально используемые public resources. Поэтому chunk, собранный другой
версией Remotion-кода или lockfile, не выдаётся за совместимый.

Content-only нормализация path разрешена только для generated
`.automontage/<namespace>-<uuid>/source[.<ext>]`; расширение сохраняется как непрозрачный suffix
basename и может отсутствовать. Обычные public paths и видимые строки остаются частью props
identity, поэтому два разных b-roll с одинаковыми байтами не считаются одним наблюдаемым входом.

Отклонены cache key только от props/source и полный hash всей `public/` папки: первый даёт
устаревший результат после изменения реализации, второй инвалидирует cache от неиспользуемого
ресурса и делает resume непредсказуемо дорогим.

## D-012 – Approved brief публикуется как rollback-транзакция

**Дата:** 2026-08-06
**Статус:** заменено D-015

JSON, Markdown и `project.json` нельзя атомарно заменить одной portable filesystem-операцией.
Поэтому approval сначала полностью записывает и синхронизирует непредсказуемые owned sibling
temps, сохраняет rollback-копию manifest, затем публикует manifest, Markdown и только последним
renderable approved JSON. Сбой до последнего шага удаляет свой Markdown, возвращает прежний
manifest и очищает temps по file identity.

Отклонены прямые последовательные `writeFile` и порядок JSON до manifest: при ошибке они
оставляют approved JSON, который можно передать рендеру без зарегистрированного approval.

## D-013 – Review Workbench изолирован от renderer и редактирует только соседнюю границу

**Дата:** 2026-08-20
**Статус:** принято

Для визуальной проверки lesson рассматривались три варианта:

1. Fork OpenCut дал бы полноценный timeline, но принёс бы чужой project format, runtime,
   renderer, effects registry и большую поверхность синхронизации и безопасности.
2. Связка с Remotion Studio переиспользовала бы composition preview, но смешала бы проверку
   draft с production props/renderer и ослабила правило «draft никогда не рендерится».
3. Изолированный локальный Review Workbench читает browser-safe snapshot и отправляет только
   узкий allowlist команд в существующий project workspace.

Выбран третий вариант. Он оставляет approval и `scripts/build.js --brief` каноническими,
не добавляет renderer или новый формат проекта и позволяет fail closed отклонить любое изменение,
кроме общей границы двух соседних сцен и allowlisted b-roll. Read-only является default; Save
создаёт новую draft-ревизию, а approved остаётся immutable.

Boundary edit намеренно adjacent-only: меняются `left.end` и `right.start`, поздние сцены не
сдвигаются. Global ripple мог бы незаметно разойтись с дословной речью, transcript и уже
утверждёнными моментами. Brief хранит абсолютное время исходника, а Remotion использует этот
глобальный source time как `trimBefore`; обнуление времени на каждой сцене вернуло бы старый
рассинхрон из D-007. Свободный текст, scene conversion, effects, keyframes, masks, browser export
и OpenCut runtime отложены до отдельных решений и спецификаций.

Asset allowlist разделён на широкую preview capability и узкую renderer capability: назначить
в b-roll можно только форматы изображений, которые уже умеет показывать `SceneBroll`. Добавлять
video renderer в security-fix означало бы менять production-композицию, поэтому audio/video
остаются только в media lane и fail closed на API, approval и render boundary.

Opaque handles считаются lease на конкретные device/inode, а не на имя файла. Fresh state
сохраняет id неизменного lease, но любая подмена source/registered asset завершает старую сессию.
Конкурентные Save сериализуются fixed exclusive no-follow reservation: manifest CAS сам по себе
не закрывал окно между проверкой и overwrite-capable rename.

После внешнего `409` silent rebase отклонён: команда границы или b-roll была сформирована от уже
устаревшей геометрии и может иметь другой смысл на новой ревизии. Браузер поэтому загружает
канонический state, но сначала синхронно очищает active/redo stacks и блокирует мутации. Ошибка
reload не возвращает старый stack и не разрешает discard. Отдельный fresh-ready gate открывается
только после успешной загрузки; следующий validate получает лишь команды, созданные оператором
после явного discard уже от свежей базы.

Review Save публикует Markdown и канонический JSON до manifest и повторяет manifest CAS прямо
перед последним rename. Manifest является visibility boundary: reader либо видит прежнюю полную
ревизию, либо новую запись, чья Markdown/JSON-пара уже существует. Это отличается от approval
транзакции D-012: draft JSON сам по себе не renderable approved capability, а частичный manifest
сломал бы даже read-only `/api/state`.

Bearer URL не выводится в обычный stdout. Если автоматический browser launch не используется
или падает, выбран временный exclusive regular-файл mode `0600` с bounded TTL; stdout показывает
только путь. Это сохраняет ручной запуск, не расширяя token exposure за browser-launch contract.
Обычные `SIGINT`/`SIGTERM` начинают штатное закрытие сервера, но exit ждёт tracked import-finalizers,
чтобы lease/quarantine исчезли до кода 130/143. Публичный wrapper использует asynchronous child,
пересылает сигнал ровно один раз и ждёт тот же cleanup outcome; синхронный `execFileSync` отвергнут,
потому что сигнал завершал wrapper и оставлял Review child жить отдельно. Неперехватываемый
`SIGKILL` вне этого обещания.

## D-014 – Video b-roll импортируется как immutable normalized asset

**Дата:** 2026-08-21
**Статус:** принято

Ограничение D-013 «renderer принимает только изображения» заменено: изоляция Review, внешний
approval и канонический lesson renderer остаются, но `broll` теперь принимает нормализованные
image/video assets. Рассматривались прямой рендер пользовательского файла, browser proxy как
master и заранее нормализованный master плюс отдельный proxy. Выбран третий вариант.

Произвольный AVIF/GIF/JPEG/PNG/WebP превращается в WebP master. MP4/MOV/M4V/WebM превращается
в H.264/yuv420p master с нормализованной геометрией/FPS и AAC 48 kHz stereo при наличии звука;
отдельный VP8/Opus WebM нужен только для предсказуемого браузерного preview. Это удваивает часть
работы и расход диска, зато approval/Remotion получают один проверяемый контракт независимо от
входного codec/container, а браузер никогда не становится источником render bytes.

Каждый import создаёт новый UUID bundle. Bundle, metadata и proxy после публикации неизменяемы;
удаление, overwrite и reuse id в V1 отклонены, потому что они ломают persisted SHA-256,
approval identity и воспроизводимость старых brief. Для замены пользователь загружает новый
файл. Один semaphore допускает только одну нормализацию на project-сессию: параллельные
транскоды резко повышают CPU/disk pressure и усложняют abort/cleanup без пользовательской пользы.

Review показывает opaque `asset-N`, а Save материализует server-side reference и hash только
после повторного descriptor probe. Approval ещё раз сверяет master/metadata/proxy и clip/audio,
после чего lesson build копирует source и все approved b-roll в один одноразовый immutable
render bundle. Так рендер не читает живой project path и repeated asset копируется один раз.

На macOS каталог может находиться внутри iCloud File Provider: после безопасной записи сервис
асинхронно меняет только `ctime` файла из-за своих metadata, не меняя байты или `mtime`. Полностью
игнорировать `ctime` или ждать фиксированный timeout нельзя. Поэтому render bundle принимает
только `ctime`-only drift: `dev/ino/size/mtime/mode/nlink` обязаны совпасть, открытый no-follow
descriptor и pathname обязаны указывать на тот же regular file, а SHA-256 всех байтов считается
заново. Hash принимается только при неизменной identity от начала до конца чтения: если за это
время сдвинулся даже один `ctime`, digest отбрасывается и выполняется полный повтор. Лишь после
стабильного совпавшего hash новый `ctime` становится baseline; число rehash/repin-циклов
ограничено. Любая другая identity-разница, непрерывный drift или изменение bytes остаются
fail-closed до Remotion callback.

Для V1 выбран Remotion `OffthreadVideo`, а не собственный browser renderer, OpenCut runtime или
ручная покадровая декомпозиция. Родительская `Sequence` ограничивает сцену, `trimBefore` задаёт
старт. `mute` оставляет source voice, `mix` добавляет clip на фиксированных −18 dB, `replace`
делает клип основным и приглушает source только в интервале сцены. Отдельный per-asset loudness
pass отклонён: он увеличил бы импорт и мог бы неожиданно менять авторский скринкаст; громкость
входного клипа в V1 является ответственностью подготовки медиа.

## D-015 – Project mutations используют общий recoverable lease и manifest-last CAS

**Дата:** 2026-08-22
**Статус:** принято; заменяет D-012

JSON, Markdown и `project.json` нельзя опубликовать одной portable filesystem-операцией, а
несколько процессов могут одновременно вызвать Save, approval или render lifecycle. Поэтому
все manifest mutations используют один project-wide lease с полным owner record. Чтения не
блокируются. Live owner и owner другого host сохраняются; reclaim разрешён только когда PID
того же host отвечает `ESRCH`, и recovery claim привязан к identity старого lease.

Под lease операция заново читает persisted manifest и сравнивает его с ожидаемым snapshot.
Draft/approved Markdown и JSON публикуются atomic no-replace hard links до manifest. Только после
их появления `project.json` заменяется с повторной проверкой прежних identity и bytes. Поэтому
`currentBrief` никогда не указывает на отсутствующий JSON, foreign destination остаётся
byte-identical, а crash-orphan не перезаписывается: новая draft получает следующий свободный
номер. Approval дополнительно всегда запускает полный `validateLessonBrief()` над заново
прочитанным текущим draft.

Уточнение после failure injection: успешный atomic rename manifest является commit point. После
него writer не делает fallible read/lstat для определения результата; следующий commit в той же
transaction использует identity и bytes уже синхронизированного staged inode. Initial draft
allocation также происходит только внутри lease через `publishBriefRevision()`, а прямое
обновление существующего manifest без expected snapshot запрещено.

D-012 заменено: прежний порядок manifest до approved JSON создавал crash-окно с битым
`currentBrief`, а rollback после publication не мог защитить от hard exit. Отклонены отдельные
locks для Review/approval/render: они сериализовали каждый путь сам с собой, но не закрывали
межпроцессную гонку разных writers одного `project.json`.

## D-016 – Media import и recovery разделяют project mutation lease

**Дата:** 2026-08-22
**Статус:** принято

Import publication и startup/refresh cleanup являются project mutations, поэтому используют
lease из D-015, а не второй lock. Долгий import сериализует Save/approval/render, зато второй
процесс не может удалить live quarantine или частично опубликованные bytes; обычные GET/HEAD
lease не берут. Crash recovery доверяет только append-only owner/publication records и точным
inode, никогда UUID или TTL. Encoder outputs создаются как private owned inode заранее, чтобы
hard exit во время записи оставался доказуемым. Marker-last сохраняет committed bundle, а
неподтверждённые replacement/unexpected children намеренно остаются для ручной диагностики.

Node 20 не предоставляет `renameat2(RENAME_NOREPLACE)` или unlink по открытому descriptor. Поэтому
cleanup не обещает невозможной абсолютной same-UID syscall-атомарности: pathname сначала переносится
в непредсказуемый `0700` tombstone, и удаляется уже совпавший перенесённый объект; малые immutable
records сверяются и по bytes. Если в claim-rename исходного pathname попал другой inode, он
сохраняется в tombstone. Процесс с тем же UID, который уже узнал private pathname, остаётся за
границей гарантии Node 20. Отвергнут прежний `lstat → unlink`, потому что race между этими syscall
мог удалить foreign bytes.

## D-017 – Opened-media probe использует portable stdin transport

**Дата:** 2026-08-22
**Статус:** принято

Save и approval обязаны проверять те же открытые immutable bytes, которые затем хэшируют. Реальные
PNG, JPEG, WebP, H.264 MP4 с metadata в конце и WebM подтвердили, что ffprobe распознаёт нужный
контракт через descriptor, подключённый к child stdin, и вход `pipe:0`. Поэтому выбран один общий
adapter: argv array, `shell:false`, timeout 30 секунд, bounded stdout/stderr и pathless canonical
error. `/dev/fd/*`, live pathname и временный copy/hardlink snapshot не нужны.

Filesystem-различия вынесены в один capability module с независимыми `noFollow`,
`posixPermissions` и `directoryFsync`. POSIX продолжает требовать `O_NOFOLLOW`, private
`0600/0700` и fsync каталога после изменения directory entries. На Windows первые две гарантии не
симулируются через бессмысленные mode bits, а directory fsync выключен отдельно: Node не
поддерживает используемую пару open-directory + `fsyncSync`. Это убирает только directory-entry
durability flush, не regular-file fsync. Обязательными остаются containment/realpath, regular-file,
opened-handle/path identity до и после probe/hash, size/timestamps и SHA-256. Отклонены pathname
fallback и простое отключение identity-проверок: первое возвращает race, второе разрешает
same-size подмену.

## D-018 – Длительность медиа принадлежит потоку, а выход ограничен по фазам

**Дата:** 2026-08-22
**Статус:** принято

Контейнер MP4/MOV/WebM может сообщать максимум из нескольких потоков. Если считать его
`durationSec`, ролик с video 1 s/audio 3 s разрешает двухсекундный визуальный trim, а ролик с
video 3 s/audio 1 s разрешает `replace` без существующего звука. Поэтому metadata v2 задаёт
два независимых значения: `durationSec` только для visual video stream и `audioDurationSec`
только для audio stream. Fallback к container duration отвергнут. Legacy v1 image остаётся
однозначным, а legacy v1 video требует переимпорта.

Master и proxy завершаются по visual duration. Это обрезает длинный звук, но не растягивает
короткий. `mute`/`mix` проверяются по visual duration, `replace` одновременно по visual/audio.
Нечётную геометрию после autorotate дополняет `pad` до ближайшего чётного размера: crop терял бы
край, а scale менял бы геометрию и соотношение сторон.

Одной проверки свободного места до upload недостаточно: encoder способен разрастись, а во время
publication одновременно живут stage и copy. Поэтому budgets считаются безопасной BigInt
арифметикой из проверенных probe/input параметров, ограничиваются абсолютными caps и применяются
в `ffmpeg -fs`, bounded copies и post-close gate. `statfs` повторяется перед каждой дорогой фазой
по peak live bytes плюс reserve. Любая quota/disk boundary имеет стабильный `507` и использует
тот же identity-only cleanup/retry, что прерванный импорт.

## D-019 - Custom scene video использует тот же immutable render bundle

**Дата:** 2026-08-22
**Статус:** принято

Старые approved lesson могли задавать локальный `scene.faceSrc`, но прямое чтение live project
или public pathname во время Remotion возвращало TOCTOU и host path в props. Полный запрет ломал
совместимость. Поэтому approved brief остаётся authoritative: render props обязаны иметь тот же
scene type и точный исходный `faceSrc`, после чего разрешён только canonical project `assets/...`
или repository-public video. Он проходит существующие trusted-chain, no-follow, identity,
bounded copy, SHA-256, File Provider repin и owned cleanup barriers и получает одноразовое имя.

Source alias не выводится из входных props: канонический lesson builder явно передаёт
`source.mp4`, а top-level `faceSrc`/`audioSrc` обязаны точно ему соответствовать. Только exact
scene match с этим trusted alias переиспользует main snapshot. Same-inode dedup хранит полную
identity первого source и SHA-256: exact reuse разрешён, ctime-only drift требует стабильного
полного rehash, остальные изменения отклоняются. Совместимыми остаются только video role и
одинаковое extension.

Repository находится под macOS File Provider, а браузерное чтение его `public` само меняет
`ctime`, поэтому lesson snapshots обслуживаются из owner-only системного temp через официальный
Remotion `--public-dir`. В этот каталог попадает только утверждённый owned bundle: весь repository
`public` и ignored/private media не копируются. Baseline фиксируется до единственного реального
render, а после всего callback выполняется strict identity/hash check без ctime re-pin. Поэтому
mutation + byte/mtime restore во время Remotion остаётся заметной, а номинальное чтение больше не
вызывает File Provider drift; второго output или manifest/history entry нет. Top-level
`audioSrc` всегда указывает на main source, custom `OffthreadVideo` muted и использует глобальный
`sourceStartFrame`. Отклонены live pathname, отдельное custom audio, post-render baseline и новый
resolver: они возвращали бы race/path leak или ослабляли уже проверенный security boundary.

## D-020 – Draft-preview является отдельной capability, а не ослабленным final render

**Дата:** 2026-08-23
**Статус:** принято; уточняет D-013

Исходный плеер Review подходит для речи и границ, но принципиально не показывает Remotion-сцены,
графику, шрифты и музыкальный микс. HTML-имитация или отдельный ffmpeg-дизайн неизбежно разошлись
бы с финалом. Поэтому выбран отдельный `automontage preview`: он принимает только текущий
persisted draft, использует те же `ReelScenes` props, isolated media bundle, finishing и music
ducking, но имеет закрытый output contract только в `previews/`.

Preview отличается от финала только половинным разрешением, CRF 28 и меткой «ЧЕРНОВИК».
Он не может обновлять `renders`, `latestRender` или `final`; approved-only builder по-прежнему
отклоняет draft. Review server сам render не запускает, а лишь показывает уже опубликованный
`current-preview.mp4` отдельным token-protected плеером с identity/SHA-256 проверкой. Отклонены
флаг «разрешить draft» в final builder, Remotion Studio как новый формат проекта и визуальная
имитация: все три смешивали бы полномочия или показывали пользователю не тот монтаж.

## D-021 – Сокращение исходника является versioned data, а не правкой draft

**Дата:** 2026-08-23
**Статус:** принято

Паузы и неудачные дубли меняют временную ось всего ролика. Если выполнять такую операцию внутри
Review или поверх готового brief, сцены, слова и media trim незаметно начнут ссылаться на другой
таймкод. Поэтому `automontage master` принимает отдельный frame-aligned source-edit, сохраняет
оригинал и выпускает immutable source/transcript revision. Транскрипт пересчитывается
детерминированно по оставленным диапазонам, без повторного Whisper; manifest меняется последним,
а старые draft и preview не получают права автоматически перейти на новый source.

Клиентская доставка отделена от развития движка. В режиме работы над конкретным роликом агент
может менять только `projects/<id>/`: исходные правки, brief, preview и render artifacts. Код,
схемы, темы и документация движка требуют отдельной инженерной задачи. Это не даёт срочному
монтажу превратиться в незапланированный рефакторинг продукта.

Отклонены полноценный нелинейный редактор внутри Review, перезапись `input/source.mp4` и повторная
транскрибация после каждого разреза: первое дублирует специализированный NLE, второе уничтожает
историю, третье медленнее и способно изменить уже проверенный текст.

## D-022 – Стандартный монтаж использует подписку, а provider API является явным opt-in

**Дата:** 2026-08-24
**Статус:** принято

Claude Code/Codex subscription и provider API billing являются разными продуктами. Пользователь,
который уже оплачивает подписку и монтирует локально, не должен получать неожиданный запрос ещё
одного ключа или отдельный счёт за подготовку ТЗ. Поэтому канонический `reel-turnkey` сам читает
локальный faster-whisper transcript в текущей подписанной сессии, создаёт draft Markdown/JSON,
валидирует и публикует их через project workspace. Транскрипция, draft, Remotion-preview, Review,
approval, final render и QA не проверяют и не запрашивают provider keys.

OpenAI API разрешён только по отдельной явной просьбе пользователя сгенерировать новое
изображение и только если текущая модель не умеет сделать это самостоятельно. Наличие ключа в
окружении не считается согласием. Перед отдельной платной операцией агент обязан предупредить
пользователя и получить явное подтверждение; ключ нельзя применять к другим задачам или просить
прислать в чат. Существующий `scripts/gen-brief.js` сохраняется как explicit legacy/developer
provider path для совместимости кода, но не является стандартным шагом навыка или публичного
beginner workflow.

Отклонены автоматическая проверка `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` при старте монтажа и
неявный fallback на provider API: оба поведения смешивают подписку с API-биллингом и могут
потратить деньги без отдельного решения пользователя.

## D-023 – Пакет Reels является оркестрацией независимых lesson-проектов

**Дата:** 2026-09-06
**Статус:** принято

Несколько роликов и варианты одного хука должны проходить единый ночной процесс, но их approval,
история версий и откат не должны зависеть друг от друга. Поэтому пакет хранит только локальный
игнорируемый индекс поверх отдельных `projects/<id>/`; нового общего manifest и отдельной команды
рендера нет. Существующие project-boundary, validation, preview и approved-only final остаются
единственным источником истины.

Hook-family фиксирует общую основу после точки стыка. Изменение одного вступления возвращает в
draft только эту версию, а изменение общей основы инвалидирует всю семью. Анализ, транскрибация и
подготовка активов могут выполняться параллельно; полные рендеры одного checkout идут
последовательно, пока legacy-временные пути не изолированы полностью.

Отклонены единый mutable batch manifest и новый batch renderer: первый создаёт общий домен отказа
для независимых роликов, второй дублирует уже проверенные lesson-команды и повышает риск, что
публичная инструкция разойдётся с реальным approved workflow.

## D-024 – Приватность Git проверяется отдельно от поиска секретов

**Дата:** 2026-09-06
**Статус:** принято

Gitleaks хорошо находит ключи и токены, но не знает, что обычный MP4, transcript, личный путь или
локальный project manifest тоже являются утечкой в публичном продукте. Поэтому release pipeline
использует два независимых барьера: public privacy checker читает tracked tree в CI и точные
staged blobs в pre-commit, а Gitleaks отдельно проверяет секреты и всю историю.

Медиа допускается в Git только при полной шестиколоночной записи происхождения в `ASSETS.md`.
Отклонены проверка только рабочей папки и единый список regex для всех рисков: первая не видит
содержимое Git index, второй смешивает разные модели угроз и даёт ложное ощущение защиты.

## D-025 – npm-архив имеет отдельную границу от Git

**Дата:** 2026-09-06
**Статус:** принято

`npm pack` может включить локальный файл, который не отслеживается Git и скрыт только через
локальный exclude. Поэтому чистый Git status и tracked privacy gate сами по себе не доказывают
безопасность package tarball. `.npmignore` исключает project workspace, рендеры, память и весь
каталог локальных implementation plans, а behavioral test проверяет фактический npm packlist и
наличие обязательных runtime-файлов.

Отклонены предположение, что npm всегда повторяет локальный Git exclude, и ручной просмотр
длинного списка перед каждым релизом: первое неверно для machine-local правил, второе не даёт
воспроизводимого автоматического барьера.

## D-026 - B-roll выбирает человек из официального поиска

Дата: 2026-09-08.

Поиск встроен в существующий Review Workbench после фиксации речи и таймингов. Агент готовит
цель кадра и `brollIntent`, Pexels возвращает фото/видео в порядке релевантности, пользователь
выбирает материал. Скачивание проходит тот же quarantine/ffprobe/decode/normalize/hash/import
контур, что локальный файл; Save создаёт новую draft-ревизию. Выбор обратим, отдельного approval
для безопасного файла нет. Общий approval требует актуальный полный Remotion-preview и явное
подтверждение его просмотра. Final render по-прежнему запускается отдельно.

Альтернативы: автоматический выбор с рендером исключён из-за необходимости оценить смысл и
права на кадр; второй редактор не нужен; скраперы/cookies/reverse API не используются. Из
MoneyPrinterTurbo взято разделение query/provider/rendition, а не код или LLM pipeline.
Официальный Pexels SDK не добавлен: прямой REST позволяет явно контролировать DNS, redirect,
timeout, MIME, размер, abort и секреты. Новый API видео использует `/v1/videos/search`;
SDK и старые примеры ещё встречаются с `/videos/`. Источник контракта:
[официальная документация Pexels](https://www.pexels.com/api/documentation/).

## D-027 - OCR evidence неизменяем, разрешение принадлежит выбору сцены

Дата: 2026-09-08.

Metadata v3 хранит provenance и машинный `textScan`. Пользовательское разрешение встроенного
текста хранится как `brollReview` в выбранной сцене brief и связано с hash файла и scan. Так один
immutable asset можно использовать в нескольких сценах без изменения чужих решений. Замена
материала сбрасывает разрешение. Save/approval повторно проверяют соответствие evidence; OCR
ошибка или отсутствие Tesseract не считаются чистым кадром.

Выбран локальный Tesseract executable с установленными языками: это сохраняет отсутствие
обязательной тяжёлой JS/WASM-зависимости и скачивания языковых моделей при открытии Review.
Tesseract.js рассматривался, но дополнительный runtime и управление WASM/языками не дают здесь
доказанного выигрыша. Для видео проверяются три равномерных кадра; OCR остаётся предупреждением,
не доказательством отсутствия текста или графических логотипов. Код Tesseract:
[Apache-2.0](https://github.com/tesseract-ocr/tesseract/blob/main/LICENSE).

## D-028 - OpenCLIP пока не входит в рабочий путь поиска

Дата: 2026-09-08.

Изолированный эксперимент через OpenCLIP 3.3.0 и SigLIP2 показал P@5 60% для порядка Openverse
и 96% для русского запроса на 57 изображениях/5 запросах. Оценки поставлены одним Codex-рецензентом
по перемешанным изображениям до запуска модели; это разведочный результат, не human acceptance
и не измерение качества Pexels. Первый CPU-прогон занял 19,13 с, peak RSS 3,10 ГиБ;
зависимости и model files занимают около 2,29 ГБ, первоначальная загрузка заняла 234,62 с.
Два повторных offline-прогона заняли 15,54 и 14,61 с и воспроизвели все оценки и места точно.

Поэтому рабочий default - релевантность провайдера с фильтрами и ручным выбором. Модель не
загружается и не устанавливается автоматически. Положительного разведочного результата
недостаточно, чтобы обязать каждый монтаж держать дополнительную модель в памяти. Перед opt-in
нужен отдельный замороженный Pexels photo/video набор с независимыми оценками и проверкой
латентности. Код OpenCLIP имеет MIT, выбранные pinned SigLIP2 weights - Apache-2.0; лицензии
проверены отдельно. Метод, версии и измерения описаны в
[отчёте benchmark](docs/research/2026-09-08-broll-reranking-benchmark.md).

## D-029 – MotionReel — отдельная camera-free композиция с аудио как источником

**Дата:** 2026-09-08
**Статус:** принято

`MotionReel` является sibling-композицией для `ReelScenes`: у неё отдельный versioned
`motion-reel` brief, набор из семи public motion-сцен и один narration audio source. Аудио
является first-class source проекта, а не звуковой дорожкой синтетического видео. Это сохраняет
честную модель данных и не позволяет camera-free brief случайно попасть в существующий
video/lesson renderer.

Основной путь принимает локальный MP3/WAV/M4A и получает word timing через local Whisper.
Платная narration, включая ElevenLabs, остаётся optional local adapter: она требует явного
`--accept-provider-cost`, не имеет публичного voice ID по умолчанию и не нужна для preview,
approval, final render или QA с готовым narration file.

Отклонён synthetic blank video: он маскирует audio-only источник под video, добавляет
несуществующую speaker/face семантику и расширяет legacy video-путь вместо проверки отдельного
контракта. Отклонён separate repository: уже существующие workspace, draft/approved gate,
immutable render versions и QA являются нужными гарантиями этого режима; второй репозиторий
дублировал бы их и расходился бы с public workflow.


### D-029: integration boundary

Motion использует общий isolated render-media bundle с явной audio-ролью, а не отдельную
упрощённую раздачу файлов. Поэтому narration, media и музыка проходят те же no-follow,
content-hash и ownership проверки. Approved JSON получает отдельный digest в manifest:
сравнение только полей сюжета не обнаруживало бы правку receipt или formatting bytes.
Motion Review в первой версии read-only: существующий lesson command language не подходит
другой библиотеке сцен; CLI preview и утверждение уже дают полный проверяемый workflow.
