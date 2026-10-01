// scripts/lead-magnet/brand.js
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');

const schema = require('../../schema/lead-magnet-brand.schema.json');
const { resolveProjectPath } = require('../project/workspace');
const { readJsonIfExists } = require('../pult/files');
const { formatAjvErrors } = require('./constants');

const NEUTRAL_DIR = path.resolve(__dirname, '..', '..', 'templates', 'lead-magnet', 'neutral');
const validateBrand = new Ajv({ allErrors: true }).compile(schema);

function loadPack(dir) {
  const brand = readJsonIfExists(path.join(dir, 'brand.json'), 'brand.json бренд-пака');
  if (brand === undefined) throw new Error(`бренд-пак лид-магнитов не найден: ${dir}`);
  if (!validateBrand(brand)) throw new Error(`бренд-пак лид-магнитов: ${formatAjvErrors(validateBrand.errors)}`);
  for (const social of brand.socials) {
    let url;
    try { url = new URL(social.url); } catch (_) { url = null; }
    if (!url || url.protocol !== 'https:' || url.username || url.password) {
      throw new Error('бренд-пак лид-магнитов: соцсети требуют адрес https:// без пароля');
    }
  }
  const inside = (stored, label) => {
    try {
      return resolveProjectPath(dir, stored, { label, mustExist: true, type: 'file' });
    } catch (_) {
      throw new Error(`бренд-пак лид-магнитов: ${label} не найден внутри пакета`);
    }
  };
  if (brand.logoRequired && !brand.logo) throw new Error('бренд-пак лид-магнитов: логотип обязателен, но не указан');
  return {
    brand,
    logoPath: brand.logo ? inside(brand.logo, 'логотип') : null,
    fontPaths: brand.fontFiles.map((file) => inside(file, 'шрифт')),
    rulesPath: brand.voice.rulesFile ? inside(brand.voice.rulesFile, 'файл голоса') : null,
  };
}

// Приватный пакет пользователя никогда не копируется в репозиторий: движок только читает его.
function resolveBrand({ env = process.env } = {}) {
  if (env.LEAD_MAGNET_BRAND) {
    const dir = path.resolve(env.LEAD_MAGNET_BRAND);
    return { source: 'pack', dir, ...loadPack(dir) };
  }
  if (env.THEMES_EXT) {
    const dir = path.join(path.dirname(path.resolve(env.THEMES_EXT)), 'lead-magnet');
    if (fs.existsSync(path.join(dir, 'brand.json'))) return { source: 'pack', dir, ...loadPack(dir) };
  }
  return { source: 'neutral', dir: NEUTRAL_DIR, ...loadPack(NEUTRAL_DIR) };
}

// Решение интервью: есть свой стиль – из референса по умолчанию берём только композицию;
// своего стиля нет – берём всё. Пользователь может переключить галочки в окне.
function defaultTake(resolved) {
  const own = resolved.source === 'pack';
  return { composition: true, colors: !own, fonts: !own };
}

module.exports = { NEUTRAL_DIR, defaultTake, resolveBrand };
