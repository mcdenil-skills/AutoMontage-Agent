const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { main } = require('../scripts/lead-magnet/cli');
const library = require('../scripts/lead-magnet/library');
const { acceptDecision, addDecision } = require('../scripts/lead-magnet/requests');
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
  assert.doesNotMatch(source, /(?:require|import)\s*\(?\s*['"][^'"]*approve[^'"]*['"]/i);
  assert.doesNotMatch(source, /(?:['"]approve['"]|\bapprove)\s*:/i);
  assert.doesNotMatch(source, /\/api\/approve/i);
});

test('create consumes only new create requests; accepted and wrong-type IDs cannot create another passport', async (t) => {
  const { projectsDir, projectDir, folder } = makeVideoProject(t);
  const P = ['--projects-dir', projectsDir];
  const offered = await run(['offer', 'add', '--project-dir', projectDir, '--code-word', 'ГАЙД', '--kind', 'dm', '--quote', QUOTE, '--units', JSON.stringify(UNITS)]);
  assert.equal(offered.code, 0, offered.out);
  const accepted = addDecision(projectDir, { type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: PARAMS });
  acceptDecision(projectDir, accepted.id);
  const wrongType = addDecision(projectDir, { type: 'decline', offerId: 'o-gayd', codeWord: 'ГАЙД' });
  for (const id of [accepted.id, wrongType.id]) {
    const result = await run(['create', ...P, '--from', folder, id, '--title', 'Повтор']);
    assert.equal(result.code, 1, result.out);
    assert.equal(library.listLeadMagnets(projectsDir).entries.length, 0);
  }
  const fresh = addDecision(projectDir, { type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: PARAMS });
  assert.equal((await run(['create', ...P, '--from', folder, fresh.id, '--title', 'Новый'])).code, 0);
  assert.equal(library.listLeadMagnets(projectsDir).entries.length, 1);
});

test('create rejects a missing offer identity but permits an explicit manual request', async (t) => {
  const { projectsDir, projectDir, folder } = makeVideoProject(t);
  const P = ['--projects-dir', projectsDir];
  assert.equal((await run(['offer', 'add', '--project-dir', projectDir, '--code-word', 'ГАЙД', '--kind', 'dm', '--quote', QUOTE, '--units', JSON.stringify(UNITS)])).code, 0);
  const request = addDecision(projectDir, { type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: PARAMS });
  fs.unlinkSync(path.join(projectDir, 'lead-magnet', 'offers.json'));
  const missing = await run(['create', ...P, '--from', folder, request.id, '--title', 'Гайд']);
  assert.equal(missing.code, 1, missing.out);
  assert.match(missing.out, /обещание|offerId/);
  assert.equal(library.listLeadMagnets(projectsDir).entries.length, 0);
  const manual = addDecision(projectDir, { type: 'create', offerId: null, codeWord: null, params: { ...PARAMS, promiseConfirmed: false } });
  const created = await run(['create', ...P, '--from', folder, manual.id, '--code-word', 'ЧЕКЛИСТ', '--title', 'Чеклист']);
  assert.equal(created.code, 0, created.out);
  assert.equal(library.listLeadMagnets(projectsDir).entries[0].promise.quote, null);
});

test('create rejects symlinked decision and offer directories before reading or mutating', async (t) => {
  for (const child of ['pult', 'lead-magnet']) {
    const { base, projectsDir, projectDir, folder } = makeVideoProject(t, `2026.09.30_${child}`);
    assert.equal((await run(['offer', 'add', '--project-dir', projectDir, '--code-word', 'ГАЙД', '--kind', 'dm', '--quote', QUOTE, '--units', JSON.stringify(UNITS)])).code, 0);
    const request = addDecision(projectDir, { type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: PARAMS });
    const outside = path.join(base, `outside-${child}`);
    fs.renameSync(path.join(projectDir, child), outside);
    fs.symlinkSync(outside, path.join(projectDir, child));
    const result = await run(['create', '--projects-dir', projectsDir, '--from', folder, request.id, '--title', 'Гайд']);
    assert.equal(result.code, 1, result.out);
    assert.equal(library.listLeadMagnets(projectsDir).entries.length, 0);
  }
});

test('promise update rejects a symlinked offer directory and leaves the passport unchanged', async (t) => {
  const { base, projectsDir, projectDir, folder, id } = makeLeadMagnet(t);
  assert.equal((await run(['offer', 'add', '--project-dir', projectDir, '--code-word', 'ГАЙД', '--kind', 'dm', '--quote', QUOTE, '--units', JSON.stringify(UNITS)])).code, 0);
  const before = library.readLeadMagnet(projectsDir, id);
  const outside = path.join(base, 'outside-offers');
  fs.renameSync(path.join(projectDir, 'lead-magnet'), outside);
  fs.symlinkSync(outside, path.join(projectDir, 'lead-magnet'));
  const result = await run(['promise', 'update', '--projects-dir', projectsDir, '--id', id, '--from', folder]);
  assert.equal(result.code, 1, result.out);
  assert.deepEqual(library.readLeadMagnet(projectsDir, id), before);
});

test('promise update prefers passport code word order over offer file order', async (t) => {
  const { projectsDir, projectDir, folder, id } = makeLeadMagnet(t);
  library.linkVideo(projectsDir, id, { folder, codeWord: 'ЧЕКЛИСТ' });
  const alternate = 'Напишите ГАЙД в комментариях';
  for (const [word, quote] of [['ЧЕКЛИСТ', alternate], ['ГАЙД', QUOTE]]) {
    const result = await run(['offer', 'add', '--project-dir', projectDir, '--code-word', word,
      '--kind', 'dm', '--quote', quote, '--units', JSON.stringify(UNITS)]);
    assert.equal(result.code, 0, result.out);
  }
  const updated = await run(['promise', 'update', '--projects-dir', projectsDir, '--id', id, '--from', folder]);
  assert.equal(updated.code, 0, updated.out);
  assert.equal(library.readLeadMagnet(projectsDir, id).promise.quote, QUOTE);
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

test('offer refresh transfers quantities and types into the next checked revision', async (t) => {
  const { checkRevision } = require('../scripts/lead-magnet/check');
  const { goodPage, writeRevision } = require('./helpers/lead-magnet-fixtures');
  for (const units of [[{ key: 'prompt', count: 7, label: 'промптов' }], [{ key: 'example', count: 2, label: 'примера' }]]) {
    const { projectsDir, projectDir, folder, id } = makeLeadMagnet(t);
    assert.equal((await run(['offer', 'add', '--project-dir', projectDir, '--code-word', 'ГАЙД', '--kind', 'dm', '--quote', QUOTE, '--units', JSON.stringify(units)])).code, 0);
    assert.equal((await run(['promise', 'update', '--projects-dir', projectsDir, '--id', id, '--from', folder])).code, 0);
    assert.deepEqual(library.readLeadMagnet(projectsDir, id).units, units);
    const { n, dir } = library.startRevision(projectsDir, id);
    writeRevision(dir);
    assert.equal((await checkRevision(projectsDir, id, n, { env: {} })).items.find((x) => x.id === 'promise').ok, false);
    writeRevision(dir, { page: goodPage({ prompts: 7, extra: '<p data-lm-item="example">Один</p><p data-lm-item="example">Два</p>' }) });
    assert.equal((await checkRevision(projectsDir, id, n, { env: {} })).ok, true);
  }
});
