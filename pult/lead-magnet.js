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
        try {
          await video.play();
        } catch (_) {
          say('Не удалось воспроизвести видео. Попробуйте запустить его в плеере.');
        }
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
      || (mode === 'reference' && !references.length) || (mode === 'like' && !likeSelect.value) || !validCall();
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

  const brandCall = leadState.brand.call.buttons.length
    ? `Призыв бренд-пака: ${leadState.brand.call.buttons.join(', ')}`
    : 'Призыв бренд-пака';
  const calls = [
    lmChoice('radio', 'lm-cta', 'brand', brandCall, true),
    lmChoice('radio', 'lm-cta', 'link', 'Своя ссылка (практикум, вебинар)', false),
    lmChoice('radio', 'lm-cta', 'none', 'Без призыва – только соцсети', false),
  ];
  const last = leadState.lastLink || { title: 'Хочешь разобраться глубже?', label: 'Бесплатный практикум', url: '' };
  const ctaTitle = lmTextInput(last.title, 'Заголовок над кнопкой', { maxLength: 120 });
  const ctaLabel = lmTextInput(last.label, 'Надпись на кнопке', { maxLength: 60 });
  const ctaUrl = lmTextInput(last.url, 'Ссылка', { maxLength: 500 });
  ctaUrl.placeholder = 'https://…';
  ctaUrl.dataset.lmCtaUrl = '';
  const linkPanel = el('div', 'lm-reference');
  linkPanel.hidden = true;
  linkPanel.append(ctaTitle, ctaLabel, ctaUrl, el('p', 'hint', 'К ссылке добавятся UTM-метки бренд-пака.'));
  const callMode = () => calls.find((item) => item.input.checked).input.value;
  calls.forEach((item) => item.input.addEventListener('change', () => { linkPanel.hidden = callMode() !== 'link'; }));
  const socialsHint = leadState.brand.socials.length
    ? `Внизу всегда: ${leadState.brand.socials.join(' · ')}`
    : 'Соцсети внизу страницы задаются в бренд-паке.';
  body.append(lmFieldset(8, 'Куда ведём в конце', [lmChoices(calls), linkPanel, el('p', 'hint', socialsHint)]));
  const validCall = () => {
    if (callMode() !== 'link') return true;
    let url;
    try { url = new URL(ctaUrl.value.trim()); } catch (_) { return false; }
    return Boolean(ctaTitle.value.trim() && ctaLabel.value.trim() && url.protocol === 'https:' && !url.username && !url.password);
  };

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
      cta: { mode: callMode(), title: ctaTitle.value.trim(), label: ctaLabel.value.trim(), url: ctaUrl.value.trim() },
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


const LM_CHECK_LABELS = {
  promise: 'Обещание выполнено',
  cta: 'Блок призыва в конце',
  'phone-width': 'Телефон 390 px',
  'copy-buttons': 'Кнопки «Скопировать»',
  logo: 'Логотип',
  header: 'Шапка без слова «лид-магнит»',
  'self-contained': 'Страница без интернета',
  blocks: 'Разметка блоков',
  texts: 'Тексты в лимитах',
  facts: 'Факты проверены',
};
const LM_FILE_LABELS = {
  'page.html': 'Страница (HTML)',
  'page.pdf': 'PDF',
  'texts/dm.txt': 'Текст в личку',
  'texts/telegram.txt': 'Пост в Telegram',
  'texts/instagram.txt': 'Подпись Instagram',
};
// Какой лид-магнит открыт во вкладке, если у ролика их несколько (разные кодовые слова).
const lmChosen = new Map();
// Активная страница за стеклом: только её сообщения принимаются (задача 5).
let lmActive = null;

async function lmCopyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    notify('Скопировано.');
  } catch (_) {
    notify('Не удалось скопировать – выделите текст и нажмите ⌘C / Ctrl+C', 'error');
  }
}

function lmTabFingerprint(leadState) {
  return JSON.stringify({ error: leadState.error, pending: leadState.pending, magnets: leadState.magnets });
}

function lmNextLoad(container) {
  container.lmPollRequest = (container.lmPollRequest || 0) + 1;
  return container.lmPollRequest;
}

function lmIsCurrentLoad(container, variant, cardId, request) {
  return container.isConnected && document.querySelector('.lm-tab') === container
    && state.openCardId === cardId && state.detailTab === 'lead'
    && shownDetail.key === variant.key && container.lmPollRequest === request;
}

async function lmPollTab(container, variant) {
  if (!container || !container.isConnected) return;
  const cardId = state.openCardId;
  const request = lmNextLoad(container);
  let leadState;
  try {
    leadState = await lmLoadState(variant);
  } catch (error) {
    if (lmIsCurrentLoad(container, variant, cardId, request)) throw error;
    return;
  }
  if (!lmIsCurrentLoad(container, variant, cardId, request)) return;
  const fingerprint = lmTabFingerprint(leadState);
  if (fingerprint !== container.lmFingerprint) {
    lmRenderTab(container, variant, leadState);
    notify('Лид-магнит обновился.');
  }
}

async function lmRenderTab(container, variant, loadedState = null) {
  const cardId = state.openCardId;
  const request = lmNextLoad(container);
  // Пока виден индикатор загрузки, прежний state уже не представлен в DOM.
  // Опрос с теми же данными должен вернуть экран, если он опередил этот запрос.
  container.lmFingerprint = null;
  container.replaceChildren(el('p', 'hint', 'Загружаю лид-магнит…'));
  let leadState;
  try {
    leadState = loadedState || await lmLoadState(variant);
  } catch (error) {
    if (!lmIsCurrentLoad(container, variant, cardId, request)) return;
    container.replaceChildren(el('p', 'lm-error', error.message));
    return;
  }
  if (!lmIsCurrentLoad(container, variant, cardId, request)) return;
  container.lmFingerprint = lmTabFingerprint(leadState);
  lmActive = null;
  container.replaceChildren();
  if (leadState.error) container.append(el('p', 'lm-error', leadState.error));
  for (const broken of leadState.magnets.filter((magnet) => magnet.error)) {
    container.append(el('p', 'lm-error', `«${broken.title}»: ${broken.nextStep}`));
  }
  const magnets = leadState.magnets.filter((magnet) => !magnet.error);
  if (!magnets.length) {
    const word = leadState.pending.find(Boolean);
    const text = leadState.pending.length ? `Агент готовит лид-магнит${word ? ` «${word}»` : ''}.` : 'Лид-магнита у этого ролика пока нет.';
    const next = el('p', 'detail__next', text);
    next.dataset.lmStatus = '';
    container.append(next, lmHandoff(variant, null));
    return;
  }
  const magnet = magnets.find((item) => item.id === lmChosen.get(variant.key)) || magnets[0];
  if (magnets.length > 1) {
    const pills = el('div', 'variant-tabs');
    for (const option of magnets) {
      const pill = el('button', 'variant-tab', option.codeWords.join(', '));
      pill.type = 'button';
      pill.setAttribute('aria-pressed', String(option.id === magnet.id));
      pill.addEventListener('click', () => { lmChosen.set(variant.key, option.id); lmRenderTab(container, variant); });
      pills.append(pill);
    }
    container.append(pills);
  }
  const layout = el('div', 'detail');
  const main = el('div', 'lm-main');
  const side = el('div', 'detail__side');
  const comments = lmCommentsPanel(magnet);
  main.append(lmViewer(magnet, (target) => comments.setTarget(target)), lmTextsPanel(magnet, comments));
  const badge = el('p', `badge badge--${magnet.status}`, LM_STATUS_LABELS[magnet.status]);
  const next = el('p', 'detail__next', magnet.nextStep);
  next.dataset.lmStatus = '';
  side.append(badge, next);
  if (magnet.promiseChanged) side.append(lmPromisePanel(variant, magnet));
  side.append(lmChecksPanel(magnet), comments.box, lmApprovePanel(magnet), lmFilesPanel(magnet));
  if (magnet.funnel) side.append(lmFunnelPanel(variant, magnet));
  side.append(lmHandoff(variant, magnet));
  layout.append(main, side);
  container.append(layout);
}

function lmViewer(magnet, onBlock) {
  const box = el('div', 'lm-viewer');
  const { revision } = magnet;
  if (!revision || !revision.pageUrl) {
    const empty = el('div', 'player player--empty');
    empty.append(el('p', 'player__label', 'Страница появится, когда агент покажет первую версию.'));
    box.append(empty);
    return box;
  }
  let view = 'desktop';
  let reviewing = false;
  const wrap = el('div', 'lm-frame-wrap');
  const frame = el('iframe', 'lm-frame');
  frame.title = 'Страница лид-магнита';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('allow', 'clipboard-write');
  frame.referrerPolicy = 'no-referrer';
  frame.dataset.lmFrame = '';
  frame.dataset.view = view;
  frame.src = revision.pageUrl;
  wrap.append(frame);
  const layoutFrame = () => {
    const width = view === 'phone' ? 390 : 1280;
    const available = wrap.clientWidth || width;
    const scale = Math.min(1, available / width);
    frame.style.width = `${width}px`;
    frame.style.height = `${Math.round((wrap.clientHeight || 600) / scale)}px`;
    frame.style.transform = `scale(${scale})`;
    frame.style.left = `${Math.max(0, (available - width * scale) / 2)}px`;
    frame.dataset.view = view;
  };
  const sendReview = () => {
    // Страница в песочнице без своего origin: адресовать сообщение можно только '*'.
    if (frame.contentWindow) frame.contentWindow.postMessage({ type: 'lm-review', on: reviewing }, '*');
  };
  const bar = el('div', 'lm-row');
  const views = el('div', 'detail-tabs');
  const viewButtons = [['desktop', '🖥 Компьютер'], ['phone', '📱 Телефон 390']].map(([key, label]) => {
    const tab = el('button', 'detail-tab', label);
    tab.type = 'button';
    tab.dataset.lmView = key;
    tab.setAttribute('aria-pressed', String(key === view));
    tab.addEventListener('click', () => {
      view = key;
      viewButtons.forEach((other) => other.setAttribute('aria-pressed', String(other === tab)));
      layoutFrame();
    });
    return tab;
  });
  views.append(...viewButtons);
  const reviewToggle = lmChoice('checkbox', 'lm-review', 'on', 'Режим правок – кликните по блоку', false);
  reviewToggle.input.dataset.lmReviewMode = '';
  reviewToggle.input.addEventListener('change', () => { reviewing = reviewToggle.input.checked; sendReview(); });
  frame.addEventListener('load', sendReview);
  bar.append(views, reviewToggle.wrap, el('span', 'hint', `Версия ${lmRevisionLabel(revision.n)}`));
  box.append(bar, wrap);
  new ResizeObserver(layoutFrame).observe(wrap);
  layoutFrame();
  lmActive = { frame, view: () => view, onBlock };
  return box;
}

function lmTextsPanel(magnet, comments) {
  const box = el('div', 'lm-texts');
  if (!magnet.revision) return box;
  for (const item of magnet.revision.texts) {
    const card = el('div', 'lm-text');
    card.dataset.lmText = item.kind;
    const meter = el('div', 'lm-meter');
    const fill = el('i');
    fill.style.width = `${Math.min(100, Math.round((item.length / item.limit) * 100))}%`;
    meter.append(fill);
    if (item.length > item.limit) meter.dataset.over = '';
    const row = el('div', 'lm-row');
    row.append(
      button('Скопировать', () => lmCopyText(item.text), 'secondary'),
      button('Правка к тексту', async () => comments.setTarget({ kind: 'text', text: item.kind }), 'link-button'),
    );
    card.append(el('strong', '', LM_TEXT_LABELS[item.kind]), meter, el('span', 'hint', `${item.length} / ${item.limit}`),
      el('p', 'lm-text__body', item.text || '—'), row);
    box.append(card);
  }
  return box;
}

function lmChecksPanel(magnet) {
  const box = el('div', 'lm-panel');
  box.append(el('h3', '', 'Проверка'));
  const { revision } = magnet;
  if (!revision) {
    box.append(el('p', 'hint', 'Агент ещё не показал первую версию.'));
    return box;
  }
  const list = el('ul', 'lm-checks');
  list.dataset.lmChecks = '';
  for (const item of revision.items) {
    const row = el('li', '', `${item.ok ? '✓' : '✕'} ${LM_CHECK_LABELS[item.id] || item.id}: ${item.message}`);
    row.dataset.ok = String(item.ok);
    list.append(row);
  }
  if (!revision.items.length) list.append(el('li', 'hint', 'Отчёта проверки нет – агент запустит её.'));
  box.append(list, el('p', revision.facts.ok ? 'hint' : 'lm-error', `Факты: ${revision.facts.message}`));
  return box;
}

function lmApprovePanel(magnet) {
  const box = el('div', 'lm-panel');
  box.dataset.lmApprove = '';
  box.append(el('h3', '', 'Утверждение'));
  if (magnet.status === 'ready') {
    box.append(el('p', 'hint', 'Лид-магнит утверждён. Файлы – в блоке ниже.'));
    return box;
  }
  const ticket = magnet.revision && magnet.revision.approvalTicket;
  if (!ticket) {
    box.append(el('p', 'hint', 'Утвердить можно, когда проверка зелёная и нет правок, которые ждут агента.'));
    return box;
  }
  const viewed = lmChoice('checkbox', 'lm-viewed', 'yes', 'Я просмотрел страницу на компьютере и телефоне и все тексты', false);
  const approve = el('button', 'primary', 'Утверждаю лид-магнит');
  approve.type = 'button';
  let submitting = false;
  let locked = false;
  const update = () => { approve.disabled = submitting || locked || !viewed.input.checked; };
  update();
  viewed.input.addEventListener('change', update);
  approve.addEventListener('click', async () => {
    if (submitting || locked || approve.disabled) return;
    submitting = true;
    update();
    try {
      await api('/api/lead-magnet/approve', { method: 'POST', body: { id: magnet.id, ticket, confirmViewed: true } });
      locked = true;
      notify('Лид-магнит утверждён. Файлы и тексты – в блоке «Файлы».');
      await refresh();
    } catch (error) {
      if (error.code === 'LM_CHANGED') {
        locked = true;
        await refresh();
        notify('Появилась новая версия лид-магнита – посмотрите её перед утверждением.', 'error');
        return;
      }
      notify(error.message, 'error');
    } finally {
      submitting = false;
      update();
    }
  });
  box.append(viewed.wrap, approve);
  return box;
}

function lmFilesPanel(magnet) {
  const box = el('div', 'lm-panel');
  box.dataset.lmFiles = '';
  box.append(el('h3', '', magnet.files.revision ? `Файлы · ${lmRevisionLabel(magnet.files.revision)}` : 'Файлы'));
  if (!magnet.files.list.length) {
    box.append(el('p', 'hint', 'Файлов пока нет.'));
    return box;
  }
  const list = el('ul', 'plain-list');
  for (const file of magnet.files.list) {
    const row = el('li', 'plain-list__row');
    row.append(el('span', '', LM_FILE_LABELS[file] || file),
      button('Показать в папке', () => api('/api/lead-magnet/reveal', { method: 'POST', body: { id: magnet.id, file } }), 'link-button'));
    list.append(row);
  }
  box.append(list);
  return box;
}

function lmFunnelPanel(variant, magnet) {
  const box = el('div', 'lm-panel');
  const { funnel } = magnet;
  const provider = funnel.provider === 'chatplace' ? 'Chatplace' : funnel.provider;
  box.append(el('h3', '', 'Воронка автоответа'),
    el('p', '', `${provider}: на слово ${magnet.codeWords[0]} воронка ${funnel.exists ? 'есть' : 'не найдена'}${funnel.automationName ? ` («${funnel.automationName}»)` : ''} · проверено ${new Date(funnel.checkedAt).toLocaleString('ru-RU')}`),
    button('Проверить ещё раз', () => lmDecide(variant, { type: 'funnel-check', leadMagnetId: magnet.id }), 'secondary'));
  return box;
}

function lmHandoff(variant, magnet) {
  const label = state.data ? state.data.projectsLabel : 'projects';
  const phrase = magnet
    ? `Продолжи лид-магнит «${magnet.title}» (${label}/.lead-magnets/${magnet.id}) для ролика ${label}/${variant.folder}: выполни automontage inbox и обработай входящие.`
    : `Подготовь лид-магнит для ролика ${label}/${variant.folder}: выполни automontage inbox и обработай входящие.`;
  const box = el('div', 'agent-handoff');
  const field = el('textarea', 'phrase');
  field.rows = 3;
  field.readOnly = true;
  field.value = phrase;
  field.dataset.lmAgentPhrase = '';
  field.setAttribute('aria-label', 'Фраза для агента');
  box.append(el('h3', '', 'Передать агенту'), el('p', 'hint', 'Скопируйте фразу и вставьте её в чат с агентом.'), field,
    button('Скопировать для агента', () => lmCopyText(phrase), 'primary'));
  return box;
}

const LM_BLOCK_ID = /^[a-z0-9][a-z0-9-]{0,60}$/;

function lmTargetName(target) {
  return target.kind === 'block'
    ? `блок «${target.blockId}» · ${target.view === 'phone' ? 'телефон' : 'компьютер'}`
    : `текст «${LM_TEXT_LABELS[target.text]}»`;
}

function lmTargetTo(target) {
  return target.kind === 'block'
    ? `К блоку «${target.blockId}» · ${target.view === 'phone' ? 'телефон' : 'компьютер'}`
    : `К тексту «${LM_TEXT_LABELS[target.text]}»`;
}

function lmCommentsPanel(magnet) {
  const box = el('div', 'lm-panel lm-comments');
  box.append(el('h3', '', 'Правки'));
  let target = null;
  const where = el('p', 'hint', 'Включите «Режим правок» и кликните по блоку страницы или нажмите «Правка к тексту».');
  where.dataset.lmTarget = '';
  const text = lmTextInput('', 'Текст правки', { multiline: true, maxLength: 1000 });
  text.placeholder = 'Что поправить?';
  text.dataset.lmCommentText = '';
  const save = el('button', 'secondary', 'Добавить правку');
  save.type = 'button';
  save.disabled = true;
  let submitting = false;
  const canSave = () => { save.disabled = submitting || !target || !text.value.trim() || !magnet.revision; };
  text.addEventListener('input', canSave);
  save.addEventListener('click', async () => {
    if (submitting || save.disabled) return;
    submitting = true;
    canSave();
    try {
      await api('/api/lead-magnet/comment', {
        method: 'POST', body: { id: magnet.id, revision: magnet.revision.n, target, text: text.value.trim() },
      });
      notify('Правка сохранена. Когда закончите, скопируйте фразу для агента.');
      await refresh();
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      submitting = false;
      canSave();
    }
  });
  const form = el('div', 'comment-form');
  form.append(where, text, save);
  const list = el('ul', 'comment-list');
  list.dataset.lmComments = '';
  const comments = magnet.comments || [];
  if (magnet.commentsBroken) list.append(el('li', 'lm-error', 'Файл правок лид-магнита повреждён – попросите агента проверить.'));
  else if (!comments.length) list.append(el('li', 'hint', 'Правок пока нет.'));
  comments.forEach((comment, index) => {
    const item = el('li', `comment comment--${comment.status}`);
    item.append(el('span', 'comment__status',
      `№${index + 1} · ${lmRevisionLabel(comment.revision)} · ${lmTargetName(comment.target)} · ${comment.status === 'new' ? 'ждёт агента' : 'принята агентом'}`));
    if (comment.snapshotUrl) {
      const image = el('img', 'comment__frame');
      image.alt = '';
      image.src = mediaUrl(comment.snapshotUrl);
      item.append(image);
    }
    item.append(el('p', 'comment__text', comment.text));
    if (comment.status === 'new') {
      item.append(button('Удалить', async () => {
        await api('/api/lead-magnet/comment/delete', { method: 'POST', body: { id: magnet.id, commentId: comment.id } });
        await refresh();
      }, 'link-button'));
    }
    list.append(item);
  });
  box.append(form, list);
  return {
    box,
    setTarget(next) {
      target = next;
      where.textContent = lmTargetTo(next);
      canSave();
      text.focus();
    },
  };
}

// Страница за стеклом передаёт данные, а не команды пульту. Принимаем сообщения
// только от iframe, который сейчас открыт, и проверяем форму каждого сообщения.
function lmHandleMessage(event) {
  if (!lmActive || !lmActive.frame.isConnected || event.source !== lmActive.frame.contentWindow) return;
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'lm-link' && typeof data.href === 'string') {
    notify(`Ссылка на странице: ${data.href.slice(0, 300)} – зритель откроет её после публикации.`);
    return;
  }
  const { rect } = data;
  const rectOk = rect && typeof rect === 'object' && ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(rect[key]) && rect[key] >= 0);
  if (data.type !== 'lm-block' || typeof data.blockId !== 'string' || !LM_BLOCK_ID.test(data.blockId) || !rectOk) return;
  lmActive.onBlock({
    kind: 'block', blockId: data.blockId, view: lmActive.view(), rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
  });
}

window.addEventListener('message', lmHandleMessage);

// Обещание в ролике изменилось после того, как лид-магнит сделан. Агент сам ничего не
// переделывает: решение – кнопка человека.
function lmPromisePanel(variant, magnet) {
  const box = el('div', 'lm-panel lm-warning');
  box.dataset.lmPromiseChanged = '';
  const { sourceFolder, current } = magnet.promise;
  const sourceKey = sourceFolder === variant.folder ? variant.key
    : allCards().flatMap((card) => card.variants).find((item) => item.folder === sourceFolder)?.key;
  const source = { key: sourceKey };
  const linked = sourceFolder !== variant.folder;
  box.append(
    el('h3', '', '⚠️ Обещание в ролике изменилось'),
    ...(linked && sourceFolder ? [el('p', 'hint', `Обещание из ролика „${sourceFolder}“`)] : []),
    el('p', 'hint', 'Лид-магнит сделан под прежнюю цитату.'),
    el('blockquote', 'lm-quote lm-quote--old', `Было: «${magnet.promise.quote}»`),
    el('blockquote', 'lm-quote', current.state === 'changed' ? `Стало: «${current.quote}»`
      : current.state === 'missing' ? 'Стало: обещания в ролике больше нет' : 'Стало: источник недоступен'),
  );
  if (current.state === 'unknown' || !sourceKey) {
    box.append(el('p', 'hint', 'ролик-источник не найден или его обещания не читаются'));
  } else if (current.state === 'changed' || current.state === 'missing') {
    const row = el('div', 'lm-row');
    const refresh = button('Обновить под новое', () => lmDecide(source,
      { type: 'promise-refresh', offerId: current.offerId, leadMagnetId: magnet.id }), 'primary');
    if (current.state === 'missing') refresh.disabled = true;
    row.append(
      refresh,
      button('Оставить как есть', () => lmDecide(source,
        { type: 'promise-keep', offerId: current.offerId, leadMagnetId: magnet.id }), 'secondary'),
    );
    box.append(row, el('p', 'hint', 'Агент сам ничего не переделывает: ваша кнопка – его задание.'));
    if (current.state === 'missing') box.append(el('p', 'hint',
      'Сначала в ролике должно появиться новое обещание – агент запишет его при монтаже'));
  }
  return box;
}
