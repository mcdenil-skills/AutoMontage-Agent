# Motion Reel Public Mode Implementation Plan

> **For agent:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Ship a public `motion-reel` mode that turns narration into a camera-free animated reel while preserving the existing draft, approval, render and QA guarantees.

**Architecture:** Add a separate motion brief and `MotionReel` composition, extend workspaces to accept audio sources, and reuse the current safe preview/approval/render pipeline through kind-based dispatch. Keep ElevenLabs an optional local adapter; the core mode works with an existing audio file and no provider credentials.

**Tech Stack:** Node.js 20 CommonJS orchestration, JSON Schema/Ajv, React 19, Remotion 4, FFmpeg/FFprobe, local faster-whisper, Node test runner, Playwright for Review acceptance.

**Spec:** `docs/superpowers/specs/2026-09-08-motion-reel-public-mode-design.md`

---

### Task 1: Start from the published baseline and freeze the public contract

**Files:**
- Create: `docs/superpowers/specs/2026-09-08-motion-reel-public-mode-design.md`
- Create: `docs/superpowers/plans/2026-09-08-motion-reel-public-mode.md`
- Modify: `DECISIONS.md`

- [ ] **Step 1: Create an isolated worktree from the published branch**

Use `superpowers:using-git-worktrees`. Base the branch on `origin/main` 1.6.0, not the stale
local `main`, and use the branch name `codex/motion-reel`.

- [ ] **Step 2: Record the architecture decision**

Add a decision that `MotionReel` is a sibling of `ReelScenes`, audio is a first-class source,
and paid narration is an optional adapter. Record why a synthetic blank video and a separate
repository were rejected.

- [ ] **Step 3: Commit the design checkpoint**

```bash
git add docs/superpowers/specs/2026-09-08-motion-reel-public-mode-design.md \
  docs/superpowers/plans/2026-09-08-motion-reel-public-mode.md DECISIONS.md
git commit -m "docs: specify public motion-reel workflow"
```

### Task 2: Add the motion brief contract and kind dispatch

**Files:**
- Create: `schema/motion-brief.schema.json`
- Create: `scripts/motion/brief.js`
- Create: `tests/motion-brief.test.js`
- Modify: `schema/project.schema.json`
- Modify: `scripts/project/workspace.js`
- Modify: `scripts/project/approve-brief.js`
- Modify: `tests/project-workspace.test.js`
- Modify: `tests/project-mutation-transaction.test.js`

- [ ] **Step 1: Write failing schema and migration tests**

Cover all seven motion scene types, overlapping or off-frame timing, text limits, unknown
properties, invalid media references, draft/approved enforcement and old manifest loading.
Assert that new projects store these discriminators and old projects infer the defaults:

```js
assert.equal(project.manifest.projectKind, 'motion-reel');
assert.equal(project.manifest.source.mediaKind, 'audio');
assert.equal(project.manifest.briefs[0].kind, 'motion-reel');
```

- [ ] **Step 2: Run the focused tests and verify the intended failures**

```bash
node --test tests/motion-brief.test.js tests/project-workspace.test.js \
  tests/project-mutation-transaction.test.js
```

- [ ] **Step 3: Implement the separate schema and validator**

Export this narrow API from `scripts/motion/brief.js`:

```js
module.exports = {
  MOTION_SCENES,
  buildDraftMotionProps,
  buildMotionProps,
  formatMotionBriefMarkdown,
  validateMotionBrief,
};
```

Use scene-specific JSON Schema branches and semantic checks for ordered, frame-snapped timing.
Do not accept executable markup or unreviewed remote media.

- [ ] **Step 4: Generalize workspace publication and approval by brief kind**

Add optional `projectKind`, `source.mediaKind` and `briefs[].kind` properties. In
`migrateProjectManifest()`, fill missing values as `video`, `video` and `lesson` before
validation. The `video` default covers both existing Dynamic and lesson projects. Dispatch
validation and Markdown formatting from the stored brief kind; never infer a motion brief from
its filename alone.

- [ ] **Step 5: Run focused tests until green**

```bash
node --test tests/motion-brief.test.js tests/project-workspace.test.js \
  tests/project-mutation-transaction.test.js
```

- [ ] **Step 6: Commit the contract**

```bash
git add schema/motion-brief.schema.json schema/project.schema.json \
  scripts/motion/brief.js scripts/project/workspace.js scripts/project/approve-brief.js \
  tests/motion-brief.test.js tests/project-workspace.test.js \
  tests/project-mutation-transaction.test.js
git commit -m "feat: add versioned motion-reel briefs"
```

### Task 3: Make audio a first-class project source

**Files:**
- Modify: `scripts/media-probe.js`
- Create: `scripts/motion/source.js`
- Create: `scripts/motion/workflow.js`
- Create: `tests/motion-source.test.js`
- Modify: `tests/media-probe.test.js`
- Modify: `scripts/project/workspace.js`

- [ ] **Step 1: Write failing audio probe and workspace tests**

Use tiny generated WAV/MP3 fixtures. Test duration, codec, sample rate, channels, a missing
audio stream, malformed ffprobe JSON, symlink/path escape rejection and an old video project.
The normalized result must have a discriminated shape:

```js
{
  mediaKind: 'audio',
  durationSec: 50.633,
  sampleRate: 44100,
  channels: 1,
  codec: 'mp3'
}
```

- [ ] **Step 2: Run the focused tests and confirm failure**

```bash
node --test tests/media-probe.test.js tests/motion-source.test.js
```

- [ ] **Step 3: Extend probing without weakening video validation**

Keep `parseMediaProbeJson()` strict for existing image/video import callers. Add a dedicated
`parseAudioProbeJson()` and `probeOpenedAudio()` so callers must opt into audio semantics.

- [ ] **Step 4: Create the motion workspace lifecycle**

`scripts/motion/source.js` copies narration into `input/` through the existing no-follow,
atomic workspace primitives. `scripts/motion/workflow.js` binds that file to a temporary
Remotion public lease and produces composition props without `faceSrc`.

- [ ] **Step 5: Produce word timing**

For a supplied narration file, reuse local faster-whisper and write the same canonical word
records consumed by brief generation. Do not require OpenAI or Anthropic API keys.

- [ ] **Step 6: Run tests and commit**

```bash
node --test tests/media-probe.test.js tests/motion-source.test.js \
  tests/project-workspace.test.js
git add scripts/media-probe.js scripts/motion/source.js scripts/motion/workflow.js \
  scripts/project/workspace.js tests/media-probe.test.js tests/motion-source.test.js
git commit -m "feat: support audio-only motion projects"
```

### Task 4: Render the public motion scene library

**Files:**
- Create: `src/MotionDirector.jsx`
- Create: `src/motion/KineticTitle.jsx`
- Create: `src/motion/CardScene.jsx`
- Create: `src/motion/StepsScene.jsx`
- Create: `src/motion/ListScene.jsx`
- Create: `src/motion/CounterScene.jsx`
- Create: `src/motion/MediaScene.jsx`
- Create: `src/motion/CtaScene.jsx`
- Create: `src/motion/motion-theme.js`
- Create: `src/motion/parts.jsx`
- Modify: `src/Root.jsx`
- Create: `tests/motion-render.test.js`
- Create: `tests/motion-timing.test.js`

- [ ] **Step 1: Write failing prop and timing tests**

Assert that duration comes from the brief, audio is present once, scene sequences use global
time, no face source is required and every scene handles Cyrillic strings at schema maxima.

- [ ] **Step 2: Register the composition**

Add `MotionReel` to `src/Root.jsx` with 1080×1920/30 defaults and metadata calculated from
validated props:

```jsx
<Composition
  id="MotionReel"
  component={MotionDirector}
  durationInFrames={300}
  fps={30}
  width={1080}
  height={1920}
  defaultProps={{ theme: 'motion-neutral', scenes: [] }}
  calculateMetadata={({props}) => ({
    durationInFrames: props.durationInFrames,
    fps: props.fps,
    width: props.width,
    height: props.height,
  })}
/>
```

- [ ] **Step 3: Implement the seven deterministic scenes**

Animate only through Remotion frame-derived values. Reuse shared safe-zone and font loading
where compatible. `steps` reveals node → connector → node; `counter` interpolates to its
approved value; full-vector scenes omit the standard subtitle stripe by default.

- [ ] **Step 4: Add a neutral public theme**

Create original generic tokens and motion presets. Do not sample the reference reel's palette,
fonts, layout measurements or branding.

- [ ] **Step 5: Render representative frames and run tests**

```bash
node --test tests/motion-brief.test.js tests/motion-timing.test.js \
  tests/motion-render.test.js
```

Inspect frames for hook, steps, counter, dense Cyrillic list and CTA at 1080×1920.

- [ ] **Step 6: Commit the renderer**

```bash
git add src/Root.jsx src/MotionDirector.jsx src/motion tests/motion-render.test.js \
  tests/motion-timing.test.js
git commit -m "feat: render camera-free motion scenes"
```

### Task 5: Wire CLI, preview, approval, final render and QA

**Files:**
- Modify: `scripts/cli.js`
- Create: `scripts/motion/build.js`
- Modify: `scripts/preview.js`
- Modify: `scripts/qa-preview.js`
- Modify: `scripts/review/server.js`
- Modify: `scripts/review/model.js`
- Create: `tests/motion-workflow.test.js`
- Modify: `tests/review-compatibility.test.js`
- Modify: `tests/qa-preview.test.js`
- Modify: `tests/cli.test.js`

- [ ] **Step 1: Write failing end-to-end workflow tests**

Cover `automontage motion`, a watermarked draft preview, hash-bound approval, approved-only final,
immutable version labels, Review loading and QA. Assert that lesson briefs cannot render through
`MotionReel` and motion briefs cannot render through `ReelScenes`.

- [ ] **Step 2: Add the CLI route**

Route the first token `motion` before legacy build forwarding. Keep the public command contract:

```text
automontage motion <audio> --project <name>
automontage preview --project-dir <dir> --brief brief/vNN-draft.motion.json
node scripts/project/approve-brief.js <dir> brief/vNN-draft.motion.json --confirm-preview-viewed
automontage motion --project-dir <dir> --brief brief/vNN-approved.motion.json --version-label <label>
```

- [ ] **Step 3: Dispatch preview and final preparation by brief kind**

Reuse existing render-media leases, atomic manifests, preview hashes, output ownership, audio
finish and music ducking. Keep final folders approved-only.

- [ ] **Step 4: Make Review kind-aware**

Display motion scene names and text fields without exposing provider settings or secrets. Keep
the browser unable to choose arbitrary local paths or executable content.

- [ ] **Step 5: Run focused workflow and UI-independent Review tests**

```bash
node --test tests/motion-workflow.test.js tests/review-compatibility.test.js \
  tests/qa-preview.test.js tests/cli.test.js
```

- [ ] **Step 6: Commit the workflow**

```bash
git add scripts/cli.js scripts/motion/build.js scripts/preview.js scripts/qa-preview.js \
  scripts/review/server.js scripts/review/model.js tests/motion-workflow.test.js \
  tests/review-compatibility.test.js tests/qa-preview.test.js tests/cli.test.js
git commit -m "feat: add motion-reel preview and render workflow"
```

### Task 6: Add optional ElevenLabs narration safely

**Files:**
- Create: `scripts/voice/elevenlabs.js`
- Create: `scripts/voice/alignment.js`
- Create: `tests/elevenlabs-voice.test.js`
- Modify: `scripts/motion/build.js`
- Modify: `.env.example`
- Modify: `scripts/check-public-privacy.js`
- Modify: `tests/public-privacy.test.js`

- [ ] **Step 1: Write failing adapter tests with a local mock server**

Verify request shape, base64 decoding, character-to-word alignment, Unicode/Cyrillic handling,
cache-key stability, redacted errors, missing key, missing voice ID, missing
`--accept-provider-cost`, timeout and ambiguous failure without automatic retry. Never call the
live provider from tests.

- [ ] **Step 2: Implement a dependency-injected adapter**

Expose a small API whose network and filesystem edges can be replaced in tests:

```js
module.exports = {
  buildNarrationCacheKey,
  charactersToWords,
  synthesizeWithTimestamps,
};
```

Call `/v1/text-to-speech/:voice_id/with-timestamps`. Cache by SHA-256 of script, voice ID,
model ID, voice settings and output format. Store provider outputs only inside the ignored
project workspace.

- [ ] **Step 3: Document empty environment placeholders**

Add only:

```dotenv
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
```

Explain that the voice ID is private configuration and has no repository default.

- [ ] **Step 4: Extend privacy checks**

Reject ElevenLabs-style secret assignments, non-empty tracked `ELEVENLABS_VOICE_ID`
assignments and narration caches outside ignored project paths. Add a positive case for empty
`.env.example` values. Do not place a real voice ID in the scanner or its fixtures.

- [ ] **Step 5: Run tests and commit**

```bash
node --test tests/elevenlabs-voice.test.js tests/public-privacy.test.js
git add scripts/voice scripts/motion/build.js .env.example scripts/check-public-privacy.js \
  tests/elevenlabs-voice.test.js tests/public-privacy.test.js
git commit -m "feat: add opt-in ElevenLabs narration"
```

### Task 7: Ship a credential-free demo, public skill and synchronized docs

**Files:**
- Modify: `scripts/generate-neutral-fixtures.js`
- Modify: `scripts/project/cli-options.js`
- Create: `examples/motion-brief-demo.json`
- Create: `skills/motion-reel/SKILL.md`
- Create: `skills/motion-reel/references/brief-package.md`
- Create: `.agents/skills/motion-reel/SKILL.md`
- Create: `.codex/skills/motion-reel/SKILL.md`
- Modify: `skills/reel-turnkey/SKILL.md`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `docs/TEMPLATES.md`
- Modify: `docs/SCENE-CATALOG.md`
- Modify: `docs/MONTAGE-GUIDE.md`
- Modify: `TESTING.md`
- Modify: `CHANGELOG.md`
- Create: `tests/motion-demo.test.js`
- Modify: `tests/neutral-fixtures.test.js`

- [ ] **Step 1: Write failing demo and skill consistency tests**

The demo must use generated neutral audio, render offline and contain no user media. Test that
the three skill copies stay byte-identical and route camera-free requests to `motion-reel`.

- [ ] **Step 2: Generate the neutral fixture**

Extend the existing deterministic fixture generator rather than committing narration audio.
The generated script and brief demonstrate all scene families with invented generic copy.

- [ ] **Step 3: Write the public agent workflow**

The skill must cover topic → script → narration choice → timed motion brief → preview → explicit
approval → final → QA. Remove the talking-head hook requirement for this mode. Keep provider
cost approval and privacy requirements explicit.

- [ ] **Step 4: Synchronize product documentation**

Document commands, the seven motion scenes, audio-only workspaces, provider opt-in, failure
modes, QA, and the boundary between engine and future scheduling/autopublishing.

- [ ] **Step 5: Run demo and documentation tests, then commit**

```bash
node --test tests/motion-demo.test.js tests/neutral-fixtures.test.js \
  tests/public-privacy.test.js
git add scripts/generate-neutral-fixtures.js scripts/project/cli-options.js examples \
  skills/motion-reel .agents/skills/motion-reel .codex/skills/motion-reel \
  skills/reel-turnkey/SKILL.md README.md ARCHITECTURE.md docs/TEMPLATES.md \
  docs/SCENE-CATALOG.md docs/MONTAGE-GUIDE.md TESTING.md CHANGELOG.md \
  tests/motion-demo.test.js tests/neutral-fixtures.test.js
git commit -m "docs: publish the motion-reel workflow"
```

### Task 8: Validate and prepare release 1.7.0

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/check-release.js`
- Modify: `scripts/smoke-release.js`
- Modify: `tests/release-hygiene.test.js`
- Modify: `tests/smoke-release.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add release and cross-platform gates**

Run the audio probe/workspace tests on Windows and the credential-free motion smoke on Linux.
Teach release checks to require the motion schema, composition, CLI help, skill and demo.

- [ ] **Step 2: Run the complete local gate**

```bash
npm ci --no-audit --no-fund
npm test
npm run check:privacy
npm run check:release
npm run smoke:release
npm pack --dry-run
```

Inspect rendered hook, steps, dense Cyrillic list, counter and CTA frames. Decode the full demo
with FFmpeg and confirm 1080×1920, 30 FPS, H.264/AAC, expected duration and one narration track.

- [ ] **Step 3: Perform a clean-clone test**

Install the packed tarball into a temporary empty directory and render the motion demo with no
`.env`, provider key or private theme. Repeat the portable focused suite on Windows CI.

- [ ] **Step 4: Prepare SemVer release files**

Bump `package.json` and `package-lock.json` from 1.6.0 to 1.7.0. Move the changelog entry from
`Unreleased` to `1.7.0` with the release date and update the version shown in README.

- [ ] **Step 5: Review the exact public diff**

```bash
git status --short
git diff --check
git diff
npm run check:privacy
```

Confirm that the diff contains no reference reel, generated narration, user script, voice ID,
API key, absolute local path, project workspace, render or copied visual identity.

- [ ] **Step 6: Commit the release candidate**

```bash
git add .github/workflows/ci.yml scripts/check-release.js scripts/smoke-release.js \
  tests/release-hygiene.test.js tests/smoke-release.test.js package.json package-lock.json \
  README.md CHANGELOG.md
node scripts/check-public-privacy.js --staged
git diff --cached
git commit -m "release: prepare AutoMontage-Agent 1.7.0"
```

- [ ] **Step 7: Stop for publication authorization**

Push, pull-request creation, merge, tag `v1.7.0` and GitHub Release are external publication
steps. Show the final diff, green local gates and exact branch before asking the owner to
authorize them.

## Self-review

- The mode is useful without ElevenLabs and therefore does not make a paid service a runtime
  requirement.
- The agent subscription handles creative planning; the public CLI stays deterministic.
- Audio is represented honestly instead of hidden inside a fabricated video.
- Existing lesson manifests remain backward compatible.
- The camera-free renderer has its own schema and cannot weaken `ReelScenes` approval gates.
- The implementation plan includes code, tests, public docs, skill adapters, privacy checks,
  package smoke, CI and SemVer release work.
- Scheduling and autopublishing remain outside this release because they require persistent
  infrastructure and account-level credentials.
