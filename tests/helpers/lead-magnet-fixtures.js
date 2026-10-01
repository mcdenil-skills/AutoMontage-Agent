// tests/helpers/lead-magnet-fixtures.js
const fs = require('node:fs');
const path = require('node:path');

const { inputFingerprint } = require('../../scripts/lead-magnet/check');
const { addOffer } = require('../../scripts/lead-magnet/offers');
const { hashFile } = require('../../scripts/pult/files');
const { addDraftProject, makePultRoot } = require('./pult-projects');

const WORDS = [
  { start: 58, end: 64, text: 'Напишите ГАЙД в комментариях, и я пришлю пошаговую инструкцию и пять промптов.', words: [
    ' Напишите', ' ГАЙД', ' в', ' комментариях,', ' и', ' я', ' пришлю', ' пошаговую', ' инструкцию',
    ' и', ' пять', ' промптов.',
  ].map((w, index) => ({ w, s: 58 + index * 0.5, e: 58.25 + index * 0.5 })) },
];
const QUOTE = 'и я пришлю пошаговую инструкцию и пять промптов';
const UNITS = [
  { key: 'step', count: null, label: 'пошаговая инструкция' },
  { key: 'prompt', count: 5, label: 'промптов' },
];

// Папка ролика с минимальным паспортом: offers.js читает из него только transcript.words.
function makeVideoProject(t, folder = '2026.09.30_sayt-za-vecher') {
  const { base, projectsDir } = makePultRoot(t);
  const projectDir = path.join(projectsDir, folder);
  fs.mkdirSync(path.join(projectDir, 'transcript'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'transcript', 'words.json'), JSON.stringify(WORDS));
  fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify({
    version: 1, transcript: { words: 'transcript/words.json', captions: 'transcript/captions.js' },
  }));
  return { base, projectsDir, projectDir, folder };
}

const library = require('../../scripts/lead-magnet/library');

const PARAMS = {
  format: 'guide',
  audience: 'новички',
  design: { mode: 'brand', take: { composition: true, colors: false, fonts: false }, likeId: null, note: '', references: [] },
  texts: ['dm', 'telegram', 'instagram'],
  wishes: '',
  promiseConfirmed: true,
};

// Страница, которая проходит все пункты каркаса. Тесты ломают её по одному пункту.
function goodPage({ quote = QUOTE, prompts = 5, cta = true, copy = true, logo = false, extra = '', wide = false, title = 'Сайт без кода' } = {}) {
  const items = Array.from({ length: prompts }, (_, index) => `
    <div data-lm-code data-lm-item="prompt"><pre>Промпт ${index + 1}</pre>${copy ? '<button data-lm-copy>Скопировать</button>' : ''}</div>`).join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{margin:0;font-family:sans-serif} pre{white-space:pre-wrap}</style></head><body>
<header data-lm-block="hero">${logo ? '<span data-lm="logo"><svg width="10" height="10"></svg></span>' : ''}<h1>${title}</h1><p>«${quote}»</p></header>
<section data-lm-block="steps"><h2>Шаги</h2><p data-lm-item="step">Шаг 1</p>${items}</section>
${wide ? '<div style="width:900px">широко</div>' : ''}${extra}
${cta ? '<section data-lm-block="cta" data-lm="cta"><h2>Понравилось?</h2></section>' : ''}
</body></html>`;
}

function makeLeadMagnet(t) {
  const context = makeVideoProject(t);
  const passport = library.createLeadMagnet(context.projectsDir, {
    codeWord: 'ГАЙД', title: 'Сайт без кода',
    promise: { quote: QUOTE, startSec: 60, endSec: 63.9, sourceFolder: context.folder },
    units: UNITS, params: PARAMS, videoFolder: context.folder,
  });
  return { ...context, id: passport.id };
}

function writeRevision(dir, { page = goodPage(), texts = { dm: 'Привет', telegram: 'Пост', instagram: 'Подпись' }, facts = [] } = {}) {
  fs.writeFileSync(path.join(dir, 'page.html'), page);
  fs.writeFileSync(path.join(dir, 'page.pdf'), '%PDF-1.7');
  fs.writeFileSync(path.join(dir, 'content.md'), '# Сайт без кода');
  for (const [kind, text] of Object.entries(texts)) fs.writeFileSync(path.join(dir, 'texts', `${kind}.txt`), text);
  fs.writeFileSync(path.join(dir, 'facts.json'), JSON.stringify({ version: 1, checkedAt: '2026-09-30T12:00:00.000Z', items: facts }));
}

// Настоящий PNG 1×1: снимкам правок нужна сигнатура PNG, а не текст.
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const CHECK_IDS = ['promise', 'cta', 'phone-width', 'copy-buttons', 'logo', 'header', 'self-contained', 'blocks', 'texts', 'facts'];

// Публикует ревизию с отчётом проверки, записанным вручную: тестам пульта и утверждения
// нужна логика, а не настоящий Chromium (его проверяет tests/lead-magnet-check.test.js).
function publishCheckedRevision(projectsDir, id, { ok = true, facts = [], page } = {}) {
  const { n, dir } = library.startRevision(projectsDir, id);
  writeRevision(dir, page === undefined ? { facts } : { facts, page });
  for (const shot of ['desktop.png', 'phone-390.png']) fs.writeFileSync(path.join(dir, 'qa', shot), PNG_BYTES);
  const pageSha256 = hashFile(path.join(dir, 'page.html'));
  const factsSha256 = hashFile(path.join(dir, 'facts.json'));
  fs.writeFileSync(path.join(dir, 'qa', 'check.json'), JSON.stringify({
    version: 1,
    checkedAt: '2026-10-01T12:00:00.000Z',
    pageSha256,
    factsSha256,
    inputSha256: inputFingerprint(projectsDir, dir, library.readLeadMagnet(projectsDir, id)),
    ok,
    items: CHECK_IDS.map((itemId) => ({ id: itemId, ok, message: 'проверено' })),
  }));
  library.publishRevision(projectsDir, id, n);
  return { n, dir, pageSha256 };
}

// Ролик пульта (настоящий project.json с preview) и обещание из сценария: расшифровка тестам
// пульта не нужна, поэтому источник обещания – script.txt внутри папки ролика.
function addVideoWithOffer(projectsDir, { folder, name = folder, approve = false, final = false, codeWord = 'ГАЙД' } = {}) {
  addDraftProject(projectsDir, { folder, name, approve, final });
  const projectDir = path.join(projectsDir, folder);
  fs.writeFileSync(path.join(projectDir, 'script.txt'), `Финал ролика. ${QUOTE}.`);
  addOffer(projectDir, {
    codeWord, kind: 'comment-keyword', quote: QUOTE, units: UNITS, sourceKind: 'script', scriptPath: 'script.txt', audience: 'новички',
  });
  return projectDir;
}

// Лид-магнит, привязанный к ролику пульта.
function addLeadMagnetFor(projectsDir, folder) {
  return library.createLeadMagnet(projectsDir, {
    codeWord: 'ГАЙД', title: 'Сайт без кода',
    promise: { quote: QUOTE, startSec: null, endSec: null, sourceFolder: folder },
    units: UNITS, params: PARAMS, videoFolder: folder,
  }).id;
}

module.exports = {
  PARAMS, PNG_BYTES, QUOTE, UNITS, WORDS,
  addLeadMagnetFor, addVideoWithOffer, goodPage, makeLeadMagnet, makeVideoProject, publishCheckedRevision, writeRevision,
};
