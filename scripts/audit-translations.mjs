#!/usr/bin/env node
/**
 * Repère les textes restés en français dans les pages anglaises du build (dist/en/…).
 *
 * Usage : npm run build && node scripts/audit-translations.mjs [--json=fichier] [--verbose]
 *
 * Chaque page EN est alignée sur sa version FR (liens hreflang) : un texte identique dans les deux
 * versions, ou un texte EN qui « ressemble » à du français, est signalé. Sont analysés les textes
 * visibles, les attributs alt / title / placeholder / aria-label, les balises SEO et les données
 * structurées (JSON-LD).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'htmlparser2';
import * as du from 'domutils';
import { looksFrench, loadDictionary } from './lib/i18n.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const args = process.argv.slice(2);
const JSON_OUT = args.find((a) => a.startsWith('--json='))?.slice(7);
const VERBOSE = args.includes('--verbose');

const meaningful = (t) => /[a-zà-ÿ]{3,}/i.test(t) && !/^[\d\s.,:;!?%€$+×x/-]+$/.test(t);

function segments(file) {
  const doc = parseDocument(fs.readFileSync(file, 'utf8'));
  const out = [];
  const head = du.findOne((e) => e.name === 'head', doc.children);
  // Pages de redirection générées par Astro : rien à traduire.
  if (!head || /http-equiv="refresh"/.test(fs.readFileSync(file, 'utf8').slice(0, 300))) return [];
  for (const e of du.findAll(() => true, head.children)) {
    if (e.name === 'title') out.push({ where: 'title', text: du.textContent(e).trim() });
    if (e.name === 'meta' && /^(description|og:title|og:description|twitter:title|twitter:description)$/.test(e.attribs.name || e.attribs.property || '')) {
      out.push({ where: `meta ${e.attribs.name || e.attribs.property}`, text: e.attribs.content?.trim() ?? '' });
    }
  }
  for (const e of du.findAll((x) => x.name === 'script' && x.attribs.type === 'application/ld+json', doc.children)) {
    const walk = (v, k) => {
      if (typeof v === 'string') {
        if (/^(name|text|description|headline|alternativeHeadline|articleBody)$/.test(k)) out.push({ where: `json-ld ${k}`, text: v });
      } else if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) walk(vv, kk);
    };
    try {
      walk(JSON.parse(du.textContent(e)), '');
    } catch {
      // JSON-LD invalide : ignoré.
    }
  }
  const body = du.findOne((e) => e.name === 'body', doc.children);
  if (!body) return out;
  const visit = (nodes) => {
    for (const n of nodes) {
      if (n.type === 'text') {
        const t = n.data.replace(/\s+/g, ' ').trim();
        if (t) out.push({ where: 'texte', text: t });
      } else if (n.type === 'tag') {
        for (const a of ['alt', 'title', 'placeholder', 'aria-label', 'value']) {
          // value : seul le libellé des boutons est affiché ; les valeurs de champs vont au CRM.
          if (n.attribs[a] && !(a === 'value' && !(n.name === 'input' && /^(submit|button)$/.test(n.attribs.type)))) {
            out.push({ where: `@${a}`, text: n.attribs[a].trim() });
          }
        }
        if (!['svg', 'code', 'pre'].includes(n.name)) visit(n.children);
      }
    }
  };
  visit(body.children);
  return out.filter((s) => meaningful(s.text));
}

const hreflang = (file) => {
  const html = fs.readFileSync(file, 'utf8');
  return Object.fromEntries([...html.matchAll(/<link[^>]*hreflang="(\w+)"[^>]*>/g)].map((m) => [m[1], m[0].match(/href="([^"]+)"/)[1]]));
};
const distFile = (url) => {
  const p = new URL(url).pathname;
  return path.join(DIST, p === '/' ? 'index.html' : `${p.slice(1)}.html`);
};

const enFiles = fs
  .readdirSync(path.join(DIST, 'en'), { recursive: true })
  .filter((f) => f.endsWith('.html'))
  .map((f) => path.join(DIST, 'en', f));
enFiles.push(path.join(DIST, 'en.html'));

// Noms propres, marques et citations volontairement conservés en français (dictionnaire en identité).
const dictionary = loadDictionary();
const kept = (t) => dictionary[t] === t;

const report = [];
let missingFr = 0;
for (const enFile of enFiles) {
  const route = `/${path.relative(DIST, enFile).replace(/\.html$/, '')}`;
  const alt = hreflang(enFile);
  const frFile = alt.fr && distFile(alt.fr);
  const en = segments(enFile);
  const fr = frFile && fs.existsSync(frFile) ? segments(frFile) : null;
  if (!fr) missingFr++;
  const frTexts = new Set((fr ?? []).map((s) => s.text));
  const issues = en.filter((s) => looksFrench(s.text) && !kept(s.text) && (frTexts.has(s.text) || !fr));
  if (issues.length) report.push({ route, fr: alt.fr ?? null, issues });
}

const total = report.reduce((n, r) => n + r.issues.length, 0);
for (const r of report.slice(0, VERBOSE ? Infinity : 30)) {
  console.log(`\n${r.route}  (${r.issues.length})`);
  for (const i of r.issues.slice(0, VERBOSE ? Infinity : 5)) console.log(`  [${i.where}] ${i.text.slice(0, 140)}`);
}
console.log(`\n${enFiles.length} pages EN analysées (${missingFr} sans version FR) : ${total} textes en français sur ${report.length} pages.`);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
