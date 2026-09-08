const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MOTION_SCENES,
  buildDraftMotionProps,
  buildMotionProps,
  formatMotionBriefMarkdown,
  validateMotionBrief,
} = require('../scripts/motion/brief');

function makeBrief(overrides = {}) {
  return {
    version: 1,
    kind: 'motion-reel',
    status: 'draft',
    source: 'input/narration.mp3',
    theme: 'motion-neutral',
    title: 'Семь сцен',
    output: {
      aspect: 'vertical',
      width: 1080,
      height: 1920,
      fps: 30,
      durationInFrames: 630,
    },
    scenes: [
      { scene: 'kinetic-title', start: 0, end: 3, text: 'Главная мысль', emphasis: 'мысль' },
      { scene: 'card', start: 3, end: 6, title: 'Карточка', body: 'Один понятный тезис' },
      { scene: 'steps', start: 6, end: 9, title: 'Процесс', steps: ['Первый', 'Второй', 'Третий'] },
      { scene: 'list', start: 9, end: 12, title: 'Список', items: ['Раз', 'Два', 'Три'] },
      { scene: 'counter', start: 12, end: 15, label: 'Результат', value: 42, suffix: '%' },
      {
        scene: 'media',
        start: 15,
        end: 18,
        media: {
          kind: 'image',
          src: 'assets/broll/chart.png',
          sha256: 'a'.repeat(64),
          fit: 'contain',
        },
        overlayText: 'Проверенный файл',
      },
      { scene: 'cta', start: 18, end: 21, title: 'Сохраните', action: 'Подпишитесь', handle: '@example' },
    ],
    ...overrides,
  };
}

test('motion brief accepts the seven official scene contracts', () => {
  assert.deepEqual(MOTION_SCENES, [
    'kinetic-title',
    'card',
    'steps',
    'list',
    'counter',
    'media',
    'cta',
  ]);
  assert.deepEqual(validateMotionBrief(makeBrief()), { ok: true, errors: [] });
});

test('motion brief rejects overlapping, off-frame and over-duration timing', () => {
  const cases = [
    {
      name: 'overlap',
      scenes: [
        { scene: 'card', start: 0, end: 2, title: 'Один' },
        { scene: 'card', start: 1.5, end: 3, title: 'Два' },
      ],
      pattern: /пересекается/i,
    },
    {
      name: 'off-frame',
      scenes: [{ scene: 'card', start: 0, end: 1.01, title: 'Мимо кадра' }],
      pattern: /границ.*кадр/i,
    },
    {
      name: 'past narration',
      scenes: [{ scene: 'card', start: 20, end: 22, title: 'Слишком поздно' }],
      pattern: /длительност/i,
    },
  ];

  for (const current of cases) {
    const result = validateMotionBrief(makeBrief({ scenes: current.scenes }));
    assert.equal(result.ok, false, current.name);
    assert.match(result.errors.join('\n'), current.pattern, current.name);
  }
});

test('motion brief rejects every non-finite scene time and counter value', () => {
  const parsedInfinity = JSON.parse('{"value":1e309}').value;
  const cases = [
    ['start Infinity', { scene: 'card', start: parsedInfinity, end: 3, title: 'Тест' }],
    ['start -Infinity', { scene: 'card', start: -Infinity, end: 3, title: 'Тест' }],
    ['start NaN', { scene: 'card', start: NaN, end: 3, title: 'Тест' }],
    ['end Infinity', { scene: 'card', start: 0, end: Infinity, title: 'Тест' }],
    ['end -Infinity', { scene: 'card', start: 0, end: -Infinity, title: 'Тест' }],
    ['end NaN', { scene: 'card', start: 0, end: NaN, title: 'Тест' }],
    ['counter Infinity', {
      scene: 'counter', start: 0, end: 3, label: 'Тест', value: Infinity,
    }],
    ['counter -Infinity', {
      scene: 'counter', start: 0, end: 3, label: 'Тест', value: -Infinity,
    }],
    ['counter NaN', {
      scene: 'counter', start: 0, end: 3, label: 'Тест', value: NaN,
    }],
  ];
  const accepted = cases
    .filter(([, scene]) => validateMotionBrief(makeBrief({ scenes: [scene] })).ok)
    .map(([name]) => name);

  assert.deepEqual(accepted, []);
});

test('motion brief rejects text beyond its scene limit and unknown executable fields', () => {
  const tooLong = makeBrief({
    scenes: [{ scene: 'kinetic-title', start: 0, end: 3, text: 'я'.repeat(121) }],
  });
  const executable = makeBrief({
    scenes: [{
      scene: 'card', start: 0, end: 3, title: 'Опасно', html: '<script>alert(1)</script>',
    }],
  });

  assert.equal(validateMotionBrief(tooLong).ok, false);
  const result = validateMotionBrief(executable);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /additional properties|html/i);
});

test('motion media requires a content-bound canonical project reference', () => {
  for (const src of [
    'https://example.com/image.png',
    '../outside.png',
    '/tmp/outside.png',
    'assets/broll/../outside.png',
    'assets/%2e%2e%2f%2e%2e%2foutside.png',
    'assets%2f..%2foutside.png',
    'assets/%5c..%5coutside.png',
    'assets/%252e%252e%252foutside.png',
  ]) {
    const brief = makeBrief({
      scenes: [{
        scene: 'media',
        start: 0,
        end: 3,
        media: { kind: 'image', src, sha256: 'b'.repeat(64), fit: 'cover' },
      }],
    });
    const result = validateMotionBrief(brief);
    assert.equal(result.ok, false, src);
    assert.match(result.errors.join('\n'), /media.*src|каноническ|проект/i, src);
  }

  const withoutHash = makeBrief({
    scenes: [{
      scene: 'media', start: 0, end: 3, media: { kind: 'image', src: 'assets/broll/photo.png', fit: 'cover' },
    }],
  });
  assert.equal(validateMotionBrief(withoutHash).ok, false);

  const canonicalEncodedName = makeBrief({
    scenes: [{
      scene: 'media',
      start: 0,
      end: 3,
      media: {
        kind: 'image',
        src: 'assets/broll/diagram%20final.png',
        sha256: 'c'.repeat(64),
        fit: 'contain',
      },
    }],
  });
  assert.deepEqual(validateMotionBrief(canonicalEncodedName), { ok: true, errors: [] });
});

test('draft and approved builders enforce status and expose camera-free props', () => {
  const draft = makeBrief();
  const approved = { ...draft, status: 'approved', approval: { draftSha256: 'a'.repeat(64), sourceSha256: 'b'.repeat(64), previewSha256: 'c'.repeat(64), confirmedAt: '2026-09-08T10:00:00.000Z' } };

  assert.throws(() => buildMotionProps({ brief: draft }), /approved/i);
  assert.throws(() => buildDraftMotionProps({ brief: approved }), /draft/i);

  const draftProps = buildDraftMotionProps({ brief: draft, sourceFile: 'voice.wav' });
  assert.equal(draftProps.audioSrc, 'voice.wav');
  assert.equal(draftProps.draftPreview, true);
  assert.equal(Object.hasOwn(draftProps, 'faceSrc'), false);

  const approvedProps = buildMotionProps({ brief: approved, sourceFile: 'voice.wav' });
  assert.equal(approvedProps.audioSrc, 'voice.wav');
  assert.equal(approvedProps.durationInFrames, 630);
  assert.equal(Object.hasOwn(approvedProps, 'faceSrc'), false);
});

test('motion Markdown identifies status and summarizes every scene', () => {
  const markdown = formatMotionBriefMarkdown(makeBrief());
  assert.match(markdown, /^# Motion Reel: Семь сцен$/m);
  assert.match(markdown, /^Статус: `draft`$/m);
  for (const scene of MOTION_SCENES) assert.match(markdown, new RegExp(`\\| ${scene} \\|`));
});
