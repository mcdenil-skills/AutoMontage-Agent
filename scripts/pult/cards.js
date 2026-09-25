const { STATUS_ORDER } = require('./status');

// Утверждение возвращает карточку из архива (Task A этой доводки, см. server.js и
// DECISIONS.md D-030), но пользователь может убрать её в архив уже ПОСЛЕ утверждения –
// обратный порядок действий. Тогда обычная надпись status.js «Утверждено – агент собирает
// финал» вводила бы в заблуждение: выглядит так, будто агент уже занят, хотя по правилу
// AGENTS.md он ждёт отдельной просьбы. Текст определён ровно в одном месте – здесь.
const ARCHIVED_NEEDS_FINAL_NEXT_STEP = 'Утверждено, в архиве – агент соберёт финал по вашей просьбе';

function cardIdFor(entry) {
  return entry.group ? `group:${entry.group.id}` : `folder:${entry.folder}`;
}

// Структурное условие вместо сравнения со строкой APPROVED_NEXT_STEP: needsFinal у status.js
// не зависит от новых правок, а невыполненная правка должна оставить «Ждёт агента: …» –
// это именно та ветка status.js, где nextStep становится APPROVED_NEXT_STEP.
function isApprovedWaitingForFinal(variant) {
  return Boolean(variant.needsFinal) && !variant.pendingComments;
}

// Копия варианта с честной надписью, если карточка архивная и вариант ждёт финала без новых
// правок; никогда не меняет entry из scan – его читают и другие карточки той же папки.
function archivedVariant(variant, archived) {
  if (!archived || !isApprovedWaitingForFinal(variant)) return variant;
  return { ...variant, nextStep: ARCHIVED_NEEDS_FINAL_NEXT_STEP, archivedNeedsFinal: true };
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

module.exports = { ARCHIVED_NEEDS_FINAL_NEXT_STEP, buildCards, cardIdFor };
