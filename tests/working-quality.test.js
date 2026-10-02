const test = require('node:test');
const assert = require('node:assert/strict');
const { QUALITIES, parseQuality, workingSize, previewScale } = require('../scripts/working-quality');

test('1080p shrinks vertical and horizontal 4K by the short side', () => {
  for (const [input, expected] of [
    [{ width: 2160, height: 3840 }, { width: 1080, height: 1920, scaled: true }],
    [{ width: 3840, height: 2160 }, { width: 1920, height: 1080, scaled: true }],
    [{ width: 1440, height: 2560 }, { width: 1080, height: 1920, scaled: true }],
    [{ width: 1350, height: 2401 }, { width: 1080, height: 1920, scaled: true }],
  ]) assert.deepEqual(workingSize(input), expected);
});
test('1080p never upscales and source keeps native size', () => {
  assert.deepEqual(workingSize({ width: 1080, height: 1920 }), { width: 1080, height: 1920, scaled: false });
  assert.deepEqual(workingSize({ width: 720, height: 1280 }), { width: 720, height: 1280, scaled: false });
  assert.deepEqual(workingSize({ width: 2160, height: 3840 }, 'source'), { width: 2160, height: 3840, scaled: false });
});
test('odd native sides are rounded down without upscaling', () => {
  for (const quality of QUALITIES) {
    assert.deepEqual(workingSize({ width: 721, height: 1281 }, quality), { width: 720, height: 1280, scaled: true });
  }
});
test('quality aliases normalize and unknown values fail', () => {
  for (const value of ['1080', '1080p', '1080P']) assert.equal(parseQuality(value), '1080p');
  for (const value of ['source', '4K', 'native']) assert.equal(parseQuality(value), 'source');
  assert.throws(() => parseQuality('720p'), /неизвестное качество "720p"/);
  assert.throws(() => workingSize({ width: 720, height: 1280 }, '720p'), /неизвестное качество/);
});
test('preview caps the long side without enlarging small compositions', () => {
  assert.equal(previewScale({ width: 2160, height: 3840 }), 0.5);
  assert.equal(previewScale({ width: 3840, height: 2160 }), 0.5);
  assert.equal(previewScale({ width: 1080, height: 1920 }), 1);
  assert.equal(previewScale({ width: 720, height: 1280 }), 1);
  assert.equal(previewScale({ width: 1080, height: 3240 }), 1920 / 3240);
});
test('invalid dimensions fail before arithmetic', () => {
  for (const value of [0, -1, NaN, Infinity, '1080', null, undefined]) {
    for (const key of ['width', 'height']) {
      const size = { width: 1080, height: 1920, [key]: value };
      assert.throws(() => workingSize(size), /положительным/);
      assert.throws(() => previewScale(size), /положительным/);
    }
  }
  assert.throws(() => workingSize({ width: 1, height: 100 }), /минимум 2/);
});

test('preview H264 geometry matches Remotion even rounding for DCI in both orientations', () => {
  const { previewSize } = require('../scripts/working-quality');
  assert.deepEqual(previewSize({width:2048,height:1080}), {width:1920,height:1012});
  assert.deepEqual(previewSize({width:1080,height:2048}), {width:1012,height:1920});
});
test('working square pixels preserve anamorphic proportions without upscaling', () => {
  assert.deepEqual(workingSize({width:2880,height:2160,sampleAspectRatio:'4:3'}), {width:1920,height:1080,scaled:true});
  assert.deepEqual(workingSize({width:2160,height:2880,sampleAspectRatio:'3:4'}), {width:1080,height:1920,scaled:true});
  assert.deepEqual(workingSize({width:2880,height:2160,sampleAspectRatio:'4:3'}, 'source'), {width:2880,height:2160,scaled:false});
});
