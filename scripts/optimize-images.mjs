#!/usr/bin/env node
/**
 * Convertit en WebP les images PNG / JPEG du site et met à jour leurs références.
 *
 * Usage : node scripts/optimize-images.mjs [--dry-run] [--keep-originals]
 *
 * - seules les images référencées par le site sont traitées (src, srcset, url() des CSS, données CMS) ;
 * - une image n'est convertie que si le WebP est nettement plus léger (au moins 10 %) ;
 * - les images Open Graph (ogImage, og:image, twitter:image) restent en PNG / JPEG : tous les réseaux
 *   sociaux ne lisent pas le WebP ;
 * - les originaux qui ne sont plus référencés nulle part sont supprimés (sauf --keep-originals).
 *
 * Le script est idempotent : il peut être relancé après l'ajout de nouvelles images.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const KEEP = args.includes('--keep-originals');

const MIN_BYTES = 8 * 1024; // en dessous, le gain ne vaut pas un fichier de plus
const MIN_GAIN = 0.1;
const QUALITY = 80;

const walk = (dir, exts) =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && exts.test(e.name))
    .map((e) => path.join(e.parentPath, e.name));

// Fichiers texte susceptibles de référencer des images.
const sources = [...walk(path.join(ROOT, 'src'), /\.(astro|json|ts|mjs|md|mdx)$/), ...walk(PUBLIC, /\.(css|html|xml|json|txt)$/)];
const corpus = new Map(sources.map((f) => [f, fs.readFileSync(f, 'utf8')]));

const IMG_REF = /\/assets\/[^"'\s()<>,\\]+?\.(?:png|jpe?g)(?=["'\s()<>,\\&]|$)/gi;
// Lignes qui déclarent une image de partage social : laissées telles quelles.
const SOCIAL = /ogImage|twitterImage|og:image|twitter:image/;

const decode = (ref) => {
  try {
    return decodeURI(ref).normalize('NFC');
  } catch {
    return null;
  }
};
const toWebpRef = (ref) => ref.replace(/\.(png|jpe?g)$/i, '.webp');

// 1. Images référencées hors balises sociales.
const refs = new Set();
for (const [file, text] of corpus) {
  for (const line of text.split('\n')) {
    if (SOCIAL.test(line)) continue;
    for (const m of line.matchAll(IMG_REF)) refs.add(m[0]);
  }
}

// 2. Conversion.
const converted = new Map(); // ref d'origine -> ref WebP
let before = 0;
let after = 0;
let skipped = 0;
for (const ref of [...refs].sort()) {
  const rel = decode(ref);
  if (!rel) continue;
  const src = path.join(PUBLIC, rel);
  const dest = path.join(PUBLIC, toWebpRef(rel));
  if (!fs.existsSync(src)) {
    // Déjà converti lors d'un passage précédent (original supprimé) ou asset manquant.
    if (fs.existsSync(dest)) converted.set(ref, toWebpRef(ref));
    continue;
  }
  const size = fs.statSync(src).size;
  if (fs.existsSync(dest)) {
    converted.set(ref, toWebpRef(ref));
    before += size;
    after += fs.statSync(dest).size;
    continue;
  }
  if (size < MIN_BYTES) {
    skipped++;
    continue;
  }
  let buf;
  try {
    buf = await sharp(src, { animated: false }).webp({ quality: QUALITY, effort: 5, smartSubsample: true }).toBuffer();
  } catch (e) {
    console.warn(`  ! ${rel} : ${e.message}`);
    continue;
  }
  if (buf.length > size * (1 - MIN_GAIN)) {
    skipped++;
    continue;
  }
  if (!DRY) fs.writeFileSync(dest, buf);
  converted.set(ref, toWebpRef(ref));
  before += size;
  after += buf.length;
}

// 3. Réécriture des références (hors balises sociales).
let rewritten = 0;
for (const [file, text] of corpus) {
  const out = text
    .split('\n')
    .map((line) => (SOCIAL.test(line) ? line : line.replace(IMG_REF, (ref) => converted.get(ref) ?? ref)))
    .join('\n');
  if (out !== text) {
    corpus.set(file, out);
    rewritten++;
    if (!DRY) fs.writeFileSync(file, out);
  }
}

// 4. Suppression des originaux qui ne sont plus référencés nulle part (nom encodé ou non).
let removed = 0;
if (!KEEP) {
  const all = [...corpus.values()].join('\n');
  for (const ref of converted.keys()) {
    const rel = decode(ref);
    const file = path.join(PUBLIC, rel);
    if (!fs.existsSync(file)) continue;
    const names = new Set([path.basename(ref), path.basename(rel), encodeURIComponent(path.basename(rel))]);
    if ([...names].some((n) => all.includes(n))) continue;
    if (!DRY) fs.unlinkSync(file);
    removed++;
  }
}

const mb = (n) => `${(n / 1048576).toFixed(1)} Mo`;
console.log(
  `${converted.size} images en WebP (${mb(before)} -> ${mb(after)}), ${skipped} laissées telles quelles, ` +
    `${rewritten} fichiers mis à jour, ${removed} originaux supprimés${DRY ? ' (simulation)' : ''}.`,
);
