const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { readFunnelState, setFunnelState } = require('../scripts/lead-magnet/funnel');
const { leadMagnetDir } = require('../scripts/lead-magnet/library');
const { makeLeadMagnet } = require('./helpers/lead-magnet-fixtures');

const INPUT = { provider: 'chatplace', codeWord: 'ГАЙД', exists: true, automationName: 'Гайд → личка' };
const NOW = () => new Date('2026-09-30T16:00:00.000Z');

test('funnel state is written by the agent and read by the pult', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  assert.equal(readFunnelState(projectsDir, id), null);
  const state = setFunnelState(projectsDir, id, { provider: 'chatplace', codeWord: 'гайд', exists: true, automationName: 'Гайд → личка' }, { now: () => new Date('2026-09-30T16:00:00.000Z') });
  assert.deepEqual(readFunnelState(projectsDir, id), state);
  assert.equal(state.codeWord, 'ГАЙД');
});

test('unknown provider and control characters are rejected', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  assert.throws(() => setFunnelState(projectsDir, id, { provider: 'other', codeWord: 'ГАЙД', exists: false, automationName: null }), /воронк/);
  assert.throws(() => setFunnelState(projectsDir, id, { provider: 'chatplace', codeWord: 'ГАЙД', exists: true, automationName: 'x\u001b[31m' }), /воронк/);
});

test('funnel state rejects a code word not linked to its lead magnet', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  assert.throws(() => setFunnelState(projectsDir, id, { ...INPUT, codeWord: 'ДРУГОЙ' }), /воронк/);
  assert.equal(readFunnelState(projectsDir, id), null);
  assert.equal(setFunnelState(projectsDir, id, { ...INPUT, codeWord: 'гайд' }, { now: NOW }).codeWord, 'ГАЙД');
});

test('a funnel directory swapped to a symlink cannot receive state bytes', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const magnet = leadMagnetDir(projectsDir, id);
  const outside = path.join(path.dirname(projectsDir), 'moved-lead-magnet');
  const destination = path.join(magnet, 'funnel.json');
  const originalOpen = fs.openSync;
  const originalWrite = fs.writeFileSync;
  let swapped = false;
  const swap = (candidate) => {
    if (swapped || typeof candidate !== 'string' || !candidate.startsWith(`${destination}.tmp-`)) return;
    fs.renameSync(magnet, outside);
    fs.symlinkSync(outside, magnet);
    swapped = true;
  };
  fs.openSync = (candidate, ...args) => { swap(candidate); return originalOpen(candidate, ...args); };
  fs.writeFileSync = (candidate, ...args) => { swap(candidate); return originalWrite(candidate, ...args); };
  t.after(() => { fs.openSync = originalOpen; fs.writeFileSync = originalWrite; });
  assert.throws(() => setFunnelState(projectsDir, id, INPUT, { now: NOW }), /identity changed|symbolic link/);
  assert.equal(swapped, true);
  assert.equal(fs.existsSync(path.join(outside, 'funnel.json')), false);
  assert.deepEqual(fs.readdirSync(outside).filter((name) => name.startsWith('funnel.json')), []);
});

test('a funnel directory swapped to a symlink cannot supply state bytes', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const state = setFunnelState(projectsDir, id, INPUT, { now: NOW });
  const magnet = leadMagnetDir(projectsDir, id);
  const outside = path.join(path.dirname(projectsDir), 'moved-lead-magnet');
  const destination = path.join(magnet, 'funnel.json');
  const originalOpen = fs.openSync;
  let swapped = false;
  fs.openSync = (candidate, ...args) => {
    if (!swapped && candidate === destination) {
      fs.renameSync(magnet, outside);
      fs.symlinkSync(outside, magnet);
      swapped = true;
    }
    return originalOpen(candidate, ...args);
  };
  t.after(() => { fs.openSync = originalOpen; });
  assert.throws(() => readFunnelState(projectsDir, id), /identity changed|symbolic link/);
  assert.equal(swapped, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outside, 'funnel.json'), 'utf8')), state);
});

test('a normal funnel directory still allows writing and reading state', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const state = setFunnelState(projectsDir, id, INPUT, { now: NOW });
  assert.deepEqual(readFunnelState(projectsDir, id), state);
});

test('a stored funnel with control characters is refused on read', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const state = setFunnelState(projectsDir, id, INPUT, { now: NOW });
  const file = path.join(leadMagnetDir(projectsDir, id), 'funnel.json');
  fs.writeFileSync(file, JSON.stringify({ ...state, automationName: 'x\u001b[31m' }));
  assert.throws(() => readFunnelState(projectsDir, id), /неверный формат/);
});
