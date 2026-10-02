// automontage layer import – импорт отрендеренного слоя kit тем же путём, что и в Review (importReviewMedia:
// нормализация в assets/broll/video/<id>/media.mp4 с sha256), и запись в реестр проверенных слоёв
// qa/layer-imports.json. Принимается только сам рендер (файл внутри проекта по тому пути и с тем sha256,
// что во входе «layer» самого свежего отчёта layer render), если этот отчёт целый, без ошибки и не «стоп» и
// собран для текущего исходника проекта.
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { configureMediaToolPath } = require('../env');
const { acquireHeavySlot } = require('../heavy-queue');
const { openReadOnlyFlags } = require('../filesystem-capabilities');
const { probeVideo } = require('../media-probe');
const { VIDEO_MAX_BYTES, createImportController, importReviewMedia } = require('../review/media-import');
const { runMediaProcess } = require('../review/media-process');
const { projectFrom, relative } = require('./common');
const { appendRegistry, assertReportSource, findByRender, findRenderReport, layerAsset, renderReportProblem } = require('./registry');

const FLAGS = { 'project-dir': 'value', file: 'value' };
const HINT = 'motion-vNN/renders/layer-NN.mp4';
const HASH_CHUNK_BYTES = 1024 * 1024;

// Коды importReviewMedia остаются в сообщении, частые получают подсказку, что делать.
const IMPORT_HINTS = {
  MEDIA_IMPORT_BUSY: 'идёт другой импорт или правка этого проекта – повторите позже',
  MEDIA_IMPORT_TOO_LARGE: `файл слоя больше ${VIDEO_MAX_BYTES / 1024 ** 3} ГБ – сократите слой или понизьте качество рендера`,
  MEDIA_IMPORT_DISK_FULL: 'на диске не хватает места для импорта – освободите место и повторите',
  MEDIA_IMPORT_DURATION_UNSUPPORTED: 'слой длиннее 30 минут – такой импорт не поддерживается, сократите слой',
};

function importFailure(error) {
  const code = error?.code;
  if (typeof code !== 'string' || !code.startsWith('MEDIA_IMPORT_')) return error;
  return new Error(`импорт не удался${IMPORT_HINTS[code] ? `: ${IMPORT_HINTS[code]}` : ''} (${code})`, { cause: error });
}

const isInside = (root, candidate) => {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

// Файл слоя: внутри проекта по настоящим путям (папка-ссылка наружу не проходит, ссылки в предках самого
// проекта не мешают), сам не ссылка и обычный файл.
function resolveLayerFile(projectDir, option, fileSystem) {
  const absolute = path.resolve(option);
  const stat = fileSystem.lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat) throw new Error(`--file ${option}: файл не найден`);
  const projectReal = fileSystem.realpathSync(projectDir);
  const real = path.join(fileSystem.realpathSync(path.dirname(absolute)), path.basename(absolute));
  if (!isInside(projectReal, real)) throw new Error(`--file ${option}: файл вне проекта – импортируется только слой из папки проекта (${HINT})`);
  if (stat.isSymbolicLink()) throw new Error(`--file ${option}: это ссылка – укажите сам файл слоя (${HINT})`);
  if (!stat.isFile()) throw new Error(`--file ${option}: это не обычный файл – укажите файл слоя (${HINT})`);
  return { file: real, stat, relativePath: relative(projectReal, real) };
}

// Файл слоя открывается один раз, без прохода по ссылке (O_NOFOLLOW, где он есть): хеш и поток импорта
// читают этот дескриптор. same() сверяет, что это всё ещё тот файл, что видел lstat, и он не менялся.
function openLayerFile(fileSystem, { file, stat }, option) {
  const descriptor = fileSystem.openSync(file, openReadOnlyFlags(fileSystem));
  const same = () => {
    const now = fileSystem.fstatSync(descriptor);
    if (!now.isFile() || now.dev !== stat.dev || now.ino !== stat.ino || now.size !== stat.size || now.mtimeMs !== stat.mtimeMs) {
      throw new Error(`--file ${option}: файл изменился во время импорта – повторите команду`);
    }
  };
  return { descriptor, same, size: stat.size };
}

// Кусками по 1 МиБ с явной позицией: renders весят сотни МБ, а поток потом читает тот же дескриптор с 0.
function hashDescriptor(fileSystem, descriptor) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  let position = 0;
  let read = fileSystem.readSync(descriptor, buffer, 0, buffer.length, position);
  while (read > 0) {
    hash.update(buffer.subarray(0, read));
    position += read;
    read = fileSystem.readSync(descriptor, buffer, 0, buffer.length, position);
  }
  return hash.digest('hex');
}

// Отчёт layer render, которому можно доверить этот файл: проверял именно его (тот же путь и sha256 во входе
// «layer»), целый и прошёл (renderReportProblem) и собран для текущего исходника проекта – старый рендер до
// замены исходника или чужой рендер с отчётом из другого проекта не проходят.
function checkedReport(projectDir, { renderSha256, relativePath, sourcePath, option }) {
  const report = findRenderReport(projectDir, renderSha256, { path: relativePath });
  if (!report) {
    const original = findRenderReport(projectDir, renderSha256);
    if (original) {
      throw new Error(`--file ${option}: это копия слоя ${original.layerPath}, проверенного в qa/${original.fileName} – импортируйте сам ${original.layerPath}`);
    }
    throw new Error('этот файл не проходил layer render: импортируется только проверенный слой – '
      + `его sha256 нет во входе «layer» ни одного отчёта qa/layer-<слой>-render-NN.json (${relativePath})`);
  }
  const problem = renderReportProblem(report, { layer: relativePath.split('/')[0] });
  if (problem) throw new Error(problem);
  assertReportSource(report, { projectDir, sourcePath });
  return report;
}

// Импорт из проверенного дескриптора с начала файла. Поток владеет дескриптором: destroy закрывает его и
// дожидается незаконченного чтения. Пока дескриптор открыт, после импорта проверяем, что файл не менялся.
// Ошибка закрытия дескриптора приходит событием error: пустой слушатель не даёт ей стать необработанной.
async function importLayerFile({ projectDir, sourcePath, file, opened, fileSystem, importImpl, runMediaProcessImpl = runMediaProcess, log }) {
  let request;
  try {
    request = fileSystem.createReadStream(file, { fd: opened.descriptor, start: 0, autoClose: false });
  } catch (error) {
    fileSystem.closeSync(opened.descriptor);
    throw error;
  }
  try {
    configureMediaToolPath();
    let asset;
    try {
      asset = await importImpl({
        request,
        signal: new AbortController().signal,
        projectDir,
        outputFps: probeVideo(sourcePath).fps,
        headers: {
          'content-length': String(opened.size),
          'content-type': 'video/mp4',
          'x-automontage-filename': encodeURIComponent(path.basename(file)),
        },
        controller: createImportController(),
        runMediaProcessImpl,
        masterStrategy: 'remux-if-conforming',
        log,
      });
    } catch (error) {
      throw importFailure(error);
    }
    opened.same();
    return asset;
  } finally {
    if (!request.closed) {
      await new Promise((resolve) => {
        request.once('close', resolve);
        request.on('error', () => {});
        request.destroy();
      });
    }
  }
}

// deps: log – вывод; fileSystem – доступ к слою; importImpl/runMediaProcessImpl/acquireSlot – подмены для тестов.
async function run(options, deps = {}) {
  const log = deps.log || console.log;
  const fileSystem = deps.fileSystem || fs;
  const importImpl = deps.importImpl || importReviewMedia;
  const acquireSlot = deps.acquireSlot || acquireHeavySlot;
  const { projectDir, sourcePath: initialSourcePath } = projectFrom(options);
  let sourcePath = initialSourcePath;
  if (!options.file) throw new Error(`нужен --file <${HINT}>`);
  const layerFile = resolveLayerFile(projectDir, options.file, fileSystem);
  const { relativePath } = layerFile;
  const opened = openLayerFile(fileSystem, layerFile, options.file);
  let ownsDescriptor = true; // до импорта дескриптор закрывает run, потом – поток импорта
  let slot;
  try {
    opened.same();
    const renderSha256 = hashDescriptor(fileSystem, opened.descriptor);
    opened.same();
    // Всё, что может отказать, – до импорта: отчёт, исходник, qa/ и реестр; иначе остался бы ассет без записи.
    let report = checkedReport(projectDir, { renderSha256, relativePath, sourcePath, option: options.file });
    slot = await acquireSlot({ label: `layer import ${path.basename(projectDir)}`, log });
    if (slot.waited) {
      opened.same();
      sourcePath = projectFrom(options).sourcePath;
      report = checkedReport(projectDir, { renderSha256, relativePath, sourcePath, option: options.file });
    }
    const existing = findByRender(projectDir, renderSha256);
    let asset;
    // Ассет прошлого импорта цел (layerAsset) – переиспользуем, иначе импортируем заново.
    if (existing && layerAsset(projectDir, existing)) {
      asset = existing;
      log(`Этот рендер уже импортирован: ${existing.reference} – новый ассет не создан`);
    } else {
      ownsDescriptor = false;
      asset = await importLayerFile({ projectDir, sourcePath, file: layerFile.file, opened, fileSystem, importImpl,
        runMediaProcessImpl: deps.runMediaProcessImpl, log });
    }
    return register({ projectDir, report, relativePath, renderSha256, asset, existing, log });
  } finally {
    try {
      if (ownsDescriptor) fileSystem.closeSync(opened.descriptor);
    } finally {
      slot?.release();
    }
  }
}

// renderFile – путь самого рендера, тот же, что во входе «layer» отчёта (копии в другом месте не принимаются).
function register({ projectDir, report, relativePath, renderSha256, asset, existing, log }) {
  const entry = {
    layer: report.layer,
    render: report.renderNumber,
    renderFile: relativePath,
    renderReport: `qa/${report.fileName}`,
    renderSha256,
    profile: report.profile,
    assetId: path.posix.basename(path.posix.dirname(asset.reference)),
    reference: asset.reference,
    canonicalSha256: asset.canonicalSha256,
    createdAt: asset === existing ? existing.createdAt : new Date().toISOString(),
  };
  appendRegistry(projectDir, entry);
  log(JSON.stringify({ reference: entry.reference, canonicalSha256: entry.canonicalSha256 }, null, 2));
  log(`Дальше: automontage layer brief --project-dir "${projectDir}" --asset ${entry.reference} --title … --head-cream … --head-orange …`);
  return 0;
}

module.exports = { FLAGS, run };
