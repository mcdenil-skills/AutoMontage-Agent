// scripts/lead-magnet/scaffold.js
const fs = require('node:fs');
const path = require('node:path');

const { slugifyProjectName } = require('../project/workspace');
const { resolveBrand } = require('./brand');
const { checkedFile } = require('./check');
const { readLeadMagnet, revisionDir } = require('./library');

const FONT_FORMATS = {
  '.woff2': ['font/woff2', 'woff2'], '.woff': ['font/woff', 'woff'], '.ttf': ['font/ttf', 'truetype'], '.otf': ['font/otf', 'opentype'],
};
const LABELS = {
  guide: 'Пошаговая инструкция по видео', prompts: 'Промпты из видео', checklist: 'Чек-лист по видео', cheatsheet: 'Шпаргалка по видео',
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function cssFontFamily(value) {
  // CSS escapes also keep a literal </style> out of the HTML parser.
  return `'${String(value).replace(/[^A-Za-z0-9 -]/gu, (character) => `\\${character.codePointAt(0).toString(16)} `)}'`;
}

// Имя файла шрифта до первого «-» или «_» – имя семейства: Oswald-Bold.ttf → Oswald.
function fontFaceCss(fontPaths) {
  return fontPaths.map((file) => {
    const extension = path.extname(file).toLowerCase();
    const [mime, format] = FONT_FORMATS[extension];
    const family = path.basename(file, extension).split(/[-_]/)[0];
    const data = fs.readFileSync(file).toString('base64');
    return `@font-face{font-family:'${family}';src:url(data:${mime};base64,${data}) format('${format}');font-weight:100 900;font-display:swap}`;
  }).join('\n');
}

function logoHtml(resolved) {
  if (!resolved.logoPath) return '';
  const mime = path.extname(resolved.logoPath).toLowerCase() === '.svg' ? 'image/svg+xml' : 'image/png';
  const data = fs.readFileSync(resolved.logoPath).toString('base64');
  return `<span class="lm-logo" data-lm="logo"><img src="data:${mime};base64,${data}" alt="${escapeHtml(resolved.brand.name)}"></span>`;
}

// Простые значки соцсетей (currentColor), чтобы страница оставалась самодостаточной.
const SOCIAL_ICONS = {
  telegram: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21.5 3.6 2.9 10.8c-1.3.5-1.3 1.3-.2 1.6l4.8 1.5 1.8 5.6c.2.6.4.8.9.8.4 0 .6-.2.9-.4l2.3-2.2 4.7 3.5c.9.5 1.5.2 1.7-.8l3.1-14.7c.3-1.3-.5-1.9-1.4-1.5ZM9.4 14.3l8.7-5.5c.4-.3.8-.1.5.2l-7.2 6.5-.3 3.1-1.7-4.3Z"/></svg>',
  instagram: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.3" cy="6.7" r="1.2" fill="currentColor"/></svg>',
  youtube: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="4" fill="currentColor"/><path d="M10 9v6l5-3-5-3Z" fill="var(--text)"/></svg>',
  vk: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="6" fill="currentColor"/><path d="M6.5 8.5h2.2c.1 2.9 1.4 4.1 2.4 4.4V8.5h2.1v2.5c1-.1 2-1.3 2.4-2.5h2.1c-.3 1.6-1.5 2.8-2.4 3.3.9.4 2.2 1.5 2.7 3.4h-2.3c-.5-1.5-1.6-2.6-2.5-2.7v2.7h-.3c-4.4 0-6.9-3-7-8Z" fill="var(--text)"/></svg>',
  site: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
};

function withUtm(rawUrl, utm) {
  if (!utm) return rawUrl;
  const url = new URL(rawUrl);
  for (const [key, value] of new URLSearchParams(utm.slice(1))) url.searchParams.set(key, value);
  return url.href;
}

function ctaHtml(brand, passport) {
  const call = passport.params.cta || { mode: 'brand' };
  const utm = brand.cta.utm ? brand.cta.utm.replace('{campaign}', slugifyProjectName(passport.codeWords[0])) : '';
  const button = (label, url) => `<a class="lm-cta__button" href="${escapeHtml(withUtm(url, utm))}">${escapeHtml(label)}</a>`;
  let head = '';
  if (call.mode === 'link') {
    head = `<h2>${escapeHtml(call.title)}</h2>\n<div class="lm-cta__buttons">${button(call.label, call.url)}</div>`;
  } else if (call.mode === 'brand') {
    const buttons = brand.cta.buttons.map((item) => button(item.label, item.url)).join('');
    head = `<h2>${escapeHtml(brand.cta.title)}</h2>\n${brand.cta.text ? `<p>${escapeHtml(brand.cta.text)}</p>` : ''}\n${buttons ? `<div class="lm-cta__buttons">${buttons}</div>` : ''}`;
  }
  const socials = brand.socials.map((item) => `<a class="lm-social" data-lm-social="${item.network}" href="${escapeHtml(item.url)}">${SOCIAL_ICONS[item.network]}<span>${escapeHtml(item.label)}</span></a>`).join('');
  const body = (head || socials) ? head : '<p>Сохраните страницу – она пригодится.</p>';
  return `<section class="lm-cta" data-lm-block="cta" data-lm="cta">
${body}
${socials ? `<nav class="lm-socials" aria-label="Соцсети">${socials}</nav>` : ''}
</section>`;
}

function unitsComment(units) {
  return units.map((unit) => `<!-- LM: ${unit.count ?? 'каждый'} × «${escapeHtml(unit.label)}» – каждый выданный пункт помечай атрибутом data-lm-item со значением «${unit.key}» -->`).join('\n');
}

const CODE = '<div class="lm-code" data-lm-code><pre data-lm-todo>Промпт или команда</pre><button type="button" data-lm-copy>Скопировать</button></div>';
const BODIES = {
  guide: () => `<section class="lm-card" data-lm-block="step-1">
<h2 data-lm-todo>Шаг 1. Название шага</h2>
<p class="lm-metaphor" data-lm-todo>Метафора из жизни: на что это похоже.</p>
<ol data-lm-todo><li>Что сделать</li></ol>
${CODE}
<label class="lm-check"><input type="checkbox" data-lm-step="step-1"> Сделал этот шаг</label>
</section>
<!-- LM: следующие шаги – копии step-1 с уникальными data-lm-block и data-lm-step -->`,
  prompts: () => `<section class="lm-card" data-lm-block="prompts">
<h2 data-lm-todo>Промпты</h2>
<h3 data-lm-todo>Для чего этот промпт</h3>
${CODE}
</section>
<!-- LM: каждый промпт – своя пара h3 + .lm-code -->`,
  checklist: () => `<section class="lm-card" data-lm-block="checklist">
<h2 data-lm-todo>Чек-лист</h2>
<ul class="lm-list">
<li><label class="lm-check"><input type="checkbox" data-lm-step="item-1"> <span data-lm-todo>Пункт чек-листа</span></label></li>
</ul>
</section>`,
  cheatsheet: () => `<section class="lm-card" data-lm-block="cheatsheet">
<h2 data-lm-todo>Шпаргалка</h2>
<div class="lm-grid">
<div class="lm-card"><h3 data-lm-todo>Тема</h3><p data-lm-todo>Коротко и по делу</p></div>
</div>
</section>`,
};

function pageCss({ tokens }) {
  const { colors: c, fonts: f } = tokens;
  return `:root{--bg:${c.background};--surface:${c.surface};--text:${c.text};--muted:${c.muted};--accent:${c.accent};--heading:${cssFontFamily(f.heading)},system-ui,sans-serif;--body:${cssFontFamily(f.body)},system-ui,sans-serif;--mono:${cssFontFamily(f.mono)},ui-monospace,Menlo,monospace}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 var(--body);overflow-wrap:anywhere}
.lm-page{max-width:760px;margin:0 auto;padding:24px 16px 56px}
.lm-hero{padding:8px 0 16px}
.lm-logo img{display:block;height:36px;width:auto;margin-bottom:16px}
.lm-label{margin:0 0 6px;color:var(--muted);font-size:14px}
h1,h2,h3{font-family:var(--heading);line-height:1.15;margin:0 0 10px}
h1{font-size:clamp(28px,7vw,44px)}
h2{font-size:clamp(21px,5vw,28px)}
.lm-promise{margin:0;color:var(--muted)}
.lm-card{margin:18px 0;padding:18px 16px;background:var(--surface);border:1px solid color-mix(in srgb,var(--muted) 28%,transparent);border-radius:14px}
.lm-metaphor{font-style:italic;color:var(--muted)}
.lm-code{position:relative;margin:12px 0;padding:14px 14px 52px;background:#17171a;color:#f3f3f3;border-radius:12px}
.lm-code pre{margin:0;white-space:pre-wrap;word-break:break-word;font:14px/1.55 var(--mono)}
[data-lm-copy]{position:absolute;right:10px;bottom:10px;padding:8px 12px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:600 14px var(--body);cursor:pointer}
.lm-check{display:flex;gap:8px;align-items:center;margin-top:10px}
.lm-check input{width:20px;height:20px;accent-color:var(--accent)}
.lm-list{margin:0;padding-left:20px}
.lm-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.lm-cta{margin-top:28px;padding:22px 16px;text-align:center;background:var(--text);color:var(--bg);border-radius:16px}
.lm-cta__buttons{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-top:14px}
.lm-cta__button{display:inline-block;padding:12px 16px;border-radius:10px;background:var(--accent);color:#fff;text-decoration:none;font-weight:600}
.lm-socials{display:flex;flex-wrap:wrap;gap:14px;justify-content:center;margin-top:18px}
.lm-social{display:inline-flex;gap:6px;align-items:center;color:var(--bg);text-decoration:none;font-weight:600}
.lm-social svg{width:22px;height:22px;flex:none}
img{max-width:100%;height:auto}
@media print{[data-lm-copy]{display:none}.lm-code{padding-bottom:14px}.lm-page{max-width:none}}`;
}

// Кнопки «Скопировать» и галочки шагов. Работает и в песочнице пульта, где нет localStorage:
// тогда галочки просто не запоминаются.
const PAGE_SCRIPT = `document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-lm-copy]');
  if (!button) return;
  const holder = button.closest('[data-lm-code]');
  const pre = holder && holder.querySelector('pre');
  if (!pre) return;
  const text = pre.innerText;
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {
    const area = document.createElement('textarea');
    area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.append(area); area.select();
    try { ok = document.execCommand('copy'); } catch (__) { ok = false; }
    area.remove();
  }
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.textContent = ok ? 'Скопировано ✓' : 'Выделите и скопируйте';
  setTimeout(() => { button.textContent = button.dataset.label; }, 1800);
});
const lmStore = (() => { try { localStorage.setItem('__lm', '1'); localStorage.removeItem('__lm'); return localStorage; } catch (_) { return null; } })();
document.querySelectorAll('input[type="checkbox"][data-lm-step]').forEach((box) => {
  const key = 'lm:' + location.pathname + ':' + box.dataset.lmStep;
  if (lmStore && lmStore.getItem(key) === '1') box.checked = true;
  box.addEventListener('change', () => { if (lmStore) lmStore.setItem(key, box.checked ? '1' : '0'); });
});`;

function scaffoldPage(passport, resolved) {
  const promise = passport.promise.quote
    ? `<p class="lm-promise">Обещал в ролике: «${escapeHtml(passport.promise.quote)}»</p>`
    : '';
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(passport.title)}</title>
<style>
${fontFaceCss(resolved.fontPaths)}
${pageCss(resolved.brand)}
</style>
</head>
<body>
<main class="lm-page">
<header class="lm-hero" data-lm-block="hero">
${logoHtml(resolved)}
<p class="lm-label">${LABELS[passport.params.format]}</p>
<h1>${escapeHtml(passport.title)}</h1>
${promise}
</header>
${unitsComment(passport.units)}
${BODIES[passport.params.format]()}
${ctaHtml(resolved.brand, passport)}
</main>
<script>${PAGE_SCRIPT}</script>
</body>
</html>
`;
}

function contentSkeleton(passport) {
  return [
    `# ${passport.title}`,
    '',
    passport.promise.quote ? `Обещание (дословно): «${passport.promise.quote}»` : 'Обещания в ролике нет.',
    '',
    '## Что выдаём',
    ...passport.units.map((unit) => `- ${unit.count ?? 'каждый'} × ${unit.label} (data-lm-item «${unit.key}»)`),
    '',
    '## Разделы',
    '',
    '<!-- Сначала план здесь, потом страница. Каждый факт со ссылкой – в facts.json. -->',
    '',
  ].join('\n');
}

function writeScaffold(projectsDir, id, n, { env = process.env, force = false } = {}) {
  const passport = readLeadMagnet(projectsDir, id);
  const revision = passport.revisions.find((item) => item.n === n);
  if (!revision || revision.status !== 'building') throw new Error(`ревизия ${n} не собирается сейчас`);
  const resolved = resolveBrand({ env });
  const dir = revisionDir(projectsDir, id, n);
  const written = [];
  for (const [file, text] of [['page.html', scaffoldPage(passport, resolved)], ['content.md', contentSkeleton(passport)]]) {
    const target = checkedFile(projectsDir, dir, file);
    if (fs.existsSync(target) && !force) continue;
    fs.writeFileSync(target, text, { mode: 0o644 });
    written.push(file);
  }
  return written;
}

module.exports = { scaffoldPage, writeScaffold };
