#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildMotionDemoFixture } = require('../generate-neutral-fixtures');
const { buildMotionDemoArgs } = require('../project/cli-options');
const { createMotionProject } = require('./source');
const { publishBriefRevision, resolveProjectPath, writeFilesNoReplace } = require('../project/workspace');
const { ROOT, configureMediaToolPath } = require('../env');

function initializeMotionDemo({ projectDir }) {
  const dir = path.resolve(projectDir);
  // Refuse every pre-existing entry, including empty directories and dangling links.
  try { fs.lstatSync(dir); throw new Error('motion demo project already exists; choose a new --project-dir'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const fixture = buildMotionDemoFixture();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-motion-demo-'));
  try {
    const narrationPath = path.join(temporary, 'narration.wav');
    fs.writeFileSync(narrationPath, fixture.audioBytes, { flag: 'wx' });
    const { workspace } = createMotionProject({ projectDir: dir, name: 'Neutral motion demo', narrationPath });
    writeFilesNoReplace([
      ['script.txt', fixture.script], ['transcript/words.json', `${JSON.stringify(fixture.transcript, null, 2)}\n`],
      ['assets/neutral.png', fixture.imageBytes],
    ].map(([relative, data]) => ({ destination: resolveProjectPath(dir, relative, { type: 'file' }), data, purpose: 'motion-demo' })));
    const draft = publishBriefRevision(workspace, { kind: 'motion-reel', brief: fixture.brief });
    return { projectDir: dir, ...draft };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

if (require.main === module) {
  try {
    configureMediaToolPath();
    const args = buildMotionDemoArgs(ROOT, process.cwd(), process.argv.slice(2));
    const result = initializeMotionDemo({ projectDir: args[2] });
    console.log(`Motion demo draft: ${result.jsonPath}\nTest tones, not speech; illustrative timing; no provider calls.\n`
      + `Next: automontage preview --project-dir ${JSON.stringify(result.projectDir)} --brief ${result.relativePath}\n`
      + 'Watch the full preview, then explicitly approve before rendering a final.');
  } catch (error) { console.error(`Motion demo cancelled: ${error.message}`); process.exitCode = 1; }
}

module.exports = { initializeMotionDemo };
