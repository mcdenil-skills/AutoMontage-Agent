const FORMATS = ['guide', 'prompts', 'checklist', 'cheatsheet'];
const TEXT_KINDS = ['dm', 'telegram', 'instagram'];
// Лимиты площадок: личка, подпись к видео в Telegram, подпись Instagram.
const TEXT_LIMITS = { dm: 1000, telegram: 1024, instagram: 2200 };
const TEXT_FILES = { dm: 'texts/dm.txt', telegram: 'texts/telegram.txt', instagram: 'texts/instagram.txt' };
const LIBRARY_DIR = '.lead-magnets';
const LEAD_MAGNET_ID = /^\d{4}\.\d{2}\.\d{2}_[a-z0-9-]{1,80}$/;
const DECISION_ID = /^r-[a-f0-9]{8}$/;
const LM_COMMENT_ID = /^c-[a-f0-9]{8}$/;
const CODE_WORD = /^[A-ZА-ЯЁ0-9][A-ZА-ЯЁ0-9 -]{0,39}$/u;

// Кодовое слово печатается агенту в терминал и попадает в имя папки библиотеки:
// только буквы, цифры, пробел и дефис.
function normalizeCodeWord(value) {
  if (typeof value !== 'string') throw new Error('кодовое слово: нужен текст');
  const word = value.normalize('NFC').trim().replace(/\s+/g, ' ').toUpperCase();
  if (!CODE_WORD.test(word)) {
    throw new Error('кодовое слово: только буквы, цифры, пробел и дефис, до 40 символов');
  }
  return word;
}

function formatAjvErrors(errors) {
  return (errors || []).map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ');
}

module.exports = {
  CODE_WORD,
  DECISION_ID,
  FORMATS,
  LEAD_MAGNET_ID,
  LIBRARY_DIR,
  LM_COMMENT_ID,
  TEXT_FILES,
  TEXT_KINDS,
  TEXT_LIMITS,
  formatAjvErrors,
  normalizeCodeWord,
};
