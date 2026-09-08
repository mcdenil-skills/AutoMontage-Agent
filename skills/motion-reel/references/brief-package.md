# Пакет motion-reel brief

Пользователь утверждает конкретный текст, звук и визуальный результат. Пакет содержит:

1. Тему, цель, длительность, CTA и script; источник фактов/чисел и спорные формулировки.
2. Выбор готового аудио или явное согласие на платную ElevenLabs-озвучку; приватные ключи
   и voice ID в пакет не входят. Фактический transcript хранится в `transcript/words.json`.
3. Таблицу `start–end`, scene ID, экранного текста и ожидаемого reveal каждого элемента.
4. Локальные media, fit/trim/audioMode и SHA-256; optional music с gain/fades/ducking.
5. Валидный JSON, Markdown той же ревизии, полный preview и результат QA.

## Формат и сцены

Начни с `examples/motion-brief-demo.json`, но замени демонстрационный текст, длительность,
аудио, все пути и hashes на фактические данные проекта. Демо содержит вымышленные общие
формулировки, тестовые тоны вместо речи и иллюстративные word timings: это не транскрипция.

Обязательные поля: `version: 1`, `kind: "motion-reel"`, `status: "draft"`, `source`, `theme`,
`title`, `output`, `scenes`. `source` равен `manifest.source.localPath`, обычно
`input/narration.wav`. Используй `theme: "motion-neutral"`, `output.aspect: "vertical"`,
1080×1920/30 и фактическую длительность `ceil(audioDurationSec * fps)` в кадрах.
У каждого scene только разрешённые схемой свойства; все поля проверяются строго.

| ID | Поля помимо `start`, `end` и optional `caption` |
|---|---|
| `kinetic-title` | `text` ≤120, optional `emphasis` ≤40 |
| `card` | `title` ≤80, optional `body` ≤240 |
| `steps` | 2–4 `steps`, каждый ≤60, optional `title` ≤80 |
| `list` | 2–4 `items`, каждый ≤80, optional `title` ≤80 |
| `counter` | `label` ≤80, числовое `value`, optional `prefix`/`suffix` ≤16 |
| `media` | `media: {kind, src, sha256, fit}`, optional `overlayText` ≤120 |
| `cta` | `title`, `action` ≤80, optional `handle` ≤80 |

Optional `caption` ≤160. Верхние ограничения не цель: оставляй время на чтение.
`media.kind` — `image` или `video`; `fit` — `contain` или `cover`. У video допустимы
`trimStartSec` (frame-aligned) и `audioMode: mute|mix|replace`. Начало клипа локальное,
начало scene глобальное; источник озвучки не запускается заново на каждой сцене.
Файлы и их hashes проверяются при preview/approval/final. HTML, CSS, код и удалённые URL
не являются средством настройки сцены. Числа и цитаты не выдумывай.

## Публикация агентом

Публичный CLI создаёт scaffold; полную режиссуру готовит текущая агентная сессия.
Сохрани предлагаемый JSON в workspace, например `brief/proposed.motion.json`, затем из
корня движка проверь и зарегистрируй новую ревизию:

```bash
node - projects/<id> brief/proposed.motion.json <<'NODE'
const fs = require('node:fs');
const { createOrOpenProject, resolveProjectPath, publishBriefRevision } = require('./scripts/project/workspace');
const { validateMotionBrief } = require('./scripts/motion/brief');
const workspace = createOrOpenProject({ projectDir: process.argv[2] });
const proposed = resolveProjectPath(workspace.dir, process.argv[3], { mustExist: true, type: 'file' });
const brief = JSON.parse(fs.readFileSync(proposed, 'utf8'));
const result = validateMotionBrief(brief);
if (!result.ok) throw new Error(result.errors.join('\n'));
if (brief.status !== 'draft') throw new Error('Publish a draft, never a fabricated approval');
console.log(publishBriefRevision(workspace, { kind: 'motion-reel', brief }));
NODE
```

Это пример для shell с heredoc; на Windows агент выполняет тот же JavaScript через временный
локальный `.cjs` из корня движка. Не превращай его в новую пользовательскую CLI-команду.
`publishBriefRevision` сам создаёт согласованные `vNN-draft.motion.json` и `.md` и обновляет
manifest. Путь из результата используй для `automontage preview`. Не переименовывай draft в
approved вручную и не меняй JSON уже зарегистрированной версии на месте.

## QA и повторная правка

Проверяй полный ролик, а не только контрольные кадры. Убедись, что заголовок, list, steps,
число, media и CTA помещаются в safe zones, а аудио не скачет на стыках. В реальной речи
проверь соответствие текста произнесённым словам. При music оцени слышимость и ducking.
`node scripts/qa-preview.js --project-dir projects/<id>` проверяет текущий полный preview,
его hashes и медиа, но не подтверждает качество речи автоматически.

После правки нужна новая draft-пара и полный preview. `--confirm-preview-viewed` применяй
только после подтверждённого полного просмотра и явного утверждения. Готовый final проверь
визуально/на слух и по метаданным (1080×1920, 30 FPS по стандарту, H.264/AAC, длительность
brief и один выходной аудиопоток). Храни QA-заметки только внутри workspace.
