#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { deflateSync } = require('node:zlib');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const PUBLIC_TEXT_FIXTURES = Object.freeze([
  'src/data/transcript.json',
  'src/data/captions.js',
  'props/job1v.json',
  'props/preview.json',
  'props/preview_h.json',
  'examples/motion-brief-demo.json',
]);
const TEXT = 'Это нейтральное демо автомонтажа. Агент получает исходник, добавляет титры, '
  + 'выбирает визуальные сцены и собирает готовый ролик. Личные материалы остаются локально.';

function roundTime(value) {
  return Math.round(value * 100) / 100;
}

function timedWords() {
  let cursor = 0.35;
  return TEXT.split(' ').map((token) => {
    const letters = token.replace(/[.,!?]/gu, '').length;
    const start = roundTime(cursor);
    const end = roundTime(start + Math.min(0.64, 0.22 + letters * 0.025));
    cursor = end + (/[.!?]$/u.test(token) ? 0.28 : 0.08);
    return { w: token, s: start, e: end };
  });
}

function captionGroups(words) {
  const groups = [];
  for (let index = 0; index < words.length; index += 4) {
    const groupWords = words.slice(index, index + 4);
    groups.push({
      start: groupWords[0].s,
      end: groupWords.at(-1).e,
      words: groupWords,
    });
  }
  return groups;
}

function blocks(captions, horizontal) {
  const position = horizontal ? { h: 'right', v: 'top' } : undefined;
  const withPosition = (block) => (position ? { ...block, pos: position } : block);
  return [
    { type: 'LabelTop', start: 0.3, text: '>_ ДЕМО АВТОМОНТАЖА' },
    {
      type: 'CaptionsAuto',
      start: 0,
      groups: captions,
      pos: horizontal ? 'bottom' : 'top',
      offset: horizontal ? 40 : 150,
    },
    withPosition({
      type: 'InfoCard',
      start: 0.8,
      end: 4.1,
      tag: '// PIPELINE',
      title: 'ИСХОДНИК → СЦЕНЫ',
      pills: ['локальная обработка', 'готовый план'],
    }),
    {
      type: 'BrollFullscreen',
      start: 4.3,
      end: 7.1,
      image: 'broll/screenshot.png',
      caption: 'визуальные сцены',
      fit: horizontal ? 'contain' : 'cover',
      transition: 'slide',
    },
    withPosition({
      type: 'SubtitleCard',
      start: 7.3,
      end: 10.1,
      text: 'Титры по таймкоду',
      accent: true,
      sub: 'синхронно с речью',
    }),
    {
      type: 'BrollFullscreen',
      start: 10.3,
      end: 12.4,
      image: 'broll/growth.png',
      caption: 'готовый ролик',
      fit: 'contain',
      transition: 'wipe',
    },
    withPosition({
      type: 'CTACard',
      start: 12.5,
      head: 'СОБЕРИ ДЕМО',
      btn: 'automontage demo',
    }),
  ];
}

function propsFixture({ captions, width, height, horizontal = false }) {
  return {
    source: 'demo-source.mp4',
    theme: 'craft',
    width,
    height,
    fps: 25,
    durationInFrames: 350,
    beatZoom: true,
    beatSec: 3,
    blocks: blocks(captions, horizontal),
  };
}

function writeText(root, relativePath, source) {
  const destination = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, source);
}

// Algorithmic fixtures only: these tones are not speech or a user's voice.
function neutralToneWav(scenes, sampleRate = 24000) {
  const durationSec = scenes.at(-1).end;
  const samples = durationSec * sampleRate;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(samples * 2, 40);
  const frequencies = [220, 275, 330, 440, 330, 275, 220];
  let sceneIndex = 0;
  for (let i = 0; i < samples; i += 1) {
    const time = i / sampleRate;
    while (sceneIndex < scenes.length - 1 && time >= scenes[sceneIndex].end) sceneIndex += 1;
    const phase = time % 0.75;
    const envelope = Math.min(1, phase / 0.03) * Math.max(0, 1 - phase / 0.6);
    const frequency = frequencies[sceneIndex];
    bytes.writeInt16LE(Math.round(2600 * envelope * Math.sin(2 * Math.PI * frequency * time)), 44 + i * 2);
  }
  return bytes;
}

function pngChunk(type, data) {
  const content = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, content, checksum]);
}

function neutralMotionImage() {
  const size = 320;
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const circle = (x - 160) ** 2 + (y - 145) ** 2 < 90 ** 2;
    const color = circle ? [130, 180, 210] : y > 245 ? [200, 210, 215] : [237, 242, 244];
    rows.set(color, y * (size * 3 + 1) + 1 + x * 3);
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}

function buildMotionDemoFixture() {
  const imageBytes = neutralMotionImage();
  // Native reveal timing leaves a deliberate reading hold in the two dense scenes.
  const durations = [3, 3, 5, 7, 3, 3, 3];
  let cursor = 0;
  const scenes = [
    { scene: 'kinetic-title', text: 'Идея приходит в движение' },
    { scene: 'card', title: 'Одна мысль', body: 'Каждая сцена объясняет один простой тезис.' },
    { scene: 'steps', title: 'Порядок действий', steps: ['Придумать', 'Проверить', 'Собрать'] },
    { scene: 'list', title: 'Что проверить', items: ['Понятный заголовок', 'Читаемый текст', 'Спокойный ритм', 'Ясный следующий шаг'] },
    { scene: 'counter', label: 'Типов сцен в этом демо', value: 7 },
    { scene: 'media', overlayText: 'Нейтральная геометрия', media: { kind: 'image', src: 'assets/neutral.png',
      sha256: createHash('sha256').update(imageBytes).digest('hex'), fit: 'contain' } },
    { scene: 'cta', title: 'Проверьте результат', action: 'Посмотрите полный черновик' },
  ].map((scene, index) => {
    const start = cursor;
    cursor += durations[index];
    return { ...scene, start, end: cursor };
  });
  const transcript = scenes.map(scene => {
    const text = scene.text || scene.title || scene.label || scene.overlayText;
    const tokens = text.split(' ');
    const step = (scene.end - scene.start) / tokens.length;
    return { start: scene.start, end: scene.end, text, words: tokens.map((w, index) => ({ w,
      s: scene.start + index * step, e: scene.start + (index + 0.8) * step })) };
  });
  return {
    brief: { version: 1, kind: 'motion-reel', status: 'draft', source: 'input/narration.wav',
      theme: 'motion-neutral', title: 'Нейтральное motion-демо',
      output: { aspect: 'vertical', width: 1080, height: 1920, fps: 30, durationInFrames: cursor * 30 }, scenes },
    script: 'Синтетическое демо: тестовые тоны, не речь. Таймкоды иллюстративные, не результат распознавания.\n\n'
      + transcript.map(segment => segment.text).join('\n') + '\n',
    transcript, audioBytes: neutralToneWav(scenes), imageBytes,
  };
}

function generateNeutralFixtures({ root = REPOSITORY_ROOT } = {}) {
  const destinationRoot = path.resolve(root);
  const words = timedWords();
  const captions = captionGroups(words);
  const transcript = [{
    start: words[0].s,
    end: words.at(-1).e,
    text: TEXT,
    words: words.map((word) => ({ ...word, w: ` ${word.w}` })),
  }];
  const fixtures = {
    'examples/motion-brief-demo.json': `${JSON.stringify(buildMotionDemoFixture().brief, null, 2)}\n`,
    'src/data/transcript.json': `${JSON.stringify(transcript, null, 2)}\n`,
    'src/data/captions.js': [
      '// АВТОГЕНЕРАЦИЯ (scripts/generate-neutral-fixtures.js).',
      `export const CAPTIONS = ${JSON.stringify(captions, null, 2)};`,
      '',
    ].join('\n'),
    'props/job1v.json': `${JSON.stringify(propsFixture({
      captions, width: 1080, height: 1920,
    }), null, 2)}\n`,
    'props/preview.json': `${JSON.stringify(propsFixture({
      captions, width: 1080, height: 1920,
    }), null, 2)}\n`,
    'props/preview_h.json': `${JSON.stringify(propsFixture({
      captions, width: 1280, height: 720, horizontal: true,
    }), null, 2)}\n`,
  };

  for (const relativePath of PUBLIC_TEXT_FIXTURES) {
    writeText(destinationRoot, relativePath, fixtures[relativePath]);
  }
  return { files: [...PUBLIC_TEXT_FIXTURES], transcript, captions };
}

if (require.main === module) {
  const result = generateNeutralFixtures();
  console.log(`neutral fixtures: ${result.files.length}`);
}

module.exports = {
  PUBLIC_TEXT_FIXTURES,
  TEXT,
  generateNeutralFixtures,
  buildMotionDemoFixture,
};
