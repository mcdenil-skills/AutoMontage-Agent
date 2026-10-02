import { formatTime, renderTimeline } from './timeline.js';
import { createMediaImporter } from './media-import.js';
import { createBrollDiscoveryUI } from './broll-discovery.js';

function takeSessionToken() {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const token = fragment.get('token');
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  return token;
}

function authenticatedMediaUrl(pathname, token) {
  const url = new URL(pathname, window.location.origin);
  url.searchParams.set('token', token);
  return `${url.pathname}${url.search}`;
}

async function loadState(token) {
  const response = await fetch('/api/state', {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!response.ok) {
    const error = new Error('review state request failed');
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function statusLabel(status) {
  return status === 'approved' ? 'Утверждён' : 'Черновик';
}

function formatBytes(bytes) {
  const safe = Math.max(0, Number(bytes) || 0);
  if (safe >= 1024 * 1024) return `${(safe / (1024 * 1024)).toFixed(1)} МБ`;
  if (safe >= 1024) return `${(safe / 1024).toFixed(1)} КБ`;
  return `${Math.round(safe)} Б`;
}

function renderDiagnostics(timing) {
  const list = document.querySelector('[data-diagnostics]');
  const summary = document.querySelector('[data-diagnostic-summary]');
  const light = document.querySelector('[data-health-light]');
  list.replaceChildren();
  const groups = [
    ['Ошибка', timing.errors, 'error'],
    ['Предупреждение', timing.warnings, 'warning'],
    ['Подсказка', timing.suggestions, 'suggestion'],
  ];
  const count = groups.reduce((total, [, items]) => total + items.length, 0);

  summary.textContent = count === 0
    ? 'Границы сцен совпадают с кадровой сеткой.'
    : `Найдено замечаний: ${count}`;
  light.dataset.health = timing.errors.length > 0 ? 'error' : 'ok';

  if (count === 0) {
    const item = document.createElement('li');
    item.className = 'diagnostic-ok';
    item.textContent = 'Критических расхождений нет';
    list.append(item);
    return;
  }

  groups.forEach(([label, items, tone]) => {
    items.forEach((entry) => {
      const item = document.createElement('li');
      item.dataset.tone = tone;
      const prefix = document.createElement('span');
      prefix.textContent = label;
      const message = document.createElement('p');
      const suggestionReason = entry.reason === 'word'
        ? 'ближайшую границу слова'
        : 'кадровую сетку';
      message.textContent = entry.message || (
        `Сцена ${(entry.sceneIndex ?? 0) + 1}: перенести на ${suggestionReason} ${formatTime(entry.suggestedSeconds, true)}`
      );
      item.append(prefix, message);
      list.append(item);
    });
  });
}

function revisionLabel(revision) {
  return `v${String(revision).padStart(2, '0')}`;
}

function formatPreviewTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const rest = (safe - (minutes * 60)).toFixed(2).padStart(5, '0');
  return `${String(minutes).padStart(2, '0')}:${rest}`;
}

function prepareBrowserState(state, token) {
  return {
    ...state,
    assets: state.assets.map((asset) => ({
      ...asset,
      mediaUrl: authenticatedMediaUrl(asset.url, token),
      ...(asset.previewUrl ? {
        previewMediaUrl: authenticatedMediaUrl(asset.previewUrl, token),
      } : {}),
    })),
  };
}

function renderMetadata(state, token) {
  const duration = state.output.durationInFrames / state.output.fps;
  document.querySelector('[data-project-title]').textContent = `${state.project.name} · ${state.brief.title}`;
  document.querySelector('[data-brief-status]').textContent = statusLabel(state.brief.status);
  document.querySelector('[data-duration]').textContent = formatTime(duration, true);
  document.querySelector('[data-output]').textContent = (
    `${state.output.width}×${state.output.height} · ${state.output.fps} FPS`
  );

  const video = document.querySelector('video[data-source-video]');
  const mediaUrl = authenticatedMediaUrl(state.source.url, token);
  if (video.getAttribute('src') !== mediaUrl) video.src = mediaUrl;
  const previewFrame = document.querySelector('[data-preview-frame]');
  const previewEmpty = document.querySelector('[data-preview-empty]');
  const previewKind = document.querySelector('[data-preview-kind]');
  if (state.currentPreview) {
    let previewVideo = previewFrame.querySelector('video[data-preview-video]');
    if (!previewVideo) {
      previewVideo = document.createElement('video');
      previewVideo.controls = true;
      previewVideo.preload = 'metadata';
      previewVideo.dataset.previewVideo = '';
      previewVideo.setAttribute('aria-label', 'Смонтированный предпросмотр');
      previewFrame.replaceChildren(previewVideo);
    }
    const previewUrl = authenticatedMediaUrl(`${state.currentPreview.url}?v=${encodeURIComponent(state.currentPreview.generatedAt)}`, token);
    if (previewVideo.getAttribute('src') !== previewUrl) previewVideo.src = previewUrl;
    previewFrame.hidden = false;
    previewEmpty.hidden = true;
    previewKind.hidden = false;
    previewKind.textContent = state.currentPreview.stale ? 'УСТАРЕЛ - сохраните и создайте новый preview' : state.currentPreview.kind === 'full'
      ? 'ПОЛНЫЙ РОЛИК'
      : `ФРАГМЕНТ ${formatPreviewTime(state.currentPreview.fromSec)}–${formatPreviewTime(state.currentPreview.toSec)}`;
  } else {
    previewFrame.replaceChildren();
    previewFrame.hidden = true;
    previewEmpty.hidden = false;
    previewKind.hidden = true;
    previewKind.textContent = '';
  }
  let revision = document.querySelector('[data-revision]');
  if (!revision) {
    revision = document.createElement('span');
    revision.className = 'revision-label';
    revision.dataset.revision = '';
    document.querySelector('[data-brief-status]').parentElement.append(revision);
  }
  revision.textContent = revisionLabel(state.session.baseRevision);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function createEditControls() {
  const panel = element('section', 'panel edit-workbench');
  panel.dataset.editControls = '';
  panel.setAttribute('aria-labelledby', 'edit-title');
  const heading = element('div', 'edit-heading');
  const titleGroup = element('div');
  titleGroup.append(
    element('p', 'panel-kicker', 'Безопасные правки'),
    element('h2', '', 'Редактирование'),
  );
  titleGroup.lastElementChild.id = 'edit-title';
  const actions = element('div', 'edit-actions');
  const undo = element('button', 'edit-button', 'Отменить');
  undo.type = 'button';
  const redo = element('button', 'edit-button', 'Повторить');
  redo.type = 'button';
  const save = element('button', 'edit-button edit-button--primary', 'Сохранить');
  save.type = 'button';
  actions.append(undo, redo, save);
  heading.append(titleGroup, actions);

  const status = element('p', 'edit-status', 'Изменений нет');
  status.dataset.editStatus = '';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const conflict = element('p', 'edit-conflict');
  conflict.dataset.conflict = '';
  conflict.hidden = true;
  const discardConflict = element(
    'button',
    'edit-button edit-conflict-action',
    'Отбросить устаревшие правки и продолжить',
  );
  discardConflict.type = 'button';
  discardConflict.hidden = true;
  const transientBusy = element('p', 'edit-conflict');
  transientBusy.dataset.transientBusy = '';
  transientBusy.hidden = true;
  const retryBusy = element(
    'button',
    'edit-button edit-conflict-action',
    'Повторить проверку',
  );
  retryBusy.type = 'button';
  retryBusy.dataset.busyRetry = '';
  retryBusy.hidden = true;
  const error = element('p', 'edit-error');
  error.dataset.editError = '';
  error.setAttribute('role', 'alert');
  error.hidden = true;

  const body = element('div', 'edit-body');
  const importSection = element('section', 'media-import');
  importSection.setAttribute('aria-labelledby', 'media-import-title');
  const importHeading = element('div', 'media-import__heading');
  const importTitle = element('h3', '', 'Медиа проекта');
  importTitle.id = 'media-import-title';
  const importButton = element('button', 'edit-button media-import__button', 'Добавить медиа');
  importButton.type = 'button';
  importButton.dataset.mediaImport = '';
  const mediaInput = element('input', 'visually-hidden');
  mediaInput.type = 'file';
  mediaInput.tabIndex = -1;
  mediaInput.setAttribute('aria-hidden', 'true');
  mediaInput.accept = '.avif,.gif,.jpeg,.jpg,.png,.webp,.mp4,.mov,.m4v,.webm';
  mediaInput.dataset.mediaInput = '';
  const abortImport = element('button', 'edit-button media-import__abort', 'Отменить загрузку');
  abortImport.type = 'button';
  abortImport.hidden = true;
  abortImport.dataset.mediaAbort = '';
  importHeading.append(importTitle, importButton, mediaInput, abortImport);
  const importStatus = element('p', 'media-import__status', 'Можно добавить изображение или видео');
  importStatus.dataset.mediaImportStatus = '';
  importStatus.setAttribute('role', 'status');
  importStatus.setAttribute('aria-live', 'polite');
  const importProgress = element('progress', 'media-import__progress');
  importProgress.max = 100;
  importProgress.dataset.mediaProgress = '';
  importProgress.hidden = true;
  importProgress.setAttribute('aria-label', 'Загрузка медиа');
  importSection.append(importHeading, importStatus, importProgress);
  const diffSection = element('section', 'edit-diff');
  const diffTitle = element('h3', '', 'Проверенные изменения');
  const diff = element('ul', 'edit-diff-list');
  diff.dataset.serverDiff = '';
  diffSection.append(diffTitle, diff);
  const brollSection = element('section', 'edit-broll');
  const brollTitle = element('h3', '', 'B-roll');
  const broll = element('div', 'broll-controls');
  broll.dataset.brollControls = '';
  brollSection.append(brollTitle, broll);
  body.append(importSection, diffSection, brollSection);
  panel.append(
    heading,
    status,
    conflict,
    discardConflict,
    transientBusy,
    retryBusy,
    error,
    body,
  );
  document.querySelector('.timeline-panel').before(panel);
  return {
    panel,
    undo,
    redo,
    save,
    status,
    conflict,
    discardConflict,
    transientBusy,
    retryBusy,
    error,
    diff,
    broll,
    importButton,
    mediaInput,
    abortImport,
    importStatus,
    importProgress,
  };
}

function diffLine(change, state) {
  if (change.kind === 'boundary') {
    return `Граница сцен ${change.leftScene + 1}–${change.rightScene + 1}: ${formatTime(change.from, true)} → ${formatTime(change.to, true)}`;
  }
  const labels = new Map(state.assets.map((asset) => [asset.id, asset.label]));
  if (change.kind === 'asset') {
    return `Медиа сцены ${change.scene + 1}: ${labels.get(change.from) || 'не выбрано'} → ${labels.get(change.to) || 'не выбрано'}`;
  }
  if (change.kind === 'fit') {
    const fit = { contain: 'Вписать целиком', cover: 'Заполнить кадр' };
    return `Кадр сцены ${change.scene + 1}: ${fit[change.from] || 'не задан'} → ${fit[change.to]}`;
  }
  if (change.kind === 'clip-start') {
    const from = change.from === null ? 'не задан' : formatTime(change.from, true);
    return `Старт видео сцены ${change.scene + 1}: ${from} → ${formatTime(change.to, true)}`;
  }
  if (change.kind === 'audio-mode') {
    const audio = {
      mute: 'Без звука',
      mix: 'Тихо поверх голоса',
      replace: 'Вместо голоса',
    };
    return `Звук сцены ${change.scene + 1}: ${audio[change.from] || 'не задан'} → ${audio[change.to]}`;
  }
  return `Изменение сцены ${change.scene + 1}`;
}

function validValidation(value) {
  return value && Array.isArray(value.diff)
    && Number.isSafeInteger(value.destinationRevision)
    && value.destinationRevision > 0
    && value.timing
    && Array.isArray(value.timing.errors)
    && Array.isArray(value.timing.warnings)
    && Array.isArray(value.timing.suggestions);
}

function editPayload(state, commands) {
  return {
    baseRevision: state.session.baseRevision,
    baseHash: state.session.baseHash,
    manifestHash: state.session.manifestHash,
    commands,
  };
}

async function postEdit(pathname, token, payload) {
  const response = await fetch(pathname, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  let data = null;
  if (response.ok) {
    try {
      data = await response.json();
    } catch (_) {
      data = null;
    }
  }
  return { response, data };
}

function createEditor(initialState, token) {
  let state = prepareBrowserState(initialState, token);
  const commands = [];
  const redoStack = [];
  let validation = { destinationRevision: null, diff: [], timing: state.timing };
  let pending = false;
  let saving = false;
  let importing = false;
  let discovering = false;
  let previewBusy = false;
  let viewedPreviewKey = null;
  let invalid = false;
  let conflict = false;
  let conflictFreshStateReady = false;
  let transientServerBusy = false;
  let busyExpectedState = null;
  let conflictedCommandCount = 0;
  let lastSnap = null;
  let focusBoundary = null;
  let focusBroll = null;
  let timelineCleanup = null;
  let validationGeneration = 0;
  let importPhase = 'idle';
  let importFilename = '';
  let importProgress = { loaded: 0, total: 0 };
  let importStatusMessage = '';
  let conflictStatusMessage = '';
  let importer = null;
  const previewPositions = new Map();
  const controls = createEditControls();
  document.querySelector('.mode-badge').textContent = 'Редактирование';
  const previewControls = element('section', 'preview-actions');
  previewControls.setAttribute('aria-label', 'Предпросмотр и утверждение');
  const previewHeading = element('h3', '', 'Предпросмотр и утверждение');
  const excerptGroup = element('div', 'preview-actions-row');
  const fullGroup = element('div', 'preview-actions-row');
  const sceneLabel = element('label', 'broll-setting', 'Сцена для фрагмента');
  const excerptScene = element('select');
  excerptScene.setAttribute('aria-label', 'Сцена для фрагмента');
  sceneLabel.append(excerptScene);
  state.brief.scenes.forEach((scene, index) => {
    const option = element('option', '', `Сцена ${index + 1}`);
    option.value = String(index);
    excerptScene.append(option);
  });
  const excerptButton = element('button', 'edit-button', 'Preview фрагмента');
  const fullButton = element('button', 'edit-button', 'Полный preview');
  const viewed = element('input');
  viewed.type = 'checkbox';
  const viewedLabel = element(
    'label',
    'preview-viewed',
    'Я посмотрел полный preview',
  );
  viewedLabel.prepend(viewed);
  const approveButton = element('button', 'edit-button', 'Утвердить');
  const previewStatus = element('p', 'edit-status');
  previewStatus.setAttribute('role', 'status');
  excerptGroup.append(sceneLabel, excerptButton);
  fullGroup.append(fullButton, viewedLabel, approveButton);
  previewControls.append(
    previewHeading,
    excerptGroup,
    fullGroup,
    previewStatus,
  );
  controls.panel.append(previewControls);
  function previewKey() {
    return `${state.session.baseHash}:${state.currentPreview?.generatedAt || ''}`;
  }
  function renderPreviewControls() {
    const locked =
      mutationLocked() ||
      commands.length > 0 ||
      invalid ||
      state.brief.status !== 'draft';
    const full =
      state.currentPreview?.kind === 'full' && !state.currentPreview.stale;
    if (viewedPreviewKey !== previewKey() || commands.length) {
      viewed.checked = false;
      viewedPreviewKey = null;
    }
    excerptScene.disabled = locked;
    excerptButton.disabled = locked;
    fullButton.disabled = locked;
    viewed.disabled = locked || !full;
    approveButton.disabled = locked || !full || !viewed.checked;
    previewStatus.textContent = previewBusy
      ? 'Создаём смонтированный preview…'
      : state.brief.status === 'approved'
        ? 'Утверждено. Финальный рендер запускается отдельно.'
        : commands.length
          ? 'Сначала сохраните изменения.'
          : state.currentPreview?.stale
            ? 'Предыдущий preview устарел. Создайте новый полный preview.'
            : '';
  }
  viewed.addEventListener('change', () => {
    viewedPreviewKey = viewed.checked ? previewKey() : null;
    renderPreviewControls();
  });
  async function previewRequest(kind) {
    if (fullButton.disabled) return;
    previewBusy = true;
    viewed.checked = false;
    viewedPreviewKey = null;
    clearEditError();
    renderAll();
    try {
      const result = await postEdit('/api/broll/preview', token, {
        baseRevision: state.session.baseRevision,
        baseHash: state.session.baseHash,
        manifestHash: state.session.manifestHash,
        kind,
        ...(kind === 'excerpt'
          ? { sceneIndex: Number(excerptScene.value) }
          : {}),
      });
      if (result.response.status !== 202) throw new Error('preview');
      let done = false;
      while (!done) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        const response = await fetch(
          `/api/broll/preview-job?id=${encodeURIComponent(result.data.jobId)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!response.ok) throw new Error('preview');
        const job = await response.json();
        if (job.status === 'failed') {
          // Барьер проверок остановил preview: показываем его причину (без путей, её готовит сервер).
          throw Object.assign(new Error('preview'), {
            reason: job.error === 'PREVIEW_BLOCKED' && typeof job.reason === 'string' ? job.reason : null,
          });
        }
        if (job.status === 'complete') {
          state = prepareBrowserState(job.state, token);
          validation = {
            destinationRevision: null,
            diff: [],
            timing: state.timing,
          };
          done = true;
        }
      }
    } catch (error) {
      showEditError(
        error?.reason
          ? error.reason.startsWith('машина занята')
            ? `Машина занята другой задачей (${error.reason}). Повторите preview позже.`
            : `Preview не опубликован: ${error.reason}. Предыдущий файл сохранён; исправьте и повторите.`
          : 'Preview не готов. Предыдущий файл сохранён; обновите состояние и повторите.',
      );
    } finally {
      previewBusy = false;
      renderAll();
    }
  }
  excerptButton.addEventListener('click', () => {
    void previewRequest('excerpt');
  });
  fullButton.addEventListener('click', () => {
    void previewRequest('full');
  });
  approveButton.addEventListener('click', async () => {
    if (approveButton.disabled) return;
    previewBusy = true;
    renderAll();
    try {
      const result = await postEdit('/api/broll/approve', token, {
        baseRevision: state.session.baseRevision,
        baseHash: state.session.baseHash,
        manifestHash: state.session.manifestHash,
        confirmPreviewViewed: true,
      });
      if (result.response.status !== 201) throw new Error('approval');
      state = prepareBrowserState(result.data.state, token);
      clearEditError();
    } catch (_) {
      showEditError(
        'Утверждение не выполнено. Проверьте текущую ревизию и полный preview.',
      );
    } finally {
      previewBusy = false;
      renderAll();
    }
  });


  const discovery = createBrollDiscoveryUI({
    getState: () => state,
    mediaUrl: (pathname) => authenticatedMediaUrl(pathname, token),
    queueCommand: dispatch,
    setBusy: (busy) => { discovering = busy; renderAll(); },
    request: async (pathname, payload) => {
      const response = await fetch(pathname, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error('B-roll request failed'), { status: response.status, code: data.error });
      return data;
    },
    refresh: async (latest) => {
      if (!sameSessionIdentity(state, latest)) {
        throw Object.assign(new Error('B-roll state changed'), { status: 409 });
      }
      state = prepareBrowserState(latest, token);
    },
    reportError: async () => classifyMutation409({ expectedState: sessionIdentitySnapshot(), generation: ++validationGeneration }),
  });

  function mutationLocked() {
    return pending || saving || importing || discovering || previewBusy || conflict || transientServerBusy;
  }

  function allControlsLocked() {
    return mutationLocked();
  }

  function showEditError(message) {
    controls.error.textContent = message;
    controls.error.hidden = false;
  }

  function clearEditError() {
    controls.error.textContent = '';
    controls.error.hidden = true;
  }

  function selectedMediaForScene(index) {
    const original = state.brief.scenes[index]?.brollMedia;
    let selected = original ? structuredClone(original) : null;
    for (const command of commands) {
      if (command.sceneIndex !== index) continue;
      if (command.type === 'replace-broll') {
        const asset = state.assets.find((candidate) => candidate.id === command.assetId);
        selected = asset?.mediaKind === 'video'
          ? { kind: 'video', assetId: command.assetId, trimStartSec: 0, fit: 'contain', audioMode: 'mute' }
          : { kind: 'image', assetId: command.assetId, fit: 'cover' };
      } else if (selected && command.type === 'set-broll-fit') {
        selected.fit = command.fit;
      } else if (selected?.kind === 'video' && command.type === 'set-broll-video-start') {
        selected.trimStartSec = Math.round(command.trimStartSec * state.output.fps) / state.output.fps;
      } else if (selected?.kind === 'video' && command.type === 'set-broll-audio-mode') {
        selected.audioMode = command.audioMode;
      }
    }
    const serverStart = validation.diff.find((change) => (
      change.scene === index && change.kind === 'clip-start'
    ));
    if (selected?.kind === 'video' && serverStart) selected.trimStartSec = serverStart.to;
    return selected;
  }

  function sceneTimesForIndex(index) {
    const scene = state.brief.scenes[index];
    const previous = validation.diff.find((change) => (
      change.kind === 'boundary' && change.leftScene === index - 1
    ));
    const next = validation.diff.find((change) => (
      change.kind === 'boundary' && change.leftScene === index
    ));
    return {
      start: previous ? previous.to : scene.start,
      end: next ? next.to : scene.end,
    };
  }

  function previewPositionKey(sceneIndex, assetId) {
    return `${sceneIndex}:${assetId}`;
  }

  function capturePreviewPositions() {
    controls.broll.querySelectorAll('video[data-broll-video]').forEach((preview) => {
      const scene = preview.closest('[data-broll-scene]');
      const assetId = scene?.querySelector('[data-broll-select]')?.value;
      const sceneIndex = Number(scene?.dataset.brollScene);
      if (Number.isInteger(sceneIndex) && assetId && Number.isFinite(preview.currentTime)) {
        previewPositions.set(previewPositionKey(sceneIndex, assetId), preview.currentTime);
      }
    });
  }

  function option(value, label) {
    const result = element('option', '', label);
    result.value = value;
    return result;
  }

  function labeledSelect(labelText, dataName, values, value, disabled) {
    const label = element('label', 'broll-setting');
    label.append(element('span', '', labelText));
    const select = element('select', 'broll-select');
    select.dataset[dataName] = '';
    values.forEach(([optionValue, optionLabel]) => select.append(option(optionValue, optionLabel)));
    select.value = value;
    select.disabled = disabled;
    label.append(select);
    return { label, select };
  }

  function renderSelectedMediaControls(wrapper, index, selected, asset) {
    if (!selected || !asset) return;
    const settings = element('div', 'broll-settings');
    const fit = labeledSelect('Положение', 'brollFit', [
      ['contain', 'Вписать целиком'],
      ['cover', 'Заполнить кадр'],
    ], selected.fit, allControlsLocked());
    fit.select.addEventListener('change', () => {
      if (mutationLocked()) return;
      focusBroll = { sceneIndex: index, control: 'fit' };
      dispatch({ type: 'set-broll-fit', sceneIndex: index, fit: fit.select.value });
    });
    settings.append(fit.label);

    if (selected.kind === 'video' && asset.previewMediaUrl) {
      const preview = element('video', 'broll-video');
      preview.dataset.brollVideo = '';
      preview.src = asset.previewMediaUrl;
      preview.controls = true;
      preview.preload = 'metadata';
      preview.setAttribute('aria-label', `Предпросмотр ${asset.label}`);
      const positionKey = previewPositionKey(index, selected.assetId);
      const restorePreviewPosition = () => {
        const seconds = previewPositions.get(positionKey);
        if (!Number.isFinite(seconds) || seconds < 0) return;
        const maximum = Number.isFinite(preview.duration) && preview.duration > 0
          ? Math.max(0, preview.duration - 0.001)
          : seconds;
        preview.currentTime = Math.min(seconds, maximum);
      };
      preview.addEventListener('loadedmetadata', restorePreviewPosition, { once: true });
      preview.addEventListener('timeupdate', () => {
        if (Number.isFinite(preview.currentTime)) previewPositions.set(positionKey, preview.currentTime);
      });
      if (preview.readyState >= 1) restorePreviewPosition();
      const startRow = element('div', 'broll-start-row');
      const start = element('output', 'broll-start', formatTime(selected.trimStartSec, true));
      start.dataset.brollStart = '';
      const sceneTimes = sceneTimesForIndex(index);
      const usedStart = selected.trimStartSec;
      const usedEnd = usedStart + Math.max(0, sceneTimes.end - sceneTimes.start);
      const usedInterval = element(
        'output',
        'broll-used-interval',
        `Используется: ${formatTime(usedStart, true)}–${formatTime(usedEnd, true)}`,
      );
      usedInterval.dataset.brollUsedInterval = '';
      usedInterval.setAttribute('aria-live', 'polite');
      const useCurrent = element('button', 'edit-button', 'Начать с текущего места');
      useCurrent.type = 'button';
      useCurrent.disabled = allControlsLocked();
      useCurrent.addEventListener('click', () => {
        if (mutationLocked() || !Number.isFinite(preview.currentTime)) return;
        previewPositions.set(positionKey, preview.currentTime);
        focusBroll = { sceneIndex: index, control: 'start' };
        dispatch({
          type: 'set-broll-video-start',
          sceneIndex: index,
          trimStartSec: preview.currentTime,
        });
      });
      startRow.append(start, useCurrent);

      const audio = labeledSelect('Звук', 'brollAudio', [
        ['mute', 'Без звука'],
        ['mix', 'Тихо поверх голоса'],
        ['replace', 'Вместо голоса'],
      ], selected.audioMode, allControlsLocked());
      if (asset.hasAudio !== true) {
        audio.select.querySelector('option[value="mix"]').disabled = true;
        audio.select.querySelector('option[value="replace"]').disabled = true;
        audio.select.value = 'mute';
      }
      audio.select.addEventListener('change', () => {
        if (mutationLocked()) return;
        focusBroll = { sceneIndex: index, control: 'audio' };
        dispatch({
          type: 'set-broll-audio-mode',
          sceneIndex: index,
          audioMode: audio.select.value,
        });
      });
      settings.prepend(preview, usedInterval, startRow);
      settings.append(audio.label);
    }
    wrapper.append(settings);
  }

  function renderBrollControls() {
    capturePreviewPositions();
    controls.broll.replaceChildren();
    const assets = state.assets.filter((asset) => (
      /^asset-[1-9]\d*$/.test(asset.id)
      && (asset.capabilities?.brollImage === true || asset.capabilities?.brollVideo === true)
    ));
    const eligible = state.brief.scenes
      .map((scene, index) => ({ scene, index }))
      .filter(({ scene }) => scene.scene === 'broll');
    if (eligible.length === 0) {
      controls.broll.append(element('p', 'broll-empty', 'Подходящих сцен нет'));
      return;
    }
    eligible.forEach(({ index, scene }) => {
      const wrapper = element('div', 'broll-field');
      wrapper.dataset.brollScene = String(index);
      const label = element('label', 'broll-asset-label');
      label.append(element('span', '', `Сцена ${index + 1}`));
      const select = element('select', 'broll-select');
      select.dataset.brollSelect = '';
      select.dataset.sceneIndex = String(index);
      const placeholder = option('', 'Выберите медиа');
      placeholder.disabled = true;
      select.append(placeholder);
      assets.forEach((asset) => select.append(option(asset.id, asset.label)));
      const selected = selectedMediaForScene(index);
      select.value = selected?.assetId || '';
      select.disabled = allControlsLocked();
      select.addEventListener('change', () => {
        if (mutationLocked()) return;
        if (!/^asset-[1-9]\d*$/.test(select.value)) return;
        focusBroll = { sceneIndex: index, control: 'asset' };
        dispatch({ type: 'replace-broll', sceneIndex: index, assetId: select.value });
      });
      label.append(select);
      wrapper.append(label);
      const asset = selected
        ? state.assets.find((candidate) => candidate.id === selected.assetId)
        : null;
      renderSelectedMediaControls(wrapper, index, selected, asset);
      const projectedScene = structuredClone(scene);
      let acknowledged = scene.brollReview === true;
      for (const command of commands) {
        if (command.sceneIndex !== index) continue;
        if (command.type === 'set-broll-query' && projectedScene.brollIntent) {
          projectedScene.brollIntent.queryOriginal = command.queryOriginal;
          projectedScene.brollIntent.queryEnglish = command.queryEnglish;
        }
        if (command.type === 'replace-broll') acknowledged = false;
        if (command.type === 'allow-broll-text') acknowledged = command.allowEmbeddedText;
      }
      wrapper.append(discovery.render({ index, scene: projectedScene, locked: allControlsLocked(), asset, acknowledged }));
      controls.broll.append(wrapper);
    });
    if (focusBroll && !allControlsLocked()) {
      const scene = controls.broll.querySelector(`[data-broll-scene="${focusBroll.sceneIndex}"]`);
      const selectors = {
        asset: '[data-broll-select]',
        fit: '[data-broll-fit]',
        start: '.broll-start-row button',
        audio: '[data-broll-audio]',
      };
      scene?.querySelector(selectors[focusBroll.control])?.focus({ preventScroll: true });
      focusBroll = null;
    }
  }

  function renderEditChrome() {
    const count = commands.length;
    controls.panel.setAttribute('aria-busy', pending || saving || importing ? 'true' : 'false');
    controls.status.textContent = conflict
      ? `Ожидают решения устаревшие правки: ${conflictedCommandCount}`
      : pending
        ? 'Проверяем изменения…'
      : count === 0 ? 'Изменений нет' : `Изменений: ${count}`;
    controls.undo.disabled = count === 0 || allControlsLocked();
    controls.redo.disabled = redoStack.length === 0 || allControlsLocked();
    controls.save.disabled = allControlsLocked() || invalid
      || !validation || validation.diff.length === 0;
    controls.conflict.hidden = !conflict;
    controls.conflict.textContent = conflict
      ? conflictStatusMessage || (conflictFreshStateReady
        ? `Конфликт ревизий: загружена последняя версия. Устаревшие правки (${conflictedCommandCount}) не будут применены. Отбросьте их явно, чтобы продолжить с новой версии.`
        : pending
          ? `Конфликт ревизий: устаревшие правки (${conflictedCommandCount}) не будут применены. Загружается последняя версия; продолжение пока заблокировано.`
          : `Конфликт ревизий: устаревшие правки (${conflictedCommandCount}) не будут применены. Последнюю версию загрузить не удалось; продолжение заблокировано.`)
      : '';
    controls.discardConflict.hidden = !conflict;
    controls.discardConflict.disabled = !conflict || !conflictFreshStateReady || pending || saving || importing;
    controls.transientBusy.hidden = !transientServerBusy;
    controls.transientBusy.textContent = transientServerBusy
      ? 'Другой файл ещё обрабатывается. Правки сохранены и временно заблокированы.'
      : '';
    controls.retryBusy.hidden = !transientServerBusy;
    controls.retryBusy.disabled = !transientServerBusy || pending || saving || importing;
    controls.importButton.disabled = allControlsLocked() || importer?.busy() === true;
    controls.mediaInput.disabled = allControlsLocked() || importer?.busy() === true;
    controls.abortImport.hidden = !importing;
    controls.abortImport.disabled = !importing;
    controls.importStatus.dataset.phase = importPhase;
    const progressActive = importPhase === 'uploading' || importPhase === 'processing';
    controls.importProgress.hidden = !progressActive;
    const total = Math.max(importProgress.total, 0);
    const percent = total > 0 ? Math.min(100, Math.round((importProgress.loaded / total) * 100)) : 0;
    if (importPhase === 'uploading') {
      controls.importProgress.value = percent;
      controls.importStatus.textContent = (
        `Загрузка ${importFilename} · ${formatBytes(importProgress.loaded)} / ${formatBytes(total)} · ${percent}%`
      );
    } else if (importPhase === 'processing') {
      controls.importProgress.removeAttribute('value');
      controls.importStatus.textContent = `Проверяем и готовим предпросмотр… ${importFilename}`;
    } else if (importPhase === 'success') {
      controls.importProgress.removeAttribute('value');
      controls.importStatus.textContent = `Добавлено: ${importFilename}`;
    } else if (importPhase === 'aborted') {
      controls.importProgress.removeAttribute('value');
      controls.importStatus.textContent = `Загрузка отменена: ${importFilename}`;
    } else if (importPhase === 'error') {
      controls.importProgress.removeAttribute('value');
      controls.importStatus.textContent = importStatusMessage || `Не удалось добавить: ${importFilename}`;
    } else if (importPhase === 'committed-refresh-error') {
      controls.importProgress.removeAttribute('value');
      controls.importStatus.textContent = importStatusMessage;
    } else {
      controls.importProgress.removeAttribute('value');
      controls.importStatus.textContent = 'Можно добавить изображение или видео';
    }
    controls.diff.replaceChildren();
    if (validation.diff.length === 0) {
      controls.diff.append(element('li', 'edit-diff-empty', 'Проверенных изменений нет'));
    } else {
      validation.diff.forEach((change) => {
        controls.diff.append(element('li', '', diffLine(change, state)));
      });
    }
    renderBrollControls();
  }

  function renderAll() {
    renderMetadata(state, token);
    renderDiagnostics(validation.timing);
    if (timelineCleanup) timelineCleanup();
    timelineCleanup = renderTimeline({
      root: document.querySelector('[data-timeline-root]'),
      video: document.querySelector('video[data-source-video]'),
      state,
      timecode: document.querySelector('[data-timecode]'),
      diff: validation.diff,
      edit: {
        lastSnap,
        invalidSceneIndexes: validation.timing.errors
          .map((entry) => entry.sceneIndex)
          .filter(Number.isInteger),
        locked: allControlsLocked(),
        focusBoundary,
        onBoundaryFocus: (index) => { focusBoundary = index; },
        onBoundaryChange: dispatch,
      },
    });
    renderEditChrome();
    renderPreviewControls();
    document.querySelector('main').dataset.reviewReady = '';
  }

  function sameSessionIdentity(left, right) {
    return left?.session?.baseRevision === right?.session?.baseRevision
      && left?.session?.baseHash === right?.session?.baseHash
      && left?.session?.manifestHash === right?.session?.manifestHash;
  }

  function sessionIdentitySnapshot() {
    return { session: { ...state.session } };
  }

  function captureMutationState() {
    return {
      commands: commands.slice(),
      redoStack: redoStack.slice(),
      validation,
      invalid,
      lastSnap,
      focusBoundary,
      focusBroll,
    };
  }

  function restoreMutationState(snapshot) {
    if (!snapshot) return;
    commands.splice(0, commands.length, ...snapshot.commands);
    redoStack.splice(0, redoStack.length, ...snapshot.redoStack);
    validation = snapshot.validation;
    invalid = snapshot.invalid;
    lastSnap = snapshot.lastSnap;
    focusBoundary = snapshot.focusBoundary;
    focusBroll = snapshot.focusBroll;
  }

  function enterConfirmedConflict(latest) {
    conflictedCommandCount = commands.length + redoStack.length;
    commands.length = 0;
    redoStack.length = 0;
    state = prepareBrowserState(latest, token);
    validation = { destinationRevision: null, diff: [], timing: state.timing };
    pending = false;
    saving = false;
    invalid = false;
    conflict = true;
    conflictFreshStateReady = true;
    conflictStatusMessage = '';
    transientServerBusy = false;
    busyExpectedState = null;
    lastSnap = null;
    focusBoundary = null;
    focusBroll = null;
    clearEditError();
  }

  async function classifyMutation409({
    expectedState,
    generation,
    rollbackSnapshot = null,
    source = 'mutation',
  }) {
    if (generation !== validationGeneration) return 'superseded';
    conflictedCommandCount = commands.length + redoStack.length;
    pending = true;
    saving = false;
    conflict = true;
    conflictFreshStateReady = false;
    conflictStatusMessage = '';
    transientServerBusy = false;
    busyExpectedState = null;
    clearEditError();
    renderAll();

    let latest;
    try {
      latest = await loadState(token);
    } catch (_) {
      if (generation !== validationGeneration) return 'superseded';
      restoreMutationState(rollbackSnapshot);
      conflictedCommandCount = commands.length + redoStack.length;
      pending = false;
      saving = false;
      invalid = true;
      conflict = true;
      conflictFreshStateReady = false;
      conflictStatusMessage = `Статус устаревших правок не подтверждён: правки (${conflictedCommandCount}) сохранены в карантине и не будут применены до безопасного обновления.`;
      transientServerBusy = false;
      busyExpectedState = null;
      lastSnap = null;
      focusBoundary = null;
      focusBroll = null;
      showEditError('Не удалось загрузить последнюю ревизию и проверить актуальность проекта. Обновите страницу перед продолжением.');
      renderAll();
      return 'unverified';
    }
    if (generation !== validationGeneration) return 'superseded';
    if (!sameSessionIdentity(expectedState, latest)) {
      enterConfirmedConflict(latest);
      renderAll();
      return 'conflict';
    }

    restoreMutationState(rollbackSnapshot);
    state = prepareBrowserState(latest, token);
    pending = false;
    saving = false;
    conflict = false;
    conflictFreshStateReady = false;
    conflictStatusMessage = '';
    conflictedCommandCount = 0;
    transientServerBusy = true;
    busyExpectedState = { session: { ...latest.session } };
    if (source === 'import') {
      importStatusMessage = 'Другой файл ещё обрабатывается. Повторите проверку чуть позже.';
    }
    showEditError('Другой файл ещё обрабатывается. Правки сохранены; повторите проверку чуть позже.');
    renderAll();
    return 'busy';
  }

  async function refreshAfterImport() {
    const latest = await loadState(token);
    if (!sameSessionIdentity(state, latest)) {
      enterConfirmedConflict(latest);
      return;
    }
    state = prepareBrowserState(latest, token);
  }

  function importFailureMessage(status) {
    if (status === 413) return 'Файл превышает допустимый размер.';
    if (status === 415) return 'Этот формат файла не поддерживается.';
    if (status === 422) return 'Файл не удалось прочитать как изображение или видео.';
    if (status === 507) return 'На диске недостаточно места для обработки файла.';
    return 'Не удалось добавить медиа. Текущие правки сохранены в памяти.';
  }

  async function startImport(file) {
    if (!(file instanceof File) || pending || mutationLocked() || importer.busy()) return;
    const expectedState = sessionIdentitySnapshot();
    importing = true;
    importPhase = 'uploading';
    importFilename = file.name;
    importProgress = { loaded: 0, total: file.size };
    importStatusMessage = '';
    focusBroll = null;
    clearEditError();
    renderAll();
    try {
      await importer.importFile(file);
      importPhase = conflict ? 'error' : 'success';
    } catch (error) {
      if (error?.code === 'MEDIA_IMPORT_COMMITTED_REFRESH_ERROR') {
        importPhase = 'committed-refresh-error';
        importStatusMessage = 'Файл добавлен, но экран не обновился. Перезагрузите страницу.';
        showEditError(importStatusMessage);
      } else if (error?.status === 409) {
        importPhase = 'error';
        await classifyMutation409({
          expectedState,
          generation: ++validationGeneration,
          source: 'import',
        });
      } else if (error?.code === 'MEDIA_IMPORT_ABORTED') {
        importPhase = 'aborted';
      } else {
        importPhase = 'error';
        showEditError(importFailureMessage(error?.status));
      }
    } finally {
      importing = false;
      controls.mediaInput.value = '';
      renderAll();
    }
  }

  async function validateCommands(snap = null, rollbackSnapshot = null, options = {}) {
    const generation = ++validationGeneration;
    const expectedState = options.expectedState || sessionIdentitySnapshot();
    pending = true;
    saving = false;
    invalid = false;
    conflict = false;
    conflictFreshStateReady = false;
    conflictStatusMessage = '';
    transientServerBusy = false;
    busyExpectedState = null;
    lastSnap = snap;
    clearEditError();
    renderAll();
    let result;
    try {
      result = await postEdit('/api/validate', token, editPayload(state, commands));
    } catch (_) {
      result = null;
    }
    if (generation !== validationGeneration) return;
    if (result && result.response.status === 409) {
      await classifyMutation409({
        expectedState,
        generation,
        rollbackSnapshot,
        source: 'validate',
      });
      return;
    }
    if (!result || !result.response.ok || !validValidation(result.data)) {
      if (options.retryingBusy) {
        restoreMutationState(rollbackSnapshot);
        pending = false;
        transientServerBusy = true;
        busyExpectedState = expectedState;
        showEditError('Не удалось повторить проверку. Правки заблокированы; попробуйте ещё раз.');
        renderAll();
        return;
      }
      pending = false;
      invalid = true;
      lastSnap = null;
      showEditError('Не удалось проверить изменения. Отмените последнее действие.');
      renderAll();
      return;
    }
    validation = result.data;
    pending = false;
    transientServerBusy = false;
    busyExpectedState = null;
    if (options.retryingBusy && importStatusMessage) {
      importPhase = 'idle';
      importFilename = '';
      importStatusMessage = '';
    }
    invalid = validation.timing.errors.length > 0;
    if (invalid) showEditError('В тайминге есть ошибка. Исправьте границу перед сохранением.');
    renderAll();
  }

  function dispatch(command, snap = null) {
    if (mutationLocked()) return;
    const rollbackSnapshot = captureMutationState();
    focusBoundary = snap && snap.restoreFocus ? snap.index : null;
    commands.push(command);
    redoStack.length = 0;
    void validateCommands(snap, rollbackSnapshot);
  }

  function undo() {
    if (mutationLocked()) return;
    const rollbackSnapshot = captureMutationState();
    const command = commands.pop();
    if (!command) return;
    redoStack.push(command);
    lastSnap = null;
    focusBoundary = null;
    focusBroll = null;
    void validateCommands(null, rollbackSnapshot);
  }

  function redo() {
    if (mutationLocked()) return;
    const rollbackSnapshot = captureMutationState();
    const command = redoStack.pop();
    if (!command) return;
    commands.push(command);
    lastSnap = null;
    focusBoundary = null;
    focusBroll = null;
    void validateCommands(null, rollbackSnapshot);
  }

  function retryBusyValidation() {
    if (!transientServerBusy || pending || saving || importing || !busyExpectedState) return;
    const rollbackSnapshot = captureMutationState();
    const expectedState = busyExpectedState;
    void validateCommands(null, rollbackSnapshot, { retryingBusy: true, expectedState });
  }

  function discardConflictAndContinue() {
    if (!conflict || !conflictFreshStateReady || pending || saving || importing) return;
    validationGeneration += 1;
    conflict = false;
    conflictFreshStateReady = false;
    conflictStatusMessage = '';
    transientServerBusy = false;
    busyExpectedState = null;
    conflictedCommandCount = 0;
    invalid = false;
    lastSnap = null;
    focusBoundary = null;
    focusBroll = null;
    clearEditError();
    renderAll();
  }

  async function save() {
    if (controls.save.disabled) return;
    const lines = validation.diff.map((change) => diffLine(change, state));
    const destination = revisionLabel(validation.destinationRevision);
    const accepted = window.confirm(
      `Будет создана ревизия ${destination}:\n\n${lines.map((line) => `• ${line}`).join('\n')}`,
    );
    if (!accepted) return;
    const rollbackSnapshot = captureMutationState();
    const expectedState = sessionIdentitySnapshot();
    const generation = ++validationGeneration;
    const payload = editPayload(state, commands);
    saving = true;
    focusBoundary = null;
    focusBroll = null;
    clearEditError();
    renderAll();
    let result;
    try {
      result = await postEdit('/api/save', token, payload);
    } catch (_) {
      result = null;
    }
    if (generation !== validationGeneration) return;
    if (result && result.response.status === 409) {
      await classifyMutation409({
        expectedState,
        generation,
        rollbackSnapshot,
        source: 'save',
      });
      return;
    }
    if (!result || result.response.status !== 201) {
      saving = false;
      invalid = true;
      showEditError('Не удалось сохранить новую ревизию. Изменения остались в памяти.');
      renderAll();
      return;
    }
    let latest;
    try {
      latest = await loadState(token);
    } catch (_) {
      saving = false;
      invalid = true;
      showEditError('Ревизия сохранена, но не удалось обновить экран. Перезапустите проверку.');
      renderAll();
      return;
    }
    state = prepareBrowserState(latest, token);
    commands.length = 0;
    redoStack.length = 0;
    validation = { destinationRevision: null, diff: [], timing: state.timing };
    pending = false;
    saving = false;
    invalid = false;
    conflict = false;
    conflictFreshStateReady = false;
    transientServerBusy = false;
    busyExpectedState = null;
    lastSnap = null;
    clearEditError();
    renderAll();
  }

  importer = createMediaImporter({
    endpoint: '/api/assets/import',
    token,
    origin: window.location.origin,
    onPhase: ({ phase, file }) => {
      importPhase = phase;
      importFilename = file.name;
      renderEditChrome();
    },
    onProgress: ({ loaded, total }) => {
      importProgress = { loaded, total };
      renderEditChrome();
    },
    onSuccess: refreshAfterImport,
  });
  controls.importButton.addEventListener('click', () => {
    if (!allControlsLocked() && !importer.busy()) controls.mediaInput.click();
  });
  controls.mediaInput.addEventListener('change', () => {
    const [file] = controls.mediaInput.files;
    if (file) void startImport(file);
  });
  controls.abortImport.addEventListener('click', () => importer.abort());
  controls.undo.addEventListener('click', undo);
  controls.redo.addEventListener('click', redo);
  controls.discardConflict.addEventListener('click', discardConflictAndContinue);
  controls.retryBusy.addEventListener('click', retryBusyValidation);
  controls.save.addEventListener('click', () => { void save(); });
  renderAll();
}

function renderReadOnly(state, token) {
  const browserState = prepareBrowserState(state, token);
  renderMetadata(browserState, token);
  renderDiagnostics(browserState.timing);
  renderTimeline({
    root: document.querySelector('[data-timeline-root]'),
    video: document.querySelector('video[data-source-video]'),
    state: browserState,
    timecode: document.querySelector('[data-timecode]'),
  });
  document.querySelector('main').dataset.reviewReady = '';
}

function showError() {
  document.querySelector('.review-layout').hidden = true;
  document.querySelector('.timeline-panel').hidden = true;
  document.querySelector('[data-error-panel]').hidden = false;
}

const sessionToken = takeSessionToken();
if (!sessionToken) {
  showError();
} else {
  loadState(sessionToken)
    .then((state) => {
      if (state.session.editable) createEditor(state, sessionToken);
      else renderReadOnly(state, sessionToken);
    })
    .catch(showError);
}
