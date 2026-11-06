#!/usr/bin/env python3
"""Publish the static build, including extensionless HTML objects, to the staging bucket.

Authentication uses Application Default Credentials (GitHub OIDC or local ADC).
--dry-run validates the object mapping without credentials or third-party packages.
"""
import argparse
import mimetypes
import subprocess
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
from pathlib import Path

PROJECT = "innovorder-ai-prod"
BUCKET = "innovorder-ai-prod-site-staging"
ROOT = Path(__file__).resolve().parents[1]


class RobotsParser(HTMLParser):
    noindex = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "meta" and attrs.get("name", "").lower() == "robots":
            self.noindex |= "noindex" in attrs.get("content", "").lower().replace(",", " ").split()


def objects_to_upload(dist):
    dist = Path(dist)
    if not (dist / "index.html").is_file():
        raise ValueError("dist/index.html is missing: run DEPLOY_ENV=staging npm run build first")
    objects = {}
    for source in sorted(dist.rglob("*")):
        if not source.is_file():
            continue
        if source.is_symlink():
            raise ValueError(f"Symlinks are not allowed in the build: {source}")
        name = source.relative_to(dist).as_posix()
        names = [name]
        if name.endswith(".html"):
            parser = RobotsParser()
            parser.feed(source.read_text())
            if not parser.noindex:
                raise ValueError(f"Page without noindex: {name}. Rebuild with DEPLOY_ENV=staging.")
            if name != "index.html":
                route = name.removesuffix(".html").removesuffix("/index")
                names.extend([route, route + "/"])
        for object_name in names:
            if object_name in objects and objects[object_name] != source:
                raise ValueError(f"Conflicting objects for {object_name}")
            objects[object_name] = source
    return objects


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--gcloud", action="store_true", help="Use the active local gcloud login instead of ADC")
    args = parser.parse_args()
    objects = objects_to_upload(ROOT / "dist")
    print(f"Validated {len(objects)} objects for gs://{BUCKET}")
    if args.dry_run:
        return

    from google.cloud import storage

    credentials = None
    if args.gcloud:
        from google.oauth2.credentials import Credentials
        # Capture in memory only: never write the access token to logs, arguments or files.
        token = subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True).strip()
        credentials = Credentials(token)
    client = storage.Client(project=PROJECT, credentials=credentials)
    bucket = client.get_bucket(BUCKET)
    # Refuse to upload to a bucket that was not provisioned for this site.
    if bucket.labels.get("application") != "site-innovorder" or bucket.labels.get("environment") != "staging":
        raise ValueError("Target bucket does not have the expected staging labels")

    def upload(item):
        name, source = item
        blob = bucket.blob(name)
        content_type = mimetypes.guess_type(source.name)[0] or "application/octet-stream"
        blob.cache_control = "no-store" if source.suffix == ".html" else "public, max-age=300"
        blob.upload_from_filename(str(source), content_type=content_type, timeout=120)

    # Assets first: pages only become visible after their dependencies are uploaded.
    with ThreadPoolExecutor(max_workers=8) as executor:
        for html in (False, True):
            items = [(name, source) for name, source in objects.items() if (source.suffix == ".html") == html]
            list(executor.map(upload, items))
    # No deletion on deploy: old assets remain available to already-open pages.
    print(f"Uploaded {len(objects)} objects. Verify https://staging.innovorder.io/")


if __name__ == "__main__":
    main()
