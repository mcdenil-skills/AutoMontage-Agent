const path = require('node:path');

const { buildMotionProps } = require('./brief');
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
  return {
    composition: 'MotionReel',
    props,
    sourcePath,
    sourceAlias,
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
  withMotionSourceLease,
};
