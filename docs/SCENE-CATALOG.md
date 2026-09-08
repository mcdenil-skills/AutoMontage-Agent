# Каталог сцен ReelScenes и MotionReel

Это полный повторно используемый набор lesson-сцен. Автоматический режиссёр выбирает только
из семи типов ниже; новая стилистическая просьба не должна создавать восьмой тип во время
монтажа клиентского ролика.

Audio-only `motion-reel` использует отдельную библиотеку из семи сцен:
[MotionReel ниже](#motionreel-семь-сцен-без-камеры). Lesson-правила спикера к ней не относятся.

| Сцена | Когда использовать | Основные свойства |
|---|---|---|
| `fullscreen` | Хук, связка, вывод | `caption`; вариант `side-overlay` использует `steps`, `stepStartsSec`, `facePos`; `centerOnFade` за последнюю секунду переводит заголовок в центр |
| `split` | Основное объяснение | `num`, `headCream`, `headOrange`, `bullets`; `animated-gradient` и `bulletDelaySec` управляют подачей |
| `bottom-diagram` | Последовательность | `headCream`, `headOrange`, `steps` |
| `blur-overlay` | Сильный акцент | `label`, `big`, `headCream`, `headOrange`, `sub` |
| `text-only` | Дословная цитата | `label`, `quoteCream`, `quoteOrange`, `author` |
| `stat` | Произнесённая метрика | `label`, `statCream`, `statOrange`, `headCream`, `headOrange`, `sub` |
| `broll` | Реальный визуальный пример | `brollMedia` или draft-only `brollIntent`, `headCream`, `headOrange`, `sub`, `showSpeakerPip` |

## Отрицательное пространство и постепенный текст

`fullscreen.variant: "side-overlay"` помещает текст с противоположной стороны от лица в
горизонтальном кадре. `stepStartsSec` содержит локальные секунды появления элементов `steps` и
должен совпадать с произнесением соответствующих фраз. Без явных времён используется безопасная
последовательная подача. `centerOnFade: true` оставляет последнюю секунду для плавного переезда
заголовка в центр.

## Настоящий b-roll

`brollMedia` принимает изображение или видео. `brollMedia.fit` равен `contain` или `cover`.
В draft вместо готового файла разрешён `brollIntent` с целью, фразой и поисковыми запросами:
preview показывает `[ B-ROLL ]`, пока человек не выберет локальный проверенный материал.
Незаполненный intent не проходит approval. Поиск, OCR и полный preview описаны в
[Review Workbench](REVIEW-WORKBENCH.md#7-назначить-b-roll-сцене).
Для видео `brollMedia.trimStartSec` задаёт глобально проверенный вход в клип, а
`brollMedia.audioMode` равен `mute`, `mix` или `replace`. Демонстрация экрана - всегда настоящее
видео, не zoom/pan скриншота. По умолчанию используется `audioMode: "mute"`, чтобы сохранить
голос мастера. `showSpeakerPip: false` убирает спикера поверх полноэкранного скринкаста.

Смысловую векторную схему для конкретного ролика можно собрать Remotion-кодом внутри его
игнорируемого `projects/<id>/`, отрендерить как немой MP4 и подключить через `brollMedia` с
`audioMode: "mute"`. Элементы должны строиться по смыслу: блок, соединитель, следующий блок,
результат; а не двигаться единой статичной картинкой. Это вариант `broll`, не восьмой тип сцены.
На полноэкранной схеме выключай `showSpeakerPip` и скрывай мешающие субтитры.

Все цвета и шрифты берутся из `theme`; локальная FFmpeg-отрисовка текста не является сценой.
Публичные примеры: `examples/lesson-horizontal-workflow-draft.json` и
`examples/lesson-vertical-workflow-draft.json`.

## MotionReel: семь сцен без камеры

Композиция `MotionReel` получает один аудиоисходник и `motion-neutral`; стандартный результат –
1080×1920/30. Это самостоятельный `motion-reel` brief, который не подходит для `ReelScenes`.
Хук может быть кинетическим текстом: камера и лицо в первые секунды не требуются.

| ID | Назначение | Поля и ограничения текста |
|---|---|---|
| `kinetic-title` | Хук с появлением слов | `text` ≤120, optional `emphasis` ≤40 |
| `card` | Один тезис на карточке | `title` ≤80, optional `body` ≤240 |
| `steps` | Узел → соединитель → следующий узел | 2–4 `steps` по ≤60; optional `title` ≤80 |
| `list` | Пункты в последовательной подаче | 2–4 `items` по ≤80; optional `title` ≤80 |
| `counter` | Число, подтверждённое сценарием | `label` ≤80, числовое `value`; optional `prefix`/`suffix` ≤16 |
| `media` | Проверенное локальное фото/видео с движением | `media: {kind, src, sha256, fit}`; optional `overlayText` ≤120 |
| `cta` | Понятное следующее действие | `title`, `action` ≤80; optional `handle` ≤80 |

У всех сцен обязательны `start`/`end`: глобальные секунды, привязанные к кадрам FPS brief,
без пересечений и выхода за длительность аудио. Не обнуляй озвучку при смене scene.
Optional `caption` ≤160 разрешён, но обычной полосы субтитров по умолчанию нет.
Готовые reveal-анимации дают движение без пользовательского React/CSS/JS в brief.

`media.kind` равен `image` или `video`, `fit` – `contain` или `cover`. Путь `src` относителен
workspace; SHA-256 обязателен. Video поддерживает `trimStartSec` и `audioMode`:
`mute` сохраняет только озвучку, `mix` добавляет тихий звук клипа, `replace` заменяет её
звуком клипа на время сцены. Все источники должны покрывать выбранный отрезок; remote URL
не поддерживаются. Optional music задаётся на уровне brief и проходит общее finish/ducking.

Публичный [пример](../examples/motion-brief-demo.json) покрывает все семь ID. Его тестовые тоны
и PNG создаёт `automontage demo --motion` локально; это не человеческая речь. Детали пакета,
согласования и QA – в [motion-reel skill](../skills/motion-reel/SKILL.md).
