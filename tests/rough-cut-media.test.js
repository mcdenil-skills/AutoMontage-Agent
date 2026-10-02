const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { ffmpegEncoderAvailable, toolAvailable } = require('./helpers/media-fixtures');
const { makeLayerProject } = require('./helpers/layer-project');
const { displayDimensions, probeMediaPath } = require('../scripts/media-probe');
const { buildRoughCut } = require('../scripts/project/rough-cut');
const { readProjectManifest } = require('../scripts/project/workspace');

const hasFfmpeg = toolAvailable('ffmpeg') && toolAvailable('ffprobe') && ffmpegEncoderAvailable('libx264');

function probe(file) {
  const result = spawnSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,pix_fmt,width,height:format=duration',
    '-of', 'json', file,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  return { ...data.streams[0], duration: Number(data.format.duration) };
}

// Порядок атомов верхнего уровня MP4: +faststart переносит moov перед mdat.
function topLevelAtoms(file) {
  const bytes = fs.readFileSync(file);
  const atoms = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (size === 1) size = Number(bytes.readBigUInt64BE(offset + 8));
    else if (size === 0) size = bytes.length - offset;
    atoms.push({ type, offset });
    if (size < 8) break;
    offset += size;
  }
  return atoms;
}

for (const [label, options] of [
  ['an upright portrait', { seconds: 6, size: '540x960' }],
  ['a phone recording rotated by 90°', { seconds: 6, size: '960x540', rotation: 90 }],
]) {
  test(`real rough cut of ${label} is a small h264 proxy with the moov atom first`, {
    skip: !hasFfmpeg, timeout: 180_000,
  }, (t) => {
    const { projectDir, workspace } = makeLayerProject(t, options);
    fs.writeFileSync(path.join(projectDir, 'edit', 'roughcut-v01.json'), `${JSON.stringify({
      version: 1,
      sourceRevision: 1,
      fps: 25,
      keep: [{ start: 0, end: 2, note: 'хук' }, { start: 3, end: 5, note: 'вырезан повтор' }],
    }, null, 2)}\n`);
    const log = [];

    const result = buildRoughCut({ projectDir, editPath: 'edit/roughcut-v01.json' }, {
      log: (line) => log.push(String(line)),
    });

    const file = path.join(projectDir, 'previews', 'roughcut-v01.mp4');
    assert.equal(result.filePath, 'previews/roughcut-v01.mp4');
    assert.deepEqual({ width: result.width, height: result.height }, { width: 540, height: 960 });
    const stream = probe(file);
    assert.equal(stream.codec_name, 'h264');
    assert.equal(stream.pix_fmt, 'yuv420p');
    assert.deepEqual({ width: stream.width, height: stream.height }, { width: 540, height: 960 });
    assert.deepEqual(displayDimensions(probeMediaPath(file)), { width: 540, height: 960 });
    assert.ok(Math.abs(stream.duration - 4) <= 0.08, `duration ${stream.duration}`);
    const atoms = topLevelAtoms(file);
    const moov = atoms.findIndex(({ type }) => type === 'moov');
    const mdat = atoms.findIndex(({ type }) => type === 'mdat');
    assert.ok(moov >= 0 && mdat >= 0 && moov < mdat, JSON.stringify(atoms));
    const manifest = readProjectManifest(projectDir);
    assert.equal(manifest.roughCut.status, 'review');
    assert.equal(manifest.roughCut.width, 540);
    assert.equal(manifest.roughCut.height, 960);
    assert.equal(manifest.source.localPath, workspace.manifest.source.localPath);
    assert.equal(manifest.source.revision ?? 1, 1);
    assert.deepEqual(fs.readdirSync(path.join(projectDir, 'previews')), ['roughcut-v01.mp4']);
  });
}
