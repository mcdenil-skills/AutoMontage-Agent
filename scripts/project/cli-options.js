const path = require('node:path');

function buildDemoArgs(root, cwd) {
  return [
    path.join(root, 'examples', 'demo-source.mp4'),
    '--scenario', path.join(root, 'examples', 'scenario-demo.json'),
    '--no-transcribe', '--id', 'demo',
    '--outdir', path.join(cwd, 'out'),
  ];
}

function ensureOutputDestination(args, cwd) {
  const result = [...args];
  const projectOwnsOutput = result.includes('--project') || result.includes('--project-dir');
  if (!projectOwnsOutput && !result.includes('--outdir')) {
    result.push('--outdir', cwd);
  }
  return result;
}

function buildMotionDemoArgs(root, cwd, args = []) {
  if (args.length && (args.length !== 2 || args[0] !== '--project-dir' || !args[1] || args[1].startsWith('--'))) {
    throw new Error('unknown motion demo option; usage: automontage demo --motion [--project-dir <new-dir>]');
  }
  return [path.join(root, 'scripts', 'motion', 'demo.js'), '--project-dir',
    path.resolve(cwd, args[1] || 'projects/motion-demo')];
}

module.exports = {
  buildDemoArgs,
  buildMotionDemoArgs,
  ensureOutputDestination,
};
