// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import redirects from './src/redirects.json' with { type: 'json' };
import sitemapExclude from './src/sitemap-exclude.json' with { type: 'json' };

// Le sitemap reprend les pages du sitemap Webflow : sont exclues les pages en noindex,
// les pages de pagination et celles que Webflow n'y faisait pas figurer.
const EXCLUDED = new Set(sitemapExclude);

export default defineConfig({
  site: 'https://www.innovorder.com',
  // Les URLs Webflow n'ont pas de slash final : on les conserve à l'identique (aucune perte de SEO).
  trailingSlash: 'never',
  build: {
    format: 'file',
    inlineStylesheets: 'auto',
  },
  compressHTML: true,
  // Redirections relevées sur le site en ligne (301 côté hébergeur ; pages de redirection en statique).
  redirects: Object.fromEntries(Object.entries(redirects).map(([from, r]) => [from, r])),
  integrations: [
    sitemap({
      filter: (page) => !EXCLUDED.has(new URL(page).pathname.replace(/\/$/, '') || '/'),
    }),
  ],
});
