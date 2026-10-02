#!/usr/bin/env node
// `automontage roughcut` – черновая нарезка без графики для пульта (до master и слоя);
// `automontage roughcut confirm` – «нарезка готова» только по явным словам автора в чате.
const path = require('node:path');

const { configureMediaToolPath } = require('../env');
const { buildRoughCut, confirmRoughCut } = require('./rough-cut');
const { readProjectManifest } = require('./workspace');

const USAGE = 'usage: automontage roughcut --project-dir <dir> --edit edit/roughcut-vNN.json\n'
  + '       automontage roughcut confirm --project-dir <dir>';

function parseRoughCutOptions(argv) {
  const command = argv[0] === 'confirm' ? 'confirm' : 'build';
  const rest = command === 'confirm' ? argv.slice(1) : argv;
  const options = { command, projectDir: null, editPath: null };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} requires a value`);
    if (key === '--project-dir') options.projectDir = value;
    else if (key === '--edit' && command === 'build') options.editPath = value;
    else throw new Error(`unknown roughcut option: ${key}\n${USAGE}`);
  }
  if (!options.projectDir || (command === 'build' && !options.editPath)) throw new Error(USAGE);
  return options;
}

function seconds(value) {
  return value.toFixed(1).replace('.', ',');
}

// «в 1 месте», «в 21 месте», но «в 11 местах», «в 2 местах».
function places(count) {
  const word = count % 10 === 1 && count % 100 !== 11 ? 'месте' : 'местах';
  return `в ${count} ${word}`;
}

function formatRoughCutSummary({ filePath, duration, removedSec, cuts }) {
  return `✅ черновая нарезка: ${filePath} – ${seconds(duration)} с, вырезано ${seconds(removedSec)} с ${places(cuts)}. `
    + 'Дальше: автор смотрит её в пульте (automontage pult).';
}

function formatRoughCutConfirmed(projectDir, editPath) {
  return `✅ нарезка подтверждена по словам автора: ${editPath}. `
    + `Дальше: automontage master --project-dir "${projectDir}" --edit ${editPath} `
    + '(правки автора к нарезке – в копию списка edit/vNN-source.json, секунды исходника – в automontage inbox)';
}

function main(argv = process.argv.slice(2), { log = console.log, error = console.error, ...deps } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    log(USAGE);
    return;
  }
  try {
    configureMediaToolPath();
    const options = parseRoughCutOptions(argv);
    if (options.command === 'confirm') {
      const projectDir = path.resolve(options.projectDir);
      const workspace = { dir: projectDir, manifest: readProjectManifest(projectDir) };
      const record = confirmRoughCut(workspace, { by: 'chat', ...(deps.now ? { now: deps.now } : {}) });
      log(formatRoughCutConfirmed(options.projectDir, record.editPath));
    } else {
      log(formatRoughCutSummary(buildRoughCut(options, { ...deps, log })));
    }
  } catch (caught) {
    error(`❌ roughcut отменён: ${caught.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  formatRoughCutConfirmed,
  formatRoughCutSummary,
  main,
  parseRoughCutOptions,
};
