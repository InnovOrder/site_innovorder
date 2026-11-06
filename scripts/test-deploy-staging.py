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


if __name__ == "__main__":
    unittest.main()
