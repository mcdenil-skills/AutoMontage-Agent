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

module.exports = { QUOTE, UNITS, WORDS, makeVideoProject };
