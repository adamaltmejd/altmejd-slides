# Architecture

`altmejd-slides` is a personal, static-first Quarto Reveal format. It has one
default design rather than research and teaching presets.

## Repository boundaries

1. `_extensions/altmejd-slides/` is the complete installable format.
2. `template.qmd` is the canonical copyable starting point.
3. `examples/showcase.qmd` is the visual reference deck.
4. `tests/fixtures/` contains adversarial compatibility cases.
5. `tools/` renders already-built Reveal HTML into reproducible PDFs.

Repository tooling, examples, tests, and documentation are excluded from
starter-template output by `.quartoignore`. Ordinary `quarto add` already
copies only the extension directory.

## Configuration contract

Quarto-native presentation options stay under
`format.altmejd-slides-revealjs`. Extension-specific choices use one
namespaced block:

```yaml
altmejd-slides:
  colors: {}
  agenda: {}
```

The Sass theme contains the default palette and structural rules as CSS custom
properties. The Lua filter validates YAML colors and emits only accepted
overrides. Those overrides are the author-facing color API; internal Sass
tokens are not a compatibility surface.

Automatic agendas are on by default. The same Lua filter collects level-one
headings and inserts a standard Pandoc list for each section divider. It does
not replace Quarto's slide construction.

## Browser behavior

Browser code is source-controlled and external to the Lua filter. The handout
runtime activates only for `?handout=true`, exposes direct-child speaker notes,
measures note and aside boxes, and reserves their combined space.

Slide Remote 0.5.3 is embedded using Quarto's extension mechanism and enabled
by the format. Its filter and Reveal plugin remain separate from theme code;
the bundle is updated intentionally from its upstream repository rather than
forked in place.

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

## Compatibility policy

CI pins the latest stable Quarto release adopted by this repository. The theme
uses standard Reveal DOM conventions and public events so Quarto, PDF capture,
speaker notes, and Slide Remote share one slide tree. There is no migration or
backward-compatibility layer for earlier course themes.
