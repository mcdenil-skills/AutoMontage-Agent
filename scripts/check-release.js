#!/usr/bin/env node
const path = require('node:path');
const { captureTool } = require('./process');

const ROOT = path.resolve(__dirname, '..');
const MAX_GIT_OUTPUT = 128 * 1024 * 1024;
const EM_DASH = String.fromCodePoint(0x2014);
const BINARY_ASSET = /\.(?:png|jpe?g|gif|webp|avif|svg|mp4|mov|m4v|webm|mp3|wav|m4a|aac|flac|ogg|woff2?|ttf|otf)$/i;
const TEXT_FILE = /(?:^|\/)(?:[^/]+\.(?:c?js|jsx|mjs|json|md|html|css|py|sh|toml|ya?ml|txt)|\.env\.example)$/i;
const CANONICAL_MARKDOWN = new Set([
  'AGENTS.md',
  'ARCHITECTURE.md',
  'ASSETS.md',
  'CHANGELOG.md',
  'DECISIONS.md',
  'README.md',
  'TESTING.md',
  'SECURITY.md',
  'docs/TEMPLATES.md',
]);
const INHERITED_SYSTEM_ENV = new Set(['PATH']);
const PRIVATE_PATTERNS = [
  { rule: 'private-id', pattern: new RegExp(['dima', 'grunge'].join('-'), 'gi'), label: 'private theme id' },
  { rule: 'private-id', pattern: new RegExp(['@MCD', 'ENIL'].join(''), 'gi'), label: 'private handle' },
  { rule: 'private-id', pattern: new RegExp(['C', '0027'].join(''), 'gi'), label: 'private media id' },
  { rule: 'personal-path', pattern: /\/Users\//g, label: 'macOS personal path' },
  { rule: 'personal-path', pattern: /C:\\Users\\/gi, label: 'Windows personal path' },
];

function gitCapture(cwd, args, stage) {
  return captureTool('git', args, {
    cwd,
    stage,
    maxBuffer: MAX_GIT_OUTPUT,
  });
}

function resolveTree(cwd, ref, kind) {
  try {
    return gitCapture(
      cwd,
      ['rev-parse', '--verify', '--end-of-options', `${ref}^{tree}`],
      `resolve ${kind}`,
    ).trim();
  } catch (error) {
    const fetch = kind === 'base'
      ? 'git fetch --all --prune'
      : 'git fetch --all --prune, then choose an existing --tree ref';
    throw new Error(`${kind} ref "${ref}" is unavailable. Run ${fetch}.`);
  }
}

function listTreeFiles(cwd, treeSha) {
  return gitCapture(
    cwd,
    ['ls-tree', '-r', '-z', '--name-only', treeSha],
    'list release tree',
  ).split('\0').filter(Boolean);
}

function readTreeFile(cwd, treeSha, file) {
  return gitCapture(cwd, ['show', `${treeSha}:${file}`], `read ${file}`);
}

function addedTreeLines(cwd, baseSha, treeSha) {
  const source = gitCapture(
    cwd,
    [
      '-c', 'core.quotePath=false',
      'diff', '--unified=0', '--no-color', '--no-ext-diff', '--no-renames',
      baseSha, treeSha, '--',
    ],
    'compare release trees',
  );
  const additions = [];
  let file = null;
  let nextLine = null;
  for (const line of source.split('\n')) {
    if (line.startsWith('+++ b/')) {
      file = line.slice(6);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      nextLine = Number(hunk[1]);
      continue;
    }
    if (!file || nextLine == null || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      additions.push({ file, line: nextLine, source: line.slice(1) });
      nextLine += 1;
    } else if (!line.startsWith('-') && !line.startsWith('\\')) {
      nextLine += 1;
    }
  }
  return additions;
}

function lineNumber(source, index) {
  return source.slice(0, Math.max(0, index)).split('\n').length;
}

function issue(rule, file, line, message, remediation) {
  return { rule, file, line, message, remediation };
}

function formatIssue(entry) {
  return `[${entry.rule}] ${entry.file}:${entry.line}: ${entry.message} Fix: ${entry.remediation}`;
}

function jsonValue(source, file, issues, label) {
  try {
    return JSON.parse(source);
  } catch (error) {
    issues.push(issue(
      'json-parse', file, 1,
      `${label} is not valid JSON (${error.message})`,
      `repair ${file} and commit the result.`,
    ));
    return null;
  }
}

function keyLine(source, key) {
  const index = source.indexOf(`"${key}"`);
  return index < 0 ? 1 : lineNumber(source, index);
}

function parseUtcCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

function releaseDateForVersion(source, version) {
  const escapedVersion = String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...String(source || '').matchAll(
    new RegExp(`^## \\[${escapedVersion}\\] - (\\d{4}-\\d{2}-\\d{2})\\s*$`, 'gm'),
  )];
  return matches.length === 1 ? parseUtcCalendarDate(matches[0][1]) : null;
}

function resolveInstalledDependency(packages, parentPath, dependencyName) {
  let base = parentPath;
  while (true) {
    const candidate = base
      ? `${base}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`;
    if (packages[candidate]) return candidate;
    if (!base) return null;
    const marker = base.lastIndexOf('/node_modules/');
    base = marker >= 0 ? base.slice(0, marker) : '';
  }
}

function installedNodeVibrantChain(lock) {
  const names = [
    'node-vibrant',
    '@vibrant/image-node',
    '@jimp/custom',
    '@jimp/core',
    'file-type',
  ];
  const packages = lock && lock.packages;
  if (!packages || !packages['']) return null;
  const chain = [];
  let parentPath = '';
  let parent = packages[''];
  for (const name of names) {
    if (!parent.dependencies || typeof parent.dependencies[name] !== 'string') return null;
    const installedPath = resolveInstalledDependency(packages, parentPath, name);
    const installed = installedPath && packages[installedPath];
    if (!installed || typeof installed.version !== 'string' || !installed.version) return null;
    chain.push(`${name}@${installed.version}`);
    parentPath = installedPath;
    parent = installed;
  }
  return chain;
}

function checkPackageMetadata(read, issues) {
  const packageSource = read('package.json');
  const lockSource = read('package-lock.json');
  const readme = read('README.md');
  const pkg = jsonValue(packageSource, 'package.json', issues, 'package.json');
  const lock = jsonValue(lockSource, 'package-lock.json', issues, 'package-lock.json');
  if (!pkg || !lock) return;
  const lockRoot = lock.packages && lock.packages[''];
  const readmeVersion = /\*\*v(\d+\.\d+\.\d+)\*\*/.exec(readme || '');
  const versions = [pkg.version, lock.version, lockRoot && lockRoot.version, readmeVersion && readmeVersion[1]];
  if (versions.some((value) => !value) || new Set(versions).size !== 1) {
    issues.push(issue(
      'version-triplet', 'package.json', keyLine(packageSource, 'version'),
      `release versions differ (${versions.map((value) => value || 'missing').join(', ')})`,
      'make package.json, package-lock.json root entries, and README vX.Y.Z identical.',
    ));
  }
  const packageEngine = pkg.engines && pkg.engines.node;
  const lockEngine = lockRoot && lockRoot.engines && lockRoot.engines.node;
  if (!packageEngine || packageEngine !== lockEngine) {
    issues.push(issue(
      'engine-match', 'package-lock.json', keyLine(lockSource, 'engines'),
      `Node engines differ (package=${packageEngine || 'missing'}, lock=${lockEngine || 'missing'})`,
      'run npm install after setting the same engines.node requirement in package.json.',
    ));
  }
  for (const field of ['license', 'repository', 'homepage', 'bugs']) {
    if (!pkg[field]) {
      issues.push(issue(
        'package-metadata', 'package.json', 1,
        `package metadata field "${field}" is missing`,
        `add a public ${field} value to package.json and refresh package-lock.json.`,
      ));
    }
  }
}

function checkSecurityException(files, read, issues, now) {
  const pkg = jsonValue(read('package.json'), 'package.json', issues, 'package.json');
  if (!pkg || !pkg.dependencies || !pkg.dependencies['node-vibrant']) return;
  const lock = jsonValue(read('package-lock.json'), 'package-lock.json', issues, 'package-lock.json');
  if (!files.includes('SECURITY.md')) {
    issues.push(issue(
      'security-exception', 'SECURITY.md', 1,
      'node-vibrant is present without a tracked security exception',
      'document the accepted advisory, exposure, mitigation, triggers, and revisit date.',
    ));
    return;
  }
  const source = read('SECURITY.md');
  const markers = [...source.matchAll(/```json security-exception\s*\n([\s\S]*?)\n```/g)];
  if (markers.length !== 1) {
    issues.push(issue(
      'security-exception', 'SECURITY.md', 1,
      `exactly one machine-readable security-exception JSON block is required (found ${markers.length})`,
      'keep one fenced `json security-exception` block with the required evidence.',
    ));
    return;
  }
  const [marker] = markers;
  const line = lineNumber(source, marker.index);
  let exception;
  try {
    exception = JSON.parse(marker[1]);
  } catch (error) {
    issues.push(issue(
      'security-exception', 'SECURITY.md', line,
      `security exception JSON is invalid (${error.message})`,
      'repair the fenced JSON without comments or trailing commas.',
    ));
    return;
  }
  const requiredStrings = [
    'ghsa', 'cve', 'severity', 'package', 'fixedIn', 'exposure', 'mitigation', 'decision', 'revisitBy',
    'reviewedAt', 'reviewedFor',
  ];
  const missing = requiredStrings.filter((key) => (
    typeof exception[key] !== 'string' || !exception[key].trim()
  ));
  if (!Array.isArray(exception.chain) || exception.chain.length < 5) missing.push('chain');
  if (!Array.isArray(exception.triggers) || exception.triggers.length < 4) missing.push('triggers');
  const expected = {
    ghsa: 'GHSA-5v7r-6r5c-r473',
    cve: 'CVE-2026-31808',
    severity: 'moderate',
    package: 'file-type@16.5.4',
    fixedIn: 'file-type@21.3.1',
    exposure: 'Optional --autotheme passes only ffmpeg-generated PNG frames to Jimp/Vibrant, not raw ASF input.',
    mitigation: 'Local-only CLI path, at most 20 scaled PNG frames, no direct untrusted-image upload into file-type.',
    decision: 'Keep node-vibrant@4.0.4; do not force-fix, override the major chain, or downgrade to 3.x.',
  };
  const incorrect = Object.entries(expected)
    .filter(([key, value]) => exception[key] !== value)
    .map(([key]) => key);
  const expectedChain = [
    'node-vibrant@4.0.4',
    '@vibrant/image-node@4.0.4',
    '@jimp/custom@0.22.12',
    '@jimp/core@0.22.12',
    'file-type@16.5.4',
  ];
  if (Array.isArray(exception.chain)
    && (exception.chain.length !== expectedChain.length
      || expectedChain.some((entry, index) => exception.chain[index] !== entry))) {
    incorrect.push('chain');
  }
  const installedChain = installedNodeVibrantChain(lock);
  if (!installedChain
    || installedChain.length !== expectedChain.length
    || expectedChain.some((entry, index) => installedChain[index] !== entry)
    || (Array.isArray(exception.chain)
      && installedChain.some((entry, index) => exception.chain[index] !== entry))) {
    incorrect.push('chain');
  }
  const requiredTriggers = [
    'upstream node-vibrant/Jimp update',
    'severity becomes high',
    'direct untrusted-image input',
    'next release',
  ];
  if (Array.isArray(exception.triggers)
    && requiredTriggers.some((entry) => !exception.triggers.includes(entry))) {
    incorrect.push('triggers');
  }
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // A public calendar date may legitimately be one day ahead of UTC once UTC+14 has
  // crossed midnight (10:00 UTC). This keeps the gate deterministic in local and CI
  // time zones while still rejecting dates that are not current anywhere on Earth.
  const nextDay = new Date(today.getTime() + 86_400_000);
  const nextDayExistsGlobally = now.getTime() >= today.getTime() + (10 * 60 * 60 * 1000);
  const latestCalendarDate = nextDayExistsGlobally ? nextDay : today;
  const reviewedAt = parseUtcCalendarDate(exception.reviewedAt || '');
  const releaseDate = releaseDateForVersion(read('CHANGELOG.md'), pkg.version);
  if (!reviewedAt || reviewedAt.getTime() > latestCalendarDate.getTime()
    || !releaseDate || reviewedAt.getTime() !== releaseDate.getTime()) {
    incorrect.push('reviewedAt');
  }
  if (exception.reviewedFor !== pkg.version) incorrect.push('reviewedFor');
  if (missing.length || incorrect.length) {
    issues.push(issue(
      'security-exception', 'SECURITY.md', line,
      `security exception is incomplete or inaccurate (${[...new Set([...missing, ...incorrect])].join(', ')})`,
      'record the exact advisory, five-package chain, exposure, mitigation, decision, four triggers, and revisit date.',
    ));
    return;
  }
  const revisit = parseUtcCalendarDate(exception.revisitBy);
  const days = revisit ? (revisit.getTime() - today.getTime()) / 86_400_000 : Number.NaN;
  if (!Number.isFinite(days) || days < 0 || days > 30) {
    issues.push(issue(
      'security-exception', 'SECURITY.md', line,
      `revisitBy ${exception.revisitBy} is expired, invalid, or more than 30 days away`,
      'reassess upstream and set a new evidence-backed date no more than 30 days away.',
    ));
  }
}

function checkReleaseNotes(files, read, issues, { releaseCandidate = false } = {}) {
  if (!files.includes('CHANGELOG.md')) {
    issues.push(issue(
      'release-notes', 'CHANGELOG.md', 1,
      'versioned release notes are missing',
      'add CHANGELOG.md with a section matching package.json version.',
    ));
    return;
  }
  const packageSource = read('package.json');
  const pkg = jsonValue(packageSource, 'package.json', issues, 'package.json');
  if (!pkg || typeof pkg.version !== 'string') return;
  const source = read('CHANGELOG.md');
  const headings = [...source.matchAll(/^## \[([^\]]+)\](?:\s+-\s+(.+?))?\s*$/gm)];
  const sectionBody = (heading) => {
    const next = headings.find((candidate) => candidate.index > heading.index);
    const start = heading.index + heading[0].length;
    return source.slice(start, next ? next.index : undefined);
  };
  const unreleased = headings.filter((heading) => heading[1] === 'Unreleased' && !heading[2]);
  if (unreleased.length !== 1) {
    issues.push(issue(
      'release-notes', 'CHANGELOG.md', 1,
      'exactly one undated [Unreleased] section is required',
      'keep one ## [Unreleased] heading before the current release section.',
    ));
  } else if (releaseCandidate && sectionBody(unreleased[0]).trim()) {
    issues.push(issue(
      'release-notes', 'CHANGELOG.md', lineNumber(source, unreleased[0].index),
      '[Unreleased] must be whitespace-empty for a release candidate',
      'move every pending bullet into the dated current-version section.',
    ));
  }
  const releases = headings.filter((heading) => heading[1] === pkg.version);
  if (releases.length !== 1) {
    issues.push(issue(
      'release-notes', 'CHANGELOG.md', 1,
      `exactly one release section [${pkg.version}] is required`,
      `add one dated ## [${pkg.version}] section with the final public changes.`,
    ));
    return;
  }
  const [release] = releases;
  const date = parseUtcCalendarDate(release[2] || '');
  if (!date) {
    issues.push(issue(
      'release-notes', 'CHANGELOG.md', lineNumber(source, release.index),
      `release ${pkg.version} requires a dated valid UTC calendar date in YYYY-MM-DD form`,
      `use ## [${pkg.version}] - YYYY-MM-DD with a real calendar date.`,
    ));
  }
  const section = sectionBody(release);
  if (!/^###\s+\S/m.test(section)) {
    issues.push(issue(
      'release-notes', 'CHANGELOG.md', lineNumber(source, release.index),
      `release ${pkg.version} requires at least one ### subsection`,
      'add a release-note subsection such as ### Исправлено.',
    ));
  }
  if (!/^\s*[-*+]\s+\S/m.test(section)) {
    issues.push(issue(
      'release-notes', 'CHANGELOG.md', lineNumber(source, release.index),
      `release ${pkg.version} requires at least one bullet`,
      'add a bullet that describes a shipped public change.',
    ));
  }
  const patch = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version);
  if (patch && Number(patch[3]) > 0 && !/^### Исправлено\s*$/m.test(section)) {
    issues.push(issue(
      'release-notes', 'CHANGELOG.md', lineNumber(source, release.index),
      `patch release ${pkg.version} requires a ### Исправлено subsection`,
      'summarize the backward-compatible fixes under ### Исправлено.',
    ));
  }
}

function checkEnvironment(files, read, issues) {
  const declarations = new Set();
  const envSource = read('.env.example');
  for (const match of envSource.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) declarations.add(match[1]);
  for (const file of files.filter((name) => /\.(?:c?js|jsx|mjs)$/.test(name))) {
    const source = read(file);
    for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
      if (!declarations.has(match[1]) && !INHERITED_SYSTEM_ENV.has(match[1])) {
        issues.push(issue(
          'env-declaration', file, lineNumber(source, match.index),
          `${match[1]} is used but absent from .env.example`,
          `declare ${match[1]}= in .env.example without adding a secret value.`,
        ));
      }
    }
  }
}

function checkPrivateData(files, read, issues) {
  for (const file of files.filter((name) => TEXT_FILE.test(name))) {
    const source = read(file);
    for (const definition of PRIVATE_PATTERNS) {
      definition.pattern.lastIndex = 0;
      for (const match of source.matchAll(definition.pattern)) {
        issues.push(issue(
          definition.rule, file, lineNumber(source, match.index),
          `${definition.label} is present in the public tree`,
          'replace it with a neutral public fixture value.',
        ));
      }
    }
  }
}

function parseAssetRows(source) {
  return source.split('\n').flatMap((line, index) => {
    if (!/^\| `[^`]+` \|/.test(line)) return [];
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    return [{ path: cells[0] ? cells[0].replace(/^`|`$/g, '') : '', cells, line: index + 1 }];
  });
}

function normalizeRepoPath(file) {
  return path.posix.normalize(file.replace(/\\/g, '/').replace(/^\.\//, ''));
}

function checkAssets(files, read, issues) {
  const source = read('ASSETS.md');
  const rows = parseAssetRows(source);
  const inventory = files.filter((file) => BINARY_ASSET.test(file)).map(normalizeRepoPath);
  const byPath = new Map();
  for (const row of rows) {
    const assetPath = normalizeRepoPath(row.path);
    if (row.cells.length !== 6 || row.cells.some((cell) => !cell)) {
      issues.push(issue(
        'asset-provenance', 'ASSETS.md', row.line,
        `asset row for ${row.path || 'unknown path'} must have six non-empty cells`,
        'complete origin, author/license, generator/source, and redistribution basis.',
      ));
    }
    if (byPath.has(assetPath)) {
      issues.push(issue(
        'asset-provenance', 'ASSETS.md', row.line,
        `duplicate provenance row for ${row.path}`,
        'keep exactly one row for each tracked binary.',
      ));
    }
    byPath.set(assetPath, row);
  }
  for (const file of inventory) {
    if (!byPath.has(file)) {
      issues.push(issue(
        'asset-provenance', 'ASSETS.md', 1,
        `${file} is tracked without provenance`,
        `add a complete six-cell ASSETS.md row for ${file}.`,
      ));
    }
  }
  for (const row of rows) {
    const assetPath = normalizeRepoPath(row.path);
    if (row.path && !inventory.includes(assetPath)) {
      issues.push(issue(
        'asset-provenance', 'ASSETS.md', row.line,
        `${row.path} is documented but is not a tracked binary`,
        'remove the stale row or add the intended binary in the same commit.',
      ));
    }
  }
}

function markdownTarget(raw) {
  const target = raw.trim().replace(/^<|>$/g, '').split(/\s+["']/)[0];
  return target.split('#')[0].split('?')[0];
}

function checkMarkdownLinks(files, read, issues) {
  const tracked = new Set(files);
  for (const file of [...CANONICAL_MARKDOWN].filter((name) => tracked.has(name))) {
    const source = read(file);
    for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = markdownTarget(match[1]);
      if (!target || /^(?:[a-z]+:|\/|#)/i.test(target)) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
      const exists = tracked.has(resolved) || files.some((candidate) => candidate.startsWith(`${resolved}/`));
      if (!exists) {
        issues.push(issue(
          'markdown-link', file, lineNumber(source, match.index),
          `local link target does not exist: ${target}`,
          'point the link at a tracked file or remove the stale reference.',
        ));
      }
    }
  }
}

function checkChangedPunctuation(additions, issues) {
  for (const addition of additions.filter(({ file }) => TEXT_FILE.test(file))) {
    if (addition.source.includes(EM_DASH)) {
      issues.push(issue(
        'changed-em-dash', addition.file, addition.line,
        'changed public file contains U+2014 em dash',
        'replace it with the repository punctuation style and recommit the file.',
      ));
    }
  }
}

// Inspect candidate bytes without executing code from a Git ref. Real CLI and rendering
// behavior is exercised separately by smoke-release against the installed package.
function checkMotionRelease(files, read, issues) {
  const pkg = jsonValue(read('package.json'), 'package.json', issues, 'package.json');
  const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg?.version || '');
  if (!version || (Number(version[1]) < 1 || (Number(version[1]) === 1 && Number(version[2]) < 7))) return;
  const required = [
    'schema/motion-brief.schema.json', 'src/Root.jsx', 'src/MotionDirector.jsx',
    'src/motion/motion-theme.js', 'scripts/motion/brief.js', 'scripts/motion/build.js',
    'scripts/motion/demo.js', 'scripts/cli.js', 'scripts/generate-neutral-fixtures.js',
    'skills/motion-reel/SKILL.md', 'skills/motion-reel/references/brief-package.md',
    'examples/motion-brief-demo.json', 'remotion.config.js', 'scripts/remotion-webpack.js',
  ];
  const problem = (file, message) => issues.push(issue('motion-release', file, 1,
    message, 'restore the public motion contract and run the credential-free release smoke.'));
  for (const file of required) if (!files.includes(file) || !read(file).trim()) problem(file, 'required motion release file is missing or empty');
  if (files.includes('src/Root.jsx') && !/<Composition\s[^>]*id=["']MotionReel["'][^>]*component=\{MotionDirector\}/s.test(read('src/Root.jsx'))) {
    problem('src/Root.jsx', 'MotionReel composition is not registered with MotionDirector');
  }
  const demoFile = 'examples/motion-brief-demo.json';
  if (files.includes(demoFile) && files.includes('schema/motion-brief.schema.json')) {
    try {
      const Ajv = require('ajv');
      const schema = JSON.parse(read('schema/motion-brief.schema.json'));
      const demo = JSON.parse(read(demoFile));
      const valid = new Ajv({ allErrors: true, strict: false }).compile(schema)(demo);
      if (!valid || demo.kind !== 'motion-reel' || demo.status !== 'draft'
        || demo.theme !== 'motion-neutral'
        || ['kinetic-title', 'card', 'steps', 'list', 'counter', 'media', 'cta'].some(
          scene => !demo.scenes?.some(entry => entry.scene === scene))) {
        problem(demoFile, 'public motion demo must be a valid neutral draft covering all seven scenes');
      }
    } catch (_) { problem(demoFile, 'motion demo or candidate schema is invalid'); }
  }
  const ciFile = '.github/workflows/ci.yml';
  const jobs = read(ciFile).split(/^  [a-zA-Z0-9_-]+:\s*$/m);
  const windows = jobs.some(job => /runs-on:\s*windows-latest/.test(job)
    && ['tests/media-probe.test.js', 'tests/motion-source.test.js', 'tests/project-workspace.test.js'].every(file => job.includes(file)));
  const linux = jobs.some(job => /runs-on:\s*ubuntu-latest/.test(job)
    && /npm run smoke:release -- --motion-only/.test(job) && !/\$\{\{\s*secrets\./i.test(job));
  if (!windows) issues.push(issue('motion-ci', ciFile, 1, 'Windows audio probe/workspace coverage is missing', 'run the portable audio and workspace suite on windows-latest.'));
  if (!linux) issues.push(issue('motion-ci', ciFile, 1, 'Linux credential-free motion smoke is missing', 'run npm run smoke:release -- --motion-only on ubuntu-latest without secrets.'));
}

function checkRelease({
  cwd = ROOT,
  tree = 'HEAD',
  base = null,
  release = false,
  now = new Date(),
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const treeSha = resolveTree(resolvedCwd, tree, 'tree');
  const baseSha = base ? resolveTree(resolvedCwd, base, 'base') : null;
  const files = listTreeFiles(resolvedCwd, treeSha);
  const fileSet = new Set(files);
  const cache = new Map();
  const read = (file) => {
    if (!fileSet.has(file)) return '';
    if (!cache.has(file)) cache.set(file, readTreeFile(resolvedCwd, treeSha, file));
    return cache.get(file);
  };
  const issues = [];
  checkPackageMetadata(read, issues);
  checkMotionRelease(files, read, issues);
  checkSecurityException(files, read, issues, now);
  checkReleaseNotes(files, read, issues, { releaseCandidate: release });
  checkEnvironment(files, read, issues);
  checkMarkdownLinks(files, read, issues);
  checkPrivateData(files, read, issues);
  checkAssets(files, read, issues);
  if (baseSha) checkChangedPunctuation(addedTreeLines(resolvedCwd, baseSha, treeSha), issues);
  issues.sort((left, right) => (
    left.file.localeCompare(right.file) || left.line - right.line || left.rule.localeCompare(right.rule)
  ));
  return { tree: treeSha, base: baseSha, issues };
}

function parseArgs(args) {
  const options = { tree: 'HEAD', base: null, release: false };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--release') {
      options.release = true;
      continue;
    }
    if (token !== '--tree' && token !== '--base') throw new Error(`unknown option: ${token}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${token} requires a Git ref`);
    options[token.slice(2)] = value;
    index += 1;
  }
  return options;
}

function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const result = checkRelease(options);
  console.log(`release tree: ${result.tree}`);
  if (result.base) console.log(`release base: ${result.base}`);
  if (result.issues.length) {
    for (const entry of result.issues) console.error(formatIssue(entry));
    console.error(`release check failed: ${result.issues.length} issue(s)`);
    process.exitCode = 1;
    return;
  }
  console.log('release check passed');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`release check failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  checkRelease,
  formatIssue,
  main,
  parseArgs,
  resolveTree,
};
