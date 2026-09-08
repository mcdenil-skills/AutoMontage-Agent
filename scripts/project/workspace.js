const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID, timingSafeEqual } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { URL } = require('node:url');
const Ajv = require('ajv');

const {
  openReadOnlyFlags,
  setPrivateDescriptorMode,
  withNoFollow,
} = require('../filesystem-capabilities');

const projectSchema = require('../../schema/project.schema.json');
const { formatBriefMarkdown, isRenderableBrollSource, validateLessonBrief } = require('../lesson/brief');
const {
  formatMotionBriefMarkdown,
  validateMotionBrief,
} = require('../motion/brief');
const {
  preflightBriefBrollMedia,
  verifyBriefBrollMedia,
} = require('../lesson/broll-media-files');
const projectManifestValidator = new Ajv({ allErrors: true }).compile(projectSchema);
const TEMPORARY_ID = /^[A-Za-z0-9_-]+$/;

const CYRILLIC_TO_LATIN = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh',
  з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu',
  я: 'ya',
};

function transliterate(value) {
  return [...value].map((character) => CYRILLIC_TO_LATIN[character] ?? character).join('');
}

function slugifyProjectName(name) {
  const latin = transliterate(String(name || '').trim().toLowerCase());
  const slug = latin.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('название проекта не содержит букв или цифр');
  return slug;
}

function formatProjectId({ date, name }) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error('дата проекта должна быть корректной');
  }
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}.${month}.${day}_${slugifyProjectName(name)}`;
}

function migrateProjectManifest(manifest) {
  if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
    if (!Object.hasOwn(manifest, 'projectKind')) manifest.projectKind = 'video';
    if (Array.isArray(manifest.briefs)) {
      for (const brief of manifest.briefs) {
        if (brief && typeof brief === 'object' && !Object.hasOwn(brief, 'kind')) {
          brief.kind = 'lesson';
        }
      }
    }
  }
  if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)
    && manifest.source && typeof manifest.source === 'object') {
    if (!Object.hasOwn(manifest.source, 'mediaKind')) manifest.source.mediaKind = 'video';
    if (!Object.hasOwn(manifest.source, 'originalLocalPath')) {
      manifest.source.originalLocalPath = manifest.source.localPath;
    }
    if (!Object.hasOwn(manifest.source, 'revision')) manifest.source.revision = 1;
    if (!Object.hasOwn(manifest.source, 'history')) manifest.source.history = [];
  }
  if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)
    && !Object.hasOwn(manifest, 'transcript')) {
    manifest.transcript = {
      words: 'transcript/words.json',
      captions: 'transcript/captions.js',
    };
  }
  return manifest;
}

function formatProjectManifestSchemaError(error) {
  const location = error.instancePath || '';
  const missingProperty = error.keyword === 'required'
    ? `.${error.params.missingProperty}`
    : '';
  const extraProperty = error.keyword === 'additionalProperties'
    ? `.${error.params.additionalProperty}`
    : '';
  return `manifest${location}${missingProperty}${extraProperty}: ${error.message}`;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative));
}

function lstatIfPresent(fileSystem, target) {
  try {
    return fileSystem.lstatSync(target);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw error;
  }
}

function assertNoProjectSymlink(root, segments, fileSystem, label) {
  const rootStat = fileSystem.lstatSync(root);
  if (rootStat.isSymbolicLink()) {
    throw new Error(`${label} escapes through a symbolic link`);
  }
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = lstatIfPresent(fileSystem, current);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} escapes through a symbolic link`);
    }
  }
}

function resolveProjectPath(projectDir, storedPath, options = {}) {
  const label = options.label || 'project path';
  const fileSystem = options.fileSystem || fs;
  if (typeof storedPath !== 'string' || storedPath.length === 0 || storedPath.includes('\0')) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  if (path.isAbsolute(storedPath)
    || path.win32.isAbsolute(storedPath)
    || path.win32.parse(storedPath).root !== '') {
    throw new Error(`${label} must stay inside the project workspace`);
  }
  const segments = storedPath.split(/[\\/]/);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${label} must be a canonical relative path`);
  }

  const root = path.resolve(projectDir);
  const candidate = path.resolve(root, ...segments);
  if (!isInside(root, candidate)) {
    throw new Error(`${label} escapes the project workspace`);
  }

  assertNoProjectSymlink(root, segments, fileSystem, label);
  const rootReal = fileSystem.realpathSync(root);
  let ancestor = candidate;
  while (!fileSystem.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const ancestorReal = fileSystem.realpathSync(ancestor);
  if (!isInside(rootReal, ancestorReal)) {
    throw new Error(`${label} escapes through a symbolic link`);
  }

  if (options.mustExist && !fileSystem.existsSync(candidate)) {
    throw new Error(`${label} does not exist`);
  }
  if (fileSystem.existsSync(candidate)) {
    const candidateReal = fileSystem.realpathSync(candidate);
    if (!isInside(rootReal, candidateReal)) {
      throw new Error(`${label} escapes through a symbolic link`);
    }
    const stat = fileSystem.statSync(candidateReal);
    if (options.type === 'file' && !stat.isFile()) throw new Error(`${label} must be a file`);
    if (options.type === 'directory' && !stat.isDirectory()) {
      throw new Error(`${label} must be a directory`);
    }
  }
  return candidate;
}

function safeTemporaryId(temporaryId) {
  const value = String(temporaryId());
  if (!TEMPORARY_ID.test(value)) throw new Error('temporary file id is unsafe');
  return value;
}

function sameFileIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino;
}

function stageOwnedSiblingFile(destination, data, {
  fileSystem = fs,
  temporaryId = randomUUID,
  purpose = 'write',
  platform = process.platform,
} = {}) {
  const bytes = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data, 'utf8');
  const temporaryPath = `${destination}.tmp-${purpose}-${safeTemporaryId(temporaryId)}`;
  const constants = fileSystem.constants || fs.constants;
  const flags = withNoFollow(
    fileSystem,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    platform,
  );
  let handle = null;
  let identity = null;
  try {
    handle = fileSystem.openSync(temporaryPath, flags, 0o600);
    identity = fileSystem.fstatSync(handle);
    if (!identity.isFile()) throw new Error('temporary project file must be regular');
    setPrivateDescriptorMode(fileSystem, handle, 0o600, platform);
    fileSystem.writeFileSync(handle, data, { encoding: 'utf8' });
    fileSystem.fsyncSync(handle);
  } catch (error) {
    if (handle !== null) fileSystem.closeSync(handle);
    const current = lstatIfPresent(fileSystem, temporaryPath);
    if (identity && current && sameFileIdentity(identity, current)) {
      fileSystem.unlinkSync(temporaryPath);
    }
    throw error;
  }
  fileSystem.closeSync(handle);

  let committedPath = null;
  return {
    path: temporaryPath,
    commitReplace(target = destination) {
      fileSystem.renameSync(temporaryPath, target);
      committedPath = target;
      return { identity, bytes };
    },
    commitNoReplace(target = destination) {
      fileSystem.linkSync(temporaryPath, target);
      committedPath = target;
      fileSystem.unlinkSync(temporaryPath);
    },
    commit(target = destination) {
      this.commitReplace(target);
    },
    cleanupTemp() {
      const current = lstatIfPresent(fileSystem, temporaryPath);
      if (current && sameFileIdentity(identity, current)) fileSystem.unlinkSync(temporaryPath);
    },
    removeCommitted() {
      if (!committedPath) return;
      const current = lstatIfPresent(fileSystem, committedPath);
      if (current && sameFileIdentity(identity, current)) fileSystem.unlinkSync(committedPath);
      committedPath = null;
    },
  };
}

function stageNoReplaceFileSet(files, {
  fileSystem = fs,
  temporaryId = randomUUID,
} = {}) {
  const stages = [];
  try {
    for (const { destination, data, purpose } of files) {
      stages.push(stageOwnedSiblingFile(
        destination,
        data,
        { fileSystem, temporaryId, purpose },
      ));
    }
  } catch (error) {
    for (const stage of stages) stage.cleanupTemp();
    throw error;
  }
  return {
    commit() {
      for (const stage of stages) stage.commitNoReplace();
    },
    rollback() {
      for (const stage of [...stages].reverse()) stage.removeCommitted();
    },
    cleanup() {
      for (const stage of stages) stage.cleanupTemp();
    },
  };
}

function writeFilesNoReplace(files, options = {}) {
  const staged = stageNoReplaceFileSet(files, options);
  try {
    staged.commit();
  } catch (error) {
    try {
      staged.rollback();
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
    throw error;
  } finally {
    staged.cleanup();
  }
}

function copyOpenedFile(fileSystem, sourceHandle, destinationHandle) {
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  for (;;) {
    const bytesRead = fileSystem.readSync(sourceHandle, buffer, 0, buffer.length, null);
    if (bytesRead === 0) return;
    let written = 0;
    while (written < bytesRead) {
      written += fileSystem.writeSync(
        destinationHandle,
        buffer,
        written,
        bytesRead - written,
        null,
      );
    }
  }
}

function copyProjectFileNoReplace({
  projectDir,
  sourcePath,
  storedPath,
  fileSystem = fs,
  temporaryId = randomUUID,
  platform = process.platform,
}) {
  const resolvedProjectDir = path.resolve(projectDir);
  const destination = resolveProjectPath(resolvedProjectDir, storedPath, {
    label: 'project source destination',
    fileSystem,
    mustExist: false,
    type: 'file',
  });
  const source = path.resolve(sourcePath);
  const sourcePathStat = fileSystem.lstatSync(source);
  if (!sourcePathStat.isFile() || sourcePathStat.isSymbolicLink()) {
    throw new Error('project source must be a regular file, not a symbolic link');
  }

  const sourceHandle = fileSystem.openSync(source, openReadOnlyFlags(fileSystem, platform));
  const temporaryPath = `${destination}.tmp-source-${safeTemporaryId(temporaryId)}`;
  const constants = fileSystem.constants || fs.constants;
  const flags = withNoFollow(
    fileSystem,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    platform,
  );
  let destinationHandle = null;
  let destinationIdentity = null;
  let committed = false;
  try {
    const openedSource = fileSystem.fstatSync(sourceHandle);
    const currentSource = fileSystem.lstatSync(source);
    if (!openedSource.isFile() || currentSource.isSymbolicLink()
      || !sameFileIdentity(openedSource, currentSource)) {
      throw new Error('project source changed or escapes through a symbolic link');
    }

    destinationHandle = fileSystem.openSync(temporaryPath, flags, 0o600);
    destinationIdentity = fileSystem.fstatSync(destinationHandle);
    if (!destinationIdentity.isFile()) throw new Error('temporary project source must be regular');
    setPrivateDescriptorMode(fileSystem, destinationHandle, 0o600, platform);
    copyOpenedFile(fileSystem, sourceHandle, destinationHandle);
    fileSystem.fsyncSync(destinationHandle);

    const copiedSource = fileSystem.fstatSync(sourceHandle);
    if (!sameFileIdentity(openedSource, copiedSource)
      || openedSource.size !== copiedSource.size
      || openedSource.mtimeMs !== copiedSource.mtimeMs
      || openedSource.ctimeMs !== copiedSource.ctimeMs) {
      throw new Error('project source changed while it was copied');
    }
    fileSystem.closeSync(destinationHandle);
    destinationHandle = null;
    fileSystem.linkSync(temporaryPath, destination);
    committed = true;
    fileSystem.unlinkSync(temporaryPath);
    return destination;
  } finally {
    if (destinationHandle !== null) fileSystem.closeSync(destinationHandle);
    fileSystem.closeSync(sourceHandle);
    if (!committed) {
      const current = lstatIfPresent(fileSystem, temporaryPath);
      if (current && destinationIdentity && sameFileIdentity(current, destinationIdentity)) {
        fileSystem.unlinkSync(temporaryPath);
      }
    }
  }
}

function validateProjectManifest(manifest, { projectDir, fileSystem = fs } = {}) {
  const migratedManifest = migrateProjectManifest(manifest);
  if (!projectManifestValidator(migratedManifest)) {
    throw new Error((projectManifestValidator.errors || [])
      .map(formatProjectManifestSchemaError)
      .join('\n'));
  }
  if (migratedManifest.currentBrief !== null
    && !migratedManifest.briefs.some((brief) => brief.jsonPath === migratedManifest.currentBrief)) {
    throw new Error('manifest.currentBrief must match one manifest.briefs[].jsonPath entry');
  }
  if (migratedManifest.latestRender !== null
    && !migratedManifest.renders.some((render) => (
      render.dir === migratedManifest.latestRender && render.status === 'complete'
    ))) {
    throw new Error('manifest.latestRender must match one complete manifest.renders[].dir entry');
  }
  if (!projectDir) return migratedManifest;

  const paths = [
    ['manifest.source.originalLocalPath', migratedManifest.source.originalLocalPath],
    ['manifest.source.localPath', migratedManifest.source.localPath],
    ['manifest.transcript.words', migratedManifest.transcript.words],
    ['manifest.transcript.captions', migratedManifest.transcript.captions],
    ['manifest.currentBrief', migratedManifest.currentBrief],
    ['manifest.latestRender', migratedManifest.latestRender],
    ['manifest.final', migratedManifest.final],
  ];
  if (migratedManifest.currentPreview) {
    paths.push(
      ['manifest.currentPreview.filePath', migratedManifest.currentPreview.filePath],
      ['manifest.currentPreview.briefPath', migratedManifest.currentPreview.briefPath],
    );
  }
  migratedManifest.briefs.forEach((brief, index) => {
    paths.push([`manifest.briefs[${index}].jsonPath`, brief.jsonPath]);
    if (brief.markdownPath !== null) {
      paths.push([`manifest.briefs[${index}].markdownPath`, brief.markdownPath]);
    }
  });
  migratedManifest.renders.forEach((render, index) => {
    paths.push([`manifest.renders[${index}].dir`, render.dir]);
    if (render.briefPath !== null) {
      paths.push([`manifest.renders[${index}].briefPath`, render.briefPath]);
    }
  });
  migratedManifest.source.history.forEach((entry, index) => {
    paths.push(
      [`manifest.source.history[${index}].localPath`, entry.localPath],
      [`manifest.source.history[${index}].editPath`, entry.editPath],
      [`manifest.source.history[${index}].transcriptPath`, entry.transcriptPath],
    );
  });
  for (const [label, storedPath] of paths) {
    if (storedPath !== null) {
      resolveProjectPath(projectDir, storedPath, { label, fileSystem });
    }
  }
  return migratedManifest;
}

function readProjectManifest(projectDir) {
  const resolvedProjectDir = path.resolve(projectDir);
  const manifestPath = resolveProjectPath(resolvedProjectDir, 'project.json', {
    label: 'project.json',
    mustExist: false,
    type: 'file',
  });
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`project.json не найден: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return validateProjectManifest(manifest, { projectDir: resolvedProjectDir });
}

function writeProjectManifestAtomic(projectDir, manifest, {
  fileSystem = fs,
  temporaryId = randomUUID,
} = {}) {
  const resolvedProjectDir = path.resolve(projectDir);
  const manifestPath = resolveProjectPath(resolvedProjectDir, 'project.json', {
    label: 'project.json',
    fileSystem,
    mustExist: false,
    type: 'file',
  });
  const validatedManifest = validateProjectManifest(manifest, {
    projectDir: resolvedProjectDir,
    fileSystem,
  });
  const staged = stageOwnedSiblingFile(
    manifestPath,
    `${JSON.stringify(validatedManifest, null, 2)}\n`,
    { fileSystem, temporaryId, purpose: 'manifest' },
  );
  try {
    staged.commitReplace();
  } finally {
    staged.cleanupTemp();
  }
}

function writeProjectManifest(projectDir, manifest, options = {}) {
  const resolvedProjectDir = path.resolve(projectDir);
  const manifestPath = path.join(resolvedProjectDir, 'project.json');
  if (!lstatIfPresent(options.fileSystem || fs, manifestPath)) {
    return writeProjectManifestAtomic(resolvedProjectDir, manifest, options);
  }
  const validated = validateProjectManifest(manifest, {
    projectDir: resolvedProjectDir,
    fileSystem: options.fileSystem || fs,
  });
  if (options.expectedManifest === undefined || options.expectedManifest === false) {
    throw manifestConflict();
  }
  return withProjectMutation(
    { dir: resolvedProjectDir, manifest: options.expectedManifest },
    (transaction) => transaction.commitManifest(validated, { purpose: 'manifest' }),
    options,
  );
}

function ensureProjectDirectories(projectDir) {
  const directories = [
    'input',
    'transcript',
    'edit',
    'brief',
    'assets/music',
    'assets/broll',
    'previews',
    'renders',
    'final',
  ];
  fs.mkdirSync(projectDir, { recursive: true });
  for (const directory of directories) {
    const directoryPath = resolveProjectPath(projectDir, directory, {
      label: `project directory ${directory}`,
      mustExist: false,
      type: 'directory',
    });
    fs.mkdirSync(directoryPath, { recursive: true });
    resolveProjectPath(projectDir, directory, {
      label: `project directory ${directory}`,
      mustExist: true,
      type: 'directory',
    });
  }
}

function asWorkspace(projectDir, manifest) {
  return {
    dir: projectDir,
    manifestPath: path.join(projectDir, 'project.json'),
    sourcePath: resolveProjectPath(projectDir, manifest.source.localPath, {
      label: 'manifest.source.localPath',
      mustExist: true,
      type: 'file',
    }),
    manifest,
  };
}

function assertMatchingSource(projectDir, manifest, sourcePath) {
  if (!sourcePath) return;
  const resolvedSource = path.resolve(sourcePath);
  const originalSource = path.resolve(manifest.source.originalPath);
  const localSource = resolveProjectPath(projectDir, manifest.source.localPath, {
    label: 'manifest.source.localPath',
    mustExist: true,
    type: 'file',
  });
  if (resolvedSource !== originalSource && resolvedSource !== localSource) {
    throw new Error('проект уже использует другой исходник');
  }
}

function createOrOpenProject({
  baseDir,
  name,
  projectDir,
  sourcePath,
  projectKind = 'video',
  mediaKind = projectKind === 'motion-reel' ? 'audio' : 'video',
  now = new Date(),
}) {
  const resolvedProjectDir = projectDir
    ? path.resolve(projectDir)
    : path.join(path.resolve(baseDir), formatProjectId({ date: now, name }));
  const manifestPath = path.join(resolvedProjectDir, 'project.json');

  if (fs.existsSync(manifestPath)) {
    const manifest = readProjectManifest(resolvedProjectDir);
    if (!manifest.transcript) {
      const expectedManifest = JSON.parse(JSON.stringify(manifest));
      manifest.transcript = {
        words: 'transcript/words.json',
        captions: 'transcript/captions.js',
      };
      writeProjectManifest(resolvedProjectDir, manifest, { expectedManifest });
    }
    assertMatchingSource(resolvedProjectDir, manifest, sourcePath);
    ensureProjectDirectories(resolvedProjectDir);
    return asWorkspace(resolvedProjectDir, manifest);
  }

  if (!name) throw new Error('для нового проекта нужно название');
  if (!sourcePath) throw new Error('для нового проекта нужен исходник');
  const originalPath = path.resolve(sourcePath);
  if (!fs.existsSync(originalPath) || !fs.statSync(originalPath).isFile()) {
    throw new Error(`исходник не найден: ${originalPath}`);
  }

  const slug = slugifyProjectName(name);
  const id = projectDir ? path.basename(resolvedProjectDir) : formatProjectId({ date: now, name });
  const extension = path.extname(originalPath).toLowerCase() || '.mp4';
  const sourceName = projectKind === 'motion-reel' && mediaKind === 'audio'
    ? 'narration'
    : 'source';
  const localPath = path.posix.join('input', `${sourceName}${extension}`);
  const timestamp = now.toISOString();
  const manifest = {
    version: 1,
    projectKind,
    id,
    name,
    slug,
    createdAt: timestamp,
    updatedAt: timestamp,
    source: {
      mediaKind,
      originalPath,
      originalLocalPath: localPath,
      localPath,
      revision: 1,
      history: [],
    },
    transcript: {
      words: 'transcript/words.json',
      captions: 'transcript/captions.js',
    },
    briefs: [],
    renders: [],
    currentBrief: null,
    latestRender: null,
    final: path.posix.join('final', `${slug}.mp4`),
  };

  ensureProjectDirectories(resolvedProjectDir);
  const localSourcePath = resolveProjectPath(resolvedProjectDir, localPath, {
    label: 'manifest.source.localPath',
    mustExist: false,
  });
  copyProjectFileNoReplace({
    projectDir: resolvedProjectDir,
    sourcePath: originalPath,
    storedPath: localPath,
  });
  writeProjectManifest(resolvedProjectDir, manifest);
  return asWorkspace(resolvedProjectDir, manifest);
}

function formatVersion(number) {
  return `v${String(number).padStart(2, '0')}`;
}

function relativeProjectPath(workspace, filePath) {
  const relative = path.relative(workspace.dir, path.resolve(filePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('путь должен находиться внутри проекта');
  }
  return relative.split(path.sep).join('/');
}

function nextBriefPaths(workspace, kind = 'lesson', { fileSystem = fs } = {}) {
  const highestRevision = workspace.manifest.briefs.reduce(
    (highest, brief) => Math.max(highest, Number(brief.revision) || 0),
    0,
  );
  resolveProjectPath(workspace.dir, 'brief', {
    label: 'project directory brief',
    fileSystem,
    mustExist: true,
    type: 'directory',
  });
  let revision = highestRevision + 1;
  while (true) {
    const prefix = `${formatVersion(revision)}-draft.${kind}`;
    const jsonPath = resolveProjectPath(workspace.dir, path.posix.join('brief', `${prefix}.json`), {
      label: 'next brief JSON path',
      fileSystem,
      mustExist: false,
      type: 'file',
    });
    const markdownPath = resolveProjectPath(workspace.dir, path.posix.join('brief', `${prefix}.md`), {
      label: 'next brief Markdown path',
      fileSystem,
      mustExist: false,
      type: 'file',
    });
    if (!lstatIfPresent(fileSystem, jsonPath) && !lstatIfPresent(fileSystem, markdownPath)) {
      return { revision, jsonPath, markdownPath };
    }
    revision += 1;
  }
}

function recordBrief(workspace, {
  revision,
  jsonPath,
  markdownPath,
  status,
  kind = 'lesson',
  theme = null,
  aspect = null,
}, options = {}) {
  return withProjectMutation(workspace, (transaction) => {
    const entry = {
      kind,
      revision,
      jsonPath: relativeProjectPath(workspace, jsonPath),
      markdownPath: markdownPath ? relativeProjectPath(workspace, markdownPath) : null,
      status,
      theme,
      aspect,
    };
    const nextManifest = JSON.parse(JSON.stringify(transaction.manifest));
    nextManifest.briefs.push(entry);
    nextManifest.currentBrief = entry.jsonPath;
    nextManifest.updatedAt = new Date().toISOString();
    workspace.manifest = transaction.commitManifest(nextManifest, { purpose: 'brief-manifest' });
    return workspace;
  }, options);
}

function publishBriefRevision(workspace, {
  kind = 'lesson',
  brief,
  markdown = null,
  status = brief?.status || 'draft',
  theme = brief?.theme || null,
  aspect = brief?.output?.aspect || null,
}, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const temporaryId = options.temporaryId || randomUUID;
  const briefKind = brief?.kind === 'motion-reel' || kind === 'motion-reel'
    ? 'motion-reel'
    : 'lesson';
  const pathKind = kind === 'motion-reel' ? 'motion' : kind;
  if (briefKind === 'motion-reel') {
    const validation = validateMotionBrief(brief);
    if (!validation.ok) throw new Error(`motion brief is invalid: ${validation.errors.join('\n')}`);
    if (brief.status !== 'draft' || status !== 'draft') {
      throw new Error('initial motion brief publication requires status draft');
    }
  }
  const publishedMarkdown = briefKind === 'motion-reel'
    ? formatMotionBriefMarkdown(brief)
    : markdown;
  return withProjectMutation(workspace, (transaction) => {
    const persistedWorkspace = { ...workspace, manifest: transaction.manifest };
    const allocated = nextBriefPaths(persistedWorkspace, pathKind, { fileSystem });
    const markdownPath = publishedMarkdown === null ? null : allocated.markdownPath;
    const entry = {
      kind: briefKind,
      revision: allocated.revision,
      jsonPath: relativeProjectPath(workspace, allocated.jsonPath),
      markdownPath: markdownPath ? relativeProjectPath(workspace, markdownPath) : null,
      status,
      theme,
      aspect,
    };
    const nextManifest = JSON.parse(JSON.stringify(transaction.manifest));
    nextManifest.briefs.push(entry);
    nextManifest.currentBrief = entry.jsonPath;
    nextManifest.updatedAt = new Date().toISOString();
    const history = stageNoReplaceFileSet([
      ...(markdownPath ? [{
        destination: markdownPath,
        data: publishedMarkdown,
        purpose: 'initial-brief-markdown',
      }] : []),
      {
        destination: allocated.jsonPath,
        data: `${JSON.stringify(brief, null, 2)}\n`,
        purpose: 'initial-brief-json',
      },
    ], { fileSystem, temporaryId });
    let manifestCommitted = false;
    try {
      history.commit();
      workspace.manifest = transaction.commitManifest(nextManifest, {
        purpose: 'initial-brief-manifest',
      });
      manifestCommitted = true;
      return {
        revision: allocated.revision,
        jsonPath: allocated.jsonPath,
        markdownPath,
        relativePath: entry.jsonPath,
      };
    } catch (error) {
      if (!manifestCommitted) {
        try {
          history.rollback();
        } catch (rollbackError) {
          error.rollbackErrors = [rollbackError];
        }
      }
      throw error;
    } finally {
      const cleanup = () => {
        history.cleanup();
      };
      if (manifestCommitted) {
        try {
          cleanup();
        } catch (_) {
          // The history and manifest commit point are already durable.
        }
      } else {
        cleanup();
      }
    }
  }, { ...options, fileSystem, temporaryId });
}

const MANIFEST_CONFLICT = 'PROJECT_MANIFEST_CONFLICT';
const REVIEW_DRAFT_RESERVATION = '.review-draft-reservation';
const PROJECT_MUTATION_LEASE = '.project-mutation.lock';

function manifestConflict() {
  const error = new Error('project manifest changed concurrently; stale snapshot');
  error.code = MANIFEST_CONFLICT;
  return error;
}

function isProvablyDeadLeaseOwner(owner, {
  hostname = os.hostname(),
  killProcess = process.kill,
} = {}) {
  if (!owner || owner.version !== 1 || owner.hostname !== hostname
    || !Number.isInteger(owner.pid) || owner.pid <= 0
    || typeof owner.token !== 'string' || !TEMPORARY_ID.test(owner.token)) {
    return false;
  }
  try {
    killProcess(owner.pid, 0);
    return false;
  } catch (error) {
    return Boolean(error && error.code === 'ESRCH');
  }
}

function readLeaseOwner(fileSystem, leasePath) {
  const snapshot = readFileSnapshot(fileSystem, leasePath);
  let owner;
  try {
    owner = JSON.parse(snapshot.bytes.toString('utf8'));
  } catch (_) {
    throw manifestConflict();
  }
  return { owner, snapshot };
}

function acquireProjectMutationLease(projectDir, {
  fileSystem = fs,
  temporaryId = randomUUID,
  hostname = os.hostname(),
  pid = process.pid,
  killProcess = process.kill,
  now = () => new Date(),
  platform = process.platform,
} = {}) {
  const resolvedProjectDir = path.resolve(projectDir);
  const leasePath = resolveProjectPath(resolvedProjectDir, PROJECT_MUTATION_LEASE, {
    label: 'project mutation lease',
    fileSystem,
    mustExist: false,
    type: 'file',
  });
  const token = safeTemporaryId(temporaryId);
  const owner = {
    version: 1,
    token,
    pid,
    hostname,
    acquiredAt: now().toISOString(),
  };
  const ownerBytes = Buffer.from(`${JSON.stringify(owner)}\n`);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const staged = stageOwnedSiblingFile(leasePath, ownerBytes, {
      fileSystem,
      temporaryId: () => token,
      purpose: 'project-mutation-owner',
      platform,
    });
    try {
      fileSystem.linkSync(staged.path, leasePath);
      const identity = lstatIfPresent(fileSystem, leasePath);
      if (!identity || identity.isSymbolicLink() || !identity.isFile()) throw manifestConflict();
      const committed = { identity, bytes: ownerBytes };
      assertFileSnapshot(fileSystem, leasePath, committed);
      let released = false;
      return {
        path: leasePath,
        owner,
        release() {
          if (released) return;
          let releaseError = null;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              assertFileSnapshot(fileSystem, leasePath, committed);
              fileSystem.unlinkSync(leasePath);
              released = true;
              return;
            } catch (error) {
              releaseError = error;
              if (!lstatIfPresent(fileSystem, leasePath)) {
                released = true;
                return;
              }
            }
          }
          throw releaseError;
        },
      };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    } finally {
      staged.cleanupTemp();
    }

    let existing;
    try {
      existing = readLeaseOwner(fileSystem, leasePath);
    } catch (error) {
      throw manifestConflict();
    }
    if (!isProvablyDeadLeaseOwner(existing.owner, { hostname, killProcess })) {
      throw manifestConflict();
    }
    assertFileSnapshot(fileSystem, leasePath, existing.snapshot);
    const tombstonePath = `${leasePath}.dead-${existing.owner.token}`;
    try {
      fileSystem.linkSync(leasePath, tombstonePath);
      assertFileSnapshot(fileSystem, tombstonePath, existing.snapshot);
      assertFileSnapshot(fileSystem, leasePath, existing.snapshot);
      fileSystem.unlinkSync(leasePath);
      fileSystem.unlinkSync(tombstonePath);
    } catch (error) {
      const tombstone = lstatIfPresent(fileSystem, tombstonePath);
      const current = lstatIfPresent(fileSystem, leasePath);
      if (!current && tombstone && sameFileIdentity(tombstone, existing.snapshot.identity)) {
        try {
          fileSystem.unlinkSync(tombstonePath);
        } catch (_) {
          // The dead lease path is already gone; the tombstone cannot block acquisition.
        }
        continue;
      }
      if (error && error.code === 'EEXIST'
        && tombstone && current
        && sameFileIdentity(tombstone, existing.snapshot.identity)
        && sameFileIdentity(current, existing.snapshot.identity)) {
        fileSystem.unlinkSync(tombstonePath);
        continue;
      }
      throw manifestConflict();
    }
  }
  throw manifestConflict();
}

function withProjectMutation(workspace, operation, {
  fileSystem = fs,
  temporaryId = randomUUID,
  mutationLease = null,
  expectedManifest = workspace.manifest,
  hostname,
  pid,
  killProcess,
  now,
  platform = process.platform,
} = {}) {
  const lease = mutationLease || acquireProjectMutationLease(workspace.dir, {
    fileSystem, temporaryId, hostname, pid, killProcess, now, platform,
  });
  const ownsLease = !mutationLease;
  let operationError = null;
  try {
    const manifestPath = resolveProjectPath(workspace.dir, 'project.json', {
      label: 'project.json', fileSystem, mustExist: true, type: 'file',
    });
    let manifestSnapshot = readFileSnapshot(fileSystem, manifestPath);
    let persistedManifest = validateProjectManifest(
      JSON.parse(manifestSnapshot.bytes.toString('utf8')),
      { projectDir: workspace.dir, fileSystem },
    );
    if (expectedManifest !== false
      && canonicalJsonHash(persistedManifest) !== canonicalJsonHash(expectedManifest)) {
      throw manifestConflict();
    }
    const transaction = {
      lease,
      get manifest() {
        return persistedManifest;
      },
      commitManifest(nextManifest, { purpose = 'project-mutation-manifest', assertCurrent = () => {} } = {}) {
        const validated = validateProjectManifest(nextManifest, {
          projectDir: workspace.dir,
          fileSystem,
        });
        const bytes = Buffer.from(`${JSON.stringify(validated, null, 2)}\n`);
        const staged = stageOwnedSiblingFile(manifestPath, bytes, {
          fileSystem,
          temporaryId,
          purpose,
          platform,
        });
        let committed = false;
        try {
          assertFileSnapshot(fileSystem, manifestPath, manifestSnapshot);
          assertCurrent();
          manifestSnapshot = staged.commitReplace();
          committed = true;
          persistedManifest = validated;
          return validated;
        } finally {
          if (!committed) staged.cleanupTemp();
          else {
            try {
              staged.cleanupTemp();
            } catch (_) {
              // The manifest replacement is already the transaction commit point.
            }
          }
        }
      },
    };
    return operation(transaction);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (ownsLease) {
      try {
        lease.release();
      } catch (releaseError) {
        if (operationError) operationError.leaseReleaseError = releaseError;
        else throw releaseError;
      }
    }
  }
}

function canonicalJsonHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function matchesExpectedHash(value, expectedHash) {
  if (expectedHash === undefined) return true;
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  const actual = Buffer.from(canonicalJsonHash(value));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function readFileSnapshot(fileSystem, filePath) {
  const before = lstatIfPresent(fileSystem, filePath);
  if (!before || before.isSymbolicLink() || !before.isFile()) throw manifestConflict();
  const bytes = fileSystem.readFileSync(filePath);
  const after = lstatIfPresent(fileSystem, filePath);
  if (!after || !sameFileIdentity(before, after)) throw manifestConflict();
  return { identity: after, bytes: Buffer.from(bytes) };
}

function assertFileSnapshot(fileSystem, filePath, expected) {
  const current = readFileSnapshot(fileSystem, filePath);
  if (!sameFileIdentity(current.identity, expected.identity)
    || !current.bytes.equals(expected.bytes)) {
    throw manifestConflict();
  }
}

function isBrowserMediaPseudoPath(value) {
  if (typeof value !== 'string') return false;
  try {
    const normalized = new URL(value, 'http://review.invalid');
    return normalized.pathname === '/media' || normalized.pathname.startsWith('/media/');
  } catch (_) {
    return false;
  }
}

function saveDraftRevisionReserved(workspace, {
  baseJsonPath,
  brief,
  fileSystem = fs,
  temporaryId = randomUUID,
  expectedManifestHash,
  expectedBaseHash,
} = {}) {
  const baseRelativePath = relativeProjectPath(workspace, path.resolve(baseJsonPath));
  const sessionEntry = workspace.manifest.briefs.find(
    (entry) => entry.jsonPath === baseRelativePath,
  );
  if (!sessionEntry) throw new Error('base brief is not registered in project.json');
  if (workspace.manifest.currentBrief !== baseRelativePath) {
    throw new Error('base brief is stale: it is not current for this session');
  }

  const manifestPath = resolveProjectPath(workspace.dir, 'project.json', {
    label: 'project.json',
    fileSystem,
    mustExist: true,
    type: 'file',
  });
  const oldManifestSnapshot = readFileSnapshot(fileSystem, manifestPath);
  const oldManifest = oldManifestSnapshot.bytes.toString('utf8');
  const persistedManifest = validateProjectManifest(JSON.parse(oldManifest), {
    projectDir: workspace.dir,
    fileSystem,
  });
  if (!matchesExpectedHash(persistedManifest, expectedManifestHash)) throw manifestConflict();
  const baseEntry = persistedManifest.briefs.find(
    (entry) => entry.jsonPath === baseRelativePath,
  );
  if (!baseEntry) throw new Error('base brief is not registered in project.json');
  if (persistedManifest.currentBrief !== baseRelativePath) {
    throw new Error('base brief is stale: it is no longer current');
  }
  const resolvedBasePath = resolveProjectPath(workspace.dir, baseEntry.jsonPath, {
    label: 'base brief JSON path',
    fileSystem,
    mustExist: true,
    type: 'file',
  });
  const baseBriefSnapshot = readFileSnapshot(fileSystem, resolvedBasePath);
  const baseBrief = JSON.parse(baseBriefSnapshot.bytes.toString('utf8'));
  const baseContract = baseEntry.kind === 'motion-reel'
    ? { validate: validateMotionBrief, format: formatMotionBriefMarkdown, pathKind: 'motion' }
    : { validate: validateLessonBrief, format: formatBriefMarkdown, pathKind: 'lesson' };
  const baseValidation = baseContract.validate(baseBrief);
  if (!baseValidation.ok) throw new Error(`base brief is invalid: ${baseValidation.errors.join('\n')}`);
  if (!matchesExpectedHash(baseBrief, expectedBaseHash)) throw manifestConflict();

  let draftJson;
  try {
    draftJson = JSON.stringify({ ...brief, status: 'draft' }, null, 2);
  } catch (_) {
    throw new Error('candidate brief is not canonical JSON');
  }
  if (draftJson === undefined) throw new Error('candidate brief is not canonical JSON');
  const draftBrief = JSON.parse(draftJson);
  const validation = baseContract.validate(draftBrief);
  if (!validation.ok) throw new Error(`candidate brief is invalid: ${validation.errors.join('\n')}`);

  const pathValues = [
    draftBrief.source,
    draftBrief.music && draftBrief.music.file,
    ...draftBrief.scenes.flatMap((scene) => [scene.brollSrc, scene.faceSrc]),
  ];
  if (pathValues.some(isBrowserMediaPseudoPath)) {
    throw new Error('candidate brief contains a browser media pseudo-path');
  }
  if (draftBrief.scenes.some((scene) => (
    typeof scene.brollSrc === 'string' && /^asset-[1-9]\d*$/.test(scene.brollSrc)
  ))) {
    throw new Error('candidate brief contains an unresolved opaque asset id');
  }
  for (const field of ['source', 'theme', 'output']) {
    if (!isDeepStrictEqual(draftBrief[field], baseBrief[field])) {
      throw new Error(`candidate brief changes protected identity field ${field}`);
    }
  }
  if (isDeepStrictEqual(draftBrief, { ...baseBrief, status: 'draft' })) {
    throw new Error('ничего не изменено');
  }

  const allocationWorkspace = { ...workspace, manifest: persistedManifest };
  const allocated = nextBriefPaths(allocationWorkspace, baseContract.pathKind, { fileSystem });
  const jsonPath = resolveProjectPath(
    workspace.dir,
    relativeProjectPath(workspace, allocated.jsonPath),
    { label: 'next review JSON path', fileSystem, mustExist: false, type: 'file' },
  );
  const markdownPath = resolveProjectPath(
    workspace.dir,
    relativeProjectPath(workspace, allocated.markdownPath),
    { label: 'next review Markdown path', fileSystem, mustExist: false, type: 'file' },
  );
  for (const [label, destination] of [
    ['next review JSON path', jsonPath],
    ['next review Markdown path', markdownPath],
  ]) {
    if (lstatIfPresent(fileSystem, destination)) throw new Error(`${label} already exists`);
  }

  const entry = {
    kind: baseEntry.kind,
    revision: allocated.revision,
    jsonPath: relativeProjectPath(workspace, jsonPath),
    markdownPath: relativeProjectPath(workspace, markdownPath),
    status: 'draft',
    theme: typeof draftBrief.theme === 'string'
      ? draftBrief.theme
      : (draftBrief.theme && draftBrief.theme.id) || baseEntry.theme,
    aspect: draftBrief.output.aspect,
  };
  const nextManifest = JSON.parse(JSON.stringify(persistedManifest));
  nextManifest.briefs.push(entry);
  nextManifest.currentBrief = entry.jsonPath;
  nextManifest.updatedAt = new Date().toISOString();
  const validatedManifest = validateProjectManifest(nextManifest, {
    projectDir: workspace.dir,
    fileSystem,
  });
  const nextManifestBytes = Buffer.from(`${JSON.stringify(validatedManifest, null, 2)}\n`);
  const committedBaseHash = canonicalJsonHash(draftBrief);
  const committedManifestHash = canonicalJsonHash(validatedManifest);
  const markdown = baseContract.format(draftBrief);
  const stages = [];
  let manifestStage;
  let markdownStage;
  let jsonStage;
  let rollbackStage;
  let manifestCommitted = false;
  let committedManifestSnapshot = null;
  let preserveStages = false;
  let fullyCommitted = false;
  try {
    manifestStage = stageOwnedSiblingFile(
      manifestPath,
      nextManifestBytes,
      { fileSystem, temporaryId, purpose: 'review-draft-manifest' },
    );
    stages.push(manifestStage);
    markdownStage = stageOwnedSiblingFile(markdownPath, markdown, {
      fileSystem,
      temporaryId,
      purpose: 'review-draft-markdown',
    });
    stages.push(markdownStage);
    jsonStage = stageOwnedSiblingFile(jsonPath, `${draftJson}\n`, {
      fileSystem,
      temporaryId,
      purpose: 'review-draft-json',
    });
    stages.push(jsonStage);
    rollbackStage = stageOwnedSiblingFile(manifestPath, oldManifest, {
      fileSystem,
      temporaryId,
      purpose: 'review-draft-rollback',
    });
    stages.push(rollbackStage);

    assertFileSnapshot(fileSystem, resolvedBasePath, baseBriefSnapshot);
    assertFileSnapshot(fileSystem, manifestPath, oldManifestSnapshot);
    markdownStage.commitNoReplace();
    jsonStage.commitNoReplace();
    assertFileSnapshot(fileSystem, manifestPath, oldManifestSnapshot);
    manifestStage.commitReplace();
    manifestCommitted = true;
    const committedIdentity = lstatIfPresent(fileSystem, manifestPath);
    if (!committedIdentity || committedIdentity.isSymbolicLink() || !committedIdentity.isFile()) {
      throw manifestConflict();
    }
    committedManifestSnapshot = {
      identity: committedIdentity,
      bytes: nextManifestBytes,
    };
    assertFileSnapshot(fileSystem, manifestPath, committedManifestSnapshot);
    fullyCommitted = true;
  } catch (error) {
    const rollbackErrors = [];
    preserveStages = error.code === MANIFEST_CONFLICT;
    if (!manifestCommitted && !preserveStages) {
      try {
        assertFileSnapshot(fileSystem, manifestPath, oldManifestSnapshot);
      } catch (concurrentError) {
        preserveStages = true;
        error.concurrentError = concurrentError;
      }
    }
    if (manifestCommitted) {
      try {
        assertFileSnapshot(fileSystem, manifestPath, committedManifestSnapshot);
        rollbackStage.commitReplace(manifestPath);
        manifestCommitted = false;
        const restoredManifest = readFileSnapshot(fileSystem, manifestPath);
        if (!restoredManifest.bytes.equals(oldManifestSnapshot.bytes)) throw manifestConflict();
      } catch (rollbackError) {
        preserveStages = true;
        rollbackErrors.push(rollbackError);
      }
    }
    if (!preserveStages && !manifestCommitted) {
      for (const stage of [jsonStage, markdownStage]) {
        try {
          if (stage) stage.removeCommitted();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
    }
    if (rollbackErrors.length) error.rollbackErrors = rollbackErrors;
    throw error;
  } finally {
    if (!preserveStages) {
      for (const stage of stages) {
        if (!fullyCommitted) {
          stage.cleanupTemp();
        } else {
          try {
            stage.cleanupTemp();
          } catch (_) {
            // The revision is already fully committed. Keep an owned temp as diagnostic evidence.
          }
        }
      }
    }
  }
  workspace.manifest = validatedManifest;
  return {
    revision: allocated.revision,
    jsonPath,
    markdownPath,
    relativePath: entry.jsonPath,
    baseHash: committedBaseHash,
    manifestHash: committedManifestHash,
  };
}

function saveDraftRevision(workspace, options = {}) {
  const fileSystem = options.fileSystem || fs;
  if (lstatIfPresent(fileSystem, path.join(path.resolve(workspace.dir), REVIEW_DRAFT_RESERVATION))) {
    throw manifestConflict();
  }
  return withProjectMutation(
    workspace,
    () => saveDraftRevisionReserved(workspace, { ...options, fileSystem }),
    { ...options, fileSystem },
  );
}

function approveBrief(workspace, draftJsonPath, {
  confirmPreviewViewed = false,
  expectedPreviewSha256,
  fileSystem = fs,
  temporaryId = randomUUID,
  root = path.resolve(__dirname, '../..'),
  runToolImpl,
  mutationLease = null,
  platform = process.platform,
} = {}) {
  return withProjectMutation(workspace, (transaction) => {
    const persistedManifest = transaction.manifest;
    const persistedWorkspace = { ...workspace, manifest: persistedManifest };
    const draftRelativePath = relativeProjectPath(workspace, path.resolve(draftJsonPath));
    const draftEntry = persistedManifest.briefs.find(
      (brief) => brief.jsonPath === draftRelativePath,
    );
    if (!draftEntry) throw new Error('черновик не зарегистрирован в project.json');
    if (persistedManifest.currentBrief !== draftRelativePath) throw manifestConflict();
    const draftPath = resolveProjectPath(workspace.dir, draftEntry.jsonPath, {
      label: 'manifest.briefs[].jsonPath',
      fileSystem,
      mustExist: true,
      type: 'file',
    });
    if (!/-draft\.[^.]+\.json$/i.test(draftPath)) {
      throw new Error('имя черновика должно содержать -draft');
    }
    const draftSnapshot = readFileSnapshot(fileSystem, draftPath);
    const draft = JSON.parse(draftSnapshot.bytes.toString('utf8'));
    if (draft.status !== 'draft') throw new Error('утвердить можно только brief со статусом draft');
    const briefKind = draftEntry.kind;
    const briefContract = briefKind === 'motion-reel'
      ? { validate: validateMotionBrief, format: formatMotionBriefMarkdown }
      : { validate: validateLessonBrief, format: formatBriefMarkdown };
    if (briefKind === 'lesson') preflightBriefBrollMedia(draft);
    const draftValidation = briefContract.validate(draft);
    if (!draftValidation.ok) {
      throw new Error(`draft brief is invalid: ${draftValidation.errors.join('\n')}`);
    }
    for (const [index, scene] of briefKind === 'lesson' ? draft.scenes.entries() : []) {
      if (scene?.scene === 'broll' && scene.brollIntent && !scene.brollMedia && !scene.brollSrc) {
        throw new Error(`scenes[${index}].brollIntent: unresolved b-roll intent cannot be approved`);
      }
    }
    for (const [index, scene] of briefKind === 'lesson' ? draft.scenes.entries() : []) {
      if (scene?.scene === 'broll' && !scene.brollMedia && !isRenderableBrollSource(scene.brollSrc)) {
        throw new Error(`scenes[${index}].brollSrc: b-roll поддерживает только изображения`);
      }
    }

    const approvedJsonPath = draftPath.replace(/-draft(\.[^.]+\.json)$/i, '-approved$1');
    const approvedJsonRelativePath = relativeProjectPath(workspace, approvedJsonPath);
    resolveProjectPath(workspace.dir, approvedJsonRelativePath, {
      label: 'approved brief JSON path',
      fileSystem,
      mustExist: false,
    });
    const draftMarkdownPath = draftEntry.markdownPath
      ? resolveProjectPath(workspace.dir, draftEntry.markdownPath, {
        label: 'manifest.briefs[].markdownPath',
        fileSystem,
        mustExist: true,
        type: 'file',
      })
      : null;
    const approvedMarkdownPath = draftMarkdownPath
      ? draftMarkdownPath.replace(/-draft(\.[^.]+\.md)$/i, '-approved$1')
      : null;
    if (approvedMarkdownPath) {
      resolveProjectPath(workspace.dir, relativeProjectPath(workspace, approvedMarkdownPath), {
        label: 'approved brief Markdown path',
        fileSystem,
        mustExist: false,
      });
    }
    for (const [label, destination] of [
      ['approved brief JSON path', approvedJsonPath],
      ['approved brief Markdown path', approvedMarkdownPath],
    ]) {
      if (destination && lstatIfPresent(fileSystem, destination)) {
        throw new Error(`${label} already exists`);
      }
    }
    const approvedBrief = {
      ...draft,
      status: 'approved',
      scenes: draft.scenes.map(({ brollIntent, ...scene }) => scene),
    };
    const mediaVerification = briefKind === 'lesson'
      ? verifyBriefBrollMedia({
        root, workspace: persistedWorkspace, brief: draft, runToolImpl, fileSystem, platform,
      })
      : {
        hasDiscovery: false,
        assertCurrent() {},
        assertIdentity() {},
        close() {},
      };
    let previewVerification = null;
    try {
      const needsPreview = mediaVerification.hasDiscovery || draft.brollReviewPolicy === 'preview-required'
        || draft.scenes.some(scene => scene.brollIntent);
      if (needsPreview) approvedBrief.brollReviewPolicy = 'preview-required';
      previewVerification = needsPreview
        ? require('./preview-workspace').verifyApprovalPreview(persistedWorkspace, draft, draftSnapshot.bytes, { fileSystem, confirmPreviewViewed, expectedPreviewSha256 }) : null;
      if (previewVerification) approvedBrief.brollApproval = previewVerification.receipt;
      const approvedValidation = briefContract.validate(approvedBrief, { requireApproved: true });
      if (!approvedValidation.ok) throw new Error(`approved brief is invalid: ${approvedValidation.errors.join('\n')}`);
    } catch (error) {
      try { mediaVerification.close(); } finally { previewVerification?.close(); }
      throw error;
    }
    const approvedMarkdown = approvedMarkdownPath ? briefContract.format(approvedBrief) : null;
    const entry = {
      kind: briefKind,
      revision: draftEntry.revision,
      jsonPath: approvedJsonRelativePath,
      markdownPath: approvedMarkdownPath
        ? relativeProjectPath(workspace, approvedMarkdownPath)
        : null,
      status: 'approved',
      theme: draftEntry.theme,
      aspect: draftEntry.aspect,
    };
    const nextManifest = JSON.parse(JSON.stringify(persistedManifest));
    nextManifest.briefs.push(entry);
    nextManifest.currentBrief = entry.jsonPath;
    nextManifest.updatedAt = new Date().toISOString();
    const assertApprovalCurrent = () => {
      assertFileSnapshot(fileSystem, draftPath, draftSnapshot);
      mediaVerification.assertCurrent();
      previewVerification?.assertCurrent();
      // All potentially long hashes precede one common fast identity barrier.
      mediaVerification.assertIdentity();
      previewVerification?.assertIdentity();
      const currentDraft = fileSystem.lstatSync(draftPath);
      if (!sameFileIdentity(currentDraft, draftSnapshot.identity) || currentDraft.isSymbolicLink()
        || ['size', 'mtimeMs', 'ctimeMs'].some(key => currentDraft[key] !== draftSnapshot.identity[key])) throw manifestConflict();
    };
    const stages = [];
    let markdownStage = null;
    let jsonStage = null;
    let manifestCommitted = false;
    try {
      if (approvedMarkdownPath) {
        markdownStage = stageOwnedSiblingFile(approvedMarkdownPath, approvedMarkdown, {
          fileSystem,
          temporaryId,
          purpose: 'approval-markdown',
          platform,
        });
        stages.push(markdownStage);
      }
      jsonStage = stageOwnedSiblingFile(
        approvedJsonPath,
        `${JSON.stringify(approvedBrief, null, 2)}\n`,
        { fileSystem, temporaryId, purpose: 'approval-json', platform },
      );
      stages.push(jsonStage);

      assertFileSnapshot(fileSystem, draftPath, draftSnapshot);
      mediaVerification.assertCurrent();
      previewVerification?.assertCurrent();
      if (markdownStage) markdownStage.commitNoReplace();
      jsonStage.commitNoReplace();
      assertFileSnapshot(fileSystem, draftPath, draftSnapshot);
      mediaVerification.assertCurrent();
      previewVerification?.assertCurrent();
      const validatedManifest = transaction.commitManifest(nextManifest, {
        purpose: 'approval-manifest',
        assertCurrent: assertApprovalCurrent,
      });
      manifestCommitted = true;
      workspace.manifest = validatedManifest;
      return {
        revision: draftEntry.revision,
        jsonPath: approvedJsonPath,
        markdownPath: approvedMarkdownPath,
      };
    } catch (error) {
      const rollbackErrors = [];
      if (!manifestCommitted) {
        for (const stage of [jsonStage, markdownStage]) {
          if (!stage) continue;
          try {
            stage.removeCommitted();
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
      }
      if (rollbackErrors.length) error.rollbackErrors = rollbackErrors;
      throw error;
    } finally {
      const cleanup = () => {
        for (const stage of stages) stage.cleanupTemp();
        mediaVerification.close();
        previewVerification?.close();
      };
      if (manifestCommitted) {
        try {
          cleanup();
        } catch (_) {
          // Historical files and the manifest are already durably published.
        }
      } else {
        cleanup();
      }
    }
  }, {
    fileSystem,
    temporaryId,
    mutationLease,
    platform,
  });
}

function nextRenderPaths(workspace, label = 'render') {
  const highestVersion = workspace.manifest.renders.reduce(
    (highest, render) => Math.max(highest, Number(render.version) || 0),
    0,
  );
  const version = highestVersion + 1;
  const safeLabel = slugifyProjectName(label);
  const renderDirectory = path.posix.join('renders', `${formatVersion(version)}-${safeLabel}`);
  resolveProjectPath(workspace.dir, 'renders', {
    label: 'project directory renders',
    mustExist: true,
    type: 'directory',
  });
  const dir = resolveProjectPath(workspace.dir, renderDirectory, {
    label: 'next render directory',
    mustExist: false,
    type: 'directory',
  });
  fs.mkdirSync(dir, { recursive: true });
  resolveProjectPath(workspace.dir, renderDirectory, {
    label: 'next render directory',
    mustExist: true,
    type: 'directory',
  });
  return {
    version,
    label: safeLabel,
    dir,
    propsPath: resolveProjectPath(workspace.dir, path.posix.join(renderDirectory, 'props.json'), {
      label: 'next render props path',
      mustExist: false,
      type: 'file',
    }),
    rawPath: resolveProjectPath(workspace.dir, path.posix.join(renderDirectory, 'raw.mp4'), {
      label: 'next render raw path',
      mustExist: false,
      type: 'file',
    }),
    finalPath: resolveProjectPath(workspace.dir, path.posix.join(renderDirectory, 'final.mp4'), {
      label: 'next render final path',
      mustExist: false,
      type: 'file',
    }),
  };
}

function recordRender(workspace, {
  version,
  label,
  dir,
  briefPath = null,
  status,
}, options = {}) {
  return withProjectMutation(workspace, (transaction) => {
    const entry = {
      version,
      label,
      dir: relativeProjectPath(workspace, dir),
      briefPath: briefPath ? relativeProjectPath(workspace, briefPath) : null,
      status,
    };
    const nextManifest = JSON.parse(JSON.stringify(transaction.manifest));
    const existingIndex = nextManifest.renders.findIndex(
      (render) => Number(render.version) === Number(version),
    );
    if (existingIndex >= 0) {
      nextManifest.renders[existingIndex] = {
        ...nextManifest.renders[existingIndex],
        ...entry,
      };
    } else {
      nextManifest.renders.push(entry);
    }
    if (status === 'complete') nextManifest.latestRender = entry.dir;
    nextManifest.updatedAt = new Date().toISOString();
    workspace.manifest = transaction.commitManifest(nextManifest, { purpose: 'render-manifest' });
    return workspace;
  }, options);
}

function publishFinal(workspace, renderFinalPath, {
  fileSystem = fs,
  temporaryId = randomUUID,
} = {}) {
  const sourceRelativePath = relativeProjectPath(workspace, path.resolve(renderFinalPath));
  const sourcePath = resolveProjectPath(workspace.dir, sourceRelativePath, {
    label: 'render final path',
    fileSystem,
    mustExist: true,
    type: 'file',
  });
  const destination = resolveProjectPath(workspace.dir, workspace.manifest.final, {
    label: 'manifest.final',
    fileSystem,
    mustExist: false,
  });
  const temporaryPath = `${destination}.tmp-${temporaryId()}`;
  let temporaryHandle = null;
  fileSystem.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fileSystem.copyFileSync(sourcePath, temporaryPath);
    temporaryHandle = fileSystem.openSync(temporaryPath, 'r+');
    fileSystem.fsyncSync(temporaryHandle);
    fileSystem.closeSync(temporaryHandle);
    temporaryHandle = null;
    fileSystem.renameSync(temporaryPath, destination);
    return destination;
  } finally {
    if (temporaryHandle !== null) fileSystem.closeSync(temporaryHandle);
    if (fileSystem.existsSync(temporaryPath)) fileSystem.unlinkSync(temporaryPath);
  }
}

function runRenderLifecycle(workspace, render, operation, {
  publish = publishFinal,
} = {}) {
  if (!workspace) return operation();
  const metadata = {
    version: render.version,
    label: render.label,
    dir: render.dir,
    briefPath: render.briefPath || null,
  };
  return withProjectMutation(workspace, (transaction) => {
    const options = { mutationLease: transaction.lease };
    recordRender(workspace, { ...metadata, status: 'started' }, options);
    try {
      const renderFinalPath = operation();
      const destination = publish(workspace, renderFinalPath);
      recordRender(workspace, { ...metadata, status: 'complete' }, options);
      return destination;
    } catch (error) {
      try {
        recordRender(workspace, { ...metadata, status: 'failed' }, options);
      } catch (manifestError) {
        error.manifestError = manifestError;
      }
      throw error;
    }
  });
}

module.exports = {
  acquireProjectMutationLease,
  approveBrief,
  copyProjectFileNoReplace,
  createOrOpenProject,
  formatProjectId,
  nextBriefPaths,
  nextRenderPaths,
  publishFinal,
  publishBriefRevision,
  readProjectManifest,
  recordBrief,
  recordRender,
  resolveProjectPath,
  runRenderLifecycle,
  saveDraftRevision,
  slugifyProjectName,
  validateProjectManifest,
  withProjectMutation,
  writeFilesNoReplace,
  writeProjectManifest,
};
