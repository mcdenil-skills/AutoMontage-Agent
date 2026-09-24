const fs = require('node:fs');
const Ajv = require('ajv');

const schema = require('../../schema/pult-card.schema.json');
const { resolveProjectPath } = require('../project/workspace');

const CARD_FILE = 'pult-card.json';
const validateCard = new Ajv({ allErrors: true }).compile(schema);

// Карточка необязательна. Любая ошибка возвращается как ok:false, чтобы каталог
// показал папку в разделе «Не читается», а не упал целиком.
function readPultCard(projectDir) {
  let cardPath;
  try {
    cardPath = resolveProjectPath(projectDir, CARD_FILE, {
      label: CARD_FILE,
      mustExist: false,
      type: 'file',
    });
  } catch (_) {
    return { ok: false, error: 'pult-card.json недоступен' };
  }
  let text;
  try {
    text = fs.readFileSync(cardPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, card: null };
    return { ok: false, error: 'pult-card.json не читается' };
  }
  let card;
  try {
    card = JSON.parse(text);
  } catch (_) {
    return { ok: false, error: 'pult-card.json: неверный JSON' };
  }
  if (!validateCard(card)) return { ok: false, error: 'pult-card.json не соответствует схеме' };
  for (const variant of card.legacy ? card.legacy.variants : []) {
    try {
      resolveProjectPath(projectDir, variant.video, {
        label: 'pult-card video',
        mustExist: false,
        type: 'file',
      });
    } catch (_) {
      return { ok: false, error: 'pult-card.json: путь видео выходит за папку ролика' };
    }
  }
  return { ok: true, card };
}

module.exports = { CARD_FILE, readPultCard };
