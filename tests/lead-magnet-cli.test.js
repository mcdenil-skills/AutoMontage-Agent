const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { main } = require('../scripts/lead-magnet/cli');
const library = require('../scripts/lead-magnet/library');
const { addDecision } = require('../scripts/lead-magnet/requests');
const { PARAMS, QUOTE, UNITS, makeLeadMagnet, makeVideoProject } = require('./helpers/lead-magnet-fixtures');

async function run(argv) {
  const lines = [];
  const code = await main(argv, { write: (line) => lines.push(line) });
  return { code, out: lines.join('\n') };
}

test('agent flow: offer → create from request → revision start → link → list', async (t) => {
  const { projectsDir, projectDir, folder } = makeVideoProject(t);
  const P = ['--projects-dir', projectsDir];
  let result = await run(['offer', 'add', '--project-dir', projectDir, '--code-word', 'гайд', '--kind', 'comment-keyword', '--quote', QUOTE, '--units', JSON.stringify(UNITS)]);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /o-gayd.*1:00/);
  const request = addDecision(projectDir, { type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: PARAMS });
  result = await run(['create', ...P, '--from', folder, request.id, '--title', 'Сайт без кода']);
  assert.equal(result.code, 0, result.out);
  const [passport] = library.listLeadMagnets(projectsDir).entries;
  assert.equal(passport.promise.quote, QUOTE);
  assert.equal(passport.promise.startSec, 60);
  result = await run(['revision', 'start', ...P, '--id', passport.id]);
  assert.match(result.out, /v01/);
  result = await run(['link', ...P, '--id', passport.id, '--folder', 'второй', '--code-word', 'ГАЙД']);
  assert.equal(result.code, 0, result.out);
  result = await run(['list', ...P, '--code-word', 'гайд']);
  assert.match(result.out, new RegExp(passport.id));
});

test('funnel set and brand report work; bad input fails with a message', async (t) => {
  const { projectsDir, projectDir, folder } = makeVideoProject(t);
  const P = ['--projects-dir', projectsDir];
  await run(['offer', 'add', '--project-dir', projectDir, '--code-word', 'ГАЙД', '--kind', 'dm', '--quote', QUOTE, '--units', JSON.stringify(UNITS)]);
  const request = addDecision(projectDir, { type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: PARAMS });
  await run(['create', ...P, '--from', folder, request.id, '--title', 'Сайт']);
  const [{ id }] = library.listLeadMagnets(projectsDir).entries;
  assert.equal((await run(['funnel', 'set', ...P, '--id', id, '--provider', 'chatplace', '--exists', 'yes', '--name', 'Гайд'])).code, 0);
  assert.match((await run(['brand'])).out, /нейтральный|бренд-пак/i);
  const bad = await run(['offer', 'add', '--project-dir', projectDir, '--code-word', 'ГАЙД', '--kind', 'dm', '--quote', 'такого не было сказано', '--units', JSON.stringify(UNITS)]);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /❌ lead-magnet: цитата не найдена/);
});

test('there is no approve command and the CLI never loads the approve module', async () => {
  const result = await run(['approve', '--id', '2026.09.30_gayd']);
  assert.equal(result.code, 1);
  assert.match(result.out, /неизвестная команда/);
  assert.equal((await run(['constructor'])).code, 1);
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lead-magnet', 'cli.js'), 'utf8');
  assert.doesNotMatch(source, /require\(['"]\.\/approve['"]\)/);
  assert.doesNotMatch(source, /['"]?approve['"]?\s*:/);
});

test('create and promise update reject a video folder outside projects', async (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const P = ['--projects-dir', projectsDir];
  const create = await run(['create', ...P, '--from', '../outside', 'r-test', '--title', 'Test']);
  assert.equal(create.code, 1);
  assert.match(create.out, /canonical relative path/);
  const update = await run(['promise', 'update', ...P, '--id', id, '--from', '../outside']);
  assert.equal(update.code, 1);
  assert.match(update.out, /canonical relative path/);
});
