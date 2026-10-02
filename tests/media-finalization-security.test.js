const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const {
  finishEncodeCommand,
  loudnessCommand,
  parseFinishOptions,
  parseLoudnessSummary,
} = require('../scripts/finish');
const {
  buildMusicFilter,
  mixMusicCommand,
  parseMixOptions,
} = require('../scripts/mix-music');
const {
  assertPackSync,
  packCommand,
  parsePackOptions,
  parsePackProbe,
} = require('../scripts/pack-tg');

const hostile = `- lead 'single' "double" $() ;\nЮникод`;

test('finish, music and pack keep hostile paths as literal absolute argv', () => {
  const input = path.join(os.tmpdir(), hostile, 'input.mp4');
  const music = path.join(os.tmpdir(), hostile, 'music.mp3');
  const output = path.join(os.tmpdir(), hostile, 'output.mp4');

  const finish = finishEncodeCommand(input, output, parseFinishOptions([
    input, output, '--hdrfix', 'off', '--lanczos', '1080x1920',
  ]), false);
  assert.equal(finish.args[finish.args.indexOf('-i') + 1], path.resolve(input));
  assert.equal(finish.args.at(-1), path.resolve(output));

  const mixOptions = parseMixOptions([input, music, output]);
  const mix = mixMusicCommand(input, music, output, buildMusicFilter(mixOptions));
  assert.equal(mix.args[mix.args.indexOf('-i') + 1], path.resolve(input));
  assert.equal(mix.args[mix.args.lastIndexOf('-i') + 1], path.resolve(music));
  assert.equal(mix.args.at(-1), path.resolve(output));

  const pack = packCommand(input, output, parsePackOptions([
    input, output, '--fps', '25', '--maxrate', '2200k', '--h', '720',
  ]));
  assert.equal(pack.args[pack.args.indexOf('-i') + 1], path.resolve(input));
  assert.equal(pack.args.at(-1), path.resolve(output));
});

test('finish rejects hdrfix, resolution and audio advance injection', () => {
  for (const args of [
    ['in.mp4', 'out.mp4', '--hdrfix', 'maybe'],
    ['in.mp4', 'out.mp4', '--lanczos', '1080;touch sentinelx1920'],
    ['in.mp4', 'out.mp4', '--lanczos', '0x720'],
    ['in.mp4', 'out.mp4', '--audio-advance-ms', 'NaN'],
    ['in.mp4', 'out.mp4', '--audio-advance-ms', '251'],
  ]) {
    assert.throws(() => parseFinishOptions(args));
  }
});

test('music rejects non-finite and out-of-range filter values', () => {
  const invalid = {
    gain: ['NaN', '-81', '13'],
    threshold: ['Infinity', '0', '1.1'],
    ratio: ['NaN', '0.9', '21'],
    attack: ['0', '2001'],
    release: ['0', '9001'],
    start: ['-1', '86401'],
    rate: ['0.49', '2.01'],
    'fade-in': ['-1', '3601'],
    'fade-out': ['-1', '3601'],
    duration: ['-1', '86401'],
  };
  for (const [name, values] of Object.entries(invalid)) {
    for (const value of values) {
      assert.throws(
        () => parseMixOptions(['in.mp4', 'music.mp3', 'out.mp4', `--${name}`, value]),
        new RegExp(`--${name}`),
      );
    }
  }
  assert.throws(
    () => parseMixOptions([
      'in.mp4', 'music.mp3', 'out.mp4', '--duration', '1', '--fade-out', '2',
    ]),
    /fade-out.*duration/,
  );
});

test('pack validates fps, bitrate and resolution before ffmpeg', () => {
  for (const args of [
    ['in.mp4', 'out.mp4', '--fps', '25;touch sentinel'],
    ['in.mp4', 'out.mp4', '--fps', '0'],
    ['in.mp4', 'out.mp4', '--fps', '121'],
    ['in.mp4', 'out.mp4', '--maxrate', 'nope'],
    ['in.mp4', 'out.mp4', '--maxrate', '63k'],
    ['in.mp4', 'out.mp4', '--h', '143'],
    ['in.mp4', 'out.mp4', '--h', '4321'],
  ]) {
    assert.throws(() => parsePackOptions(args));
  }
});

test('pack requires valid video and audio streams and rejects drift at 80 ms', () => {
  const probe = (videoStart, videoDuration, audioStart, audioDuration) => JSON.stringify({
    streams: [
      { codec_type: 'video', start_time: String(videoStart), duration: String(videoDuration) },
      { codec_type: 'audio', start_time: String(audioStart), duration: String(audioDuration) },
    ],
  });

  assert.doesNotThrow(() => assertPackSync(parsePackProbe(probe(0, 10, 0.079, 10.079))));
  assert.throws(() => assertPackSync(parsePackProbe(probe(0, 10, 0.08, 10.08))), /80.*мс/);
  assert.throws(() => parsePackProbe(JSON.stringify({ streams: [
    { codec_type: 'video', start_time: '0', duration: '10' },
  ] })), /audio stream/);
  assert.throws(() => parsePackProbe(probe(0, 'N/A', 0, 10)), /duration/);
});

test('loudness check disables video before the audio filter', () => {
  const command = loudnessCommand('x.mp4');
  assert.equal(command.command, 'ffmpeg');
  assert.ok(command.args.includes('-vn'));
  assert.ok(command.args.indexOf('-vn') < command.args.indexOf('-af'));
  assert.equal(command.args[command.args.indexOf('-i') + 1], path.resolve('x.mp4'));
});

test('loudness summary is parsed in JavaScript without a shell pipeline', () => {
  assert.equal(parseLoudnessSummary('Input Integrated:    -14.2 LUFS\n'), '-14.2');
  assert.equal(parseLoudnessSummary('Input Integrated:     -inf LUFS\n'), '-inf');
  assert.equal(parseLoudnessSummary('unrelated output'), null);
  for (const file of ['finish.js', 'mix-music.js', 'pack-tg.js']) {
    const source = fs.readFileSync(path.join(ROOT, 'scripts', file), 'utf8');
    assert.doesNotMatch(source, /\bexecSync\b|shell\s*:\s*true|\|\s*grep/);
  }
});

test('invalid CLI values fail before ffmpeg and cannot execute a sentinel', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-finalization-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sentinel = path.join(dir, 'sentinel');
  const payload = `1;touch ${sentinel}`;
  const cases = [
    ['finish.js', ['in.mp4', 'out.mp4', '--audio-advance-ms', payload]],
    ['mix-music.js', ['in.mp4', 'music.mp3', 'out.mp4', '--gain', payload]],
    ['pack-tg.js', ['in.mp4', 'out.mp4', '--fps', payload]],
  ];

  for (const [script, args] of cases) {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `${script} должен отклонить payload`);
  }
  assert.equal(fs.existsSync(sentinel), false);
});
