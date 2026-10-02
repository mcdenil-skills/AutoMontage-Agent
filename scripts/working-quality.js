// Один рабочий размер для master; остальные этапы наследуют его из активного исходника.
const QUALITIES = Object.freeze(['1080p', 'source']);
const ALIASES = { '1080p': '1080p', '1080': '1080p', source: 'source', '4k': 'source', native: 'source' };

function parseQuality(value) {
  const quality = Object.hasOwn(ALIASES, String(value).toLowerCase())
    ? ALIASES[String(value).toLowerCase()] : null;
  if (!quality) throw new Error(`неизвестное качество "${value}": используй 1080p или source`);
  return quality;
}

function dimensions({ width, height }) {
  for (const [label, value] of [['ширина', width], ['высота', height]]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`${label} должна быть положительным конечным числом`);
    }
  }
  return { width, height };
}

function workingSize(size, quality = '1080p') {
  const { width, height } = dimensions(size);
  const normalized = parseQuality(quality);
  if (Math.min(width, height) < 2) throw new Error('размер кадра должен быть минимум 2 пикселя');
  const k = normalized === '1080p' ? Math.min(1, 1080 / Math.min(width, height)) : 1;
  // На неизменяемом размере нечётные стороны уменьшаем на пиксель: никогда не увеличиваем.
  const even = (side) => k < 1 ? Math.round(side * k / 2) * 2 : Math.floor(side / 2) * 2;
  const target = { width: even(width), height: even(height) };
  return { ...target, scaled: target.width !== width || target.height !== height };
}

function previewScale(size) {
  const { width, height } = dimensions(size);
  return Math.min(1, 1920 / Math.max(width, height));
}

module.exports = { QUALITIES, parseQuality, workingSize, previewScale };
