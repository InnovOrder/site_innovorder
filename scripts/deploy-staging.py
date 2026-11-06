#!/usr/bin/env python3
"""Publish the static build, including extensionless HTML objects, to the staging bucket.

Authentication uses Application Default Credentials (GitHub OIDC or local ADC).
--dry-run validates the object mapping without credentials or third-party packages.
"""
import argparse
import base64
import gzip
import hashlib
import mimetypes
import subprocess
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
from pathlib import Path

PROJECT = "innovorder-ai-prod"
BUCKET = "innovorder-ai-prod-site-staging"
ROOT = Path(__file__).resolve().parents[1]

# Text files are stored gzip-compressed with Content-Encoding: gzip. GCS serves them compressed to browsers
# and decompresses them on the fly for the rare clients that do not accept gzip (decompressive transcoding).
COMPRESSIBLE = {".html", ".css", ".js", ".mjs", ".json", ".svg", ".xml", ".txt", ".map", ".webmanifest", ".ico"}
MIN_COMPRESS_SIZE = 1024


def cache_control(name, source):
    """HTML is never cached; assets have unique (Webflow id or hashed) names and are cached for a year."""
    if source.suffix == ".html":
        return "no-store"
    if name.startswith(("assets/", "_astro/")):
        return "public, max-age=31536000"
    return "public, max-age=300"


def content_type(source):
    return mimetypes.guess_type(source.name)[0] or "application/octet-stream"


def payload(source):
    """Bytes to store for a file and their Content-Encoding (None when stored as is)."""
    data = source.read_bytes()
    if source.suffix.lower() in COMPRESSIBLE and len(data) >= MIN_COMPRESS_SIZE:
        # mtime=0 keeps the output deterministic, so unchanged files keep the same MD5 and are skipped.
        compressed = gzip.compress(data, compresslevel=9, mtime=0)
        if len(compressed) < len(data) * 0.9:
            return compressed, "gzip"
    return data, None


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
        if source.stat().st_size < 1024 and source.read_bytes().startswith(b"version https://git-lfs.github.com/spec/v1"):
            raise ValueError(f"Unresolved Git LFS pointer: {source}. Run git lfs pull before building.")
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

    existing = {blob.name: blob for blob in client.list_blobs(bucket)}
    # MD5 and encoding of what is actually stored (compressed bytes for text files).
    stored = {}
    for source in set(objects.values()):
        data, encoding = payload(source)
        stored[source] = (base64.b64encode(hashlib.md5(data).digest()).decode(), encoding)

    pending = []
    for name, source in objects.items():
        md5, encoding = stored[source]
        expected = (md5, content_type(source), cache_control(name, source), encoding)
        previous = existing.get(name)
        if previous and (previous.md5_hash, previous.content_type, previous.cache_control, previous.content_encoding) == expected:
            continue
        pending.append((name, source))
    print(f"Uploading {len(pending)} changed objects; {len(objects) - len(pending)} unchanged", flush=True)

    def upload(item):
        name, source = item
        blob = bucket.blob(name)
        data, encoding = payload(source)
        blob.cache_control = cache_control(name, source)
        blob.content_encoding = encoding
        blob.upload_from_string(data, content_type=content_type(source), timeout=120)

    # Assets first: pages only become visible after their dependencies are uploaded.
    with ThreadPoolExecutor(max_workers=8) as executor:
        for html in (False, True):
            items = [(name, source) for name, source in pending if (source.suffix == ".html") == html]
            for count, _ in enumerate(executor.map(upload, items), 1):
                if count % 500 == 0:
                    print(f"Uploaded {count}/{len(items)} {'pages' if html else 'assets'}", flush=True)
    # No deletion on deploy: old assets remain available to already-open pages.
    print(f"Uploaded {len(pending)} changed objects. Verify https://staging.innovorder.io/")


if __name__ == "__main__":
    main()
