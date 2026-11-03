/**
 * Internationalisation sans Weglot.
 *
 * Weglot traduisait le site à la volée (proxy /en/…) et pilotait le sélecteur de langue. Ces
 * transformations, appliquées au DOM des pages publiées, le remplacent :
 *  - suppression du SDK Weglot et de ses attributs ;
 *  - sélecteur de langue natif : vrais liens vers la page traduite (balises hreflang) ;
 *  - traduction des textes que Weglot laissait en français (données structurées JSON-LD,
 *    contenus exclus de la traduction…), à partir :
 *      1. d'une mémoire de traduction construite en alignant chaque page EN sur sa page FR
 *         (Weglot conserve la structure HTML : un même emplacement = même texte traduit) ;
 *      2. du dictionnaire migration/translations.json pour le reste.
 *
 * Utilisé par la migration et par la vérification de parité, pour comparer à l'identique.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as du from 'domutils';
import { Text } from 'domhandler';
import { decodeHTML } from 'entities';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DICT_FILE = path.join(ROOT, 'migration', 'translations.json');
const GLOSSARY_FILE = path.join(ROOT, 'migration', 'glossary-en.json');
const TRANSLATABLE_ATTRS = ['alt', 'title', 'placeholder', 'aria-label', 'value'];

// ---------------------------------------------------------------------------
// Détection du français
// ---------------------------------------------------------------------------

const FR_WORDS = new Set(
  'le la les des du un une et est sont pour avec vous votre vos nous notre nos dans sur par qui que quoi pas plus ce cette ces son sa ses leur leurs être avoir ou où mais comme tout tous toutes très aussi au aux en à été sans chez entre depuis grâce afin lorsque dont ainsi être faire peut votre découvrez nos'.split(' '),
);
const EN_WORDS = new Set('the and of to for with your you our we is are in on by that this from at as be it its an or can will'.split(' '));

/** Le texte ressemble-t-il à du français ? */
export function looksFrench(text) {
  const words = text.toLowerCase().match(/[a-zàâäçéèêëîïôöùûüÿœ']+/g) ?? [];
  if (!words.length) return false;
  const fr = words.filter((w) => FR_WORDS.has(w.replace(/^[ldjmnst]'/, ''))).length;
  const en = words.filter((w) => EN_WORDS.has(w)).length;
  const accents = (text.match(/[àâçéèêëîïôûùœ]/gi) ?? []).length;
  if (words.length <= 3) return accents > 0 && en === 0;
  return fr >= 2 && fr > en * 1.5;
}


export const norm = (s) => decodeHTML(s).replace(/\s+/g, ' ').trim();
export const isEnRoute = (route) => route === '/en' || route.startsWith('/en/');

export const loadDictionary = () => (fs.existsSync(DICT_FILE) ? JSON.parse(fs.readFileSync(DICT_FILE, 'utf8')) : {});

/**
 * Correcteur terminologique des pages EN (migration/glossary-en.json) : corrige les traductions
 * automatiques erronées de Weglot (ex. « TPE » traduit par « very small enterprise »).
 */
export function loadGlossary() {
  const { terms = [], labels = {} } = fs.existsSync(GLOSSARY_FILE) ? JSON.parse(fs.readFileSync(GLOSSARY_FILE, 'utf8')) : {};
  const escape = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rules = terms.map((t) => ({
    // Bornes de mot uniquement aux extrémités alphanumériques (un terme peut finir par « ! »).
    re: new RegExp(t.regex ? t.find : `${/^\w/.test(t.find) ? '\\b' : ''}${escape(t.find)}${/\w$/.test(t.find) ? '\\b' : ''}`, t.caseSensitive ? 'g' : 'gi'),
    replace: t.replace,
  }));
  // Casse : casse « titre » et majuscule initiale conservées ; pour un acronyme (VSE), majuscule
  // seulement en début de phrase.
  const withCase = (match, repl, offset, whole) => {
    const words = match.split(/\s+/);
    if (words.length > 1 && words.every((w) => /^[A-Z]/.test(w))) return repl.replace(/\b[a-z]/g, (c) => c.toUpperCase());
    const sentenceStart = /(^|(?<!\bvs)[.!?:]\s+)$/.test(whole.slice(0, offset));
    const upper = /^[A-Z]{2,}s?$/.test(match) ? sentenceStart : /^[A-Z]/.test(match);
    return (upper ? repl[0].toUpperCase() : repl[0].toLowerCase()) + repl.slice(1);
  };
  return (text) => {
    const trimmed = norm(text);
    if (labels[trimmed]) return text.replace(/^(\s*)[\s\S]*?(\s*)$/, (_, a, b) => `${a}${labels[trimmed]}${b}`);
    return rules.reduce((t, r) => t.replace(r.re, (m, ...rest) => withCase(m, r.replace, rest.at(-2), rest.at(-1))), text);
  };
}

// ---------------------------------------------------------------------------
// Weglot
// ---------------------------------------------------------------------------

const isWeglotNode = (n) =>
  (n.name === 'script' && (/weglot/i.test(n.attribs.src || '') || /weglot/i.test(n.attribs.id || '') || /\bWeglot\./.test(du.textContent(n)))) ||
  (n.type === 'comment' && /^\s*Weglot\s*$/i.test(n.data));

/** Script du sélecteur de langue natif (remplace le script qui pilotait Weglot). */
export const LANG_SWITCHER_SCRIPT = `
// Sélecteur de langue : la langue courante est marquée au chargement (animation Webflow du sélecteur),
// un clic sur l'autre langue joue l'animation puis ouvre la page traduite.
document.querySelectorAll('.wg-element-wrapper.sw3 [lang]').forEach((link) => {
  const isCurrent = link.getAttribute('lang') === document.documentElement.lang;
  link.addEventListener('click', (e) => {
    e.preventDefault();
    if (!isCurrent) setTimeout(() => window.location.assign(link.href), 700);
  });
  if (isCurrent) window.addEventListener('load', () => link.click());
});
`;

/**
 * Retire Weglot d'une page : SDK, script du sélecteur (remplacé par le sélecteur natif),
 * attributs data-wg-*. Renvoie les liens alternates { fr, en } relevés dans le <head>.
 */
export function removeWeglot({ htmlEl, head, body }) {
  for (const n of [...du.findAll(() => true, head.children), ...head.children.filter((c) => c.type === 'comment')]) {
    if (isWeglotNode(n)) du.removeElement(n);
  }
  for (const n of du.findAll((e) => e.name === 'script' && /Weglot\.on\(/.test(du.textContent(e)), body.children)) {
    du.replaceElement(n, Object.assign(n, { children: [new Text(LANG_SWITCHER_SCRIPT)] }));
    n.children[0].parent = n;
  }
  for (const n of body.children.filter((c) => c.type === 'comment' && /Weglot/i.test(c.data))) du.removeElement(n);
  for (const el of [htmlEl, ...du.findAll(() => true, [head, body])]) {
    for (const k of Object.keys(el.attribs)) if (k.startsWith('data-wg-')) delete el.attribs[k];
  }

  const alternates = {};
  for (const l of du.findAll((e) => e.name === 'link' && e.attribs.rel === 'alternate' && e.attribs.hreflang, head.children)) {
    alternates[l.attribs.hreflang] = l.attribs.href;
  }
  // Sélecteur de langue : liens réels vers la version traduite de la page.
  for (const a of du.findAll((e) => e.name === 'a' && e.parent?.attribs?.class?.includes('wg-element-wrapper'), body.children)) {
    const target = a.attribs.lang;
    a.attribs.href = alternates[target] ? new URL(alternates[target]).pathname : target === 'en' ? '/en' : '/';
    a.attribs.hreflang = target;
  }
  return alternates;
}

// ---------------------------------------------------------------------------
// Mémoire de traduction
// ---------------------------------------------------------------------------

/** Textes et attributs traduisibles d'un arbre, indexés par leur position dans le DOM. */
function positions(nodes, prefix = '', out = new Map()) {
  let i = 0;
  for (const n of nodes) {
    const p = `${prefix}/${i++}`;
    if (n.type === 'text') {
      const t = norm(n.data);
      if (t) out.set(p, t);
    } else if (n.type === 'tag') {
      for (const a of TRANSLATABLE_ATTRS) if (n.attribs[a]) out.set(`${p}@${a}`, norm(n.attribs[a]));
      positions(n.children, `${p}${n.name}`, out);
    }
  }
  return out;
}

/** Aligne une page FR et sa traduction EN : Map texte FR -> texte EN. */
export function align(frBody, enBody) {
  const fr = positions(frBody.children);
  const en = positions(enBody.children);
  const pairs = new Map();
  for (const [p, t] of fr) {
    const e = en.get(p);
    // Seuls les textes manifestement français alimentent la mémoire : un nom propre aligné par erreur
    // sur un autre texte (« Innovorder » -> « Innovorder vs. ») ne doit jamais devenir une traduction.
    if (e && e !== t && (looksFrench(t) || FRENCH_MARKER.test(t))) pairs.set(t, e);
  }
  return pairs;
}

export function buildMemory(pagePairs) {
  const counts = new Map();
  for (const pairs of pagePairs) {
    for (const [fr, en] of pairs) {
      if (!counts.has(fr)) counts.set(fr, new Map());
      const c = counts.get(fr);
      c.set(en, (c.get(en) ?? 0) + 1);
    }
  }
  // Traduction la plus fréquente pour chaque texte FR.
  return new Map([...counts].map(([fr, c]) => [fr, [...c].sort((a, b) => b[1] - a[1])[0][0]]));
}

// ---------------------------------------------------------------------------
// Traduction d'une page EN
// ---------------------------------------------------------------------------

// Webflow laisse parfois des retours à la ligne bruts dans les chaînes JSON-LD (JSON invalide) : tolérés.
const parseJsonString = (inner) => JSON.parse(`"${inner.replace(/\r?\n/g, '\\n')}"`);
const JSON_STRING = /"((?:[^"\\]|\\.)*)"(\s*:)?/g;
// Clés JSON-LD dont la valeur n'est pas du texte à traduire.
const JSON_LD_TECHNICAL = new Set(['@context', '@type', '@id', 'url', 'item', 'image', 'logo', 'sameAs', 'datePublished', 'dateModified', 'uploadDate', 'priceCurrency', 'price', 'telephone', 'email', 'streetAddress', 'postalCode', 'addressCountry', 'addressLocality', 'inLanguage', 'contentUrl', 'embedUrl', 'thumbnailUrl', 'duration', 'ratingValue', 'reviewCount', 'opens', 'closes', 'dayOfWeek']);

const FRENCH_MARKER = /[àâçéèêëîïôûùœ]|\b(de|du|des|le|la|les|et|pour|avec|un|une|en|au|aux|sur|à|d'|l')\b/i;

/** Chaînes des données structurées (JSON-LD) d'une page. */
function jsonLdStrings(root) {
  const out = new Set();
  for (const s of du.findAll((e) => e.name === 'script' && e.attribs.type === 'application/ld+json', root.children)) {
    for (const m of du.textContent(s).matchAll(JSON_STRING)) {
      try {
        out.add(norm(parseJsonString(m[1])));
      } catch {
        // chaîne JSON invalide : ignorée
      }
    }
  }
  return out;
}

/**
 * Traduit les textes encore en français d'une page EN.
 *
 * Un texte est à traduire s'il figure dans le dictionnaire, s'il ressemble à du français, ou s'il est
 * identique à la page FR correspondante (`frPage`) : dans les données structurées (que Weglot ne
 * traduisait pas), ou dans le contenu s'il porte une marque du français. Les textes identiques dans
 * les deux langues (marques, noms propres) ne sont jamais remplacés par la mémoire.
 * `lookup(fr)` renvoie la traduction connue ou undefined. Renvoie les textes non traduits.
 */
export function translatePage({ head, body }, lookup, looksFrench, dictionary = {}, frPage = null, correct = (t) => t) {
  const missing = [];
  const frTexts = new Set(frPage ? positions([frPage.head, frPage.body]).values() : []);
  const frLd = frPage ? jsonLdStrings(frPage.head).union(jsonLdStrings(frPage.body)) : new Set();
  const candidate = (t, inJsonLd) =>
    t in dictionary || looksFrench(t) || (inJsonLd ? frLd.has(t) : frTexts.has(t) && FRENCH_MARKER.test(t));
  // Traduction éventuelle puis corrections terminologiques ; null si le texte est inchangé.
  const tr = (raw, inJsonLd = false) => {
    const t = norm(raw);
    let en = null;
    if (candidate(t, inJsonLd)) {
      en = lookup(t) ?? null;
      if (en === null) missing.push(t);
    }
    const fixed = correct(en ?? raw);
    if (fixed !== (en ?? raw)) return norm(fixed);
    return en;
  };

  // Textes visibles et attributs.
  for (const n of du.findAll(() => true, [head, body])) {
    if (n.name === 'script' || n.name === 'style') {
      if (n.attribs.type === 'application/ld+json') translateJsonLd(n, (v) => tr(v, true));
      continue;
    }
    for (const a of TRANSLATABLE_ATTRS) {
      // value : seul le libellé des boutons est affiché ; les valeurs de champs sont transmises au CRM.
      if (!n.attribs[a] || (a === 'value' && !(n.name === 'input' && /^(submit|button)$/.test(n.attribs.type)))) continue;
      const en = tr(n.attribs[a]);
      if (en !== null) n.attribs[a] = en;
    }
    if (n.name === 'meta' && /description|title/.test(n.attribs.name || n.attribs.property || '') && n.attribs.content) {
      const en = tr(n.attribs.content);
      if (en !== null) n.attribs.content = en;
    }
    for (const c of n.children ?? []) {
      if (c.type !== 'text' || !c.data.trim() || ['script', 'style'].includes(n.name)) continue;
      const en = tr(c.data);
      if (en !== null) c.data = c.data.replace(/^(\s*)[\s\S]*?(\s*)$/, (_, a, b) => `${a}${en}${b}`);
    }
  }
  return missing;
}

function translateJsonLd(script, tr) {
  const text = script.children[0];
  if (!text) return;
  let key = '';
  text.data = text.data.replace(JSON_STRING, (m, inner, isKey) => {
    let value;
    try {
      value = parseJsonString(inner);
    } catch {
      return m;
    }
    if (isKey) {
      key = value;
      return m;
    }
    if (JSON_LD_TECHNICAL.has(key) || /^(https?:|\/)/.test(value) || !/[a-zà-ÿ]{3}/i.test(value)) return m;
    const en = tr(value);
    return en === null ? m : JSON.stringify(en);
  });
}
