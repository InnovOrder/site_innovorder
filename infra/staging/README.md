# Staging : staging.innovorder.io

Configuration destinée au projet **innovorder-ai-prod**, branche **staging**.
Les ressources sont gérées par Terraform ; vérifier leur état avec `terraform plan`.

## Architecture

- Bucket dédié `innovorder-ai-prod-site-staging`, en `europe-west1`, contenant uniquement le build public.
- Load balancer HTTPS classique, IP globale fixe et certificat Google pour `staging.innovorder.io`.
- HTTP redirigé vers HTTPS ; les redirections de `src/redirects.json` sont appliquées en 301.
- CDN désactivé ; HTML en `no-store`, assets en cache pendant cinq minutes.
- `noindex` dans les pages de staging et `X-Robots-Tag` sur le backend bucket.
- Authentification GitHub via OIDC, sans clé de service account. Seul le dépôt numérique
  `1444134992` de l’organisation `17184998`, sur `refs/heads/staging`, peut publier.
- Les droits de publication sont limités au bucket de staging. La CI ne modifie pas l’infrastructure.

Le bucket est public en lecture, comme le site. `noindex` n’est pas un contrôle d’accès.
Les formulaires et scripts tiers existants conservent leur configuration : les soumissions peuvent atteindre
Webflow, HubSpot ou d’autres services de production. Ne pas envoyer de faux leads lors de la recette.

## Provisionnement initial

Prérequis : Terraform >= 1.5, gcloud, permissions GCP nécessaires et compte GitHub avec écriture.
Avant application, inspecter les load balancers existants : cette configuration crée un load balancer dédié.
S’il faut réutiliser un load balancer partagé, adapter cette partie après inspection de ses règles.

```sh
gcloud auth login
gcloud auth application-default login
terraform -chdir=infra/staging init
terraform -chdir=infra/staging plan -out=staging.tfplan
terraform -chdir=infra/staging apply staging.tfplan
```

L’état Terraform est stocké dans le bucket privé et versionné
`innovorder-ai-prod-site-staging-tfstate`, avec le préfixe `site-staging`.
Ce bucket a été créé séparément avant `terraform init`, avec accès public interdit.

Terraform crée l’enregistrement DNS **A** `staging.innovorder.io` dans la zone
`innovorder-io-zone` du projet `innovorder-infra`. Le certificat devient actif après propagation DNS
et validation Google. Ne pas ajouter d’AAAA sans frontend IPv6.

Le provider OIDC est renseigné dans le workflow ; aucune variable GitHub ni clé privée n’est nécessaire.
Publier la branche `staging` pour déclencher le workflow.
Une modification de `src/redirects.json` nécessite également un nouvel apply Terraform.

## Build et publication manuelle

```sh
# Node 24
npm ci
ASTRO_TELEMETRY_DISABLED=1 DEPLOY_ENV=staging npm run build
npm run check:links
python3 scripts/test-deploy-staging.py
python3 scripts/deploy-staging.py --dry-run
python3 -m venv .venv
.venv/bin/pip install -r scripts/requirements-deploy.txt
.venv/bin/python scripts/deploy-staging.py --gcloud
```

`prix.html` est envoyé à la fois sous `prix.html`, `prix` et `prix/`, toujours en `text/html`.
Les pages `/blog` et `/blog/article` peuvent coexister car les noms des objets GCS ne sont pas des
répertoires locaux. Les URLs avec slash sont servies en staging ; les canoniques conservent les URLs
de production sans slash. La racine utilise `index.html` et les erreurs utilisent `404.html`.

Les assets sont envoyés avant les pages. La publication n’est pas atomique et les objets supprimés du
build ne sont pas purgés automatiquement. Les versions GCS précédentes sont conservées sept jours.
Pour revenir à une version précédente du site, reconstruire et republier le commit correspondant.

## Vérifications après déploiement

Exécuter `node scripts/verify-staging.mjs` (ou `--wait` pendant la propagation initiale).
Ce contrôle vérifie `/`, `/prix`, `/en/price`, un article, une image, une URL absente (404), une ancienne
URL (301), HTTP vers HTTPS et l’en-tête `X-Robots-Tag`. Il est aussi exécuté après chaque déploiement CI.
