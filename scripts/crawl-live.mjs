#!/usr/bin/env node
/**
 * Aspire le site Webflow publié pour servir de référence à la migration (ISO).
 *
 * Usage : node scripts/crawl-live.mjs [--concurrency=8]
 *
 * - part du sitemap et suit tous les liens internes ;
 * - enregistre le HTML de chaque page dans .cache/live/pages/<chemin>.html ;
 * - relève les redirections (-> .cache/live/redirects.json) et les erreurs ;
 * - télécharge les assets du CDN Webflow (images, vidéos, PDF, CSS, JS, polices)
 *   dans .cache/live/assets/ et écrit le manifeste .cache/live/assets.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = 'https://www.innovorder.com';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.cache', 'live');
const CONCURRENCY = Number(process.argv.find((a) => a.startsWith('--concurrency='))?.split('=')[1] ?? 8);
// Hôtes servant les assets Webflow du site.
const ASSET_HOSTS = /^https:\/\/(cdn\.prod\.website-files\.com|uploads-ssl\.webflow\.com|assets-global\.website-files\.com|assets\.website-files\.com|global-uploads\.webflow\.com|d3e54v103j8qbb\.cloudfront\.net)\//;

fs.mkdirSync(path.join(OUT, 'pages'), { recursive: true });

async function fetchWithRetry(url, opts = {}, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { redirect: 'manual', ...opts, headers: { 'user-agent': 'innovorder-migration/1.0', ...opts.headers } });
      if (res.status >= 500 && i < tries) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
}

async function pool(items, worker) {
  let i = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (i < items.length) await worker(items[i++]);
    }),
  );
}

const normalizePath = (p) => {
  let decoded = p;
  try {
    decoded = decodeURI(p);
  } catch {
    // URL mal encodée dans le contenu : on la garde telle quelle.
  }
  const clean = decoded.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return clean || '/';
};

// --- Pagination Webflow (?xxx_page=N) ----------------------------------------
// Les listes CMS paginées ne sont pas dans le sitemap : on suit les liens de pagination
// des pages déjà aspirées. Chaque page N est enregistrée sous la route « <page>?<id>_page=N ».

async function crawlPagination(pages) {
  const queue = Object.keys(pages).filter((r) => !r.includes('?'));
  const seenPg = new Set(Object.keys(pages));
  while (queue.length) {
    const batch = queue.splice(0);
    await pool(batch, async (route) => {
      const html = fs.readFileSync(path.join(OUT, 'pages', pages[route]), 'utf8');
      const base = route.split('?')[0];
      for (const m of html.matchAll(/href="\?([a-z0-9]+_page=\d+)"/g)) {
        const target = `${base}?${m[1]}`;
        if (seenPg.has(target)) continue;
        seenPg.add(target);
        const res = await fetchWithRetry(SITE + target);
        if (res.status !== 200) continue;
        const file = `${base === '/' ? 'index' : base.slice(1)}__${m[1]}.html`;
        fs.mkdirSync(path.dirname(path.join(OUT, 'pages', file)), { recursive: true });
        const pageHtml = await res.text();
        fs.writeFileSync(path.join(OUT, 'pages', file), pageHtml);
        collect(pageHtml, base);
        pages[target] = file;
        queue.push(target);
      }
    });
  }
}

if (process.argv.includes('--only-pagination')) {
  const pages = JSON.parse(fs.readFileSync(path.join(OUT, 'pages.json'), 'utf8'));
  await crawlPagination(pages);
  fs.writeFileSync(path.join(OUT, 'pages.json'), JSON.stringify(pages, null, 2));
  console.log(`Pages paginées : ${Object.keys(pages).filter((r) => r.includes('?')).length}`);
  process.exit(0);
}

// --- 1. Pages ---------------------------------------------------------------

const sitemap = await (await fetchWithRetry(`${SITE}/sitemap.xml`)).text();
const queue = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => normalizePath(new URL(m[1]).pathname));
const seen = new Set(queue);
fs.writeFileSync(path.join(OUT, 'sitemap.json'), JSON.stringify(queue, null, 2));
const pages = {};
const redirects = {};
const errors = {};
const assetUrls = new Set();

function collect(html, pagePath) {
  for (const m of html.matchAll(/(?:href|src|poster|data-src|data-poster-url)="([^"]+)"/g)) handleUrl(m[1], pagePath);
  // Balises meta (og:image…) : seules les valeurs qui sont des URLs nous intéressent.
  for (const m of html.matchAll(/content="(https?:\/\/[^"]+)"/g)) handleUrl(m[1], pagePath);
  for (const m of html.matchAll(/(?:srcset|data-video-urls)="([^"]+)"/g)) {
    for (const part of m[1].split(',')) handleUrl(part.trim().split(/\s+/)[0], pagePath);
  }
  for (const m of html.matchAll(/url\((&quot;|['"]?)(.+?)\1\)/g)) handleUrl(m[2], pagePath);
}

function handleUrl(raw, pagePath) {
  const value = raw.replace(/&amp;/g, '&');
  if (ASSET_HOSTS.test(value)) return assetUrls.add(value.split('#')[0]);
  let url;
  try {
    url = new URL(value, SITE + pagePath);
  } catch {
    return;
  }
  if (!/^(www\.)?innovorder\.com$/.test(url.hostname)) return;
  if (/\.[a-z0-9]{2,5}$/i.test(url.pathname)) return;
  const p = normalizePath(url.pathname);
  if (!seen.has(p)) {
    seen.add(p);
    queue.push(p);
  }
}

let done = 0;
while (queue.length) {
  const batch = queue.splice(0);
  await pool(batch, async (p) => {
    try {
      const res = await fetchWithRetry(SITE + (p === '/' ? '/' : p));
      if (res.status >= 300 && res.status < 400) {
        const to = new URL(res.headers.get('location'), SITE + p);
        redirects[p] = { to: to.host.endsWith('innovorder.com') ? to.pathname + to.search : to.href, status: res.status };
        handleUrl(to.href, p);
        return;
      }
      if (res.status !== 200) {
        errors[p] = res.status;
        return;
      }
      const html = await res.text();
      const file = p === '/' ? 'index.html' : `${p.slice(1)}.html`;
      fs.mkdirSync(path.dirname(path.join(OUT, 'pages', file)), { recursive: true });
      fs.writeFileSync(path.join(OUT, 'pages', file), html);
      pages[p] = file;
      collect(html, p);
    } catch (e) {
      errors[p] = String(e.message || e);
    } finally {
      if (++done % 50 === 0) console.log(`  ${done} URLs traitées…`);
    }
  });
}
await crawlPagination(pages);
console.log(`Pages : ${Object.keys(pages).length} | redirections : ${Object.keys(redirects).length} | erreurs : ${Object.keys(errors).length}`);

// --- 2. Assets --------------------------------------------------------------

// Les CSS référencent d'autres assets (polices, images de fond) : on les télécharge d'abord.
const assets = {};
const localPath = (u) => {
  const url = new URL(u);
  return path.posix.join(url.hostname, decodeURIComponent(url.pathname));
};

async function download(u) {
  if (assets[u]) return;
  const rel = localPath(u);
  const dest = path.join(OUT, 'assets', rel);
  assets[u] = rel;
  if (fs.existsSync(dest)) return;
  try {
    const res = await fetchWithRetry(u, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  } catch (e) {
    delete assets[u];
    errors[u] = String(e.message || e);
  }
}

const cssUrls = [...assetUrls].filter((u) => /\.css(\?|$)/.test(u));
await pool(cssUrls, download);
for (const u of cssUrls) {
  if (!assets[u]) continue;
  const css = fs.readFileSync(path.join(OUT, 'assets', assets[u]), 'utf8');
  for (const m of css.matchAll(/url\((['"]?)([^'")]+)\1\)/g)) {
    if (m[2].startsWith('data:')) continue;
    const abs = new URL(m[2], u).href;
    if (ASSET_HOSTS.test(abs)) assetUrls.add(abs);
  }
}
const rest = [...assetUrls].filter((u) => !assets[u]);
console.log(`Assets à télécharger : ${rest.length}`);
done = 0;
await pool(rest, async (u) => {
  await download(u);
  if (++done % 200 === 0) console.log(`  ${done}/${rest.length}`);
});

fs.writeFileSync(path.join(OUT, 'pages.json'), JSON.stringify(pages, null, 2));
fs.writeFileSync(path.join(OUT, 'redirects.json'), JSON.stringify(redirects, null, 2));
fs.writeFileSync(path.join(OUT, 'assets.json'), JSON.stringify(assets, null, 2));
fs.writeFileSync(path.join(OUT, 'errors.json'), JSON.stringify(errors, null, 2));
console.log(`Assets : ${Object.keys(assets).length} | erreurs totales : ${Object.keys(errors).length}`);
