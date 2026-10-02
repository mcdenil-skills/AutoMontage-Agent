const path = require('node:path');
const { Config } = require('@remotion/cli/config');
const { includeInstalledSource, withMotionKitAlias } = require('./scripts/remotion-webpack');
const { shouldOverride, limitedRangeOverride } = require('./scripts/remotion-ffmpeg-override');

if (shouldOverride(process.env)) {
  Config.overrideFfmpegCommand(limitedRangeOverride);
}

// The Remotion loader evaluates bundled config from its own module; it sets cwd
// to the selected project root while loading. Capture that root before callbacks.
const sourceDirectory = path.join(process.cwd(), 'src');
// MOTION_KIT_DIR (default в withMotionKitAlias) верен только для обычного require из Node;
// здесь код исполняется через eval из node_modules/@remotion/cli, поэтому каталог считаем от
// того же process.cwd(), что и sourceDirectory выше.
Config.overrideWebpackConfig(config => withMotionKitAlias(
  includeInstalledSource(config, sourceDirectory),
  path.join(sourceDirectory, 'motion-kit'),
));
