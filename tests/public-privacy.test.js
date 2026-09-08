const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { checkPublicPrivacy } = require('../scripts/check-public-privacy');

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function write(root, relativePath, bytes) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
}

function fixtureRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-public-privacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'privacy-test@example.invalid']);
  git(root, ['config', 'user.name', 'Privacy Test']);
  write(root, 'ASSETS.md', [
    '# Public assets',
    '',
    '| Path | Kind | Origin | Author / license | Source or generator | Redistribution basis |',
    '|---|---|---|---|---|---|',
    '',
  ].join('\n'));
  write(root, '.env.example', 'PUBLIC_THEME=\n');
  write(root, 'README.md', '# Fixture\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'initial fixture']);
  return root;
}

function stageBytes(root, relativePath, bytes) {
  write(root, relativePath, bytes);
  git(root, ['add', '-f', '--', relativePath]);
}

function commitBytes(root, relativePath, bytes) {
  stageBytes(root, relativePath, bytes);
  git(root, ['commit', '-qm', `add ${relativePath}`]);
}

function assetRow(relativePath) {
  return `| \`${relativePath}\` | fixture | local | contributors / MIT | generator | MIT |`;
}

test('a neutral repository passes tracked and staged privacy checks', (t) => {
  const root = fixtureRepo(t);

  assert.deepEqual(checkPublicPrivacy({ root, scope: 'tracked' }), { ok: true, issues: [] });
  assert.deepEqual(checkPublicPrivacy({ root, scope: 'staged' }), { ok: true, issues: [] });
});

test('staged mode rejects a client video before it can be committed', (t) => {
  const root = fixtureRepo(t);
  const privateVideo = ['projects', 'client-a', 'input', 'source.mp4'].join('/');
  stageBytes(root, privateVideo, Buffer.from('private'));

  const result = checkPublicPrivacy({ root, scope: 'staged' });

  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /forbidden project path/);
  assert.equal(result.issues[0].path, privateVideo);
});

test('staged mode scans the index blob and ignores a safe unstaged replacement', (t) => {
  const root = fixtureRepo(t);
  const leaked = ['', 'Users', 'private-user', 'Desktop', 'source.mp4'].join('/');
  stageBytes(root, 'docs/example.md', leaked);
  write(root, 'docs/example.md', 'portable example\n');

  const result = checkPublicPrivacy({ root, scope: 'staged' });

  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /absolute local path/);
  assert.doesNotMatch(JSON.stringify(result.issues), /private-user/);
});

test('tracked mode rejects personal absolute paths without echoing their contents', (t) => {
  const root = fixtureRepo(t);
  const unixPath = ['', 'home', 'private-user', 'recordings', 'source.mov'].join('/');
  const windowsPath = ['C:', 'Users', 'private-user', 'recordings', 'source.mov'].join('\\');
  commitBytes(root, 'docs/example.md', `${unixPath}\n${windowsPath}\n`);

  const result = checkPublicPrivacy({ root, scope: 'tracked' });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /absolute local path/.test(issue.message)));
  assert.doesNotMatch(JSON.stringify(result.issues), /private-user/);
});

test('environment files are private except for the documented example', (t) => {
  const root = fixtureRepo(t);
  stageBytes(root, '.env.local', 'TOKEN=secret\n');

  const result = checkPublicPrivacy({ root, scope: 'staged' });

  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /environment file/);
  assert.equal(result.issues.some((issue) => issue.path === '.env.example'), false);
});

test('tracked media must be declared in the six-column ASSETS table', (t) => {
  const root = fixtureRepo(t);
  commitBytes(root, 'examples/unlisted.mp4', Buffer.from('fixture'));

  const result = checkPublicPrivacy({ root, scope: 'tracked' });

  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /ASSETS\.md/);
});

test('media declared in ASSETS.md is allowed', (t) => {
  const root = fixtureRepo(t);
  const mediaPath = 'examples/neutral.mp4';
  const assets = `${fs.readFileSync(path.join(root, 'ASSETS.md'), 'utf8')}${assetRow(mediaPath)}\n`;
  write(root, 'ASSETS.md', assets);
  write(root, mediaPath, Buffer.from('fixture'));
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'add declared media']);

  assert.deepEqual(checkPublicPrivacy({ root, scope: 'tracked' }), { ok: true, issues: [] });
});

test('a symlink target is scanned as text', (t) => {
  const root = fixtureRepo(t);
  const target = ['', 'var', 'folders', 'private', 'source.mov'].join('/');
  fs.symlinkSync(target, path.join(root, 'source-link'));
  git(root, ['add', 'source-link']);

  const result = checkPublicPrivacy({ root, scope: 'staged' });

  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /absolute local path/);
  assert.doesNotMatch(JSON.stringify(result.issues), /source\.mov/);
});

test('unknown scope fails closed', (t) => {
  const root = fixtureRepo(t);

  assert.throws(
    () => checkPublicPrivacy({ root, scope: 'working-tree' }),
    /scope must be tracked or staged/,
  );
});

test('provider configuration secrets and voice identities are rejected without echoing their values', t => {
  const root = fixtureRepo(t);
  const keyName = ['ELEVENLABS', 'API_KEY'].join('_');
  const voiceName = ['ELEVENLABS', 'VOICE_ID'].join('_');
  const secret = ['sk', 'synthetic-private-value'].join('_');
  stageBytes(root, '.env.example', `${keyName}=${secret}\n${voiceName}=synthetic-private-voice\n`);
  write(root, '.env.example', `${keyName}=\n${voiceName}=\n`);
  const result = checkPublicPrivacy({ root, scope: 'staged' });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.rule === 'provider-secret'));
  assert.ok(result.issues.some(issue => issue.rule === 'private-voice-id'));
  assert.doesNotMatch(JSON.stringify(result.issues), /synthetic-private/);
});
test('empty provider settings and documentation placeholders remain publishable', t => {
  const root = fixtureRepo(t);
  stageBytes(root, '.env.example', ['ELEVENLABS_API_KEY=', 'ELEVENLABS_VOICE_ID=', ''].join('\n'));
  stageBytes(root, 'docs/provider.md', 'Use --voice-id <voice-id>. ELEVENLABS_VOICE_ID=<voice-id>\n');
  assert.deepEqual(checkPublicPrivacy({ root, scope: 'staged' }), { ok: true, issues: [] });
});
test('JSON provider configuration and leaked timestamp outputs outside projects are private', t => {
  const root = fixtureRepo(t);
  stageBytes(root, 'config/voice.json', JSON.stringify({ ['ELEVENLABS_' + 'VOICE_ID']: 'synthetic-private-voice' }));
  stageBytes(root, 'public/narration.json', JSON.stringify({ audio_base64: 'synthetic', alignment: { characters: ['A'] } }));
  stageBytes(root, 'examples/voice-cache/receipt.json', '{}');
  const result = checkPublicPrivacy({ root, scope: 'staged' });
  assert.ok(result.issues.some(issue => issue.rule === 'private-voice-id'));
  assert.ok(result.issues.some(issue => issue.path === 'public/narration.json' && issue.rule === 'provider-output'));
  assert.ok(result.issues.some(issue => issue.path === 'examples/voice-cache/receipt.json' && issue.rule === 'provider-output'));
});
test('multiline JSON provider assignments cannot bypass the privacy gate', t => {
  const root = fixtureRepo(t);
  stageBytes(root, 'config/voice.json', '{"ELEVENLABS_VOICE_ID":\n"synthetic-private-voice"}');
  const result = checkPublicPrivacy({ root, scope: 'staged' });
  assert.ok(result.issues.some(issue => issue.rule === 'private-voice-id'));
});

for (const [extension, contents] of [
  ['yaml', 'ELEVENLABS_VOICE_ID:\n  synthetic-private-voice\n'],
  ['yaml', 'ELEVENLABS_VOICE_ID:\n  "synthetic-private-voice"\n'],
  ['toml', 'ELEVENLABS_VOICE_ID = """\nsynthetic-private-voice\n"""\n'],
  ['toml', "ELEVENLABS_VOICE_ID = '''\nsynthetic-private-voice\n'''\n"],
]) {
  test(`staged privacy rejects multiline ${extension} provider identity: ${JSON.stringify(contents).slice(0, 38)}`, t => {
    const root = fixtureRepo(t); const filename = `config/voice.${extension}`;
    stageBytes(root, filename, contents); write(root, filename, '');
    const result = checkPublicPrivacy({ root, scope: 'staged' });
    assert.ok(result.issues.some(issue => issue.rule === 'private-voice-id'));
    assert.doesNotMatch(JSON.stringify(result.issues), /synthetic-private/);
  });
}
test('empty multiline YAML/TOML settings and explicit placeholders remain public', t => {
  const root = fixtureRepo(t);
  stageBytes(root, 'config/voice.yaml', 'ELEVENLABS_VOICE_ID:\n  ""\nELEVENLABS_API_KEY: <api-key>\n');
  stageBytes(root, 'config/voice.toml', 'ELEVENLABS_VOICE_ID = """\n"""\nELEVENLABS_API_KEY = """<api-key>"""\n');
  assert.deepEqual(checkPublicPrivacy({ root, scope: 'staged' }), { ok: true, issues: [] });
});
