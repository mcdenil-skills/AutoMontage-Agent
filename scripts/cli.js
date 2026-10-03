#!/usr/bin/env node
// Глобальная команда `automontage` – работает из любой папки на Windows/macOS/Linux.
// Движок сам находит свой корень (__dirname), результат кладёт в папку пользователя.
//
//   automontage <видео> [опции build.js]   – смонтировать ролик
//   automontage motion <audio> --project <name> – создать motion-черновик
//   automontage demo                        – собрать демо из примера в репозитории
//   automontage --help                      – помощь
const path = require('path');
const fs = require('fs');
const { execFileSync, spawn } = require('child_process');
const { buildDemoArgs, buildMotionDemoArgs, ensureOutputDestination } = require('./project/cli-options');
const { configureMediaToolPath } = require('./env');

const ROOT = path.join(__dirname, '..');

function help() {
  console.log(`AutoMontage-Agent – автомонтаж видео.

Использование:
  automontage <видео.mp4> [опции]     смонтировать (результат в текущей папке)
  automontage motion <audio> --project <name>  создать motion-черновик
  automontage motion --help          motion из аудио или явная платная ElevenLabs-озвучка
  automontage motion --project-dir . --brief brief/v01-approved.motion.json
                                      собрать утверждённый MotionReel
  automontage demo                    собрать демо-ролик из примера (без ключей и whisper)
  automontage demo --motion           создать motion-reel draft с тестовыми тонами (без речи/API)
                                      [--project-dir <новая-папка>], затем preview и утверждение
  automontage doctor                  проверить окружение (что доустановить)
  automontage review --project-dir .  открыть локальную проверку монтажного листа
  automontage pult                    открыть «Пульт роликов» со всеми роликами
  automontage pult --install-shortcut создать значок пульта (macOS/Windows)
  automontage inbox                   правки и утверждения из пульта для агента
  automontage queue                   состояние очереди тяжёлых задач
  automontage lead-magnet --help      лид-магниты: обещание, сборка, проверка (для агента)
  automontage preview --project-dir . --brief brief/v01-draft.lesson.json
                                      собрать настоящий Remotion-предпросмотр draft
  automontage takes add --project-dir . --file take2.mp4 [--file take3.mp4]
                                      добавить дубли одного ролика и локально расшифровать каждый
  automontage takes pack --project-dir .
                                      сводка фраз всех дублей для выбора лучших кусков
  automontage layer new --project-dir <p>
                                      motion-слой из деталей motion-kit
  automontage layer check --project-dir <p> --layer motion-v01
                                      гейты ритма, safe-zone, звуков по плану
  automontage layer render --project-dir <p> --layer motion-v01
                                      рендер слоя, когда машина свободна, + гейты
  automontage layer import --project-dir <p> --file <mp4>
                                      импорт проверенного слоя
  automontage layer brief --project-dir <p> --asset <ref> …
                                      draft brief со слоем на весь ролик
  automontage layer --help            все команды layer (new/words/check/render/import/brief/stock/sheet)
  automontage roughcut --project-dir <p> --edit edit/roughcut-v01.json
                                      черновая нарезка без графики для пульта (до master и слоя)
  automontage roughcut confirm --project-dir <p>
                                      нарезка готова – только по явным словам автора в чате
  automontage master --project-dir . --edit edit/v02-source.json [--quality 1080p|source]
    1080p по умолчанию; source (4k/native) сохраняет родной размер
                                      собрать новую source-ревизию без повторного Whisper
  automontage master --project-dir . --edit edit/v02-takes.json
                                      собрать ролик из лучших кусков разных дублей
  automontage clean [--level renders|archive] [--yes]
                                      отчёт, что можно удалить у готовых роликов; --yes удаляет
  automontage --help                  эта справка

Частые опции:
  --theme <id>          тема: Dynamic по умолчанию craft, lesson – lesson-neutral
  --template lesson     создать черновик ТЗ из 7 готовых сцен и остановиться
  --aspect source       формат как у исходника (дефолт для lesson)
  --aspect vertical     вертикальный результат 1080x1920
  --aspect horizontal   горизонтальный результат 1920x1080
  --brief file.json     рендер утверждённого lesson-ТЗ через ReelScenes
  --face-x 0.5          горизонтальный центр лица в исходнике, от 0 до 1
  --face-y 0.5          вертикальный центр лица в исходнике, от 0 до 1
  --face-zoom 1.05      дополнительное приближение спикера, от 1 до 2
  --title "ТЕМА"        заголовок для lesson
  --project "Тема"      создать локальную папку ролика с историей версий
  --project-dir <путь>   продолжить работу в существующей папке ролика
  --version-label <имя>  подпись новой версии рендера, например ducking
  --scenario file.json  готовый монтажный лист
  --no-transcribe       не транскрибировать (для монтажа по готовому --scenario)
  --model <id>          Whisper-модель (по умолчанию large-v3-turbo; также base, small, large-v3)
  --tighten             срезать паузы и слова-паразиты (не вместе с lesson)
  --beat                ритмичный зум под музыку
  --autopos             плашки автоматически мимо лица
  --reframe             перекадрировать Dynamic в вертикаль по лицу
  --outdir <путь>       куда положить результат (по умолчанию текущая папка)

Внешние темы подключаются по id через каталог THEMES_EXT.

Сначала проверь окружение: automontage doctor
Требуется: Node.js (>=20), Python 3, ffmpeg (libwebp нужен для загрузки фото в Review).`);
}

// Команды с собственной уборкой по сигналу: сигнал внешнему automontage передаётся ребёнку, внешний
// процесс ждёт его выхода и отдаёт его код (в том числе 2 у layer check/render). execFileSync так не
// умеет: убитый внешний процесс оставлял ребёнка доделывать работу (layer new дособирал слой).
// review – локальная проверка проекта; layer – motion-слой из деталей motion-kit и его проверки.
// Аргументы обеих не попадают в build.js.
// SIGHUP – закрытое окно терминала: без него осиротевший review-сервер и недостроенный layer new
// остаются висеть. layer new и review/cli.js убирают за собой на SIGHUP так же, как на SIGTERM.
const SIGNAL_FORWARDING = {
  review: { script: ['review', 'cli.js'], signalExitCodes: { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } },
  layer: { script: ['layer', 'cli.js'], signalExitCodes: { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } },
};

function runForwardingSignals({ script, signalExitCodes }, args, {
  platform = process.platform,
  spawnImpl = spawn,
  processLike = process,
} = {}) {
  const child = spawnImpl(
    process.execPath,
    [path.join(ROOT, 'scripts', ...script), ...args],
    { stdio: 'inherit', cwd: process.cwd(), shell: false },
  );
  // На Windows нет настоящих POSIX-сигналов: консольное событие (Ctrl+C/Ctrl+Break) и так доходит до
  // ребёнка напрямую через общую консольную группу. Дополнительный child.kill(signal) там – это
  // TerminateProcess, то есть жёсткое убийство поверх уже идущей уборки ребёнка (например, layer new
  // удаляет недостроенную папку по своему SIGINT) – снаружи только ждём его настоящий код выхода.
  const forwardToChild = platform !== 'win32';
  let forwardedSignal = null;
  let settled = false;
  const handlers = {};
  const restore = () => {
    for (const signal of Object.keys(signalExitCodes)) {
      processLike.removeListener(signal, handlers[signal]);
    }
  };
  const finish = (code) => {
    if (settled) return;
    settled = true;
    restore();
    processLike.exit(code);
  };
  for (const signal of Object.keys(signalExitCodes)) {
    handlers[signal] = () => {
      if (forwardedSignal) return;
      forwardedSignal = signal;
      if (!forwardToChild) return;
      try {
        child.kill(signal);
      } catch {
        // Сюда попадаем только на POSIX (forwardToChild уже false и выход выше – на Windows). Сам сигнал
        // по какой-то причине не ушёл (например, ребёнок уже завершается) – гасим его понятным SIGTERM.
        child.kill('SIGTERM');
      }
    };
    processLike.on(signal, handlers[signal]);
  }
  child.once('error', () => finish(1));
  child.once('exit', (code) => {
    if (Number.isInteger(code)) finish(code);
    else finish(forwardedSignal ? signalExitCodes[forwardedSignal] : 1);
  });
}

function main(argv = process.argv.slice(2)) {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { help(); process.exit(0); }

  try {
    configureMediaToolPath();
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  }

  // проверка окружения: automontage doctor
  if (argv[0] === 'doctor') {
    try { execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'doctor.js')], { stdio: 'inherit', cwd: ROOT }); }
    catch (e) { process.exit(e.status || 1); }
    process.exit(0);
  }

  if (argv[0] === 'motion') {
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'motion', 'build.js'), ...argv.slice(1)], {
        stdio: 'inherit', cwd: process.cwd(), shell: false,
      });
    } catch (error) { process.exit(error.status || 1); }
    process.exit(0);
  }

  if (argv[0] === 'demo' && argv[1] === '--motion') {
    try {
      execFileSync(process.execPath, buildMotionDemoArgs(ROOT, process.cwd(), argv.slice(2)), {
        stdio: 'inherit', cwd: process.cwd(), shell: false,
      });
    } catch (error) { if (!error.status) console.error(error.message); process.exit(error.status || 1); }
    process.exit(0);
  }

  // настоящий draft-preview: отдельная команда не попадает в approved final build.js
  if (argv[0] === 'preview') {
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'preview.js'), ...argv.slice(1)], {
        stdio: 'inherit', cwd: process.cwd(), shell: false,
      });
    } catch (e) { process.exit(e.status || 1); }
    process.exit(0);
  }

  // версионированный монтаж исходника: cut-list остаётся данными проекта
  if (argv[0] === 'master') {
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'project', 'build-master.js'), ...argv.slice(1)], {
        stdio: 'inherit', cwd: process.cwd(), shell: false,
      });
    } catch (e) { process.exit(e.status || 1); }
    process.exit(0);
  }

  // черновая нарезка: лёгкая копия из активного исходника для пульта, без новой ревизии
  if (argv[0] === 'roughcut') {
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'project', 'rough-cut-cli.js'), ...argv.slice(1)], {
        stdio: 'inherit', cwd: process.cwd(), shell: false,
      });
    } catch (e) { process.exit(e.status || 1); }
    process.exit(0);
  }

  // чистка готовых роликов: по умолчанию только отчёт, удаление – с --yes
  if (argv[0] === 'clean') {
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'project', 'clean.js'), ...argv.slice(1)], {
        stdio: 'inherit', cwd: process.cwd(), shell: false,
      });
    } catch (e) { process.exit(e.status || 1); }
    process.exit(0);
  }

  // дубли одного ролика: импорт, локальная расшифровка и сводка фраз для выбора
  if (argv[0] === 'takes') {
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'project', 'takes-cli.js'), ...argv.slice(1)], {
        stdio: 'inherit', cwd: process.cwd(), shell: false,
      });
    } catch (e) { process.exit(e.status || 1); }
    process.exit(0);
  }

  // пульт роликов, входящие и лид-магниты: отдельные скрипты, аргументы не попадают в build.js
  if (argv[0] === 'pult' || argv[0] === 'inbox' || argv[0] === 'lead-magnet') {
    const script = {
      pult: ['pult', 'cli.js'],
      inbox: ['pult', 'inbox.js'],
      'lead-magnet': ['lead-magnet', 'cli.js'],
    }[argv[0]];
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', ...script), ...argv.slice(1)], {
        stdio: 'inherit', cwd: process.cwd(), shell: false,
      });
    } catch (error) { process.exit(error.status || 1); }
    process.exit(0);
  }

  if (argv[0] === 'queue') {
    try {
      const { heavyQueueConfig, listHeavySlots } = require('./heavy-queue');
      const config = heavyQueueConfig();
      const busy = listHeavySlots(config).filter((slot) => slot.busy);
      console.log(`Очередь тяжёлых задач: ${busy.length ? 'занято' : 'свободно'} (слотов: ${config.slots})`);
      for (const slot of busy) {
        console.log(`Слот ${slot.index}: ${slot.label || 'другая тяжёлая задача'}; pid: ${slot.pid ?? 'неизвестен'}; начало: ${slot.acquiredAt || 'неизвестно'}`);
      }
      console.log(`Папка очереди: ${config.dir}`);
    } catch (error) {
      console.error(`❌ ${error.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (Object.hasOwn(SIGNAL_FORWARDING, argv[0])) {
    runForwardingSignals(SIGNAL_FORWARDING[argv[0]], argv.slice(1));
    return;
  }

  const buildJs = path.join(ROOT, 'scripts', 'build.js');

  let forward;
  if (argv[0] === 'demo') {
    // демо из коробки: лёгкое тест-видео + готовый монтажный лист, без whisper и ключей
    forward = buildDemoArgs(ROOT, process.cwd());
    const demoSrc = forward[0];
    const demoList = forward[2];
    if (!fs.existsSync(demoSrc) || !fs.existsSync(demoList)) {
      console.error('Демо-файлы не найдены (examples/demo-source.mp4 + examples/scenario-demo.json).');
      console.error('Смонтируй своё: automontage <видео.mp4>');
      process.exit(1);
    }
  } else {
    forward = argv.slice();
  }

  // В project-режиме папка ролика владеет финалом. Legacy-режим копирует его пользователю.
  forward = ensureOutputDestination(forward, process.cwd());

  try {
    // build.js резолвит видео от своего process.cwd() → запускаем с cwd пользователя
    execFileSync(process.execPath, [buildJs, ...forward], { stdio: 'inherit', cwd: process.cwd() });
  } catch (e) {
    process.exit(e.status || 1);
  }
}

if (require.main === module) main();

module.exports = { SIGNAL_FORWARDING, help, main, runForwardingSignals };
