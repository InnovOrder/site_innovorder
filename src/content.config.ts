// Collections générées depuis le CMS Webflow par scripts/migrate-webflow.mjs.
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';

const cms = (dir: string) =>
  defineCollection({
    loader: glob({ pattern: '*.json', base: `./src/content/${dir}`, generateId: ({ entry }) => entry.replace(/\.json$/, '') }),
  });

export const collections = {
  "blog": cms("blog"),
  "blog-page": cms("blog-page"),
  "categories": cms("categories"),
  "categories-digitalisation-restauration-page": cms("categories-digitalisation-restauration-page"),
  "categories-ouvrir-restaurant-page": cms("categories-ouvrir-restaurant-page"),
  "categories-restauration-collective-page": cms("categories-restauration-collective-page"),
  "categories-tendances-restauration-page": cms("categories-tendances-restauration-page"),
  "ebook": cms("ebook"),
  "en-blog": cms("en-blog"),
  "en-blog-page": cms("en-blog-page"),
  "en-categories": cms("en-categories"),
  "en-categories-catering-trends-page": cms("en-categories-catering-trends-page"),
  "en-categories-collective-catering-page": cms("en-categories-collective-catering-page"),
  "en-categories-digital-transformation-restoration-page": cms("en-categories-digital-transformation-restoration-page"),
  "en-categories-opening-a-restaurant-page": cms("en-categories-opening-a-restaurant-page"),
  "en-collective-catering": cms("en-collective-catering"),
  "en-commercial-catering": cms("en-commercial-catering"),
  "en-ebook": cms("en-ebook"),
  "en-integrations": cms("en-integrations"),
  "en-media-page": cms("en-media-page"),
  "en-resources-ebook-page": cms("en-resources-ebook-page"),
  "en-success-stories": cms("en-success-stories"),
  "en-success-stories-page": cms("en-success-stories-page"),
  "en-webinars": cms("en-webinars"),
  "integrations": cms("integrations"),
  "presse-page": cms("presse-page"),
  "ressources-ebook-page": cms("ressources-ebook-page"),
  "restauration-collective": cms("restauration-collective"),
  "restauration-commerciale": cms("restauration-commerciale"),
  "success-stories": cms("success-stories"),
  "success-stories-page": cms("success-stories-page"),
  "webinars": cms("webinars"),
};
