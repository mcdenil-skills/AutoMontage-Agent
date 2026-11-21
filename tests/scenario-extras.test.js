const test = require('node:test');
const assert = require('node:assert/strict');
const { scenarioExtras } = require('../scripts/scenario-extras');

// Регресс из PR #14: schema/scenario.schema.json разрешает audio и theme, а build.js их терял –
// музыка листа молча не попадала в рендер, тема бралась только из --theme.
const resolveTheme = (name) => ({ resolved: name });

test('scenarioExtras: audio листа переходит в props', () => {
  const audio = { music: { file: 'music.mp3', volume: 0.2 } };
  assert.deepEqual(scenarioExtras({ audio }, { themeFlag: false, resolveTheme }).audio, audio);
});

test('scenarioExtras: тема листа – строка через resolveTheme, объект как есть', () => {
  assert.deepEqual(scenarioExtras({ theme: 'neon' }, { themeFlag: false, resolveTheme }).theme, { resolved: 'neon' });
  const custom = { colors: { accent: '#fff' } };
  assert.equal(scenarioExtras({ theme: custom }, { themeFlag: false, resolveTheme }).theme, custom);
});

test('scenarioExtras: флаг --theme важнее темы листа', () => {
  assert.equal(scenarioExtras({ theme: 'neon' }, { themeFlag: true, resolveTheme }).theme, null);
});

test('scenarioExtras: лист без audio и theme ничего не добавляет', () => {
  assert.deepEqual(scenarioExtras({ blocks: [] }, { themeFlag: false, resolveTheme }), { audio: null, theme: null });
  assert.deepEqual(scenarioExtras(null, { themeFlag: false, resolveTheme }), { audio: null, theme: null });
});
