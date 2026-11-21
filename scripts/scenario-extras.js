// Поля монтажного листа (--scenario), которые build.js переносит в props кроме blocks/beat:
// audio (фоновая музыка) и theme. Раньше оба молча терялись (PR #14): музыка не подмешивалась,
// тема бралась только из флага --theme. Флаг --theme по-прежнему важнее темы листа.
function scenarioExtras(scenario, { themeFlag, resolveTheme }) {
  const sc = scenario && typeof scenario === 'object' ? scenario : {};
  const audio = sc.audio != null ? sc.audio : null;
  let theme = null;
  if (sc.theme != null && !themeFlag) theme = typeof sc.theme === 'string' ? resolveTheme(sc.theme) : sc.theme;
  return { audio, theme };
}

module.exports = { scenarioExtras };
