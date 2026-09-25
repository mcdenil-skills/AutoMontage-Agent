#!/usr/bin/env node
const { configureMediaToolPath } = require('../env');
const { addTakes } = require('./takes');
const { packTakes } = require('./takes-pack');

const USAGE = 'usage: automontage takes add|pack --project-dir <dir> '
  + '[--file <video> ...] [--model <id>] [--prompt <text>] [--silence <sec>]';

function parseTakesOptions(argv) {
  const [action, ...rest] = argv;
  if (!['add', 'pack'].includes(action)) throw new Error(USAGE);
  const options = {
    action,
    projectDir: null,
    files: [],
    model: 'large-v3-turbo',
    prompt: null,
    silence: 0.5,
  };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} requires a value`);
    if (key === '--project-dir') options.projectDir = value;
    else if (key === '--file' && action === 'add') options.files.push(value);
    else if (key === '--model' && action === 'add') options.model = value;
    else if (key === '--prompt' && action === 'add') options.prompt = value;
    else if (key === '--silence' && action === 'pack') options.silence = Number(value);
    else throw new Error(`unknown takes option: ${key}`);
  }
  if (!options.projectDir) throw new Error('takes requires --project-dir');
  if (action === 'add' && !options.files.length) throw new Error('takes add requires at least one --file');
  if (action === 'pack' && (!Number.isFinite(options.silence)
    || options.silence < 0.1 || options.silence > 5)) {
    throw new Error('--silence must be between 0.1 and 5 seconds');
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return; }
  try {
    configureMediaToolPath();
    const options = parseTakesOptions(argv);
    if (options.action === 'add') {
      const result = addTakes(options);
      for (const take of result.takes) {
        console.log(`✅ ${take.id}: ${take.localPath} -> ${take.transcriptPath}`);
      }
    } else {
      process.stdout.write(packTakes(options));
    }
  } catch (error) {
    console.error(`❌ takes отменён: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { main, parseTakesOptions };
