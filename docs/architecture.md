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

Automatic agendas are on by default, without a visible heading or list markers.
The same Lua filter collects level-one headings, inserts the configured agenda
content for each section divider, and treats direct section content as a kicker.
It also recognizes the narrow, semantic
case of two Quarto columns that each contain a figure and enriches them with
the extension's fill-height panel class. It does not replace Quarto's slide
construction.

## Browser behavior

Browser code is source-controlled and external to the Lua filter. The runtime
always measures direct-child visible asides and reserves their space. Under
`?handout=true` it also exposes direct-child speaker notes, measures them, and
reserves the combined note-and-aside space.

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

## Compatibility policy

CI pins the latest stable Quarto release adopted by this repository. The theme
uses standard Reveal DOM conventions and public events so Quarto, PDF capture,
speaker notes, and Slide Remote share one slide tree. There is no migration or
backward-compatibility layer for earlier course themes.
