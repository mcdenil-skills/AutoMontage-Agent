const test = require('node:test');
const assert = require('node:assert/strict');
const { buildConcatFilter, buildSegmentsConcatFilter, runTrim, runSegmentsTrim } = require('../scripts/trim-media');
const scale = { width: 1080, height: 1920 };
test('scale follows video concat with lanczos and square pixels', () => {
  assert.match(buildConcatFilter([[0, 1], [2, 3]], { scale }), /concat=n=2:v=1:a=0\[vcat\];\[vcat\]scale=1080:1920:flags=lanczos,setsar=1\[vout\]/);
  assert.match(buildSegmentsConcatFilter([{ input: 0, start: 0, end: 1 }], { scale }), /scale=1080:1920/);
});
test('without scale the filter retains its output labels and has no scale', () => {
  const filter = buildConcatFilter([[0, 1]]);
  assert.match(filter, /concat=n=1:v=1:a=0\[vout\]/);
  assert.doesNotMatch(filter, /scale=/);
});
test('trim runners write the requested scale into their filter scripts', () => {
  for (const run of [
    (deps) => runTrim({ input: 'in.mp4', output: 'out.mp4', intervals: [[0, 1]], scale }, deps),
    (deps) => runSegmentsTrim({ inputs: ['in.mp4'], output: 'out.mp4', segments: [{ input: 0, start: 0, end: 1 }], scale }, deps),
  ]) {
    let script;
    run({ fileSystem: { writeFileSync(file, text) { script = text; }, existsSync: () => false }, run() {}, filterScriptOption: '-/filter_complex' });
    assert.match(script, /scale=1080:1920:flags=lanczos,setsar=1\[vout\]/);
  }
});
test('invalid scale cannot enter the ffmpeg filter', () => {
  for (const value of [0, -2, 1081, 2.5, NaN, Infinity, '1080', '1080;null', undefined]) {
    for (const key of ['width', 'height']) {
      assert.throws(() => buildConcatFilter([[0, 1]], { scale: { ...scale, [key]: value } }), /scale|масштаб/);
    }
  }
});

test('native odd-side scaling preserves an explicit SAR and rejects filter injection', () => {
  assert.match(buildConcatFilter([[0,1]],{scale:{width:720,height:1280,sampleAspectRatio:'4:3'}}), /setsar=4\/3\[vout\]/);
  for (const sampleAspectRatio of ['4:3;null','0:1','1:0','1/1']) assert.throws(() => buildConcatFilter([[0,1]],{scale:{...scale,sampleAspectRatio}}), /scale/);
});
