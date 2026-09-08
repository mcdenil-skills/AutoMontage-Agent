const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');
const { frameSnapSeconds, isCanonicalBrollReference } = require('../lesson/broll-media');

const MOTION_SCENES = [
  'kinetic-title',
  'card',
  'steps',
  'list',
  'counter',
  'media',
  'cta',
];

const MOTION_MEDIA_EXTENSIONS = {
  image: new Set(['.avif', '.gif', '.jpeg', '.jpg', '.png', '.webp']),
  video: new Set(['.m4v', '.mov', '.mp4', '.webm']),
};

const schemaPath = path.join(__dirname, '../../schema/motion-brief.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const validator = new Ajv({ allErrors: true, strict: false, strictNumbers: true }).compile(schema);

function schemaErrors(brief) {
  if (validator(brief)) return [];
  return (validator.errors || []).map((error) => {
    const location = error.instancePath || '(корень)';
    const property = error.keyword === 'additionalProperties'
      ? `/${error.params.additionalProperty}`
      : '';
    return `${location}${property}: ${error.message}`;
  });
}

function isFrameSnapped(seconds, fps) {
  try {
    return Math.abs(frameSnapSeconds(seconds, fps) - seconds) < 1e-9;
  } catch (_) {
    return false;
  }
}

function hasEncodedPathSeparatorOrTraversal(value) {
  return value.split('/').some((rawSegment) => {
    let segment = rawSegment;
    for (let depth = 0; depth < 16; depth += 1) {
      let decoded;
      try {
        decoded = decodeURIComponent(segment);
      } catch (_) {
        return false;
      }
      if (decoded === segment) return false;
      if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
        return true;
      }
      segment = decoded;
    }
    return true;
  });
}

function isCanonicalMotionReference(value) {
  return isCanonicalBrollReference(value)
    && !hasEncodedPathSeparatorOrTraversal(value);
}

function containsExecutableMarkup(value) {
  if (typeof value === 'string') {
    return /<\/?(?:script|style|iframe|object|embed|svg|math|link|meta)\b/i.test(value)
      || /\bjavascript\s*:/i.test(value)
      || /\bon[a-z]+\s*=/i.test(value);
  }
  if (Array.isArray(value)) return value.some(containsExecutableMarkup);
  if (value && typeof value === 'object') return Object.values(value).some(containsExecutableMarkup);
  return false;
}

function validateMotionBrief(brief, { requireApproved = false } = {}) {
  const errors = schemaErrors(brief);
  const scenes = Array.isArray(brief?.scenes) ? brief.scenes : [];
  const fps = brief?.output?.fps;
  const durationInFrames = brief?.output?.durationInFrames;

  if (typeof brief?.source === 'string' && !isCanonicalMotionReference(brief.source)) {
    errors.push('source: ссылка на narration должна быть канонической относительной внутри проекта');
  }
  if (brief?.status === 'draft' && brief.approval) errors.push('draft cannot carry an approval receipt');
  if (brief?.music && !isCanonicalMotionReference(brief.music.file)) {
    errors.push('music.file: music must be a canonical project reference');
  }
  if (containsExecutableMarkup(brief)) {
    errors.push('brief: executable HTML or JavaScript markup is not allowed');
  }

  scenes.forEach((scene, index) => {
    if (!MOTION_SCENES.includes(scene?.scene)) {
      errors.push(`scenes[${index}]: сцена "${scene?.scene}" не входит в motion library`);
    }
    if (Number.isFinite(scene?.start) && Number.isFinite(scene?.end) && scene.end <= scene.start) {
      errors.push(`scenes[${index}]: end (${scene.end}) должен быть больше start (${scene.start})`);
    }
    for (const field of ['start', 'end']) {
      if (Number.isFinite(scene?.[field]) && Number.isFinite(fps)
        && !isFrameSnapped(scene[field], fps)) {
        errors.push(`scenes[${index}].${field}: тайминг должен совпадать с границей кадра`);
      }
    }
    if (index > 0 && Number.isFinite(scene?.start) && Number.isFinite(scenes[index - 1]?.end)
      && scene.start < scenes[index - 1].end) {
      errors.push(`scenes[${index}]: тайминг пересекается с предыдущей сценой`);
    }
    if (Number.isFinite(scene?.end) && Number.isFinite(fps) && Number.isInteger(durationInFrames)
      && Math.round(scene.end * fps) > durationInFrames) {
      errors.push(`scenes[${index}].end: сцена выходит за длительность narration`);
    }
    if (scene?.scene === 'media' && scene.media) {
      const { kind, src } = scene.media;
      if (!isCanonicalMotionReference(src)) {
        errors.push(`scenes[${index}].media.src: ссылка должна быть канонической относительной внутри проекта`);
      } else if (MOTION_MEDIA_EXTENSIONS[kind]
        && !MOTION_MEDIA_EXTENSIONS[kind].has(path.posix.extname(src).toLowerCase())) {
        errors.push(`scenes[${index}].media.src: расширение не соответствует media kind ${kind}`);
      }
      if (kind === 'video' && Number.isFinite(scene.media.trimStartSec)
        && Number.isFinite(fps) && !isFrameSnapped(scene.media.trimStartSec, fps)) {
        errors.push(`scenes[${index}].media.trimStartSec: тайминг должен совпадать с границей кадра`);
      }
    }
  });

  if (requireApproved && brief?.status !== 'approved') {
    errors.push('motion brief is not approved: status must be approved');
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

function motionProps({ brief, theme, sourceFile = 'narration.mp3' }) {
  return {
    theme: theme ?? brief.theme,
    scenes: brief.scenes,
    audioSrc: sourceFile,
    videoTitle: brief.title,
    width: brief.output.width,
    height: brief.output.height,
    fps: brief.output.fps,
    durationInFrames: brief.output.durationInFrames,
  };
}

function buildDraftMotionProps(options) {
  const validation = validateMotionBrief(options.brief);
  if (!validation.ok) throw new Error(validation.errors.join('\n'));
  if (options.brief.status !== 'draft') throw new Error('motion preview requires status draft');
  return { ...motionProps(options), draftPreview: true };
}

function buildMotionProps(options) {
  const validation = validateMotionBrief(options.brief, { requireApproved: true });
  if (!validation.ok) throw new Error(validation.errors.join('\n'));
  return motionProps(options);
}

function clock(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const rest = Math.floor(safe % 60);
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function cell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function sceneSummary(scene) {
  if (scene.scene === 'kinetic-title') return scene.text;
  if (scene.scene === 'card') return [scene.title, scene.body].filter(Boolean).join(': ');
  if (scene.scene === 'steps') return [scene.title, ...(scene.steps || [])].filter(Boolean).join(' → ');
  if (scene.scene === 'list') return [scene.title, ...(scene.items || [])].filter(Boolean).join('; ');
  if (scene.scene === 'counter') return `${scene.label}: ${scene.prefix || ''}${scene.value}${scene.suffix || ''}`;
  if (scene.scene === 'media') return `${scene.media?.kind}: ${scene.media?.src}${scene.overlayText ? ` – ${scene.overlayText}` : ''}`;
  return [scene.title, scene.action, scene.handle].filter(Boolean).join(' – ');
}

function formatMotionBriefMarkdown(brief) {
  const sceneRows = (brief.scenes || []).map((scene, index) => (
    `| ${String(index + 1).padStart(2, '0')} | ${scene.scene} | ${clock(scene.start)}–${clock(scene.end)} | ${cell(sceneSummary(scene))} |`
  ));
  return [
    `# Motion Reel: ${brief.title || 'VIDEO'}`,
    '',
    `Статус: \`${brief.status}\``,
    `Формат: \`${brief.output.aspect}\`, ${brief.output.width}x${brief.output.height}, ${brief.output.fps} FPS`,
    '',
    '## Сцены',
    '',
    '| № | Сцена | Тайминг | Что на экране |',
    '|---:|---|---:|---|',
    ...sceneRows,
    '',
    'Рендер разрешён только после явного утверждения и смены статуса на `approved`.',
    '',
  ].join('\n');
}

module.exports = {
  MOTION_SCENES,
  buildDraftMotionProps,
  buildMotionProps,
  formatMotionBriefMarkdown,
  validateMotionBrief,
};
