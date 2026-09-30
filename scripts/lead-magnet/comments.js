// scripts/lead-magnet/comments.js
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const Ajv = require('ajv');

const schema = require('../../schema/lead-magnet-comments.schema.json');
const { resolveProjectPath } = require('../project/workspace');
const { ensureDirectory, readJsonIfExists, writeJsonAtomic } = require('../pult/files');
const { leadMagnetDir, readLeadMagnet } = require('./library');
const { LIBRARY_DIR } = require('./constants');

const LABEL = 'pult/comments.json лид-магнита';
const MAX_SNAPSHOT = 4 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const validateFile = new Ajv({ allErrors: true }).compile(schema);

function commentsPath(projectsDir, id) {
  leadMagnetDir(projectsDir, id);
  return resolveProjectPath(projectsDir, path.join(LIBRARY_DIR, id, 'pult', 'comments.json'),
    { label: LABEL, type: 'file' });
}

function snapshotPathFor(commentId) {
  return `pult/frames/${commentId}.png`;
}

function framesPath(projectsDir, id) {
  leadMagnetDir(projectsDir, id);
  return resolveProjectPath(projectsDir, path.join(LIBRARY_DIR, id, 'pult', 'frames'),
    { label: 'снимки правок', type: 'directory' });
}

function snapshotFile(projectsDir, id, commentId) {
  leadMagnetDir(projectsDir, id);
  return resolveProjectPath(projectsDir, path.join(LIBRARY_DIR, id, snapshotPathFor(commentId)),
    { label: 'снимок правки', type: 'file' });
}

function readLeadMagnetComments(projectsDir, id) {
  const value = readJsonIfExists(commentsPath(projectsDir, id), LABEL);
  if (value === undefined) return [];
  if (!validateFile(value)) throw new Error(`${LABEL}: неверный формат`);
  const seen = new Set();
  for (const comment of value.comments) {
    if (seen.has(comment.id) || (comment.snapshot !== null && comment.snapshot !== snapshotPathFor(comment.id))) {
      throw new Error(`${LABEL}: неверный формат`);
    }
    seen.add(comment.id);
  }
  return value.comments;
}

function writeComments(projectsDir, id, comments) {
  const value = { version: 1, comments };
  if (!validateFile(value)) throw new Error('правка лид-магнита: неверные данные');
  writeJsonAtomic(commentsPath(projectsDir, id), value);
}

function isPng(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length > PNG_MAGIC.length && bytes.length <= MAX_SNAPSHOT
    && bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
}

function addLeadMagnetComment(projectsDir, id, input, { now = () => new Date(), id: makeId = () => `c-${randomBytes(4).toString('hex')}` } = {}) {
  readLeadMagnet(projectsDir, id);
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  const comment = {
    id: makeId(),
    createdAt: now().toISOString(),
    revision: input.revision,
    target: input.target,
    text,
    snapshot: null,
    status: 'new',
  };
  const comments = readLeadMagnetComments(projectsDir, id);
  const next = [...comments, comment];
  if (comments.some((item) => item.id === comment.id) || !validateFile({ version: 1, comments: next })) {
    throw new Error('правка лид-магнита: неверные данные');
  }
  // Снимок – подсказка агенту «где это». Не PNG или слишком большой – правка остаётся без снимка.
  if (input.target && input.target.kind === 'block' && isPng(input.snapshotBytes)) {
    ensureDirectory(path.dirname(commentsPath(projectsDir, id)));
    const framesDir = framesPath(projectsDir, id);
    ensureDirectory(framesDir);
    fs.writeFileSync(snapshotFile(projectsDir, id, comment.id), input.snapshotBytes,
      { flag: 'wx', mode: 0o644 });
    comment.snapshot = snapshotPathFor(comment.id);
  }
  writeComments(projectsDir, id, next);
  return comment;
}

function deleteLeadMagnetComment(projectsDir, id, commentId) {
  const comments = readLeadMagnetComments(projectsDir, id);
  const comment = comments.find((item) => item.id === commentId);
  if (!comment) throw new Error('правка не найдена');
  if (comment.status !== 'new') throw new Error('принятую агентом правку удалить нельзя');
  const file = comment.snapshot ? snapshotFile(projectsDir, id, comment.id) : null;
  writeComments(projectsDir, id, comments.filter((item) => item.id !== commentId));
  if (file) fs.rmSync(file, { force: true });
}

function acceptLeadMagnetComment(projectsDir, id, commentId, { now = () => new Date() } = {}) {
  const comments = readLeadMagnetComments(projectsDir, id);
  const comment = comments.find((item) => item.id === commentId);
  if (!comment) throw new Error(`правка ${commentId} не найдена`);
  if (comment.status === 'new') {
    comment.status = 'accepted';
    comment.acceptedAt = now().toISOString();
    writeComments(projectsDir, id, comments);
  }
  return comment;
}

function countNewLeadMagnetComments(projectsDir, id, revision = null) {
  return readLeadMagnetComments(projectsDir, id)
    .filter((item) => item.status === 'new' && (revision === null || item.revision === revision)).length;
}

module.exports = {
  acceptLeadMagnetComment,
  addLeadMagnetComment,
  countNewLeadMagnetComments,
  deleteLeadMagnetComment,
  readLeadMagnetComments,
};
