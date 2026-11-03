/**
 * Induction de template à partir de plusieurs pages d'une même collection CMS Webflow.
 *
 * Les pages d'une collection partagent le même squelette (template Webflow) et ne diffèrent que par
 * les champs CMS. On aligne les arbres DOM de toutes les pages :
 *  - un nœud identique partout appartient au template ;
 *  - un texte ou un attribut qui varie devient un champ ;
 *  - une liste d'enfants dont la structure varie (texte riche, liste CMS imbriquée…) devient un
 *    « slot » HTML rendu tel quel.
 *
 * Le template et les données permettent de régénérer exactement chaque page d'origine.
 */
import render from 'dom-serializer';
import { Text } from 'domhandler';

const RENDER_OPTS = { encodeEntities: 'utf8', decodeEntities: true };
const RAW = ['script', 'style'];

const sig = (n) => (n.type === 'text' ? '#text' : n.type === 'comment' ? '#comment' : `${n.type}:${n.name}`);
const outer = (n) => render(n, RENDER_OPTS);

/** Nom lisible d'un champ, dérivé de la classe ou du tag de l'élément le plus proche. */
function hint(el, what) {
  let e = el;
  while (e && !(e.attribs?.class || e.attribs?.id)) e = e.parent;
  const base = (e?.attribs?.class?.split(/\s+/).find((c) => !c.startsWith('w-')) || e?.attribs?.id || el?.name || 'field')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return what ? `${base}-${what}` : base;
}

export function induce(pageNodeLists, prefix = '') {
  const fields = []; // { name, kind: 'text' | 'attr' | 'html', values: string[] }
  const names = new Map();
  const n = pageNodeLists.length;

  const addField = (name, kind, values) => {
    let unique = prefix + name;
    for (let i = 2; names.has(unique); i++) unique = `${name}-${i}`;
    names.set(unique, true);
    fields.push({ name: unique, kind, values });
    return unique;
  };

  const sameStructure = (lists) =>
    lists.every((l) => l.length === lists[0].length) && lists[0].every((node, i) => lists.every((l) => sig(l[i]) === sig(node)));

  /** Retourne la liste de nœuds du template pour un ensemble de listes de frères alignées. */
  function induceList(lists, parentEl) {
    if (!sameStructure(lists)) {
      const values = lists.map((l) => l.map(outer).join(''));
      if (values.every((v) => v === values[0])) return lists[0];
      const name = addField(hint(parentEl, 'html'), 'html', values);
      return [Object.assign(new Text(`<Fragment set:html={d[${JSON.stringify(name)}]} />`), { raw: true })];
    }
    return lists[0].map((_, i) => induceNode(lists.map((l) => l[i]), parentEl));
  }

  function induceNode(nodes, parentEl) {
    const first = nodes[0];
    if (first.type === 'text') {
      const values = nodes.map((x) => x.data);
      if (values.every((v) => v === values[0])) return first;
      const lead = values.map((v) => v.match(/^\s*/)[0]);
      const trail = values.map((v) => v.match(/\s*$/)[0]);
      const sameWs = lead.every((w) => w === lead[0]) && trail.every((w) => w === trail[0]);
      const name = addField(hint(parentEl), 'text', sameWs ? values.map((v) => v.trim()) : values);
      return Object.assign(new Text(`${sameWs ? lead[0] : ''}{d[${JSON.stringify(name)}]}${sameWs ? trail[0] : ''}`), { raw: true });
    }
    if (first.type === 'comment') return first;

    // Scripts / styles dont le contenu varie : élément complet en slot.
    if (RAW.includes(first.name)) {
      const values = nodes.map(outer);
      if (values.every((v) => v === values[0])) return first;
      const name = addField(hint(parentEl, first.name), 'html', values);
      return Object.assign(new Text(`<Fragment set:html={d[${JSON.stringify(name)}]} />`), { raw: true });
    }

    const el = first;
    const keys = [...new Set(nodes.flatMap((x) => Object.keys(x.attribs)))];
    const attribs = {};
    const dynamic = {};
    for (const k of keys) {
      const values = nodes.map((x) => x.attribs[k]);
      if (values.every((v) => v === values[0])) {
        attribs[k] = values[0];
      } else {
        const name = addField(hint(el, k), 'attr', values.map((v) => v ?? null));
        attribs[k] = `@@ATTR:${name}@@`;
        dynamic[k] = name;
      }
    }
    const children = induceList(
      nodes.map((x) => x.children),
      el,
    );
    const clone = { ...el, attribs, children, parent: null, prev: null, next: null };
    Object.setPrototypeOf(clone, Object.getPrototypeOf(el));
    children.forEach((c, i) => {
      c.parent = clone;
      c.prev = children[i - 1] ?? null;
      c.next = children[i + 1] ?? null;
    });
    return clone;
  }

  const template = induceList(pageNodeLists, null);
  const data = Array.from({ length: n }, (_, i) => Object.fromEntries(fields.map((f) => [f.name, f.values[i]])));
  return { template, data, fields };
}

/** Remplace les marqueurs d'attributs dynamiques par des expressions Astro. */
export const bindAttributes = (markup) => markup.replace(/([\w:.@-]+)="@@ATTR:([^@]+)@@"/g, (_, attr, name) => `${attr}={d[${JSON.stringify(name)}]}`);
