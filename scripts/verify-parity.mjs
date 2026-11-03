#!/usr/bin/env node
/**
 * Vérifie que chaque page du build (dist/) est identique à la page publiée par Webflow (.cache/live).
 *
 * Usage : npm run build && node scripts/verify-parity.mjs [--verbose] [route…]
 *
 * Comparaison :
 *  - <head> : title, description, robots, canonique, Open Graph, hreflang, données structurées ;
 *  - <body> : arbre complet (balises, attributs, textes, scripts).
 * Différences neutralisées : emplacement des assets (CDN Webflow -> /assets), domaine des liens
 * internes, pagination (?xxx_page=N -> /page/N), mise en forme, classe w--current posée par webflow.js.
 * Évolutions volontaires appliquées au site publié avant comparaison (scripts/lib/i18n.mjs) :
 * suppression de Weglot, sélecteur de langue natif, traduction des textes EN restés en français.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'htmlparser2';
import * as du from 'domutils';
import { removeWeglot, align, buildMemory, translatePage, loadDictionary, loadGlossary, looksFrench, isEnRoute } from './lib/i18n.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = path.join(ROOT, '.cache', 'live');
const DIST = path.join(ROOT, 'dist');
const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose');
const only = args.filter((a) => !a.startsWith('--'));

const pages = JSON.parse(fs.readFileSync(path.join(LIVE, 'pages.json'), 'utf8'));
const EXCLUDED = /^(\/en)?\/(search|checkout|paypal-checkout|order-confirmation)$/;

const paginated = (r) => {
  const m = r.match(/^([^?]*)\?[a-z0-9]+_page=(\d+)$/);
  if (!m) return r;
  return m[2] === '1' ? m[1] : `${m[1] === '/' ? '' : m[1]}/page/${m[2]}`;
};

/** Normalise une URL pour la comparaison (assets -> nom de fichier, liens internes -> chemin). */
function normUrl(value, base) {
  let v = value.trim().replace(/&amp;/g, '&');
  if (/^\?[a-z0-9]+_page=\d+$/.test(v)) v = paginated(base + v);
  v = v.replace(/^https?:\/\/(www\.)?innovorder\.com/i, '') || '/';
  const asset = v.match(/^(?:https:\/\/(?:cdn\.prod\.website-files\.com|uploads-ssl\.webflow\.com|assets-global\.website-files\.com|assets\.website-files\.com|global-uploads\.webflow\.com|d3e54v103j8qbb\.cloudfront\.net)|\/assets\/[^/]+)\/(.*)$/);
  if (asset) {
    try {
      return `asset:${decodeURIComponent(asset[1].split('?')[0]).normalize('NFC')}`;
    } catch {
      return `asset:${asset[1]}`;
    }
  }
  return v;
}
const normList = (v, base) =>
  v
    .split(',')
    .map((p) => p.trim().replace(/^(\S+)/, (u) => normUrl(u, base)))
    .join(', ');
const normCss = (v, base) => v.replace(/url\((['"]?)(.+?)\1\)/g, (_, q, u) => `url(${normUrl(u, base)})`);

function tokens(nodes, base, out = []) {
  for (const n of nodes) {
    if (n.type === 'text') {
      const t = n.data.replace(/\s+/g, ' ').trim();
      if (t) out.push(`#${t}`);
    } else if (n.type === 'tag' || n.type === 'script' || n.type === 'style') {
      const attrs = Object.entries(n.attribs)
        .filter(([k]) => !['is:inline', 'aria-current'].includes(k))
        .map(([k, v]) => {
          if (k === 'class') v = v.replace(/\s*w--current/g, '').replace(/\s+/g, ' ').trim();
          else if (['srcset', 'data-video-urls', 'sizes-srcset'].includes(k)) v = normList(v, base);
          else if (k === 'style') v = normCss(v, base);
          else if (/^(https?:|\/|\?)/.test(v.trim())) v = normUrl(v, base);
          return `${k}=${v}`;
        })
        .sort();
      out.push(`<${n.name} ${attrs.join(' ')}>`);
      if (n.type === 'script' || n.type === 'style') {
        const raw = du.textContent(n).replace(/\s+/g, ' ').trim();
        if (raw) out.push(`#${n.type === 'style' ? normCss(raw, base) : raw}`);
      } else {
        tokens(n.children, base, out);
      }
      out.push(`</${n.name}>`);
    }
  }
  return out;
}

function headInfo(doc, base) {
  const head = du.findOne((e) => e.name === 'head', doc.children);
  const all = du.findAll(() => true, head.children);
  const meta = (attr, name) => all.find((e) => e.name === 'meta' && e.attribs[attr] === name)?.attribs.content?.trim();
  const link = (rel) => all.find((e) => e.name === 'link' && e.attribs.rel === rel)?.attribs.href;
  return {
    title: du.textContent(all.find((e) => e.name === 'title') ?? { children: [] }).trim(),
    description: meta('name', 'description'),
    robots: meta('name', 'robots'),
    canonical: link('canonical') && normUrl(link('canonical'), base).replace(/\/$/, ''),
    'og:title': meta('property', 'og:title'),
    'og:description': meta('property', 'og:description'),
    'og:image': meta('property', 'og:image') && normUrl(meta('property', 'og:image'), base),
    hreflang: all
      .filter((e) => e.name === 'link' && e.attribs.hreflang)
      .map((e) => `${e.attribs.hreflang}=${e.attribs.href}`)
      .sort()
      .join(' '),
    jsonld: all
      .filter((e) => e.name === 'script' && e.attribs.type === 'application/ld+json')
      .map((e) => du.textContent(e).replace(/\s+/g, ' ').trim())
      .sort()
      .join('\n'),
  };
}

let ok = 0;
const failures = [];
const allRoutes = Object.keys(pages).filter((r) => !EXCLUDED.test(r) && !/_page=1$/.test(r));
const routes = allRoutes.filter((r) => !only.length || only.includes(r));

// Site publié + évolutions volontaires (même traitement que la migration).
const liveDocs = new Map();
for (const r of allRoutes) {
  const doc = parseDocument(fs.readFileSync(path.join(LIVE, 'pages', pages[r]), 'utf8'));
  const page = {
    route: paginated(r),
    doc,
    htmlEl: du.findOne((e) => e.name === 'html', doc.children),
    head: du.findOne((e) => e.name === 'head', doc.children),
    body: du.findOne((e) => e.name === 'body', doc.children),
  };
  page.alternates = removeWeglot(page);
  liveDocs.set(r, page);
}
const byRoute = new Map([...liveDocs.values()].map((p) => [p.route, p]));
const enPages = [...liveDocs.values()].filter((p) => isEnRoute(p.route));
const localPairs = new Map();
const frOf = new Map();
for (const p of enPages) {
  const fr = p.alternates.fr && byRoute.get(new URL(p.alternates.fr).pathname.replace(/\/$/, ''));
  if (fr) {
    localPairs.set(p, align(fr.body, p.body));
    frOf.set(p, fr);
  }
}
const memory = buildMemory(localPairs.values());
const dictionary = loadDictionary();
const correct = loadGlossary();
for (const p of enPages) {
  const local = localPairs.get(p);
  translatePage(p, (t) => local?.get(t) ?? memory.get(t) ?? dictionary[t], looksFrench, dictionary, frOf.get(p), correct);
}

for (const liveRoute of routes) {
  const route = paginated(liveRoute);
  const base = liveRoute.split('?')[0];
  const distFile = path.join(DIST, route === '/' ? 'index.html' : `${route.slice(1)}.html`);
  if (!fs.existsSync(distFile)) {
    failures.push({ route, reason: 'page absente du build' });
    continue;
  }
  const live = liveDocs.get(liveRoute).doc;
  const built = parseDocument(fs.readFileSync(distFile, 'utf8'));

  const problems = [];
  const hl = headInfo(live, base);
  const hb = headInfo(built, base);
  // Une canonique égale à l'URL de la page est équivalente à une canonique implicite.
  if (!hl.canonical) hl.canonical = route === '/' ? '' : route;
  if (hb.canonical === '/') hb.canonical = '';
  for (const k of Object.keys(hl)) {
    if ((hl[k] ?? '') !== (hb[k] ?? '') && !(k.startsWith('og:') && !hl[k])) problems.push(`head ${k} : « ${hl[k] ?? ''} » ≠ « ${hb[k] ?? ''} »`);
  }

  const bl = tokens(du.findOne((e) => e.name === 'body', live.children).children, base);
  const bb = tokens(du.findOne((e) => e.name === 'body', built.children).children, base);
  const len = Math.max(bl.length, bb.length);
  for (let i = 0; i < len; i++) {
    if (bl[i] !== bb[i]) {
      problems.push(`body : écart au jeton ${i}/${bl.length}\n      webflow : ${String(bl[i]).slice(0, 220)}\n      astro   : ${String(bb[i]).slice(0, 220)}`);
      break;
    }
  }
  if (problems.length) failures.push({ route, reason: problems.join('\n    ') });
  else ok++;
}

for (const f of failures.slice(0, VERBOSE ? Infinity : 25)) console.log(`✗ ${f.route}\n    ${f.reason}`);
if (!VERBOSE && failures.length > 25) console.log(`… ${failures.length - 25} autres (--verbose pour tout afficher)`);
console.log(`\n${ok}/${routes.length} pages identiques au site Webflow publié.`);
process.exitCode = failures.length ? 1 : 0;
