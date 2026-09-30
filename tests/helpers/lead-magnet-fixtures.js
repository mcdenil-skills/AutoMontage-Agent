// tests/helpers/lead-magnet-fixtures.js
const fs = require('node:fs');
const path = require('node:path');

const { makePultRoot } = require('./pult-projects');

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

module.exports = { PARAMS, QUOTE, UNITS, WORDS, goodPage, makeLeadMagnet, makeVideoProject, writeRevision };
