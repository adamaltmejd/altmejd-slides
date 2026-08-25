# Architecture

`altmejd-slides` is a personal, static-first Quarto Reveal format. It has one
default design rather than research and teaching presets.

## Repository boundaries

1. `_extensions/altmejd-slides/` is the complete installable format.
2. `template.qmd` is the canonical copyable starting point.
3. `examples/showcase.qmd` is the canonical synthetic research-talk fixture
   for visual development and full-slide browser sweeps.
4. `tests/fixtures/` contains adversarial limits and deck-wide agenda variants.
5. `tools/` renders already-built Reveal HTML into reproducible PDFs.

Repository tooling, examples, tests, and documentation are excluded from
starter-template output by `.quartoignore`. Ordinary `quarto add` already
copies only the extension directory.

GitHub is the distribution and release boundary. Quarto installs the public
repository directly and vendors the extension into each consuming project.
Version tags provide stable checkpoints without an additional package
registry.

## Configuration contract

Quarto-native presentation options stay under
`format.altmejd-slides-revealjs`. Extension-specific choices use one
namespaced block:

```yaml
altmejd-slides:
  colors: {}
  agenda: {}
  math: true
```

The Sass theme contains the default palette and structural rules as CSS custom
properties. The Lua filter validates YAML colors and emits only accepted
overrides. Those overrides are the author-facing color API; internal Sass
tokens are not a compatibility surface.

The format converts Pandoc math nodes to stable TeX-bearing spans and renders
them with a vendored KaTeX build. KaTeX JavaScript, CSS, and fonts are copied as
a normal Quarto HTML dependency, so equation rendering never depends on a CDN.

Text typography follows the same rule: Schibsted Grotesk and JetBrains Mono
are vendored as variable WOFF2 subsets (latin and latin-ext, upright and
italic) with their OFL licenses in `resources/fonts/`, registered as an HTML
dependency. The system stacks remain as fallbacks only; rendered decks and
captured PDFs use the bundled faces on every host.

An appendix boundary — the first level-one heading with identifier or class
`appendix` — makes the filter set Reveal's native `visibility="uncounted"` on
every subsequent slide heading that lacks its own visibility attribute. Reveal
then excludes those slides from the slide-number total and freezes the shown
count, while navigation, speaker notes, and PDF capture treat them as normal
slides. No custom counter code is involved.

Automatic agendas are on by default, without a visible heading or list markers.
The same Lua filter collects level-one headings, inserts the configured agenda
content for each section divider, and treats direct section content as a kicker.
It also recognizes the narrow, semantic
case of two Quarto columns that each contain a figure and enriches them with
the extension's fill-height panel class. Because Quarto skips its own
auto-stretch on any slide carrying an `::: {.aside}`, the filter restores it
for a slide whose only figure is a top-level image: a bare image takes the
stretch class, while a captioned or linked one keeps its wrapper and takes the
fill-height layout class instead. `auto-stretch: false` disables both. It does
not replace Quarto's slide construction.

The remaining slide primitives are pure theme contracts with no Lua
involvement: `.statement`, `.closing-slide`, and `.full-bleed` are slide
classes, `.stat-row`, `.table-note`, and `.emph` are content classes, and
callouts restyle Quarto's native callout markup in place. One exception: a
`.table-note` that directly follows a table is a sibling of the element it
annotates, so the filter pairs the two in a `.table-with-note` wrapper. The
wrapper shrinks to the table, the note spans it exactly, and a container
query switches a note wider than the standalone 30em clamp to ragged-right.
A note with no preceding table keeps the pure-theme centered styling. Mode gating
(`.handout-only`, `.live-only`) rides on the `altmejd-handout` root class the
runtime already maintains. The intent behind these primitives and the palette
is recorded in `docs/design.md`.

The one generated asset is the QR code: a `{.qr}` link is encoded at render
time by the vendored `qrencode.lua` (speedata/luaqrcode, BSD-3, license in
the file header) and embedded as an SVG data URI with its four-module quiet
zone inside the image. Like KaTeX and the typefaces, this keeps rendering
offline; the encoder loads lazily, so decks without QR links never touch it.

## Browser behavior

Browser code is source-controlled and external to the Lua filter. The runtime
always measures direct-child visible asides and reserves their space. Under
`?handout=true` it also exposes direct-child speaker notes, measures them, and
reserves the combined note-and-aside space.

Reveal assigns lazy `data-src` image sources when a slide comes within view
distance, so the network request often fires at reveal time — and neither the
browser nor Reveal retries a failure, which would leave the slide blank on a
flaky network. The runtime re-requests broken images on the current slide:
immediately at reveal, on a short backoff, and when the browser comes back
online. A successful retry reruns Reveal's stretch layout.

Reveal's stretch sizing measures synchronously, so any CSS transition on
layout properties poisons it: the theme's reduced-motion rule once created
`transition: all 0.01ms` on every element (the common accessibility snippet
activates the default `transition-property: all`), which collapsed stretch
images to zero on any OS reporting reduced motion — Windows with animation
effects off, macOS Reduce Motion. Reduced motion therefore disables
transitions entirely, and CI drives every browser check under real Edge on
a Windows runner, whose reduced-motion environment caught the bug. As
defense in depth, a watchdog heals a loaded stretch image rendering at
near-zero height despite free space by requesting a fresh layout, appending
a geometry snapshot to `window.__altmejdDiag` for diagnosis.

The runtime disables Reveal 5.1's automatic narrow-screen scroll view. Quarto's
vertical section stacks are otherwise promoted to extra scroll pages and break
the title and panel layouts. Phones therefore receive the intact scaled slide
canvas; landscape orientation is the useful review mode.

Slide Remote 0.5.3 is embedded using Quarto's extension mechanism and enabled
by the format. Its filter and Reveal plugin remain separate from theme code;
the bundle is updated intentionally from its upstream repository rather than
forked in place.

The public showcase omits `slide-remote.worker-url`. The plugin still loads,
but exits before creating a session or opening a WebSocket. Personal decks
configure the Worker URL in their own YAML.

Quarto's Reveal instance remains authoritative. A future interactive React
component may mount inside a slide, but it must ship as a prebuilt island with
a deterministic static/PDF state. `@revealjs/react` does not own the deck.

## PDF contract

Quarto produces HTML once. The repository PDF tool consumes that HTML without
re-executing the document and produces:

- `slides`: final fragment state, notes hidden;
- `handout`: final fragment state, notes visible.

The renderer uses pinned DeckTape in normal Reveal mode. Cache identity covers
the HTML, referenced local assets, the Quarto dependency tree, mode, viewport,
renderer configuration, lockfile, and browser fingerprint.

Presentation PDFs are visual artifacts, not guaranteed PDF/UA documents. A
paper-like tagged handout would be a separate output format.

## Public preview

CI renders the showcase once, copies its HTML to `index.html` beside the same
relative asset tree, and deploys that directory to GitHub Pages after all
validation passes. Pages therefore previews the tested artifact without a
second site framework or a checked-in build directory.

## Cloudflare publishing

Publishing is an explicit external action, never a render side effect. The
publisher lives at `_extensions/altmejd-slides/tools/publish-cloudflare.ts`
so it ships with `quarto add`, and runs on Quarto's bundled Deno via
`quarto run`; the starter-template `Makefile` provides the `make publish`
wrapper because `quarto add` copies only the extension directory. Each deck
deploys as an independent Static Assets Worker (`altmejd-slides-<slug>`) on
zone routes beneath a gateway Custom Domain, so one talk's republish cannot
replace another's assets. Pure decisions (slug and target resolution, HTML
asset scanning, staging plans, wrangler configs) sit in
`tools/publish/core.ts` with no Deno APIs, tested by `bun test`; the effects
are exercised end-to-end against a mocked wrangler by
`tools/test_publish_integration.sh`, and `tools/check_published_prefix.mjs`
proves a staged deck still works beneath a non-root path prefix. Operational
details live in `docs/publishing.md`.

## Compatibility policy

CI pins the latest stable Quarto release adopted by this repository. The theme
uses standard Reveal DOM conventions and public events so Quarto, PDF capture,
speaker notes, and Slide Remote share one slide tree. There is no migration or
backward-compatibility layer for earlier course themes.
