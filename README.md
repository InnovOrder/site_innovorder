# Site Innovorder

Site vitrine [innovorder.com](https://www.innovorder.com), migré depuis Webflow vers [Astro](https://astro.build).

Astro génère un site **100 % statique** : chaque page est du HTML pré-rendu, sans JavaScript ajouté par le
framework. C'est la base idéale pour le SEO (contenu indexable immédiatement, temps de chargement minimal,
Core Web Vitals).

La migration est **ISO** : chaque page générée est identique au HTML publié par Webflow (contenu, attributs,
scripts, balises SEO, `hreflang`), ce que vérifie `npm run verify:parity`.

## Démarrage

```bash
npm install
npm run dev          # http://localhost:4321
npm run build        # génère dist/
npm run preview      # sert dist/ en local
npm run check:links  # vérifie les liens internes et les assets du build
```

## Organisation

```
src/
  layouts/BaseLayout.astro     # <head> SEO (title, description, canonique, Open Graph, robots) + code global
  components/
    Navbar.astro, Footer.astro       # FR
    NavbarEn.astro, FooterEn.astro   # EN
    site/GlobalHead.astro      # code tiers du <head> : consentement Axeptio, GTM, Weglot…
    site/GlobalScripts.astro   # scripts de fin de <body> communs à toutes les pages
  pages/                       # une page = une route (prix.astro -> /prix, en/price.astro -> /en/price)
    blog/[slug].astro          # templates des collections CMS (blog, success stories, intégrations…)
  content/                     # données des collections CMS : un fichier JSON par élément
  content.config.ts            # déclaration des collections
  redirects.json               # redirections 301 reprises de Webflow
  sitemap-exclude.json         # pages hors sitemap (noindex, pagination…)
  site.json                    # feuilles de style et favicons Webflow
public/assets/                 # tous les assets rapatriés du CDN Webflow (images, vidéos, CSS, JS, polices, PDF)
scripts/
  crawl-live.mjs               # aspire le site publié (pages, pagination, redirections, assets)
  migrate-webflow.mjs          # convertit le site aspiré en projet Astro
  lib/induce.mjs               # induction des templates CMS
  verify-parity.mjs            # compare le build au site publié, page par page
  check-links.mjs
migration/REPORT.md            # rapport de la dernière migration
```

### Pages, langues et collections

- **Pages statiques** : un fichier `.astro` par page, dans `src/pages`. Les pages anglaises (servies jusqu'ici
  par le proxy Weglot sous `/en/…`) sont des pages à part entière dans `src/pages/en`.
- **Collections CMS** (blog, success stories, intégrations, ebooks, webinars, pages secteurs, catégories, en FR
  et EN) : un template `src/pages/<collection>/[slug].astro` et un fichier de données par élément dans
  `src/content/<collection>/<slug>.json` :
  - `seo` : title, description, Open Graph… ;
  - `fields` : les parties variables de la page (textes, attributs, fragments HTML comme le corps d'article).
- **Pagination** des listes (`?xxx_page=2` sur Webflow) : servie sous `/blog/page/2` ; Finsweet CMS Load suit
  ces liens pour afficher la liste complète.

Pour **ajouter un article de blog**, dupliquer un fichier de `src/content/blog/` en changeant le `slug` et les
champs, puis ajouter si besoin la carte dans les listes (`src/pages/blog.astro`, pages de catégories).

### SEO

- URLs identiques à Webflow (sans slash final) ;
- balises SEO de chaque page reprises à l'identique, canonique et `og:url` générées par le layout ;
- `hreflang` FR/EN conservés ; sitemap généré (`/sitemap-index.xml`) avec les mêmes pages que Webflow ;
- redirections 301 reprises (`src/redirects.json`, à appliquer aussi côté hébergeur).

## Migration depuis Webflow

```bash
npm run crawl            # 1. aspire le site publié dans .cache/live (≈ 15 min)
npm run migrate:webflow  # 2. régénère src/pages, src/content, les composants et public/assets
npm run build
npm run verify:parity    # 3. compare chaque page au site publié
```

La migration écrase les fichiers générés : **dès que l'équipe modifie le site dans ce dépôt, celui-ci devient la
source de vérité** et la migration ne doit plus être relancée.

Le markup, les classes et les interactions Webflow (`webflow.js`, attributs `data-w-id`) sont conservés tels
quels pour garantir un rendu identique. Ils pourront être remplacés progressivement par des composants Astro.

### Points d'attention avant la bascule

- **Formulaires Webflow natifs** (newsletter, simulateur) : ils envoient les données à Webflow et cesseront de
  fonctionner à la fermeture du site Webflow. À basculer vers HubSpot.
- **Recherche Webflow** (`/search`) et pages e-commerce Webflow : non reprises (fonctionnalités Webflow).
- **Weglot** : les pages anglaises sont désormais statiques. Une modification d'une page FR doit être reportée
  sur sa version EN (ou Weglot reconfiguré en proxy devant le nouvel hébergement).
- **Hébergement** : servir `prix.html` sur `/prix`, appliquer `src/redirects.json` en 301 et rediriger les URLs
  avec slash final vers leur version sans slash, comme Webflow (comportement par défaut de Vercel, Netlify,
  Cloudflare Pages).
