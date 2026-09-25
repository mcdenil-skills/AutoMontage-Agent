// Имя папки ролика: всё, кроме того, что опасно в пути. Список разрешённых символов
// ломался на реальных именах (й/ё в NFD macOS, скобки, плюс).
const SAFE_NAME = '(?!\\.)[^/\\\\\\u0000-\\u001F\\u007F]{1,255}';
const SAFE_NAME_PATTERN = new RegExp(`^${SAFE_NAME}$`, 'u');

function isSafeName(value) {
  return typeof value === 'string' && SAFE_NAME_PATTERN.test(value);
}

module.exports = { SAFE_NAME, isSafeName };
