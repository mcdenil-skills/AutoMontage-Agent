'use strict';

const SECTION_TITLES = { waiting: 'Ждёт меня', working: 'В работе', ready: 'Готов' };
const STATUS_LABELS = { waiting: 'Ждёт меня', working: 'В работе', ready: 'Готов' };
const VIDEO_LABELS = {
  final: 'Финальная версия',
  preview: 'Preview на проверку',
  'stale-preview': 'Preview устарел — агент готовит новый',
};
// Показываем, когда видео есть на диске, но пульт не умеет отдать его браузеру
// (legacy-форматы вроде .mkv/.avi) — «Показать в папке» при этом остаётся рабочим.
const VIDEO_UNSUPPORTED_LABEL = 'Этот формат не проигрывается в пульте — откройте в папке';
const REFRESH_MS = 20000;

const token = new URLSearchParams(window.location.hash.slice(1)).get('token') || '';
const state = { data: null, tab: 'main', query: '', openCardId: null, variantKey: null };
// Снимок последних /api/cards, для которых список уже перерисован — фоновый опрос
// каждые 20 с не должен пересобирать DOM и сбрасывать фокус/скролл, если ничего не
// изменилось на сервере.
let lastCardsJson = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function mediaUrl(url) {
  const parsed = new URL(url, window.location.origin);
  parsed.searchParams.set('token', token);
  return `${parsed.pathname}${parsed.search}`;
}

async function api(pathname, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(pathname, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (_) {
    // Сервер пульта закрылся или недоступен: fetch() отклоняется низкоуровневой сетевой
    // ошибкой браузера («Failed to fetch»), которую человеку показывать нельзя.
    throw new Error('Пульт не отвечает — откройте его снова значком «Пульт роликов».');
  }
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_) {
    payload = null;
  }
  if (!response.ok) {
    // 401 и 503 сервер отдаёт как обычный текст, а не JSON (см. sendError в http.js),
    // и это не разовая ошибка запроса — токен умер или пульт выключается совсем.
    if (response.status === 401) throw new Error('Ключ доступа устарел — откройте пульт заново значком.');
    if (response.status === 503) throw new Error('Пульт закрывается — откройте его снова значком.');
    const error = new Error((payload && payload.message) || 'Запрос не выполнен');
    error.code = payload && payload.code;
    throw error;
  }
  return payload;
}

function notify(message, tone = 'info') {
  const notice = document.querySelector('[data-notice]');
  notice.textContent = message;
  notice.dataset.tone = tone;
  notice.hidden = !message;
}

function button(label, handler, className = 'secondary') {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', async () => {
    node.disabled = true;
    try {
      await handler();
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      node.disabled = false;
    }
  });
  return node;
}

function formatClock(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// Таймкоды правок — по низу секунды (14.6 → 0:14), как в самом плеере: округление вверх
// (0:15) обещало бы кадр, которого правка ещё не касалась. Длительность в cardFacts()
// по-прежнему округляется через formatClock — там это просто «сколько идёт ролик».
function formatClockFloor(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function formatAspect(meta) {
  if (!meta) return '';
  const ratio = meta.width / meta.height;
  const known = [['9:16', 9 / 16], ['16:9', 16 / 9], ['1:1', 1], ['4:5', 4 / 5]];
  const match = known.find(([, value]) => Math.abs(ratio - value) < 0.02);
  return match ? match[0] : `${meta.width}×${meta.height}`;
}

function formatDate(iso) {
  const date = new Date(iso);
  // Legacy-вариант без файла на диске получает updatedAt = new Date(0) (см. catalog.js) —
  // это не настоящая дата, а «файл потерян», и показывать «1 янв.» человеку не нужно.
  if (Number.isNaN(date.getTime()) || date.getFullYear() < 2000) return '';
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function pluralVariants(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} вариант`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} варианта`;
  return `${count} вариантов`;
}

function allCards() {
  const data = state.data;
  return data ? [...data.waiting, ...data.working, ...data.ready, ...data.archive] : [];
}

// NFC + нижний регистр с обеих сторон: имена папок на macOS бывают в NFD (например,
// «й» как «и» + отдельный значок), а человек печатает в обычной, NFC-раскладке —
// без нормализации визуально одинаковые слова не совпадали бы при поиске.
function normalizeText(text) {
  return text.normalize('NFC').toLowerCase();
}

function matches(card) {
  const query = normalizeText(state.query.trim());
  if (!query) return true;
  return [card.title, ...card.variants.map((variant) => variant.variantLabel)]
    .some((text) => normalizeText(text).includes(query));
}

// Самый срочный вариант карточки — по нему рисуем лицо карточки в списке и его же
// открываем первым, а не первый по алфавиту порядку вкладок (card.variants).
function leadVariant(card) {
  return card.variants.find((variant) => variant.key === card.leadKey) || card.variants[0];
}

function cardFacts(card) {
  const lead = leadVariant(card);
  // Срочный вариант мог ещё не обзавестись ffprobe-метаданными (preview только что
  // опубликован) — ищем факты у любого другого варианта карточки, а не показываем пустоту.
  const source = lead.meta ? lead : (card.variants.find((variant) => variant.meta) || lead);
  const facts = [formatAspect(source.meta), source.meta ? formatClock(source.meta.durationSec) : '']
    .filter(Boolean)
    .join(' · ');
  return card.variants.length > 1 ? [facts, pluralVariants(card.variants.length)].filter(Boolean).join(' · ') : facts;
}

function renderCard(card) {
  const node = el('button', `card card--${card.status}`);
  node.type = 'button';
  node.dataset.cardId = card.id;
  const thumb = el('div', 'card__thumb');
  const lead = leadVariant(card);
  // Та же логика, что в cardFacts: у срочного варианта может не быть обложки (или её ещё
  // не сгенерировал ffmpeg), тогда карточка берёт обложку у любого варианта, где она есть.
  const source = lead.thumbUrl ? lead : (card.variants.find((variant) => variant.thumbUrl) || lead);
  if (source.thumbUrl) {
    const image = el('img');
    image.alt = '';
    image.loading = 'lazy';
    image.src = mediaUrl(source.thumbUrl);
    image.addEventListener('error', () => image.remove());
    thumb.append(image);
  }
  const body = el('div', 'card__body');
  // <button> — фразовый контент: h3/p внутри него не по спецификации (хоть браузеры это
  // и прощают). span + display:block в CSS даёт тот же вид, оставаясь валидной разметкой.
  const meta = el('span', 'card__meta');
  meta.append(
    el('span', `badge badge--${card.status}`, STATUS_LABELS[card.status]),
    el('span', '', formatDate(card.updatedAt)),
    el('span', '', cardFacts(card)),
  );
  body.append(el('span', 'card__title', card.title), meta, el('span', 'card__next', card.nextStep));
  node.append(thumb, body);
  node.addEventListener('click', () => openCard(card.id));
  return node;
}

function renderGrid(cards, section) {
  const grid = el('div', 'grid');
  grid.dataset.section = section;
  cards.forEach((card) => grid.append(renderCard(card)));
  return grid;
}

function renderFolderList(items, section, describe) {
  const list = el('ul', 'plain-list');
  list.dataset.section = section;
  for (const item of items) {
    const row = el('li', 'plain-list__row');
    row.append(
      el('span', '', describe(item)),
      button('Показать в папке', () => api('/api/reveal', { method: 'POST', body: { folder: item.folder } }), 'link-button'),
    );
    list.append(row);
  }
  return list;
}

function renderList() {
  const view = document.querySelector('[data-view="list"]');
  view.replaceChildren();
  const data = state.data;
  if (!data) return;
  if (state.tab === 'main') {
    let shown = 0;
    for (const key of ['waiting', 'working', 'ready']) {
      const cards = data[key].filter(matches);
      if (!cards.length) continue;
      shown += cards.length;
      const section = el('section', 'section');
      const title = el('h2', 'section__title', `${SECTION_TITLES[key]} (${cards.length})`);
      title.dataset.sectionTitle = key;
      section.append(title, renderGrid(cards, key));
      view.append(section);
    }
    if (!shown) {
      view.append(el('p', 'empty', state.query ? 'Ничего не найдено.' : 'Роликов пока нет. Попросите агента смонтировать первый.'));
    }
  } else if (state.tab === 'archive') {
    const cards = data.archive.filter(matches);
    view.append(cards.length ? renderGrid(cards, 'archive') : el('p', 'empty', 'Архив пуст.'));
  } else if (state.tab === 'unregistered') {
    view.append(
      el('p', 'hint', 'У этих папок нет паспорта ролика. Попросите агента: «заведи паспорт для папки …».'),
      renderFolderList(data.unregistered, 'unregistered', (item) => `${data.projectsLabel}/${item.folder}`),
    );
  } else if (state.tab === 'broken') {
    view.append(
      el('p', 'hint', 'Попросите агента проверить паспорт этой папки.'),
      renderFolderList(data.broken, 'broken', (item) => `${data.projectsLabel}/${item.folder} — ${item.error}`),
    );
  }
}

function updateTabs() {
  const data = state.data;
  for (const key of ['archive', 'unregistered', 'broken']) {
    document.querySelector(`[data-count="${key}"]`).textContent = String(data[key].length);
    if (key === 'archive') continue;
    const tabButton = document.querySelector(`[data-tab="${key}"]`);
    tabButton.hidden = data[key].length === 0;
    // Открытая вкладка «Без паспорта»/«Не читается» вдруг опустела (агент завёл паспорт,
    // почистил ошибку) — нельзя оставлять человека смотреть на спрятанную кнопку раздела.
    if (state.tab === key && data[key].length === 0) {
      state.tab = 'main';
      document.querySelectorAll('[data-tab]').forEach((other) => {
        other.setAttribute('aria-pressed', String(other.dataset.tab === 'main'));
      });
    }
  }
}

function currentCard() {
  return allCards().find((card) => card.id === state.openCardId) || null;
}

function currentVariant(card) {
  return card.variants.find((variant) => variant.key === state.variantKey) || card.variants[0];
}

function openCard(cardId) {
  notify('');
  state.openCardId = cardId;
  const card = currentCard();
  state.variantKey = card ? leadVariant(card).key : null;
  document.querySelector('[data-view="list"]').hidden = true;
  document.querySelector('[data-view="detail"]').hidden = false;
  renderDetail();
}

function closeCard() {
  notify('');
  state.openCardId = null;
  state.variantKey = null;
  document.querySelector('[data-view="detail"]').hidden = true;
  document.querySelector('[data-view="detail"]').replaceChildren();
  document.querySelector('[data-view="list"]').hidden = false;
  renderList();
}

function actionsBlock(card, variant) {
  const box = el('div', 'actions');
  box.append(el('h3', '', 'Передать агенту'));
  box.append(button('Показать в папке', () => api('/api/reveal', { method: 'POST', body: { key: variant.key } })));
  if (variant.reviewable) {
    box.append(button('Открыть проверку монтажа', async () => {
      await api('/api/review', { method: 'POST', body: { key: variant.key } });
      notify('Проверка монтажа открывается в отдельном окне.');
    }));
  }
  box.append(button(card.archived ? 'Вернуть из архива' : 'В архив', async () => {
    await api('/api/archive', { method: 'POST', body: { cardId: card.id, archived: !card.archived } });
    notify(card.archived ? 'Ролик вернулся из архива.' : 'Ролик убран в архив. Папка не тронута.');
    await refresh();
    closeCard();
  }));
  box.append(el('p', 'hint', 'Скопируйте фразу и вставьте её в чат с агентом.'));
  const phrase = `Продолжи ролик «${card.title}» в ${state.data.projectsLabel}/${variant.folder}: выполни automontage inbox и обработай входящие.`;
  const field = el('textarea', 'phrase');
  field.rows = 3;
  field.readOnly = true;
  field.value = phrase;
  field.dataset.agentPhrase = '';
  field.setAttribute('aria-label', 'Фраза для агента');
  const copyStatus = el('span', 'copy-status');
  copyStatus.dataset.copyStatus = '';
  const copy = button('Скопировать для агента', async () => {
    let copied = false;
    try {
      await navigator.clipboard.writeText(phrase);
      copied = true;
    } catch (_) {
      field.select();
      // execCommand — резервный путь, когда Clipboard API недоступен (нет разрешения,
      // страница не в фокусе): он тоже может не сработать, и об этом нужно сказать честно,
      // а не показывать «Скопировано» вслепую.
      copied = document.execCommand('copy');
    }
    copyStatus.textContent = copied
      ? 'Скопировано — вставьте в чат с агентом'
      : 'Не удалось скопировать — выделите фразу и нажмите ⌘C / Ctrl+C';
  }, 'primary');
  box.append(field, copy, copyStatus);
  return box;
}

function approveBlock(variant) {
  const box = el('div', 'approve');
  // Билет запоминаем на самой коробке — по нему фоновое обновление узнаёт, что вариант
  // стал (не)утверждаемым или что появился новый preview, не дожидаясь полной перерисовки.
  box.dataset.ticket = variant.approvalTicket || '';
  if (!variant.approvable) {
    box.hidden = true;
    box.setHistoryMode = () => {};
    return box;
  }
  box.append(el('h3', '', 'Утверждение'));
  const label = el('label', 'check');
  const checkbox = el('input');
  checkbox.type = 'checkbox';
  checkbox.dataset.viewed = '';
  label.append(checkbox, el('span', '', 'Я посмотрел preview целиком'));
  const approve = el('button', 'primary', 'Утверждаю');
  approve.type = 'button';
  approve.disabled = true;
  // Пока человек смотрит старую версию из Истории, утверждать нельзя — кнопка блокируется
  // независимо от чекбокса (см. box.setHistoryMode, дергает renderDetail).
  let viewingHistory = false;
  checkbox.addEventListener('change', () => { approve.disabled = viewingHistory || !checkbox.checked; });
  approve.addEventListener('click', async () => {
    approve.disabled = true;
    try {
      await api('/api/approve', {
        method: 'POST',
        body: { key: variant.key, ticket: variant.approvalTicket, confirmPreviewViewed: true },
      });
      notify('Утверждено. Скопируйте фразу для агента — он соберёт финал и проверит его.');
      await refresh();
    } catch (error) {
      if (error.code === 'PREVIEW_CHANGED') {
        // Билет протух не из-за сети, а потому что ролик реально изменился — перечитываем
        // карточку целиком вместо просьбы «обновите страницу вручную».
        await refresh();
        notify('Появилась новая версия preview — посмотрите её перед утверждением.', 'error');
      } else {
        notify(error.message, 'error');
        approve.disabled = viewingHistory || !checkbox.checked;
      }
    }
  });
  box.append(label, approve);
  box.setHistoryMode = (active) => {
    viewingHistory = active;
    approve.disabled = active || !checkbox.checked;
  };
  return box;
}

async function loadComments(variant, list, video) {
  const { comments } = await api(`/api/comments?key=${encodeURIComponent(variant.key)}`);
  list.replaceChildren();
  if (!comments.length) {
    list.append(el('li', 'hint', 'Правок пока нет.'));
    return;
  }
  for (const comment of comments) {
    const item = el('li', `comment comment--${comment.status}`);
    const jump = el('button', 'link-button', formatClockFloor(comment.timeSec));
    jump.type = 'button';
    jump.addEventListener('click', () => {
      video.currentTime = comment.timeSec;
      video.pause();
    });
    item.append(jump);
    if (comment.frameUrl) {
      const frame = el('img', 'comment__frame');
      frame.alt = '';
      frame.src = mediaUrl(comment.frameUrl);
      item.append(frame);
    }
    item.append(
      el('p', 'comment__text', comment.text),
      el('span', 'comment__status', comment.status === 'new' ? 'ждёт агента' : 'принята агентом'),
    );
    if (comment.status === 'new') {
      item.append(button('Удалить', async () => {
        await api('/api/comments/delete', { method: 'POST', body: { key: variant.key, id: comment.id } });
        await loadComments(variant, list, video);
        await refresh({ keepDetail: true });
      }, 'link-button'));
    }
    list.append(item);
  }
}

function commentsBlock(variant, video) {
  const box = el('div', 'comments');
  box.append(el('h3', '', 'Правки'));
  if (!variant.video) {
    const hint = variant.videoUnsupported
      ? 'Этот формат не проигрывается в пульте — правку можно описать словами агенту.'
      : 'Правки можно оставить, когда появится видео.';
    box.append(el('p', 'hint', hint));
    box.setHistoryMode = () => {};
    return box;
  }
  const time = el('span', 'comment-time', 'на 0:00');
  const text = el('textarea');
  text.rows = 3;
  text.maxLength = 1000;
  text.placeholder = 'Что поправить в этом месте?';
  text.dataset.commentText = '';
  text.setAttribute('aria-label', 'Текст правки');
  const syncTime = () => { time.textContent = `на ${formatClockFloor(video.currentTime || 0)}`; };
  video.addEventListener('timeupdate', syncTime);
  video.addEventListener('seeked', syncTime);
  text.addEventListener('focus', () => video.pause());
  const list = el('ul', 'comment-list');
  list.dataset.commentList = '';
  // secondary — амбер оставлен только двум по-настоящему решающим кнопкам («Утверждаю»,
  // «Скопировать для агента»), чтобы взгляд не разбегался между тремя яркими кнопками.
  const save = el('button', 'secondary', 'Добавить правку');
  save.type = 'button';
  save.addEventListener('click', async () => {
    if (!text.value.trim()) {
      notify('Напишите, что поправить.', 'error');
      return;
    }
    save.disabled = true;
    try {
      await api('/api/comments', {
        method: 'POST',
        body: { key: variant.key, timeSec: video.currentTime || 0, text: text.value },
      });
      text.value = '';
      await loadComments(variant, list, video);
      notify('Правка сохранена. Когда закончите, скопируйте фразу для агента.');
      await refresh({ keepDetail: true });
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      save.disabled = false;
    }
  });
  const form = el('div', 'comment-form');
  form.append(time, text, save);
  box.append(form, list);
  loadComments(variant, list, video).catch((error) => notify(error.message, 'error'));
  box.setHistoryMode = (active) => { save.disabled = active; };
  return box;
}

function renderDetail() {
  const view = document.querySelector('[data-view="detail"]');
  view.replaceChildren();
  const card = currentCard();
  if (!card) {
    closeCard();
    return;
  }
  const variant = currentVariant(card);
  const back = el('button', 'link-button', '← Все ролики');
  back.type = 'button';
  back.addEventListener('click', closeCard);
  view.append(back, el('h2', 'detail__title', card.title));
  if (card.variants.length > 1) {
    const tabs = el('div', 'variant-tabs');
    for (const option of card.variants) {
      const tab = el('button', 'variant-tab', option.variantLabel);
      tab.type = 'button';
      tab.setAttribute('aria-pressed', String(option.key === variant.key));
      tab.addEventListener('click', () => {
        state.variantKey = option.key;
        renderDetail();
      });
      tabs.append(tab);
    }
    view.append(tabs);
  }
  const layout = el('div', 'detail');
  const playerColumn = el('div', 'detail__player');
  const playerSlot = el('div', 'player-slot');
  playerColumn.append(playerSlot);
  // video остаётся null, пока в слоте не настоящий <video> (например, легаси .mkv или
  // ролик без preview) — dead-плеер без источника выглядел рабочим, но не проигрывал ничего.
  let video = null;
  function showVideo(url) {
    playerSlot.replaceChildren();
    video = el('video', 'player');
    video.controls = true;
    video.preload = 'metadata';
    video.dataset.player = '';
    video.src = url;
    playerSlot.append(video);
  }
  function showPlaceholder() {
    playerSlot.replaceChildren(el('div', 'player player--empty'));
    video = null;
  }

  let videoLabelText;
  if (variant.video) {
    // Сразу после утверждения ролик ещё «В работе» (агент собирает финал), но видео на
    // экране — уже утверждённый preview, а не тот, что «ждёт проверки».
    if (variant.video.kind === 'preview' && variant.status === 'working' && !variant.nextStep.startsWith('Ждёт агента')) {
      videoLabelText = 'Утверждённый preview — агент собирает финал';
    } else {
      videoLabelText = VIDEO_LABELS[variant.video.kind];
    }
  } else if (variant.videoUnsupported) {
    videoLabelText = VIDEO_UNSUPPORTED_LABEL;
  } else {
    videoLabelText = 'Видео пока нет';
  }
  if (variant.video) showVideo(mediaUrl(variant.video.url)); else showPlaceholder();
  const videoLabel = el('p', 'player__label', videoLabelText);
  playerColumn.append(videoLabel);

  // approveBox/commentsBox назначаются ниже, но замыкания истории читают их только по
  // клику — к тому моменту renderDetail уже отработает целиком, и обе переменные будут
  // присвоены (порядок объявления здесь не важен, важен порядок исполнения).
  let approveBox;
  let commentsBox;
  const historyBar = el('div', 'history-bar');
  historyBar.hidden = true;
  const backToCurrent = el('button', 'link-button', 'Вернуться к текущей');
  backToCurrent.type = 'button';
  backToCurrent.addEventListener('click', () => {
    if (variant.video) showVideo(mediaUrl(variant.video.url)); else showPlaceholder();
    videoLabel.textContent = videoLabelText;
    historyBar.hidden = true;
    approveBox.setHistoryMode(false);
    commentsBox.setHistoryMode(false);
  });
  historyBar.append(el('span', 'history-bar__text', 'Вы смотрите прежнюю версию'), backToCurrent);
  playerColumn.append(historyBar);

  if (variant.history.length) {
    const history = el('ul', 'history');
    history.hidden = true;
    for (const item of variant.history) {
      const row = el('li');
      const open = el('button', 'link-button', item.label);
      open.type = 'button';
      open.addEventListener('click', () => {
        // Рендеры Истории — всегда обычный mp4 (см. renderHistory в catalog.js), поэтому
        // тут всегда показываем настоящее видео, даже если текущий вариант — плейсхолдер.
        showVideo(mediaUrl(item.url));
        videoLabel.textContent = item.label;
        // Кадр из Истории уже не текущий: правку по нему добавить нельзя (агент увидит
        // не тот таймкод), а утверждение всегда привязано именно к текущему preview.
        historyBar.hidden = false;
        approveBox.setHistoryMode(true);
        commentsBox.setHistoryMode(true);
      });
      row.append(open);
      history.append(row);
    }
    const toggle = el('button', 'secondary', `История (${variant.history.length})`);
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', () => {
      history.hidden = !history.hidden;
      toggle.setAttribute('aria-expanded', String(!history.hidden));
    });
    playerColumn.append(toggle, history);
  }
  const side = el('div', 'detail__side');
  const badge = el('p', `badge badge--${variant.status}`, STATUS_LABELS[variant.status]);
  badge.dataset.variantStatus = '';
  const next = el('p', 'detail__next', variant.nextStep);
  next.dataset.variantNext = '';
  approveBox = approveBlock(variant);
  commentsBox = commentsBlock(variant, video);
  side.append(badge, next, approveBox, commentsBox, actionsBlock(card, variant));
  layout.append(playerColumn, side);
  view.append(layout);
}

async function refresh({ keepDetail = false } = {}) {
  try {
    state.data = await api('/api/cards');
  } catch (error) {
    notify(error.message, 'error');
    return;
  }
  // Сервер снова ответил — прежняя ошибка («Failed to fetch», 409 и т.п.) больше не
  // актуальна. Успешные подсказки (тон не 'error') это не трогает.
  const notice = document.querySelector('[data-notice]');
  if (notice.dataset.tone === 'error') notify('');
  updateTabs();
  if (!state.openCardId) {
    const json = JSON.stringify(state.data);
    if (json !== lastCardsJson) renderList();
    lastCardsJson = json;
    return;
  }
  const card = currentCard();
  if (!card) {
    closeCard();
    return;
  }
  if (!keepDetail) {
    renderDetail();
    return;
  }
  const variant = currentVariant(card);
  const badge = document.querySelector('[data-variant-status]');
  const next = document.querySelector('[data-variant-next]');
  if (badge) {
    badge.textContent = STATUS_LABELS[variant.status];
    badge.className = `badge badge--${variant.status}`;
  }
  if (next) next.textContent = variant.nextStep;
  // Билет утверждения мог устареть между фоновыми обновлениями: новая правка убирает
  // возможность утвердить, удаление правки — возвращает, а новый preview меняет билет
  // на другой непустой. Лёгкое обновление badge/next этого не замечает — досверяем отдельно.
  const approveBox = document.querySelector('.approve');
  if (approveBox) {
    const previousTicket = approveBox.dataset.ticket || '';
    const freshTicket = variant.approvalTicket || '';
    if (previousTicket !== freshTicket) {
      if (!previousTicket || !freshTicket) {
        approveBox.replaceWith(approveBlock(variant));
      } else {
        renderDetail();
        notify('Появилась новая версия preview — посмотрите её перед утверждением.');
      }
    }
  }
}

async function init() {
  if (!token) {
    notify('Нет ключа доступа. Откройте пульт значком или командой automontage pult.', 'error');
    return;
  }
  document.querySelector('[data-search]').addEventListener('input', (event) => {
    state.query = event.target.value;
    if (!state.openCardId) renderList();
  });
  document.querySelectorAll('[data-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.tab = tab.dataset.tab;
      document.querySelectorAll('[data-tab]').forEach((other) => {
        other.setAttribute('aria-pressed', String(other === tab));
      });
      closeCard();
    });
  });
  await refresh();
  setInterval(() => { refresh({ keepDetail: true }); }, REFRESH_MS);
}

init();
