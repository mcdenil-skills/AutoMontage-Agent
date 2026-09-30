const test = require('node:test');
const assert = require('node:assert/strict');

const { readFunnelState, setFunnelState } = require('../scripts/lead-magnet/funnel');
const { makeLeadMagnet } = require('./helpers/lead-magnet-fixtures');

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
