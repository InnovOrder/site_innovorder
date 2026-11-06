terraform {
  required_version = ">= 1.5"
  backend "gcs" {
    bucket = "innovorder-ai-prod-site-staging-tfstate"
    prefix = "site-staging"
  }
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
}

provider "google" {
  project = "innovorder-ai-prod"
  region  = "europe-west1"
}

locals {
  name      = "site-staging"
  domain    = "staging.innovorder.io"
  redirects = jsondecode(file("${path.module}/../../src/redirects.json"))
}

resource "google_project_service" "required" {
  for_each = toset([
    "compute.googleapis.com", "storage.googleapis.com", "iam.googleapis.com",
    "iamcredentials.googleapis.com", "sts.googleapis.com"
  ])
  service            = each.key
  disable_on_destroy = false
}

resource "google_storage_bucket" "site" {
  name                        = "innovorder-ai-prod-site-staging"
  location                    = "EUROPE-WEST1"
  uniform_bucket_level_access = true
  force_destroy               = false
  labels = {
    application = "site-innovorder"
    environment = "staging"
  }
  website {
    main_page_suffix = "index.html"
    not_found_page   = "404.html"
  }
  versioning {
    enabled = true
  }
  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 7
      with_state                 = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }
  lifecycle {
    prevent_destroy = true
  }
  depends_on = [google_project_service.required]
}

# This bucket contains only the public build. Source code and credentials are never uploaded.
resource "google_storage_bucket_iam_member" "public_read" {
  bucket = google_storage_bucket.site.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

resource "google_compute_backend_bucket" "site" {
  name                    = local.name
  bucket_name             = google_storage_bucket.site.name
  enable_cdn              = false
  custom_response_headers = ["X-Robots-Tag: noindex, nofollow", "X-Content-Type-Options: nosniff"]
}

resource "google_compute_url_map" "site" {
  name            = local.name
  default_service = google_compute_backend_bucket.site.id
  host_rule {
    hosts        = [local.domain]
    path_matcher = "site"
  }
  path_matcher {
    name            = "site"
    default_service = google_compute_backend_bucket.site.id
    dynamic "path_rule" {
      for_each = local.redirects
      content {
        paths = [path_rule.key, "${path_rule.key}/", "${path_rule.key}.html"]
        url_redirect {
          host_redirect          = startswith(path_rule.value.destination, "https://") ? split("/", path_rule.value.destination)[2] : null
          path_redirect          = startswith(path_rule.value.destination, "https://") ? "/${join("/", slice(split("/", path_rule.value.destination), 3, length(split("/", path_rule.value.destination))))}" : path_rule.value.destination
          https_redirect         = true
          redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
          strip_query            = false
        }
      }
    }
  }
}

resource "google_compute_global_address" "site" {
  name       = local.name
  depends_on = [google_project_service.required]
}

resource "google_dns_record_set" "site" {
  project      = "innovorder-infra"
  managed_zone = "innovorder-io-zone"
  name         = "${local.domain}."
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_global_address.site.address]
}

resource "google_compute_managed_ssl_certificate" "site" {
  name = local.name
  managed {
    domains = [local.domain]
  }
  depends_on = [google_project_service.required]
}

resource "google_compute_target_https_proxy" "site" {
  name             = local.name
  url_map          = google_compute_url_map.site.id
  ssl_certificates = [google_compute_managed_ssl_certificate.site.id]
}

resource "google_compute_global_forwarding_rule" "https" {
  name                  = "${local.name}-https"
  target                = google_compute_target_https_proxy.site.id
  ip_address            = google_compute_global_address.site.id
  port_range            = "443"
  load_balancing_scheme = "EXTERNAL"
}

resource "google_compute_url_map" "http" {
  name = "${local.name}-http"
  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "site" {
  name    = local.name
  url_map = google_compute_url_map.http.id
}

resource "google_compute_global_forwarding_rule" "http" {
  name                  = "${local.name}-http"
  target                = google_compute_target_http_proxy.site.id
  ip_address            = google_compute_global_address.site.id
  port_range            = "80"
  load_balancing_scheme = "EXTERNAL"
}

resource "google_service_account" "deploy" {
  account_id   = "site-staging-deploy"
  display_name = "Deploy site staging from GitHub Actions"
  depends_on   = [google_project_service.required]
}

resource "google_storage_bucket_iam_member" "deploy" {
  bucket = google_storage_bucket.site.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.deploy.email}"
}

# get_bucket() verifies the target's labels before upload; it needs storage.buckets.get.
resource "google_storage_bucket_iam_member" "deploy_metadata" {
  bucket = google_storage_bucket.site.name
  role   = "roles/storage.legacyBucketReader"
  member = "serviceAccount:${google_service_account.deploy.email}"
}

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "site-staging-github"
  display_name              = "Site staging GitHub"
  depends_on                = [google_project_service.required]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  attribute_mapping = {
    "google.subject"          = "assertion.sub"
    "attribute.repository_id" = "assertion.repository_id"
  }
  # Numeric IDs prevent reuse of the repository or organization name by another owner.
  attribute_condition = "assertion.repository_owner_id == '17184998' && assertion.repository_id == '1444134992' && assertion.ref == 'refs/heads/staging'"
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "github" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository_id/1444134992"
}

output "staging_ip" {
  value = google_compute_global_address.site.address
}

output "staging_url" {
  value = "https://${local.domain}"
}

output "github_workload_identity_provider" {
  value = google_iam_workload_identity_pool_provider.github.name
}
