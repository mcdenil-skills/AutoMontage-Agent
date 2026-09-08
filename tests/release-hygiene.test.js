const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  checkRelease,
  formatIssue,
} = require('../scripts/check-release');
const {
  assertProtectedFilesUnchanged,
  snapshotFiles,
} = require('../scripts/smoke-release');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(root, file, source) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
}

function updateReleaseVersion(root, { version, date = '2026-08-05', unreleased = '', section }) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  pkg.version = version;
  lock.version = version;
  lock.packages[''].version = version;
  write(root, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  write(root, 'package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);
  write(root, 'README.md', `# Fixture\n\nCurrent version: **v${version}**.\n\n[Testing](TESTING.md)\n`);
  const heading = date == null ? `## [${version}]` : `## [${version}] - ${date}`;
  write(root, 'CHANGELOG.md', [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    unreleased,
    heading,
    '',
    section,
    '',
  ].join('\n'));
}

function assetRow(file) {
  return `| \`${file}\` | fixture | generated | test fixture / MIT | test fixture | MIT |`;
}

function securityException(overrides = {}) {
  return {
    ghsa: 'GHSA-5v7r-6r5c-r473',
    cve: 'CVE-2026-31808',
    severity: 'moderate',
    package: 'file-type@16.5.4',
    fixedIn: 'file-type@21.3.1',
    chain: [
      'node-vibrant@4.0.4',
      '@vibrant/image-node@4.0.4',
      '@jimp/custom@0.22.12',
      '@jimp/core@0.22.12',
      'file-type@16.5.4',
    ],
    exposure: 'Optional --autotheme passes only ffmpeg-generated PNG frames to Jimp/Vibrant, not raw ASF input.',
    mitigation: 'Local-only CLI path, at most 20 scaled PNG frames, no direct untrusted-image upload into file-type.',
    decision: 'Keep node-vibrant@4.0.4; do not force-fix, override the major chain, or downgrade to 3.x.',
    triggers: [
      'upstream node-vibrant/Jimp update',
      'severity becomes high',
      'direct untrusted-image input',
      'next release',
    ],
    revisitBy: '2026-09-04',
    reviewedAt: '2026-08-05',
    reviewedFor: '1.2.1',
    ...overrides,
  };
}

function writeSecurityException(root, exception) {
  write(root, 'SECURITY.md', [
    '# Security',
    '',
    '```json security-exception',
    JSON.stringify(exception),
    '```',
    '',
  ].join('\n'));
}

test('repository dependency exception is reviewed for the 1.7.0 release window', () => {
  const security = fs.readFileSync(path.join(__dirname, '..', 'SECURITY.md'), 'utf8');
  const match = security.match(/```json security-exception\s*([\s\S]*?)```/);
  assert.ok(match, 'SECURITY.md must contain one machine-readable dependency exception');

  const exception = JSON.parse(match[1]);
  assert.deepEqual({
    reviewedAt: exception.reviewedAt,
    reviewedFor: exception.reviewedFor,
    revisitBy: exception.revisitBy,
  }, {
    reviewedAt: '2026-09-08',
    reviewedFor: '1.7.0',
    revisitBy: '2026-10-06',
  });
});

function enableNodeVibrant(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  pkg.dependencies = { ...(pkg.dependencies || {}), 'node-vibrant': '^4.0.4' };
  lock.packages[''].dependencies = {
    ...(lock.packages[''].dependencies || {}),
    'node-vibrant': '^4.0.4',
  };
  lock.packages['node_modules/node-vibrant'] = {
    version: '4.0.4',
    dependencies: { '@vibrant/image-node': '^4.0.4' },
  };
  lock.packages['node_modules/@vibrant/image-node'] = {
    version: '4.0.4',
    dependencies: { '@jimp/custom': '^0.22.12' },
  };
  lock.packages['node_modules/@jimp/custom'] = {
    version: '0.22.12',
    dependencies: { '@jimp/core': '^0.22.12' },
  };
  lock.packages['node_modules/@jimp/core'] = {
    version: '0.22.12',
    dependencies: { 'file-type': '^16.5.4' },
  };
  lock.packages['node_modules/file-type'] = { version: '16.5.4' };
  write(root, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  write(root, 'package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);
}

function makeRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-release-check-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'release-test@example.invalid']);
  git(root, ['config', 'user.name', 'Release Test']);
  write(root, 'package.json', `${JSON.stringify({
    name: 'fixture',
    version: '1.2.0',
    license: 'MIT',
    repository: 'https://example.invalid/repo.git',
    homepage: 'https://example.invalid/repo',
    bugs: 'https://example.invalid/repo/issues',
    engines: { node: '>=20' },
  }, null, 2)}\n`);
  write(root, 'package-lock.json', `${JSON.stringify({
    name: 'fixture',
    version: '1.2.0',
    lockfileVersion: 3,
    packages: { '': { name: 'fixture', version: '1.2.0', engines: { node: '>=20' } } },
  }, null, 2)}\n`);
  write(root, 'README.md', '# Fixture\n\nCurrent version: **v1.2.0**.\n\n[Testing](TESTING.md)\n');
  write(root, 'TESTING.md', '# Testing\n');
  write(root, '.env.example', 'OPENAI_API_KEY=\nTHEMES_EXT=\n');
  write(root, 'src/example.js', "const key = process.env.OPENAI_API_KEY;\nconst theme = process.env.THEMES_EXT;\n");
  write(root, 'ASSETS.md', '# Public asset provenance\n\n| Path | Kind | Origin | Author / license | Source or generator | Redistribution basis |\n|---|---|---|---|---|---|\n');
  write(root, 'CHANGELOG.md', [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '## [1.2.0] - 2026-08-05',
    '',
    '### Исправлено',
    '',
    '- lesson-neutral; shell hardening; generated data in out/.',
    '- failed lifecycle and atomic final publication.',
    '- private demo-preview cleanup and ASSETS.md provenance.',
    '- temporary exception is recorded in SECURITY.md.',
    '',
  ].join('\n'));
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'valid fixture']);
  return root;
}

test('release checker reads the committed tree instead of dirty worktree files', () => {
  const root = makeRepository();
  const privateHandle = ['@MCD', 'ENIL'].join('');
  const personalPath = ['/Users', '/private/source.mp4'].join('');
  write(root, 'src/example.js', `const owner = '${privateHandle}';\nconst path = '${personalPath}';\n`);

  const result = checkRelease({ cwd: root, tree: 'HEAD' });

  assert.equal(result.tree, git(root, ['rev-parse', 'HEAD^{tree}']));
  assert.deepEqual(result.issues, []);
  assert.ok(fs.readFileSync(path.join(root, 'src/example.js'), 'utf8').includes(privateHandle));
});

test('release checker reports private ids, media provenance, engines, and changed em dash', () => {
  const root = makeRepository();
  const base = git(root, ['rev-parse', 'HEAD']);
  write(root, 'package-lock.json', `${JSON.stringify({
    name: 'fixture',
    version: '1.2.0',
    lockfileVersion: 3,
    packages: { '': { name: 'fixture', version: '1.2.0', engines: { node: '>=18' } } },
  }, null, 2)}\n`);
  const privateHandle = ['@MCD', 'ENIL'].join('');
  const personalPath = ['/Users', '/private/video.mp4'].join('');
  write(root, 'src/private.js', `const owner = '${privateHandle}';\nconst path = '${personalPath}';\n`);
  write(root, 'public/example.png', 'not-a-real-image');
  const emDash = String.fromCodePoint(0x2014);
  write(root, 'README.md', `# Fixture\n\nCurrent version: **v1.2.0**.\n\nNew ${emDash} text.\n`);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'invalid fixture']);

  const result = checkRelease({ cwd: root, tree: 'HEAD', base });
  const rules = new Set(result.issues.map((issue) => issue.rule));

  assert.ok(rules.has('engine-match'));
  assert.ok(rules.has('private-id'));
  assert.ok(rules.has('personal-path'));
  assert.ok(rules.has('asset-provenance'));
  assert.ok(rules.has('changed-em-dash'));
  assert.match(formatIssue(result.issues[0]), /^\[[a-z-]+\] [^:]+:\d+: .+ Fix: .+/);
});

test('missing base ref explains how to fetch history', () => {
  const root = makeRepository();

  assert.throws(
    () => checkRelease({ cwd: root, tree: 'HEAD', base: 'origin/main' }),
    /git fetch --all --prune/,
  );
});

test('environment declarations ignore inherited PATH but still require product variables', () => {
  const root = makeRepository();
  const undeclared = ['AUTOMONTAGE', 'CUSTOM', 'TOOL'].join('_');
  write(root, 'src/example.js', [
    'const inherited = process.env.PATH;',
    `const missing = process.env.${undeclared};`,
    '',
  ].join('\n'));
  git(root, ['add', 'src/example.js']);
  git(root, ['commit', '-qm', 'system and product environment variables']);

  const result = checkRelease({ cwd: root, tree: 'HEAD' });
  const envIssues = result.issues.filter((entry) => entry.rule === 'env-declaration');

  assert.deepEqual(envIssues.map((entry) => entry.message), [
    `${undeclared} is used but absent from .env.example`,
  ]);
});

test('release notes accept a current patch without 1.2.0-specific wording', () => {
  const root = makeRepository();
  updateReleaseVersion(root, {
    version: '1.2.1',
    section: [
      '### Исправлено',
      '',
      '- Validate release metadata before publication.',
    ].join('\n'),
  });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'generic patch release']);

  const result = checkRelease({ cwd: root, tree: 'HEAD' });

  assert.equal(result.issues.some((entry) => entry.rule === 'release-notes'), false);
});

test('release notes require the current version section to have a date', () => {
  const root = makeRepository();
  updateReleaseVersion(root, {
    version: '1.2.1',
    date: null,
    section: '### Исправлено\n\n- Validate release metadata before publication.',
  });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'undated release']);

  const result = checkRelease({ cwd: root, tree: 'HEAD' });

  assert.match(result.issues.find((entry) => entry.rule === 'release-notes').message, /dated/i);
});

test('development tree permits pending Unreleased notes before a version bump', () => {
  const root = makeRepository();
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
    .replace('## [Unreleased]\n\n', '## [Unreleased]\n\n### Добавлено\n\n- Pending feature.\n\n');
  write(root, 'CHANGELOG.md', changelog);
  git(root, ['add', 'CHANGELOG.md']);
  git(root, ['commit', '-qm', 'pending feature notes']);

  const result = checkRelease({ cwd: root, tree: 'HEAD' });

  assert.equal(result.issues.some((entry) => entry.rule === 'release-notes'), false);
});

test('release notes require Unreleased to be whitespace-empty for a release candidate', () => {
  const root = makeRepository();
  updateReleaseVersion(root, {
    version: '1.2.1',
    unreleased: 'Still pending.',
    section: '### Исправлено\n\n- Validate release metadata before publication.',
  });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'nonempty unreleased']);

  const result = checkRelease({ cwd: root, tree: 'HEAD', release: true });

  assert.match(result.issues.find((entry) => entry.rule === 'release-notes').message, /Unreleased/);
});

test('release notes require a subsection with at least one bullet', () => {
  const root = makeRepository();
  updateReleaseVersion(root, {
    version: '1.2.1',
    section: '### Исправлено\n\nRelease metadata is validated before publication.',
  });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'release without bullet']);

  const result = checkRelease({ cwd: root, tree: 'HEAD' });

  assert.match(result.issues.find((entry) => entry.rule === 'release-notes').message, /bullet/i);
});

test('patch release notes require the exact Исправлено subsection', () => {
  const root = makeRepository();
  updateReleaseVersion(root, {
    version: '1.2.1',
    section: '### Добавлено\n\n- Validate release metadata before publication.',
  });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'patch release without fixed subsection']);

  const result = checkRelease({ cwd: root, tree: 'HEAD' });

  assert.ok(result.issues.some((entry) => (
    entry.rule === 'release-notes' && /Исправлено/.test(entry.message)
  )));
});

test('release notes reject impossible UTC calendar dates', () => {
  const root = makeRepository();
  updateReleaseVersion(root, {
    version: '1.2.1',
    date: '2026-02-30',
    section: '### Исправлено\n\n- Validate release metadata before publication.',
  });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'impossible release date']);

  const result = checkRelease({ cwd: root, tree: 'HEAD' });

  assert.match(result.issues.find((entry) => entry.rule === 'release-notes').message, /calendar date/i);
});

test('release checker requires provenance for each recognized binary asset extension', () => {
  const root = makeRepository();
  const files = ['public/card.webp', 'public/music.mp3', 'public/clip.mov'];
  for (const file of files) write(root, file, 'fixture binary');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'unprovenanced binary assets']);

  const result = checkRelease({ cwd: root, tree: 'HEAD' });
  const missing = result.issues
    .filter((entry) => entry.rule === 'asset-provenance')
    .map((entry) => entry.message.match(/^(public\/[^ ]+)/)?.[1])
    .filter(Boolean)
    .sort();

  assert.deepEqual(missing, files.sort());
});

test('release checker accepts provenance rows using repo-relative binary paths', () => {
  const root = makeRepository();
  const files = ['public/card.webp', 'public/music.mp3', 'public/clip.mov'];
  for (const file of files) write(root, file, 'fixture binary');
  write(root, 'ASSETS.md', [
    '# Public asset provenance',
    '',
    '| Path | Kind | Origin | Author / license | Source or generator | Redistribution basis |',
    '|---|---|---|---|---|---|',
    ...files.map(assetRow),
    '',
  ].join('\n'));
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'provenanced binary assets']);

  const result = checkRelease({ cwd: root, tree: 'HEAD' });

  assert.equal(result.issues.some((entry) => entry.rule === 'asset-provenance'), false);
});

test('release checker normalizes provenance paths before stale-row comparison', () => {
  for (const documentedPath of ['./public/card.webp', 'public\\card.webp']) {
    const root = makeRepository();
    write(root, 'public/card.webp', 'fixture binary');
    write(root, 'ASSETS.md', [
      '# Public asset provenance',
      '',
      '| Path | Kind | Origin | Author / license | Source or generator | Redistribution basis |',
      '|---|---|---|---|---|---|',
      assetRow(documentedPath),
      '',
    ].join('\n'));
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'normalized provenance path']);

    const result = checkRelease({ cwd: root, tree: 'HEAD' });

    assert.equal(result.issues.some((entry) => entry.rule === 'asset-provenance'), false, documentedPath);
  }
});

test('node-vibrant audit exception requires complete and time-bounded evidence', () => {
  const root = makeRepository();
  enableNodeVibrant(root);
  write(root, 'SECURITY.md', [
    '# Security',
    '',
    '```json security-exception',
    JSON.stringify({
      ghsa: 'GHSA-5v7r-6r5c-r473',
      chain: ['node-vibrant@4.0.4', 'file-type@16.5.4'],
      revisitBy: '2026-09-04',
    }),
    '```',
    '',
  ].join('\n'));
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'incomplete exception']);

  const result = checkRelease({ cwd: root, tree: 'HEAD', now: new Date('2026-08-05T00:00:00Z') });

  assert.ok(result.issues.some((entry) => entry.rule === 'security-exception'));

  write(root, 'SECURITY.md', [
    '# Security',
    '',
    '```json security-exception',
    JSON.stringify({
      ghsa: 'GHSA-5v7r-6r5c-r473',
      cve: 'CVE-2026-31808',
      severity: 'moderate',
      package: 'file-type@16.5.4',
      fixedIn: 'file-type@21.3.1',
      chain: [
        'node-vibrant@4.0.4',
        '@vibrant/image-node@4.0.4',
        '@jimp/custom@0.22.12',
        '@jimp/core@0.22.12',
        'file-type@16.5.4',
      ],
      exposure: 'Optional --autotheme passes only ffmpeg-generated PNG frames to Jimp/Vibrant, not raw ASF input.',
      mitigation: 'Local-only CLI path, at most 20 scaled PNG frames, no direct untrusted-image upload into file-type.',
      decision: 'Keep node-vibrant@4.0.4; do not force-fix, override the major chain, or downgrade to 3.x.',
      triggers: [
        'upstream node-vibrant/Jimp update',
        'severity becomes high',
        'direct untrusted-image input',
        'next release',
      ],
      revisitBy: '2026-09-04',
      reviewedAt: '2026-08-05',
      reviewedFor: '1.2.0',
    }),
    '```',
    '',
  ].join('\n'));
  git(root, ['add', 'SECURITY.md']);
  git(root, ['commit', '-qm', 'complete exception']);

  const accepted = checkRelease({ cwd: root, tree: 'HEAD', now: new Date('2026-08-05T00:00:00Z') });
  const expired = checkRelease({ cwd: root, tree: 'HEAD', now: new Date('2026-09-05T00:00:00Z') });
  assert.equal(accepted.issues.some((entry) => entry.rule === 'security-exception'), false);
  assert.equal(expired.issues.some((entry) => entry.rule === 'security-exception'), true);
});

test('node-vibrant exception rejects an invalid reviewedAt calendar date', () => {
  const root = makeRepository();
  updateReleaseVersion(root, {
    version: '1.2.1',
    section: '### Исправлено\n\n- Validate release metadata before publication.',
  });
  enableNodeVibrant(root);
  writeSecurityException(root, securityException({ reviewedAt: '2026-02-30' }));
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'invalid exception review date']);

  const result = checkRelease({ cwd: root, tree: 'HEAD', now: new Date('2026-08-05T00:00:00Z') });

  assert.ok(result.issues.some((entry) => (
    entry.rule === 'security-exception' && /reviewedAt/.test(entry.message)
  )));
});

test('node-vibrant exception requires reviewedFor to match package.json version', () => {
  const root = makeRepository();
  updateReleaseVersion(root, {
    version: '1.2.1',
    section: '### Исправлено\n\n- Validate release metadata before publication.',
  });
  enableNodeVibrant(root);
  writeSecurityException(root, securityException({ reviewedFor: '1.2.0' }));
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'mismatched exception review version']);

  const result = checkRelease({ cwd: root, tree: 'HEAD', now: new Date('2026-08-05T00:00:00Z') });

  assert.ok(result.issues.some((entry) => (
    entry.rule === 'security-exception' && /reviewedFor/.test(entry.message)
  )));
});

test('node-vibrant exception rejects an advisory changed without review evidence', () => {
  const root = makeRepository();
  updateReleaseVersion(root, {
    version: '1.2.1',
    section: '### Исправлено\n\n- Validate release metadata before publication.',
  });
  enableNodeVibrant(root);
  writeSecurityException(root, securityException({ ghsa: 'GHSA-0000-0000-0000' }));
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'changed advisory without review']);

  const result = checkRelease({ cwd: root, tree: 'HEAD', now: new Date('2026-08-05T00:00:00Z') });

  assert.ok(result.issues.some((entry) => (
    entry.rule === 'security-exception' && /ghsa/.test(entry.message)
  )));
});

test('node-vibrant exception requires exactly one parseable security-exception fence', () => {
  const root = makeRepository();
  updateReleaseVersion(root, {
    version: '1.2.1',
    section: '### Исправлено\n\n- Validate release metadata before publication.',
  });
  enableNodeVibrant(root);
  write(root, 'SECURITY.md', [
    '# Security',
    '',
    '```json security-exception',
    JSON.stringify(securityException()),
    '```',
    '',
    '```json security-exception',
    '{"ghsa":',
    '```',
    '',
  ].join('\n'));
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'duplicate security exception fences']);

  const result = checkRelease({ cwd: root, tree: 'HEAD', now: new Date('2026-08-05T00:00:00Z') });

  assert.ok(result.issues.some((entry) => (
    entry.rule === 'security-exception' && /exactly one/.test(entry.message)
  )));
});

test('node-vibrant exception rejects a future review date', () => {
  const root = makeRepository();
  updateReleaseVersion(root, {
    version: '1.2.1',
    date: '2026-08-06',
    section: '### Исправлено\n\n- Validate release metadata before publication.',
  });
  enableNodeVibrant(root);
  writeSecurityException(root, securityException({ reviewedAt: '2026-08-06' }));
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'future exception review']);

  const result = checkRelease({ cwd: root, tree: 'HEAD', now: new Date('2026-08-05T09:59:59Z') });

  assert.ok(result.issues.some((entry) => (
    entry.rule === 'security-exception' && /reviewedAt/.test(entry.message)
  )));
});

test('node-vibrant exception accepts the next global calendar date after UTC+14 midnight', () => {
  const root = makeRepository();
  updateReleaseVersion(root, {
    version: '1.2.1',
    date: '2026-08-06',
    section: '### Исправлено\n\n- Validate release metadata before publication.',
  });
  enableNodeVibrant(root);
  writeSecurityException(root, securityException({ reviewedAt: '2026-08-06' }));
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'global calendar exception review']);

  const result = checkRelease({ cwd: root, tree: 'HEAD', now: new Date('2026-08-05T10:00:00Z') });

  assert.ok(!result.issues.some((entry) => entry.rule === 'security-exception'));
});

test('node-vibrant exception rejects a stale review carried into a new release date', () => {
  const root = makeRepository();
  updateReleaseVersion(root, {
    version: '1.2.1',
    date: '2026-08-06',
    section: '### Исправлено\n\n- Validate release metadata before publication.',
  });
  enableNodeVibrant(root);
  writeSecurityException(root, securityException({ reviewedAt: '2026-08-05' }));
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'stale exception review']);

  const result = checkRelease({ cwd: root, tree: 'HEAD', now: new Date('2026-08-06T12:00:00Z') });

  assert.ok(result.issues.some((entry) => (
    entry.rule === 'security-exception' && /reviewedAt/.test(entry.message)
  )));
});

test('node-vibrant exception requires exactly the documented five chain entries', () => {
  const root = makeRepository();
  updateReleaseVersion(root, {
    version: '1.2.1',
    section: '### Исправлено\n\n- Validate release metadata before publication.',
  });
  enableNodeVibrant(root);
  writeSecurityException(root, securityException({
    chain: [...securityException().chain, 'unexpected-extra@1.0.0'],
  }));
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'extra exception chain entry']);

  const result = checkRelease({ cwd: root, tree: 'HEAD', now: new Date('2026-08-05T12:00:00Z') });

  assert.ok(result.issues.some((entry) => (
    entry.rule === 'security-exception' && /chain/.test(entry.message)
  )));
});

test('node-vibrant exception is compared with the installed candidate lockfile chain', () => {
  const root = makeRepository();
  updateReleaseVersion(root, {
    version: '1.2.1',
    section: '### Исправлено\n\n- Validate release metadata before publication.',
  });
  enableNodeVibrant(root);
  writeSecurityException(root, securityException());
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  lock.packages['node_modules/file-type'].version = '16.5.5';
  write(root, 'package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'changed installed exception chain']);

  const result = checkRelease({ cwd: root, tree: 'HEAD', now: new Date('2026-08-05T12:00:00Z') });

  assert.ok(result.issues.some((entry) => (
    entry.rule === 'security-exception' && /chain/.test(entry.message)
  )));
});

test('versioned release notes must cover every public release boundary', () => {
  const root = makeRepository();
  write(root, 'CHANGELOG.md', [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    'All important work is still here.',
    '',
    '## [1.2.0] - 2026-08-05',
    '',
    '- lesson-neutral only.',
    '',
  ].join('\n'));
  git(root, ['add', 'CHANGELOG.md']);
  git(root, ['commit', '-qm', 'incomplete release notes']);

  const result = checkRelease({ cwd: root, tree: 'HEAD' });

  assert.ok(result.issues.some((entry) => entry.rule === 'release-notes'));
});

test('smoke guard detects any protected-file mutation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-smoke-guard-'));
  write(root, 'src/data/captions.js', 'module.exports = [];\n');
  write(root, 'src/data/transcript.json', '[]\n');
  const files = ['src/data/captions.js', 'src/data/transcript.json'];
  const before = snapshotFiles(root, files);

  assert.doesNotThrow(() => assertProtectedFilesUnchanged(root, before));
  write(root, files[0], 'module.exports = ["changed"];\n');
  assert.throws(
    () => assertProtectedFilesUnchanged(root, before),
    /protected file changed: src\/data\/captions\.js/,
  );
});

function enableMotionRelease(root) {
  updateReleaseVersion(root, { version: '1.7.0', date: '2026-09-08', section: '### Добавлено\n\n- Public motion-reel.' });
  for (const file of [
    'schema/motion-brief.schema.json', 'src/Root.jsx', 'src/MotionDirector.jsx',
    'src/motion/motion-theme.js', 'scripts/motion/brief.js', 'scripts/motion/build.js',
    'scripts/motion/demo.js', 'scripts/cli.js', 'scripts/generate-neutral-fixtures.js',
    'skills/motion-reel/SKILL.md', 'skills/motion-reel/references/brief-package.md',
    'examples/motion-brief-demo.json', '.github/workflows/ci.yml', 'remotion.config.js', 'scripts/remotion-webpack.js',
  ]) write(root, file, fs.readFileSync(path.join(__dirname, '..', file)));
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'motion candidate']);
}

test('motion release refuses missing runtime, schema, skill or demo in the candidate tree', () => {
  const root = makeRepository();
  enableMotionRelease(root);
  assert.equal(checkRelease({ cwd: root }).issues.filter(entry => entry.rule === 'motion-release').length, 0);
  for (const file of ['schema/motion-brief.schema.json', 'src/MotionDirector.jsx', 'scripts/cli.js',
    'scripts/motion/demo.js', 'skills/motion-reel/SKILL.md', 'examples/motion-brief-demo.json', 'remotion.config.js']) {
    git(root, ['rm', file]);
    git(root, ['commit', '-qm', 'incomplete motion candidate']);
    assert.ok(checkRelease({ cwd: root }).issues.some(entry => entry.rule === 'motion-release' && entry.file === file), file);
    git(root, ['restore', '--source=HEAD~1', '--staged', '--worktree', file]);
    git(root, ['commit', '-qm', 'restore motion candidate']);
  }
});

test('motion release refuses an unregistered composition and an invalid demo brief', () => {
  const root = makeRepository();
  enableMotionRelease(root);
  write(root, 'src/Root.jsx', 'export const Root = () => null;\n');
  const demo = JSON.parse(fs.readFileSync(path.join(root, 'examples/motion-brief-demo.json')));
  demo.status = 'approved';
  write(root, 'examples/motion-brief-demo.json', JSON.stringify(demo));
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'broken motion contract']);
  const issues = checkRelease({ cwd: root }).issues.filter(entry => entry.rule === 'motion-release');
  assert.ok(issues.some(entry => entry.file === 'src/Root.jsx'));
  assert.ok(issues.some(entry => entry.file === 'examples/motion-brief-demo.json'));
});

test('motion release refuses CI that drops Windows audio or Linux credential-free smoke', () => {
  const root = makeRepository();
  enableMotionRelease(root);
  const file = '.github/workflows/ci.yml';
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  write(root, file, source.replaceAll('tests/motion-source.test.js', 'tests/media-probe.test.js')
    .replaceAll('npm run smoke:release -- --motion-only', 'npm run check:release'));
  git(root, ['add', '.']);
  git(root, ['commit', '--allow-empty', '-qm', 'missing motion CI']);
  const issues = checkRelease({ cwd: root }).issues.filter(entry => entry.rule === 'motion-ci');
  assert.ok(issues.some(entry => /Windows/.test(entry.message)));
  assert.ok(issues.some(entry => /Linux/.test(entry.message)));
});
