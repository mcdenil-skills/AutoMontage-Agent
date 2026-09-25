const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createHmac, randomBytes } = require('node:crypto');

const { approveBrief, createOrOpenProject, resolveProjectPath } = require('../project/workspace');
const { startReviewServer } = require('../review/server');
const { buildCards } = require('./cards');
const { ENTRY_KEY, folderFromKey, scanFolder, scanProjects } = require('./catalog');
const { addComment, deleteComment, readComments } = require('./comments');
const { hashFile } = require('./files');
const {
  PultRequestError,
  hasUnsafePath,
  isServableMedia,
  readJsonBody,
  requestToken,
  safeTokenEqual,
  sendError,
  sendJson,
  sendProblem,
  serveFile,
  serveStatic,
} = require('./http');
const { openPultWindow, revealInFileManager } = require('./launcher');
const { extractFrame, probeMedia, thumbnailFor } = require('./media-cache');
const { isSafeName } = require('./names');
const { readPultState, setArchived } = require('./state');

const IDLE_MS = 30 * 60 * 1000;
const IDLE_CHECK_MS = 60 * 1000;
const COMMENTS_BROKEN_MESSAGE = 'Файл правок повреждён — попросите агента проверить pult/comments.json';
const APPROVAL_BLOCKED_MESSAGE = 'Движок не принял утверждение: черновик ещё не готов. '
  + 'Откройте проверку монтажа или передайте ролик агенту.';

const badRequest = () => new PultRequestError(400, 'INVALID_REQUEST', 'Неверный запрос');
const notFound = () => new PultRequestError(404, 'NOT_FOUND', 'Ролик не найден');
const shuttingDown = () => new PultRequestError(503, 'SHUTTING_DOWN', 'Пульт закрывается');
const previewChanged = () => new PultRequestError(
  409,
  'PREVIEW_CHANGED',
  'Ролик изменился — обновите страницу и посмотрите новую версию',
);
const previewDamaged = () => new PultRequestError(
  409,
  'PREVIEW_DAMAGED',
  'Файл preview не совпадает с паспортом ролика — попросите агента пересобрать preview',
);
const projectBusy = () => new PultRequestError(409, 'PROJECT_BUSY', 'Агент сейчас меняет этот ролик — попробуйте через минуту');
// Код, которым движок помечает занятый или изменившийся во время записи project.json
// (scripts/project/workspace.js, manifestConflict). Движок его не экспортирует.
const ENGINE_MANIFEST_CONFLICT = 'PROJECT_MANIFEST_CONFLICT';

// Для лога — только имя класса ошибки, и то лишь если оно похоже на имя класса:
// сообщение и произвольные поля могут содержать абсолютные пути.
function errorName(error) {
  const name = error && typeof error.name === 'string' ? error.name : '';
  return /^[A-Za-z]{1,40}$/.test(name) ? name : 'Error';
}

// Тело запроса должно содержать ровно эти поля: лишнее поле — признак чужого клиента.
function exactKeys(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const actual = Object.keys(body);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

// Браузеру показываем только относительную подпись папки, а не абсолютный путь.
function projectsLabel(root, projectsDir) {
  const relative = path.relative(root, projectsDir);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.split(path.sep).join('/')
    : path.basename(projectsDir);
}

async function startPultServer({
  root = path.resolve(__dirname, '../..'),
  projectsDir,
  port = 0,
  token = randomBytes(32).toString('base64url'),
  idleMs = IDLE_MS,
  idleCheckMs = IDLE_CHECK_MS,
  now = () => Date.now(),
  approveBriefImpl = approveBrief,
  revealImpl = revealInFileManager,
  openWindowImpl = openPultWindow,
  startReviewServerImpl = startReviewServer,
  captureImpl = null,
  onIdle = () => {},
  logger = console,
} = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedProjectsDir = path.resolve(projectsDir);
  const mediaOptions = captureImpl ? { captureImpl } : {};
  const ticketSecret = randomBytes(32);
  // Отдельный секрет для меток версии медиа: метка видна в URL, поэтому она не должна
  // совпадать ни с одним билетом утверждения и не выдаёт ни хеша, ни пути, ни mtime.
  const mediaVersionSecret = randomBytes(32);
  const reviewSessions = new Map();
  const reviewStarts = new Map();
  let closing = false;
  let origin = 'http://127.0.0.1';
  let lastActivity = now();

  const projectDirOf = (entry) => path.join(resolvedProjectsDir, entry.folder);

  // Точечный поиск по ключу: сканируем только одну папку, а не весь каталог. Полное
  // сканирование ~40 реальных папок стоит ~35 мс, а страница с двумя десятками обложек
  // делала бы его на каждую — однопоточный сервер вставал бы почти на секунду.
  function findEntry(key) {
    if (typeof key !== 'string' || !ENTRY_KEY.test(key)) return null;
    return scanFolder(resolvedProjectsDir, folderFromKey(key)).entries.find((entry) => entry.key === key) || null;
  }

  function entryFile(entry, relative) {
    try {
      return resolveProjectPath(projectDirOf(entry), relative, { mustExist: true, type: 'file' });
    } catch (_) {
      return null;
    }
  }

  // Страница смотрела файл preview из паспорта; утверждать можно, только если его
  // байты на диске до сих пор совпадают с хешем, к которому привязан билет.
  function servedPreviewMatches(entry) {
    if (!entry.video || entry.video.kind !== 'preview' || !entry.previewSha256) return false;
    const file = entryFile(entry, entry.video.path);
    if (!file) return false;
    try {
      return hashFile(file) === entry.previewSha256;
    } catch (_) {
      return false;
    }
  }

  // Билет привязывает утверждение к тем brief и preview, которые видела страница,
  // не показывая браузеру ни путей, ни хешей.
  function approvalTicket(entry) {
    if (!entry.approvable) return null;
    return createHmac('sha256', ticketSecret)
      .update(`${entry.key}\0${entry.briefPath}\0${entry.previewSha256}`)
      .digest('base64url');
  }

  // Метка версии видео для URL: адрес `?key=…` одинаков для старого и нового preview, и
  // открытая страница не узнала бы о новом файле. Метка меняется вместе с файлом (SHA-256
  // из паспорта, а у финала и legacy-видео без хеша — размер и время изменения) и
  // остаётся прежней, пока файл тот же. Маршрут медиа её не проверяет: файл по-прежнему
  // выбирается только ключом.
  function mediaVersion(entry, videoFile) {
    let fingerprint = entry.video.sha256 || '';
    if (!fingerprint) {
      try {
        const stat = fs.statSync(videoFile);
        fingerprint = `${stat.size}:${stat.mtimeMs}`;
      } catch (_) {
        fingerprint = 'missing';
      }
    }
    return createHmac('sha256', mediaVersionSecret)
      .update(`${entry.key}\0${entry.video.path}\0${fingerprint}`)
      .digest('base64url')
      .slice(0, 16);
  }

  // У legacy-папки несколько вариантов делят один comments.json — каждому свои правки.
  function variantComments(entry) {
    const comments = readComments(projectDirOf(entry));
    return entry.kind === 'legacy'
      ? comments.filter((comment) => entry.video && comment.video.path === entry.video.path)
      : comments;
  }

  function browserComment(entry, comment) {
    const key = encodeURIComponent(entry.key);
    return {
      id: comment.id,
      createdAt: comment.createdAt,
      timeSec: comment.timeSec,
      text: comment.text,
      status: comment.status,
      frameUrl: comment.frame ? `/media/frame?key=${key}&comment=${encodeURIComponent(comment.id)}` : null,
    };
  }

  // Вариант для браузера: без путей, brief и SHA-256 — видео адресуется ключом,
  // утверждение — непрозрачным билетом.
  function browserVariant(entry) {
    const query = `key=${encodeURIComponent(entry.key)}`;
    const videoFile = entry.video ? entryFile(entry, entry.video.path) : null;
    // Видео, которое пульт не может отдать браузеру (нет файла или формат вроде .mkv),
    // нельзя ни посмотреть, ни утвердить. Обложку ffmpeg всё равно сделает.
    const playable = Boolean(videoFile) && isServableMedia(videoFile);
    const versioned = videoFile ? `${query}&v=${mediaVersion(entry, videoFile)}` : query;
    return {
      key: entry.key,
      folder: entry.folder,
      variantLabel: entry.variantLabel,
      status: entry.status,
      nextStep: entry.nextStep,
      updatedAt: entry.updatedAt,
      projectKind: entry.projectKind,
      pendingComments: entry.pendingComments,
      reviewable: entry.reviewable,
      approvable: entry.approvable && playable,
      approvalTicket: playable ? approvalTicket(entry) : null,
      // Утверждённый brief ещё без финала: на экране — тот самый утверждённый preview.
      needsFinal: Boolean(entry.needsFinal),
      video: playable ? { kind: entry.video.kind, url: `/media/video?${versioned}` } : null,
      videoUnsupported: Boolean(videoFile) && !playable,
      thumbUrl: videoFile ? `/media/thumb?${versioned}` : null,
      meta: playable ? probeMedia(resolvedProjectsDir, videoFile, mediaOptions) : null,
      history: entry.history.map((item, index) => ({ label: item.label, url: `/media/history?${query}&index=${index}` })),
    };
  }

  function browserCards() {
    const sections = buildCards(scanProjects({ projectsDir: resolvedProjectsDir }), {
      archived: readPultState(resolvedProjectsDir).archived,
    });
    const mapCard = (card) => ({ ...card, variants: card.variants.map(browserVariant) });
    return {
      projectsLabel: projectsLabel(resolvedRoot, resolvedProjectsDir),
      waiting: sections.waiting.map(mapCard),
      working: sections.working.map(mapCard),
      ready: sections.ready.map(mapCard),
      archive: sections.archive.map(mapCard),
      unregistered: sections.unregistered,
      broken: sections.broken,
    };
  }

  // Папка для «Показать в папке»: то же правило имени, что и у каталога (names.js),
  // плюс это настоящий каталог внутри projects/, а не симлинк наружу.
  function safeFolder(folder) {
    if (!isSafeName(folder)) return null;
    const target = path.join(resolvedProjectsDir, folder);
    try {
      const stat = fs.lstatSync(target);
      return stat.isDirectory() && !stat.isSymbolicLink() ? target : null;
    } catch (_) {
      return null;
    }
  }

  // Работа в окне Review — тоже активность пульта: иначе человек, закрывший окно пульта
  // и правящий монтаж в Review, через 30 минут потерял бы Review вместе с ним. Считаем
  // только запросы, которые сам Review признал бы своими: его Host и его токен.
  function watchReviewActivity(review) {
    if (typeof review.token !== 'string' || !review.token || typeof review.origin !== 'string') return;
    let reviewHost;
    try {
      reviewHost = new URL(review.origin).host;
    } catch (_) {
      return;
    }
    review.server.on('request', (request) => {
      if (request.headers.host !== reviewHost) return;
      let url;
      try {
        url = new URL(request.url, review.origin);
      } catch (_) {
        return;
      }
      if (safeTokenEqual(requestToken(request, url), review.token)) lastActivity = now();
    });
  }

  async function startReview(projectDir) {
    let review;
    try {
      review = await startReviewServerImpl({ root: resolvedRoot, projectDir, editable: true, open: false });
    } catch (error) {
      logger.error(`Пульт: проверка монтажа не запустилась (${errorName(error)})`);
      throw new PultRequestError(409, 'REVIEW_FAILED', 'Проверку монтажа открыть не удалось');
    }
    // Пока Review запускался, пульт начал закрываться: такой сервер никому не нужен,
    // и оставить его слушать порт нельзя.
    if (closing) {
      await closeReview(review);
      throw shuttingDown();
    }
    watchReviewActivity(review);
    reviewSessions.set(projectDir, review);
    return review;
  }

  // Один Review на проект: повторное нажатие лишь снова открывает его окно, а два
  // одновременных нажатия ждут один и тот же запуск, а не поднимают два сервера.
  function reviewFor(projectDir) {
    // Тело POST могло прийти уже после начала close(): проверка в начале маршрута тогда
    // пройдена, а запуск, начатый сейчас, close() уже не дождался бы.
    if (closing) return Promise.reject(shuttingDown());
    const existing = reviewSessions.get(projectDir);
    if (existing && existing.server.listening) return Promise.resolve(existing);
    let start = reviewStarts.get(projectDir);
    if (!start) {
      start = startReview(projectDir);
      reviewStarts.set(projectDir, start);
      const forget = () => {
        if (reviewStarts.get(projectDir) === start) reviewStarts.delete(projectDir);
      };
      start.then(forget, forget);
    }
    return start;
  }

  function handleMedia(url, request, response) {
    const head = request.method === 'HEAD';
    const entry = findEntry(url.searchParams.get('key'));
    if (!entry) {
      sendError(response, 404, head);
      return;
    }
    let filePath = null;
    if (url.pathname === '/media/video') {
      filePath = entry.video ? entryFile(entry, entry.video.path) : null;
    } else if (url.pathname === '/media/history') {
      const raw = url.searchParams.get('index') || '';
      const index = /^\d{1,3}$/.test(raw) ? Number(raw) : -1;
      filePath = entry.history[index] ? entryFile(entry, entry.history[index].path) : null;
    } else if (url.pathname === '/media/frame') {
      let comments = [];
      try {
        comments = variantComments(entry);
      } catch (_) {
        comments = [];
      }
      const comment = comments.find((item) => item.id === url.searchParams.get('comment'));
      filePath = comment && comment.frame ? entryFile(entry, comment.frame) : null;
    } else if (url.pathname === '/media/thumb') {
      const videoFile = entry.video ? entryFile(entry, entry.video.path) : null;
      filePath = videoFile ? thumbnailFor(resolvedProjectsDir, videoFile, mediaOptions) : null;
    }
    if (!filePath) {
      sendError(response, 404, head);
      return;
    }
    serveFile(request, response, filePath);
  }

  async function handlePost(pathname, request, response) {
    const body = await readJsonBody(request);
    if (pathname === '/api/comments') {
      if (!exactKeys(body, ['key', 'timeSec', 'text'])) throw badRequest();
      const entry = findEntry(body.key);
      if (!entry) throw notFound();
      if (!entry.video) throw new PultRequestError(409, 'NO_VIDEO', 'У ролика пока нет видео');
      let comment;
      try {
        comment = addComment(projectDirOf(entry), { timeSec: body.timeSec, text: body.text, video: entry.video }, {
          captureFrame: (videoPath, timeSec, outPath) => extractFrame(videoPath, timeSec, outPath, mediaOptions),
        });
      } catch (error) {
        const message = error && typeof error.message === 'string' ? error.message : '';
        // Ошибки проверки ввода — фиксированные русские фразы «правка: …», их можно показать.
        if (/^правка/.test(message)) throw new PultRequestError(400, 'COMMENT_INVALID', message);
        // Битый comments.json — не вина ввода: та же подсказка, что при удалении и чтении.
        if (/comments\.json/.test(message)) {
          throw new PultRequestError(409, 'COMMENTS_BROKEN', COMMENTS_BROKEN_MESSAGE);
        }
        // Остальное — неожиданный сбой: общий обработчик ответит 500 и запишет только имя класса.
        throw error;
      }
      sendJson(response, 201, { comment: browserComment(entry, comment) });
      return;
    }
    if (pathname === '/api/comments/delete') {
      if (!exactKeys(body, ['key', 'id']) || typeof body.id !== 'string') throw badRequest();
      const entry = findEntry(body.key);
      if (!entry) throw notFound();
      let deleted;
      try {
        deleted = deleteComment(projectDirOf(entry), body.id);
      } catch (error) {
        // Принятую агентом правку удалять нельзя; любая другая ошибка — это битый
        // comments.json, и человеку нужна другая подсказка, чем «уже принята».
        if (/принят/.test(error && error.message)) {
          throw new PultRequestError(409, 'COMMENT_ACCEPTED', 'Правка уже принята агентом');
        }
        throw new PultRequestError(409, 'COMMENTS_BROKEN', COMMENTS_BROKEN_MESSAGE);
      }
      sendJson(response, 200, { deleted });
      return;
    }
    if (pathname === '/api/archive') {
      if (!exactKeys(body, ['cardId', 'archived']) || typeof body.archived !== 'boolean') throw badRequest();
      try {
        setArchived(resolvedProjectsDir, body.cardId, body.archived);
      } catch (_) {
        throw new PultRequestError(400, 'INVALID_CARD', 'Неверная карточка');
      }
      sendJson(response, 200, { ok: true });
      return;
    }
    if (pathname === '/api/approve') {
      if (!exactKeys(body, ['key', 'ticket', 'confirmPreviewViewed'])) throw badRequest();
      if (body.confirmPreviewViewed !== true) {
        throw new PultRequestError(400, 'CONFIRMATION_REQUIRED', 'Отметьте, что посмотрели preview целиком');
      }
      const entry = findEntry(body.key);
      if (!entry) throw notFound();
      const expected = approvalTicket(entry);
      if (!expected || !safeTokenEqual(body.ticket, expected)) throw previewChanged();
      // Движок сверяет expectedPreviewSha256 только там, где preview обязателен (motion,
      // discovery b-roll); для обычного lesson он его пропускает. Поэтому пульт сам
      // проверяет, что байты, которые он отдавал странице, всё ещё те, что в паспорте.
      // Билет при этом актуален, так что обновление страницы не поможет — нужен новый
      // preview от агента, отсюда отдельный код PREVIEW_DAMAGED.
      if (!servedPreviewMatches(entry)) throw previewDamaged();
      try {
        const projectDir = projectDirOf(entry);
        const workspace = createOrOpenProject({ projectDir });
        const briefFile = resolveProjectPath(projectDir, entry.briefPath, { mustExist: true, type: 'file' });
        approveBriefImpl(workspace, briefFile, {
          root: resolvedRoot,
          confirmPreviewViewed: true,
          expectedPreviewSha256: entry.previewSha256,
        });
      } catch (error) {
        // В лог — только класс ошибки: сообщение движка может содержать абсолютные пути.
        logger.error(`Пульт: движок не принял утверждение (${errorName(error)})`);
        // Билет по-прежнему актуален — значит, ролик не менялся и дело в самом черновике.
        // Иначе за время утверждения агент успел что-то поменять.
        const current = findEntry(body.key);
        const currentTicket = current ? approvalTicket(current) : null;
        if (!currentTicket || !safeTokenEqual(body.ticket, currentTicket)) throw previewChanged();
        // Ролик тот же, но project.json сейчас занят другой записью (агент меняет проект):
        // это временно, в отличие от отказа по самому черновику.
        if (error && error.code === ENGINE_MANIFEST_CONFLICT) throw projectBusy();
        throw new PultRequestError(422, 'APPROVAL_BLOCKED', APPROVAL_BLOCKED_MESSAGE);
      }
      sendJson(response, 201, { ok: true });
      return;
    }
    if (pathname === '/api/reveal') {
      let target;
      if (exactKeys(body, ['key'])) {
        const entry = findEntry(body.key);
        if (!entry) throw notFound();
        target = (entry.video && entryFile(entry, entry.video.path)) || projectDirOf(entry);
      } else if (exactKeys(body, ['folder'])) {
        target = safeFolder(body.folder);
        if (!target) throw new PultRequestError(400, 'INVALID_FOLDER', 'Неверная папка');
      } else {
        throw badRequest();
      }
      try {
        await revealImpl(target);
      } catch (error) {
        logger.error(`Пульт: не удалось открыть папку (${errorName(error)})`);
        throw new PultRequestError(409, 'REVEAL_FAILED', 'Не удалось открыть папку');
      }
      sendJson(response, 200, { ok: true });
      return;
    }
    if (pathname === '/api/review') {
      if (!exactKeys(body, ['key'])) throw badRequest();
      const entry = findEntry(body.key);
      if (!entry) throw notFound();
      if (!entry.reviewable) throw new PultRequestError(409, 'NOT_REVIEWABLE', 'Для этого ролика проверка монтажа недоступна');
      const review = await reviewFor(projectDirOf(entry));
      try {
        await openWindowImpl(review.url);
      } catch (error) {
        logger.error(`Пульт: не удалось открыть окно проверки монтажа (${errorName(error)})`);
        throw new PultRequestError(409, 'WINDOW_FAILED', 'Не удалось открыть окно проверки монтажа');
      }
      sendJson(response, 200, { ok: true });
      return;
    }
    throw new PultRequestError(404, 'NOT_FOUND', 'Не найдено');
  }

  async function route(request, response) {
    const head = request.method === 'HEAD';
    const safeMethod = request.method === 'GET' || head;
    let url;
    try {
      url = new URL(request.url, origin);
    } catch (_) {
      request.resume();
      sendError(response, 400);
      return;
    }
    // Проверка Host защищает от DNS rebinding: чужой сайт с доменом, указывающим на
    // 127.0.0.1, не получит даже страницу.
    if (request.headers.host !== new URL(origin).host) {
      request.resume();
      sendError(response, 403, head);
      return;
    }
    if (hasUnsafePath(request.url)) {
      request.resume();
      sendError(response, 404, head);
      return;
    }
    const { pathname } = url;
    // Закрывающийся пульт больше не принимает работу: страница увидит 503, а не
    // ответ сервера, который через миг исчезнет.
    if (closing && (pathname.startsWith('/api/') || pathname.startsWith('/media/'))) {
      request.resume();
      sendError(response, 503, head);
      return;
    }
    if (pathname === '/api/health') {
      if (request.method !== 'GET') {
        request.resume();
        sendError(response, 405);
        return;
      }
      sendJson(response, 200, { app: 'automontage-pult', version: 1 });
      return;
    }
    if (safeMethod && serveStatic(resolvedRoot, pathname, request, response)) return;
    const isApi = pathname.startsWith('/api/');
    const isMedia = pathname.startsWith('/media/');
    if (!isApi && !isMedia) {
      request.resume();
      sendError(response, 404, head);
      return;
    }
    if (!safeTokenEqual(requestToken(request, url), token)) {
      request.resume();
      sendError(response, 401, head);
      return;
    }
    // Изменения принимаются только со страницы самого пульта.
    if (!safeMethod && request.headers.origin !== origin) {
      request.resume();
      sendError(response, 403);
      return;
    }
    lastActivity = now();
    if (isMedia) {
      if (!safeMethod) {
        request.resume();
        sendError(response, 405);
        return;
      }
      handleMedia(url, request, response);
      return;
    }
    if (pathname === '/api/cards' && safeMethod) {
      sendJson(response, 200, browserCards());
      return;
    }
    if (pathname === '/api/comments' && safeMethod) {
      const entry = findEntry(url.searchParams.get('key'));
      if (!entry) throw notFound();
      let comments;
      try {
        comments = variantComments(entry);
      } catch (_) {
        throw new PultRequestError(409, 'COMMENTS_BROKEN', COMMENTS_BROKEN_MESSAGE);
      }
      sendJson(response, 200, { comments: comments.map((comment) => browserComment(entry, comment)) });
      return;
    }
    if (request.method !== 'POST') {
      request.resume();
      sendError(response, 405);
      return;
    }
    await handlePost(pathname, request, response);
  }

  const server = http.createServer((request, response) => {
    route(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof PultRequestError) {
        sendProblem(response, error.status, error.code, error.message);
        return;
      }
      // В лог — только класс ошибки: сообщение может содержать абсолютные пути.
      logger.error(`Пульт: внутренняя ошибка (${errorName(error)})`);
      sendProblem(response, 500, 'INTERNAL', 'Внутренняя ошибка пульта');
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  origin = `http://127.0.0.1:${server.address().port}`;

  let idleTimer = null;
  let closed = null;

  // Закрывает сервер и сразу обрывает его соединения: иначе незаконченная отдача видео
  // (или keep-alive окна) держала бы close() сколько угодно долго.
  function closeServerNow(target) {
    return new Promise((resolve) => {
      if (!target || !target.listening) {
        resolve();
        return;
      }
      try {
        target.close(() => resolve());
      } catch (_) {
        resolve();
        return;
      }
      if (typeof target.closeAllConnections === 'function') target.closeAllConnections();
    });
  }

  // Review гасится так же, как это делает его CLI по Ctrl+C (scripts/review/cli.js):
  // оборвать активный импорт → закрыть сервер → дождаться, пока импорты приберут за собой.
  async function closeReview(review) {
    try { review.abortActiveImports?.(); } catch (_) { /* закрыть сервер всё равно нужно */ }
    const serverClosed = closeServerNow(review.server);
    try { await review.waitForActiveImports?.(); } catch (_) { /* итог уборки уже достигнут */ }
    await serverClosed;
  }

  // Закрывает и открытые из пульта окна Review: они живут только вместе с ним.
  async function close() {
    if (closed) return closed;
    closing = true;
    closed = (async () => {
      if (idleTimer) clearInterval(idleTimer);
      // Review, который ещё запускается, увидит closing и сам закроет свой сервер —
      // дожидаемся этого, чтобы после close() ни один порт Review не остался открытым.
      await Promise.allSettled([...reviewStarts.values()]);
      for (const review of reviewSessions.values()) {
        await closeReview(review);
      }
      reviewSessions.clear();
      await closeServerNow(server);
    })();
    return closed;
  }

  // Пульт сам завершается, если страница давно не обращалась к серверу.
  idleTimer = idleMs > 0
    ? setInterval(() => {
      // catch: ошибка в onIdle не должна превратиться в необработанный отказ промиса.
      if (now() - lastActivity >= idleMs) close().then(() => onIdle()).catch(() => {});
    }, idleCheckMs)
    : null;
  if (idleTimer && typeof idleTimer.unref === 'function') idleTimer.unref();

  return {
    server,
    token,
    origin,
    url: `${origin}/#token=${token}`,
    reviewSessions,
    close,
  };
}

module.exports = { startPultServer };
