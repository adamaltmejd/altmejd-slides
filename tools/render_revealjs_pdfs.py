#!/usr/bin/env python3
"""Render presentation and notes-handout PDFs from rendered Reveal HTML.

The renderer is deliberately offline at render time. It uses the DeckTape
installation pinned in the repository package lock and serves an existing site
tree on loopback. It never invokes npx/bunx or downloads a renderer on demand.
"""

from __future__ import annotations

import argparse
import hashlib
import html.parser
import http.server
import json
import os
import re
import shutil
import string
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

CACHE_SCHEMA = 1
PIPELINE_VERSION = "1"
DEFAULT_CACHE_FILE = ".revealjs-pdf-cache.json"
DEFAULT_GLOB = "**/*.html"
DEFAULT_PRESENTATION_NAME = "{stem}-slides.pdf"
DEFAULT_HANDOUT_NAME = "{stem}-handout.pdf"
DEFAULT_PRESENTATION_QUERY = "pdf=slides&pdfSeparateFragments=false"
DEFAULT_HANDOUT_QUERY = "pdf=handout&handout=true&pdfSeparateFragments=false"
DEFAULT_RESOLUTION_SCALE = 2
MAX_VIEWPORT_DIMENSION = 32768

FETCHABLE_ATTRIBUTES: dict[str, tuple[str, ...]] = {
    "audio": ("src",),
    "embed": ("src",),
    "iframe": ("src",),
    "img": ("src", "srcset"),
    "input": ("src",),
    "object": ("data",),
    "script": ("src",),
    "source": ("src", "srcset"),
    "track": ("src",),
    "video": ("src", "poster"),
}
REVEAL_DATA_ATTRIBUTES = {
    "data-background-iframe",
    "data-background-image",
    "data-background-video",
    "data-src",
    "data-srcset",
}
FETCHABLE_LINK_RELS = {
    "icon",
    "manifest",
    "modulepreload",
    "preload",
    "stylesheet",
}
CSS_URL_RE = re.compile(r"url\(\s*(['\"]?)(.*?)\1\s*\)", re.IGNORECASE)
CSS_IMPORT_RE = re.compile(r"@import\s+(?!url\()(['\"])(.*?)\1", re.IGNORECASE)
CSS_COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)
REVEAL_INITIALIZE_RE = re.compile(r"\bReveal\s*\.\s*initialize\s*\(")


class RenderError(RuntimeError):
    """A stable, user-facing render failure."""


@dataclass(frozen=True)
class Viewport:
    width: int
    height: int

    def as_decktape_arg(self) -> str:
        return f"{self.width}x{self.height}"


@dataclass(frozen=True)
class RenderMode:
    name: str
    query: str
    name_template: str


@dataclass(frozen=True)
class RendererInfo:
    executable: Path
    version: str
    dependency_lock_hash: str


class _ResourceParser(html.parser.HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.references: list[str] = []
        self.inline_css: list[str] = []
        self.is_reveal = False
        self._in_style = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {name.lower(): value or "" for name, value in attrs}
        classes = set(attributes.get("class", "").split())
        if "reveal" in classes:
            self.is_reveal = True

        for attribute in FETCHABLE_ATTRIBUTES.get(tag.lower(), ()):
            value = attributes.get(attribute)
            if not value:
                continue
            if attribute == "srcset":
                self.references.extend(parse_srcset(value))
            else:
                self.references.append(value)

        for attribute in REVEAL_DATA_ATTRIBUTES:
            value = attributes.get(attribute)
            if not value:
                continue
            if attribute == "data-srcset":
                self.references.extend(parse_srcset(value))
            else:
                self.references.append(value)

        if tag.lower() == "link":
            rels = set(attributes.get("rel", "").lower().split())
            href = attributes.get("href")
            if href and rels.intersection(FETCHABLE_LINK_RELS):
                self.references.append(href)

        style = attributes.get("style")
        if style:
            self.inline_css.append(style)
        if tag.lower() == "style":
            self._in_style = True

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "style":
            self._in_style = False

    def handle_data(self, data: str) -> None:
        if self._in_style:
            self.inline_css.append(data)


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        return

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


class LocalSiteServer:
    def __init__(self, site_dir: Path) -> None:
        handler = lambda *args, **kwargs: _QuietHandler(  # noqa: E731
            *args, directory=str(site_dir), **kwargs
        )
        self._server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def __enter__(self) -> LocalSiteServer:
        self._thread.start()
        try:
            with urllib.request.urlopen(f"{self.base_url}/", timeout=5) as response:
                if response.status >= 400:
                    raise RenderError(f"local render server returned HTTP {response.status}")
        except (OSError, urllib.error.URLError) as exc:
            self._server.shutdown()
            self._thread.join(timeout=5)
            raise RenderError(f"local render server did not become ready: {exc}") from exc
        return self

    def __exit__(self, *exc_info: object) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)


def parse_srcset(value: str) -> list[str]:
    if value.lstrip().startswith("data:"):
        return []
    references: list[str] = []
    for candidate in value.split(","):
        url = candidate.strip().split(maxsplit=1)[0]
        if url:
            references.append(url)
    return references


def parse_viewport(value: str) -> Viewport:
    match = re.fullmatch(r"([1-9]\d*)[xX]([1-9]\d*)", value.strip())
    if not match:
        raise RenderError(
            f"invalid viewport {value!r}; expected WIDTHxHEIGHT with positive integers"
        )
    viewport = Viewport(int(match.group(1)), int(match.group(2)))
    _validate_viewport(viewport)
    return viewport


def _validate_viewport(viewport: Viewport) -> None:
    if max(viewport.width, viewport.height) > MAX_VIEWPORT_DIMENSION:
        raise RenderError(
            f"viewport {viewport.as_decktape_arg()} exceeds the supported "
            f"maximum dimension {MAX_VIEWPORT_DIMENSION}"
        )


def _balanced_object(source: str, open_brace: int) -> str:
    depth = 0
    quote: str | None = None
    escaped = False
    line_comment = False
    block_comment = False
    index = open_brace

    while index < len(source):
        char = source[index]
        following = source[index + 1] if index + 1 < len(source) else ""

        if line_comment:
            if char in "\r\n":
                line_comment = False
            index += 1
            continue
        if block_comment:
            if char == "*" and following == "/":
                block_comment = False
                index += 2
            else:
                index += 1
            continue
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            index += 1
            continue
        if char == "/" and following == "/":
            line_comment = True
            index += 2
            continue
        if char == "/" and following == "*":
            block_comment = True
            index += 2
            continue
        if char in "'\"`":
            quote = char
            index += 1
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[open_brace : index + 1]
        index += 1

    raise RenderError("Reveal.initialize configuration has an unclosed object")


def extract_reveal_dimensions(html_text: str) -> Viewport:
    initialize = REVEAL_INITIALIZE_RE.search(html_text)
    if not initialize:
        raise RenderError("HTML does not contain Reveal.initialize({...})")
    open_brace = html_text.find("{", initialize.end())
    if open_brace < 0:
        raise RenderError("Reveal.initialize call does not contain a configuration object")
    config = _balanced_object(html_text, open_brace)

    def numeric_property(name: str) -> int:
        pattern = re.compile(rf"(?:['\"]{name}['\"]|\b{name}\b)\s*:\s*([0-9]+(?:\.[0-9]+)?)")
        match = pattern.search(config)
        if not match:
            raise RenderError(f"Reveal configuration has no numeric {name}; pass --viewport-size")
        value = float(match.group(1))
        if value <= 0 or not value.is_integer():
            raise RenderError(
                f"Reveal configuration {name} must be a positive integer; pass --viewport-size"
            )
        return int(value)

    viewport = Viewport(numeric_property("width"), numeric_property("height"))
    _validate_viewport(viewport)
    return viewport


def render_viewport(html_text: str, override: Viewport | None, resolution_scale: int) -> Viewport:
    if override is not None:
        return override
    if resolution_scale < 1 or resolution_scale > 4:
        raise RenderError("resolution scale must be an integer from 1 to 4")
    source = extract_reveal_dimensions(html_text)
    scaled = Viewport(
        width=source.width * resolution_scale,
        height=source.height * resolution_scale,
    )
    _validate_viewport(scaled)
    return scaled


def validate_name_template(template: str) -> None:
    formatter = string.Formatter()
    allowed = {"stem", "mode"}
    try:
        parsed = list(formatter.parse(template))
    except ValueError as exc:
        raise RenderError(f"invalid output name template {template!r}: {exc}") from exc
    for _, field_name, format_spec, conversion in parsed:
        if field_name is None:
            continue
        if field_name not in allowed or format_spec or conversion:
            raise RenderError(
                f"invalid output name template {template!r}; only {{stem}} and "
                "{mode} fields without formatting are allowed"
            )
    rendered = template.format(stem="deck", mode="presentation")
    if not rendered or Path(rendered).name != rendered or not rendered.endswith(".pdf"):
        raise RenderError(
            f"invalid output name template {template!r}; it must produce a PDF basename"
        )


def output_path_for(
    html_path: Path,
    site_dir: Path,
    output_dir: Path,
    mode: RenderMode,
) -> Path:
    validate_name_template(mode.name_template)
    relative = html_path.relative_to(site_dir)
    filename = mode.name_template.format(stem=html_path.stem, mode=mode.name)
    return output_dir / relative.parent / filename


def normalize_query(query: str) -> str:
    query = query.lstrip("?")
    try:
        pairs = urllib.parse.parse_qsl(query, keep_blank_values=True, strict_parsing=True)
    except ValueError as exc:
        raise RenderError(f"invalid query string {query!r}: {exc}") from exc
    return urllib.parse.urlencode(sorted(pairs))


def deck_url(base_url: str, html_path: Path, site_dir: Path, query: str) -> str:
    relative = html_path.relative_to(site_dir).as_posix()
    encoded = urllib.parse.quote(relative, safe="/")
    normalized = normalize_query(query)
    return f"{base_url.rstrip('/')}/{encoded}" + (f"?{normalized}" if normalized else "")


def _local_reference_path(reference: str, base_file: Path, site_dir: Path) -> Path | None:
    reference = reference.strip()
    if not reference or reference.startswith(("#", "data:", "blob:")):
        return None
    parsed = urllib.parse.urlsplit(reference)
    if parsed.scheme or parsed.netloc:
        if parsed.scheme in {"mailto", "tel", "javascript"}:
            return None
        raise RenderError(
            f"offline render blocked external resource {reference!r} referenced by "
            f"{base_file.relative_to(site_dir)}"
        )
    decoded = urllib.parse.unquote(parsed.path)
    if not decoded:
        return None
    candidate = (
        site_dir / decoded.lstrip("/") if decoded.startswith("/") else base_file.parent / decoded
    )
    resolved = candidate.resolve()
    try:
        resolved.relative_to(site_dir)
    except ValueError as exc:
        raise RenderError(
            f"resource {reference!r} escapes site directory from {base_file.relative_to(site_dir)}"
        ) from exc
    if not resolved.is_file():
        raise RenderError(
            f"missing local resource {reference!r} referenced by {base_file.relative_to(site_dir)}"
        )
    return resolved


def css_references(css_text: str) -> list[str]:
    # Commented-out references must not fail the missing-resource preflight.
    css_text = CSS_COMMENT_RE.sub(" ", css_text)
    references = [match.group(2) for match in CSS_URL_RE.finditer(css_text)]
    references.extend(match.group(2) for match in CSS_IMPORT_RE.finditer(css_text))
    return references


def collect_asset_paths(html_path: Path, site_dir: Path) -> tuple[Path, ...]:
    site_dir = site_dir.resolve()
    html_path = html_path.resolve()
    html_text = html_path.read_text(encoding="utf-8")
    parser = _ResourceParser()
    parser.feed(html_text)
    if not parser.is_reveal or not REVEAL_INITIALIZE_RE.search(html_text):
        raise RenderError(f"not a rendered Reveal deck: {html_path.relative_to(site_dir)}")

    assets: set[Path] = {html_path}
    pending: list[Path] = []
    for reference in parser.references:
        path = _local_reference_path(reference, html_path, site_dir)
        if path is not None and path not in assets:
            assets.add(path)
            pending.append(path)
    for inline_css in parser.inline_css:
        for reference in css_references(inline_css):
            path = _local_reference_path(reference, html_path, site_dir)
            if path is not None and path not in assets:
                assets.add(path)
                pending.append(path)

    quarto_resource_dir = html_path.with_name(f"{html_path.stem}_files")
    if quarto_resource_dir.is_dir():
        for candidate in sorted(quarto_resource_dir.rglob("*")):
            if not candidate.is_file():
                continue
            resolved = candidate.resolve()
            try:
                resolved.relative_to(site_dir)
            except ValueError as exc:
                raise RenderError(f"resource file escapes site directory: {candidate}") from exc
            if resolved not in assets:
                assets.add(resolved)
                pending.append(resolved)

    examined_css: set[Path] = set()
    while pending:
        asset = pending.pop()
        if asset.suffix.lower() != ".css" or asset in examined_css:
            continue
        examined_css.add(asset)
        css_text = asset.read_text(encoding="utf-8")
        for reference in css_references(css_text):
            path = _local_reference_path(reference, asset, site_dir)
            if path is not None and path not in assets:
                assets.add(path)
                pending.append(path)

    return tuple(sorted(assets, key=lambda path: path.relative_to(site_dir).as_posix()))


def cache_digest(
    *,
    assets: Sequence[Path],
    site_dir: Path,
    mode: RenderMode,
    viewport: Viewport,
    renderer: RendererInfo,
    pause_ms: int,
    load_pause_ms: int,
    no_sandbox: bool,
    chrome_fingerprint: str | None,
    pipeline_source_hash: str,
) -> str:
    config = {
        "cache_schema": CACHE_SCHEMA,
        "pipeline_version": PIPELINE_VERSION,
        "pipeline_source_hash": pipeline_source_hash,
        "mode": mode.name,
        "query": normalize_query(mode.query),
        "name_template": mode.name_template,
        "viewport": viewport.as_decktape_arg(),
        "renderer_version": renderer.version,
        "dependency_lock_hash": renderer.dependency_lock_hash,
        "pause_ms": pause_ms,
        "load_pause_ms": load_pause_ms,
        "no_sandbox": no_sandbox,
        "chrome_fingerprint": chrome_fingerprint,
        "offline": True,
    }
    digest = hashlib.sha256()
    digest.update(json.dumps(config, sort_keys=True, separators=(",", ":")).encode())
    for asset in assets:
        relative = asset.relative_to(site_dir).as_posix().encode()
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        with asset.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_renderer(tools_dir: Path, override: Path | None) -> RendererInfo:
    repository_root = tools_dir.parent
    package_json_path = repository_root / "package.json"
    lock_candidates = (repository_root / "bun.lock", repository_root / "package-lock.json")
    lock_path = next((path for path in lock_candidates if path.is_file()), None)
    if not package_json_path.is_file() or lock_path is None:
        raise RenderError(
            "renderer metadata is incomplete; expected a root package.json and "
            "bun.lock or package-lock.json"
        )
    package_json = json.loads(package_json_path.read_text(encoding="utf-8"))
    expected_version = package_json.get("devDependencies", {}).get(
        "decktape", package_json.get("dependencies", {}).get("decktape")
    )
    if not isinstance(expected_version, str) or not re.fullmatch(
        r"\d+\.\d+\.\d+", expected_version
    ):
        raise RenderError("root package.json must pin an exact DeckTape version")

    if override is not None:
        executable = override.expanduser().resolve()
        if not executable.is_file() or not os.access(executable, os.X_OK):
            raise RenderError(f"DeckTape executable is not runnable: {executable}")
        version = f"override:{sha256_file(executable)}"
    else:
        executable = repository_root / "node_modules" / ".bin" / "decktape"
        installed_package = repository_root / "node_modules" / "decktape" / "package.json"
        if not executable.is_file() or not os.access(executable, os.X_OK):
            raise RenderError(
                "pinned DeckTape is not installed; run `bun install --frozen-lockfile` "
                "from the repository root before rendering"
            )
        if not installed_package.is_file():
            raise RenderError("installed DeckTape package metadata is missing")
        installed_version = json.loads(installed_package.read_text(encoding="utf-8")).get("version")
        if installed_version != expected_version:
            raise RenderError(
                f"installed DeckTape version {installed_version!r} does not match "
                f"the pinned version {expected_version!r}; run "
                "`bun install --frozen-lockfile`"
            )
        version = expected_version

    return RendererInfo(
        executable=executable,
        version=version,
        dependency_lock_hash=sha256_file(lock_path),
    )


def discover_decks(site_dir: Path, patterns: Sequence[str]) -> list[Path]:
    candidates: set[Path] = set()
    for pattern in patterns:
        candidates.update(path for path in site_dir.glob(pattern) if path.is_file())
    decks: list[Path] = []
    for candidate in sorted(candidates):
        try:
            text = candidate.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        parser = _ResourceParser()
        parser.feed(text)
        if parser.is_reveal and REVEAL_INITIALIZE_RE.search(text):
            decks.append(candidate.resolve())
    if not decks:
        joined = ", ".join(repr(pattern) for pattern in patterns)
        raise RenderError(f"no rendered Reveal HTML matched under {site_dir}: {joined}")
    return decks


def load_cache(path: Path) -> dict[str, object]:
    if not path.exists():
        return {"schema": CACHE_SCHEMA, "entries": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RenderError(f"cannot read PDF cache {path}: {exc}") from exc
    if data.get("schema") != CACHE_SCHEMA or not isinstance(data.get("entries"), dict):
        return {"schema": CACHE_SCHEMA, "entries": {}}
    return data


def save_cache(path: Path, cache: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(cache, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def build_decktape_command(
    *,
    renderer: RendererInfo,
    url: str,
    output_path: Path,
    viewport: Viewport,
    pause_ms: int,
    load_pause_ms: int,
    no_sandbox: bool,
    chrome_path: Path | None,
) -> list[str]:
    command = [
        str(renderer.executable),
        "reveal",
        url,
        str(output_path),
        "--size",
        viewport.as_decktape_arg(),
        "--pause",
        str(pause_ms),
        "--load-pause",
        str(load_pause_ms),
        "--chrome-arg=--disable-background-networking",
        "--chrome-arg=--disable-component-update",
        "--chrome-arg=--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
        "--chrome-arg=--proxy-server=http://127.0.0.1:9",
        "--chrome-arg=--proxy-bypass-list=localhost;127.0.0.1",
    ]
    if no_sandbox:
        command.append("--chrome-arg=--no-sandbox")
    if chrome_path is not None:
        command.extend(("--chrome-path", str(chrome_path)))
    return command


def render_pdf(
    *,
    renderer: RendererInfo,
    url: str,
    output_path: Path,
    viewport: Viewport,
    pause_ms: int,
    load_pause_ms: int,
    timeout_seconds: int,
    no_sandbox: bool,
    chrome_path: Path | None,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output_path.stem}.", suffix=".pdf", dir=output_path.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    temporary.unlink()
    command = build_decktape_command(
        renderer=renderer,
        url=url,
        output_path=temporary,
        viewport=viewport,
        pause_ms=pause_ms,
        load_pause_ms=load_pause_ms,
        no_sandbox=no_sandbox,
        chrome_path=chrome_path,
    )
    try:
        result = subprocess.run(
            command,
            check=False,
            timeout=timeout_seconds,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        if result.returncode != 0:
            detail = result.stdout.strip().splitlines()
            tail = "\n".join(detail[-12:])
            raise RenderError(
                f"DeckTape failed for {output_path.name} with exit "
                f"{result.returncode}" + (f":\n{tail}" if tail else "")
            )
        if not temporary.is_file() or temporary.stat().st_size < 5:
            raise RenderError(f"DeckTape did not create a non-empty PDF for {output_path.name}")
        with temporary.open("rb") as handle:
            if handle.read(5) != b"%PDF-":
                raise RenderError(f"DeckTape output is not a PDF for {output_path.name}")
        os.replace(temporary, output_path)
    except subprocess.TimeoutExpired as exc:
        raise RenderError(
            f"DeckTape timed out after {timeout_seconds}s for {output_path.name}"
        ) from exc
    finally:
        if temporary.exists():
            temporary.unlink()


def cache_key(html_path: Path, site_dir: Path, mode: RenderMode, output: Path) -> str:
    return "|".join(
        (
            html_path.relative_to(site_dir).as_posix(),
            mode.name,
            output.name,
        )
    )


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be an integer") from exc
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def resolve_chrome(path: Path | None) -> tuple[Path, str]:
    if path is None:
        configured = os.environ.get("CHROME_PATH") or os.environ.get("PUPPETEER_EXECUTABLE_PATH")
        if configured:
            path = Path(configured)

    if path is None:
        command = next(
            (
                candidate
                for name in (
                    "google-chrome",
                    "google-chrome-stable",
                    "chromium",
                    "chromium-browser",
                )
                if (candidate := shutil.which(name)) is not None
            ),
            None,
        )
        if command is not None:
            path = Path(command)

    if path is None and sys.platform == "darwin":
        for candidate in (
            Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            Path("/Applications/Chromium.app/Contents/MacOS/Chromium"),
        ):
            if candidate.is_file() and os.access(candidate, os.X_OK):
                path = candidate
                break

    if path is None:
        raise RenderError(
            "no Chrome or Chromium executable found; pass --chrome-path or set "
            "CHROME_PATH (the bun install does not download a Puppeteer browser)"
        )
    resolved = path.expanduser().resolve()
    if not resolved.is_file() or not os.access(resolved, os.X_OK):
        raise RenderError(f"Chrome executable is not runnable: {resolved}")
    return resolved, sha256_file(resolved)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Render reproducible presentation and notes-handout PDFs from an "
            "already-rendered Reveal site."
        )
    )
    parser.add_argument("--site-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--glob", action="append", dest="globs")
    parser.add_argument("--mode", choices=("both", "presentation", "handout"), default="both")
    parser.add_argument("--presentation-name")
    parser.add_argument("--handout-name")
    parser.add_argument("--presentation-query", default=DEFAULT_PRESENTATION_QUERY)
    parser.add_argument("--handout-query", default=DEFAULT_HANDOUT_QUERY)
    parser.add_argument("--viewport-size", type=parse_viewport)
    parser.add_argument("--resolution-scale", type=positive_int, default=DEFAULT_RESOLUTION_SCALE)
    parser.add_argument("--pause-ms", type=positive_int, default=250)
    parser.add_argument("--load-pause-ms", type=positive_int, default=1000)
    parser.add_argument("--timeout-seconds", type=positive_int, default=300)
    parser.add_argument("--cache-file", type=Path)
    parser.add_argument("--decktape", type=Path)
    parser.add_argument("--chrome-path", type=Path)
    parser.add_argument("--no-sandbox", action="store_true")
    parser.add_argument("--force", action="store_true")
    return parser.parse_args(argv)


def configured_modes(args: argparse.Namespace) -> list[RenderMode]:
    presentation_name = args.presentation_name or DEFAULT_PRESENTATION_NAME
    handout_name = args.handout_name or DEFAULT_HANDOUT_NAME
    modes = {
        "presentation": RenderMode(
            "presentation", normalize_query(args.presentation_query), presentation_name
        ),
        "handout": RenderMode("handout", normalize_query(args.handout_query), handout_name),
    }
    for mode in modes.values():
        validate_name_template(mode.name_template)
    if args.mode == "both":
        return [modes["presentation"], modes["handout"]]
    return [modes[args.mode]]


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        site_dir = args.site_dir.resolve()
        if not site_dir.is_dir():
            raise RenderError(f"site directory does not exist: {site_dir}")
        output_dir = (args.output_dir or site_dir).resolve()
        output_dir.mkdir(parents=True, exist_ok=True)
        globs = args.globs or [DEFAULT_GLOB]
        modes = configured_modes(args)
        tools_dir = Path(__file__).resolve().parent
        renderer = resolve_renderer(tools_dir, args.decktape)
        chrome_path, chrome_fingerprint = resolve_chrome(args.chrome_path)
        cache_file = (args.cache_file or (site_dir / DEFAULT_CACHE_FILE)).resolve()
        cache = load_cache(cache_file)
        entries = cache["entries"]
        assert isinstance(entries, dict)
        decks = discover_decks(site_dir, globs)
        pipeline_source_hash = sha256_file(Path(__file__).resolve())

        work: list[tuple[Path, RenderMode, Path, Viewport, str]] = []
        for html_path in decks:
            html_text = html_path.read_text(encoding="utf-8")
            viewport = render_viewport(html_text, args.viewport_size, args.resolution_scale)
            assets = collect_asset_paths(html_path, site_dir)
            for mode in modes:
                output = output_path_for(html_path, site_dir, output_dir, mode)
                digest = cache_digest(
                    assets=assets,
                    site_dir=site_dir,
                    mode=mode,
                    viewport=viewport,
                    renderer=renderer,
                    pause_ms=args.pause_ms,
                    load_pause_ms=args.load_pause_ms,
                    no_sandbox=args.no_sandbox,
                    chrome_fingerprint=chrome_fingerprint,
                    pipeline_source_hash=pipeline_source_hash,
                )
                key = cache_key(html_path, site_dir, mode, output)
                cached = entries.get(key)
                if (
                    not args.force
                    and output.is_file()
                    and isinstance(cached, dict)
                    and cached.get("digest") == digest
                ):
                    print(
                        f"unchanged {html_path.relative_to(site_dir)} [{mode.name}], skipping",
                        flush=True,
                    )
                    continue
                work.append((html_path, mode, output, viewport, digest))

        if not work:
            return 0

        with LocalSiteServer(site_dir) as server:
            for html_path, mode, output, viewport, digest in work:
                url = deck_url(server.base_url, html_path, site_dir, mode.query)
                print(
                    f"rendering {html_path.relative_to(site_dir)} [{mode.name}] "
                    f"-> {output.relative_to(output_dir)} "
                    f"({viewport.as_decktape_arg()})",
                    flush=True,
                )
                render_pdf(
                    renderer=renderer,
                    url=url,
                    output_path=output,
                    viewport=viewport,
                    pause_ms=args.pause_ms,
                    load_pause_ms=args.load_pause_ms,
                    timeout_seconds=args.timeout_seconds,
                    no_sandbox=args.no_sandbox,
                    chrome_path=chrome_path,
                )
                key = cache_key(html_path, site_dir, mode, output)
                entries[key] = {
                    "digest": digest,
                    "output": output.relative_to(output_dir).as_posix(),
                    "mode": mode.name,
                }
                save_cache(cache_file, cache)
        return 0
    except RenderError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: filesystem or renderer configuration failure: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("error: interrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
