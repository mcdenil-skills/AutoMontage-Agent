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
const argv = process.argv.slice(2);

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
  automontage preview --project-dir . --brief brief/v01-draft.lesson.json
                                      собрать настоящий Remotion-предпросмотр draft
  automontage master --project-dir . --edit edit/v02-source.json
                                      собрать новую source-ревизию без повторного Whisper
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

// локальная проверка проекта: аргументы review никогда не попадают в build.js
if (argv[0] === 'review') {
  const child = spawn(
    process.execPath,
    [path.join(ROOT, 'scripts', 'review', 'cli.js'), ...argv.slice(1)],
    { stdio: 'inherit', cwd: process.cwd(), shell: false },
  );
  const signalExitCodes = { SIGINT: 130, SIGTERM: 143 };
  let forwardedSignal = null;
  let settled = false;
  const handlers = {};
  const restore = () => {
    for (const signal of Object.keys(signalExitCodes)) {
      process.removeListener(signal, handlers[signal]);
    }
  };
  const finish = (code) => {
    if (settled) return;
    settled = true;
    restore();
    process.exit(code);
  };
  for (const signal of Object.keys(signalExitCodes)) {
    handlers[signal] = () => {
      if (forwardedSignal) return;
      forwardedSignal = signal;
      child.kill(signal);
    };
    process.on(signal, handlers[signal]);
  }
  child.once('error', () => finish(1));
  child.once('exit', (code) => {
    if (Number.isInteger(code)) finish(code);
    else finish(forwardedSignal ? signalExitCodes[forwardedSignal] : 1);
  });
} else {

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
