#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FORBIDDEN_ROOTS = [
  'projects/',
  'out/',
  'tmp/',
  'memory/',
  'knowledge/',
];
const FORBIDDEN_FILES = new Set(['MEMORY.md', '_progress.md', '.env']);
const MEDIA_EXTENSIONS = new Set([
  '.mp4', '.mov', '.mkv', '.webm', '.mp3', '.wav', '.m4a',
  '.aac', '.flac', '.png', '.jpg', '.jpeg', '.webp', '.heic',
]);
const slash = '/';
const backslash = '\\\\';
const LOCAL_PATH_PATTERNS = [
  new RegExp([slash, 'Users', slash, '[^/\\s]+', slash].join(''), 'u'),
  new RegExp([slash, 'var', slash, 'folders', slash].join(''), 'u'),
  new RegExp([slash, 'home', slash, '[^/\\s]+', slash].join(''), 'u'),
  new RegExp(['[A-Za-z]:', backslash, 'Users', backslash, '[^\\\\\\s]+', backslash].join(''), 'u'),
];

function runGit(root, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: null,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args[0]} failed while checking public privacy`);
  }
  return result;
}

function splitNull(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return [];
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

function listGitPaths(root, scope) {
  if (scope === 'tracked') {
    return splitNull(runGit(root, ['ls-files', '-z']).stdout);
  }
  if (scope === 'staged') {
    return splitNull(runGit(root, [
      'diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z',
    ]).stdout);
  }
  throw new Error('scope must be tracked or staged');
}

function readGitBlob(root, scope, relativePath) {
  if (scope === 'staged') {
    const result = runGit(root, ['show', `:${relativePath}`], { allowFailure: true });
    return result.status === 0 ? result.stdout : null;
  }

  const target = path.join(root, relativePath);
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return Buffer.from(fs.readlinkSync(target));
    if (!stat.isFile()) return null;
    return fs.readFileSync(target);
  } catch (_) {
    return null;
  }
}

function parseAssetTable(buffer) {
  if (!Buffer.isBuffer(buffer)) return new Set();
  const assets = new Set();
  for (const rawLine of buffer.toString('utf8').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line.startsWith('|') || !line.endsWith('|')) continue;
    const cells = line.slice(1, -1).split('|').map((cell) => cell.trim());
    if (cells.length !== 6) continue;
    const match = /^`([^`]+)`$/u.exec(cells[0]);
    if (match) assets.add(match[1]);
  }
  return assets;
}

function environmentFile(relativePath) {
  const basename = path.posix.basename(relativePath);
  return basename.startsWith('.env') && basename !== '.env.example';
}

function forbiddenRoot(relativePath) {
  return FORBIDDEN_ROOTS.find((root) => relativePath.startsWith(root));
}

function providerPrivacyIssues(relativePath, content) {
  const issues = [];
  const basename = path.posix.basename(relativePath);
  const isConfig = basename.startsWith('.env') || /\.(?:json|ya?ml|toml|ini|conf)$/iu.test(basename)
    || /(?:^|\/)config(?:\/|\.)/u.test(relativePath);
  const placeholder = value => !value || /^<[A-Za-z0-9_-]+>$/u.test(value);
  if (isConfig) {
    let assignments = content;
    if (/\.json$/iu.test(relativePath)) {
      try { assignments = JSON.stringify(JSON.parse(content)); } catch (_) { /* scan malformed config as text */ }
    }
    // Match assignments, not arbitrary prose or programmatic environment reads.
    const assignment = /(?:^|[\s{,])(?:export[ \t]+)?["']?(ELEVENLABS_API_KEY|ELEVENLABS_VOICE_ID|elevenlabs_api_key|elevenlabs_voice_id|elevenlabsApiKey|elevenlabsVoiceId|xi-api-key)["']?[ \t]*[:=][ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s#,}\r\n]*))/gmu;
    for (const match of assignments.matchAll(assignment)) {
      const value = (match[2] ?? match[3] ?? match[4]).trim();
      if (placeholder(value)) continue;
      const voice = /voice/i.test(match[1]);
      issues.push({ path: relativePath, rule: voice ? 'private-voice-id' : 'provider-secret',
        message: voice ? 'provider voice identity must remain private; use an empty placeholder'
          : 'provider credentials must remain private; use an empty placeholder' });
    }
  }
  if (/(?:^|\/)(?:voice-cache|narration-cache)(?:\/|$)/u.test(relativePath)
    || (/\.json$/iu.test(relativePath) && /"audio_base64"\s*:/u.test(content))) {
    issues.push({ path: relativePath, rule: 'provider-output', message: 'narration provider output belongs only in ignored project workspaces' });
  }
  return issues;
}

function inspectPathsAndContents({ root, scope, paths, assets }) {
  const issues = [];
  for (const relativePath of paths) {
    const normalized = relativePath.replaceAll('\\', '/');
    const basename = path.posix.basename(normalized);
    const rootMatch = forbiddenRoot(normalized);
    if (rootMatch) {
      issues.push({
        path: relativePath,
        rule: 'forbidden-project-path',
        message: `forbidden project path under ${rootMatch}`,
      });
    }
    if (FORBIDDEN_FILES.has(basename) && basename !== '.env') {
      issues.push({
        path: relativePath,
        rule: 'local-project-state',
        message: 'local project state must not be public',
      });
    }
    if (environmentFile(normalized) || basename === '.env') {
      issues.push({
        path: relativePath,
        rule: 'environment-file',
        message: 'private environment file is not allowed; publish only .env.example',
      });
    }
    const extension = path.posix.extname(normalized).toLowerCase();
    if (MEDIA_EXTENSIONS.has(extension) && !assets.has(normalized)) {
      issues.push({
        path: relativePath,
        rule: 'asset-provenance',
        message: 'binary media must have a six-column ASSETS.md entry',
      });
    }

    const bytes = readGitBlob(root, scope, relativePath);
    if (!Buffer.isBuffer(bytes)) {
      issues.push({
        path: relativePath,
        rule: 'unreadable-tracked-file',
        message: 'tracked content could not be inspected',
      });
      continue;
    }
    const content = bytes.toString('utf8');
    issues.push(...providerPrivacyIssues(normalized, content));
    if (LOCAL_PATH_PATTERNS.some((pattern) => pattern.test(content))) {
      issues.push({
        path: relativePath,
        rule: 'absolute-local-path',
        message: 'absolute local path is not allowed in public content',
      });
    }
  }
  return issues;
}

function checkPublicPrivacy({ root = process.cwd(), scope = 'tracked' } = {}) {
  const resolvedRoot = path.resolve(root);
  const paths = listGitPaths(resolvedRoot, scope);
  const assets = parseAssetTable(readGitBlob(resolvedRoot, scope, 'ASSETS.md'));
  const issues = inspectPathsAndContents({
    root: resolvedRoot,
    scope,
    paths,
    assets,
  });
  return { ok: issues.length === 0, issues };
}

function parseCliScope(argv) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--tracked')) return 'tracked';
  if (argv.length === 1 && argv[0] === '--staged') return 'staged';
  throw new Error('usage: node scripts/check-public-privacy.js [--tracked|--staged]');
}

function main(argv = process.argv.slice(2)) {
  try {
    const scope = parseCliScope(argv);
    const result = checkPublicPrivacy({ scope });
    if (result.ok) {
      console.log(`public privacy check passed (${scope})`);
      return;
    }
    for (const issue of result.issues) {
      console.error(`[${issue.rule}] ${issue.path}: ${issue.message}`);
    }
    process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'public privacy check failed');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  checkPublicPrivacy,
  inspectPathsAndContents,
  listGitPaths,
  parseAssetTable,
  readGitBlob,
};
