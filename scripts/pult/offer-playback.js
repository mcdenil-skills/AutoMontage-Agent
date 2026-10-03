const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { readProjectManifest, resolveProjectPath } = require('../project/workspace');
const { activeRoughCut, sourceRangeToRoughCut } = require('../project/rough-cut-model');
const { validateSourceEdit } = require('../project/build-master');
const { hashFile } = require('./files');
const unavailable = (reason) => ({ videoUrl: null, startSec: null, endSec: null, unavailableReason: reason });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function playbackForOffer({ projectDir, entry, offer, video }) {
  if (!video?.url) return unavailable('У этого ролика пока нет видео для прослушивания');
  if (!Number.isFinite(offer.startSec) || !Number.isFinite(offer.endSec) || offer.startSec < 0 || offer.endSec <= offer.startSec) {
    return unavailable('У обещания в сценарии нет времени для прослушивания');
  }
  let range = { startSec: offer.startSec, endSec: offer.endSec };
  if (entry.video?.kind === 'roughcut') {
    try {
      const manifest = readProjectManifest(projectDir);
      const cut = activeRoughCut(manifest);
      if (!cut || entry.video.path !== cut.filePath) throw new Error('changed');
      const resolve = (stored) => resolveProjectPath(projectDir, stored, { mustExist: true, type: 'file' });
      if (hashFile(resolve(cut.filePath)) !== cut.sha256) throw new Error('changed');
      const bytes = fs.readFileSync(resolve(cut.editPath));
      if (sha256(bytes) !== cut.editSha256) throw new Error('changed');
      const edit = validateSourceEdit(JSON.parse(bytes.toString('utf8')), {
        sourceRevision: cut.sourceRevision, sourceDuration: cut.sourceDuration,
      });
      if (Math.abs(edit.fps - cut.fps) > 1e-6 || offer.source?.kind !== 'transcript'
        || offer.source.path !== manifest.transcript.words
        || hashFile(resolve(manifest.transcript.words)) !== offer.source.sha256) throw new Error('changed');
      range = sourceRangeToRoughCut(edit.keep, offer.startSec, offer.endSec);
      if (!range) return unavailable('Обещание вырезано из этой нарезки целиком или частично');
    } catch (_) {
      return unavailable('Нарезка или расшифровка изменилась – попросите агента обновить обещание');
    }
  }
  return { videoUrl: video.url, ...range, unavailableReason: null };
}
module.exports = { playbackForOffer };
