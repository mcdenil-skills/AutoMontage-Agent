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

function sampleAspectRatio(size) {
  const raw = size.sampleAspectRatio || '1:1';
  if (!/^\d+:\d+$/.test(raw)) throw new Error('неверное соотношение пикселей');
  const [num, den] = raw.split(':').map(Number);
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0) throw new Error('неверное соотношение пикселей');
  return num / den;
}

function orientedSampleAspectRatio(media) {
  const raw = media.sampleAspectRatio || '1:1';
  sampleAspectRatio({sampleAspectRatio: raw});
  return [90,270].includes(media.rotation) ? raw.split(':').reverse().join(':') : raw;
}

function workingSize(size, quality = '1080p') {
  const original = dimensions(size);
  let { width, height } = original;
  const normalized = parseQuality(quality);
  if (normalized === '1080p') {
    const sar = sampleAspectRatio(size);
    // Квадратные пиксели без увеличения осей: сжимаем противоположную сторону.
    if (sar > 1) height /= sar;
    else width *= sar;
  }
  if (Math.min(width, height) < 2) throw new Error('размер кадра должен быть минимум 2 пикселя');
  const k = normalized === '1080p' ? Math.min(1, 1080 / Math.min(width, height)) : 1;
  // На неизменяемом размере нечётные стороны уменьшаем на пиксель: никогда не увеличиваем.
  const even = (side) => k < 1 ? Math.round(side * k / 2) * 2 : Math.floor(side / 2) * 2;
  const target = { width: even(width), height: even(height) };
  return { ...target, scaled: target.width !== original.width || target.height !== original.height || (normalized === '1080p' && sampleAspectRatio(size) !== 1) };
}

function previewScale(size) {
  const { width, height } = dimensions(size);
  return Math.min(1, 1920 / Math.max(width, height));
}

function previewSize(size) {
  const scale = previewScale(size);
  const even = (side) => {
    // Remotion уменьшает сторону композиции до чётного округлённого H264-размера.
    while (Math.round(side * scale) % 2 !== 0) side -= 1;
    return Math.round(side * scale);
  };
  return {width:even(size.width),height:even(size.height)};
}

module.exports = { QUALITIES, parseQuality, workingSize, previewScale, previewSize, orientedSampleAspectRatio };
