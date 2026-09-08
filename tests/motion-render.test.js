const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { loadMotion, scenes, brief, dense } = require('./helpers/motion-render');
const { MOTION_SCENES, validateMotionBrief } = require('../scripts/motion/brief');

function html(Component, props) {
  return renderToStaticMarkup(React.createElement(Component, props));
}

test('all seven motion components render schema-maximum Cyrillic without a camera or default caption', () => {
  assert.equal(validateMotionBrief(brief()).ok, true);
  const { MOTION_COMPONENTS } = loadMotion('src/MotionDirector.jsx');
  assert.deepEqual(Object.keys(MOTION_COMPONENTS), MOTION_SCENES);
  for (const scene of scenes) {
    const markup = html(MOTION_COMPONENTS[scene.scene], { ...scene, durationInFrames: 90 });
    assert.match(markup, /data-motion-safe/);
    assert.match(markup, /data-motion-text/);
    assert.doesNotMatch(markup, /data-motion-caption/);
    assert.doesNotMatch(markup, /<video|<audio|faceSrc|FaceLayer/);
    for (const key of ['text', 'title', 'body', 'label', 'overlayText', 'action', 'handle']) {
      if (scene[key]) {
        // Word animation wraps text in spans; compare textual content without tags.
        const text = markup.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
        assert.ok(text.includes(scene[key].trim().replace(/\s+/g, ' ')), `${scene.scene}.${key} is preserved`);
      }
    }
  }
});

test('explicit caption text is rendered only when selected in the brief', () => {
  const { CardScene } = loadMotion('src/motion/CardScene.jsx');
  const markup = html(CardScene, { title: 'Заголовок', caption: dense(160), durationInFrames: 90 });
  assert.match(markup, /data-motion-caption/);
  assert.ok(markup.includes(dense(160)));
});

test('draft watermark is independent of the scene library and approved output has none', () => {
  const { MotionDirector } = loadMotion('src/MotionDirector.jsx');
  assert.match(html(MotionDirector, { scenes: [], draftPreview: true }), /data-draft-preview-watermark/);
  assert.doesNotMatch(html(MotionDirector, { scenes: [], draftPreview: false }), /data-draft-preview-watermark/);
});

test('media uses reviewed fit, local asset trim and defaults to muted video', () => {
  const { mediaPlaybackProps } = loadMotion('src/motion/MediaScene.jsx');
  assert.deepEqual(mediaPlaybackProps({ kind: 'video', src: 'assets/clip.mp4', fit: 'contain' }, 30), {
    trimBefore: 0, muted: true, objectFit: 'contain',
  });
  assert.deepEqual(mediaPlaybackProps({ kind: 'video', fit: 'cover', trimStartSec: 2.4, audioMode: 'mix' }, 25), {
    trimBefore: 60, muted: false, objectFit: 'cover',
  });
});

test('media component applies video trim and audio mode to the actual OffthreadVideo element', () => {
  const { MediaScene } = loadMotion('src/motion/MediaScene.jsx');
  for (const audioMode of [undefined, 'mute', 'mix', 'replace']) {
    const tree = MediaScene({ media: {
      kind: 'video', src: 'assets/clip.mp4', fit: 'cover', trimStartSec: 2.4, audioMode,
    }, durationInFrames: 90 });
    const video = React.Children.toArray(tree.props.children)[0].props.children;
    assert.equal(video.type, 'video');
    assert.equal(video.props.src, '/static/assets/clip.mp4');
    assert.equal(video.props.trimBefore, 72);
    assert.equal(video.props.muted, audioMode === undefined || audioMode === 'mute');
    assert.equal(video.props.style.objectFit, 'cover');
    if (audioMode === 'mix' || audioMode === 'replace') {
      assert.equal(video.props.volume(0), 0);
      assert.equal(video.props.volume(45), audioMode === 'mix' ? 10 ** (-18 / 20) : 1);
    }
  }
});

test('replacement media ducks the sole global narration on its global interval', () => {
  const { MotionDirector } = loadMotion('src/MotionDirector.jsx');
  const scene = { scene: 'media', start: 3, end: 6, media: { kind: 'video', src: 'a.mp4', fit: 'cover', audioMode: 'replace' } };
  const tree = MotionDirector({ scenes: [scene], audioSrc: 'voice.wav' });
  const audio = React.Children.toArray(tree.props.children).find((el) => el.type === 'audio');
  assert.equal(audio.props.volume(0), 1);
  assert.equal(audio.props.volume(100), 0);
  assert.equal(audio.props.volume(180), 1);
});

test('real MotionReel frames keep every maximum-length Cyrillic field inside safe zones', {
  skip: process.env.AUTOMONTAGE_TEST_MOTION_RENDER !== '1', timeout: 180_000,
}, async (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const { bundle } = require('@remotion/bundler');
  const { openBrowser, renderStill, selectComposition } = require('@remotion/renderer');
  const { buildMotionProps } = require('../scripts/motion/brief');
  const root = path.join(__dirname, '..');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-render-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const outputDir = process.env.AUTOMONTAGE_MOTION_FRAMES_DIR || path.join(work, 'frames');
  fs.mkdirSync(outputDir, { recursive: true });
  const publicDir = path.join(work, 'public');
  fs.mkdirSync(path.join(publicDir, 'assets'), { recursive: true });
  const ffmpeg = process.env.AUTOMONTAGE_FFMPEG_DIR
    ? path.join(process.env.AUTOMONTAGE_FFMPEG_DIR, 'ffmpeg') : 'ffmpeg';
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0xDEE7F3:s=640x480', '-frames:v', '1', path.join(publicDir, 'assets/test.png')]);
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=22', path.join(publicDir, 'narration.wav')]);
  const serveUrl = await bundle({ entryPoint: path.join(root, 'src/index.js'), publicDir, outDir: path.join(work, 'bundle') });
  const browser = await openBrowser('chrome', { logLevel: 'error' });
  t.after(() => browser.close({ silent: true }));
  const measured = [];
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...args) => {
    const page = await newPage(...args);
    const close = page.close.bind(page);
    page.close = async (...closeArgs) => {
      try {
        const boxes = await page.evaluate(() => {
          return [...document.querySelectorAll('[data-motion-text]')].map((box) => {
            const safe = box.closest('[data-motion-safe]').getBoundingClientRect();
            const rect = box.getBoundingClientRect();
            const content = box.firstElementChild.getBoundingClientRect();
            return {
              text: box.textContent, fontSize: getComputedStyle(box).fontSize,
              counter: box.hasAttribute('data-counter-value'),
              safe: { left: safe.left, right: safe.right, top: safe.top, bottom: safe.bottom },
              box: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
              content: { left: content.left, right: content.right, top: content.top, bottom: content.bottom },
              scrollWidth: box.firstElementChild.scrollWidth, clientWidth: box.clientWidth,
            };
          });
        });
        if (boxes.length) measured.push(boxes);
      } finally { await close(...closeArgs); }
    };
    return page;
  };
  const props = buildMotionProps({ brief: brief(), sourceFile: 'narration.wav' });
  const composition = await selectComposition({ serveUrl, id: 'MotionReel', inputProps: props, puppeteerInstance: browser });
  assert.equal(composition.durationInFrames, 660);
  for (const [variant, inputProps] of [
    ['dense', props],
    ['unbroken-caption', { ...props, scenes: scenes.map((scene) => {
      const next = { ...scene, caption: 'Щ'.repeat(160) };
      for (const key of ['text', 'title', 'body', 'label', 'overlayText', 'action', 'handle', 'prefix', 'suffix']) {
        if (next[key]) next[key] = 'Щ'.repeat(next[key].length);
      }
      if (next.steps) next.steps = next.steps.map((step) => 'Щ'.repeat(step.length));
      if (next.items) next.items = next.items.map((item) => 'Щ'.repeat(item.length));
      return next;
    }) }],
  ]) {
    for (let index = 0; index < scenes.length; index++) {
      const name = `${variant}-${scenes[index].scene}`;
      const frame = index * 90 + 89;
      await renderStill({ serveUrl, composition: { ...composition, props: inputProps }, inputProps,
        puppeteerInstance: browser, frame, imageFormat: 'png', output: path.join(outputDir, `${name}.png`), logLevel: 'error' });
      const boxes = measured.at(-1);
      assert.ok(boxes?.length, `${name}: actual DOM was measured`);
      for (const box of boxes) {
        assert.deepEqual(box.safe, { left: 70, right: 950, top: 250, bottom: 1500 });
        if (box.counter) assert.ok(box.content.bottom - box.content.top <= parseFloat(box.fontSize) * 1.17, `${name}: a number must remain on one line`);
        assert.ok(box.scrollWidth <= box.clientWidth + 1, `${name}: horizontal overflow ${JSON.stringify(box)}`);
        assert.ok(box.content.bottom <= box.box.bottom + 1, `${name}: text exceeds allocated box ${JSON.stringify(box)}`);
        for (const rect of [box.box, box.content]) {
          assert.ok(rect.left >= box.safe.left - 1 && rect.right <= box.safe.right + 1
            && rect.top >= box.safe.top - 1 && rect.bottom <= box.safe.bottom + 1,
          `${name}: safe-zone overflow ${JSON.stringify(box)}`);
        }
      }
    }
  }
  for (const [name, frame] of [['steps-early', 190], ['steps-connector', 200], ['counter-mid', 375], ['hook-early', 10], ['cta-enter', 555]]) {
    await renderStill({ serveUrl, composition, inputProps: props, puppeteerInstance: browser,
      frame, imageFormat: 'png', output: path.join(outputDir, `${name}.png`), logLevel: 'error' });
  }
  fs.writeFileSync(path.join(outputDir, 'layout-measurements.json'), JSON.stringify(measured, null, 2));
});
