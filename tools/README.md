# Reveal PDF tools

Install the renderer once from the repository's committed lockfile:

```sh
bun install --frozen-lockfile
```

Render both PDF variants from an already-rendered Quarto site:

```sh
python tools/render_revealjs_pdfs.py --site-dir _site
```

The default outputs are `NAME-slides.pdf` and `NAME-handout.pdf`. Use
`--presentation-name` or `--handout-name` when a deck needs another basename.

The script derives each viewport from the numeric `width` and `height` in the
rendered `Reveal.initialize` configuration and renders at 2x resolution. Use
`--viewport-size WIDTHxHEIGHT` only for decks whose configuration does not have
numeric dimensions.

Rendering is offline: fetchable external resources fail preflight, and Chromium
network resolution is disabled except for the loopback site server. Package
fonts, images, scripts, stylesheets, and other resources into the rendered site.
DeckTape is always invoked from the root `node_modules` installation pinned by
`package.json` and `bun.lock`; the renderer never falls back to a networked
package runner.

The renderer uses `CHROME_PATH`, `PUPPETEER_EXECUTABLE_PATH`, or a common system
Chrome/Chromium installation when one is available; otherwise DeckTape uses the
browser installed with Puppeteer. Pass `--chrome-path /path/to/chrome` to choose
explicitly. The selected executable's fingerprint becomes part of the PDF
cache key.

The default mode queries are:

- presentation: `pdf=slides&pdfSeparateFragments=false`
- handout: `pdf=handout&handout=true&pdfSeparateFragments=false`

DeckTape runs under WebDriver, which keeps `quarto-slide-remote` silent. The
query keys also let the extension configure `disable-on-params: [pdf, handout]`.

Run the stdlib test suite with:

```sh
python -m unittest discover -s tools/tests -v
```
