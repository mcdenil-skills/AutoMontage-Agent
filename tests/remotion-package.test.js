const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bundle } = require('@remotion/bundler');

const ROOT = path.resolve(__dirname, '..');

test('Remotion bundles JSX under an installed package while keeping other node_modules excluded', { timeout: 30_000 }, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-installed-jsx-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const installedRoot = path.join(temporary, 'node_modules/automontage-agent');
  const sourceDirectory = path.join(installedRoot, 'src');
  fs.mkdirSync(sourceDirectory, { recursive: true });
  const entryPoint = path.join(sourceDirectory, 'fixture.jsx');
  fs.writeFileSync(entryPoint, 'export const Installed = () => <div>Public motion fixture</div>;\n');
  fs.mkdirSync(path.join(installedRoot, 'scripts'));
  fs.copyFileSync(path.join(ROOT, 'remotion.config.js'), path.join(installedRoot, 'remotion.config.js'));
  fs.copyFileSync(path.join(ROOT, 'scripts/remotion-webpack.js'), path.join(installedRoot, 'scripts/remotion-webpack.js'));
  const cliPackage = path.dirname(require.resolve('@remotion/cli/package.json'));
  const { loadConfigFile } = require(path.join(cliPackage, 'dist/load-config.js'));
  const { getWebpackOverrideFn, resetBundlerOverrides } = require(path.join(cliPackage, 'dist/config/override-webpack.js'));
  t.after(resetBundlerOverrides);
  await loadConfigFile(installedRoot, 'remotion.config.js', true);
  const override = getWebpackOverrideFn();
  const realSource = fs.realpathSync(sourceDirectory);
  let checked = false;
  const result = await bundle({
    entryPoint, rootDir: ROOT, publicDir: null, outDir: path.join(temporary, 'bundle'),
    enableCaching: false, ignoreRegisterRootWarning: true,
    async webpackOverride(config) {
      const updated = await override(config);
      const jsxRule = updated.module.rules.find(rule => rule.test?.test('fixture.jsx') && rule.exclude);
      assert.equal(jsxRule.exclude(path.join(realSource, 'fixture.jsx')), false);
      assert.equal(jsxRule.exclude(path.join(realSource, '../src-other/fixture.jsx')), true);
      assert.equal(jsxRule.exclude(path.join(temporary, 'node_modules/foreign/fixture.jsx')), true);
      checked = true;
      return updated;
    },
  });
  assert.equal(checked, true);
  assert.ok(fs.existsSync(path.join(result, 'bundle.js')));
});
