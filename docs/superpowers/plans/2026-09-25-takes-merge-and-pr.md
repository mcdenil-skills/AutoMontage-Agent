# Takes Merge and PR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** влить свежий `main` (с пультом роликов из PR #26) в ветку `feat/multi-take-master`, добавить в Windows-задание CI настоящие FFmpeg-тесты склейки дублей, проверить всё локально, запушить ветку и открыть PR в `main` с зелёным CI. Сам PR в `main` не вливать.

**Architecture:** merge-коммит `origin/main` → ветка, а не rebase: в ветке больше 60 коммитов, rebase заставил бы разрешать конфликты многократно и переписал бы историю, которую уже проверяли ревью; PR #26 тоже влит merge-коммитом. Windows-шаг ставится в конец задания `portable-media-windows` после шага пульта и перед ним стоит проверка кодера libx264, чтобы настоящие тесты не пропустились молча.

**Tech Stack:** git, GitHub CLI `gh`, GitHub Actions (`windows-latest`, choco FFmpeg 7.1.1, PowerShell), Node.js 20 test runner.

---

## Факты, на которых построен план (проверено 2026-09-25)

- **F1.** `origin/main` = `0a97f3e` (Merge PR #26 «пульт роликов»). Общий предок с веткой – `e888305`, в `main` после него 61 коммит.
- **F2.** `git merge-tree --write-tree HEAD origin/main` показывает конфликты только в двух файлах:
  - `scripts/cli.js`: обе ветки вставили свой блок маршрутизации сразу после блока `master`. Ветка добавила `takes`, main добавил `pult`/`inbox`. Хвост `process.exit(0);\n}` у блоков общий, поэтому git склеил их в один конфликт.
  - `DECISIONS.md`: обе ветки дописали новую запись в конец. Ветка добавила D-031 «Монтаж из нескольких дублей», main добавил D-030 «Пульт роликов».
  - Автоматически сливаются `ARCHITECTURE.md`, `CHANGELOG.md`, `README.md`, `TESTING.md`, `package.json`, `skills/reel-turnkey/SKILL.md`.
- **F3.** CI (`.github/workflows/ci.yml`) запускается на `pull_request` и на push в `main`. Задание `portable-media-windows` ставит `choco install ffmpeg --version=7.1.1` и выполняет шаги в `shell: pwsh`; последний шаг – «Проверить пульт роликов». Ветка сама `ci.yml` не меняла.
- **F4.** Настоящие тесты склейки дублей пропускаются (`t.skip`) без `ffmpeg`, `ffprobe` или кодера `libx264`. Проверку кодера делает `ffmpegEncoderAvailable` в `tests/helpers/media-fixtures.js`: `ffmpeg -hide_banner -encoders` и слово `libx264` в выводе. Настоящих тестов 9:
  - `tests/trim-media-real.test.js` – 2;
  - `tests/takes-master-media.test.js` – 3;
  - `tests/take-pauses.test.js` – 2;
  - `tests/project-takes.test.js` – 2.
- **F5.** `npm run check:release -- --base <ref>` сверяет добавленные строки относительно базы. `test:review-ui` в main включает `tests/pult-ui.spec.js`.
- **F6.** `gh` авторизован (аккаунт Ntmib), remote `origin` = `mcdenil-skills/AutoMontage-Agent`. PR #26 оформлен по-русски: «Что даёт», «Как проверено», «Известные ограничения».

## Глобальные ограничения

- Не `git stash` (общий стек с другими worktree), не `--no-verify`, не `--force`, не `reset --hard`, не amend опубликованных коммитов.
- Не вливать PR в `main` и не мержить локально в `main`: по просьбе владельца только открыть PR.
- Никакого длинного тире U+2014 и абсолютных личных путей в добавленных строках.
- Красный CI – не повод отключать тест или шаг: найти первопричину, сделать минимальное исправление с регрессионным тестом, запушить обычным коммитом.

---

### Task 0: Закоммитить этот план

**Files:** Create `docs/superpowers/plans/2026-09-25-takes-merge-and-pr.md`.

- [ ] **Step 1:** `git add docs/superpowers/plans/2026-09-25-takes-merge-and-pr.md && git commit -m "docs: plan the takes branch merge and PR"` (с трейлером `Co-Authored-By`). Ожидается: hook (privacy + Gitleaks) passed.

### Task 1: Влить `origin/main` и разрешить конфликты

**Files:**
- Modify (конфликт): `scripts/cli.js`, `DECISIONS.md`.
- Проверить автослияние: `CHANGELOG.md`, `package.json`, `README.md`, `ARCHITECTURE.md`, `TESTING.md`, `skills/reel-turnkey/SKILL.md`.

- [ ] **Step 1: Обновить remote и начать слияние.**
  ```bash
  git fetch origin
  git status --short            # ожидается пусто
  git merge --no-ff --no-commit origin/main
  ```
  Ожидается: `CONFLICT (content)` ровно в `scripts/cli.js` и `DECISIONS.md`. Любой другой конфликт – остановиться, выяснить причину (main мог уйти вперёд) и дополнить план.

- [ ] **Step 2: `scripts/cli.js` – оставить оба блока, каждый со своим выходом.** Весь участок между блоком `master` и следующим кодом должен стать ровно таким:
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

  // пульт роликов и входящие агента: отдельные скрипты, аргументы не попадают в build.js
  if (argv[0] === 'pult' || argv[0] === 'inbox') {
    const script = argv[0] === 'pult' ? 'cli.js' : 'inbox.js';
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'pult', script), ...argv.slice(1)], {
        stdio: 'inherit', cwd: process.cwd(), shell: false,
      });
    } catch (error) { process.exit(error.status || 1); }
    process.exit(0);
  }
  ```
  Затем проверить остальной `cli.js` (он слит автоматически): в тексте `--help` есть и `takes`, и `pult`/`inbox`, если обе ветки их добавляли, и нет дублей.
  ```bash
  grep -n "<<<<<<<\|>>>>>>>\|=======" scripts/cli.js   # ожидается пусто
  node scripts/cli.js --help | grep -n "takes\|pult\|inbox\|master"
  ```

- [ ] **Step 3: `DECISIONS.md` – сначала D-030, потом D-031.** Взять блок main (`## D-030 – Пульт роликов…` до конца записи) и после одной пустой строки блок ветки (`## D-031 – Монтаж из нескольких дублей…` до конца). Оба текста дословно, маркеры конфликта удалить.
  ```bash
  grep -n "<<<<<<<\|>>>>>>>\|^=======$" DECISIONS.md   # ожидается пусто
  grep -n "^## D-0" DECISIONS.md | tail -4             # ожидается … D-029, D-030, D-031 по порядку, каждый один раз
  ```

- [ ] **Step 4: Проверить автослияние.**
  - `CHANGELOG.md`: в `[Unreleased]` пункты обеих веток (пульт и дубли), без повторов, заголовки разделов (`### Добавлено`, `### Исправлено`…) не задвоены: `sed -n '/## \[Unreleased\]/,/^## \[/p' CHANGELOG.md`.
  - `package.json`: JSON валиден; `test:video-edit` содержит `tests/take-pauses.test.js`; `test:review-ui` содержит `tests/pult-ui.spec.js`: `node -e "const p=require('./package.json');console.log(p.scripts['test:video-edit']);console.log(p.scripts['test:review-ui'])"`.
  - `README.md`, `ARCHITECTURE.md`, `TESTING.md`, `skills/reel-turnkey/SKILL.md`: `git diff --cached --stat` и беглый просмотр мест, которые меняли обе ветки (`git diff origin/main -- <file>` показывает только правки дублей).
  - Во всём дереве нет маркеров: `git grep -n "^<<<<<<< \|^>>>>>>> " -- . ':!docs/superpowers/plans'` – пусто.

- [ ] **Step 5: Тесты на слитом дереве до коммита.**
  ```bash
  PATH="/opt/homebrew/opt/ffmpeg-full/bin:$PATH" npm test
  ```
  Ожидается: `fail 0`, пропуски только штатные (6, тяжёлые приёмки Remotion/браузера) плюс, возможно, штатные пропуски тестов пульта.
  ```bash
  node --test tests/takes-cli.test.js tests/cli.test.js
  ```
  Маршрутизация `takes` и `pult` – зелёная.

- [ ] **Step 6: Закоммитить слияние.**
  ```bash
  git add scripts/cli.js DECISIONS.md
  git commit --no-edit --trailer "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  # сообщение по умолчанию "Merge remote-tracking branch 'origin/main' into feat/multi-take-master"
  ```
  Hook запустит privacy-check и Gitleaks на staged-дереве; должен пройти. Если hook остановит из-за файлов, пришедших из main, выяснить причину, `--no-verify` не использовать.

### Task 2: Настоящие FFmpeg-тесты дублей в Windows CI

**Files:** Modify `.github/workflows/ci.yml` (конец задания `portable-media-windows`), `tests/project-takes.test.js:269`, `TESTING.md` (абзац про настоящие тесты склейки и абзац про `portable-media-windows`).

- [ ] **Step 0: Сделать тест `project-takes` переносимым (иначе новый шаг упадёт на Windows всегда).** Тест `transcribeTakeFile` передаёт `videoPath: '/tmp/source.mp4'` и ждёт этот путь обратно, но движок пропускает путь через `hostPath` (`path.resolve`), и на Windows получается `D:\tmp\source.mp4`. Заменить строку 269:
  ```js
    assert.deepEqual(ffmpegArgs.slice(0, 5), ['-y', '-i', '/tmp/source.mp4', '-map', '0:a:0']);
  ```
  на (так уже сделано в `tests/take-pauses.test.js:467`; на POSIX результат тот же):
  ```js
    assert.deepEqual(ffmpegArgs.slice(0, 5), ['-y', '-i', path.resolve('/tmp/source.mp4'), '-map', '0:a:0']);
  ```
  `path` в файле уже подключён. Проверка: `node --test tests/project-takes.test.js` – зелёный; `node -e "console.log(require('path').win32.resolve('/tmp/source.mp4'))"` показывает, что Windows-форма отличается, и прежнее ожидание падало бы.

- [ ] **Step 1: Добавить два шага после «Проверить пульт роликов»** (отступы как у соседних шагов, 6 пробелов перед `-`). Проверка кодера читает только stdout и код выхода, как `ffmpegEncoderAvailable`, и пишет аннотацию, как Linux-задание:
  ```yaml
        - name: Проверить кодер libx264 для настоящих тестов склейки
          shell: pwsh
          run: |
            $encoders = (ffmpeg -hide_banner -encoders) | Out-String
            if ($LASTEXITCODE -ne 0 -or $encoders -notmatch '\blibx264\b') {
              Write-Output '::error::FFmpeg без libx264: настоящие тесты склейки дублей пропустились бы молча'
              exit 1
            }

        - name: Проверить склейку дублей на настоящем FFmpeg 7
          shell: pwsh
          run: node --test tests/trim-media-real.test.js tests/takes-master-media.test.js tests/take-pauses.test.js tests/project-takes.test.js
  ```

- [ ] **Step 2: Проверить YAML локально.**
  ```bash
  node -e "require('yaml')" 2>/dev/null && node -e "const y=require('yaml');const d=y.parse(require('fs').readFileSync('.github/workflows/ci.yml','utf8'));const s=d.jobs['portable-media-windows'].steps;console.log(s.slice(-3).map(x=>x.name).join(' | '))" || ruby -ryaml -e "d=YAML.load_file('.github/workflows/ci.yml');puts d['jobs']['portable-media-windows']['steps'].last(3).map{|s|s['name']}.join(' | ')"
  ```
  Ожидается: `Проверить пульт роликов | Проверить кодер libx264 для настоящих тестов склейки | Проверить склейку дублей на настоящем FFmpeg 7`.

- [ ] **Step 3: Проверить, что шаг действительно гоняет настоящие тесты.** Прогнать ту же команду локально на FFmpeg 7:
  ```bash
  PATH="/opt/homebrew/opt/ffmpeg@7/bin:$PATH" node --test tests/trim-media-real.test.js tests/takes-master-media.test.js tests/take-pauses.test.js tests/project-takes.test.js
  ```
  Ожидается: `fail 0`, `skipped 0`.

- [ ] **Step 4: `TESTING.md`.**
  - В абзаце о настоящих тестах склейки предложение занимает три строки: «Перед / изменением склейки … Linux CI добавляет / FFmpeg 6.x.». Заменить его на:

    `Перед изменением склейки прогони их с FFmpeg 7 и FFmpeg 9 в \`PATH\`; Linux CI добавляет FFmpeg 6.x, а Windows CI прогоняет их вместе с \`tests/project-takes.test.js\` на FFmpeg 7.1 и падает, если у FFmpeg нет \`libx264\`, чтобы тесты не пропустились молча.`

  - В абзаце про `portable-media-windows` (около строки 152) добавить в перечень того, что запускает задание: `настоящие тесты склейки дублей (\`tests/trim-media-real.test.js\`, \`tests/takes-master-media.test.js\`, \`tests/take-pauses.test.js\`, \`tests/project-takes.test.js\`) после проверки кодера \`libx264\``. Формулировку согласовать с соседним перечнем.
  - Переносы строк – по ширине абзаца, около 100 символов.

- [ ] **Step 5: Проверки и коммит.** `check:release` читает дерево коммита, поэтому новое дерево проверяется через `git write-tree` до коммита:
  ```bash
  git add .github/workflows/ci.yml TESTING.md tests/project-takes.test.js
  git diff --cached -U0 | grep '^+' | grep -c "$(printf '\342\200\224')"   # 0
  node scripts/check-public-privacy.js --staged && npm run check:release -- --tree "$(git write-tree)" --base origin/main
  git commit -m "ci: run real takes FFmpeg tests on Windows"   # + трейлер Co-Authored-By
  ```

### Task 3: Итоговая локальная проверка перед push

- [ ] **Step 1:** `PATH="/opt/homebrew/opt/ffmpeg-full/bin:$PATH" npm test`. Ожидается `fail 0`.
- [ ] **Step 2:** Настоящие тесты на FFmpeg 7 (команда из Task 2 Step 3). Ожидается `fail 0`, `skipped 0`.
- [ ] **Step 3:** `npm run test:review-ui`. Ожидается: все зелёные. Если браузер Playwright не установлен локально, записать это и положиться на задание `review-ui` в CI.
- [ ] **Step 4:** `npm run check:privacy && npm run check:release && npm run check:release -- --base origin/main`. Все три – passed.
- [ ] **Step 5:** В PR не попадёт ничего локального:
  ```bash
  git status --short                                             # пусто
  git diff --name-only origin/main...HEAD | grep -E '^(projects|input|out|tmp|memory)/|MEMORY.md|_progress.md|\.env' || echo "clean"
  ```
  Ожидается `clean`.

### Task 4: Push, PR и CI

- [ ] **Step 0: Убедиться, что main не ушёл вперёд.**
  ```bash
  git fetch origin
  git merge-base --is-ancestor origin/main HEAD && echo "main not moved"
  ```
  Если `main not moved` не напечатано, повторить Task 1 (новый merge-коммит) и Task 3, потом вернуться сюда.

- [ ] **Step 1: Push ветки.**
  ```bash
  git push -u origin feat/multi-take-master
  ```
  Ожидается: новая удалённая ветка. 403/404 означает проблему с правами токена, а не отсутствие репозитория.

- [ ] **Step 2: Текст PR** записать во временный файл сессии (не в репозиторий), по-русски, в формате PR #26:
  - заголовок: `feat: build one video from the best takes, cutting in pauses`;
  - `## Что даёт`: `automontage takes add|pack`, `automontage master` для `edit/vNN-takes.json`, авто-разрез в паузах без перехода через слово, очистка галлюцинаций Whisper, маршрут навыка «один ролик из разных записей по сценарию»; ссылки на `DECISIONS.md` D-031, `ARCHITECTURE.md`, `README.md`, `skills/reel-turnkey/references/takes-selection.md`;
  - `## Как проверено`:
    - `npm test` с числами из Task 3;
    - FFmpeg 7 и 9;
    - `check:release` (обычный и `--base origin/main`);
    - исполнитель, проверка соответствия и проверка качества на каждую задачу; финальное ревью – Ready to merge;
    - живая проба на прошлых записях автора (5 бывших дефектов исправлены автоматически, стыки тихие по уровню);
    - новый Windows-шаг запускается впервые в этом PR;
  - `## Известные ограничения`:
    - граница между склеенными без паузы словами остаётся в речи и печатается `no pause near`;
    - защита по словам доверяет таймингам Whisper;
    - ничьи и провал короче 50 мс внутри соседнего слова блокируют сдвиг;
    - `collectWords` отклоняет слова нулевой длины в `master`/`--tighten`/`cut-pauses` (старое, отдельная задача);
    - смешение HDR и SDR дублей не проверяется;
  - последней строкой: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
  - Проверить файл на U+2014 и абсолютные личные пути.

- [ ] **Step 3: Открыть PR.**
  ```bash
  gh pr create --repo mcdenil-skills/AutoMontage-Agent --base main --head feat/multi-take-master --title "feat: build one video from the best takes, cutting in pauses" --body-file <временный файл>
  ```
  Ожидается: URL PR.

- [ ] **Step 4: Дождаться CI и проверить, что настоящие тесты на Windows не пропущены.** На CI Node 20 печатает TAP (`ok N - …`, `# SKIP`), а не `ℹ`, и `gh run view --log` не даёт отфильтровать строки по имени шага:
  ```bash
  R=mcdenil-skills/AutoMontage-Agent
  RUN_ID=$(gh run list --repo $R --branch feat/multi-take-master --event pull_request --workflow ci.yml --limit 1 --json databaseId --jq '.[0].databaseId')
  gh run watch "$RUN_ID" --repo $R --exit-status
  JOB_ID=$(gh run view "$RUN_ID" --repo $R --json jobs --jq '.jobs[] | select(.name | startswith("Windows")) | .databaseId')
  gh run view --repo $R --job "$JOB_ID" --log | grep -E ' (ok|not ok) [0-9]+ - real (runTrim|segments concat|takes master|levels|transcribeTakeFile)'
  ```
  Ожидается ровно 9 строк, все `ok`, ни одной с `# SKIP`. Если сразу после создания PR `gh run list` ещё пуст, подождать минуту и повторить. `gh pr checks <N> --repo $R --watch` в первые секунды может ответить «no checks reported».

- [ ] **Step 5: Если CI красный.** Прочитать лог упавшего шага. Найти первопричину, скорее всего Windows-специфичную: пути, `hostPath`, разделители, кодировки. Сделать минимальное исправление в ветке. Если причина в коде, добавить регрессионный тест. Прогнать локальные проверки Task 3 и запушить обычным коммитом. Шаг не отключать и тест не пропускать. Если исправление требует решения владельца, остановиться и спросить.

- [ ] **Step 6: Готово.** PR открыт, CI зелёный. PR в `main` не вливать.
  - Записать номер PR и результат CI в дневник проекта.
  - Локальный `_progress.md` существует только на время незавершённой работы: перенести из него в дневник то, что ещё нужно, и удалить файл.
