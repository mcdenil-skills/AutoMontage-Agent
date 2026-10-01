# Лид-магнит к ролику – этап 1: общий план

> **For agentic workers:** это карта этапа, а не исполняемый план. Исполняемые планы – по частям
> ниже; каждую часть выполняй через superpowers:subagent-driven-development или
> superpowers:executing-plans.

**Спецификация:** [../specs/2026-09-30-lead-magnet-design.md](../specs/2026-09-30-lead-magnet-design.md)
(утверждена 2026-09-30). **Задача:** [#63](https://github.com/mcdenil-skills/AutoMontage-Agent/issues/63).
**Цель релиза:** 1.11.0.

## Почему три части

Этап 1 – это три подсистемы с разными проверками. Каждая часть даёт работающий и проверяемый результат
сама по себе, а следующая опирается на уже выпущенный код предыдущей, а не на догадки.

| Часть | Что даёт | Проверка | План |
|---|---|---|---|
| **1A – данные и команды движка** | схемы, обещания, запросы, библиотека, референсы, правки, бренд-пак, проверка каркаса и фактов, утверждение (функция), статусы, воронка (чтение), входящие, CLI `automontage lead-magnet` | `node --test`, реальный Chromium для `check` | [2026-09-30-lead-magnet-1a-core.md](2026-09-30-lead-magnet-1a-core.md) |
| **1B – пульт** | метка и плашка, окно параметров, загрузка референсов, вкладка «Лид-магнит», песочница просмотра, режим правок, «Утверждаю», блок «Файлы» и «Воронка» | `node --test` для сервера, Playwright `pult-ui` для экранов | пишется после слияния 1A |
| **1C – навык агента и шаблоны** | навык `skills/lead-magnet/` (Claude Code и Codex), нейтральная тема и скелеты 4 форматов, инструкции поставщика воронок Chatplace (MCP, только чтение), документ `docs/LEAD-MAGNET.md` целиком | тест правил навыка + живой прогон на ролике | пишется после слияния 1A (может идти параллельно с 1B) |

## Договорённости между частями (контракт 1A)

Части 1B и 1C пользуются только этими функциями и файлами. Меняются они только через 1A.

- **Файлы ролика:** `lead-magnet/offers.json` (пишет агент через CLI), `pult/lead-magnet.json`
  (решения пульта), `pult/lead-magnet-refs/<sha256>.<ext>` (референсы).
- **Библиотека:** `projects/.lead-magnets/<YYYY.MM.DD_slug>/` с `lead-magnet.json`, `vNN/`,
  `funnel.json`, `pult/comments.json`, `pult/frames/`.
- **Модули `scripts/lead-magnet/`:**
  - `offers`: `readOffers`, `addOffer`;
  - `requests`: `readDecisions`, `addDecision`, `acceptDecision`, `offerStates`;
  - `references`: `storeReference`, `normalizeReferenceUrl`, `REFERENCE_LIMITS`;
  - `library`: `createLeadMagnet`, `readLeadMagnet`, `listLeadMagnets`, `findByCodeWord`,
    `linkVideo`, `startRevision`, `publishRevision`, `acknowledgePromise`, `updatePromise`,
    `revisionDir`;
  - `comments`: `addLeadMagnetComment`, `readLeadMagnetComments`, `deleteLeadMagnetComment`,
    `acceptLeadMagnetComment`;
  - `brand`: `resolveBrand`, `defaultTake`;
  - `check`: `checkRevision`;
  - `approve`: `approveLeadMagnet` – вызывает **только** сервер пульта;
  - `status`: `deriveLeadMagnetStatus`;
  - `funnel`: `readFunnelState`, `setFunnelState`;
  - `inbox`: `buildLeadMagnetInbox`, `formatLeadMagnetInbox`.
- **Разметка страницы для `check`:**
  - `data-lm-block="<id>"` у каждого раздела;
  - `data-lm="cta"` у блока призыва в конце;
  - `data-lm="logo"` у логотипа;
  - `data-lm-code` с кнопкой `data-lm-copy` вокруг каждого `<pre>`;
  - `data-lm-item="<ключ единицы>"` у каждой выданной единицы обещания.

## Порядок и Issue

1. Перед стартом 1A перевести #63 в «В работе» на доске.
2. 1A → PR → зелёный CI → слияние (без релиза).
3. Написать план 1B по `superpowers:writing-plans`, затем выполнить; параллельно – план и выполнение 1C.
4. После слияния 1B и 1C: живой прогон на реальном ролике, `CHANGELOG` → релиз 1.11.0, #63 → «Проверка»,
   после проверки владельцем – «Выпущено» и закрыть.
