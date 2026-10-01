const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { addOffer } = require('../scripts/lead-magnet/offers');
const { main: leadMagnetCli } = require('../scripts/lead-magnet/cli');
const { linkVideo } = require('../scripts/lead-magnet/library');
const { addDecision } = require('../scripts/lead-magnet/requests');
const { attachLeadMagnets, buildLeadMagnetIndex, folderLeadMagnet } = require('../scripts/pult/lead-magnet-view');
const { addDraftProject, makePultRoot } = require('./helpers/pult-projects');
const {
  PARAMS, QUOTE, UNITS, addLeadMagnetFor, addVideoWithOffer, publishCheckedRevision,
} = require('./helpers/lead-magnet-fixtures');

const view = (projectsDir, folder = 'clip') => folderLeadMagnet(projectsDir, folder, buildLeadMagnetIndex(projectsDir));

test('an offer asks; «Нет» hides it; «Разработать» waits for the agent', (t) => {
  const { projectsDir } = makePultRoot(t);
  const projectDir = addVideoWithOffer(projectsDir, { folder: 'clip' });
  let current = view(projectsDir);
  assert.deepEqual(current.offers.map((offer) => [offer.codeWord, offer.state]), [['ГАЙД', 'ask']]);
  assert.equal(current.offers[0].quote, QUOTE);
  assert.equal(current.status, null);
  assert.equal(JSON.stringify(current).includes(projectsDir), false);
  addDecision(projectDir, { type: 'decline', offerId: 'o-gayd', codeWord: 'ГАЙД' });
  assert.equal(view(projectsDir).offers[0].state, 'declined');
  addDecision(projectDir, { type: 'reopen', offerId: 'o-gayd', codeWord: 'ГАЙД' });
  addDecision(projectDir, { type: 'create', offerId: 'o-gayd', codeWord: 'ГАЙД', params: PARAMS });
  current = view(projectsDir);
  assert.deepEqual(current.pending, ['ГАЙД']);
  assert.deepEqual([current.status, current.nextStep], ['working', 'Агент готовит лид-магнит']);
});

test('a linked lead magnet reports its status, readiness and a changed promise', (t) => {
  const { projectsDir } = makePultRoot(t);
  const projectDir = addVideoWithOffer(projectsDir, { folder: 'clip' });
  const id = addLeadMagnetFor(projectsDir, 'clip');
  assert.deepEqual(view(projectsDir).magnets.map((magnet) => [magnet.id, magnet.status]), [[id, 'working']]);
  publishCheckedRevision(projectsDir, id);
  let current = view(projectsDir);
  assert.deepEqual([current.status, current.magnets[0].approvable], ['waiting', true]);
  fs.writeFileSync(path.join(projectDir, 'script.txt'), 'Финал. и я пришлю пошаговую инструкцию и семь промптов.');
  addOffer(projectDir, {
    codeWord: 'ГАЙД', kind: 'comment-keyword', quote: 'и я пришлю пошаговую инструкцию и семь промптов',
    units: UNITS, sourceKind: 'script', scriptPath: 'script.txt',
  });
  current = view(projectsDir);
  assert.equal(current.magnets[0].promiseChanged, true);
  assert.equal(current.nextStep, 'Обещание в ролике изменилось – проверьте лид-магнит');
});

test('a removed source promise is reported as changed', (t) => {
  const { projectsDir } = makePultRoot(t);
  const projectDir = addVideoWithOffer(projectsDir, { folder: 'clip' });
  const id = addLeadMagnetFor(projectsDir, 'clip');
  publishCheckedRevision(projectsDir, id);
  fs.writeFileSync(path.join(projectDir, 'lead-magnet', 'offers.json'), JSON.stringify({ version: 1, offers: [] }));
  const current = view(projectsDir);
  assert.deepEqual([current.magnets[0].promiseChanged, current.magnets[0].approvable], [true, false]);
  assert.equal(current.nextStep, 'Обещание в ролике изменилось – проверьте лид-магнит');
});

test('an unrelated linked code word cannot replace the source promise', (t) => {
  const { projectsDir } = makePultRoot(t);
  const projectDir = addVideoWithOffer(projectsDir, { folder: 'clip' });
  const id = addLeadMagnetFor(projectsDir, 'clip');
  linkVideo(projectsDir, id, { folder: 'clip', codeWord: 'БОНУС' });
  fs.writeFileSync(path.join(projectDir, 'script.txt'), `Финал. ${QUOTE}.`);
  const bonus = addOffer(projectDir, {
    codeWord: 'БОНУС', kind: 'comment-keyword', quote: QUOTE,
    units: UNITS, sourceKind: 'script', scriptPath: 'script.txt',
  });
  fs.writeFileSync(path.join(projectDir, 'lead-magnet', 'offers.json'), JSON.stringify({ version: 1, offers: [bonus] }));
  assert.equal(view(projectsDir).magnets[0].promiseChanged, true);
});

test('promise update can move the source to a linked video with a later code word', async (t) => {
  const { projectsDir } = makePultRoot(t);
  addVideoWithOffer(projectsDir, { folder: 'clip' });
  const linkedDir = addVideoWithOffer(projectsDir, { folder: 'linked', codeWord: 'БОНУС' });
  const id = addLeadMagnetFor(projectsDir, 'clip');
  linkVideo(projectsDir, id, { folder: 'linked', codeWord: 'БОНУС' });
  const output = [];
  assert.equal(await leadMagnetCli(['promise', 'update', '--projects-dir', projectsDir,
    '--id', id, '--from', 'linked'], { write: (line) => output.push(line) }), 0, output.join('\n'));
  publishCheckedRevision(projectsDir, id);
  const current = view(projectsDir);
  assert.equal(current.magnets[0].promiseChanged, false);
  assert.deepEqual([current.status, current.magnets[0].approvable], ['waiting', true]);
  fs.writeFileSync(path.join(linkedDir, 'script.txt'), 'Финал. и я пришлю пошаговую инструкцию и семь промптов.');
  addOffer(linkedDir, {
    codeWord: 'БОНУС', kind: 'comment-keyword', quote: 'и я пришлю пошаговую инструкцию и семь промптов',
    units: UNITS, sourceKind: 'script', scriptPath: 'script.txt',
  });
  assert.equal(view(projectsDir).magnets[0].promiseChanged, true);
});

test('a damaged passport stays visible as a library error on cards', (t) => {
  const { projectsDir } = makePultRoot(t);
  addVideoWithOffer(projectsDir, { folder: 'clip' });
  const id = addLeadMagnetFor(projectsDir, 'clip');
  fs.writeFileSync(path.join(projectsDir, '.lead-magnets', id, 'lead-magnet.json'), '{');
  const current = view(projectsDir);
  assert.match(current.error, /повреждён/);
  assert.deepEqual([current.status, current.nextStep], ['working', 'Лид-магнит: файл повреждён – попросите агента проверить']);
  const [card] = attachLeadMagnets(projectsDir, [{ folder: 'clip', status: 'waiting' }]);
  assert.deepEqual(card.leadMagnet, { ask: true, status: 'working', nextStep: current.nextStep });
  addDraftProject(projectsDir, { folder: 'plain' });
  const [plain] = attachLeadMagnets(projectsDir, [{ folder: 'plain', status: 'ready' }]);
  assert.deepEqual(plain.leadMagnet, { ask: false, status: 'working', nextStep: current.nextStep });
});

test('a damaged decision file outranks a waiting lead magnet on the card', (t) => {
  const { projectsDir } = makePultRoot(t);
  const projectDir = addVideoWithOffer(projectsDir, { folder: 'clip' });
  const id = addLeadMagnetFor(projectsDir, 'clip');
  publishCheckedRevision(projectsDir, id);
  fs.mkdirSync(path.join(projectDir, 'pult'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'pult', 'lead-magnet.json'), '{');
  const current = view(projectsDir);
  assert.match(current.error, /повреждён/);
  assert.deepEqual([current.status, current.nextStep], ['working', 'Лид-магнит: файл повреждён – попросите агента проверить']);
});

test('a red check keeps the lead magnet on the agent side', (t) => {
  const { projectsDir } = makePultRoot(t);
  addVideoWithOffer(projectsDir, { folder: 'clip' });
  const id = addLeadMagnetFor(projectsDir, 'clip');
  publishCheckedRevision(projectsDir, id, { ok: false });
  const [magnet] = view(projectsDir).magnets;
  assert.deepEqual([magnet.status, magnet.approvable], ['working', false]);
});

test('a broken decision file is reported instead of thrown', (t) => {
  const { projectsDir } = makePultRoot(t);
  const projectDir = addVideoWithOffer(projectsDir, { folder: 'clip' });
  fs.mkdirSync(path.join(projectDir, 'pult'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'pult', 'lead-magnet.json'), '{');
  const current = view(projectsDir);
  assert.match(current.error, /повреждён/);
  assert.deepEqual(current.offers, []);
  assert.equal(current.status, 'working');
});

test('cards get a light summary only where there is something to show', (t) => {
  const { projectsDir } = makePultRoot(t);
  addVideoWithOffer(projectsDir, { folder: 'clip' });
  addDraftProject(projectsDir, { folder: 'plain' });
  const [clip, plain] = attachLeadMagnets(projectsDir, [{ folder: 'clip', status: 'working' }, { folder: 'plain', status: 'waiting' }]);
  assert.deepEqual(clip.leadMagnet, { ask: true, status: null, nextStep: null });
  assert.equal(Object.hasOwn(plain, 'leadMagnet'), false);
});
