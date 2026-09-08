import { seekPlayer, synchronizePlayer } from './player-sync.js';

const MIN_CANVAS_WIDTH = 720;
const CANVAS_CHROME_WIDTH = 160;
const BASE_PIXELS_PER_SECOND = 20;
const MIN_SCENE_WIDTH = 40;
const MIN_WORD_SPACING = 44;
const WORD_SNAP_WINDOW_SECONDS = 0.12;

function formatTime(seconds, milliseconds = false) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const rest = safe - (minutes * 60);
  const precision = milliseconds ? 3 : 0;
  return `${String(minutes).padStart(2, '0')}:${rest.toFixed(precision).padStart(milliseconds ? 6 : 2, '0')}`;
}

function button(label, className) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.setAttribute('aria-label', label);
  return element;
}

function place(element, start, end, duration) {
  const safeDuration = Math.max(duration, 0.001);
  const left = Math.min(100, Math.max(0, (start / safeDuration) * 100));
  const right = Math.min(100, Math.max(left, (end / safeDuration) * 100));
  element.style.setProperty('--segment-start', `${left}%`);
  element.style.setProperty('--segment-width', `${Math.max(0.001, right - left)}%`);
}

function minimumPositive(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  let minimum = Infinity;
  for (let index = 1; index < sorted.length; index += 1) {
    const difference = sorted[index] - sorted[index - 1];
    if (difference > 0) minimum = Math.min(minimum, difference);
  }
  return minimum;
}

function timelineCanvasWidth(duration, scenes, words) {
  const shortestScene = Math.min(...scenes.map((scene) => scene.end - scene.start));
  const wordGap = minimumPositive(words.map((word) => word.start));
  const pixelsPerSecond = Math.max(
    BASE_PIXELS_PER_SECOND,
    Number.isFinite(shortestScene) ? MIN_SCENE_WIDTH / shortestScene : 0,
    Number.isFinite(wordGap) ? MIN_WORD_SPACING / wordGap : 0,
  );
  return Math.max(
    MIN_CANVAS_WIDTH,
    Math.ceil((Math.max(0, duration) * pixelsPerSecond) + CANVAS_CHROME_WIDTH),
  );
}

function setCurrent(elements, activeIndex) {
  elements.forEach((element, index) => {
    if (index === activeIndex) element.setAttribute('aria-current', 'true');
    else element.removeAttribute('aria-current');
  });
}

function safeWaveformUrl(waveform, video) {
  if (!waveform || waveform.url !== '/media/waveform') return null;
  try {
    const sourceUrl = new URL(video.currentSrc || video.src, window.location.origin);
    if (sourceUrl.origin !== window.location.origin || sourceUrl.pathname !== '/media/source') return null;
    const token = sourceUrl.searchParams.get('token');
    if (!token) return null;
    const waveformUrl = new URL('/media/waveform', window.location.origin);
    waveformUrl.searchParams.set('token', token);
    return `${waveformUrl.pathname}${waveformUrl.search}`;
  } catch (_) {
    return null;
  }
}

function renderSource(track, video, duration, waveform) {
  const target = button('Перейти к началу исходного видео', 'source-segment');
  target.dataset.sourceTarget = '';
  const waveformUrl = safeWaveformUrl(waveform, video);
  if (waveformUrl) {
    const image = document.createElement('img');
    image.dataset.waveformPreview = '';
    image.src = waveformUrl;
    image.alt = '';
    image.setAttribute('aria-hidden', 'true');
    Object.assign(image.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      opacity: '0.28',
      objectFit: 'fill',
      pointerEvents: 'none',
    });
    target.style.overflow = 'hidden';
    target.append(image);
  }
  const label = document.createElement('span');
  label.textContent = 'Исходник';
  const time = document.createElement('span');
  time.textContent = '00:00';
  label.style.position = 'relative';
  time.style.position = 'relative';
  target.append(label, time);
  target.addEventListener('click', () => seekPlayer(video, 0));
  track.append(target);
  place(target, 0, duration, duration);
}

function boundaryChange(diff, index) {
  return diff.find((change) => change.kind === 'boundary' && change.leftScene === index);
}

function sceneTimes(scene, index, diff) {
  const previous = boundaryChange(diff, index - 1);
  const next = boundaryChange(diff, index);
  return {
    start: previous ? previous.to : scene.start,
    end: next ? next.to : scene.end,
  };
}

export function sceneDisplayText(scene) {
  if (!['kinetic-title', 'card', 'steps', 'list', 'counter', 'media', 'cta'].includes(scene.scene)) {
    return scene.caption || scene.headOrange || scene.headCream || scene.scene;
  }
  const fields = [scene.scene, scene.text, scene.title, scene.body, scene.label,
    scene.steps?.join(' → '), scene.items?.join('; '),
    scene.value === undefined ? null : `${scene.prefix || ''}${scene.value}${scene.suffix || ''}`,
    scene.overlayText, scene.action, scene.handle, scene.caption];
  return fields.filter(Boolean).join(' · ');
}

function renderScenes(track, video, scenes, duration, diff) {
  return scenes.map((scene, index) => {
    const times = sceneTimes(scene, index, diff);
    const label = `Сцена ${index + 1}: ${scene.scene}, ${formatTime(times.start)}–${formatTime(times.end)}`;
    const target = button(label, 'scene-segment');
    target.dataset.scene = String(index);
    target.dataset.start = String(times.start);
    target.dataset.end = String(times.end);

    const number = document.createElement('span');
    number.className = 'segment-number';
    number.textContent = String(index + 1).padStart(2, '0');
    const name = document.createElement('span');
    name.className = 'segment-name';
    name.textContent = sceneDisplayText(scene);
    target.title = name.textContent;
    target.append(number, name);
    target.addEventListener('click', () => seekPlayer(video, times.start));
    place(target, times.start, times.end, duration);
    track.append(target);
    return target;
  });
}

function interiorTime(seconds, start, end) {
  const room = end - start;
  const inset = Math.min(0.000001, room / 4);
  return Math.min(end - inset, Math.max(start + inset, seconds));
}

function snapBoundary(seconds, {
  start,
  end,
  fps,
  words,
  allowWordSnap = true,
}) {
  const raw = interiorTime(seconds, start, end);
  const wordCandidates = (allowWordSnap ? words : []).flatMap((word) => [word.start, word.end])
    .filter((value) => Number.isFinite(value)
      && value > start && value < end
      && Math.abs(value - raw) <= WORD_SNAP_WINDOW_SECONDS)
    .sort((left, right) => Math.abs(left - raw) - Math.abs(right - raw));
  if (wordCandidates.length > 0) {
    return { seconds: Number(wordCandidates[0].toFixed(6)), reason: 'word' };
  }

  if (Number.isFinite(fps) && fps > 0) {
    const firstFrame = Math.floor(start * fps) + 1;
    const lastFrame = Math.ceil(end * fps) - 1;
    if (firstFrame <= lastFrame) {
      const frame = Math.min(lastFrame, Math.max(firstFrame, Math.round(raw * fps)));
      return { seconds: Number((frame / fps).toFixed(6)), reason: 'frame' };
    }
  }
  return { seconds: Number(raw.toFixed(6)), reason: 'exact' };
}

function setBoundaryPosition(handle, seconds, duration) {
  const percent = Math.min(100, Math.max(0, (seconds / Math.max(duration, 0.001)) * 100));
  handle.style.setProperty('--boundary-position', `${percent}%`);
  handle.setAttribute('aria-valuenow', String(seconds));
  handle.setAttribute('aria-valuetext', formatTime(seconds, true));
}

function setSnapLabel(handle, reason) {
  const label = handle.querySelector('.boundary-snap-label');
  handle.dataset.snapReason = reason;
  label.textContent = reason === 'word' ? 'слово' : reason === 'frame' ? 'кадр' : 'точно';
}

function renderBoundaries({
  track,
  sceneButtons,
  scenes,
  words,
  fps,
  duration,
  diff,
  onBoundaryChange,
  lastSnap,
  invalidSceneIndexes,
  locked,
  focusBoundary,
  onBoundaryFocus,
}) {
  const cleanups = [];
  const invalidBoundaries = new Set();
  for (const sceneIndex of invalidSceneIndexes || []) {
    if (!Number.isInteger(sceneIndex)) continue;
    if (sceneIndex > 0) invalidBoundaries.add(sceneIndex - 1);
    if (sceneIndex < scenes.length - 1) invalidBoundaries.add(sceneIndex);
  }
  for (let index = 0; index < scenes.length - 1; index += 1) {
    const leftTimes = sceneTimes(scenes[index], index, diff);
    const rightTimes = sceneTimes(scenes[index + 1], index + 1, diff);
    if (leftTimes.end !== rightTimes.start) continue;
    const boundaryRange = {
      start: leftTimes.start,
      end: rightTimes.end,
      fps,
      words: [],
      allowWordSnap: false,
    };
    const minimum = snapBoundary(leftTimes.start, boundaryRange).seconds;
    const maximum = snapBoundary(rightTimes.end, boundaryRange).seconds;
    const handle = button(`Граница сцен ${index + 1} и ${index + 2}`, 'boundary-handle');
    handle.dataset.boundary = String(index);
    handle.setAttribute('role', 'slider');
    handle.setAttribute('aria-valuemin', String(minimum));
    handle.setAttribute('aria-valuemax', String(maximum));
    handle.disabled = Boolean(locked);
    handle.dataset.snapReason = lastSnap && lastSnap.index === index ? lastSnap.reason : '';
    if (invalidBoundaries.has(index)) {
      handle.dataset.invalid = 'true';
      handle.setAttribute('aria-invalid', 'true');
    }
    const snapLabel = document.createElement('span');
    snapLabel.className = 'boundary-snap-label';
    snapLabel.textContent = lastSnap && lastSnap.index === index
      ? (lastSnap.reason === 'word' ? 'слово' : lastSnap.reason === 'frame' ? 'кадр' : 'точно')
      : '';
    handle.append(snapLabel);
    setBoundaryPosition(handle, leftTimes.end, duration);
    track.append(handle);

    let dragging = null;
    const restore = () => {
      if (!dragging) return;
      const { left, right, seconds } = dragging;
      left.dataset.end = String(seconds);
      right.dataset.start = String(seconds);
      place(left, Number(left.dataset.start), seconds, duration);
      place(right, seconds, Number(right.dataset.end), duration);
      setBoundaryPosition(handle, seconds, duration);
      dragging = null;
    };
    const move = (event) => {
      if (!dragging) return;
      const bounds = track.getBoundingClientRect();
      const raw = ((event.clientX - bounds.left) / Math.max(bounds.width, 1)) * duration;
      const snapped = snapBoundary(raw, {
        start: dragging.start,
        end: dragging.end,
        fps,
        words,
      });
      dragging.snapped = snapped;
      dragging.left.dataset.end = String(snapped.seconds);
      dragging.right.dataset.start = String(snapped.seconds);
      place(dragging.left, Number(dragging.left.dataset.start), snapped.seconds, duration);
      place(dragging.right, snapped.seconds, Number(dragging.right.dataset.end), duration);
      setBoundaryPosition(handle, snapped.seconds, duration);
      setSnapLabel(handle, snapped.reason);
    };
    const cancel = () => {
      if (!dragging) return;
      restore();
      handle.dataset.snapReason = lastSnap && lastSnap.index === index ? lastSnap.reason : '';
      snapLabel.textContent = lastSnap && lastSnap.index === index
        ? (lastSnap.reason === 'word' ? 'слово' : lastSnap.reason === 'frame' ? 'кадр' : 'точно')
        : '';
    };
    const keyDuringDrag = (event) => {
      if (event.key !== 'Escape' || !dragging) return;
      event.preventDefault();
      cancel();
    };
    const drop = (event) => {
      if (!dragging) return;
      move(event);
      const snapped = dragging.snapped;
      dragging = null;
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      if (snapped) onBoundaryChange({
        type: 'move-boundary',
        leftSceneIndex: index,
        seconds: snapped.seconds,
      }, { index, reason: snapped.reason });
    };
    const pointerDown = (event) => {
      if (locked) return;
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const left = sceneButtons[index];
      const right = sceneButtons[index + 1];
      dragging = {
        left,
        right,
        seconds: Number(left.dataset.end),
        start: Number(left.dataset.start),
        end: Number(right.dataset.end),
        snapped: null,
      };
      handle.setPointerCapture(event.pointerId);
    };
    const keyboardMove = (event) => {
      if (locked) return;
      const supportedKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
      if (!supportedKeys.includes(event.key)) return;
      event.preventDefault();
      const step = Number.isFinite(fps) && fps > 0 ? 1 / fps : 0.001;
      const left = sceneButtons[index];
      const right = sceneButtons[index + 1];
      const direction = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 1;
      const target = event.key === 'Home'
        ? Number(left.dataset.start)
        : event.key === 'End'
          ? Number(right.dataset.end)
          : Number(left.dataset.end) + (direction * step);
      const snapped = snapBoundary(target, {
        start: Number(left.dataset.start),
        end: Number(right.dataset.end),
        fps,
        words,
        allowWordSnap: false,
      });
      left.dataset.end = String(snapped.seconds);
      right.dataset.start = String(snapped.seconds);
      place(left, Number(left.dataset.start), snapped.seconds, duration);
      place(right, snapped.seconds, Number(right.dataset.end), duration);
      setBoundaryPosition(handle, snapped.seconds, duration);
      setSnapLabel(handle, snapped.reason);
      onBoundaryChange({
        type: 'move-boundary',
        leftSceneIndex: index,
        seconds: snapped.seconds,
      }, { index, reason: snapped.reason, restoreFocus: true });
    };
    handle.addEventListener('pointerdown', pointerDown);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', drop);
    handle.addEventListener('pointercancel', cancel);
    handle.addEventListener('keydown', keyboardMove);
    handle.addEventListener('focus', () => onBoundaryFocus(index));
    window.addEventListener('keydown', keyDuringDrag);
    cleanups.push(() => window.removeEventListener('keydown', keyDuringDrag));
    if (!locked && focusBoundary === index) handle.focus({ preventScroll: true });
  }
  return () => cleanups.forEach((cleanup) => cleanup());
}

function renderTranscript(list, video, words, duration) {
  return words.map((word, index) => {
    const item = document.createElement('li');
    place(item, word.start, word.end, duration);
    const target = button(`${word.text}, ${formatTime(word.start, true)}`, 'word-segment');
    target.dataset.transcriptWord = String(index);
    target.textContent = word.text;
    target.addEventListener('click', () => seekPlayer(video, word.start));
    item.append(target);
    list.append(item);
    return target;
  });
}

function renderAssets(list, assets) {
  if (assets.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'asset-empty';
    empty.textContent = 'Дополнительных медиа нет';
    list.append(empty);
    return;
  }
  assets.forEach((asset) => {
    const item = document.createElement('li');
    item.className = 'asset-chip';
    if (asset.mediaKind === 'image' && asset.mediaUrl) {
      const thumbnail = document.createElement('img');
      thumbnail.className = 'asset-thumbnail';
      thumbnail.dataset.assetImage = '';
      thumbnail.src = asset.mediaUrl;
      thumbnail.alt = '';
      item.append(thumbnail);
    } else if (asset.mediaKind === 'video' && asset.previewMediaUrl) {
      const preview = document.createElement('video');
      preview.className = 'asset-video';
      preview.dataset.assetVideo = '';
      preview.src = asset.previewMediaUrl;
      preview.controls = true;
      preview.preload = 'metadata';
      preview.setAttribute('aria-label', `Предпросмотр ${asset.label}`);
      item.append(preview);
    }
    const meta = document.createElement('span');
    meta.className = 'asset-meta';
    const kind = document.createElement('span');
    if (asset.mediaKind === 'video' && Number.isFinite(asset.durationSec)) {
      const dimensions = Number.isFinite(asset.width) && Number.isFinite(asset.height)
        ? `${asset.width}×${asset.height}`
        : 'видео';
      kind.textContent = `${formatTime(asset.durationSec)} · ${dimensions} · ${asset.hasAudio ? 'со звуком' : 'без звука'}`;
    } else {
      kind.textContent = asset.kind === 'project' ? 'проект' : 'библиотека';
    }
    const label = document.createElement('strong');
    label.dataset.assetLabel = '';
    label.textContent = asset.label;
    meta.append(kind, label);
    item.append(meta);
    list.append(item);
  });
}

export function renderTimeline({
  root,
  video,
  state,
  timecode,
  diff = [],
  edit = null,
}) {
  const duration = state.output.durationInFrames / state.output.fps;
  const scenes = state.brief.scenes;
  const words = state.transcript.words;
  const sourceTrack = root.querySelector('[data-source-track]');
  const scenesTrack = root.querySelector('[data-scenes-track]');
  const transcript = root.querySelector('[data-transcript]');
  const assets = root.querySelector('[data-assets]');
  sourceTrack.replaceChildren();
  scenesTrack.replaceChildren();
  transcript.replaceChildren();
  assets.replaceChildren();
  root.querySelector('.timeline-canvas').style.setProperty(
    '--timeline-width',
    `${timelineCanvasWidth(duration, scenes, words)}px`,
  );
  const sceneButtons = renderScenes(
    scenesTrack,
    video,
    scenes,
    duration,
    diff,
  );
  const wordButtons = renderTranscript(
    transcript,
    video,
    words,
    duration,
  );
  renderSource(sourceTrack, video, duration, state.waveform);
  renderAssets(assets, state.assets);
  const removeBoundaryListeners = edit
    ? renderBoundaries({
      track: scenesTrack,
      sceneButtons,
      scenes,
      words,
      fps: state.output.fps,
      duration,
      diff,
      onBoundaryChange: edit.onBoundaryChange,
      lastSnap: edit.lastSnap,
      invalidSceneIndexes: edit.invalidSceneIndexes,
      locked: edit.locked,
      focusBoundary: edit.focusBoundary,
      onBoundaryFocus: edit.onBoundaryFocus,
    })
    : () => {};

  const playbackScenes = scenes.map((scene, index) => sceneTimes(scene, index, diff));

  const stopSynchronizing = synchronizePlayer({
    video,
    playhead: root.querySelector('[data-playhead]'),
    duration,
    scenes: playbackScenes,
    words,
    onPosition: ({ seconds, sceneIndex, wordIndex }) => {
      timecode.textContent = formatTime(seconds, true);
      setCurrent(sceneButtons, sceneIndex);
      setCurrent(wordButtons, wordIndex);
    },
  });
  return () => {
    removeBoundaryListeners();
    stopSynchronizing();
  };
}

export { formatTime };
