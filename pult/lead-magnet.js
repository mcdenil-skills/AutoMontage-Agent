'use strict';

// Экраны лид-магнита в пульте (план 1B-2). Файл подключается ДО app.js и пользуется его
// помощниками только во время работы: el, button, api, notify, mediaUrl, refresh, token и
// state. Все свои имена – с приставкой lm, чтобы не столкнуться с app.js. Сервер – маршруты
// scripts/pult/lead-magnet-routes.js; браузер не получает ни путей, ни хешей.

const LM_STATUS_LABELS = { waiting: 'Ждёт меня', working: 'В работе', ready: 'Готов' };
const LM_FORMAT_LABELS = {
  guide: 'Гайд по шагам', prompts: 'Набор промптов', checklist: 'Чек-лист', cheatsheet: 'Шпаргалка на один экран',
};
const LM_DESIGN_LABELS = {
  brand: 'Мой стиль', reference: 'По референсу', new: 'Новый дизайн под тему', like: 'Как прошлый лид-магнит',
};
const LM_TEXT_LABELS = { dm: 'Сообщение в личку', telegram: 'Пост в Telegram', instagram: 'Подпись Instagram' };

function lmClock(seconds) {
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function lmRevisionLabel(n) {
  return `v${String(n).padStart(2, '0')}`;
}

function lmUnitsText(units) {
  return units.map((unit) => (unit.count ? `${unit.count} ${unit.label}` : unit.label)).join(' + ');
}

function lmLoadState(variant) {
  return api(`/api/lead-magnet?key=${encodeURIComponent(variant.key)}`);
}

// Решение человека: сервер записывает его (и сразу исполняет «Нет», «Уже есть готовый»,
// «Оставить как есть»), а пульт перерисовывает карточку по свежим данным.
async function lmDecide(variant, body) {
  await api('/api/lead-magnet/decision', { method: 'POST', body: { key: variant.key, ...body } });
  await refresh();
}

function lmCardTag(card) {
  if (!card.leadMagnetAsk) return null;
  const tag = el('span', 'lm-tag', '🎁 Лид-магнит?');
  tag.dataset.lmTag = '';
  return tag;
}
