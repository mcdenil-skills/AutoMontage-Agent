const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  audioExtractionCommand,
  frameAnalysisCommand,
  paletteCommand,
  reframeCommand,
  remotionRenderCommand,
  videoProbeCommand,
} = require('../scripts/build-commands');
const { parseBuildOptions } = require('../scripts/build-options');

const ROOT = path.resolve(__dirname, '..');
const HOSTILE = path.resolve(ROOT, `tmp/- clip ' " $() ;\nЮникод.mp4`);

function runBuildWithIntercept(t, args, {
  ffprobeRates = ['30/1'],
  materializeFinish = false,
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-build-intercept-'));
  const hook = path.join(directory, 'hook.js');
  const calls = path.join(directory, 'calls.jsonl');
  // build.js кладёт промежуточные файлы в os.tmpdir(); держим их внутри directory.
  const temporary = path.join(directory, 'tmp');
  fs.mkdirSync(temporary);
  fs.writeFileSync(hook, [
    "const childProcess = require('node:child_process');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const calls = process.env.AUTOMONTAGE_BUILD_CAPTURE;",
    `const ffprobeRates = ${JSON.stringify(ffprobeRates)};`,
    `const materializeFinish = ${JSON.stringify(materializeFinish)};`,
    'let ffprobeIndex = 0;',
    'childProcess.spawnSync = (command, args) => {',
    "  fs.appendFileSync(calls, JSON.stringify({ command, args }) + '\\n');",
    "  if (command === 'ffprobe') {",
    '    const rate = ffprobeRates[Math.min(ffprobeIndex, ffprobeRates.length - 1)];',
    '    ffprobeIndex += 1;',
    "    return { status: 0, stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 1080, height: 1920, r_frame_rate: rate }], format: { duration: '20' } }) };",
    '  }',
    "  if (args[0] === '--version') return { status: 0, stdout: 'Python 3.12.0' };",
    "  if (path.basename(args[0]) === 'reframe.py') { fs.writeFileSync(args[2], 'reframed'); return { status: 0, stdout: '' }; }",
    "  if (command === process.execPath && path.basename(args[0]) === 'tighten.js') { fs.writeFileSync(args[3], 'tightened'); return { status: 0, stdout: '' }; }",
    "  if (command === process.execPath && path.basename(args[0]) === 'build-captions.js') {",
    "    fs.mkdirSync(path.dirname(args[2]), { recursive: true });",
    "    fs.writeFileSync(args[2], 'module.exports = { CAPTIONS: [] };\\n');",
    "    return { status: 0, stdout: 'captions ready' };",
    '  }',
    "  if (materializeFinish && command === process.execPath && path.basename(args[0]) === 'finish.js') {",
    "    fs.mkdirSync(path.dirname(args[2]), { recursive: true });",
    "    fs.writeFileSync(args[2], 'finished-dynamic');",
    "    return { status: 0, stdout: '' };",
    '  }',
    "  return { status: 0, stdout: '' };",
    '};',
    '',
  ].join('\n'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/build.js'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      TMPDIR: temporary,
      TEMP: temporary,
      TMP: temporary,
      AUTOMONTAGE_BUILD_CAPTURE: calls,
      NODE_OPTIONS: `--require=${hook}`,
    },
  });
  const invocations = fs.existsSync(calls)
    ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
  return { result, invocations };
}

test('build process builders keep hostile host paths as one absolute argv', () => {
  const probe = videoProbeCommand(HOSTILE);
  assert.equal(probe.command, 'ffprobe');
  assert.equal(probe.args.at(-1), HOSTILE);

  const reframe = reframeCommand('/python 3', ROOT, HOSTILE, `${HOSTILE}.out`, 'track');
  assert.equal(reframe.command, '/python 3');
  assert.deepEqual(reframe.args.slice(0, 3), [
    path.join(ROOT, 'scripts/reframe.py'),
    HOSTILE,
    `${HOSTILE}.out`,
  ]);

  const audio = audioExtractionCommand(HOSTILE, `${HOSTILE}.wav`);
  assert.equal(audio.args[2], HOSTILE);
  assert.deepEqual(audio.args.slice(-3), ['-ac', '1', `${HOSTILE}.wav`]);

  const analysis = frameAnalysisCommand('/python 3', ROOT, HOSTILE, '1,2', `${HOSTILE}.json`);
  assert.equal(analysis.args[1], HOSTILE);
  assert.equal(analysis.args.at(-1), `${HOSTILE}.json`);

  const palette = paletteCommand(ROOT, HOSTILE, 0.5);
  assert.equal(palette.command, process.execPath);
  assert.equal(palette.args[1], HOSTILE);
});

test('Remotion keeps entry refs relative and host output paths absolute', () => {
  const resolved = { command: process.execPath, argsPrefix: ['/repo/remotion-cli.js'] };
  const publicDir = path.resolve(ROOT, 'tmp/isolated public');
  const command = remotionRenderCommand(resolved, {
    entry: 'src/index.js',
    composition: 'Dynamic',
    output: HOSTILE,
    props: `${HOSTILE}.json`,
    publicDir,
  });
  assert.equal(command.args[2], 'src/index.js');
  assert.equal(command.args[4], HOSTILE);
  assert.deepEqual(command.args.slice(5, 7), ['--props', `${HOSTILE}.json`]);
  assert.deepEqual(command.args.slice(7, 9), ['--public-dir', publicDir]);
});

test('Remotion preview options stay typed and become separate argv entries', () => {
  const resolved = { command: process.execPath, argsPrefix: ['/repo/remotion-cli.js'] };
  const command = remotionRenderCommand(resolved, {
    entry: 'src/index.js',
    composition: 'ReelScenes',
    output: HOSTILE,
    props: `${HOSTILE}.json`,
    scale: 0.5,
    crf: 28,
    frameRange: { fromFrame: 250, toFrameExclusive: 500 },
    concurrency: '50%',
    overwrite: true,
  });

  assert.deepEqual(command.args.slice(-7), [
    '--codec=h264',
    '--log=error',
    '--scale=0.5',
    '--crf=28',
    '--frames=250-499',
    '--concurrency=50%',
    '--overwrite',
  ]);
  for (const invalid of [
    { scale: 0 },
    { crf: 52 },
    { frameRange: { fromFrame: 20, toFrameExclusive: 20 } },
    { concurrency: '50%;touch sentinel' },
    { overwrite: 'yes' },
  ]) {
    assert.throws(() => remotionRenderCommand(resolved, {
      entry: 'src/index.js',
      composition: 'ReelScenes',
      output: HOSTILE,
      props: `${HOSTILE}.json`,
      ...invalid,
    }), /scale|crf|frame|concurrency|overwrite/i);
  }
});

test('build rejects non-finite, out-of-range and injected numeric options', () => {
  for (const [flag, value] of [
    ['--frames', '0'], ['--frames', '1.5'], ['--frames', 'Infinity'],
    ['--max', '0'], ['--max', '101'], ['--max', '1;touch sentinel'],
    ['--beatSec', '0'], ['--beatSec', '61'], ['--beatSec', 'NaN'],
    ['--brandLock', '-0.1'], ['--brandLock', '1.1'], ['--brandLock', '$()'],
  ]) {
    assert.throws(() => parseBuildOptions([flag, value]), new RegExp(flag.slice(2)));
  }
});

test('build accepts only supported reframe modes and valid ranges', () => {
  assert.equal(parseBuildOptions(['--reframe']).reframeMode, 'track');
  assert.equal(parseBuildOptions(['--reframe', 'static']).reframeMode, 'static');
  assert.throws(() => parseBuildOptions(['--reframe', 'crop;touch']), /reframe/);
  assert.deepEqual(parseBuildOptions([
    '--frames', '75', '--max', '8', '--beatSec', '2.5', '--brandLock', '0.4',
  ]), {
    framesOverride: 75,
    maxScenes: 8,
    beatSec: 2.5,
    brandLock: 0.4,
    reframeMode: null,
  });
});

test('central build contains no shell execution escape hatch', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/build.js'), 'utf8');
  assert.doesNotMatch(source, /\bexecSync\b/);
  assert.doesNotMatch(source, /shell\s*:\s*true/);
});

test('build preserves the final fractional ffprobe rate through props and render invocation', (t) => {
  const id = `fractional-derived-${process.pid}-${Date.now()}`;
  const propsPath = path.join(ROOT, 'out', `${id}.props.json`);
  t.after(() => fs.rmSync(propsPath, { force: true }));

  const { result, invocations } = runBuildWithIntercept(t, [
    'examples/demo-source.mp4',
    '--scenario', 'examples/scenario-demo.json',
    '--reframe', 'static',
    '--tighten',
    '--frames', '25',
    '--id', id,
  ], {
    ffprobeRates: ['25/1', '24000/1001', '30000/1001'],
  });

  assert.equal(result.status, 0, result.stderr);
  const props = JSON.parse(fs.readFileSync(propsPath, 'utf8'));
  assert.equal(props.fps, 30000 / 1001);
  const render = invocations.find((entry) => entry.args.includes('Dynamic'));
  assert.ok(render, 'Dynamic Remotion render should be invoked');
  assert.equal(render.args[render.args.indexOf('--props') + 1], propsPath);
});

test('invalid build values fail before ffprobe or sentinel execution', () => {
  const sentinel = path.join(ROOT, 'tmp', 'build-option-sentinel');
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/build.js'),
    path.join(ROOT, 'examples/demo-source.mp4'),
    '--frames', `1;touch ${sentinel}`,
  ], { cwd: ROOT, encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--frames/);
  assert.doesNotMatch(result.stdout, /видео .*fps/);
  assert.equal(fs.existsSync(sentinel), false);
});

test('long Dynamic render gives Remotion a unique lease and muxes the same absolute source', (t) => {
  const id = `lease-dynamic-${process.pid}-${Date.now()}`;
  const propsPath = path.join(ROOT, 'out', `${id}.props.json`);
  t.after(() => fs.rmSync(propsPath, { force: true }));

  const { result, invocations } = runBuildWithIntercept(t, [
    'examples/demo-source.mp4',
    '--scenario', 'examples/scenario-demo.json',
    '--no-transcribe',
    '--frames', '600',
    '--id', id,
  ]);

  assert.equal(result.status, 0, result.stderr);
  const props = JSON.parse(fs.readFileSync(propsPath, 'utf8'));
  assert.match(props.source, /^\.automontage\/dynamic-[0-9a-f-]+\/source\.mp4$/);
  const chunkRender = invocations.find((entry) => path.basename(entry.args[0]) === 'render-chunks.js');
  assert.ok(chunkRender, 'long build should invoke render-chunks.js');
  assert.equal(chunkRender.args.at(-1), path.join(ROOT, 'public', props.source));
  assert.equal(fs.existsSync(path.join(ROOT, 'public', props.source)), false);
});

test('Dynamic export rejects a pre-existing final symlink without overwriting its target', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-dynamic-export-'));
  const id = `dynamic-export-${process.pid}-${Date.now()}`;
  const propsPath = path.join(ROOT, 'out', `${id}.props.json`);
  const builtPath = path.join(ROOT, 'out', `${id}.mp4`);
  const sentinel = path.join(fixture, 'outside.mp4');
  const destination = path.join(fixture, `${id}.mp4`);
  fs.writeFileSync(sentinel, 'outside-must-survive');
  fs.symlinkSync(sentinel, destination, 'file');
  t.after(() => {
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.rmSync(propsPath, { force: true });
    fs.rmSync(builtPath, { force: true });
  });

  const { result } = runBuildWithIntercept(t, [
    'examples/demo-source.mp4',
    '--scenario', 'examples/scenario-demo.json',
    '--no-transcribe',
    '--frames', '25',
    '--id', id,
    '--outdir', fixture,
  ], { materializeFinish: true });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /symbolic link/i);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside-must-survive');
  assert.equal(fs.lstatSync(destination).isSymbolicLink(), true);
});
