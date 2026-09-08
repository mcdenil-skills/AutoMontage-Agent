const { validateLessonBrief } = require('../lesson/brief');
const { validateMotionBrief } = require('../motion/brief');

// Stored metadata is authoritative; a filename never selects a composition.
function validateStoredBrief({ manifest, briefPath, brief }) {
  const entry = manifest.briefs.find(item => item.jsonPath === briefPath);
  if (!entry) throw new Error('brief is not registered in the project manifest');
  const kind = entry.kind || 'lesson';
  const motion = kind === 'motion-reel';
  if (motion !== (brief.kind === 'motion-reel')
    || motion !== (manifest.projectKind === 'motion-reel')
    || (motion && manifest.source.mediaKind !== 'audio')) {
    throw new Error('stored brief kind does not match the brief or project kind');
  }
  const validation = (motion ? validateMotionBrief : validateLessonBrief)(brief);
  if (!validation.ok) throw new Error(`invalid ${kind} brief: ${validation.errors.join('\n')}`);
  if (brief.status !== entry.status) throw new Error('brief status does not match the manifest');
  return kind;
}
module.exports = { validateStoredBrief };
