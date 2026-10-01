const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const library = require('../scripts/lead-magnet/library');
const { writeScaffold } = require('../scripts/lead-magnet/scaffold');
const { QUOTE, makeLeadMagnet } = require('./helpers/lead-magnet-fixtures');

function pack(t, overrides = {}) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-scaffold-pack-')), 'lead-magnet');
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'fonts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  fs.writeFileSync(path.join(dir, 'fonts', 'Oswald-Bold.ttf'), Buffer.from('fake-font'));
  const neutral = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', 'lead-magnet', 'neutral', 'brand.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'brand.json'), JSON.stringify({
    ...neutral,
    name: 'Мой бренд',
    socials: ['telegram', 'instagram', 'youtube'].map((network) => ({ network, label: network, url: `https://${network}.com/example` })),
    logoRequired: true,
    logo: 'logo.svg',
    tokens: { ...neutral.tokens, fonts: { heading: 'Oswald', body: 'Onest', mono: 'JetBrains Mono' } },
    fontFiles: ['fonts/Oswald-Bold.ttf'],
    cta: { title: 'Первая анимация готова?', text: 'Дальше – практикум.', buttons: [{ label: 'Практикум', url: 'https://example.com/practicum' }], utm: '?utm_source=youtube&utm_campaign={campaign}' },
    ...overrides,
  }));
  return dir;
}

test('a neutral scaffold has the promise, a CTA, todo markers and nothing external', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const { n, dir } = library.startRevision(projectsDir, id);
  assert.deepEqual(writeScaffold(projectsDir, id, n, { env: {} }), ['page.html', 'content.md']);
  const html = fs.readFileSync(path.join(dir, 'page.html'), 'utf8');
  assert.ok(html.includes(`«${QUOTE}»`));
  assert.match(html, /data-lm="cta"/);
  assert.match(html, /data-lm-todo/);
  assert.match(html, /data-lm-copy/);
  assert.doesNotMatch(html, /data-lm-item=/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /data-lm="logo"/);
  assert.doesNotMatch(html.toLowerCase(), /лид-магнит/);
  assert.match(fs.readFileSync(path.join(dir, 'content.md'), 'utf8'), /Обещание \(дословно\)/);
  assert.deepEqual(writeScaffold(projectsDir, id, n, { env: {} }), [], 'существующие файлы не перезаписываются');
});

test('a brand pack scaffold embeds the logo, the fonts and CTA links with UTM', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const { n, dir } = library.startRevision(projectsDir, id);
  writeScaffold(projectsDir, id, n, { env: { LEAD_MAGNET_BRAND: pack(t) } });
  const html = fs.readFileSync(path.join(dir, 'page.html'), 'utf8');
  assert.match(html, /data-lm="logo"/);
  assert.match(html, /src="data:image\/svg\+xml;base64,/);
  assert.match(html, /font-family:'Oswald';src:url\(data:font\/ttf;base64,/);
  assert.ok(html.includes('href="https://example.com/practicum?utm_source=youtube&amp;utm_campaign=gayd"'));
  assert.match(html, /Первая анимация готова\?/);
});

test('brand CTA keeps existing query parameters and fragments when adding UTM', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const { n, dir } = library.startRevision(projectsDir, id);
  const brandDir = pack(t, { cta: {
    title: 'Дальше', text: '', utm: '?utm_source=youtube&utm_campaign={campaign}',
    buttons: [
      { label: 'С query', url: 'https://example.com/practicum?ref=video' },
      { label: 'С fragment', url: 'https://example.com/practicum?ref=video#start' },
    ],
  } });
  writeScaffold(projectsDir, id, n, { env: { LEAD_MAGNET_BRAND: brandDir } });
  const html = fs.readFileSync(path.join(dir, 'page.html'), 'utf8');
  assert.match(html, /href="https:\/\/example\.com\/practicum\?ref=video&amp;utm_source=youtube&amp;utm_campaign=gayd"/);
  assert.match(html, /href="https:\/\/example\.com\/practicum\?ref=video&amp;utm_source=youtube&amp;utm_campaign=gayd#start"/);
});

test('font family markup is inert while a normal multiword family remains usable', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const { n, dir } = library.startRevision(projectsDir, id);
  const injection = '</style><script id="font-attack">window.fontAttack=1</script><style>';
  const brandDir = pack(t, { tokens: {
    colors: { background: '#F7F5F0', surface: '#FFFFFF', text: '#1C1C1E', muted: '#6B6B70', accent: '#2F6FEB' },
    fonts: { heading: injection, body: 'JetBrains Mono', mono: 'JetBrains Mono' },
  } });
  writeScaffold(projectsDir, id, n, { env: { LEAD_MAGNET_BRAND: brandDir } });
  const html = fs.readFileSync(path.join(dir, 'page.html'), 'utf8');
  assert.doesNotMatch(html, /<script id="font-attack">/);
  assert.match(html, /--body:'JetBrains Mono'/);
  assert.equal((html.match(/<\/style>/g) || []).length, 1);
});

test('unit label cannot escape the instruction comment; ordinary labels remain readable', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  const passport = library.readLeadMagnet(projectsDir, id);
  const injection = '--><script id="unit-attack">window.unitAttack=1</script><!--';
  library.savePassport(projectsDir, { ...passport, units: [
    { ...passport.units[0], label: injection },
    { ...passport.units[1], label: 'пять промптов' },
  ] }, () => new Date());
  const { n, dir } = library.startRevision(projectsDir, id);
  writeScaffold(projectsDir, id, n, { env: {} });
  const html = fs.readFileSync(path.join(dir, 'page.html'), 'utf8');
  assert.doesNotMatch(html, /<script id="unit-attack">/);
  assert.match(html, /пять промптов/);
  assert.equal((html.match(/<!-- LM:/g) || []).length, 3);
});

test('scaffold only fills a revision that is being built', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  assert.throws(() => writeScaffold(projectsDir, id, 1, { env: {} }), /не собирается/);
});

function scaffoldWith(t, cta, env) {
  const { projectsDir, id } = makeLeadMagnet(t);
  const passport = library.readLeadMagnet(projectsDir, id);
  library.savePassport(projectsDir, { ...passport, params: { ...passport.params, ...(cta ? { cta } : {}) } }, () => new Date());
  const { n, dir } = library.startRevision(projectsDir, id);
  writeScaffold(projectsDir, id, n, { env });
  return fs.readFileSync(path.join(dir, 'page.html'), 'utf8');
}

test('socials from the brand pack are always at the bottom, with icons', (t) => {
  const env = { LEAD_MAGNET_BRAND: pack(t) };
  for (const cta of [undefined, { mode: 'brand', title: '', label: '', url: '' }, { mode: 'none', title: '', label: '', url: '' }, { mode: 'link', title: 'Дальше', label: 'Кнопка', url: 'https://example.com' }]) {
    const html = scaffoldWith(t, cta, env);
    for (const network of ['telegram', 'instagram', 'youtube']) assert.match(html, new RegExp(`data-lm-social="${network}"[^>]*><svg`));
    assert.match(html, /data-lm="cta"/);
  }
});

test('the main call follows the chosen mode', (t) => {
  const env = { LEAD_MAGNET_BRAND: pack(t) };
  const link = scaffoldWith(t, { mode: 'link', title: 'Хочешь собрать проект с нуля?', label: 'Бесплатный практикум', url: 'https://example.com/p' }, env);
  assert.ok(link.includes('href="https://example.com/p?utm_source=youtube&amp;utm_campaign=gayd"'));
  assert.match(link, /Хочешь собрать проект с нуля\?/);
  assert.match(scaffoldWith(t, undefined, env), /Практикум/, 'brand: кнопка бренд-пака');
  assert.doesNotMatch(scaffoldWith(t, { mode: 'none', title: '', label: '', url: '' }, env), /class="lm-cta__button"/);
});

test('custom call preserves query and fragments, escapes labels and keeps socials without UTM', (t) => {
  const html = scaffoldWith(t, { mode: 'link', title: '<script>bad()</script>', label: '<b>Открыть</b>', url: 'https://example.com/p?ref=video&utm_source=old#start' }, { LEAD_MAGNET_BRAND: pack(t) });
  assert.ok(html.includes('href="https://example.com/p?ref=video&amp;utm_source=youtube&amp;utm_campaign=gayd#start"'));
  assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt;'));
  assert.ok(html.includes('&lt;b&gt;Открыть&lt;/b&gt;'));
  assert.match(html, /data-lm-social="telegram" href="https:\/\/telegram.com\/example"/);
  assert.doesNotMatch(html, /<script>bad/);
});
