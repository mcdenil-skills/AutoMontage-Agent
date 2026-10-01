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

test('scaffold only fills a revision that is being built', (t) => {
  const { projectsDir, id } = makeLeadMagnet(t);
  assert.throws(() => writeScaffold(projectsDir, id, 1, { env: {} }), /не собирается/);
});
