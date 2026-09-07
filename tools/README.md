# Reveal PDF tools

The canonical renderer and its exact DeckTape lockfile ship inside
`_extensions/altmejd-slides/tools/pdf/`. The repository's `tools/` entry point
delegates to that implementation. Installed starter decks use the same code.

Install the renderer once, explicitly allowing the locked package download:

```sh
make pdf-setup
```

This requires Bun and does not download a browser or run dependency install
scripts. Install Chrome or Chromium separately. After setup, a starter deck's
single-command render and export is:

```sh
make pdf
```

For a Quarto project with `output-dir: _site`, use
`make pdf PDF_SITE_DIR=_site`. Extra capture options go in `PDF_ARGS`, for example
`make pdf PDF_ARGS="--mode presentation"`. PDF setup is separate so ordinary
capture never installs packages or downloads a renderer.
The Makefile detects a Quarto project or the sole top-level QMD. With several
standalone decks, choose one with `DECK_INPUT=talk.qmd` and restrict capture with
`PDF_ARGS="--glob talk.html"`.

To capture already-rendered HTML without re-executing Quarto:

```sh
python tools/render_revealjs_pdfs.py --site-dir _site
```

In an installed deck, replace the script path with
`_extensions/altmejd-slides/tools/pdf/render_revealjs_pdfs.py` (or
`_extensions/OWNER/altmejd-slides/tools/pdf/render_revealjs_pdfs.py` when Quarto
uses an owner namespace). Both paths work with the starter Makefile.

The default outputs are `NAME-slides.pdf` and `NAME-handout.pdf`. Use
`--presentation-name` or `--handout-name` when a deck needs another basename.

The script derives each viewport from the numeric `width` and `height` in the
rendered `Reveal.initialize` configuration and renders at 2x resolution. Use
`--viewport-size WIDTHxHEIGHT` only for decks whose configuration does not have
numeric dimensions.

Rendering is offline: fetchable external resources fail preflight, and Chromium
network resolution is disabled except for the loopback site server. Package
fonts, images, scripts, stylesheets, and other resources into the rendered site.
DeckTape is always invoked from the PDF tool's own `node_modules` installation,
pinned by its adjacent `package.json` and `bun.lock`. The renderer never falls
back to a networked package runner.

The renderer uses `CHROME_PATH`, `PUPPETEER_EXECUTABLE_PATH`, or a common system
Chrome/Chromium installation when one is available, and fails fast when none is
found (bun does not run Puppeteer's browser-download install script). Pass
`--chrome-path /path/to/chrome` to choose explicitly. The selected executable's
fingerprint becomes part of the PDF cache key.

The default mode queries are:

- presentation: `pdf=slides&pdfSeparateFragments=false`
- handout: `pdf=handout&handout=true&pdfSeparateFragments=false`

DeckTape runs under WebDriver, which keeps `quarto-slide-remote` silent. The
query keys also let the extension configure `disable-on-params: [pdf, handout]`.

The cache follows static local HTML, SVG, and CSS references, including nested
iframe figures. It also hashes the full Quarto `NAME_files` and shared
`site_libs` dependency directories. It bypasses caching for scripted embedded
documents and JavaScript outside those dependency trees because their dynamic
resource dependencies cannot be determined safely. Top-level custom code that
loads data outside the bundled tree, or content that depends on time, should
use `PDF_ARGS="--no-cache"`. No cache scan reads the entire deck project.

Run the stdlib test suite with:

```sh
python -m unittest discover -s tools/tests -v
```
