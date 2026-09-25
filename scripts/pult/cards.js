const { STATUS_ORDER } = require('./status');

function cardIdFor(entry) {
  return entry.group ? `group:${entry.group.id}` : `folder:${entry.folder}`;
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
    groups.get(id).push(entry);
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
