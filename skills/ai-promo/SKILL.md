---
name: ai-promo
description: >-
  Собирает безголосый промо-ролик, рекламу или трейлер на 20–30 секунд из AI-кинокадров
  (сейчас Higgsfield через OAuth MCP) и project-local Remotion-VFX под музыку в AutoMontage-Agent:
  согласованный текст, бюджет кредитов с явным согласием, ключевые кадры, оживление, VFX-пакет,
  саундтрек, `automontage motion --music-only`, настоящий preview, ручной QA, явное «утверждаю»
  и final. Используй для «промо-ролик», «рекламный ролик», «трейлер», «ролик из AI-кадров»,
  «Higgsfield», «ролик под музыку без голоса», даже если навык не назван.
metadata:
  compatibility: AutoMontage-Agent 1.14+, Node.js 20+, FFmpeg/FFprobe, Remotion browser; Higgsfield MCP с OAuth-входом пользователя (без API-ключа, тратит кредиты его тарифа).
---

# AI-промо без голоса

Короткий ролик под музыку: 3 сгенерированных кинокадра + 4 собственные Remotion-сцены с VFX,
надписи только из утверждённого текста. Движок собирает его как MotionReel без речи:
саундтрек – мастер-аудио, весь видеоряд – один отрендеренный project-local пакет в `media`-сцене.

Планирование, промпты, режиссура и QA выполняются в текущей подписке Claude Code/Codex.
Никакой `*_API_KEY` для этого навыка не нужен и не запрашивается: Higgsfield подключается через
OAuth MCP пользователя, остальное работает локально.

## Сначала выбери маршрут

Прочитай [`reel-turnkey/references/creative-motion.md`](../reel-turnkey/references/creative-motion.md).
Прочитай [`reel-turnkey/references/motion-craft.md`](../reel-turnkey/references/motion-craft.md) – числа и запреты движения.
Приём под каждую фразу речи подбирай по [`reel-turnkey/references/motion-library.md`](../reel-turnkey/references/motion-library.md) – каталог 703 анимаций Opus 5.5: что сказал спикер → приём → пример и как перенести.
Если пользователь ещё не выбрал способ оформления, покажи карточку **«Что делаем?»** (вопрос «Как монтируем?»)
из контракта только с неясными вопросами. Сюда ведёт ответ «Рекламный промо под музыку»; формат –
вертикаль 9:16 или горизонталь 16:9 (`--aspect horizontal`), длину (20–30 с) агент выбирает сам.
По умолчанию промо идёт как Creative Motion, вариант «Creative Motion + оверлеи Higgsfield» тратит
кредиты только после сметы и «да» ([cost-and-consent.md](references/cost-and-consent.md)), «По
ссылке-референсу» берёт ритм и механики донора без его материалов. «Реши сам» – Creative Motion.

## Границы

- Client-delivery mode: всё живёт в игнорируемой `projects/<id>/` – текст, ключевые кадры, клипы,
  референсы лица, саундтрек, `motion-vNN/`, provenance и рендеры. До создания проекта
  саундтрек сводится в игнорируемой `tmp/ai-promo/<slug>/` движка. Общие `src/`, `scripts/`,
  `schema/`, тесты и документацию ради одного ролика не меняй.
- Текст на экране – только из согласованной с пользователем копии. Факты, цифры, награды,
  отзывы и обещания не выдумывай; неподтверждённое помечай предложением и не выводи в кадр.
- Платная генерация – только после явного «да» пользователя на конкретную смету: на одну
  партию или один раз на весь план с разбивкой по партиям. Всё сверх утверждённой сметы –
  новый вопрос ([cost-and-consent.md](references/cost-and-consent.md)). Без автоповторов и
  обхода модерации.
- Лицо реального человека – только с его согласия и только по кадрам из его собственной записи
  ([identity-from-own-footage.md](references/identity-from-own-footage.md)).
- Оригинальный стиль: не воспроизводи логотипы, персонажей и фирменные заставки франшиз и не
  делай похожие на чужие знаки марки ([vfx-kit.md](references/vfx-kit.md)).
- CDN-ссылки результатов содержат id аккаунта: только локально, никогда в Git и Issues
  ([provenance.md](references/provenance.md)).
- Тяжёлые рендеры в одном checkout – последовательно, через общую очередь.

## Маршрут

Точки пользователя отмечены ✋. В остальном работай автономно: стиль, шрифт, палитру, ритм,
переходы и музыку решаешь сам и показываешь одним полным preview.

1. **Бриф, текст и трек** ✋. Цель, продукт, площадка, длина 20–30 с, CTA. Предложи короткую
   копию надписей (3–6 строк) и раскадровку из 7 сцен (3 AI-кадра + 4 Remotion-сцены) с кадрами
   склеек ([storyboard-and-prompts.md](references/storyboard-and-prompts.md)). На экран попадает
   только копия, которую пользователь согласовал. В этом же вопросе попроси лицензированный трек
   из его библиотеки: без него нет саундтрека, проекта и точной длины для сметы.
2. **Саундтрек.** Сегмент неиспользованного лицензированного трека, дроп на первом большом
   кадре, саб-бумы и вжухи на склейках раскадровки, премикс, loudnorm −14 LUFS, обрезка до
   целых кадров ([audio-recipe.md](references/audio-recipe.md)). Собирай в `tmp/ai-promo/<slug>/`
   движка. Этот файл – источник ролика и задаёт `TOTAL` пакета.
3. **Проект без речи.** `automontage motion tmp/ai-promo/<slug>/soundtrack.wav --project "<Название>" --music-only`
   (горизонтальный ролик 16:9 – с `--aspect horizontal`, 1920×1080; по умолчанию вертикаль 1080×1920):
   Whisper не запускается, transcript пуст, scaffold brief с `audioRole: "music"`
   ([engine-path.md](references/engine-path.md)). С этого момента всё – в `projects/<id>/`.
   Источник и лицензию трека сразу запиши в `assets/ai/provenance.json`. Согласованную копию сохрани в `projects/<id>/copy.md`. CTA с кодовым словом или «напиши в
   личку» – запиши обещание по разделу «Обещание в ролике» навыка
   [`skills/lead-magnet/SKILL.md`](../lead-magnet/SKILL.md) с `--source script --script copy.md`.
4. **Подключение провайдера.** Проверь Higgsfield MCP, вход и баланс
   ([higgsfield-mcp.md](references/higgsfield-mcp.md)). Модели и разрешения –
   [model-selection.md](references/model-selection.md).
5. **Бюджет** ✋. Сначала `get_cost` на каждую задачу, потом смета: задачи, модели, варианты,
   кредиты, итог, текущий баланс, жёсткий потолок. Генерация – только после явного
   подтверждения пользователем этой суммы кредитов
   ([cost-and-consent.md](references/cost-and-consent.md)): либо на одну партию (ключевые
   кадры, затем клипы), либо один раз на весь план со сметой по партиям и общим потолком. Всё
   сверх утверждённой сметы – лишние варианты, повторы, новая партия, цена `get_cost` выше
   сметы – новый вопрос.
6. **Ключевые кадры.** `nano_banana_pro`, 2k, 9:16 (для горизонтали 16:9), 2 варианта на кадр. Для героя – референсы
   из собственной записи автора. Скачай результаты в `projects/<id>/assets/ai/` и сразу дополни
   `provenance.json` ([provenance.md](references/provenance.md)).
7. **Выбор кадров** ✋. Покажи варианты. Если пользователь заранее поручил выбор агенту, выбери
   сам и коротко объясни выбор.
8. **Оживление.** Партия клипов: новый ✋ на бюджет (шаг 5), если план не был утверждён
   целиком. Image-to-video каждого из трёх кадров в `veo3_1` high 6 с и в `kling3_0` pro 5 с,
   затем лучший клип на кадр: обе модели – ради качества и выбора, а не экономии.
   У Veo-клипов есть свой звук – в пакете они всегда `muted`, а `media`-сцена – `audioMode: mute`.
9. **Motion-пакет.** Скопируй [`templates/motion-pack/`](templates/motion-pack/README.md) в
   `projects/<id>/motion-vNN/`, положи клипы в `public/clips/`, `TOTAL` = `durationInFrames`
   scaffold brief, `ASPECT` = `output.aspect` ТЗ (шаблон вертикальный; для 16:9 поставь `'horizontal'` и
   перекомпонуй сцены под 1920×1080, иначе клип обрежется), замени заглушки текстом из `copy.md`, адаптируй ДНК дизайна. Эффекты и
   правила стиля – [vfx-kit.md](references/vfx-kit.md). Контрольные кадры – `stills.cjs`.
10. **Рендер пакета.** `node projects/<id>/motion-vNN/render.cjs --brief brief/vNN-draft.motion.json`
    (флаг сверяет `ASPECT` с `output.aspect` ТЗ и останавливает рендер при расхождении): ровно `durationInFrames`
    кадров, `withAudio=false`, без звуковой дорожки. Скопируй рендер в `assets/`, посчитай SHA-256.
11. **Media-сцена.** Draft brief: одна `media`-сцена `start 0`, `end` = длительность,
    `fit: cover`, `audioMode: mute`, `frame: "full"` (клип на весь кадр 1080×1920, у горизонтали
    1920×1080, без рамки и зума сцены); публикация через `publishBriefRevision`. `brief.music`
    для music-only запрещён: вся музыка уже в источнике.
    **Цикл критика** (до рендера preview). Кадры рисуются прямо из композиции черновика ТЗ, без
    рендера preview: `automontage layer sheet --mode moments --project-dir projects/<id>` кладёт кадры
    ключевых моментов, лист и телефонный лист в `qa/moments-stills-*`. Запусти субагента
    `motion-critic` (в Codex – отдельного агента с заданием из
    [`motion-critic.md`](../reel-turnkey/references/motion-critic.md)); передай ему путь к свежему
    `qa/moments-stills-<sha8>.json`, который напечатал `layer sheet`, и номер круга. Он только читает
    кадры и отвечает JSON-отчётом. Сохрани ответ в файл и прогони `automontage critic --project-dir
    projects/<id> --report <файл.json>`. При `fix` («Решение: исправлять») исправь три названные
    худшие сцены в пакете, пересобери только пакет (шаг 10), обнови его `sha256` в ТЗ и снова
    нарисуй кадры (не больше трёх кругов). Внутри цикла только кадры:
    рендер видео внутри цикла запрещён. Единственное узкое исключение: пересборка видео-пакета
    ai-promo – это изготовление материала сцены, а не рендер ролика; байты пакета входят в отпечаток
    кадров, поэтому новые кадры получат новый `inputsSha256`. Рендер preview или final внутри цикла
    запрещён: `automontage preview` до решения критика не запускай. При `stop` («Решение:
    остановиться») переходи к шагу 12: preview рендерится один раз после `stop`. Оценки и причину
    остановки назови в сообщении пользователю.
12. **Preview.** Один раз после `stop` цикла критика:
    `automontage preview --project-dir projects/<id> --brief brief/vNN-draft.motion.json`
    (без браузера, например по SSH, – с `--no-open`: preview сохраняется, окно не открывается).
13. **QA.** Чёрные провалы, громкость −14 ± 1 LUFS / true peak ≤ −1,5 dBTP, одну дорожку
    48 кГц и кадр preview проверяет сам: при ❌ он не публикуется, причина – в
    `qa/motion-preview-full.json` (D-049). Остальное – вручную по
    [qa-checklist.md](references/qa-checklist.md): смотри и слушай сам – начало, дроп, финал,
    синхрон ударов, лица и руки, сгенерированные буквы, вотермарки, права.
14. **Утверждение** ✋. Покажи полный preview (и напомни про `automontage pult`). Только явное
    «утверждаю» пользователя к этой версии; QA, Save и просмотр утверждением не являются.
    Утверждать за пользователя через API пульта нельзя.
15. **Final.** Утверждение полного 1080p preview сразу даёт финал копированием (D-051): пульт и
    `approve-brief.js` (строка `final: …`) кладут просмотренный файл в `final/<slug>.mp4`, final QA
    идёт в фоне – команду final тогда не запускай. Если после «Утверждаю» в пульте во входящих
    строка «Утверждено» (фрагмент, 4K, старый preview), `approveBrief` уже выполнен и `brief/vNN-approved.motion.json` есть: сразу
    `automontage motion --project-dir projects/<id> --brief brief/vNN-approved.motion.json --version-label reviewed`.
    Только при явном «утверждаю» в чате сначала
    `node scripts/project/approve-brief.js projects/<id> brief/vNN-draft.motion.json --confirm-preview-viewed`,
    затем та же команда final, если `approve-brief.js` не напечатал `final: …`.
16. **QA final** по тому же чек-листу: H.264/AAC, 1080×1920 (горизонталь 1920×1080), 30 FPS, −14±1 LUFS, TP ≤ −1,5 dBTP,
    без watermark `ЧЕРНОВИК`. Отдай путь к `final/<slug>.mp4`, длительность, итог QA и потраченные кредиты.
17. **Чистка** – всегда после финала и QA: `automontage clean --project <id> --level archive` без
    `--yes`, покажи ГБ и список файлов. Команду с `--yes` – только после явного «да» пользователя
    в чате; без «да» ничего не удаляй.

Саундтрек связан с проектом хэшами. Если после создания проекта нужно сдвинуть удары или
сменить трек – новый проект с `--music-only`, `assets/ai/` и `motion-vNN/` копируются в него
([engine-path.md](references/engine-path.md)).

Любая правка после показа preview – новая версия пакета или brief, новый полный preview и новое
утверждение. Новая генерация после показа – снова через ✋ на бюджет, если она не входит в уже
утверждённую смету.

## Пульт роликов

- В начале работы выполни `automontage inbox` и сначала обработай входящие этого ролика.
- Выполненную правку из пульта отмечай `automontage inbox --accept <папка> <id>`.
- Варианты одной темы (разные хуки, длины) получают `pult-card.json` с общим `group`.

## Справочники

- [higgsfield-mcp.md](references/higgsfield-mcp.md) – подключение, OAuth, headless-запуск, скачивание.
- [cost-and-consent.md](references/cost-and-consent.md) – бюджет, согласие, потолок, сбои.
- [storyboard-and-prompts.md](references/storyboard-and-prompts.md) – раскадровка, промпты, расход.
- [identity-from-own-footage.md](references/identity-from-own-footage.md) – лицо автора и согласие.
- [model-selection.md](references/model-selection.md) – какие модели и когда.
- [vfx-kit.md](references/vfx-kit.md) – эффекты пакета и правила стиля.
- [audio-recipe.md](references/audio-recipe.md) – саундтрек для `--music-only`.
- [engine-path.md](references/engine-path.md) – точные команды движка.
- [qa-checklist.md](references/qa-checklist.md) – проверка preview и final.
- [provenance.md](references/provenance.md) – происхождение AI-файлов.
- [templates/motion-pack/README.md](templates/motion-pack/README.md) – шаблон пакета.
