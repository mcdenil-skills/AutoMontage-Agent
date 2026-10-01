const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const library = require('../scripts/lead-magnet/library');
const { makeLeadMagnet, writeRevision } = require('./helpers/lead-magnet-fixtures');

const cli = path.join(__dirname, '..', 'scripts', 'cli.js');

for (const scenario of [
  { name: 'RED', facts: [{ claim: 'Неверный факт', source: 'Локальный источник', status: 'failed' }], code: 1,
    item: '✕ facts:', summary: 'Есть красные пункты – исправь до показа.' },
  { name: 'GREEN', facts: [], code: 0,
    item: '✓ facts:', summary: 'Каркас и факты: всё зелёное.' },
]) {
  test(`automontage lead-magnet check ${scenario.name} saves and prints its report with exit code ${scenario.code}`, (t) => {
    const { projectsDir, id } = makeLeadMagnet(t);
    const { n, dir } = library.startRevision(projectsDir, id);
    writeRevision(dir, { facts: scenario.facts });

    const result = spawnSync(process.execPath, [cli, 'lead-magnet', 'check', '--projects-dir', projectsDir,
      '--id', id, '--revision', String(n)], { encoding: 'utf8', timeout: 60000 });

    assert.ifError(result.error);
    assert.equal(result.status, scenario.code, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, '');
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'qa', 'check.json'), 'utf8'));
    assert.equal(report.ok, scenario.code === 0);
    assert.equal(report.items.find((item) => item.id === 'facts').ok, scenario.code === 0);
    assert.ok(result.stdout.includes(scenario.item), result.stdout);
    assert.ok(result.stdout.includes(scenario.summary), result.stdout);
  });
}
