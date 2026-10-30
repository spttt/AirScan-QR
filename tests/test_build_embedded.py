import contextlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import build_embedded as builder


class EmbeddedBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def build(self, html, dependencies=None):
        source = self.root / "source.html"
        source.write_text(html, encoding="utf-8")
        return builder.build_html(
            source, dependencies if dependencies is not None else {},
        )

    def test_preserves_application_and_escapes_inline_script_terminator(self):
        html = '<script src="https://example.test/lib.js"></script><style>/* 中文 */</style><script>app()</script>'
        code = 'const tag = "</ScRiPt>";\n//# sourceMappingURL=lib.js.map'
        result = self.build(html, {"https://example.test/lib.js": code})
        self.assertIn('const tag = "<\\/ScRiPt>";', result)
        self.assertNotIn("sourceMappingURL", result)
        self.assertTrue(result.endswith('<style>/* 中文 */</style><script>app()</script>'))

    def test_downloads_shared_dependency_once_across_pages(self):
        html = '<script src="https://example.test/lib.js"></script>'
        dependencies = {}
        with patch.object(builder, "load_dependency", return_value="window.lib = true;") as load:
            self.build(html, dependencies)
            self.build(html, dependencies)
        load.assert_called_once()

    def test_dependency_is_downloaded_fresh_every_time(self):
        url = "https://example.test/lib.js"
        with patch.object(builder, "urlopen") as download:
            response = download.return_value.__enter__.return_value
            response.headers.get_content_type.return_value = "text/javascript"
            response.read.return_value = b"fresh();"
            self.assertEqual(builder.load_dependency(url), "fresh();")
            self.assertEqual(builder.load_dependency(url), "fresh();")
            self.assertEqual(download.call_count, 2)

    def test_each_run_rebuilds_both_pages_with_fresh_dependencies(self):
        html = '<script src="https://example.test/lib.js"></script>'
        for name in builder.SOURCES:
            (self.root / name).write_text(html, encoding="utf-8")
        with (
            patch.object(builder, "ROOT", self.root),
            patch.object(builder, "RELEASE", self.root / "release"),
            patch.object(builder, "load_dependency", side_effect=["first();", "second();"]) as load,
            contextlib.redirect_stdout(io.StringIO()),
        ):
            for expected in ("first();", "second();"):
                self.assertEqual(builder.main(), 0)
                for name in builder.SOURCES:
                    target = self.root / "release" / f"{Path(name).stem}-embedded.html"
                    self.assertIn(expected, target.read_text(encoding="utf-8"))
        self.assertEqual(load.call_count, 2)

    def test_rejects_external_script_execution_modes_that_change_when_inlined(self):
        for attr in ('type="module"', "async", "defer"):
            with self.subTest(attr=attr), self.assertRaisesRegex(ValueError, "Unsupported"):
                self.build(f'<script {attr} src="https://example.test/lib.js"></script>')

    def test_failed_conversion_preserves_existing_releases(self):
        release = self.root / "release"
        release.mkdir()
        target = release / "index-embedded.html"
        target.write_text("previous release", encoding="utf-8")
        (self.root / "index.html").write_text("<p>valid source</p>", encoding="utf-8")
        (self.root / "airscan-fountain.html").write_text(
            '<script src="https://example.test/missing.js"></script>', encoding="utf-8",
        )
        with (
            patch.object(builder, "ROOT", self.root),
            patch.object(builder, "RELEASE", release),
            patch.object(builder, "load_dependency", side_effect=OSError("Download failed")),
            contextlib.redirect_stdout(io.StringIO()),
            contextlib.redirect_stderr(io.StringIO()),
        ):
            self.assertEqual(builder.main(), 1)
        self.assertEqual(target.read_text(encoding="utf-8"), "previous release")


if __name__ == "__main__":
    unittest.main()
