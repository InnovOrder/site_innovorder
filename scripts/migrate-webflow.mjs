#!/usr/bin/env node
/**
 * Convertit le site Webflow publié (aspiré par scripts/crawl-live.mjs) en projet Astro.
 *
 * Usage :
 *   node scripts/crawl-live.mjs          # 1. aspire le site en ligne dans .cache/live
 *   node scripts/migrate-webflow.mjs     # 2. génère src/pages, les composants et public/assets
 *
 * Ce que fait le script :
 *  - convertit chaque page publiée en page Astro (src/pages/**) avec la même URL ;
 *  - extrait les métadonnées SEO (title, description, Open Graph, robots…) en props du layout ;
 *  - factorise la navbar, le footer et le code commun (head + fin de body) en composants ;
 *  - rapatrie les assets du CDN Webflow dans public/assets et réécrit leurs URLs ;
 *  - génère la table des redirections relevées sur le site en ligne (src/redirects.json).
 *
 * Les pages générées écrasent les existantes : une fois que l'équipe édite le code dans ce dépôt,
 * celui-ci devient la source de vérité et la migration ne doit plus être relancée.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'htmlparser2';
import render from 'dom-serializer';
import * as du from 'domutils';
import { Text, cloneNode } from 'domhandler';
import { induce, bindAttributes } from './lib/induce.mjs';
import { removeWeglot, align, buildMemory, translatePage, loadDictionary, loadGlossary, looksFrench, isEnRoute } from './lib/i18n.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = path.join(ROOT, '.cache', 'live');
const ASSETS_URL = '/assets';

// Pages publiées qui ne deviennent pas des routes : fonctionnalités propres à Webflow
// (e-commerce, recherche) qui ne fonctionnent pas hors de Webflow.
const EXCLUDED = new Set(['/search', '/checkout', '/paypal-checkout', '/order-confirmation', '/en/search', '/en/checkout', '/en/paypal-checkout', '/en/order-confirmation']);
// Un nœud présent dans au moins cette proportion de pages est considéré comme global au site.
const GLOBAL_THRESHOLD = 0.9;
const ASSET_HOSTS = /^https:\/\/(cdn\.prod\.website-files\.com|uploads-ssl\.webflow\.com|assets-global\.website-files\.com|assets\.website-files\.com|global-uploads\.webflow\.com|d3e54v103j8qbb\.cloudfront\.net)\//;

const PARSE_OPTS = { decodeEntities: true, lowerCaseAttributeNames: false, lowerCaseTags: false, recognizeSelfClosing: true };
const RENDER_OPTS = { encodeEntities: 'utf8', decodeEntities: true };

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(LIVE, f), 'utf8'));
const livePages = readJson('pages.json');
const assetManifest = readJson('assets.json');
const liveRedirects = readJson('redirects.json');

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

const usedAssets = new Set();

/** URL publique locale d'un asset du CDN Webflow. */
function assetUrl(cdnUrl) {
  const clean = cdnUrl.replace(/&amp;/g, '&').split('#')[0];
  const rel = assetManifest[clean] ?? assetManifest[clean.split('?')[0]];
  if (!rel) return null;
  usedAssets.add(rel);
  // Noms de fichiers normalisés en NFC : git (macOS) et les serveurs statiques comparent les octets,
  // un « é » décomposé (NFD) dans l'URL ne trouverait pas le fichier.
  return `${ASSETS_URL}/${rel.normalize('NFC').split('/').map(encodeURIComponent).join('/')}`;
}

function resolveUrl(url) {
  const raw = url.trim();
  if (!raw) return url;
  if (ASSET_HOSTS.test(raw)) return assetUrl(raw) ?? url;
  if (/^https?:\/\/(www\.)?innovorder\.com(\/|$|\?|#)/i.test(raw)) {
    const p = raw.replace(/^https?:\/\/(www\.)?innovorder\.com/i, '');
    return p === '' || p.startsWith('?') || p.startsWith('#') ? `/${p}` : p;
  }
  return url;
}

const rewriteList = (value) =>
  value
    .split(',')
    .map((part) => part.replace(/^(\s*)(\S+)/, (_, ws, u) => ws + resolveUrl(u)))
    .join(',');

const rewriteCssUrls = (value) =>
  value.replace(/url\((['"]?)(.+?)\1\)/g, (_, q, u) => `url(${q}${resolveUrl(u)}${q})`);

function rewriteAttributes(nodes) {
  for (const el of du.findAll(() => true, nodes)) {
    // Les alternates hreflang doivent rester des URLs absolues.
    if (el.name === 'link' && el.attribs.rel === 'alternate') continue;
    for (const [name, value] of Object.entries(el.attribs)) {
      if (['srcset', 'data-video-urls', 'sizes-srcset'].includes(name)) el.attribs[name] = rewriteList(value);
      else if (name === 'style') el.attribs[name] = rewriteCssUrls(value);
      else if (/^https?:\/\//.test(value.trim())) el.attribs[name] = resolveUrl(value);
    }
  }
  for (const el of du.findAll((e) => e.name === 'style', nodes)) {
    for (const t of el.children) if (t.type === 'text') t.data = rewriteCssUrls(t.data);
  }
}

// ---------------------------------------------------------------------------
// Sérialisation Astro
// ---------------------------------------------------------------------------

// Comme l'export Webflow, on ne passe à la ligne qu'entre éléments de bloc :
// les espaces ajoutés ne changent donc pas le rendu.
const BLOCK = new Set(
  'html head body div section nav header footer main article aside form fieldset ul ol li dl dt dd table thead tbody tfoot tr td th figure figcaption h1 h2 h3 h4 h5 h6 p blockquote noscript iframe video picture select option meta link title script style template'.split(' '),
);
const PRESERVE = new Set(['pre', 'textarea', 'script', 'style', 'svg', 'code']);

function indentTree(el, depth) {
  if (!el.children?.length || PRESERVE.has(el.name)) return;
  const kids = el.children;
  const hasText = kids.some((n) => n.type === 'text' && n.data.trim());
  const hasBlock = kids.some((n) => n.type !== 'text' && (BLOCK.has(n.name) || n.type === 'comment'));
  if (!hasText && hasBlock) {
    const pad = '\n' + '  '.repeat(depth + 1);
    const out = [];
    for (const n of kids) {
      if (n.type === 'text' && !n.raw) continue;
      out.push(new Text(pad), n);
    }
    out.push(new Text('\n' + '  '.repeat(depth)));
    el.children = out;
    out.forEach((n, i) => {
      n.parent = el;
      n.prev = out[i - 1] ?? null;
      n.next = out[i + 1] ?? null;
    });
  }
  for (const n of el.children) if (n.type !== 'text') indentTree(n, depth + 1);
}

/** Sérialise des nœuds en markup Astro valide. */
function toAstro(nodes, indent = '', { format = true } = {}) {
  const prepare = (list) => {
    for (const n of list) {
      if (n.type === 'script' || n.type === 'style') {
        n.attribs['is:inline'] = '';
      } else if (n.type === 'text' && !n.raw && !['script', 'style'].includes(n.parent?.name)) {
        // { et } ouvrent une expression en Astro : on les échappe dans le texte.
        n.data = n.data.replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
      }
      if (n.children) prepare(n.children);
    }
  };
  const list = nodes.filter((n) => n.type !== 'text' || n.raw || n.data.trim());
  if (format) for (const n of list) indentTree(n, 0);
  prepare(list);
  const placeholders = [];
  const protect = (l) =>
    l.forEach((n) => {
      if (n.raw) {
        placeholders.push(n.data);
        n.data = `@@RAW${placeholders.length - 1}@@`;
      }
      if (n.children) protect(n.children);
    });
  protect(list);
  return list
    .map((n) => render(n, RENDER_OPTS))
    .join('\n')
    .replace(/@@RAW(\d+)@@/g, (_, i) => placeholders[i])
    .replace(/ is:inline=""/g, ' is:inline')
    .split('\n')
    .map((l) => (l.trim() ? indent + l : l))
    .join('\n')
    .trim();
}

const html = (n) => render(n, RENDER_OPTS);
// Clé de comparaison insensible aux espaces.
const key = (n) => html(n).replace(/\s+/g, ' ').trim();

function write(rel, content) {
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const findNav = (nodes) => du.findOne((e) => /\bw-nav\b/.test(e.attribs.class || '') && e.attribs.role === 'banner', nodes);
const findFooter = (nodes) => du.findOne((e) => e.name === 'footer' || /(^|\s)footer(\s|$)/.test(e.attribs.class || ''), nodes);
const meta = (head, attr, value) => du.findOne((e) => e.name === 'meta' && e.attribs[attr] === value, head.children, false);

/** /blog?fcd9c3de_page=3 -> /blog/page/3 ; la page 1 est la liste elle-même. */
function paginatedRoute(liveRoute) {
  const m = liveRoute.match(/^([^?]*)\?[a-z0-9]+_page=(\d+)$/);
  if (!m) return liveRoute;
  return m[2] === '1' ? m[1] : `${m[1] === '/' ? '' : m[1]}/page/${m[2]}`;
}

// ---------------------------------------------------------------------------
// 1. Lecture et normalisation de toutes les pages
// ---------------------------------------------------------------------------

const pages = Object.entries(livePages)
  // ?xxx_page=1 est un doublon de la liste elle-même.
  .filter(([route]) => !EXCLUDED.has(route) && !/_page=1$/.test(route))
  .map(([liveRoute, file]) => {
    const doc = parseDocument(fs.readFileSync(path.join(LIVE, 'pages', file), 'utf8'), PARSE_OPTS);
    const htmlEl = du.findOne((e) => e.name === 'html', doc.children);
    const head = du.findOne((e) => e.name === 'head', doc.children);
    const body = du.findOne((e) => e.name === 'body', doc.children);
    rewriteAttributes([head, body]);
    // Pagination Webflow : /blog?xxx_page=2 devient /blog/page/2 (servable par un hébergement statique).
    const base = liveRoute.split('?')[0];
    const route = paginatedRoute(liveRoute);
    for (const a of du.findAll((e) => /^\?[a-z0-9]+_page=\d+$/.test(e.attribs.href || ''), body.children)) {
      a.attribs.href = paginatedRoute(base + a.attribs.href);
    }
    // La classe w--current est posée dynamiquement par webflow.js : on la retire du markup statique.
    for (const el of du.findAll((e) => /\bw--current\b/.test(e.attribs.class || ''), body.children)) {
      el.attribs.class = el.attribs.class.replace(/\s*w--current/, '');
      delete el.attribs['aria-current'];
    }
    return { route, file, htmlEl, head, body };
  });

// ---------------------------------------------------------------------------
// 1 bis. Langues : suppression de Weglot et traduction des pages EN
// ---------------------------------------------------------------------------

const byRoute = new Map(pages.map((p) => [p.route, p]));
for (const p of pages) p.alternates = removeWeglot(p);

const routeOf = (url) => url && new URL(url).pathname.replace(/\/$/, '');
const enPages = pages.filter((p) => isEnRoute(p.route));
const localPairs = new Map();
const frOf = new Map();
for (const p of enPages) {
  const fr = byRoute.get(routeOf(p.alternates.fr));
  if (fr) {
    localPairs.set(p, align(fr.body, p.body));
    frOf.set(p, fr);
  }
}
const memory = buildMemory(localPairs.values());
const dictionary = loadDictionary();
const correct = loadGlossary();
const untranslated = new Map();
for (const p of enPages) {
  const local = localPairs.get(p);
  const lookup = (t) => local?.get(t) ?? memory.get(t) ?? dictionary[t];
  for (const t of translatePage(p, lookup, looksFrench, dictionary, frOf.get(p), correct)) {
    if (!untranslated.has(t)) untranslated.set(t, new Set());
    untranslated.get(t).add(p.route);
  }
}
write(
  'migration/untranslated.json',
  `${JSON.stringify(Object.fromEntries([...untranslated].map(([t, r]) => [t, [...r].slice(0, 3)])), null, 2)}\n`,
);

// Le sélecteur de langue de la navbar dépend de la page : marqueur remplacé par le composant.
const SWITCHER = (e) => e.name === 'a' && e.attribs.hreflang && e.parent?.attribs?.class?.includes('wg-element-wrapper');
for (const p of pages) {
  for (const a of du.findAll(SWITCHER, p.body.children)) a.attribs.href = `@@ALT:${a.attribs.hreflang}@@`;
}

// ---------------------------------------------------------------------------
// 2. Détection du code global (head et fin de body)
// ---------------------------------------------------------------------------

const SEO_META = new Set(['description', 'robots', 'twitter:title', 'twitter:description', 'twitter:image', 'twitter:card', 'viewport']);
const SEO_PROP = new Set(['og:title', 'og:description', 'og:image', 'og:type']);
const isLayoutNode = (n) =>
  n.name === 'title' ||
  (n.name === 'meta' && (n.attribs.charset !== undefined || SEO_META.has(n.attribs.name) || SEO_PROP.has(n.attribs.property))) ||
  (n.name === 'link' && ['canonical', 'shortcut icon', 'apple-touch-icon', 'preconnect'].includes(n.attribs.rel)) ||
  (n.name === 'link' && n.attribs.rel === 'alternate' && n.attribs.hreflang) ||
  (n.name === 'link' && n.attribs.rel === 'stylesheet' && n.attribs.href?.startsWith(ASSETS_URL)) ||
  // Script Webflow qui ajoute w-mod-js / w-mod-touch : repris dans le layout.
  (n.name === 'script' && /w-mod-/.test(du.textContent(n)));

/** Enfants significatifs, chaque commentaire étant rattaché au nœud qui le suit. */
function groups(children) {
  const out = [];
  let pending = [];
  for (const n of children) {
    if (n.type === 'text') continue;
    if (n.type === 'comment') {
      pending.push(n);
      continue;
    }
    out.push({ nodes: [...pending, n], key: key(n) });
    pending = [];
  }
  if (pending.length) out.push({ nodes: pending, key: pending.map(key).join('') });
  return out;
}

/**
 * Sépare le contenu de la page, le runtime Webflow (jQuery + chunks webflow.js, propres à chaque page)
 * et les autres scripts de fin de body.
 */
function splitBody(body) {
  const kids = body.children.filter((n) => n.type !== 'text');
  const idx = kids.findIndex((n) => n.name === 'script' && /jquery/.test(n.attribs.src || ''));
  if (idx === -1) return { content: kids, runtime: [], tail: [] };
  let end = idx;
  while (kids[end]?.name === 'script' && /jquery|\/js\/webflow\./.test(kids[end].attribs.src || '')) end++;
  return { content: kids.slice(0, idx), runtime: kids.slice(idx, end), tail: kids.slice(end) };
}

const counts = { head: new Map(), tail: new Map() };
const firstSeen = { head: new Map(), tail: new Map() };
for (const p of pages) {
  p.headGroups = groups(p.head.children).filter((g) => !g.nodes.some(isLayoutNode));
  p.split = splitBody(p.body);
  p.tailGroups = groups(p.split.tail);
  for (const [kind, list] of [
    ['head', p.headGroups],
    ['tail', p.tailGroups],
  ]) {
    for (const g of new Map(list.map((x) => [x.key, x])).values()) {
      counts[kind].set(g.key, (counts[kind].get(g.key) || 0) + 1);
      if (!firstSeen[kind].has(g.key)) firstSeen[kind].set(g.key, g);
    }
  }
}
const globalKeys = (kind) => new Set([...counts[kind]].filter(([, c]) => c >= pages.length * GLOBAL_THRESHOLD).map(([k]) => k));
const globalHead = globalKeys('head');
const globalTail = globalKeys('tail');

// Feuilles de style Webflow (identiques sur toutes les pages) : chargées par le layout.
const stylesheets = [
  ...new Set(
    pages.flatMap((p) =>
      du.findAll((e) => e.name === 'link' && e.attribs.rel === 'stylesheet' && e.attribs.href?.startsWith(ASSETS_URL), p.head.children).map((e) => e.attribs.href),
    ),
  ),
];

// ---------------------------------------------------------------------------
// 3. Composants partagés : navbar / footer par langue, scripts globaux
// ---------------------------------------------------------------------------

const isEn = (route) => route === '/en' || route.startsWith('/en/');
const LANGS = [
  { id: 'fr', suffix: '', match: (r) => !isEn(r) },
  { id: 'en', suffix: 'En', match: isEn },
];

function mostCommon(list, finder) {
  const tally = new Map();
  for (const p of list) {
    const el = finder(p.split.content);
    if (!el) continue;
    const k = key(el);
    tally.set(k, { el, n: (tally.get(k)?.n || 0) + 1 });
  }
  return [...tally.values()].sort((a, b) => b.n - a.n)[0]?.el;
}

const shared = {};
for (const lang of LANGS) {
  const list = pages.filter((p) => lang.match(p.route));
  const nav = mostCommon(list, findNav);
  const footer = mostCommon(list, findFooter);
  shared[lang.id] = {
    lang,
    nav: nav && cloneNode(nav, true),
    footer: footer && cloneNode(footer, true),
    navKey: nav && key(nav),
    footerKey: footer && key(footer),
  };
}

const banner = (what) => `---\n// ${what}\n// Généré depuis le site Webflow par scripts/migrate-webflow.mjs, puis maintenu dans ce dépôt.\n---\n`;
const headNodes = [...globalHead].flatMap((k) => firstSeen.head.get(k).nodes.map((n) => cloneNode(n, true)));
const tailNodes = [...globalTail].flatMap((k) => firstSeen.tail.get(k).nodes.map((n) => cloneNode(n, true)));

// ---------------------------------------------------------------------------
// 4. Préparation des pages (SEO, composants, mise en forme)
// ---------------------------------------------------------------------------

const report = { static: 0, collections: [], customNav: [], customFooter: [] };

function preparePage(p) {
  const { head, htmlEl, body, route } = p;
  const getMeta = (attr, v) => meta(head, attr, v)?.attribs.content;
  const title = du.textContent(du.findOne((e) => e.name === 'title', head.children) || { children: [] }).trim();
  const canonical = du.findOne((e) => e.name === 'link' && e.attribs.rel === 'canonical', head.children, false)?.attribs.href;
  const props = {
    title,
    description: getMeta('name', 'description'),
    ogTitle: getMeta('property', 'og:title'),
    ogDescription: getMeta('property', 'og:description'),
    ogImage: getMeta('property', 'og:image'),
    ogType: getMeta('property', 'og:type'),
    // Canonique par défaut = URL de la page : on ne garde que les canoniques différentes.
    canonical: canonical && canonical.replace(/\/$/, '') !== route.replace(/\/$/, '') ? canonical : undefined,
    noindex: /noindex/i.test(getMeta('name', 'robots') || ''),
    lang: htmlEl.attribs.lang,
    htmlAttrs: Object.fromEntries(Object.entries(htmlEl.attribs).filter(([k]) => /^data-wf-/.test(k) && !['data-wf-domain', 'data-wf-site'].includes(k))),
    bodyClass: body.attribs.class,
    bodyAttrs: Object.fromEntries(Object.entries(body.attribs).filter(([k]) => k !== 'class')),
    webflowScripts: p.split.runtime.map((n) => ({ ...n.attribs })),
    alternates: p.alternates,
  };
  if (props.ogTitle === props.title) delete props.ogTitle;
  if (props.ogDescription === props.description) delete props.ogDescription;
  if (props.ogType === 'website') delete props.ogType;
  if (props.lang === 'fr') delete props.lang;
  for (const k of Object.keys(props)) {
    if (props[k] === undefined || props[k] === false || (typeof props[k] === 'object' && !Object.keys(props[k]).length)) delete props[k];
  }

  // Remplacement de la navbar et du footer standards par les composants de la langue.
  const s = shared[LANGS.find((l) => l.match(route)).id];
  const imports = new Set(["import BaseLayout from '@/layouts/BaseLayout.astro';"]);
  const nav = findNav(p.split.content);
  if (nav && key(nav) === s.navKey) {
    du.replaceElement(nav, Object.assign(new Text(`<Navbar${s.lang.suffix} />`), { raw: true }));
    imports.add(`import Navbar${s.lang.suffix} from '@/components/Navbar${s.lang.suffix}.astro';`);
  } else if (nav) report.customNav.push(route);
  const footer = findFooter(p.split.content);
  if (footer && key(footer) === s.footerKey) {
    du.replaceElement(footer, Object.assign(new Text(`<Footer${s.lang.suffix} />`), { raw: true }));
    imports.add(`import Footer${s.lang.suffix} from '@/components/Footer${s.lang.suffix}.astro';`);
  } else if (footer) report.customFooter.push(route);

  // Sélecteurs de langue hors navbar commune (landing pages) : lien direct vers la page traduite.
  for (const a of du.findAll((e) => /^@@ALT:/.test(e.attribs.href || ''), p.split.content)) {
    const target = a.attribs.hreflang;
    a.attribs.href = p.alternates[target] ? new URL(p.alternates[target]).pathname : target === 'en' ? '/en' : '/';
  }

  const format = (list) => {
    for (const n of list) indentTree(n, 0);
    return list;
  };
  return {
    ...p,
    props,
    imports,
    headNodes: format(p.headGroups.filter((g) => !globalHead.has(g.key)).flatMap((g) => g.nodes)),
    contentNodes: format(p.split.content),
    tailNodes: format(p.tailGroups.filter((g) => !globalTail.has(g.key)).flatMap((g) => g.nodes)),
  };
}

const prepared = pages.map(preparePage);

const pageBody = ({ headNodes: h, contentNodes: c, tailNodes: t }, spread, post = (x) => x) =>
  [
    `<BaseLayout {...${spread}}>`,
    h.length ? `  <Fragment slot="head">\n    ${post(toAstro(h, '    ', { format: false }))}\n  </Fragment>` : null,
    `  ${post(toAstro(c, '  ', { format: false }))}`,
    t.length ? `  <Fragment slot="scripts">\n    ${post(toAstro(t, '    ', { format: false }))}\n  </Fragment>` : null,
    '</BaseLayout>',
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');

// ---------------------------------------------------------------------------
// 5. Collections CMS : template induit + données (src/content)
// ---------------------------------------------------------------------------

fs.rmSync(path.join(ROOT, 'src/pages'), { recursive: true, force: true });
fs.rmSync(path.join(ROOT, 'src/content'), { recursive: true, force: true });

const groupsByBase = new Map();
for (const p of prepared) {
  // Pages d'une collection CMS, ou pages de pagination d'une même liste (/blog/page/N).
  const collection = p.htmlEl.attribs['data-wf-collection'] || /\/page\/\d+$/.test(p.route);
  if (!collection) continue;
  const base = p.route.slice(0, p.route.lastIndexOf('/'));
  if (!groupsByBase.has(base)) groupsByBase.set(base, []);
  groupsByBase.get(base).push(p);
}
const inCollection = new Set();
const collectionNames = [];

for (const [base, list] of groupsByBase) {
  if (list.length < 2) continue;
  const name = base.slice(1).replace(/\//g, '-');
  const head = induce(list.map((p) => p.headNodes), 'head:');
  const content = induce(list.map((p) => p.contentNodes), '');
  const tail = induce(list.map((p) => p.tailNodes), 'tail:');
  const imports = [...new Set(list.flatMap((p) => [...p.imports]))];

  list.forEach((p, i) => {
    const slug = p.route.slice(base.length + 1);
    const entry = { slug, seo: p.props, fields: { ...head.data[i], ...content.data[i], ...tail.data[i] } };
    write(`src/content/${name}/${slug}.json`, `${JSON.stringify(entry, null, 1)}\n`);
    inCollection.add(p.route);
  });

  const template = pageBody({ headNodes: head.template, contentNodes: content.template, tailNodes: tail.template }, 'entry.data.seo', bindAttributes);
  const page = [
    '---',
    "import { getCollection } from 'astro:content';",
    ...imports,
    '',
    'export async function getStaticPaths() {',
    `  const entries = await getCollection(${JSON.stringify(name)});`,
    '  return entries.map((entry) => ({ params: { slug: entry.data.slug }, props: { entry } }));',
    '}',
    '',
    'const { entry } = Astro.props;',
    '// Champs variables de la page (texte, attributs, fragments HTML), issus du CMS Webflow.',
    'const d = entry.data.fields;',
    '---',
    template,
  ].join('\n');
  write(`src/pages${base}/[slug].astro`, page);
  collectionNames.push(name);
  const total = (r) => r.fields.length;
  report.collections.push(`${base} : ${list.length} pages, ${total(head) + total(content) + total(tail)} champs`);
}

write(
  'src/content.config.ts',
  [
    '// Collections générées depuis le CMS Webflow par scripts/migrate-webflow.mjs.',
    "import { defineCollection } from 'astro:content';",
    "import { glob } from 'astro/loaders';",
    '',
    'const cms = (dir: string) =>',
    '  defineCollection({',
    "    loader: glob({ pattern: '*.json', base: `./src/content/${dir}`, generateId: ({ entry }) => entry.replace(/\\.json$/, '') }),",
    '  });',
    '',
    'export const collections = {',
    ...collectionNames.sort().map((n) => `  ${JSON.stringify(n)}: cms(${JSON.stringify(n)}),`),
    '};',
    '',
  ].join('\n'),
);

// ---------------------------------------------------------------------------
// 6. Pages statiques
// ---------------------------------------------------------------------------

for (const p of prepared) {
  if (inCollection.has(p.route)) continue;
  const out = ['---', ...p.imports, '', `const seo = ${JSON.stringify(p.props, null, 2)};`, '---', pageBody(p, 'seo')].join('\n');
  write(p.route === '/' ? 'src/pages/index.astro' : `src/pages${p.route}.astro`, out);
  report.static++;
}

for (const { lang, nav, footer } of Object.values(shared)) {
  if (nav) {
    const front = [
      '---',
      `// Navigation principale (${lang.id}).`,
      '// Généré depuis le site Webflow par scripts/migrate-webflow.mjs, puis maintenu dans ce dépôt.',
      '',
      '// Versions traduites de la page courante, fournies par BaseLayout (sélecteur de langue).',
      "const alternates: Record<string, string> = Astro.locals.alternates ?? {};",
      "const switchTo = (lang: string) => alternates[lang] ?? (lang === 'en' ? '/en' : '/');",
      '---',
      '',
    ].join('\n');
    write(`src/components/Navbar${lang.suffix}.astro`, `${front}${toAstro([nav]).replace(/href="@@ALT:(\w+)@@"/g, (_, l) => `href={switchTo(${JSON.stringify(l)})}`)}\n`);
  }
  if (footer) write(`src/components/Footer${lang.suffix}.astro`, `${banner(`Pied de page (${lang.id}).`)}${toAstro([footer])}\n`);
}
write('src/components/site/GlobalHead.astro', `${banner('Code tiers chargé dans le <head> de toutes les pages (consentement, GTM…).')}${toAstro(headNodes)}\n`);
write('src/components/site/GlobalScripts.astro', `${banner('Scripts chargés en fin de <body> sur toutes les pages (jQuery, Webflow, tracking…).')}${toAstro(tailNodes)}\n`);
// Pages hors sitemap : noindex, pages de pagination et pages absentes du sitemap Webflow.
const sitemapRoutes = new Set(readJson('sitemap.json'));
write(
  'src/sitemap-exclude.json',
  `${JSON.stringify(
    prepared.filter((p) => p.props.noindex || p.route.includes('/page/') || !sitemapRoutes.has(p.route)).map((p) => p.route).sort(),
    null,
    2,
  )}\n`,
);

const iconHref = (rel) =>
  pages.map((p) => du.findOne((e) => e.name === 'link' && e.attribs.rel === rel, p.head.children, false)?.attribs.href).find(Boolean);
write('src/site.json', `${JSON.stringify({ stylesheets, favicon: iconHref('shortcut icon'), webclip: iconHref('apple-touch-icon') }, null, 2)}\n`);

// ---------------------------------------------------------------------------
// 5. Redirections relevées sur le site en ligne
// ---------------------------------------------------------------------------

const redirects = Object.fromEntries(
  Object.entries(liveRedirects)
    .filter(([from, r]) => from !== r.to && !from.endsWith('/') && !/^\/(cdn-cgi)/.test(from))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([from, r]) => [from, { status: r.status === 302 ? 302 : 301, destination: r.to }]),
);
write('src/redirects.json', `${JSON.stringify(redirects, null, 2)}\n`);

// ---------------------------------------------------------------------------
// 6. Assets : copie dans public/assets (CSS réécrits pour pointer vers les copies locales)
// ---------------------------------------------------------------------------

const publicAssets = path.join(ROOT, 'public', 'assets');
fs.rmSync(publicAssets, { recursive: true, force: true });
// Les CSS et JS référencent eux-mêmes d'autres assets (polices, images de fond, chunks).
for (const rel of Object.values(assetManifest)) {
  if (/\.(css|js)$/.test(rel)) usedAssets.add(rel);
}
let bytes = 0;
for (const rel of usedAssets) {
  const src = path.join(LIVE, 'assets', rel);
  if (!fs.existsSync(src)) continue;
  const dest = path.join(publicAssets, rel.normalize('NFC'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (rel.endsWith('.css')) {
    const css = fs.readFileSync(src, 'utf8').replace(/url\((['"]?)(.+?)\1\)/g, (m, q, u) => {
      const abs = u.startsWith('data:') ? null : new URL(u, `https://${rel}`).href;
      const local = abs && ASSET_HOSTS.test(abs) ? assetUrl(abs) : null;
      return local ? `url(${q}${local}${q})` : m;
    });
    fs.writeFileSync(dest, css);
  } else {
    fs.copyFileSync(src, dest);
  }
  bytes += fs.statSync(dest).size;
}
// Assets ajoutés par la réécriture des CSS.
for (const rel of usedAssets) {
  const dest = path.join(publicAssets, rel.normalize('NFC'));
  const src = path.join(LIVE, 'assets', rel);
  if (!fs.existsSync(dest) && fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    bytes += fs.statSync(dest).size;
  }
}

// ---------------------------------------------------------------------------
// Rapport
// ---------------------------------------------------------------------------

const errors = readJson('errors.json');
const lines = [
  '# Rapport de migration Webflow',
  '',
  `- Pages statiques : ${report.static}`,
  `- Collections CMS (template + données) :`,
  ...report.collections.map((c) => `  - ${c}`),
  `- Pages exclues (fonctionnalités Webflow) : ${[...EXCLUDED].join(', ')}`,
  `- Redirections : ${Object.keys(redirects).length} (src/redirects.json)`,
  `- Textes EN restés en français : ${untranslated.size} (migration/untranslated.json)`,
  `- Assets copiés : ${usedAssets.size} (${(bytes / 1e6).toFixed(1)} Mo)`,
  '',
  '## Pages avec une navbar spécifique (non factorisée)',
  ...report.customNav.map((f) => `- ${f}`),
  '',
  '## Pages avec un footer spécifique (non factorisé)',
  ...report.customFooter.map((f) => `- ${f}`),
  '',
  '## Erreurs relevées sur le site en ligne (crawl)',
  ...Object.entries(errors).map(([u, e]) => `- ${u} : ${e}`),
  '',
];
write('migration/REPORT.md', lines.join('\n'));
console.log(lines.slice(0, 6).join('\n'));
