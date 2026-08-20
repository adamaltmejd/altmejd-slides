from __future__ import annotations

import argparse
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tools.render_revealjs_pdfs import (
    DEFAULT_HANDOUT_NAME,
    DEFAULT_PRESENTATION_NAME,
    RendererInfo,
    RenderError,
    RenderMode,
    Viewport,
    cache_digest,
    collect_asset_paths,
    configured_modes,
    deck_url,
    extract_reveal_dimensions,
    normalize_query,
    output_path_for,
    parse_viewport,
    render_viewport,
    resolve_chrome,
    resolve_renderer,
    validate_name_template,
)


def reveal_html(extra_head: str = "", body: str = "") -> str:
    return f"""<!doctype html>
<html>
<head>{extra_head}</head>
<body><div class="reveal"><div class="slides">{body}</div></div>
<script>
Reveal.initialize({{
  menu: {{ custom: [{{ title: "a }} value" }}] }},
  width: 1050,
  height: 700,
  plugins: []
}});
</script></body></html>
"""


class ViewportTests(unittest.TestCase):
    def test_parse_explicit_viewport(self) -> None:
        self.assertEqual(parse_viewport("1920x1080"), Viewport(1920, 1080))

    def test_rejects_unsafe_viewport(self) -> None:
        for value in ("0x700", "1050", "1050x-1", "99999x700"):
            with self.subTest(value=value), self.assertRaises(RenderError):
                parse_viewport(value)

    def test_extracts_dimensions_after_nested_config(self) -> None:
        self.assertEqual(extract_reveal_dimensions(reveal_html()), Viewport(1050, 700))

    def test_missing_dimensions_require_override(self) -> None:
        html = '<div class="reveal"></div><script>Reveal.initialize({});</script>'
        with self.assertRaisesRegex(RenderError, "pass --viewport-size"):
            extract_reveal_dimensions(html)

    def test_derived_viewport_scales_actual_deck_ratio(self) -> None:
        self.assertEqual(render_viewport(reveal_html(), None, 2), Viewport(2100, 1400))
        self.assertEqual(
            render_viewport(reveal_html(), Viewport(1600, 900), 4),
            Viewport(1600, 900),
        )


class NamingAndQueryTests(unittest.TestCase):
    def test_name_template_is_a_pdf_basename(self) -> None:
        validate_name_template("{stem}-{mode}.pdf")
        for template in ("../{stem}.pdf", "/tmp/{stem}.pdf", "{unknown}.pdf", "x.txt"):
            with self.subTest(template=template), self.assertRaises(RenderError):
                validate_name_template(template)

    def test_output_path_preserves_relative_directory(self) -> None:
        root = Path("/site")
        html = root / "lectures" / "one" / "deck.html"
        mode = RenderMode("presentation", "", "{stem}-slides.pdf")
        self.assertEqual(
            output_path_for(html, root, Path("/pdfs"), mode),
            Path("/pdfs/lectures/one/deck-slides.pdf"),
        )

    def test_query_is_canonical_and_url_encoded(self) -> None:
        self.assertEqual(normalize_query("?z=hello world&a=1"), "a=1&z=hello+world")
        url = deck_url(
            "http://127.0.0.1:8000",
            Path("/site/decks/a b.html"),
            Path("/site"),
            "handout=true",
        )
        self.assertEqual(url, "http://127.0.0.1:8000/decks/a%20b.html?handout=true")

    def test_default_modes_have_distinct_names_and_queries(self) -> None:
        args = argparse.Namespace(
            handout_name=None,
            presentation_name=None,
            presentation_query="pdf=slides",
            handout_query="handout=true",
            mode="both",
        )
        modes = configured_modes(args)
        self.assertEqual(modes[0].name_template, DEFAULT_PRESENTATION_NAME)
        self.assertEqual(modes[1].name_template, DEFAULT_HANDOUT_NAME)
        self.assertNotEqual(modes[0].query, modes[1].query)


class AssetAndCacheTests(unittest.TestCase):
    def test_collects_html_direct_css_and_quarto_directory_assets(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            site = Path(temporary).resolve()
            deck_dir = site / "decks"
            deck_dir.mkdir()
            files_dir = deck_dir / "talk_files"
            files_dir.mkdir()
            (deck_dir / "image.png").write_bytes(b"image")
            (files_dir / "font.woff2").write_bytes(b"font")
            (files_dir / "theme.css").write_text(
                "@font-face { src: url('font.woff2'); }", encoding="utf-8"
            )
            html = deck_dir / "talk.html"
            html.write_text(
                reveal_html(
                    '<link rel="stylesheet" href="talk_files/theme.css">',
                    '<img data-src="image.png">',
                ),
                encoding="utf-8",
            )
            relative = {
                path.relative_to(site).as_posix() for path in collect_asset_paths(html, site)
            }
            self.assertEqual(
                relative,
                {
                    "decks/talk.html",
                    "decks/image.png",
                    "decks/talk_files/theme.css",
                    "decks/talk_files/font.woff2",
                },
            )

    def test_external_fetchable_resource_fails_but_link_is_allowed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            site = Path(temporary).resolve()
            html = site / "talk.html"
            html.write_text(
                reveal_html(
                    body=(
                        '<a href="https://example.com/paper">paper</a>'
                        '<section data-background-image="https://example.com/image.png">'
                        "background"
                        "</section>"
                    )
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RenderError, "blocked external resource"):
                collect_asset_paths(html, site)

    def test_digest_changes_with_asset_mode_and_renderer_config(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            site = Path(temporary).resolve()
            html = site / "talk.html"
            html.write_text(reveal_html(), encoding="utf-8")
            css = site / "theme.css"
            css.write_text("body { color: black; }", encoding="utf-8")
            renderer = RendererInfo(Path("/decktape"), "3.16.1", "lock")
            presentation = RenderMode("presentation", "pdf=slides", "{stem}-slides.pdf")
            handout = RenderMode("handout", "handout=true", "{stem}-handout.pdf")

            def digest(mode: RenderMode, pause: int = 250) -> str:
                return cache_digest(
                    assets=(html, css),
                    site_dir=site,
                    mode=mode,
                    viewport=Viewport(2100, 1400),
                    renderer=renderer,
                    pause_ms=pause,
                    load_pause_ms=1000,
                    no_sandbox=False,
                    chrome_fingerprint=None,
                    pipeline_source_hash="source",
                )

            initial = digest(presentation)
            self.assertNotEqual(initial, digest(handout))
            self.assertNotEqual(initial, digest(presentation, pause=500))
            css.write_text("body { color: red; }", encoding="utf-8")
            after_css_change = digest(presentation)
            self.assertNotEqual(initial, after_css_change)
            html.write_text(reveal_html(body="changed"), encoding="utf-8")
            self.assertNotEqual(after_css_change, digest(presentation))


class RendererResolutionTests(unittest.TestCase):
    def test_resolves_chrome_from_environment_and_fingerprints_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            executable = Path(temporary) / "chrome"
            executable.write_text("browser", encoding="utf-8")
            executable.chmod(0o755)
            with mock.patch.dict(os.environ, {"CHROME_PATH": str(executable)}):
                resolved, fingerprint = resolve_chrome(None)

            self.assertEqual(resolved, executable.resolve())
            self.assertEqual(len(fingerprint or ""), 64)

    def test_resolves_exact_root_pin_and_hashes_lock(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            tools_dir = root / "tools"
            tools_dir.mkdir()
            (root / "package.json").write_text(
                '{"devDependencies":{"decktape":"3.16.1"}}', encoding="utf-8"
            )
            (root / "bun.lock").write_text("lock", encoding="utf-8")
            executable = root / "node_modules" / ".bin" / "decktape"
            executable.parent.mkdir(parents=True)
            executable.write_text("#!/bin/sh\n", encoding="utf-8")
            executable.chmod(0o755)
            installed = root / "node_modules" / "decktape" / "package.json"
            installed.parent.mkdir(parents=True)
            installed.write_text('{"version":"3.16.1"}', encoding="utf-8")

            renderer = resolve_renderer(tools_dir, None)
            self.assertEqual(renderer.executable, executable)
            self.assertEqual(renderer.version, "3.16.1")
            self.assertEqual(len(renderer.dependency_lock_hash), 64)

    def test_rejects_installed_version_drift(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            tools_dir = root / "tools"
            tools_dir.mkdir()
            (root / "package.json").write_text(
                '{"devDependencies":{"decktape":"3.16.1"}}', encoding="utf-8"
            )
            (root / "bun.lock").write_text("lock", encoding="utf-8")
            executable = root / "node_modules" / ".bin" / "decktape"
            executable.parent.mkdir(parents=True)
            executable.write_text("#!/bin/sh\n", encoding="utf-8")
            executable.chmod(0o755)
            installed = root / "node_modules" / "decktape" / "package.json"
            installed.parent.mkdir(parents=True)
            installed.write_text('{"version":"3.15.0"}', encoding="utf-8")

            with self.assertRaisesRegex(RenderError, "does not match"):
                resolve_renderer(tools_dir, None)


if __name__ == "__main__":
    unittest.main()
