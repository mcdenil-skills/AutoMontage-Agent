const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, createHmac, randomBytes } = require('node:crypto');

const { approveLeadMagnet } = require('../lead-magnet/approve');
const { defaultTake, resolveBrand } = require('../lead-magnet/brand');
const { checkedFile, readChecked } = require('../lead-magnet/check');
const { addLeadMagnetComment, deleteLeadMagnetComment, readLeadMagnetComments } = require('../lead-magnet/comments');
const { LEAD_MAGNET_ID, LM_COMMENT_ID, TEXT_FILES, TEXT_LIMITS } = require('../lead-magnet/constants');
const { readFacts } = require('../lead-magnet/facts');
const { readFunnelState } = require('../lead-magnet/funnel');
const { leadMagnetDir, readLeadMagnet, revisionDir } = require('../lead-magnet/library');
const { revisionReadiness } = require('../lead-magnet/readiness');
const { REFERENCE_LIMITS, storeReference } = require('../lead-magnet/references');
const { addDecision } = require('../lead-magnet/requests');
const {
  PultRequestError, readJsonBody, readRawBody, safeTokenEqual, send, sendError, sendJson,
} = require('./http');
const { buildLeadMagnetIndex, folderLeadMagnet } = require('./lead-magnet-view');
const { cropImage } = require('./media-cache');

const DECISION_KEYS = {
  create: ['key', 'type', 'offerId', 'codeWord', 'params'],
  decline: ['key', 'type', 'offerId', 'codeWord'],
  reopen: ['key', 'type', 'offerId', 'codeWord'],
  link: ['key', 'type', 'offerId', 'codeWord', 'leadMagnetId'],
  'promise-refresh': ['key', 'type', 'offerId', 'leadMagnetId'],
  'promise-keep': ['key', 'type', 'offerId', 'leadMagnetId'],
  'funnel-check': ['key', 'type', 'leadMagnetId'],
};
const REVEAL_FILES = ['page.html', 'page.pdf', ...Object.values(TEXT_FILES)];
const MAX_REFERENCE = Math.max(...Object.values(REFERENCE_LIMITS));

const bad = () => new PultRequestError(400, 'INVALID_REQUEST', 'Неверный запрос');
const notFound = () => new PultRequestError(404, 'NOT_FOUND', 'Не найдено');
const changed = () => new PultRequestError(409, 'LM_CHANGED', 'Лид-магнит изменился – посмотрите новую версию');
const broken = () => new PultRequestError(409, 'LM_BROKEN', 'Файл лид-магнита повреждён – попросите агента проверить');
const messageOf = (error) => (error && typeof error.message === 'string' ? error.message : '');

function exactKeys(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const actual = Object.keys(body);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function createLeadMagnetRoutes({
  projectsDir, getOrigin, findEntry, projectDirOf, mediaOptions = {}, revealImpl, logger, errorName, env = process.env,
}) {
  const approvalSecret = randomBytes(32);
  const pageSecret = randomBytes(32);
  const sign = (secret, ...parts) => createHmac('sha256', secret).update(parts.join('\0')).digest('base64url');
  const pageTicket = (id, n, sha) => sign(pageSecret, 'page', id, String(n), sha);
  const approvalTicket = (id, n, sha) => sign(approvalSecret, 'approve', id, String(n), sha);

  function passportOr404(id) {
    if (typeof id !== 'string' || !LEAD_MAGNET_ID.test(id)) throw notFound();
    try {
      return readLeadMagnet(projectsDir, id);
    } catch (error) {
      if (/не найден/.test(messageOf(error))) throw notFound();
      throw broken();
    }
  }

  function brandView() {
    try {
      const resolved = resolveBrand({ env });
      return {
        source: resolved.source, name: resolved.brand.name, logoRequired: resolved.brand.logoRequired, defaultTake: defaultTake(resolved),
      };
    } catch (_) {
      return { source: 'error', name: null, logoRequired: false, defaultTake: { composition: true, colors: true, fonts: true } };
    }
  }

  function filesView(passport) {
    const n = passport.approved ?? passport.current;
    if (n === null) return { revision: null, list: [] };
    const dir = revisionDir(projectsDir, passport.id, n);
    const list = REVEAL_FILES.filter((file) => {
      try {
        return fs.existsSync(checkedFile(projectsDir, dir, file));
      } catch (_) {
        return false;
      }
    });
    return { revision: n, list };
  }

  function revisionView(passport, summary) {
    const n = passport.current;
    if (n === null) return null;
    const dir = revisionDir(projectsDir, passport.id, n);
    const readiness = revisionReadiness(projectsDir, passport, n);
    const texts = passport.params.texts.map((kind) => {
      const bytes = readChecked(projectsDir, dir, TEXT_FILES[kind]);
      const value = bytes ? bytes.toString('utf8') : '';
      return { kind, text: value, length: [...value].length, limit: TEXT_LIMITS[kind] };
    });
    const facts = readFacts(dir, readChecked(projectsDir, dir, 'facts.json'));
    const sha = readiness.pageSha256;
    const revision = passport.revisions.find((item) => item.n === n);
    return {
      n, status: revision.status, ready: readiness.ok, items: readiness.items,
      facts: { ok: facts.ok, message: facts.message, count: facts.items.length },
      texts,
      pageUrl: sha ? `/lm/page?id=${encodeURIComponent(passport.id)}&rev=${n}&ticket=${pageTicket(passport.id, n, sha)}` : null,
      approvalTicket: sha && summary.approvable && readiness.ok ? approvalTicket(passport.id, n, sha) : null,
    };
  }

  function magnetView(passport, summary) {
    let comments = null;
    try { comments = readLeadMagnetComments(projectsDir, passport.id); } catch (_) { comments = null; }
    let funnel = null;
    try { funnel = readFunnelState(projectsDir, passport.id); } catch (_) { funnel = null; }
    return {
      ...summary,
      promise: { quote: passport.promise.quote, startSec: passport.promise.startSec },
      revision: revisionView(passport, summary),
      files: filesView(passport),
      commentsBroken: comments === null,
      comments: (comments || []).map((comment) => ({
        id: comment.id, createdAt: comment.createdAt, revision: comment.revision,
        target: comment.target, text: comment.text, status: comment.status,
        snapshotUrl: comment.snapshot
          ? `/media/lm-snapshot?id=${encodeURIComponent(passport.id)}&comment=${encodeURIComponent(comment.id)}`
          : null,
      })),
      funnel: funnel && {
        provider: funnel.provider, exists: funnel.exists, automationName: funnel.automationName, checkedAt: funnel.checkedAt,
      },
    };
  }

  function stateFor(entry) {
    const index = buildLeadMagnetIndex(projectsDir);
    const view = folderLeadMagnet(projectsDir, entry.folder, index);
    const passports = new Map(index.entries.map((passport) => [passport.id, passport]));
    return {
      brand: brandView(), status: view.status, nextStep: view.nextStep, error: view.error,
      offers: view.offers, pending: view.pending,
      magnets: view.magnets.map((summary) => (summary.error ? summary : magnetView(passports.get(summary.id), summary))),
      library: index.entries
        .filter((passport) => passport.approved !== null)
        .map((passport) => ({
          id: passport.id, title: passport.title, codeWords: passport.codeWords,
          createdAt: passport.createdAt, videos: passport.videos.length,
        })),
    };
  }

  async function postDecision(request, response) {
    const body = await readJsonBody(request);
    const keys = body && typeof body === 'object' ? DECISION_KEYS[body.type] : null;
    if (!keys || !exactKeys(body, keys)) throw bad();
    const entry = findEntry(body.key);
    if (!entry) throw notFound();
    const { key, ...input } = body;
    let decision;
    try {
      decision = addDecision(projectDirOf(entry), input);
    } catch (error) {
      const message = messageOf(error);
      if (/неверный формат|не читается|неверный JSON/.test(message)) throw broken();
      if (/^(лид-магнит|кодовое слово|ссылка на референс)/.test(message)) throw new PultRequestError(400, 'LM_INVALID', message);
      throw error;
    }
    sendJson(response, 201, { decision: { id: decision.id, type: decision.type, status: decision.status } });
  }

  const POST_ROUTES = new Map([
    ['/api/lead-magnet/decision', (url, request, response) => postDecision(request, response)],
  ]);

  async function handleApi(pathname, url, request, response) {
    if (pathname === '/api/lead-magnet' && (request.method === 'GET' || request.method === 'HEAD')) {
      const entry = findEntry(url.searchParams.get('key'));
      if (!entry) throw notFound();
      sendJson(response, 200, stateFor(entry));
      return;
    }
    const handler = request.method === 'POST' ? POST_ROUTES.get(pathname) : null;
    if (!handler) {
      request.resume();
      throw request.method === 'POST' ? notFound() : new PultRequestError(405, 'METHOD_NOT_ALLOWED', 'Метод не поддерживается');
    }
    await handler(url, request, response);
  }

  return { handleApi, POST_ROUTES, internals: { approvalTicket, pageTicket, passportOr404, sign } };
}

module.exports = { DECISION_KEYS, REVEAL_FILES, createLeadMagnetRoutes, exactKeys };
