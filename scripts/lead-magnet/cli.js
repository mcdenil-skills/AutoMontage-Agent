#!/usr/bin/env node
// scripts/lead-magnet/cli.js
const path = require('node:path');

const { resolveProjectPath } = require('../project/workspace');
const { resolveBrand } = require('./brand');
const { checkRevision } = require('./check');
const { setFunnelState } = require('./funnel');
const library = require('./library');
const { DECISION_ID } = require('./constants');
const { addOffer, readOffers } = require('./offers');
const { renderPdf } = require('./pdf');
const { readDecisions } = require('./requests');
const { importReference, shootReference } = require('./reference-tools');
const { writeScaffold } = require('./scaffold');

const ROOT = path.resolve(__dirname, '../..');

const HELP = `automontage lead-magnet – команды агента для лид-магнитов

  offer add --project-dir <папка> --code-word <слово> --kind comment-keyword|dm --quote "<цитата>"
            --units '<JSON>' [--format guide|prompts|checklist|cheatsheet] [--audience "<кто>"]
            [--source script --script <файл в папке ролика>]
  create --from <папка ролика> <r-id> --title "<название>" [--code-word <слово без обещания>]
  revision start --id <id>          revision publish --id <id> --revision <n>
  revision scaffold --id <id> --revision <n> [--force yes]
  pdf --id <id> --revision <n>
  reference import --id <id> --from <папка ролика> --path pult/lead-magnet-refs/<файл>
  reference shot --id <id> (--url <ссылка> | --file references/<файл>.html)
  check --id <id> --revision <n>
  link --id <id> --folder <папка ролика> --code-word <слово>
  promise update --id <id> --from <папка ролика>
  funnel set --id <id> --provider chatplace --exists yes|no [--name "<автоматизация>"]
  list [--code-word <слово>]        brand

Общий флаг: --projects-dir <путь> (по умолчанию projects/ движка).
Утверждает лид-магнит только человек в пульте – такой команды здесь нет.`;

function parseFlags(argv) {
  const flags = Object.assign(Object.create(null), { positional: [] });
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith('--')) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${argument} требует значение`);
      flags[argument.slice(2)] = value;
      index += 1;
    } else {
      flags.positional.push(argument);
    }
  }
  flags.projectsDir = path.resolve(flags['projects-dir'] || path.join(ROOT, 'projects'));
  return flags;
}

function need(flags, name) {
  if (!flags[name]) throw new Error(`нужен флаг --${name}`);
  return flags[name];
}

function formatTime(seconds) {
  if (seconds === null) return 'из сценария';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function videoProject(projectsDir, folder) {
  return resolveProjectPath(projectsDir, folder, { label: 'папка ролика', mustExist: true, type: 'directory' });
}

function checkedVideoFile(projectDir, relativePath, mustExist = false) {
  return resolveProjectPath(projectDir, relativePath, { label: relativePath, mustExist, type: 'file' });
}

const COMMANDS = {
  'offer add': (flags, write) => {
    const offer = addOffer(path.resolve(need(flags, 'project-dir')), {
      codeWord: need(flags, 'code-word'),
      kind: need(flags, 'kind'),
      quote: need(flags, 'quote'),
      units: JSON.parse(need(flags, 'units')),
      format: flags.format,
      audience: flags.audience,
      sourceKind: flags.source,
      scriptPath: flags.script,
    });
    write(`Обещание ${offer.id} «${offer.codeWord}» на ${formatTime(offer.startSec)}: «${offer.quote}».`);
  },
  create: (flags, write) => {
    const folder = need(flags, 'from');
    const [decisionId] = flags.positional;
    const projectDir = videoProject(flags.projectsDir, folder);
    if (typeof decisionId !== 'string' || !DECISION_ID.test(decisionId)) throw new Error('лид-магнит: неверный id запроса');
    checkedVideoFile(projectDir, 'pult/lead-magnet.json', true);
    const existing = library.listLeadMagnets(flags.projectsDir).entries.find((item) => item.request?.folder === folder
      && item.request.decisionId === decisionId);
    if (existing) {
      write(`Лид-магнит по запросу ${decisionId} уже создан: ${existing.id}. Продолжай его`);
      return;
    }
    const decision = readDecisions(projectDir).find((item) => item.id === decisionId && item.type === 'create' && item.status === 'new');
    if (!decision) throw new Error(`запрос ${decisionId} не найден в ${folder}`);
    let offer = null;
    if (decision.offerId !== null) {
      checkedVideoFile(projectDir, 'lead-magnet/offers.json');
      offer = readOffers(projectDir).find((item) => item.id === decision.offerId) || null;
      if (!offer) throw new Error(`обещание ${decision.offerId} не найдено у ролика ${folder}`);
    }
    const passport = library.createLeadMagnet(flags.projectsDir, {
      codeWord: decision.codeWord || need(flags, 'code-word'),
      title: need(flags, 'title'),
      promise: offer
        ? { quote: offer.quote, startSec: offer.startSec, endSec: offer.endSec, sourceFolder: folder }
        : { quote: null, startSec: null, endSec: null, sourceFolder: folder },
      units: offer ? offer.units : [],
      params: decision.params,
      videoFolder: folder,
      request: { folder, decisionId },
    });
    write(`Создан лид-магнит ${passport.id}. Дальше: automontage lead-magnet revision start --id ${passport.id}`);
  },
  'revision start': (flags, write) => {
    const { n, dir } = library.startRevision(flags.projectsDir, need(flags, 'id'));
    write(`Ревизия ${n}: ${dir}`);
  },
  'revision scaffold': (flags, write) => {
    const written = writeScaffold(flags.projectsDir, need(flags, 'id'), Number(need(flags, 'revision')), { force: flags.force === 'yes' });
    write(written.length
      ? `Заготовка: ${written.join(', ')}. Заполни все места с data-lm-todo.`
      : 'Файлы уже есть – заготовка не перезаписана (добавь --force yes, если нужно).');
  },
  'revision publish': (flags, write) => {
    const passport = library.publishRevision(flags.projectsDir, need(flags, 'id'), Number(need(flags, 'revision')));
    write(`Ревизия ${passport.current} показана в пульте.`);
  },
  pdf: async (flags, write) => {
    await renderPdf(flags.projectsDir, need(flags, 'id'), Number(need(flags, 'revision')));
    write('PDF готов. Печатай его после последней правки страницы.');
  },
  'reference import': (flags, write) => {
    const target = importReference(flags.projectsDir, need(flags, 'id'), { folder: need(flags, 'from'), storedPath: need(flags, 'path') });
    write(`Референс в библиотеке: references/${path.basename(target)}`);
  },
  'reference shot': async (flags, write) => {
    const result = await shootReference(flags.projectsDir, need(flags, 'id'), { url: flags.url || null, file: flags.file || null });
    write(`Снимки: ${result.files.join(', ')}`);
    write(`Текст страницы (начало): ${result.text}`);
  },
  check: async (flags, write) => {
    const report = await checkRevision(flags.projectsDir, need(flags, 'id'), Number(need(flags, 'revision')));
    for (const item of report.items) write(`${item.ok ? '✓' : '✕'} ${item.id}: ${item.message}`);
    write(report.ok ? 'Каркас и факты: всё зелёное.' : 'Есть красные пункты – исправь до показа.');
    return report.ok ? 0 : 1;
  },
  link: (flags, write) => {
    const passport = library.linkVideo(flags.projectsDir, need(flags, 'id'), { folder: need(flags, 'folder'), codeWord: need(flags, 'code-word') });
    write(`Ролик привязан к ${passport.id}: ${passport.videos.join(', ')}`);
  },
  'promise update': (flags, write) => {
    const id = need(flags, 'id');
    const folder = need(flags, 'from');
    const passport = library.readLeadMagnet(flags.projectsDir, id);
    const projectDir = videoProject(flags.projectsDir, folder);
    checkedVideoFile(projectDir, 'lead-magnet/offers.json');
    const offers = readOffers(projectDir);
    const offer = passport.codeWords.map((word) => offers.find((item) => item.codeWord === word)).find(Boolean);
    if (!offer) throw new Error(`у ролика ${folder} нет обещания со словом лид-магнита`);
    library.updatePromise(flags.projectsDir, id, { quote: offer.quote, startSec: offer.startSec, endSec: offer.endSec, sourceFolder: folder }, { units: offer.units });
    write(`Обещание обновлено: «${offer.quote}». Собери новую ревизию.`);
  },
  'funnel set': (flags, write) => {
    const exists = need(flags, 'exists');
    if (exists !== 'yes' && exists !== 'no') throw new Error('--exists: yes или no');
    const id = need(flags, 'id');
    const passport = library.readLeadMagnet(flags.projectsDir, id);
    const state = setFunnelState(flags.projectsDir, id, {
      provider: need(flags, 'provider'), codeWord: passport.codeWords[0], exists: exists === 'yes', automationName: flags.name || null,
    });
    write(`Воронка на слово ${state.codeWord}: ${state.exists ? 'есть' : 'нет'}.`);
  },
  list: (flags, write) => {
    const entries = flags['code-word'] ? library.findByCodeWord(flags.projectsDir, flags['code-word']) : library.listLeadMagnets(flags.projectsDir).entries;
    if (!entries.length) write('Лид-магнитов нет.');
    for (const item of entries) {
      write(`${item.id} · ${item.codeWords.join(', ')} · ${item.approved !== null ? 'утверждён' : 'в работе'} · роликов: ${item.videos.length}`);
    }
  },
  brand: (flags, write) => {
    const resolved = resolveBrand();
    write(resolved.source === 'pack'
      ? `Бренд-пак «${resolved.brand.name}». Логотип ${resolved.brand.logoRequired ? 'обязателен' : 'не обязателен'}.`
      : 'Бренд-пака нет – нейтральный стиль движка, без логотипа.');
    write(`Навыки голоса: ${resolved.brand.voice.skills.join(', ') || 'нет'}.`);
  },
};

async function main(argv = process.argv.slice(2), { write = (line) => console.log(line) } = {}) {
  try {
    if (!argv.length || argv[0] === '--help') { write(HELP); return 0; }
    const twoWords = `${argv[0]} ${argv[1] || ''}`;
    const name = Object.hasOwn(COMMANDS, twoWords) ? twoWords : argv[0];
    if (!Object.hasOwn(COMMANDS, name)) throw new Error(`неизвестная команда «${argv[0]}». Справка: automontage lead-magnet --help`);
    const result = await COMMANDS[name](parseFlags(argv.slice(name.split(' ').length)), write);
    return name === 'check' ? result : 0;
  } catch (error) {
    write(`❌ lead-magnet: ${error.message}`);
    return 1;
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { main };
