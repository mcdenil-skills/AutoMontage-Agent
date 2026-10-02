const LIMITED_RANGE_ENV = 'AUTOMONTAGE_LAYER_LIMITED_RANGE';

function shouldOverride(env) {
  return env[LIMITED_RANGE_ENV] === '1';
}

function limitedRangeOverride({ type, args }) {
  // Pre-stitcher argv can contain numbers. Copy/mux commands need no video filter.
  const encodesVideo = args.some((arg, index) => String(arg) === '-c:v' && String(args[index + 1]) === 'libx264');
  if (!encodesVideo) return args;
  let insertAt = args.length - 1;
  if (String(args[insertAt - 1]) === '-y') insertAt -= 1;
  return [...args.slice(0, insertAt), '-vf', 'scale=out_range=tv,format=yuv420p',
    '-color_range', 'tv', ...args.slice(insertAt)];
}

module.exports = { LIMITED_RANGE_ENV, shouldOverride, limitedRangeOverride };
