const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const { resolveProjectPath } = require('../project/workspace');
const { ensureDirectory, readJsonIfExists, writeJsonAtomic } = require('./files');

const COMMENT_ID = /^c-[A-Za-z0-9-]{1,40}$/;
const VIDEO_KINDS = new Set(['preview', 'stale-preview', 'final']);
const MAX_TEXT = 1000;
const MAX_TIME_SEC = 24 * 60 * 60;

function commentsPath(projectDir) {
  return path.join(projectDir, 'pult', 'comments.json');
}

// Единственное каноническое имя файла кадра для правки: используется и при записи
// (addComment), и при проверке чтения (isValidComment), и при удалении (deleteComment).
function framePathFor(commentId) {
  return `pult/frames/${commentId}.jpg`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Путь видео из правки печатается агенту в терминал (`automontage inbox`) и адресует файл
// внутри папки ролика. Поэтому в нём нет управляющих символов (ESC, BEL и другие C0/C1),
// он не начинается с `/` или `\` и не содержит сегмента `..`: подменённый comments.json
// не должен ни управлять терминалом, ни указывать за пределы ролика.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

function isSafeVideoPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !CONTROL_CHARS.test(value)
    && !/^[/\\]/.test(value)
    && !value.split(/[/\\]/).includes('..');
}

function isValidVideoRecord(video) {
  return isPlainObject(video)
    && VIDEO_KINDS.has(video.kind)
    && isSafeVideoPath(video.path)
    && (video.sha256 === null || /^[a-f0-9]{64}$/.test(video.sha256));
}

// Проверяет одну запись из уже прочитанного comments.json. Файл могли подменить
// вручную, поэтому читаем его не доверяя форме: неизвестный статус, отрицательное
// время, чужое видео или frame, не совпадающий с каноническим путём для этого id,
// делают весь файл нечитаемым, а не одну запись.
function isValidComment(comment) {
  return isPlainObject(comment)
    && typeof comment.id === 'string' && COMMENT_ID.test(comment.id)
    && (comment.status === 'new' || comment.status === 'accepted')
    && Number.isFinite(comment.timeSec) && comment.timeSec >= 0 && comment.timeSec <= MAX_TIME_SEC
    && typeof comment.text === 'string'
    && typeof comment.createdAt === 'string'
    && isValidVideoRecord(comment.video)
    && (comment.frame === null || comment.frame === framePathFor(comment.id));
}

function readComments(projectDir) {
  const value = readJsonIfExists(commentsPath(projectDir), 'pult/comments.json');
  if (value === undefined) return [];
  if (!value || value.version !== 1 || !Array.isArray(value.comments)) {
    throw new Error('pult/comments.json: неверный формат');
  }
  const seenIds = new Set();
  for (const comment of value.comments) {
    if (!isValidComment(comment) || seenIds.has(comment.id)) {
      throw new Error('pult/comments.json: неверный формат');
    }
    seenIds.add(comment.id);
  }
  return value.comments;
}

function writeComments(projectDir, comments) {
  writeJsonAtomic(commentsPath(projectDir), { version: 1, comments });
}

function countNewComments(projectDir, videoPath = null) {
  try {
    return readComments(projectDir).filter((comment) => comment.status === 'new'
      && (videoPath === null || comment.video.path === videoPath)).length;
  } catch (_) {
    return 0;
  }
}

function validateInput(projectDir, { timeSec, text, video }) {
  if (!Number.isFinite(timeSec) || timeSec < 0 || timeSec > MAX_TIME_SEC) {
    throw new Error('правка: неверное время');
  }
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) throw new Error('правка: пустой текст');
  if (trimmed.length > MAX_TEXT) throw new Error('правка: слишком длинный текст');
  // Та же проверка, что и при чтении: иначе записанная правка сделала бы весь файл
  // правок нечитаемым.
  if (!isValidVideoRecord(video)) throw new Error('правка: неверное видео');
  let videoPath;
  try {
    videoPath = resolveProjectPath(projectDir, video.path, {
      label: 'comment video',
      mustExist: true,
      type: 'file',
    });
  } catch (_) {
    throw new Error('правка: неверное видео');
  }
  return {
    timeSec: Math.round(timeSec * 100) / 100,
    text: trimmed,
    video: { kind: video.kind, path: video.path, sha256: video.sha256 },
    videoPath,
  };
}

function addComment(projectDir, input, {
  now = () => new Date(),
  id = () => `c-${randomBytes(4).toString('hex')}`,
  captureFrame = null,
} = {}) {
  const checked = validateInput(projectDir, input);
  // Ранее чтение: битый comments.json должен упасть до запуска захвата кадра
  // (он может занимать секунды через ffmpeg), а не после.
  const comments = readComments(projectDir);
  const commentId = id();
  if (!COMMENT_ID.test(commentId) || comments.some((comment) => comment.id === commentId)) {
    throw new Error('правка: неверный идентификатор');
  }
  let frame = null;
  if (typeof captureFrame === 'function') {
    // Проверить саму pult до захода в неё mkdir -p: символическая ссылка на pult
    // не должна позволить записать кадр вовне проекта.
    ensureDirectory(path.join(projectDir, 'pult'));
    const framesDir = path.join(projectDir, 'pult', 'frames');
    ensureDirectory(framesDir);
    try {
      if (captureFrame(checked.videoPath, checked.timeSec, path.join(framesDir, `${commentId}.jpg`))) {
        frame = framePathFor(commentId);
      }
    } catch (_) {
      frame = null;
    }
  }
  const comment = {
    id: commentId,
    createdAt: now().toISOString(),
    timeSec: checked.timeSec,
    text: checked.text,
    video: checked.video,
    frame,
    status: 'new',
  };
  // Повторное чтение перед записью: захват кадра мог занять секунды, за которые
  // другой процесс (например `inbox --accept` от агента) мог изменить файл –
  // писать поверх устаревшего списка нельзя.
  const latest = readComments(projectDir);
  if (latest.some((existing) => existing.id === commentId)) {
    throw new Error('правка: неверный идентификатор');
  }
  writeComments(projectDir, [...latest, comment]);
  return comment;
}

function deleteComment(projectDir, commentId) {
  const comments = readComments(projectDir);
  const target = comments.find((comment) => comment.id === commentId);
  if (!target) return false;
  if (target.status !== 'new') throw new Error('правка уже принята агентом');
  writeComments(projectDir, comments.filter((comment) => comment.id !== commentId));
  // Кадр – только кэш: удаляем его лишь если путь в точности совпадает с каноническим
  // именем для этого id (readComments уже это гарантирует, проверка здесь – вторая
  // линия защиты) и только через движковый guard с проверкой символических ссылок.
  // Запись правки уже удалена, поэтому ошибку удаления кадра можно игнорировать.
  if (target.frame === framePathFor(target.id)) {
    try {
      const framePath = resolveProjectPath(projectDir, target.frame, { label: 'comment frame' });
      fs.rmSync(framePath, { force: true });
    } catch (_) {
      // no-op: frame cache cleanup is best-effort
    }
  }
  return true;
}

function acceptComment(projectDir, commentId) {
  const comments = readComments(projectDir);
  const target = comments.find((comment) => comment.id === commentId);
  if (!target) throw new Error(`правка ${commentId} не найдена`);
  const accepted = { ...target, status: 'accepted', acceptedAt: new Date().toISOString() };
  writeComments(projectDir, comments.map((comment) => (comment.id === commentId ? accepted : comment)));
  return accepted;
}

module.exports = {
  COMMENT_ID,
  acceptComment,
  addComment,
  countNewComments,
  deleteComment,
  readComments,
};
