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
    button('Разработать новый', async () => { lmOpenWizard(variant, leadState, offer, getVideo); }, 'primary'),
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

const LM_REFERENCE_LIMITS_MB = { 'image/png': 15, 'image/jpeg': 15, 'image/webp': 15, 'application/pdf': 30, 'text/html': 5 };
const LM_MAX_REFERENCES = 5;

function lmChoice(type, name, value, label, checked) {
  const wrap = el('label', 'lm-choice');
  const input = el('input');
  input.type = type;
  input.name = name;
  input.value = value;
  input.checked = checked;
  wrap.append(input, el('span', '', label));
  return { wrap, input };
}

function lmChoices(items) {
  const row = el('div', 'lm-choices');
  row.append(...items.map((item) => item.wrap));
  return row;
}

function lmFieldset(number, legend, children) {
  const box = el('fieldset', 'lm-field');
  box.append(el('legend', '', number ? `${number}. ${legend}` : legend), ...children);
  return box;
}

function lmTextInput(value, label, { multiline = false, maxLength = 0 } = {}) {
  const input = el(multiline ? 'textarea' : 'input');
  if (multiline) input.rows = 2;
  else input.type = 'text';
  input.value = value || '';
  if (maxLength) input.maxLength = maxLength;
  input.setAttribute('aria-label', label);
  return input;
}

// Референс уходит сырыми байтами: сервер сам определяет тип по сигнатуре и хранит файл по SHA-256.
async function lmUploadReference(variant, file) {
  const limit = LM_REFERENCE_LIMITS_MB[file.type];
  if (limit && file.size > limit * 1024 * 1024) throw new Error(`файл больше ${limit} МБ`);
  let response;
  try {
    response = await fetch(`/api/lead-magnet/reference?key=${encodeURIComponent(variant.key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: file,
    });
  } catch (_) {
    throw new Error('пульт не отвечает – откройте его снова значком «Пульт роликов»');
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error((payload && payload.message) || 'файл не загрузился');
  return payload.reference;
}

function lmOpenWizard(variant, leadState, offer, getVideo) {
  const dialog = el('dialog', 'lm-dialog');
  dialog.dataset.lmWizard = '';
  const references = [];
  let activeUploads = 0;
  let pendingSlots = 0;
  let submitting = false;
  const errorLine = el('p', 'lm-error');
  errorLine.dataset.lmWizardError = '';
  const say = (message) => {
    if (message) errorLine.textContent = [errorLine.textContent, message].filter(Boolean).join(' ');
  };
  const body = el('div', 'lm-dialog__body');

  let promise = null;
  if (offer) {
    promise = lmChoice('checkbox', 'lm-promise', 'yes', `Делаем ровно под это обещание: ${lmUnitsText(offer.units)}`, false);
    promise.input.dataset.lmPromise = '';
    const promiseParts = [el('blockquote', 'lm-quote', `«${offer.quote}»`)];
    if (offer.startSec !== null) {
      promiseParts.push(button('▶ послушать', async () => {
        const video = getVideo && getVideo();
        if (!video) return;
        video.currentTime = offer.startSec;
        await video.play();
      }, 'link-button'));
    }
    promiseParts.push(promise.wrap);
    body.append(lmFieldset(1, `Обещание из ролика${offer.startSec === null ? '' : ` · ${lmClock(offer.startSec)}`}`,
      promiseParts));
  }
  const codeWord = lmTextInput(offer ? offer.codeWord : '', 'Кодовое слово', { maxLength: 40 });
  codeWord.readOnly = Boolean(offer);
  codeWord.dataset.lmCodeWord = '';
  body.append(lmFieldset(2, 'Кодовое слово', [codeWord]));

  const suggested = offer ? offer.suggest.format : 'guide';
  const formats = Object.entries(LM_FORMAT_LABELS).map(([value, label]) => lmChoice('radio', 'lm-format', value, label, value === suggested));
  const formatParts = [lmChoices(formats)];
  if (offer) formatParts.push(el('p', 'lm-hint', `Агент советует «${LM_FORMAT_LABELS[suggested]}».`));
  body.append(lmFieldset(3, 'Формат', formatParts));

  const audience = lmTextInput(offer ? offer.suggest.audience : '', 'Для кого', { maxLength: 200 });
  body.append(lmFieldset(4, 'Для кого', [audience]));

  const designs = Object.entries(LM_DESIGN_LABELS).map(([value, label]) => lmChoice('radio', 'lm-design', value, label, value === 'brand'));
  const designMode = () => designs.find((item) => item.input.checked).input.value;

  const referencePanel = el('div', 'lm-reference');
  referencePanel.hidden = true;
  referencePanel.dataset.lmReference = '';
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.accept = '.png,.jpg,.jpeg,.webp,.pdf,.html,.htm';
  fileInput.dataset.lmFile = '';
  fileInput.setAttribute('aria-label', 'Файл референса');
  const drop = el('div', 'lm-drop');
  drop.append(el('span', '', 'Перетащите картинку, PDF или HTML-файл'), el('span', 'hint', 'PNG, JPG, WebP до 15 МБ · PDF до 30 МБ · HTML до 5 МБ'), fileInput);
  const urlInput = lmTextInput('', 'Ссылка на референс', { maxLength: 2048 });
  urlInput.placeholder = 'https://…';
  const chips = el('ul', 'lm-chips');
  chips.dataset.lmChips = '';
  const take = {
    composition: lmChoice('checkbox', 'lm-take', 'composition', 'Композицию и подачу', leadState.brand.defaultTake.composition),
    colors: lmChoice('checkbox', 'lm-take', 'colors', 'Цвета', leadState.brand.defaultTake.colors),
    fonts: lmChoice('checkbox', 'lm-take', 'fonts', 'Шрифты', leadState.brand.defaultTake.fonts),
  };
  const takeHint = el('p', 'hint', leadState.brand.source === 'pack'
    ? 'У вас свой стиль, поэтому по умолчанию берём только композицию. Логотип, блок призыва, кнопки «Скопировать» и мобильная вёрстка останутся в любом случае.'
    : 'Своего стиля нет – берём из референса всё. Блок призыва, кнопки «Скопировать» и мобильная вёрстка останутся в любом случае.');
  const note = lmTextInput('', 'Что нравится в референсе', { multiline: true, maxLength: 500 });

  const likePanel = el('div', 'lm-like');
  likePanel.hidden = true;
  const likeSelect = el('select');
  likeSelect.setAttribute('aria-label', 'Образец');
  likeSelect.append(new Option('Выберите утверждённый лид-магнит', ''), ...leadState.library.map((item) => new Option(`${item.codeWords.join(', ')} · ${item.title}`, item.id)));
  likePanel.append(leadState.library.length ? likeSelect : el('p', 'hint', 'Утверждённых лид-магнитов пока нет.'));

  const texts = Object.entries(LM_TEXT_LABELS).map(([value, label]) => lmChoice('checkbox', 'lm-texts', value, label, true));
  const wishes = lmTextInput('', 'Пожелания', { multiline: true, maxLength: 1000 });
  wishes.placeholder = 'Например: добавить блок «частые ошибки»';
  wishes.dataset.lmWishes = '';

  const send = el('button', 'primary', 'Отправить агенту');
  send.type = 'button';
  send.dataset.lmSend = '';
  const validate = () => {
    const mode = designMode();
    send.disabled = submitting || activeUploads > 0 || Boolean(offer && !promise.input.checked) || !codeWord.value.trim()
      || (mode === 'reference' && !references.length) || (mode === 'like' && !likeSelect.value);
  };
  const drawChips = () => {
    chips.replaceChildren(...references.map((item, index) => {
      const chip = el('li', 'lm-chip');
      chip.append(el('span', '', item.label), button('✕', async () => { references.splice(index, 1); drawChips(); validate(); }, 'link-button'));
      return chip;
    }));
  };
  const addFiles = async (files) => {
    activeUploads += 1;
    validate();
    try {
      for (const file of files) {
        if (references.length + pendingSlots >= LM_MAX_REFERENCES) {
          say(`Можно приложить до ${LM_MAX_REFERENCES} референсов.`);
          break;
        }
        pendingSlots += 1;
        try {
          references.push({ reference: await lmUploadReference(variant, file), label: `📎 ${file.name}` });
        } catch (error) {
          say(`${file.name}: ${error.message}`);
        } finally {
          pendingSlots -= 1;
        }
      }
    } finally {
      activeUploads -= 1;
      drawChips();
      validate();
    }
  };
  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    addFiles(files);
  });
  drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.dataset.over = ''; });
  drop.addEventListener('dragleave', () => { delete drop.dataset.over; });
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    delete drop.dataset.over;
    addFiles([...event.dataTransfer.files]);
  });
  const addUrl = button('Добавить ссылку', async () => {
    const value = urlInput.value.trim();
    if (!/^https?:\/\/\S+$/i.test(value)) { say('Нужна ссылка вида https://…'); return; }
    if (references.length + pendingSlots >= LM_MAX_REFERENCES) { say(`Можно приложить до ${LM_MAX_REFERENCES} референсов.`); return; }
    references.push({ reference: { kind: 'url', url: value }, label: `🔗 ${value}` });
    urlInput.value = '';
    drawChips();
    validate();
  }, 'secondary');
  const urlRow = el('div', 'lm-row');
  urlRow.append(urlInput, addUrl);
  referencePanel.append(drop, urlRow, chips,
    lmFieldset(null, 'Что взять из референса', [lmChoices(Object.values(take)), takeHint]),
    lmFieldset(null, 'Что нравится', [note]));
  designs.forEach((item) => item.input.addEventListener('change', () => {
    referencePanel.hidden = designMode() !== 'reference';
    likePanel.hidden = designMode() !== 'like';
  }));
  body.append(lmFieldset(5, 'Дизайн', [lmChoices(designs), referencePanel, likePanel]));
  body.append(lmFieldset(6, 'Тексты для раздачи', [lmChoices(texts)]));
  body.append(lmFieldset(7, 'Пожелания (необязательно)', [wishes]));

  const close = () => { if (dialog.open) dialog.close(); dialog.remove(); };
  send.addEventListener('click', async () => {
    if (submitting || send.disabled) return;
    submitting = true;
    validate();
    const mode = designMode();
    const params = {
      format: formats.find((item) => item.input.checked).input.value,
      audience: audience.value.trim(),
      design: {
        mode,
        take: { composition: take.composition.input.checked, colors: take.colors.input.checked, fonts: take.fonts.input.checked },
        likeId: mode === 'like' ? likeSelect.value : null,
        note: mode === 'reference' ? note.value.trim() : '',
        references: mode === 'reference' ? references.map((item) => item.reference) : [],
      },
      texts: texts.filter((item) => item.input.checked).map((item) => item.input.value),
      wishes: wishes.value.trim(),
      promiseConfirmed: Boolean(promise && promise.input.checked),
    };
    try {
      await api('/api/lead-magnet/decision', {
        method: 'POST',
        body: {
          key: variant.key, type: 'create', offerId: offer ? offer.offerId : null, codeWord: offer ? offer.codeWord : codeWord.value.trim(), params,
        },
      });
      close();
      notify('Запрос отправлен агенту. Скопируйте фразу для агента – он соберёт черновик.');
      await refresh();
    } catch (error) {
      say(error.message);
      submitting = false;
      validate();
    }
  });

  const head = el('div', 'lm-dialog__head');
  head.append(el('h3', '', offer ? `Лид-магнит «${offer.codeWord}»` : 'Новый лид-магнит'), button('✕', async () => close(), 'link-button'));
  const foot = el('div', 'lm-dialog__foot');
  foot.append(errorLine, button('Отмена', async () => close(), 'secondary'), send);
  dialog.append(head, body, foot);
  dialog.addEventListener('input', validate);
  dialog.addEventListener('change', validate);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  validate();
  dialog.showModal();
  return dialog;
}
