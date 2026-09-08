const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { loadMotion, brief } = require('./helpers/motion-render');
const { buildMotionProps } = require('../scripts/motion/brief');

function children(element) {
  if (!element || typeof element !== 'object') return [];
  return [element, ...React.Children.toArray(element.props?.children).flatMap(children)];
}

test('MotionReel metadata keeps narration duration, geometry and FPS from validated props', () => {
  const { RemotionRoot } = loadMotion('src/Root.jsx');
  const comp = children(RemotionRoot()).find((el) => el.props.id === 'MotionReel');
  assert.ok(comp, 'MotionReel is registered');
  assert.equal(comp.props.width, 1080);
  assert.equal(comp.props.height, 1920);
  assert.equal(comp.props.fps, 30);
  const props = buildMotionProps({ brief: brief() });
  assert.deepEqual(comp.props.calculateMetadata({ props }), {
    durationInFrames: 660, width: 1080, height: 1920, fps: 30,
  });
  assert.deepEqual(comp.props.calculateMetadata({ props: { ...props, width: 720, height: 1280, fps: 25, durationInFrames: 550 } }), {
    durationInFrames: 550, width: 720, height: 1280, fps: 25,
  });
});

test('one narration Audio is at root frame zero, scenes have global sequences and no face source', () => {
  const { MotionDirector } = loadMotion('src/MotionDirector.jsx');
  const props = buildMotionProps({ brief: brief() });
  const tree = MotionDirector(props);
  const all = children(tree);
  const audio = all.filter((el) => el.type === 'audio');
  const sequences = all.filter((el) => el.type === 'sequence');
  assert.equal(audio.length, 1);
  assert.equal(audio[0].props.src, '/static/narration.mp3');
  assert.equal(audio[0].props.trimBefore, undefined);
  assert.equal(sequences.length, 7);
  sequences.forEach((seq, index) => {
    assert.equal(seq.props.from, index * 90);
    assert.equal(seq.props.durationInFrames, 90);
    assert.equal(children(seq).filter((el) => el.type === 'audio').length, 0);
    assert.equal(seq.props.children.props.durationInFrames, 90);
  });
  assert.equal(all.some((el) => el.props.faceSrc || el.type === 'video'), false);
});

test('motion timing rounds absolute endpoints without drifting at fractional FPS', () => {
  const { getMotionTiming } = loadMotion('src/MotionDirector.jsx');
  const fps = 30000 / 1001;
  assert.deepEqual(getMotionTiming({ start: 101 / fps, end: 202 / fps }, fps), {
    from: 101, durationInFrames: 101,
  });
});

test('steps reveal node, then connector, then next node in local frame time', () => {
  const { stepState } = loadMotion('src/motion/StepsScene.jsx');
  for (const fps of [25, 30, 60]) {
    const duration = fps * 8;
    const first = stepState(0, fps, duration, 4);
    assert.ok(first.nodes[0] > 0);
    assert.equal(first.connectors[0], 0);
    assert.equal(first.nodes[1], 0);
    const connected = stepState(Math.round(fps * 1.3), fps, duration, 4);
    assert.equal(connected.nodes[0], 1);
    assert.ok(connected.connectors[0] > 0);
    assert.equal(connected.nodes[1], 0);
    const final = stepState(duration - 1, fps, duration, 4);
    assert.deepEqual(final.nodes, [1, 1, 1, 1]);
    assert.deepEqual(final.connectors, [1, 1, 1]);
  }
});

test('counter interpolates signed, fractional and extreme approved values and finishes exactly', () => {
  const { counterValue } = loadMotion('src/motion/CounterScene.jsx');
  for (const value of [42, -123.45, 0.000001, 1e100, Number.MAX_VALUE]) {
    assert.equal(counterValue(0, 30, 90, value), 0);
    const middle = counterValue(15, 30, 90, value);
    assert.ok(Number.isFinite(middle));
    assert.ok(Math.abs(middle) > 0 && Math.abs(middle) < Math.abs(value));
    assert.equal(counterValue(89, 30, 90, value), value);
    assert.equal(counterValue(0, 30, 1, value), value);
  }
});

test('short scenes show all content on the last frame, including one-frame scenes', () => {
  const { stepState } = loadMotion('src/motion/StepsScene.jsx');
  for (const duration of [1, 2, 5, 15]) {
    assert.deepEqual(stepState(duration - 1, 30, duration, 4).nodes, [1, 1, 1, 1]);
  }
});

test('counter component actually renders intermediate numeric text, not just final approved value', () => {
  let frame = 0;
  const { CounterScene } = loadMotion('src/motion/CounterScene.jsx', { useCurrentFrame: () => frame });
  const scene = { label: 'Рост', value: 100, suffix: '%', durationInFrames: 90 };
  const at = (nextFrame) => {
    frame = nextFrame;
    return renderToStaticMarkup(React.createElement(CounterScene, scene));
  };
  assert.match(at(0), /data-counter-value="0"/);
  const mid = at(15);
  assert.doesNotMatch(mid, /data-counter-value="(?:0|100)"/);
  assert.match(at(89), /data-counter-value="100"/);
});
