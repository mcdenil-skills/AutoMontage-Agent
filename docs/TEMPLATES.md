# Шаблоны монтажа (Templates)

Движок собирает ролик по ВЫБРАННОМУ шаблону. Шаблон = композиция (layout) + тема (стиль).
Для lesson формат наследуется от видео, если не сказано иначе. У audio-only `motion-reel`
свой стандарт: 1080×1920 и 30 FPS.

Для первого монтажа без технических деталей начни с
[«Монтаж от видео до готового MP4»](MONTAGE-GUIDE.md). Этот каталог нужен, когда уже требуется
выбрать конкретный шаблон, сцену или тему.

Как выбрать шаблон при монтаже: скажи агенту тип ролика и стиль, либо укажи флагом
`--template lesson` (и `--theme <id>` для скина). Motion запускается отдельной командой
`automontage motion`, а не флагом `--template motion-reel`.

Запускай только одну сборку на checkout. Каждый lesson render получает owner-only media root
в `os.tmpdir()`, который Remotion получает отдельным абсолютным `--public-dir`; props сохраняют
только web-relative `.automontage/...` ссылки. Но `tmp/` и legacy-пути всё ещё общие, поэтому для
параллельного монтажа нужны отдельные clone/worktree.

Для пакета Reels параллельно готовь транскрипты, brief, активы и проверки, а полные Remotion-
рендеры в одном checkout ставь в последовательную очередь. Каждый выход живёт в собственной
`projects/<id>/`; варианты хука делят утверждённую общую основу, но имеют отдельные preview и QA.
Полный порядок описан в [пакетном workflow](BATCH-REELS-WORKFLOW.md).

---

## Открытые шаблоны (в этом репозитории)

### Motion-reel :: Анимационный ролик без камеры

Композиция `MotionReel`, тема `motion-neutral`, аудио вместо говорящей головы. Сцены:
`kinetic-title`, `card`, `steps`, `list`, `counter`, `media`, `cta` – отдельный набор,
не варианты lesson. Полоса субтитров по умолчанию выключена; optional `caption` задаётся в brief.
Лимиты полей и media/audioMode описаны в [каталоге](SCENE-CATALOG.md#motionreel-семь-сцен-без-камеры).

```bash
automontage motion narration.mp3 --project "Анимационный ролик"
automontage preview --project-dir projects/<id> --brief brief/vNN-draft.motion.json
node scripts/project/approve-brief.js projects/<id> brief/vNN-draft.motion.json --confirm-preview-viewed
automontage motion --project-dir projects/<id> --brief brief/vNN-approved.motion.json --version-label reviewed
```

Между инициализацией и preview агент по локальному transcript публикует полный timed brief;
между preview и approval пользователь смотрит полный ролик и явно утверждает эту версию.
`<id>`/`vNN` – пути фактической ревизии, `node scripts/...` выполняется из корня движка.
Preview – настоящий Remotion с watermark; final принимает только текущий approved JSON и
проверенные hashes. Motion Review пока read-only. Готовое аудио не требует provider-ключей,
ElevenLabs – отдельная опция с согласованным текстом/голосом и `--accept-provider-cost`.
Текст отправляется провайдеру; ключ/voice ID/кэш остаются приватными, неоднозначный сбой
не повторяется автоматически. [Полный навык](../skills/motion-reel/SKILL.md) описывает consent,
таймкоды, QA и повторные правки. Офлайн-тест: `automontage demo --motion` – только draft,
с тестовыми тонами вместо речи. Расписание и автопубликация относятся к будущему отдельному слою.

### 1. lesson-presentation :: Урок / эфир (9:16 / 16:9)
Режиссёр выбирает раскладку из 7 готовых сцен и заполняет её дословными фразами,
тезисами и цифрами из речи. Код и дизайн сцен не генерируются. Официальная библиотека:
`fullscreen`, `split-top` (JSON-ключ `split`), `bottom-diagram`, `blur-overlay`,
`text-only`, `stat`, `broll`. Экспериментальный `chart` в автоматический план не входит.

![lesson-presentation](previews/lesson-presentation.png)

Пример стиля выше. Монтаж идёт в два обязательных этапа: сначала ТЗ, затем рендер
только после явного утверждения пользователем.

- Композиция: `ReelScenes` · Публичная тема: `lesson-neutral`
- Если `--theme` не задан, lesson автоматически использует `lesson-neutral`; Dynamic
  по-прежнему использует `craft`.
- По умолчанию `--aspect source`: ширина, высота и FPS равны исходнику.
- `--aspect vertical`: 1080x1920 с FPS исходника.
- `--aspect horizontal`: 1920x1080 с FPS исходника.
- `--face-x`, `--face-y` и `--face-zoom` фиксируют проверенное кадрирование спикера в ТЗ.
- Для горизонтального talking-head с намеренно свободной половиной кадра `fullscreen` может
  использовать `variant: "side-overlay"`: спикер остаётся на исходном видео, а заголовок и до
  четырёх лёгких анимированных шагов располагаются на противоположной стороне без карточки.
  Если шаги должны входить по смысловым словам речи, `stepStartsSec` задаёт для каждого пункта
  секунду появления относительно начала сцены; без него действует стандартный короткий stagger.
  Для финального `side-overlay` флаг `centerOnFade: true` плавно переносит заголовок из свободной
  стороны в центр в течение последней секунды сцены и одновременно убирает разделительную линию.
- `--tighten` и `--reframe` нужно применять к отдельному исходнику до создания lesson-ТЗ.

Этап 1. Транскрибация, проруф и черновик ТЗ выполняются агентом в текущей подписанной сессии.
Достаточно попросить:

> Собери lesson-ролик под ключ из `<видео>`. Формат как у исходника, тема `lesson-neutral`.
> Работай локально по подписке, не используй provider API и сначала покажи draft-preview.

Агент создаёт `projects/YYYY.MM.DD_<slug>/`, копирует исходник, запускает локальный
faster-whisper, сам формирует `brief/v01-draft.lesson.md` + `.json`, валидирует и публикует их
через project workspace. `ANTHROPIC_API_KEY` и `OPENAI_API_KEY` для этого не нужны. Отдельный
provider-скрипт `scripts/gen-brief.js` остаётся только явным legacy/developer opt-in и не должен
запускаться обычным навыком `reel-turnkey`.

Если нужно сначала вырезать паузы или неудачные дубли, создай frame-aligned
`edit/v02-source.json` и выполни до новой режиссуры:

```bash
automontage master --project-dir projects/YYYY.MM.DD_<slug> \
  --edit edit/v02-source.json
```

Оригинал не меняется: публикуются новая source revision и пересчитанный transcript без повторного
Whisper. Старый draft остаётся историей и не подходит для нового master; следующий draft должен
ссылаться на активную source revision.

При необходимости draft можно проверить локально до утверждения:

Полная пользовательская последовательность по самому окну, включая границы, импорт,
Save → approval → render и частые ошибки, находится в [REVIEW-WORKBENCH.md](REVIEW-WORKBENCH.md).

```bash
automontage review --project-dir projects/2026.08.20_demo
automontage review --project-dir projects/2026.08.20_demo --edit
automontage review --project-dir projects/2026.08.20_demo --no-open
```

Review всегда разделяет два видео: **«ИСХОДНИК»** нужен для речи и границ, а
**«СМОНТИРОВАННЫЙ ПРЕДПРОСМОТР»** показывает настоящий результат `ReelScenes`. Второй плеер
появляется после отдельной команды:

```bash
automontage preview --project-dir projects/2026.08.20_demo \
  --brief brief/vNN-draft.lesson.json
```

Для фрагмента добавь парные `--from-sec N --to-sec N`. В интерфейсе всегда показывается
`ПОЛНЫЙ РОЛИК` либо точный диапазон фрагмента. Preview помечен «ЧЕРНОВИК», имеет пониженное
качество и не даёт draft права на финальный render.

Возможности семи официальных сцен, допустимые варианты и обязательные проверки собраны в
[каталоге сцен](SCENE-CATALOG.md). Там же зафиксировано: screencast - это настоящее video,
а не статичный screenshot; `brollMedia` управляет fit/trim/mute, а master voice остаётся главным.

Первая команда read-only и не меняет brief, manifest или render history. Вторая разрешает
adjacent boundary, загрузку AVIF/GIF/JPEG/PNG/WebP или MP4/MOV/M4V/WebM и назначение image/video
готовой `broll`-сцене. После «Добавить медиа» файл только появляется в media lane: Review не
выбирает сцену автоматически. Image default — `cover`; video default — `contain`, старт 0,
`mute`. Плеер и кнопка «Начать с текущего места» задают старт, а селекторы — fit и один из трёх
audio modes. Один immutable asset можно повторять в нескольких сценах с разными настройками.

Save создаёт новую `vNN-draft.lesson.md/.json`, не меняя approved и исходную ревизию. Undo/redo
до Save остаётся в памяти. `--no-open` печатает путь к временному mode-`0600` URL-файлу вместо
bearer URL; файл живёт не дольше 10 минут, до закрытия сервера или обычного `SIGINT`/`SIGTERM`.
После внешнего `409` controls блокируются до безопасной повторной проверки/свежего state;
устаревшие команды не перебазируются молча. Waveform является best-effort: при его ошибке видео,
слова и timeline продолжают работать. Review не умеет менять текст, effects, keyframes, masks,
делать global ripple/OpenCut-экспорт, удалять/перезаписывать imported asset или запускать render.
Черновой Remotion-preview собирается настоящей командой `automontage preview`; edit Review
может запускать её отдельным действием и показывать результат.

Для подбора stock-фото/видео draft может временно содержать `brollIntent` вместо медиа.
Агент берёт цель и исходную фразу из транскрипта и задаёт исходный/английский поисковые запросы.
Пример формы сцены - [examples/broll-intent.scene.json](../examples/broll-intent.scene.json).
Пустая сцена сохраняет тип `broll` и показывает `[ B-ROLL ]` в draft-preview; approval её
отклоняет. В edit Review пользователь ищет через официальный Pexels API и выбирает один
файл для локального безопасного импорта. `PEXELS_API_KEY` нужен только для этого поиска.

Discovery-asset получает provenance и локальную OCR-проверку. Предупреждение о встроенном
тексте или невозможности проверки требует явного разрешения в сцене. Выбор и разрешение
сохраняются обычным Save в новый draft. Затем нужен полный Remotion-preview текущей ревизии,
подтверждение просмотра и отдельный approval; final render остаётся отдельным действием.
Полный путь описан в [Review Workbench](REVIEW-WORKBENCH.md#7-назначить-b-roll-сцене).

Legacy image остаётся совместимым и не требует миграции:

```json
{
  "scene": "broll",
  "start": 3,
  "end": 6,
  "headCream": "ПРИМЕР",
  "headOrange": "НА ЭКРАНЕ",
  "brollSrc": "broll/growth.png"
}
```

Новый normalized image сохраняется в draft так (путь и SHA создаёт Review, руками их не
придумывают):

```json
{
  "scene": "broll",
  "start": 3,
  "end": 6,
  "headCream": "ПРИМЕР",
  "headOrange": "НА ЭКРАНЕ",
  "brollMedia": {
    "kind": "image",
    "src": "assets/broll/images/123e4567-e89b-42d3-a456-426614174000/media.webp",
    "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "fit": "cover"
  }
}
```

Normalized video добавляет старт и звук:

```json
{
  "scene": "broll",
  "start": 6,
  "end": 9,
  "headCream": "СКРИНКАСТ",
  "headOrange": "ШАГ 1",
  "showSpeakerPip": false,
  "brollMedia": {
    "kind": "video",
    "src": "assets/broll/video/123e4567-e89b-42d3-a456-426614174001/media.mp4",
    "sha256": "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
    "trimStartSec": 1.2,
    "fit": "contain",
    "audioMode": "mix"
  }
}
```

- `fit: "contain"` показывает весь кадр с возможными полями; `cover` заполняет сцену с
  возможной обрезкой краёв.
- `showSpeakerPip: false` оставляет b-roll единственным видео на весь кадр. Если ключ не задан,
  поверх b-roll сохраняется стандартное окно спикера для обратной совместимости.
- `audioMode: "mute"` оставляет исходный голос; `mix` добавляет звук клипа на −18 dB;
  `replace` заменяет исходный голос только внутри сцены с короткой огибающей на стыках.
- У silent video разрешён только `mute`.
- Клип обязан покрыть сцену с тем же frame math, что renderer:
  `round(trimStartSec × fps) + max(1, round((end − start) × fps)) ≤ round(durationSec × fps)`.
  Зацикливания и freeze последнего кадра в V1 нет.
- Approval заново проверяет normalized metadata, master/proxy hashes, duration и audio stream;
  ручной MP4 в legacy `brollSrc` намеренно не проходит.

После правок собери и посмотри полный preview, затем явным «утверждаю» заморозь отдельную
approved-копию. Для discovery эта проверка обязательна и требует подтверждения просмотра:

```bash
node scripts/project/approve-brief.js \
  projects/2026.08.05_tema-rolika \
  brief/v01-draft.lesson.json --confirm-preview-viewed
```

Этап 2. Рендер утверждённого листа:

```bash
node scripts/build.js \
  projects/2026.08.05_tema-rolika/input/source.mp4 \
  --template lesson \
  --project-dir projects/2026.08.05_tema-rolika \
  --brief brief/v01-approved.lesson.json \
  --version-label first-render
```

На втором этапе LLM-ключ и повторная транскрибация не нужны. Движок проверяет статус,
тот же исходник, утверждённые тему и аспект, затем передаёт `faceSrc` и `audioSrc` в
`ReelScenes`. Draft, другой исходник, другая тема или другой аспект блокируются до рендера.
Каждая следующая правка получает свой `renders/vNN-<version-label>/`, а принятый файл лежит
в `final/<slug>.mp4`.

Для отдельной сцены approved JSON может содержать `faceSrc: "assets/faces/cutaway.mp4"` или
web-relative video из repository `public/`. Точное значение и тип сцены обязаны совпасть в
approved brief и render props. Build открывает локальный файл без follow, проверяет identity,
копирует его в одноразовый bundle и передаёт Remotion только `.automontage/.../media-N.ext`.
Custom video использует глобальный таймкод сцены и всегда muted; main voice продолжает идти из
top-level `audioSrc`. URL, absolute/traversal path, symlink и image/audio/text здесь запрещены.

Публичный approved fixture без LLM, музыки и внешней темы лежит в
`examples/lesson-neutral-approved.json`. Короткую проверку lesson и Dynamic вместе запускает
`npm run smoke:release`; скрипт оставляет оба финала для просмотра.

### 2. reel-captions :: Вертикаль: говорящая голова + субтитры (9:16)
Спикер на весь экран + караоке-субтитры по словам + плашки/счётчики/врезки.
Для Reels/Shorts/TikTok. Скины: `craft` (кремовый) и `cyber` (тёмный неон).
Это шаблон по умолчанию (собирается без ключей и без транскрипции по готовому листу).

- Композиция: `Dynamic` · Темы: `craft`, `cyber`
- Пайплайн: `node scripts/build.js <видео> [--theme craft|cyber]`
- Демо из коробки: `automontage demo` (лёгкое видео + готовый лист, без ключей)

### 3. highlight :: Крупная цитата (9:16 / 16:9)
Минимал: одна дословная фраза спикера крупно на фоне + подпись. Для нарезок-хайлайтов
и цитат. Скины нейтральные.

- Статус: НЕ реализован (композиции `Highlight` пока нет). Ранняя идея сохранена в
  историческом `PLAN.md`.

---

## Свой приватный бренд-пак (внешние темы)

Фирменный стиль (палитра, шрифты, декор) может лежать ВНЕ этого репозитория – в
отдельной приватной папке или приватном GitHub-репо. Движок подхватывает тему по id,
не таща сам стиль в open-source. Формат внешней темы – ровно тот же объект, что
встроенные (`src/theme/craft.js`): `colors`, `fonts`, `radius`, `cardShadow`,
`cardBorder`, `motion` (+ опц. блок `lesson` для декора уроков).

Структура бренд-пака:

```
мой-бренд-пак/
  themes/
    <theme-id>/
      theme.json     # объект темы (см. пример craft.js)
```

Подключение (на любой машине, без изменения кода движка):

```bash
export THEMES_EXT="/путь/с пробелами/мой-бренд-пак/themes"
node scripts/build.js видео.mp4 --theme <theme-id>
```

```powershell
$env:THEMES_EXT = "C:\путь с пробелами\мой-бренд-пак\themes"
node scripts/build.js видео.mp4 --theme <theme-id>
```

```bat
set "THEMES_EXT=C:\путь с пробелами\мой-бренд-пак\themes"
node scripts\build.js видео.mp4 --theme <theme-id>
```

Загрузчик `scripts/load-ext-theme.js` при `--theme <id>` ищет `$THEMES_EXT/<id>/theme.json`,
читает его объектом и отдаёт в `getTheme`. Встроенные id не требуют внешней папки. Любой
другой явно заданный id работает fail-closed: отсутствие `THEMES_EXT`, файла, блока
`colors` или валидного JSON останавливает сборку до Remotion. Ошибка показывает id, но не
раскрывает абсолютный путь бренд-пака.

### Памятка агенту: подключить приватный стиль на новой машине

Если пользователь монтирует в СВОЁМ фирменном стиле, а стиль живёт в приватном репо:

1. Склонировать движок и приватный бренд-пак рядом:
   `git clone <движок>` и `git clone <приватный-бренд-пак>`
2. Указать путь к темам: `export THEMES_EXT=/путь/к/бренд-пак/themes`
3. Монтировать: `node scripts/build.js видео.mp4 --theme <id-стиля>`

Точный адрес приватного репо и id дефолтного стиля пользователь хранит у себя (в памяти
агента или в README своего бренд-пака) – в этот открытый репозиторий они не пишутся.


## MotionReel: монтаж из narration

`automontage motion narration.wav --project "Название"` создаёт audio workspace и локальный
транскрипт со scaffold `brief/v01-draft.motion.json`. Агент заполняет его сценами `kinetic-title`,
`card`, `steps`, `list`, `counter`, `media`, `cta`, затем проходит preview → явный полный просмотр
→ `approve-brief.js --confirm-preview-viewed` → `automontage motion --project-dir … --brief …`.
Полная последовательность команд – в README, раздел «Motion Reel из готовой озвучки».

Схема `schema/motion-brief.schema.json` отдельна от lesson. `source`, `media.src` и `music.file`
ссылаются только на относительные файлы внутри workspace. Для media и music обязателен `sha256`.
Опциональная `music` принимает `gainDb`, fade/start/playbackRate/ducking как lesson и микшируется
через тот же FFmpeg pipeline. Дизайн использует фиксированную `motion-neutral`, камера и `faceSrc`
отсутствуют. Утверждённая копия и просмотр криптографически связаны с озвучкой; новая правка требует
нового draft и полного preview. В motion Review пока доступны просмотр/таймлайн, правки – через агента.
