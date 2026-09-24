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

function readComments(projectDir) {
  const value = readJsonIfExists(commentsPath(projectDir), 'pult/comments.json');
  if (value === undefined) return [];
  if (!value || value.version !== 1 || !Array.isArray(value.comments)) {
    throw new Error('pult/comments.json: неверный формат');
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
  if (!video || !VIDEO_KINDS.has(video.kind) || typeof video.path !== 'string'
    || !(video.sha256 === null || /^[a-f0-9]{64}$/.test(video.sha256))) {
    throw new Error('правка: неверное видео');
  }
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
  const comments = readComments(projectDir);
  const commentId = id();
  if (!COMMENT_ID.test(commentId) || comments.some((comment) => comment.id === commentId)) {
    throw new Error('правка: неверный идентификатор');
  }
  let frame = null;
  if (typeof captureFrame === 'function') {
    const framesDir = path.join(projectDir, 'pult', 'frames');
    ensureDirectory(framesDir);
    try {
      if (captureFrame(checked.videoPath, checked.timeSec, path.join(framesDir, `${commentId}.jpg`))) {
        frame = `pult/frames/${commentId}.jpg`;
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
  writeComments(projectDir, [...comments, comment]);
  return comment;
}

function deleteComment(projectDir, commentId) {
  const comments = readComments(projectDir);
  const target = comments.find((comment) => comment.id === commentId);
  if (!target) return false;
  if (target.status !== 'new') throw new Error('правка уже принята агентом');
  writeComments(projectDir, comments.filter((comment) => comment.id !== commentId));
  if (target.frame) fs.rmSync(path.join(projectDir, ...target.frame.split('/')), { force: true });
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
