'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { charactersToWords } = require('./alignment');
const { resolveProjectPath, writeFilesNoReplace } = require('../project/workspace');
const { validateCanonicalTranscript } = require('../motion/source');
const { fsyncDirectoryIfSupported } = require('../filesystem-capabilities');

const DEFAULT_MODEL = 'eleven_multilingual_v2';
const DEFAULT_FORMAT = 'mp3_44100_128';
const DEFAULT_SETTINGS = Object.freeze({ stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1 });
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const configError = () => new Error('ElevenLabs configuration is invalid');

function narrationInput({ script, voiceId, modelId = DEFAULT_MODEL, voiceSettings = {}, outputFormat = DEFAULT_FORMAT }) {
  if (typeof script !== 'string' || !script.trim() || Array.from(script).length > 10000
    || typeof voiceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(voiceId)
    || typeof modelId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(modelId)
    || !['mp3_44100_128', 'mp3_22050_32'].includes(outputFormat)
    || !voiceSettings || Object.getPrototypeOf(voiceSettings) !== Object.prototype) throw configError();
  const settings = { ...DEFAULT_SETTINGS, ...voiceSettings };
  for (const [key, value] of Object.entries(settings)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw configError();
    if (key === 'use_speaker_boost') { if (typeof value !== 'boolean') throw configError(); }
    else if (!Number.isFinite(value) || (key === 'speed' ? value < 0.7 || value > 1.2 : value < 0 || value > 1)) throw configError();
  }
  return { script, voiceId, modelId, voiceSettings: Object.fromEntries(Object.entries(settings).sort(([a], [b]) => a.localeCompare(b))), outputFormat };
}
function buildNarrationCacheKey(options) { return sha(JSON.stringify(narrationInput(options))); }

// Persist each new directory and its entry in the parent before advancing to the
// next level. Recursive mkdir plus syncing only the leaf can lose the whole cache.
function ensureDurableDirectoryChain(target, fileSystem) {
  const missing = []; let existing = target;
  while (!fileSystem.existsSync(existing)) {
    missing.push(existing); existing = path.dirname(existing);
  }
  const parentIdentity = fileSystem.lstatSync(existing);
  if (!parentIdentity.isDirectory() || parentIdentity.isSymbolicLink()) throw configError();
  for (const directory of missing.reverse()) {
    const parent = path.dirname(directory);
    const before = fileSystem.lstatSync(parent);
    if (!before.isDirectory() || before.isSymbolicLink()) throw configError();
    fileSystem.mkdirSync(directory, { mode: 0o700 });
    const created = fileSystem.lstatSync(directory); const after = fileSystem.lstatSync(parent);
    if (!created.isDirectory() || created.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) throw configError();
    fsyncDirectoryIfSupported(fileSystem, directory);
    fsyncDirectoryIfSupported(fileSystem, parent);
  }
  fsyncDirectoryIfSupported(fileSystem, target);
}

// A local ignore rule protects workspaces even when the CLI is installed globally.
// Never turn an existing tracked repository into a private workspace.
function prepareNarrationWorkspace(projectDir, { fileSystem = fs, spawnSyncImpl = spawnSync } = {}) {
  try {
    if (typeof projectDir !== 'string' || !projectDir) throw configError();
    const dir = path.resolve(projectDir);
    let existing = dir;
    while (!fileSystem.existsSync(existing)) existing = path.dirname(existing);
    if (fileSystem.lstatSync(existing).isSymbolicLink()) throw configError();
    const repo = spawnSyncImpl('git', ['rev-parse', '--show-toplevel'], { cwd: existing, encoding: 'utf8' });
    if (repo.status === 0) {
      const root = repo.stdout.trim();
      if (path.resolve(root) === dir) throw configError();
      const tracked = spawnSyncImpl('git', ['ls-files', '-z', '--', dir], { cwd: root, encoding: 'utf8' });
      if (tracked.status !== 0 || tracked.stdout.length) throw configError();
    } else if (repo.error && repo.error.code !== 'ENOENT') throw configError();
    ensureDurableDirectoryChain(dir, fileSystem);
    const ignore = resolveProjectPath(dir, '.gitignore', { fileSystem, type: 'file' });
    if (!fileSystem.existsSync(ignore)) fileSystem.writeFileSync(ignore, '*\n', { flag: 'wx', mode: 0o600 });
    if (fileSystem.readFileSync(ignore, 'utf8').trim() !== '*') throw configError();
    const ignoreHandle = fileSystem.openSync(ignore, fileSystem.constants.O_RDWR | (fileSystem.constants.O_NOFOLLOW || 0));
    try { fileSystem.fsyncSync(ignoreHandle); } finally { fileSystem.closeSync(ignoreHandle); }
    fsyncDirectoryIfSupported(fileSystem, dir);
    resolveProjectPath(dir, 'voice-cache', { fileSystem, type: 'directory' });
    return dir;
  } catch (_) { throw new Error('ElevenLabs requires a private, untracked project workspace without symbolic links'); }
}

function loadVoiceConfig({ env = process.env, root, fileSystem = fs } = {}) {
  const local = {};
  if (root) {
    try {
      const filename = path.join(root, '.env');
      if (fileSystem.statSync(filename).size > 65536) throw configError();
      for (const line of fileSystem.readFileSync(filename, 'utf8').split(/\r?\n/u)) {
        const match = /^\s*(?:export\s+)?(ELEVENLABS_API_KEY|ELEVENLABS_VOICE_ID)\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^#\r\n]*))\s*(?:#.*)?$/u.exec(line);
        if (match) local[match[1]] = (match[2] ?? match[3] ?? match[4]).trim();
      }
    } catch (error) { if (error.code !== 'ENOENT') throw configError(); }
  }
  const value = key => typeof env[key] === 'string' ? env[key].trim() : local[key] || '';
  return { apiKey: value('ELEVENLABS_API_KEY'), voiceId: value('ELEVENLABS_VOICE_ID') };
}

async function responseJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('invalid response');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('response too large');
      chunks.push(Buffer.from(chunk.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { reader.releaseLock(); }
}
function decodeResponse(response) {
  if (typeof response?.audio_base64 !== 'string' || !response.audio_base64.length
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(response.audio_base64)) throw new Error('invalid response');
  const audio = Buffer.from(response.audio_base64, 'base64');
  if (!audio.length || audio.toString('base64') !== response.audio_base64) throw new Error('invalid response');
  const alignment = response.alignment || response.normalized_alignment;
  const words = charactersToWords(alignment);
  if (!words.length) throw new Error('invalid response alignment');
  const transcript = [{ start: words[0].s, end: words.at(-1).e, text: alignment.characters.join('').trim(), words }];
  validateCanonicalTranscript(transcript);
  return { audio, transcript };
}

async function synthesizeWithTimestamps(options, { fetchImpl = fetch, fileSystem = fs, spawnSyncImpl = spawnSync } = {}) {
  if (!options.voiceId) throw new Error('ElevenLabs requires --voice-id or private ELEVENLABS_VOICE_ID');
  const input = narrationInput(options);
  const cacheKey = buildNarrationCacheKey(input);
  const dir = prepareNarrationWorkspace(options.projectDir, { fileSystem, spawnSyncImpl });
  const relative = `voice-cache/${cacheKey}`;
  const resolve = (name, mustExist = false) => resolveProjectPath(dir, `${relative}/${name}`, { fileSystem, type: 'file', mustExist });
  let cachePath; let audioPath; let assertWorkspaceCurrent;
  try {
    const cacheDir = resolveProjectPath(dir, relative, { fileSystem, type: 'directory' });
    ensureDurableDirectoryChain(cacheDir, fileSystem);
    const ignorePath = resolveProjectPath(dir, '.gitignore', { fileSystem, type: 'file', mustExist: true });
    const identities = [dir, path.join(dir, 'voice-cache'), cacheDir, ignorePath].map(filename => ({ filename, stat: fileSystem.lstatSync(filename) }));
    assertWorkspaceCurrent = () => {
      for (const { filename, stat } of identities) {
        const current = fileSystem.lstatSync(filename);
        if (current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) throw configError();
      }
      if (fileSystem.readFileSync(ignorePath, 'utf8').trim() !== '*') throw configError();
    };
    assertWorkspaceCurrent();
    cachePath = resolve('receipt.json'); audioPath = resolve('narration.mp3');
    if (fileSystem.existsSync(cachePath)) {
      const receipt = JSON.parse(fileSystem.readFileSync(cachePath, 'utf8'));
      const audio = fileSystem.readFileSync(resolve('narration.mp3', true));
      const wordsBytes = fileSystem.readFileSync(resolve('words.json', true));
      if (receipt.version !== 1 || receipt.cacheKey !== cacheKey || receipt.audioSha256 !== sha(audio)
        || receipt.wordsSha256 !== sha(wordsBytes)) throw configError();
      const transcript = validateCanonicalTranscript(JSON.parse(wordsBytes));
      if (!transcript.length || !transcript[0].words.length) throw configError();
      assertWorkspaceCurrent();
      return { cacheKey, cachePath, audioPath, audioSha256: receipt.audioSha256, transcript, cached: true };
    }
    if (fileSystem.existsSync(resolve('attempt.json'))) {
      throw new Error('previous attempt');
    }
    if (fileSystem.readdirSync(cacheDir).length) throw configError();
  } catch (error) {
    throw new Error(error.message === 'previous attempt'
      ? 'ElevenLabs previous attempt is incomplete; check provider history before manually clearing its voice-cache attempt.json. Request not retried.'
      : 'ElevenLabs private cache is invalid; request not retried.');
  }
  if (options.acceptProviderCost !== true) throw new Error('ElevenLabs is a separate paid API; pass --accept-provider-cost only after explicit cost approval');
  if (!options.apiKey) throw new Error('ElevenLabs requires private ELEVENLABS_API_KEY');
  if (typeof options.apiKey !== 'string' || options.apiKey.length > 512 || /[\x00-\x20\x7f]/u.test(options.apiKey)) throw configError();
  const timeoutMs = options.timeoutMs ?? 60000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw configError();
  // The exclusive marker survives crashes/timeouts. A second process cannot submit the same request.
  try {
    const marker = fileSystem.openSync(resolve('attempt.json'), 'wx', 0o600);
    try {
      fileSystem.writeFileSync(marker, JSON.stringify({ version: 1, cacheKey }));
      fileSystem.fsyncSync(marker);
    } finally { fileSystem.closeSync(marker); }
    fsyncDirectoryIfSupported(fileSystem, path.dirname(resolve('attempt.json')));
    assertWorkspaceCurrent();
  }
  catch (_) { throw new Error('ElevenLabs previous attempt or private cache conflict; request not retried.'); }
  const controller = new AbortController(); let timer; let status; let timedOut = false;
  try {
    const request = async () => {
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(input.voiceId)}/with-timestamps?output_format=${input.outputFormat}`;
      const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'xi-api-key': options.apiKey },
        body: JSON.stringify({ text: input.script, model_id: input.modelId, voice_settings: input.voiceSettings }),
      });
      status = Number.isInteger(response.status) ? response.status : null;
      if (!response.ok) throw new Error('provider response failure');
      return decodeResponse(await responseJson(response));
    };
    const result = await Promise.race([request(), new Promise((_, reject) => {
      timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('timeout')); }, timeoutMs);
    })]);
    assertWorkspaceCurrent();
    const wordsBytes = Buffer.from(`${JSON.stringify(result.transcript, null, 2)}\n`);
    const receipt = { version: 1, cacheKey, audioSha256: sha(result.audio), wordsSha256: sha(wordsBytes) };
    writeFilesNoReplace([
      { destination: resolve('narration.mp3'), data: result.audio, purpose: 'narration-cache' },
      { destination: resolve('words.json'), data: wordsBytes, purpose: 'narration-words' },
      { destination: resolve('receipt.json'), data: `${JSON.stringify(receipt)}\n`, purpose: 'narration-receipt' },
    ], { fileSystem, assertParentCurrent: assertWorkspaceCurrent, verifyPublishedIdentity: true,
      afterCommit() {
        assertWorkspaceCurrent();
        fsyncDirectoryIfSupported(fileSystem, path.dirname(audioPath));
        assertWorkspaceCurrent();
      },
    });
    return { cacheKey, cachePath, audioPath, audioSha256: receipt.audioSha256, transcript: result.transcript, cached: false };
  } catch (_) {
    // Never include provider body, URL/voice ID, credentials, script or low-level causes.
    throw new Error(`ElevenLabs ${timedOut ? 'timeout' : status && status >= 400 ? `HTTP ${status}` : 'request or response failure'}; outcome may be ambiguous. Request not retried; check provider history and the private cache before retrying.`);
  } finally { clearTimeout(timer); controller.abort(); }
}
module.exports = { buildNarrationCacheKey, charactersToWords, synthesizeWithTimestamps, prepareNarrationWorkspace, loadVoiceConfig };
