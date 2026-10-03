const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeLayerProject } = require('./layer-project');
const { ffmpegEncoderAvailable, toolAvailable, runTool } = require('./media-fixtures');
const { buildMaster } = require('../../scripts/project/build-master');
const { addTakes } = require('../../scripts/project/takes');
const { readProjectManifest } = require('../../scripts/project/workspace');
const { probeMediaPath, probeVideo, displayDimensions } = require('../../scripts/media-probe');
const { runTrim, runSegmentsTrim } = require('../../scripts/trim-media');
const { captureTool } = require('../../scripts/process');

function checkMasterMedia(t, { rotation, takes = false, retainedMatrix = false }) {
  if (!toolAvailable('ffmpeg') || !toolAvailable('ffprobe') || !ffmpegEncoderAvailable('libx264')) {
    if (process.env.CI) throw new Error('CI master media requires FFmpeg, FFprobe and libx264');
    t.skip('requires FFmpeg, FFprobe and libx264'); return;
  }
  const { projectDir, workspace } = makeLayerProject(t, { seconds: 2, size: '960x540', rotation });
  const original = path.join(projectDir, workspace.manifest.source.localPath);
  const bytes = fs.readFileSync(original);
  const transcriptBytes = fs.readFileSync(path.join(projectDir, 'transcript/words.json'));
  const second = path.join(path.dirname(projectDir), 'second.mp4');
  if (takes) fs.copyFileSync(original, second);
  if (takes) addTakes({ projectDir, files: [second] }, {
    transcribeImpl: () => [{ words: [{ w: 'Привет', s: 0.1, e: 0.4 }] }],
  });
  const editPath = 'edit/v02-source.json';
  fs.mkdirSync(path.join(projectDir, 'edit'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, editPath), JSON.stringify(takes
    ? { version: 1, kind: 'takes', sourceRevision: 1,
      ranges: [{ take: 'take-01', start: 0, end: 1.6, beat: 'HOOK', reason: 'media test' }] }
    : { version: 1, sourceRevision: 1, fps: 25, keep: [{ start: 0, end: 1.6 }] }));
  const deps = { readTakeLevelsImpl: () => null };
  if (retainedMatrix) {
    const encode = takes ? runSegmentsTrim : runTrim;
    deps[takes ? 'runSegmentsTrimImpl' : 'runTrimImpl'] = (options) => {
      encode(options);
      const marked = options.output + '.marked.mp4';
      runTool('ffmpeg', ['-v', 'error', '-y', '-display_rotation', String(rotation), '-i', options.output,
        '-map', '0', '-c', 'copy', marked]);
      fs.renameSync(marked, options.output);
    };
  }
  const result = buildMaster({ projectDir, editPath }, deps);
  const media = probeMediaPath(result.sourcePath, { containerDurationFallback: true });
  const video = probeVideo(result.sourcePath);
  const expected = rotation === 90 || rotation === 270 ? [540, 960] : [960, 540];
  assert.equal(media.rotation, 0);
  assert.deepEqual([media.width, media.height], expected);
  const shown = displayDimensions(media);
  assert.deepEqual([shown.width, shown.height], expected);
  assert.equal(video.fps, 25);
  assert.ok(Math.abs(video.duration - 1.6) <= 0.08, String(video.duration));
  const drift = Math.abs(media.audioDurationSec - media.videoDurationSec);
  if (drift > 0.03) {
    const packets = JSON.parse(captureTool('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_packets', '-show_entries', 'packet=pts_time,duration_time', '-of', 'json', result.sourcePath],
    { maxBuffer: 1024 * 1024, stage: 'master test packet timing' })).packets;
    t.diagnostic(JSON.stringify({ audioDurationSec: media.audioDurationSec,
      videoDurationSec: media.videoDurationSec, drift, packetCount: packets.length,
      missingPacketDurations: packets.filter((packet) => !packet.duration_time).length,
      firstPacket: packets[0], lastPacket: packets[packets.length - 1] }));
  }
  assert.ok(drift <= 0.03, `audio=${media.audioDurationSec}, video=${media.videoDurationSec}, drift=${drift}`);
  runTool('ffmpeg', ['-v', 'error', '-i', result.sourcePath, '-f', 'null', '-']);
  assert.deepEqual(fs.readFileSync(original), bytes);
  if (!takes) assert.deepEqual(fs.readFileSync(path.join(projectDir, 'transcript/words.json')), transcriptBytes);
  assert.equal(readProjectManifest(projectDir).source.revision, 2);
}
module.exports = { checkMasterMedia };
