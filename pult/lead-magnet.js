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

// Плашка «Разработать лид-магнит?» над статусом видео. Раздел карточки она не меняет.
async function lmRenderBanner(slot, variant, getVideo) {
  if (!variant.leadMagnet || !variant.leadMagnet.ask) return;
  let leadState;
  try {
    leadState = await lmLoadState(variant);
  } catch (error) {
    notify(error.message, 'error');
    return;
  }
  for (const offer of leadState.offers.filter((item) => item.state === 'ask')) {
    slot.append(lmOfferBanner(variant, leadState, offer, getVideo));
  }
}

function lmOfferBanner(variant, leadState, offer, getVideo) {
  const box = el('div', 'lm-offer');
  box.dataset.lmOffer = offer.codeWord;
  box.append(el('h3', '', `🎁 В ролике есть обещание${offer.startSec === null ? '' : ` · ${lmClock(offer.startSec)}`}`));
  box.append(el('blockquote', 'lm-quote', `«${offer.quote}»`));
  const facts = el('div', 'lm-row');
  if (offer.startSec !== null) {
    facts.append(button('▶ послушать', async () => {
      const video = getVideo();
      if (!video) return;
      video.currentTime = offer.startSec;
      await video.play();
    }, 'link-button'));
  }
  facts.append(el('span', 'hint', `кодовое слово: ${offer.codeWord}`));
  box.append(facts);
  const matches = leadState.library.filter((item) => item.codeWords.includes(offer.codeWord));
  if (matches.length) {
    box.append(el('p', 'lm-hint', `Для слова ${offer.codeWord} уже есть готовый лид-магнит «${matches[0].title}» – можно не делать заново.`));
  }
  box.append(el('strong', '', 'Разработать лид-магнит для этого ролика?'));
  const picker = lmLibraryPicker(variant, leadState, offer);
  const choices = el('div', 'lm-row');
  choices.append(
    button('Разработать новый', async () => { lmOpenWizard(variant, leadState, offer); }, 'primary'),
    button('Уже есть готовый ▾', async () => { picker.hidden = !picker.hidden; }, 'secondary'),
    button('Нет', () => lmDecide(variant, { type: 'decline', offerId: offer.offerId, codeWord: offer.codeWord }), 'secondary'),
  );
  box.append(choices, picker, el('p', 'hint', `«Нет» больше не спрашивает про слово ${offer.codeWord}. Передумаете – кнопка «🎁 Лид-магнит» в действиях.`));
  return box;
}

// Утверждённые лид-магниты библиотеки; совпадения по кодовому слову – первыми.
function lmLibraryPicker(variant, leadState, offer) {
  const box = el('div', 'lm-picker');
  box.hidden = true;
  box.dataset.lmPicker = '';
  if (!leadState.library.length) {
    box.append(el('p', 'hint', 'Утверждённых лид-магнитов пока нет.'));
    return box;
  }
  const search = el('input');
  search.type = 'search';
  search.placeholder = 'Найти лид-магнит';
  search.setAttribute('aria-label', 'Найти лид-магнит');
  const list = el('ul', 'lm-picker__list');
  const isMatch = (item) => item.codeWords.includes(offer.codeWord);
  const ordered = [...leadState.library].sort((left, right) => Number(isMatch(right)) - Number(isMatch(left)));
  const draw = () => {
    const query = search.value.trim().toLowerCase();
    list.replaceChildren();
    for (const item of ordered.filter((entry) => !query || `${entry.title} ${entry.codeWords.join(' ')}`.toLowerCase().includes(query))) {
      const row = el('li');
      row.append(button(`${item.codeWords.join(', ')} · «${item.title}» · роликов: ${item.videos}`,
        () => lmDecide(variant, { type: 'link', offerId: offer.offerId, codeWord: offer.codeWord, leadMagnetId: item.id }),
        isMatch(item) ? 'lm-pick lm-pick--match' : 'lm-pick'));
      list.append(row);
    }
  };
  search.addEventListener('input', draw);
  draw();
  box.append(search, list, el('p', 'hint', 'Выбор сразу привязывает ролик к лид-магниту – агенту ничего делать не нужно.'));
  return box;
}

// Кнопка в «Действиях»: вернуть вопрос после «Нет» или заказать лид-магнит без обещания.
function lmActionButton(variant) {
  return button('🎁 Лид-магнит', async () => {
    const leadState = await lmLoadState(variant);
    const declined = leadState.offers.find((offer) => offer.state === 'declined');
    if (declined) {
      await lmDecide(variant, { type: 'reopen', offerId: declined.offerId, codeWord: declined.codeWord });
      notify('Вопрос про лид-магнит вернулся в карточку.');
      return;
    }
    lmOpenWizard(variant, leadState, null);
  });
}

// Окно параметров – задача 3. До неё кнопка честно говорит, что окна ещё нет.
function lmOpenWizard() {
  notify('Окно параметров появится в следующей задаче.', 'error');
}
