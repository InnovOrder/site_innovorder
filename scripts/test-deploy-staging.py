import gzip
import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("deploy_staging", Path(__file__).with_name("deploy-staging.py"))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

HTML = '<html><head><meta content="noindex,nofollow" name="robots"></head><body>Test</body></html>'


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.dist = Path(self.directory.name)
        (self.dist / "index.html").write_text(HTML)

    def test_pages_and_nested_routes_can_coexist(self):
        (self.dist / "blog.html").write_text(HTML)
        (self.dist / "blog").mkdir()
        (self.dist / "blog/article.html").write_text(HTML)
        (self.dist / "style.css").write_text("body {}")
        objects = deploy.objects_to_upload(self.dist)
        self.assertEqual(objects["blog"], self.dist / "blog.html")
        self.assertEqual(objects["blog/"], self.dist / "blog.html")
        self.assertEqual(objects["blog/article"], self.dist / "blog/article.html")
        self.assertEqual(objects["index.html"], self.dist / "index.html")
        self.assertEqual(objects["style.css"], self.dist / "style.css")
        self.assertNotIn("", objects)

    def test_rejects_production_build(self):
        (self.dist / "prix.html").write_text("<html><head></head></html>")
        with self.assertRaisesRegex(ValueError, "without noindex"):
            deploy.objects_to_upload(self.dist)

    def test_rejects_conflicting_aliases(self):
        (self.dist / "prix.html").write_text(HTML)
        (self.dist / "prix").write_text("other content")
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            deploy.objects_to_upload(self.dist)

    def test_rejects_lfs_pointers(self):
        (self.dist / "logo.svg").write_text("version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 3000\n")
        with self.assertRaisesRegex(ValueError, "Git LFS pointer"):
            deploy.objects_to_upload(self.dist)

    def test_text_files_are_gzipped_deterministically(self):
        css = self.dist / "style.css"
        css.write_text("body { color: red; }\n" * 500)
        data, encoding = deploy.payload(css)
        self.assertEqual(encoding, "gzip")
        self.assertEqual(gzip.decompress(data), css.read_bytes())
        self.assertEqual(deploy.payload(css)[0], data)

    def test_binary_and_small_files_are_stored_as_is(self):
        image = self.dist / "photo.webp"
        image.write_bytes(b"\x00" * 5000)
        small = self.dist / "tiny.css"
        small.write_text("a{}")
        self.assertEqual(deploy.payload(image), (image.read_bytes(), None))
        self.assertEqual(deploy.payload(small), (small.read_bytes(), None))

    def test_cache_control(self):
        self.assertEqual(deploy.cache_control("prix", Path("prix.html")), "no-store")
        self.assertEqual(deploy.cache_control("assets/a/b.css", Path("b.css")), "public, max-age=31536000")
        self.assertEqual(deploy.cache_control("_astro/x.js", Path("x.js")), "public, max-age=31536000")
        self.assertEqual(deploy.cache_control("sitemap-index.xml", Path("sitemap-index.xml")), "public, max-age=300")


if __name__ == "__main__":
    unittest.main()
