#!/usr/bin/env node
/**
 * Vérifie, sur le build (dist/), que les liens internes et les assets pointent vers des fichiers existants.
 * Usage : npm run build && npm run check:links
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const pages = fs.readdirSync(DIST, { recursive: true }).filter((f) => f.endsWith('.html'));
const exists = (urlPath) => {
  const p = decodeURIComponent(urlPath);
  const candidates = p === '/' ? ['index.html'] : [p, `${p}.html`, `${p}/index.html`];
  return candidates.some((c) => fs.existsSync(path.join(DIST, c)) && fs.statSync(path.join(DIST, c)).isFile());
};

const broken = new Map();
for (const page of pages) {
  const html = fs.readFileSync(path.join(DIST, page), 'utf8');
  const urls = [
    ...[...html.matchAll(/\s(?:href|src|poster|data-poster-url)="([^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/\s(?:srcset|data-video-urls)="([^"]+)"/g)].flatMap((m) =>
      m[1].split(',').map((s) => s.trim().split(/\s+/)[0]),
    ),
  ];
  for (const url of urls) {
    if (!url.startsWith('/') || url.startsWith('//')) continue;
    const target = url.replace(/[?#].*$/, '') || '/';
    if (!exists(target)) {
      if (!broken.has(target)) broken.set(target, new Set());
      broken.get(target).add(`/${page.replace(/\.html$/, '')}`);
    }
  }
}

const sorted = [...broken].sort((a, b) => b[1].size - a[1].size);
for (const [target, from] of sorted) {
  console.log(`${target}  ← ${from.size} page(s)${from.size <= 3 ? ` : ${[...from].join(', ')}` : ''}`);
}
console.log(`\n${pages.length} pages analysées, ${broken.size} cible(s) introuvable(s).`);
process.exitCode = broken.size ? 1 : 0;
