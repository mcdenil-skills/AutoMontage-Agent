const path = require('node:path');
const { Config } = require('@remotion/cli/config');
const { includeInstalledSource } = require('./scripts/remotion-webpack');

// The Remotion loader evaluates bundled config from its own module; it sets cwd
// to the selected project root while loading. Capture that root before callbacks.
const sourceDirectory = path.join(process.cwd(), 'src');
Config.overrideWebpackConfig(config => includeInstalledSource(config, sourceDirectory));
