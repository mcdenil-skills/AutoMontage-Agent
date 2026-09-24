const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const { collectWords, parseTightenOptions } = require('../scripts/tighten');
const { parseCutOptions } = require('../scripts/cut-pauses');
const {
  buildConcatFilter,
  buildSegmentsConcatFilter,
  detectFilterScriptOption,
  filterScriptCommand,
  filterScriptOptionForVersion,
  runSegmentsTrim,
  runTrim,
  trimCommand,
} = require('../scripts/trim-media');

const hostile = `- lead 'single' "double" $() ;\nЮникод`;

test('trim command keeps hostile input, output and filter paths as literal argv', () => {
  const input = path.join(os.tmpdir(), hostile, 'input.mp4');
  const output = path.join(os.tmpdir(), hostile, 'output.mp4');
  const filter = path.join(os.tmpdir(), hostile, 'filter.txt');
  const command = trimCommand(input, output, filter);

  assert.equal(command.args[command.args.indexOf('-i') + 1], path.resolve(input));
  assert.equal(
    command.args[command.args.indexOf('-/filter_complex') + 1],
    path.resolve(filter),
  );
  assert.equal(command.args.at(-1), path.resolve(output));
});

test('tighten validates maxGap, pad, hookGuard and minDur ranges', () => {
  const invalid = {
    maxGap: ['NaN', '0', '61', '1;touch sentinel'],
    pad: ['NaN', '-0.1', '0', '5.1'],
    hookGuard: ['Infinity', '-1', '0', '61'],
    minDur: ['NaN', '0', '86401'],
  };
  for (const [name, values] of Object.entries(invalid)) {
    for (const value of values) {
      assert.throws(
        () => parseTightenOptions(['in.mp4', 'in.json', 'out.mp4', 'out.json', `--${name}`, value]),
        new RegExp(`--${name}`),
      );
    }
  }
});

test('cut-pauses validates positional maxGap and pad ranges', () => {
  for (const args of [
    ['in.mp4', 'in.json', 'out.mp4', 'NaN', '0.1'],
    ['in.mp4', 'in.json', 'out.mp4', '0', '0.1'],
    ['in.mp4', 'in.json', 'out.mp4', '61', '0.1'],
    ['in.mp4', 'in.json', 'out.mp4', '0.55', '-1'],
    ['in.mp4', 'in.json', 'out.mp4', '0.55', '0'],
    ['in.mp4', 'in.json', 'out.mp4', '0.55', '5.1'],
  ]) {
    assert.throws(() => parseCutOptions(args));
  }
});

test('trim filter rejects empty, invalid and overlapping intervals', () => {
  assert.throws(() => buildConcatFilter([]), /интервал/);
  assert.throws(() => buildConcatFilter([[1, 1]]), /интервал/);
  assert.throws(() => buildConcatFilter([[0, Infinity]]), /интервал/);
  assert.throws(() => buildConcatFilter([[0, 2], [1, 3]]), /пересека/);
  assert.match(buildConcatFilter([[0, 1], [2, 3]]), /concat=n=2/);
});

test('transcript word timings must be finite positive intervals', () => {
  assert.throws(() => collectWords([{ words: [
    { w: 'word', s: '1;touch sentinel', e: 2 },
  ] }]), /таймкод/);
  assert.throws(() => collectWords([{ words: [
    { w: 'word', s: 2, e: 1 },
  ] }]), /таймкод/);
});

test('failed ffmpeg always removes its temporary filter script', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-trim-cleanup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filterPath = path.join(dir, 'filter.txt');

  assert.throws(() => runTrim({
    input: path.join(dir, 'input.mp4'),
    output: path.join(dir, 'output.mp4'),
    intervals: [[0, 1]],
    filterPath,
  }, {
    run() {
      throw new Error('fake ffmpeg failed');
    },
  }), /fake ffmpeg failed/);

  assert.equal(fs.existsSync(filterPath), false);
});

test('invalid trimming CLI values fail before ffmpeg and cannot execute a sentinel', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-trim-sentinel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sentinel = path.join(dir, 'sentinel');
  const payload = `1;touch ${sentinel}`;
  const cases = [
    ['tighten.js', ['in.mp4', 'in.json', 'out.mp4', 'out.json', '--maxGap', payload]],
    ['cut-pauses.js', ['in.mp4', 'in.json', 'out.mp4', payload, '0.1']],
  ];
  for (const [script, args] of cases) {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
  }
  assert.equal(fs.existsSync(sentinel), false);
});

test('trimming scripts contain no shell execution escape hatch', () => {
  for (const file of ['tighten.js', 'cut-pauses.js', 'trim-media.js']) {
    const source = fs.readFileSync(path.join(ROOT, 'scripts', file), 'utf8');
    assert.doesNotMatch(source, /\bexecSync\b|shell\s*:\s*true/);
  }
});

test('ffmpeg 7+ and unversioned builds read filter scripts through -/filter_complex', () => {
  for (const banner of [
    'ffmpeg version 9.0.1 Copyright (c) 2000-2026 the FFmpeg developers',
    'ffmpeg version 7.1.1-full_build-www.gyan.dev Copyright (c) 2000-2025',
    'ffmpeg version n7.0.2 Copyright (c) 2000-2024',
    'ffmpeg version N-118123-g0123456789 Copyright (c) 2000-2026',
  ]) {
    assert.equal(filterScriptOptionForVersion(banner), '-/filter_complex', banner);
  }
  for (const banner of [
    'ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023',
    'ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright (c) 2000-2021',
  ]) {
    assert.equal(filterScriptOptionForVersion(banner), '-filter_complex_script', banner);
  }
});

test('runTrim passes the detected filter script option to ffmpeg', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-trim-option-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  runTrim({
    input: path.join(dir, 'in.mp4'),
    output: path.join(dir, 'out.mp4'),
    intervals: [[0, 1]],
    filterPath: path.join(dir, 'filter.txt'),
  }, {
    run(command, args) { calls.push(args); },
    detectOption: () => '-filter_complex_script',
  });
  assert.equal(calls[0].includes('-filter_complex_script'), true);
  assert.equal(calls[0].includes('-/filter_complex'), false);
  assert.equal(
    detectFilterScriptOption({ capture: () => 'ffmpeg version 9.0.1 Copyright' }),
    '-/filter_complex',
  );
  assert.equal(
    detectFilterScriptOption({ capture: () => { throw new Error('ENOENT'); } }),
    '-/filter_complex',
  );
});

test('single-input concat filter keeps its exact published shape', () => {
  assert.equal(
    buildConcatFilter([[0, 1], [2, 3]], { audioFadeSec: 0.04, precision: 6 }),
    '[0:v]trim=0.000000:1.000000,setpts=PTS-STARTPTS[v0];'
      + '[0:a]atrim=0.000000:1.000000,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.04,afade=t=out:st=0.960000:d=0.04[a0];'
      + '[0:v]trim=2.000000:3.000000,setpts=PTS-STARTPTS[v1];'
      + '[0:a]atrim=2.000000:3.000000,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.04,afade=t=out:st=0.960000:d=0.04[a1];'
      + '[v0][v1]concat=n=2:v=1:a=0[vout];[a0][a1]concat=n=2:v=0:a=1[aout]',
  );
});

test('multi-input filter normalizes FPS and audio format per segment', () => {
  assert.equal(
    buildSegmentsConcatFilter([
      { input: 1, start: 0.5, end: 2.5 },
      { input: 0, start: 1, end: 3 },
    ], {
      inputCount: 2,
      audioFadeSec: 0.04,
      precision: 6,
      fps: '25/1',
      audioFormat: { sampleRate: 48000, channelLayout: 'stereo' },
    }),
    '[1:v]trim=0.500000:2.500000,setpts=PTS-STARTPTS,fps=25/1[v0];'
      + '[1:a]atrim=0.500000:2.500000,asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,'
      + 'afade=t=in:st=0:d=0.04,afade=t=out:st=1.960000:d=0.04[a0];'
      + '[0:v]trim=1.000000:3.000000,setpts=PTS-STARTPTS,fps=25/1[v1];'
      + '[0:a]atrim=1.000000:3.000000,asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,'
      + 'afade=t=in:st=0:d=0.04,afade=t=out:st=1.960000:d=0.04[a1];'
      + '[v0][v1]concat=n=2:v=1:a=0[vout];[a0][a1]concat=n=2:v=0:a=1[aout]',
  );
});

test('multi-input filter rejects unknown inputs and filter injection', () => {
  const segment = [{ input: 0, start: 0, end: 1 }];
  assert.throws(() => buildSegmentsConcatFilter([{ input: 2, start: 0, end: 1 }], { inputCount: 2 }), /входн/);
  assert.throws(() => buildSegmentsConcatFilter([{ input: 0, start: 1, end: 1 }], { inputCount: 1 }), /end > start/);
  assert.throws(() => buildSegmentsConcatFilter([], { inputCount: 1 }), /сегмент/);
  assert.throws(() => buildSegmentsConcatFilter(segment, { inputCount: 1, fps: '25;[0:v]null' }), /FPS/);
  assert.throws(() => buildSegmentsConcatFilter(segment, {
    inputCount: 1, audioFormat: { sampleRate: 48000, channelLayout: '5.1' },
  }), /mono или stereo/);
  assert.throws(() => buildSegmentsConcatFilter(segment, {
    inputCount: 1, audioFormat: { sampleRate: '48000,volume=9', channelLayout: 'stereo' },
  }), /sample rate/);
});

test('multi-input command keeps every hostile input path as literal argv', () => {
  const first = path.join(os.tmpdir(), hostile, 'take-01.mp4');
  const second = path.join(os.tmpdir(), hostile, 'take-02.mov');
  const filter = path.join(os.tmpdir(), hostile, 'filter.txt');
  const output = path.join(os.tmpdir(), hostile, 'out.mp4');
  const command = filterScriptCommand([first, second], output, filter, {
    filterScriptOption: '-/filter_complex',
  });
  assert.deepEqual(command.args.slice(0, 7), [
    '-y', '-i', path.resolve(first), '-i', path.resolve(second), '-/filter_complex', path.resolve(filter),
  ]);
  assert.equal(command.args.at(-1), path.resolve(output));
  assert.throws(() => filterScriptCommand([], output, filter), /входной файл/);
});

test('runSegmentsTrim removes its filter script after a failed encode', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-segments-cleanup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filterPath = path.join(dir, 'filter.txt');
  const stages = [];
  assert.throws(() => runSegmentsTrim({
    inputs: [path.join(dir, 'a.mp4'), path.join(dir, 'b.mp4')],
    output: path.join(dir, 'out.mp4'),
    segments: [{ input: 1, start: 0, end: 1 }, { input: 0, start: 0, end: 1 }],
    filterPath,
  }, {
    run(command, args, options) { stages.push(options.stage); throw new Error('encode failed'); },
    detectOption: () => '-/filter_complex',
  }), /encode failed/);
  assert.deepEqual(stages, ['takes encode']);
  assert.equal(fs.existsSync(filterPath), false);
});
