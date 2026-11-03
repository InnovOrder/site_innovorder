declare namespace App {
  interface Locals {
    /** Chemins des versions de la page courante par langue, renseignés par BaseLayout. */
    alternates?: Record<string, string>;
  }
}
