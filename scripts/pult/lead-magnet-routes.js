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
const { buildLeadMagnetIndex, currentPromiseFor, folderLeadMagnet, magnetSummary } = require('./lead-magnet-view');
const { isSafeName } = require('./names');
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

function hasCreateParamsShape(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  const { design } = params;
  return Boolean(design && typeof design === 'object' && !Array.isArray(design)
    && Array.isArray(design.references)
    && design.references.every((reference) => reference && typeof reference === 'object' && !Array.isArray(reference)));
}

const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  'sandbox allow-scripts',
].join('; ');

// Выполняется ВНУТРИ страницы лид-магнита (в песочнице, без доступа к пульту). Сервер
// добавляет его при выдаче, в файл ревизии он не пишется.
function reviewScript(pultOrigin) {
  let reviewing = false;
  const style = document.createElement('style');
  style.textContent = '[data-lm-review] [data-lm-block]:hover{outline:2px dashed #f5a524;outline-offset:2px;cursor:crosshair}';
  document.head.append(style);
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || !event.data || event.data.type !== 'lm-review') return;
    reviewing = Boolean(event.data.on);
    document.documentElement.toggleAttribute('data-lm-review', reviewing);
  });
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (link && !link.getAttribute('href').startsWith('#')) {
      event.preventDefault();
      window.parent.postMessage({ type: 'lm-link', href: link.href }, pultOrigin);
      return;
    }
    if (!reviewing) return;
    const block = event.target.closest('[data-lm-block]');
    if (!block) return;
    event.preventDefault();
    event.stopPropagation();
    const box = block.getBoundingClientRect();
    window.parent.postMessage({
      type: 'lm-block',
      blockId: block.getAttribute('data-lm-block'),
      rect: { x: Math.max(0, box.left + window.scrollX), y: Math.max(0, box.top + window.scrollY), w: box.width, h: box.height },
    }, pultOrigin);
  }, true);
}

function injectReview(html, pultOrigin) {
  const tag = `<script>(${reviewScript.toString()})(${JSON.stringify(pultOrigin)});</script>`;
  const at = html.toLowerCase().lastIndexOf('</body>');
  return at === -1 ? `${html}${tag}` : `${html.slice(0, at)}${tag}${html.slice(at)}`;
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
        call: { title: resolved.brand.cta.title, buttons: resolved.brand.cta.buttons.map((item) => item.label) },
        socials: resolved.brand.socials.map((item) => item.label),
        source: resolved.source, name: resolved.brand.name, logoRequired: resolved.brand.logoRequired, defaultTake: defaultTake(resolved),
      };
    } catch (_) {
      return { call: { title: '', buttons: [] }, socials: [], source: 'error', name: null, logoRequired: false, defaultTake: { composition: true, colors: true, fonts: true } };
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
      promise: {
        quote: passport.promise.quote, startSec: passport.promise.startSec,
        sourceFolder: isSafeName(passport.promise.sourceFolder) ? passport.promise.sourceFolder : null,
        current: currentPromiseFor(projectsDir, passport),
      },
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
    const lastCall = index.entries.find((item) => item.params.cta?.mode === 'link')?.params.cta;
    return {
      lastLink: lastCall ? { title: lastCall.title, label: lastCall.label, url: lastCall.url } : null,
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
    if (!keys || !exactKeys(body, keys) || (body.type === 'create' && !hasCreateParamsShape(body.params))) throw bad();
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

  // Ролик выбирается ключом из адреса до чтения тела: неизвестный ролик не стоит 30 МБ трафика.
  async function postReference(url, request, response) {
    const entry = findEntry(url.searchParams.get('key'));
    if (!entry) {
      request.resume();
      throw notFound();
    }
    const bytes = await readRawBody(request, MAX_REFERENCE);
    let reference;
    try {
      reference = storeReference(projectDirOf(entry), bytes);
    } catch (error) {
      if (/^референс:/.test(messageOf(error))) throw new PultRequestError(400, 'REFERENCE_INVALID', messageOf(error));
      throw error;
    }
    sendJson(response, 201, { reference });
  }

  // Страница «за стеклом»: без ключа пульта, только по пропуску, привязанному к байтам страницы.
  function handlePage(url, request, response) {
    const head = request.method === 'HEAD';
    if (request.method !== 'GET' && !head) {
      request.resume();
      sendError(response, 405);
      return;
    }
    const id = url.searchParams.get('id') || '';
    const rawRevision = url.searchParams.get('rev') || '';
    const n = /^\d{1,2}$/.test(rawRevision) ? Number(rawRevision) : 0;
    let html;
    try {
      if (!LEAD_MAGNET_ID.test(id) || n < 1) throw new Error('bad page');
      const passport = readLeadMagnet(projectsDir, id);
      const revision = passport.revisions.find((item) => item.n === n);
      if (!revision || revision.status === 'building') throw new Error('bad page');
      const bytes = readChecked(projectsDir, revisionDir(projectsDir, id, n), 'page.html');
      if (!bytes) throw new Error('bad page');
      const sha = createHash('sha256').update(bytes).digest('hex');
      if (!safeTokenEqual(url.searchParams.get('ticket'), pageTicket(id, n, sha))) throw new Error('bad page');
      html = injectReview(bytes.toString('utf8'), getOrigin());
    } catch (_) {
      sendError(response, 404, head);
      return;
    }
    send(response, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP }, head);
  }

  // Путь снимка правки для /media/lm-snapshot или null (тогда 404).
  function snapshotFile(url) {
    const id = url.searchParams.get('id');
    const commentId = url.searchParams.get('comment');
    if (typeof id !== 'string' || !LEAD_MAGNET_ID.test(id) || typeof commentId !== 'string' || !LM_COMMENT_ID.test(commentId)) return null;
    try {
      const comment = readLeadMagnetComments(projectsDir, id).find((item) => item.id === commentId);
      return comment && comment.snapshot ? checkedFile(projectsDir, leadMagnetDir(projectsDir, id), comment.snapshot) : null;
    } catch (_) {
      return null;
    }
  }

  // Снимок места правки – кусок скриншота проверки той же ревизии и того же вида.
  function snapshotBytes(id, n, target) {
    const shot = target.view === 'phone' ? 'qa/phone-390.png' : 'qa/desktop.png';
    let source;
    try {
      source = checkedFile(projectsDir, revisionDir(projectsDir, id, n), shot);
    } catch (_) {
      return null;
    }
    if (!fs.existsSync(source)) return null;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-lm-snapshot-'));
    try {
      const out = path.join(tmp, 'snapshot.png');
      return cropImage(source, target.rect, out, mediaOptions) ? fs.readFileSync(out) : null;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  async function postComment(request, response) {
    const body = await readJsonBody(request);
    if (!exactKeys(body, ['id', 'revision', 'target', 'text'])) throw bad();
    const passport = passportOr404(body.id);
    const { target } = body;
    const published = Number.isInteger(body.revision) && passport.revisions.some((item) => item.n === body.revision && item.status !== 'building');
    const snapshot = published && target && target.kind === 'block' && target.rect ? snapshotBytes(passport.id, body.revision, target) : null;
    let comment;
    try {
      comment = addLeadMagnetComment(projectsDir, passport.id, { revision: body.revision, target, text: body.text, snapshotBytes: snapshot });
    } catch (error) {
      const message = messageOf(error);
      if (/неверный формат/.test(message)) throw broken();
      if (/^правк/.test(message)) throw new PultRequestError(400, 'LM_COMMENT_INVALID', message);
      throw error;
    }
    sendJson(response, 201, { comment: { id: comment.id, status: comment.status } });
  }

  async function postCommentDelete(request, response) {
    const body = await readJsonBody(request);
    if (!exactKeys(body, ['id', 'commentId']) || typeof body.commentId !== 'string' || !LM_COMMENT_ID.test(body.commentId)) throw bad();
    passportOr404(body.id);
    try {
      deleteLeadMagnetComment(projectsDir, body.id, body.commentId);
    } catch (error) {
      const message = messageOf(error);
      if (/принят/.test(message)) throw new PultRequestError(409, 'COMMENT_ACCEPTED', 'Правка уже принята агентом');
      if (/не найдена/.test(message)) throw notFound();
      throw broken();
    }
    sendJson(response, 200, { deleted: true });
  }

  // Утверждение – только по пропуску той ревизии, которую показала страница, и только после
  // галочки. Пропуск выдаётся лишь для зелёной ревизии в статусе «посмотрите и утвердите».
  async function postApprove(request, response) {
    const body = await readJsonBody(request);
    if (!exactKeys(body, ['id', 'ticket', 'confirmViewed'])) throw bad();
    if (body.confirmViewed !== true) {
      throw new PultRequestError(400, 'CONFIRMATION_REQUIRED', 'Отметьте, что посмотрели страницу и тексты');
    }
    const passport = passportOr404(body.id);
    const n = passport.current;
    if (n === null) throw changed();
    const readiness = revisionReadiness(projectsDir, passport, n);
    const expected = readiness.pageSha256 ? approvalTicket(passport.id, n, readiness.pageSha256) : null;
    if (!expected || !safeTokenEqual(body.ticket, expected)) throw changed();
    // A ticket binds the page, but its source promise may have changed since GET.
    const eligibility = magnetSummary(projectsDir, passport);
    if (eligibility.error || eligibility.promiseChanged) throw changed();
    try {
      approveLeadMagnet(projectsDir, passport.id, { revision: n, expectedPageSha256: readiness.pageSha256, confirmViewed: true });
    } catch (error) {
      const code = error && error.code;
      if (code === 'REVISION_CHANGED' || code === 'PAGE_CHANGED') throw changed();
      if (code === 'CHECK_FAILED') throw new PultRequestError(422, 'LM_CHECK_FAILED', 'Проверка каркаса или фактов не пройдена – агент исправит');
      if (code === 'PENDING_COMMENTS') throw new PultRequestError(409, 'LM_PENDING_COMMENTS', 'Есть правки, которые ждут агента');
      logger.error(`Пульт: лид-магнит не утверждён (${errorName(error)})`);
      throw error;
    }
    sendJson(response, 201, { ok: true });
  }

  async function postReveal(request, response) {
    const body = await readJsonBody(request);
    if (!exactKeys(body, ['id', 'file']) || !REVEAL_FILES.includes(body.file)) throw bad();
    const passport = passportOr404(body.id);
    const { revision, list } = filesView(passport);
    if (revision === null || !list.includes(body.file)) throw notFound();
    const target = checkedFile(projectsDir, revisionDir(projectsDir, passport.id, revision), body.file);
    try {
      await revealImpl(target);
    } catch (error) {
      logger.error(`Пульт: не удалось открыть папку лид-магнита (${errorName(error)})`);
      throw new PultRequestError(409, 'REVEAL_FAILED', 'Не удалось открыть папку');
    }
    sendJson(response, 200, { ok: true });
  }

  const POST_ROUTES = new Map([
    ['/api/lead-magnet/approve', (url, request, response) => postApprove(request, response)],
    ['/api/lead-magnet/reveal', (url, request, response) => postReveal(request, response)],

    ['/api/lead-magnet/comment', (url, request, response) => postComment(request, response)],
    ['/api/lead-magnet/comment/delete', (url, request, response) => postCommentDelete(request, response)],

    ['/api/lead-magnet/decision', (url, request, response) => postDecision(request, response)],
    ['/api/lead-magnet/reference', (url, request, response) => postReference(url, request, response)],
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

  return { handleApi, handlePage, snapshotFile, POST_ROUTES, internals: { approvalTicket, pageTicket, passportOr404, sign } };
}

module.exports = { DECISION_KEYS, REVEAL_FILES, createLeadMagnetRoutes, exactKeys };
