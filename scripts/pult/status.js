const STATUS_ORDER = Object.freeze({ waiting: 0, working: 1, ready: 2 });

function pluralEdits(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} правка`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} правки`;
  return `${count} правок`;
}

// Чистая функция: статус выводится только из явных данных движка (project.json,
// хеш текущего brief, наличие файла финала, число новых правок), без угадывания по MP4.
// approvalBlocker – русская подсказка, если движок заведомо не примет утверждение этого
// черновика (например, b-roll ещё не выбран): ход всё ещё за человеком, но не «утвердите».
function deriveVariantStatus({
  manifest,
  currentBriefStatus,
  currentBriefSha256,
  finalExists,
  pendingComments = 0,
  approvalBlocker = null,
}) {
  const preview = manifest.currentPreview || null;
  const latest = manifest.latestRender
    ? manifest.renders.find((render) => render.dir === manifest.latestRender) || null
    : null;
  const renderMatchesBrief = Boolean(latest && latest.status === 'complete' && (
    manifest.currentBrief === null
    || (currentBriefStatus === 'approved' && latest.briefPath === manifest.currentBrief)
  ));
  const finalIsCurrent = Boolean(finalExists && renderMatchesBrief);
  const previewIsCurrent = Boolean(preview
    && preview.kind === 'full'
    && preview.briefPath === manifest.currentBrief
    && currentBriefSha256
    && preview.briefSha256 === currentBriefSha256);
  const previewVideo = preview ? {
    kind: previewIsCurrent || currentBriefStatus === 'approved' ? 'preview' : 'stale-preview',
    path: preview.filePath,
    sha256: preview.sha256 || null,
  } : null;
  const finalVideo = finalExists ? { kind: 'final', path: manifest.final, sha256: null } : null;

  let status;
  let nextStep;
  if (pendingComments > 0) {
    status = 'working';
    nextStep = `Ждёт агента: ${pluralEdits(pendingComments)}`;
  } else if (finalIsCurrent) {
    status = 'ready';
    nextStep = 'Готов – можно забирать';
  } else if (currentBriefStatus === 'approved') {
    status = 'working';
    nextStep = 'Утверждено – агент собирает финал';
  } else if (currentBriefStatus === 'draft' && previewIsCurrent) {
    status = 'waiting';
    nextStep = approvalBlocker || 'Посмотрите preview и утвердите';
  } else if (currentBriefStatus === 'draft') {
    status = 'working';
    nextStep = 'Агент готовит preview';
  } else {
    status = 'working';
    nextStep = 'Агент готовит черновик';
  }

  const showPreview = status === 'waiting' || (pendingComments > 0 && previewIsCurrent);
  return {
    status,
    nextStep,
    video: showPreview ? previewVideo : (finalVideo || previewVideo),
    approvable: status === 'waiting' && !approvalBlocker,
    needsFinal: currentBriefStatus === 'approved' && !finalIsCurrent,
    briefPath: manifest.currentBrief,
    previewSha256: preview ? preview.sha256 || null : null,
  };
}

module.exports = { STATUS_ORDER, deriveVariantStatus, pluralEdits };
