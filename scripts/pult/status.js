const { activeRoughCut } = require('../project/rough-cut-model');

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
// roughCutExists – файл копии активной черновой нарезки лежит на диске: без него этап для
// пульта не активен (показывать и подтверждать нечего).
function deriveVariantStatus({
  manifest,
  currentBriefStatus,
  currentBriefSha256,
  finalExists,
  pendingComments = 0,
  approvalBlocker = null,
  roughCutExists = false,
}) {
  const roughCut = roughCutExists ? activeRoughCut(manifest) : null;
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

  // Порядок проверок: новые правки, черновая нарезка (ждёт автора или подтверждена),
  // затем прежняя логика preview и финала.
  let status;
  let nextStep;
  if (pendingComments > 0) {
    status = 'working';
    nextStep = `Ждёт агента: ${pluralEdits(pendingComments)}`;
  } else if (roughCut && roughCut.status === 'review') {
    status = 'waiting';
    nextStep = 'Черновая нарезка – посмотрите и отметьте оговорки';
  } else if (roughCut) {
    status = 'working';
    nextStep = 'Нарезка подтверждена – агент собирает слой';
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
  // Пока этап нарезки активен, утверждённый brief прежнего монтажа финала не ждёт: идёт новый монтаж.
  const needsFinal = !roughCut && currentBriefStatus === 'approved' && !finalIsCurrent;
  // Активная нарезка остаётся на экране и с новыми правками: они оставлены именно к ней.
  // Пока агент собирает финал утверждённой версии, финал на диске (если он есть) относится
  // к прежней версии: показываем утверждённый preview, чтобы новые правки цеплялись к нему.
  let video;
  if (roughCut) {
    video = { kind: 'roughcut', path: roughCut.filePath, sha256: roughCut.sha256 };
  } else {
    video = (showPreview || (needsFinal && previewVideo)) ? previewVideo : (finalVideo || previewVideo);
  }
  return {
    status,
    nextStep,
    video,
    // Утвердить можно только preview: черновую нарезку подтверждают отдельной кнопкой.
    approvable: status === 'waiting' && !approvalBlocker && video?.kind === 'preview',
    needsFinal,
    briefPath: manifest.currentBrief,
    previewSha256: preview ? preview.sha256 || null : null,
    // confirmedAt – ISO-время подтверждения (только у confirmed): по нему блок нарезки рисует
    // отметку «Нарезка подтверждена в …», пока агент не собрал master.
    roughCut: roughCut ? {
      editPath: roughCut.editPath,
      sha256: roughCut.sha256,
      status: roughCut.status,
      confirmedAt: roughCut.status === 'confirmed' ? roughCut.confirmedAt || null : null,
    } : null,
    // Подтвердить нарезку можно, пока она ждёт автора, даже если к ней уже есть новые правки.
    roughCutConfirmable: Boolean(roughCut && roughCut.status === 'review'),
  };
}

module.exports = { STATUS_ORDER, deriveVariantStatus, pluralEdits };
