'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { makeReviewProject } = require('./helpers/review-project');
const { applyReviewCommands } = require('../scripts/review/commands');
const {
  buildReviewCandidateBase,
  buildReviewStateFromEdit,
} = require('../scripts/review/model');
const { diffLessonBrief } = require('../scripts/review/diff');
function context(t) {
  const f = makeReviewProject(t);
  const brief = JSON.parse(fs.readFileSync(f.briefPath));
  brief.scenes[0].scene = 'broll';
  brief.scenes[0].headCream = 'ГОРОД';
  brief.scenes[0].headOrange = 'УТРО';
  brief.scenes[0].brollMedia = {
    kind: 'image',
    src: 'assets/a.webp',
    sha256: 'a'.repeat(64),
    fit: 'cover',
  };
  const asset = {
    mediaKind: 'image',
    reference: 'assets/a.webp',
    canonicalSha256: 'a'.repeat(64),
    scanSha256: 'b'.repeat(64),
    provenance: { provider: 'pexels' },
    textScan: { status: 'needs-review' },
    capabilities: { brollImage: true },
  };
  return {
    brief,
    assets: new Map([
      ['asset-1', asset],
      ['asset-2', { ...asset, reference: 'assets/b.webp' }],
    ]),
  };
}
test('ack command accepts only boolean and maps canonical selection evidence to browser boolean', (t) => {
  const { brief, assets } = context(t);
  brief.scenes[0].brollReview = {
    assetSha256: 'a'.repeat(64),
    scanSha256: 'b'.repeat(64),
    allowEmbeddedText: true,
  };
  const base = buildReviewCandidateBase({
    canonicalBrief: brief,
    assetFiles: assets,
  });
  assert.equal(base.scenes[0].brollReview, true);
  const changed = applyReviewCommands({
    brief: base,
    assets,
    fps: 25,
    commands: [
      { type: 'allow-broll-text', sceneIndex: 0, allowEmbeddedText: false },
    ],
  });
  assert.equal(changed.scenes[0].brollReview, undefined);
  assert.deepEqual(
    diffLessonBrief({ before: base, after: changed }).filter(
      (c) => c.kind === 'embedded-text',
    ),
    [{ kind: 'embedded-text', scene: 0, from: true, to: false }],
  );
  assert.throws(() =>
    applyReviewCommands({
      brief: base,
      assets,
      fps: 25,
      commands: [
        {
          type: 'allow-broll-text',
          sceneIndex: 0,
          allowEmbeddedText: true,
          scanSha256: 'evil',
        },
      ],
    }),
  );
});
test('replacement clears acknowledgement, replay of original restores it and discovered assets require preview policy', (t) => {
  const { brief, assets } = context(t);
  const base = buildReviewCandidateBase({
    canonicalBrief: brief,
    assetFiles: assets,
  });
  const allowed = applyReviewCommands({
    brief: base,
    assets,
    fps: 25,
    commands: [
      { type: 'allow-broll-text', sceneIndex: 0, allowEmbeddedText: true },
    ],
  });
  assert.equal(allowed.scenes[0].brollReview, true);
  const replaced = applyReviewCommands({
    brief: allowed,
    assets,
    fps: 25,
    commands: [{ type: 'replace-broll', sceneIndex: 0, assetId: 'asset-2' }],
  });
  assert.equal(replaced.scenes[0].brollReview, undefined);
  assert.equal(replaced.brollReviewPolicy, 'preview-required');
  assert.equal(
    applyReviewCommands({ brief: allowed, assets, fps: 25, commands: [] })
      .scenes[0].brollReview,
    true,
  );
  const state = buildReviewStateFromEdit({ state: {}, brief: base });
  assert.equal(JSON.stringify(state).includes('a'.repeat(64)), false);
});
const {
  verifyBriefBrollMedia,
} = require('../scripts/lesson/broll-media-files');
const { hashTextScan } = require('../scripts/broll/text-scan');
const crypto = require('node:crypto');
const path = require('node:path');
function bundle(t, status = 'needs-review') {
  const { brief } = context(t);
  const f = makeReviewProject(t);
  const id = '4af36be4-0b26-4e6f-bd48-8bdd2215a4f1';
  const dir = path.join(f.projectDir, 'assets/broll/images', id);
  fs.mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from('image');
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const textScan = {
    status,
    text: status === 'needs-review' ? 'BRAND' : '',
    reasons: status === 'clear' ? [] : ['ocr-unavailable'],
    engine: 'tesseract',
  };
  const metadata = {
    version: 3,
    id,
    label: 'photo.jpg',
    mediaKind: 'image',
    canonicalSha256: hash,
    previewSha256: null,
    width: 1200,
    height: 800,
    fps: 0,
    durationSec: 0,
    audioDurationSec: null,
    hasAudio: false,
    provenance: {
      provider: 'pexels',
      providerAssetId: '123',
      sourcePage: 'https://www.pexels.com/photo/example-123/',
      author: { name: 'Jane', url: 'https://www.pexels.com/@jane/' },
      license: {
        name: 'Pexels License',
        url: 'https://www.pexels.com/license/',
      },
      queryOriginal: 'город',
      queryEnglish: 'city',
      retrievedAt: '2026-09-08T00:00:00.000Z',
      rendition: {
        id: 'original',
        width: 1200,
        height: 800,
        mimeType: 'image/jpeg',
      },
    },
    textScan,
  };
  fs.writeFileSync(path.join(dir, 'media.webp'), bytes);
  fs.writeFileSync(path.join(dir, 'asset.json'), JSON.stringify(metadata));
  brief.scenes[0].brollMedia.src = `assets/broll/images/${id}/media.webp`;
  brief.scenes[0].brollMedia.sha256 = hash;
  const runToolImpl = () => ({
    status: 0,
    stdout: JSON.stringify({
      streams: [
        { codec_type: 'video', codec_name: 'webp', width: 1200, height: 800 },
      ],
      format: { format_name: 'webp_pipe' },
    }),
  });
  return {
    root: f.root,
    workspace: f.workspace,
    brief,
    runToolImpl,
    metadata,
    path: path.join(dir, 'asset.json'),
  };
}
test('approval rejects missing or stale OCR acknowledgement and accepts exact evidence', (t) => {
  for (const status of ['needs-review', 'unavailable']) {
    const b = bundle(t, status);
    assert.throws(() => verifyBriefBrollMedia(b), {
      code: 'BROLL_TEXT_REVIEW_REQUIRED',
    });
    b.brief.scenes[0].brollReview = {
      assetSha256: b.metadata.canonicalSha256,
      scanSha256: 'c'.repeat(64),
      allowEmbeddedText: true,
    };
    assert.throws(() => verifyBriefBrollMedia(b), {
      code: 'BROLL_TEXT_REVIEW_REQUIRED',
    });
    b.brief.scenes[0].brollReview.scanSha256 = hashTextScan(
      b.metadata.textScan,
    );
    const verified = verifyBriefBrollMedia(b);
    verified.assertCurrent();
    fs.writeFileSync(
      b.path,
      JSON.stringify({
        ...b.metadata,
        textScan: { ...b.metadata.textScan, text: 'OTHER' },
      }),
    );
    assert.throws(() => verified.assertCurrent(), {
      code: 'BROLL_MEDIA_IDENTITY_CHANGED',
    });
    verified.close();
  }
});
test('clear scans need no acknowledgement; unresolved draft intent cannot approve', (t) => {
  const b = bundle(t, 'clear');
  const handle = verifyBriefBrollMedia(b);
  handle.assertCurrent();
  handle.close();
  delete b.brief.scenes[0].brollMedia;
  b.brief.scenes[0].brollIntent = { queryEnglish: 'city' };
  assert.throws(() => verifyBriefBrollMedia(b), {
    code: 'BROLL_INTENT_UNRESOLVED',
  });
});

test('verified v3 discovery provenance requires preview even without authoring markers; v2 remains compatible', (t) => {
  const path = require('node:path');
  const { approveBrief } = require('../scripts/project/workspace');
  for (const version of [3, 2]) {
    const b = bundle(t, 'clear');
    b.brief.source = b.workspace.sourcePath;
    if (version === 2) {
      b.metadata.version = 2;
      delete b.metadata.provenance;
      delete b.metadata.textScan;
      fs.writeFileSync(b.path, JSON.stringify(b.metadata));
    }
    const draftPath = path.join(b.workspace.dir, b.workspace.manifest.currentBrief);
    fs.writeFileSync(draftPath, JSON.stringify(b.brief));
    const approve = () => approveBrief(b.workspace, draftPath, { root: b.root, runToolImpl: b.runToolImpl });
    if (version === 3) assert.throws(approve, /preview/i);
    else assert.equal(JSON.parse(fs.readFileSync(approve().jsonPath)).status, 'approved');
  }
});

test('final media verification refuses approved v3 discovery without its preview receipt', (t) => {
  const b = bundle(t, 'clear');
  b.brief.status = 'approved';
  assert.throws(() => verifyBriefBrollMedia(b), {code:'BROLL_PREVIEW_REQUIRED'});
  b.brief.brollReviewPolicy = 'preview-required';
  assert.throws(() => verifyBriefBrollMedia(b), {code:'BROLL_PREVIEW_REQUIRED'});
  b.brief.brollApproval = {draftSha256:'a'.repeat(64),previewSha256:'b'.repeat(64),confirmedAt:'2026-09-08T00:00:00.000Z'};
  const verified = verifyBriefBrollMedia(b);verified.assertCurrent();verified.close();
});

test('common approval barrier catches b-roll bytes changed during the final preview source hash', (t) => {
  const path = require('node:path');
  const crypto = require('node:crypto');
  const { approveBrief } = require('../scripts/project/workspace');
  const { planPreview, publishCurrentPreview } = require('../scripts/project/preview-workspace');
  const b = bundle(t, 'clear');
  b.brief.source = b.workspace.sourcePath;
  b.brief.brollReviewPolicy = 'preview-required';
  const draftPath = path.join(b.workspace.dir, b.workspace.manifest.currentBrief);
  fs.writeFileSync(draftPath, JSON.stringify(b.brief));
  const planned = planPreview(b.workspace, {briefPath:draftPath,briefSha256:crypto.createHash('sha256').update(fs.readFileSync(draftPath)).digest('hex'),range:{kind:'full',fromSec:0,toSec:4}});
  const staged = path.join(b.workspace.dir,'previews/stage.mp4');fs.writeFileSync(staged,'preview');
  publishCurrentPreview(b.workspace,planned,staged,{width:1920,height:1080,fps:25,generatedAt:new Date().toISOString()});
  const descriptors = new Map();let sourceReads=0;let changed=false;
  const fileSystem = new Proxy(fs,{get(target,key){
    if(key==='openSync')return (filename,...args)=>{const fd=target.openSync(filename,...args);descriptors.set(fd,String(filename));return fd;};
    if(key==='readSync')return (fd,buffer,offset,length,position)=>{const read=target.readSync(fd,buffer,offset,length,position);if(descriptors.get(fd)===b.workspace.sourcePath&&position===0&&++sourceReads===4){fs.appendFileSync(path.join(b.workspace.dir,b.brief.scenes[0].brollMedia.src),'changed');changed=true;}return read;};
    return Reflect.get(target,key);
  }});
  assert.throws(()=>approveBrief(b.workspace,draftPath,{root:b.root,runToolImpl:b.runToolImpl,fileSystem,confirmPreviewViewed:true}),{code:'BROLL_MEDIA_IDENTITY_CHANGED'});
  assert.equal(changed,true);
});
