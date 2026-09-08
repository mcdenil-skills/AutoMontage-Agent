const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { buildNarrationCacheKey, charactersToWords, synthesizeWithTimestamps, prepareNarrationWorkspace } = require('../scripts/voice/elevenlabs');
const { runMotion, parseMotionOptions } = require('../scripts/motion/build');
const { validateCanonicalTranscript } = require('../scripts/motion/source');

const voiceId = 'synthetic-test-voice';
const apiKey = 'synthetic-test-key';
const script = 'Привет, мир!';
function alignment(text = script) {
  const characters = Array.from(text);
  return { characters, character_start_times_seconds: characters.map((_, i) => i / 10),
    character_end_times_seconds: characters.map((_, i) => (i + 1) / 10) };
}
function payload(text = script) {
  return { audio_base64: Buffer.from('synthetic audio bytes').toString('base64'), alignment: alignment(text) };
}
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-voice-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'projects', 'test');
  prepareNarrationWorkspace(projectDir);
  return { root, projectDir };
}
async function mockServer(t, handler) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, method: request.method, headers: request.headers, body: JSON.parse(body) });
    handler(request, response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { requests, fetchImpl(url, init) {
    assert.equal(new URL(url).origin, 'https://api.elevenlabs.io');
    return fetch(origin + new URL(url).pathname + new URL(url).search, init);
  } };
}
function options(projectDir, overrides = {}) { return { projectDir, script, voiceId, apiKey, acceptProviderCost: true, ...overrides }; }

test('character timing produces canonical Cyrillic words including punctuation, combining marks and emoji', () => {
  const text = ' Ёжик,\nмир! е\u0301лка 😀 ';
  const words = charactersToWords(alignment(text));
  assert.deepEqual(words.map(w => w.w), ['Ёжик,', 'мир!', 'е\u0301лка', '😀']);
  assert.equal(words[0].s, 0.1);
  assert.equal(words[0].e, 0.6);
  validateCanonicalTranscript([{ start: words[0].s, end: words.at(-1).e, text: text.trim(), words }]);
  assert.deepEqual(charactersToWords(alignment('  \n')), []);
});
test('invalid timing fails closed without including supplied text', () => {
  for (const bad of [null, {}, { ...alignment(), character_start_times_seconds: [] },
    { ...alignment(), character_end_times_seconds: Array(11).fill(-1) },
    { ...alignment(), character_start_times_seconds: Array(11).fill(NaN) },
    { ...alignment(), characters: [123] }]) {
    assert.throws(() => charactersToWords(bad), error => /alignment/i.test(error.message) && !error.message.includes(script));
  }
});
test('cache identity is stable for equivalent settings, distinct for every billed input and independent of credentials', () => {
  const base = { script, voiceId, modelId: 'eleven_multilingual_v2', voiceSettings: { stability: 0.5, similarity_boost: 0.75 }, outputFormat: 'mp3_44100_128' };
  const hash = buildNarrationCacheKey(base);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash, buildNarrationCacheKey({ ...base, voiceSettings: { similarity_boost: 0.75, stability: 0.5 }, apiKey: 'different' }));
  for (const change of [{ script: script + ' ' }, { voiceId: 'another-synthetic' }, { modelId: 'another_model' },
    { voiceSettings: { stability: 0.4 } }, { outputFormat: 'mp3_22050_32' }]) assert.notEqual(hash, buildNarrationCacheKey({ ...base, ...change }));
});
test('official timestamp request is opt-in, decodes audio and reuses a verified private cache without another call', async t => {
  const { projectDir } = workspace(t);
  const mock = await mockServer(t, (_, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(payload())); });
  const result = await synthesizeWithTimestamps(options(projectDir), mock);
  assert.equal(result.cached, false);
  assert.equal(fs.readFileSync(result.audioPath, 'utf8'), 'synthetic audio bytes');
  assert.deepEqual(result.transcript[0].words.map(w => w.w), ['Привет,', 'мир!']);
  validateCanonicalTranscript(result.transcript);
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0].method, 'POST');
  assert.equal(mock.requests[0].url, `/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`);
  assert.equal(mock.requests[0].headers['xi-api-key'], apiKey);
  assert.deepEqual(mock.requests[0].body, { text: script, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1 } });
  const reused = await synthesizeWithTimestamps(options(projectDir, { acceptProviderCost: false, apiKey: '' }), mock);
  assert.equal(reused.cached, true);
  assert.deepEqual(reused.transcript, result.transcript);
  assert.equal(mock.requests.length, 1);
  assert.ok(result.audioPath.startsWith(projectDir + path.sep));
  assert.doesNotMatch(fs.readFileSync(result.cachePath, 'utf8'), new RegExp(`${apiKey}|${voiceId}`));
});
test('cost gate, missing credentials and invalid settings refuse before any network call', async t => {
  const { projectDir } = workspace(t); let calls = 0;
  for (const [change, pattern] of [[{ acceptProviderCost: false }, /accept-provider-cost/], [{ apiKey: '' }, /API_KEY/],
    [{ voiceId: '' }, /VOICE_ID|voice-id/], [{ voiceId: '../leak' }, /configuration/i], [{ voiceSettings: { stability: Infinity } }, /configuration/i]]) {
    await assert.rejects(synthesizeWithTimestamps(options(projectDir, change), { fetchImpl: () => { calls++; throw new Error('unexpected'); } }), pattern);
  }
  assert.equal(calls, 0);
});
test('provider failures redact credentials, script and response details and never retry', async t => {
  const { projectDir } = workspace(t);
  const mock = await mockServer(t, (_, res) => { res.writeHead(500); res.end(`${apiKey} ${voiceId} ${script}`); });
  await assert.rejects(synthesizeWithTimestamps(options(projectDir), mock), error => {
    assert.match(error.message, /500.*not retried|not retried.*500/i);
    assert.doesNotMatch(error.stack, new RegExp(`${apiKey}|${voiceId}|${script}`)); return true;
  });
  await assert.rejects(synthesizeWithTimestamps(options(projectDir), mock), /previous|attempt|ambiguous/i);
  assert.equal(mock.requests.length, 1);
});
test('network failure and stalled response body time out without automatic retry or leaked cause', async t => {
  for (const mode of ['disconnect', 'headers-only']) {
    const { projectDir } = workspace(t);
    const mock = await mockServer(t, (req, res) => {
      if (mode === 'disconnect') req.socket.destroy(); else { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); }
    });
    await assert.rejects(synthesizeWithTimestamps(options(projectDir, { timeoutMs: 100 }), mock), /not retried/i);
    assert.equal(mock.requests.length, 1);
  }
});
test('malformed responses and corrupted completed cache never trigger a replacement paid call', async t => {
  for (const body of [{ ...payload(), audio_base64: 'not base64?' }, { ...payload(), alignment: null }, { ...payload(), alignment: alignment('') }]) {
    const { projectDir } = workspace(t);
    const mock = await mockServer(t, (_, res) => res.end(JSON.stringify(body)));
    await assert.rejects(synthesizeWithTimestamps(options(projectDir), mock), /invalid|alignment|not retried/i);
    assert.equal(mock.requests.length, 1);
  }
  const { projectDir } = workspace(t);
  const mock = await mockServer(t, (_, res) => res.end(JSON.stringify(payload())));
  const result = await synthesizeWithTimestamps(options(projectDir), mock);
  fs.appendFileSync(result.audioPath, 'changed');
  await assert.rejects(synthesizeWithTimestamps(options(projectDir), mock), /cache/i);
  assert.equal(mock.requests.length, 1);
});
test('tracked workspaces and symlinked provider cache paths are refused before a paid call', async t => {
  const { root, projectDir } = workspace(t);
  fs.mkdirSync(path.join(root, 'outside'));
  fs.symlinkSync(path.join(root, 'outside'), path.join(projectDir, 'voice-cache'), 'dir');
  await assert.rejects(synthesizeWithTimestamps(options(projectDir), { fetchImpl: () => assert.fail('network forbidden') }), /workspace|symbolic|cache/i);
  const tracked = path.join(root, 'tracked'); fs.mkdirSync(tracked);
  spawnSync('git', ['init', '-q'], { cwd: tracked });
  fs.writeFileSync(path.join(tracked, 'README.md'), 'public');
  spawnSync('git', ['add', 'README.md'], { cwd: tracked });
  assert.throws(() => prepareNarrationWorkspace(tracked), /private|tracked|workspace/i);
});
test('CLI accepts explicit TTS opt-in and rejects mixed final/audio/provider inputs', () => {
  const args = ['--script', 'script.txt', '--voice', 'elevenlabs', '--voice-id', voiceId, '--project', 'Reel', '--accept-provider-cost'];
  assert.equal(parseMotionOptions(args).acceptProviderCost, true);
  assert.equal(parseMotionOptions(args).scriptPath, 'script.txt');
  for (const bad of [args.concat('--accept-provider-cost'), ['voice.wav', ...args], args.concat('--brief', 'approved.json', '--project-dir', '.'),
    ['voice.wav', '--project', 'Reel', '--accept-provider-cost'], ['--script', 'script.txt', '--project', 'Reel'],
    ['--script', 'script.txt', '--voice', 'other', '--project', 'Reel']]) assert.throws(() => parseMotionOptions(bad));
});
test('TTS build saves canonical timing directly and enters the same draft workflow without Whisper', async t => {
  const { root, projectDir } = workspace(t); const scriptPath = path.join(root, 'script.txt'); fs.writeFileSync(scriptPath, script);
  const mock = await mockServer(t, (_, res) => res.end(JSON.stringify(payload())));
  const result = await runMotion({ scriptPath, voice: 'elevenlabs', voiceId, projectDir, project: 'Synthetic', acceptProviderCost: true }, {
    voiceDependencies: mock, voiceEnv: { ELEVENLABS_API_KEY: apiKey },
    probeOpenedAudioImpl: () => ({ mediaKind: 'audio', durationSec: 2 }),
    transcribeMotionNarrationImpl: () => assert.fail('generated narration must use provider timing'),
  });
  const brief = JSON.parse(fs.readFileSync(result.jsonPath));
  assert.equal(brief.status, 'draft'); assert.equal(brief.scenes[0].text, script);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(projectDir, 'transcript/words.json')))[0].words.map(w => w.w), ['Привет,', 'мир!']);
  assert.doesNotMatch(fs.readFileSync(path.join(projectDir, 'project.json'), 'utf8'), new RegExp(`${apiKey}|${voiceId}`));
  assert.equal(mock.requests.length, 1);
  await assert.rejects(runMotion({ scriptPath, voice: 'elevenlabs', voiceId, projectDir, project: 'Synthetic', acceptProviderCost: true }, { voiceDependencies: mock }), /brief|project/i);
  assert.equal(mock.requests.length, 1);
});

test('parallel identical requests submit once and timeout before headers is bounded', async t => {
  const { projectDir } = workspace(t);
  const mock = await mockServer(t, () => {});
  const one = synthesizeWithTimestamps(options(projectDir, { timeoutMs: 100 }), mock);
  const two = synthesizeWithTimestamps(options(projectDir, { timeoutMs: 100 }), mock);
  const settled = await Promise.allSettled([one, two]);
  assert.deepEqual(settled.map(r => r.status), ['rejected', 'rejected']);
  assert.match(settled[0].reason.message, /timeout/i);
  assert.match(settled[1].reason.message, /previous attempt/i);
  assert.equal(mock.requests.length, 1);
});
test('provider redirects never forward credentials to a second endpoint', async t => {
  const { projectDir } = workspace(t);
  const mock = await mockServer(t, (_, res) => { res.writeHead(307, { location: '/unexpected' }); res.end(); });
  await assert.rejects(synthesizeWithTimestamps(options(projectDir), mock), /not retried/i);
  assert.equal(mock.requests.length, 1);
});
test('workspace replacement during a billed request cannot publish into an unprotected directory', async t => {
  const { projectDir } = workspace(t);
  const mock = await mockServer(t, (_, res) => {
    fs.renameSync(projectDir, projectDir + '-moved');
    fs.mkdirSync(projectDir);
    res.end(JSON.stringify(payload()));
  });
  await assert.rejects(synthesizeWithTimestamps(options(projectDir), mock), /not retried/i);
  assert.deepEqual(fs.readdirSync(projectDir), []);
});
test('private local config does not populate process.env and explicit environment wins', t => {
  const { root } = workspace(t);
  const { loadVoiceConfig } = require('../scripts/voice/elevenlabs');
  const keyName = ['ELEVENLABS', 'API_KEY'].join('_');
  const voiceName = ['ELEVENLABS', 'VOICE_ID'].join('_');
  fs.writeFileSync(path.join(root, '.env'), `${keyName}='synthetic-local-key'\n${voiceName}="synthetic-local-voice"\nUNRELATED=private\n`);
  const before = process.env[keyName];
  assert.deepEqual(loadVoiceConfig({ root, env: {} }), { apiKey: 'synthetic-local-key', voiceId: 'synthetic-local-voice' });
  assert.deepEqual(loadVoiceConfig({ root, env: { [keyName]: apiKey, [voiceName]: voiceId } }), { apiKey, voiceId });
  assert.equal(process.env[keyName], before);
});
test('new provider outputs are ignored by a containing repository and use private file modes', async t => {
  const { root, projectDir } = workspace(t);
  spawnSync('git', ['init', '-q'], { cwd: root });
  const mock = await mockServer(t, (_, res) => res.end(JSON.stringify(payload())));
  const result = await synthesizeWithTimestamps(options(projectDir), mock);
  const ignored = spawnSync('git', ['check-ignore', result.audioPath, result.cachePath], { cwd: root, encoding: 'utf8' });
  assert.equal(ignored.status, 0);
  assert.equal(ignored.stdout.trim().split('\n').length, 2);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(result.audioPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(result.cachePath).mode & 0o777, 0o600);
  }
});
test('removing the ignore file during an in-flight request refuses provider publication', async t => {
  const { projectDir } = workspace(t);
  const mock = await mockServer(t, (_, res) => {
    fs.unlinkSync(path.join(projectDir, '.gitignore'));
    res.end(JSON.stringify(payload()));
  });
  await assert.rejects(synthesizeWithTimestamps(options(projectDir), mock), /not retried/i);
  const cacheRoot = path.join(projectDir, 'voice-cache');
  assert.deepEqual(fs.readdirSync(path.join(cacheRoot, fs.readdirSync(cacheRoot)[0])), ['attempt.json']);
});
test('orphaned cached audio cannot trigger paid replacement generation', async t => {
  const { projectDir } = workspace(t);
  const cacheDir = path.join(projectDir, 'voice-cache', buildNarrationCacheKey(options(projectDir)));
  fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(path.join(cacheDir, 'narration.mp3'), 'orphan');
  await assert.rejects(synthesizeWithTimestamps(options(projectDir), { fetchImpl: () => assert.fail('paid replacement forbidden') }), /cache.*invalid/i);
});
test('attempt persistence failure refuses the paid request before fetch', async t => {
  const { projectDir } = workspace(t); let calls = 0;
  const fileSystem = Object.create(fs);
  fileSystem.fsyncSync = () => { throw new Error('synthetic disk failure'); };
  const mock = await mockServer(t, (_, res) => { calls++; res.end(JSON.stringify(payload())); });
  await assert.rejects(synthesizeWithTimestamps(options(projectDir), { ...mock, fileSystem }), /not retried/i);
  assert.equal(calls, 0);
});
test('invalid project name is rejected before generating narration even with an explicit directory', async t => {
  const { root, projectDir } = workspace(t);
  const scriptPath = path.join(root, 'script.txt'); fs.writeFileSync(scriptPath, script);
  const mock = await mockServer(t, (_, res) => res.end(JSON.stringify(payload())));
  await assert.rejects(runMotion({ projectDir, project: '😀', scriptPath, voice: 'elevenlabs', voiceId, acceptProviderCost: true }, {
    voiceEnv: { ELEVENLABS_API_KEY: apiKey }, voiceDependencies: mock,
    probeOpenedAudioImpl: () => ({ mediaKind: 'audio', durationSec: 2 }),
  }));
  assert.equal(mock.requests.length, 0);
});
