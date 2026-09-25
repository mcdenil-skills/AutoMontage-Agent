const { STATUS_ORDER } = require('./status');

// Утверждение возвращает карточку из архива (см. server.js, DECISIONS.md D-030), но
// пользователь может убрать её в архив уже ПОСЛЕ утверждения – обратный порядок действий, а
// approveBrief можно вызвать и не через кнопку пульта (Review Workbench, CLI-утверждение в
// чате), тогда карточка вообще не возвращается из архива автоматически. Тогда обычная надпись
// status.js «Утверждено – агент собирает финал» вводила бы в заблуждение: выглядит так, будто
// агент уже занят, хотя по правилу AGENTS.md он ждёт отдельной просьбы. Текст определён ровно
// в одном месте – здесь.
const ARCHIVED_NEEDS_FINAL_NEXT_STEP = 'Утверждено, в архиве – агент соберёт финал по вашей просьбе';

function cardIdFor(entry) {
  return entry.group ? `group:${entry.group.id}` : `folder:${entry.folder}`;
}

// Копия варианта архивной карточки с утверждённым brief без финала. archivedNeedsFinal –
// то же условие, по которому `automontage inbox` помечает утверждение «в архиве»
// (scripts/pult/inbox.js: archivedIds.has(cardIdFor(entry)) при entry.needsFinal, без оглядки
// на новые правки): подпись плеера должна оставаться честной даже тогда, когда по ролику уже
// ждёт новая правка. nextStep карточки при этом меняем только без невыполненных правок –
// «Ждёт агента: …» – это новая работа автора, и архивная надпись про финал не должна её
// заслонять. Никогда не меняет entry из scan – его читают и другие карточки той же папки.
function archivedVariant(variant, archived) {
  const archivedNeedsFinal = archived && Boolean(variant.needsFinal);
  if (!archivedNeedsFinal) return variant;
  return {
    ...variant,
    archivedNeedsFinal: true,
    nextStep: variant.pendingComments ? variant.nextStep : ARCHIVED_NEEDS_FINAL_NEXT_STEP,
  };
}

function byUrgency(left, right) {
  return STATUS_ORDER[left.status] - STATUS_ORDER[right.status]
    || right.updatedAt.localeCompare(left.updatedAt);
}

function buildCards(scan, { archived = [] } = {}) {
  const archivedIds = new Set(archived);
  const groups = new Map();
  for (const entry of scan.entries) {
    const id = cardIdFor(entry);
    if (!groups.has(id)) groups.set(id, []);
    // Переопределение – до сборки карточки: nextStep карточки (ниже) читает его прямо из
    // lead.nextStep, поэтому честная надпись должна попасть в variants раньше, чем прочитается.
    groups.get(id).push(archivedVariant(entry, archivedIds.has(id)));
  }
  const cards = [...groups].map(([id, variants]) => {
    const status = variants
      .map((variant) => variant.status)
      .sort((left, right) => STATUS_ORDER[left] - STATUS_ORDER[right])[0];
    const lead = variants.find((variant) => variant.status === status);
    return {
      id,
      title: variants[0].group ? variants[0].group.title : variants[0].title,
      status,
      nextStep: variants.length > 1 ? `${lead.variantLabel}: ${lead.nextStep}` : lead.nextStep,
      // Ключ самого срочного варианта – по нему UI (Task 15) открывает вкладку и берёт
      // факты для лица карточки. Порядок variants при этом не трогаем – это порядок вкладок.
      leadKey: lead.key,
      updatedAt: variants.map((variant) => variant.updatedAt).sort().at(-1),
      archived: archivedIds.has(id),
      variants,
    };
  });
  const active = cards.filter((card) => !card.archived).sort(byUrgency);
  return {
    waiting: active.filter((card) => card.status === 'waiting'),
    working: active.filter((card) => card.status === 'working'),
    ready: active.filter((card) => card.status === 'ready'),
    archive: cards.filter((card) => card.archived).sort(byUrgency),
    unregistered: scan.unregistered,
    broken: scan.broken,
  };
}

module.exports = { buildCards, cardIdFor };
