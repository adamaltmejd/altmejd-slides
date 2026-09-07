from __future__ import annotations

import argparse
import os
import shutil
import subprocess
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
    cache_bypass_reason,
    cache_digest,
    collect_asset_paths,
    configured_modes,
    css_references,
    deck_url,
    extract_reveal_dimensions,
    normalize_query,
    output_path_for,
    parse_srcset,
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


class StarterWorkflowTests(unittest.TestCase):
    def test_make_requires_an_unambiguous_render_input(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            shutil.copy2(Path(__file__).resolve().parents[2] / "Makefile", root / "Makefile")
            (root / "talk.qmd").write_text("## A slide\n")
            executable = root / "quarto"
            executable.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$QUARTO_TEST_LOG"\n')
            executable.chmod(0o755)
            log = root / "quarto-arguments"
            env = {
                **os.environ,
                "PATH": f"{root}{os.pathsep}{os.environ.get('PATH', '')}",
                "QUARTO_TEST_LOG": str(log),
            }

            def render(*args: str) -> subprocess.CompletedProcess[str]:
                return subprocess.run(
                    ["make", "render", *args],
                    cwd=root,
                    env=env,
                    capture_output=True,
                    text=True,
                    check=False,
                )

            self.assertEqual(render().returncode, 0)
            self.assertEqual(log.read_text().splitlines(), ["render", "talk.qmd"])
            (root / "other.qmd").write_text("## Another talk\n")
            log.unlink()
            self.assertNotEqual(render().returncode, 0)
            self.assertFalse(log.exists())
            self.assertEqual(render("DECK_INPUT=other.qmd").returncode, 0)
            self.assertEqual(log.read_text().splitlines(), ["render", "other.qmd"])
            (root / "_quarto.yml").write_text("project: {type: default}\n")
            self.assertEqual(render().returncode, 0)
            self.assertEqual(log.read_text().splitlines(), ["render", "."])


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
    def test_srcset_ignores_empty_candidates(self) -> None:
        self.assertEqual(
            parse_srcset(", plot.svg 1x, , plot-2x.svg 2x, "), ["plot.svg", "plot-2x.svg"]
        )
        self.assertEqual(parse_srcset(" , "), [])

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

    def test_css_references_ignore_commented_urls(self) -> None:
        css = (
            "/* url(commented-out.png) */\n"
            "body { background: url(kept.png); }\n"
            '/* @import "legacy.css"\n   url(multi-line.woff2) */\n'
        )
        self.assertEqual(css_references(css), ["kept.png"])

    def test_iframe_and_svg_dependencies_change_cache_digest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            site = Path(temporary).resolve()
            html = site / "talk.html"
            html.write_text(reveal_html(body='<iframe src="figure.html"></iframe>'))
            (site / "figure.html").write_text(
                '<img src="plot.svg"><link rel="stylesheet" href="plot.css">'
            )
            (site / "plot.css").write_text("body { background: url(background.svg); }")
            (site / "background.svg").write_text("<svg/>")
            (site / "plot.svg").write_text('<svg><use href="marks.svg#marker"/></svg>')
            marks = site / "marks.svg"
            marks.write_text('<svg><text id="marker">Original result</text></svg>')
            assets = collect_asset_paths(html, site)
            self.assertEqual(
                {path.name for path in assets},
                {"talk.html", "figure.html", "plot.svg", "marks.svg", "plot.css", "background.svg"},
            )
            self.assertIsNone(cache_bypass_reason(html, site))

            def digest() -> str:
                return cache_digest(
                    assets=assets,
                    site_dir=site,
                    mode=RenderMode("presentation", "pdf=slides", "{stem}.pdf"),
                    viewport=Viewport(2100, 1400),
                    renderer=RendererInfo(Path("/decktape"), "3.16.1", "lock"),
                    pause_ms=250,
                    load_pause_ms=1000,
                    no_sandbox=False,
                    chrome_fingerprint=None,
                    pipeline_source_hash="source",
                )

            initial = digest()
            marks.write_text('<svg><text id="marker">Revised result</text></svg>')
            self.assertNotEqual(initial, digest())

    def test_nested_external_or_missing_resources_fail_preflight(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            site = Path(temporary).resolve()
            html = site / "talk.html"
            html.write_text(reveal_html(body='<iframe src="figure.html"></iframe>'))
            for reference, error in (
                ("https://example.com/plot.svg", "blocked external resource"),
                ("missing.svg", "missing local resource"),
            ):
                with self.subTest(reference=reference):
                    (site / "figure.html").write_text(f'<img src="{reference}">')
                    with self.assertRaisesRegex(RenderError, error):
                        collect_asset_paths(html, site)

    def test_unknown_script_dependencies_bypass_cache(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            site = Path(temporary).resolve()
            html = site / "talk.html"
            for filename, content in (
                ("figure.html", '<script>fetch("unlisted-result.json")</script>'),
                ("figure.svg", '<svg><script>fetch("unlisted-result.json")</script></svg>'),
                ("figure.mjs", 'import("./unlisted-result.js")'),
            ):
                with self.subTest(filename=filename):
                    html.write_text(reveal_html(body=f'<iframe src="{filename}"></iframe>'))
                    (site / filename).write_text(content)
                    collect_asset_paths(html, site)
                    self.assertIsNotNone(cache_bypass_reason(html, site))

    def test_bundled_dependencies_remain_cacheable_and_fully_hashed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            site = Path(temporary).resolve()
            html = site / "talk.html"
            html.write_text(reveal_html('<script src="site_libs/reveal.js"></script>'))
            libraries = site / "site_libs"
            libraries.mkdir()
            (libraries / "reveal.js").write_text("// bundled runtime")
            (libraries / "support.json").write_text("{}")
            (libraries / "speaker-view.html").write_text("<script>// separate window</script>")
            assets = collect_asset_paths(html, site)
            self.assertIn(libraries / "support.json", assets)
            self.assertIsNone(cache_bypass_reason(html, site))

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

    def test_missing_chrome_fails_fast(self) -> None:
        with (
            mock.patch.dict(os.environ, {}, clear=True),
            mock.patch("tools.render_revealjs_pdfs.shutil.which", return_value=None),
            mock.patch("tools.render_revealjs_pdfs.sys.platform", "linux"),
            self.assertRaisesRegex(RenderError, "no Chrome or Chromium executable"),
        ):
            resolve_chrome(None)

    def test_resolves_exact_renderer_pin_and_hashes_lock(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
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

            renderer = resolve_renderer(root, None)
            self.assertEqual(renderer.executable, executable)
            self.assertEqual(renderer.version, "3.16.1")
            self.assertEqual(len(renderer.dependency_lock_hash), 64)

    def test_rejects_installed_version_drift(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
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
                resolve_renderer(root, None)


if __name__ == "__main__":
    unittest.main()
