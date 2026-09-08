const path = require('node:path');

const { buildMotionProps, buildDraftMotionProps } = require('./brief');
const { buildLessonMusicMixArgs } = require('../lesson/workflow');
const { resolveProjectPath } = require('../project/workspace');
const { withPublicMediaLease } = require('../public-media');
const { assertMotionWorkspace } = require('./source');

function prepareMotionRender({ workspace, brief, theme, framesOverride = null }) {
  assertMotionWorkspace(workspace);
  const sourcePath = resolveProjectPath(workspace.dir, brief?.source, {
    label: 'motion brief source',
    mustExist: true,
    type: 'file',
  });
  if (path.resolve(sourcePath) !== path.resolve(workspace.sourcePath)) {
    throw new Error('motion brief uses another narration source');
  }
  const sourceAlias = path.basename(sourcePath);
  const props = buildMotionProps({ brief, theme, sourceFile: sourceAlias });
  const requestedFrames = Number(framesOverride);
  if (Number.isFinite(requestedFrames) && requestedFrames > 0) {
    props.durationInFrames = Math.min(props.durationInFrames, Math.floor(requestedFrames));
  }
  if (brief.theme !== 'motion-neutral') throw new Error('unsupported public motion theme');
  return {
    composition: 'MotionReel',
    music: motionMusic(workspace, brief, 0, props.durationInFrames / props.fps),
    props,
    sourcePath,
    sourceAlias,
  };
}

function motionMusic(workspace, brief, fromSec, durationSec) {
  if (!brief.music) return null;
  return {
    sourcePath: resolveProjectPath(workspace.dir, brief.music.file, { mustExist: true, type: 'file' }),
    mixArgs: buildLessonMusicMixArgs({ ...brief.music,
      startSec: (brief.music.startSec ?? 0) + fromSec * (brief.music.playbackRate ?? 1),
    }, durationSec),
  };
}

function prepareMotionPreview({ workspace, brief, fromSec, toSec }) {
  assertMotionWorkspace(workspace);
  if (brief.theme !== 'motion-neutral') throw new Error('unsupported public motion theme');
  const sourcePath = resolveProjectPath(workspace.dir, brief.source, { mustExist: true, type: 'file' });
  if (sourcePath !== workspace.sourcePath) throw new Error('motion brief uses another narration source');
  const sourceAlias = path.basename(sourcePath);
  const props = buildDraftMotionProps({ brief, sourceFile: sourceAlias });
  const duration = props.durationInFrames / props.fps;
  let range = { kind: 'full', fromSec: 0, toSec: duration, fromFrame: 0, toFrameExclusive: props.durationInFrames };
  if (fromSec !== undefined || toSec !== undefined) {
    if (!Number.isFinite(fromSec) || !Number.isFinite(toSec) || fromSec < 0 || toSec <= fromSec || toSec > duration) {
      throw new Error('motion preview range is invalid');
    }
    const fromFrame = Math.round(fromSec * props.fps);
    const toFrameExclusive = Math.round(toSec * props.fps);
    if (toFrameExclusive <= fromFrame) throw new Error('motion preview range is shorter than one frame');
    range = { kind: 'excerpt', fromSec: fromFrame / props.fps, toSec: toFrameExclusive / props.fps, fromFrame, toFrameExclusive };
  }
  return { composition: 'MotionReel', props, range,
    music: motionMusic(workspace, brief, range.fromSec, range.toSec - range.fromSec),
    previewMedia: { brief, sourcePath, sourceAlias },
  };
}

function withMotionSourceLease({ root, prepared, temporaryId }, operation) {
  if (typeof operation !== 'function') {
    throw new TypeError('motion source lease requires an operation');
  }
  return withPublicMediaLease({
    root,
    sourcePath: prepared.sourcePath,
    namespace: 'motion-reel',
    temporaryId,
  }, (lease) => operation({
    ...prepared,
    props: { ...prepared.props, audioSrc: lease.publicPath },
    publicDirectory: path.join(path.resolve(root), 'public'),
  }));
}

module.exports = {
  prepareMotionRender,
  prepareMotionPreview,
  withMotionSourceLease,
};
