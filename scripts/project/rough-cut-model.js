// Модель черновой нарезки: чистые функции без чтения диска и без workspace.js
// (workspace.js сам подключает эту модель, обратная связь дала бы цикл require).
// Нарезка – обычный source-edit `edit/roughcut-vNN.json` плюс копия `previews/roughcut-vNN.mp4`
// с тем же NN; запись о ней хранится в `project.json.roughCut`.
const ROUGH_CUT_EDIT = /^edit\/roughcut-v(\d{2,3})\.json$/;
const ROUGH_CUT_VIDEO = /^previews\/roughcut-v(\d{2,3})\.mp4$/;
const SHORT_SIDE = 720;
// Действия, которые охраняет assertRoughCutSettled: опечатка в имени не должна тихо снимать охрану.
const GUARDED_ACTIONS = ['master', 'layer new'];
// Вырез не длиннее миллисекунды – погрешность округления, а не решение автора.
const MIN_REMOVED_SEC = 0.001;

function rounded(value) {
  return Number(value.toFixed(3));
}

function roughCutPaths(editRelative) {
  const match = ROUGH_CUT_EDIT.exec(String(editRelative));
  if (!match) throw new Error('черновая нарезка: имя списка кусков – edit/roughcut-vNN.json');
  return {
    editPath: editRelative,
    filePath: `previews/roughcut-v${match[1]}.mp4`,
    version: Number(match[1]),
  };
}

function editPathForRoughCutVideo(videoPath) {
  const match = ROUGH_CUT_VIDEO.exec(String(videoPath));
  return match ? `edit/roughcut-v${match[1]}.json` : null;
}

// Секунда нарезки → секунда исходника. На стыке берём конец левого куска, за концом – конец последнего.
function roughCutTimeToSource(keep, timeSec) {
  const target = Math.max(0, timeSec);
  let passed = 0;
  for (const piece of keep) {
    const length = piece.end - piece.start;
    if (target <= passed + length) return piece.start + (target - passed);
    passed += length;
  }
  return keep[keep.length - 1].end;
}

// Что автор не увидит в нарезке: голова до первого куска, стыки между кусками и хвост.
// `atSec` – место стыка в нарезке, `note` – причина из следующего куска (у хвоста её нет).
// С `fps` вырез короче кадра не считается: контейнер часто длиннее последнего кадра, и список,
// оставленный до последнего кадра, иначе показал бы хвост «вырезано 0,0 с».
function removedRanges(keep, sourceDuration, { fps } = {}) {
  const frameFps = typeof fps === 'number' && Number.isFinite(fps) && fps > 0;
  const ranges = [];
  const add = (atSec, sourceStart, sourceEnd, note) => {
    const length = sourceEnd - sourceStart;
    if (frameFps ? length < 1 / fps - 1e-6 : length <= MIN_REMOVED_SEC) return;
    ranges.push({
      atSec: rounded(atSec),
      sourceStart: rounded(sourceStart),
      sourceEnd: rounded(sourceEnd),
      removedSec: rounded(sourceEnd - sourceStart),
      note: note ?? null,
    });
  };
  let kept = 0;
  let previousEnd = 0;
  for (const piece of keep) {
    add(kept, previousEnd, piece.start, piece.note);
    kept += piece.end - piece.start;
    previousEnd = piece.end;
  }
  add(kept, previousEnd, sourceDuration, null);
  return ranges;
}

// Вход – уже рабочий размер 1080p (с учётом поворота и пикселей): короткая сторона 720,
// без увеличения, стороны чётные (как у workingSize).
function roughCutSize({ width, height }) {
  for (const side of [width, height]) {
    if (typeof side !== 'number' || !Number.isFinite(side) || side <= 0) {
      throw new Error('размер кадра должен состоять из положительных чисел');
    }
  }
  const k = Math.min(1, SHORT_SIDE / Math.min(width, height));
  const even = (side) => (k < 1 ? Math.round((side * k) / 2) * 2 : Math.floor(side / 2) * 2);
  return { width: even(width), height: even(height) };
}

// Этап активен, пока нарезка относится к текущей ревизии исходника: первый же master
// поднимает ревизию, и запись становится историей.
function activeRoughCut(manifest) {
  const record = manifest.roughCut;
  if (!record) return null;
  return record.sourceRevision === (manifest.source?.revision ?? 1) ? record : null;
}

function pendingError(message) {
  const error = new Error(message);
  error.code = 'ROUGH_CUT_PENDING';
  return error;
}

// Охрана для master и `layer new`: пока нарезка ждёт автора, слой строить рано; после
// подтверждения master собирается из нарезки (или списка с правками), а слой – только после него.
function assertRoughCutSettled(manifest, action, { projectDir }) {
  if (!GUARDED_ACTIONS.includes(action)) {
    throw new Error(`assertRoughCutSettled: неизвестное действие ${JSON.stringify(action)} – ожидается master или layer new`);
  }
  const record = activeRoughCut(manifest);
  if (!record) return;
  if (record.status === 'review') {
    throw pendingError(`черновая нарезка ${record.filePath} ждёт автора: подтверждает только автор – кнопкой «Нарезка готова» в пульте или явными словами в чате. Сам не подтверждай.`);
  }
  if (action === 'layer new') {
    throw pendingError(`нарезка подтверждена, но master по ней ещё не собран: automontage master --project-dir "${projectDir}" --edit ${record.editPath} (или ваш список с правками автора к этой нарезке)`);
  }
}

module.exports = {
  ROUGH_CUT_EDIT,
  activeRoughCut,
  assertRoughCutSettled,
  editPathForRoughCutVideo,
  removedRanges,
  roughCutPaths,
  roughCutSize,
  roughCutTimeToSource,
};
