# Altmejd Slides

`altmejd-slides` is Adam Altmejd Selder's personal Quarto Reveal format for
research talks and lectures. It has one opinionated default design, built
around a burgundy, cream, coral, and slate palette, and a small YAML surface
for the choices that should vary between decks.

Quarto and Pandoc remain responsible for document processing and slide
construction. The extension adds the theme, automatic section agendas,
speaker-note handouts, and a pinned copy of
[`quarto-slide-remote`](https://github.com/adamaltmejd/quarto-slide-remote).

## Start a deck

Create a new deck directly from the public starter template:

```sh
quarto use template adamaltmejd/altmejd-slides
```

To add or update only the extension in an existing Quarto project:

```sh
quarto add adamaltmejd/altmejd-slides
quarto update adamaltmejd/altmejd-slides
```

Pin a deck to a released extension when reproducibility matters:

```sh
quarto add adamaltmejd/altmejd-slides@v0.1.0
```

The complete copyable front matter lives in [`template.qmd`](template.qmd).

## Preview

The current showcase is published at
[adamaltmejd.github.io/altmejd-slides](https://adamaltmejd.github.io/altmejd-slides/).
It uses the real extension but deliberately leaves Slide Remote unconfigured,
so opening the public preview does not allocate a remote-control session.

## Configure it

The built-in palette and automatic section agendas are defaults. A deck can
override only what it needs:

```yaml
format:
  altmejd-slides-revealjs:
    footer: "Project · Institution"
    transition: none
    width: 1600
    height: 900

altmejd-slides:
  colors:
    primary: "#0057b8"
    secondary: "#f4d35e"
    accent: "#d1495b"
  agenda:
    enabled: true
    heading: Outline
    bullets: numbered # bullet, numbered, or none
    clickable: false
```

Valid color overrides are emitted as CSS custom properties after the compiled
theme. Omitted values inherit the defaults. Invalid values produce a warning
and are ignored. Add `.no-agenda` to an individual level-one heading to omit
its generated agenda slide, or set `agenda.enabled: false` for the whole deck.

Keep native Reveal and Quarto settings—such as footer, logo, dimensions,
transition, and slide numbers—under the format rather than duplicating them in
`altmejd-slides`.

## Slide Remote

Slide Remote 0.5.3 is embedded and loaded by the format. It remains dormant
until a deck supplies its Worker URL:

```yaml
slide-remote:
  worker-url: https://slide-remote.adamaltmejd.workers.dev
  show-button: false
  disable-on-params: [pdf, handout]
```

The theme preserves direct-child headings, `aside.notes`, fragments, and the
normal Reveal plugin API. The PDF queries keep the remote silent during
capture.

## HTML and PDFs

Install the locked development tools and render the showcase:

```sh
bun install --frozen-lockfile
bun run render:examples
bun run pdf:examples
```

Each deck produces two artifacts:

- `NAME-slides.pdf`: final-state slides without speaker notes;
- `NAME-handout.pdf`: the same slides with speaker notes visible.

The renderer captures normal Reveal mode with pinned DeckTape rather than
Reveal's browser print layout. It derives the viewport from the deck,
preflights local assets, blocks network access, writes atomically, and caches
the two modes independently. See [`tools/README.md`](tools/README.md).

## Development

```sh
bun run check
bun run render:examples
```

[`examples/showcase.qmd`](examples/showcase.qmd) is the visual reference.
[`tests/fixtures/regression.qmd`](tests/fixtures/regression.qmd) contains the
adversarial layout and configuration cases. The supported baseline is the
Quarto version pinned in CI.

The architecture and public boundaries are recorded in
[`docs/architecture.md`](docs/architecture.md).

## Releases

Quarto copies extensions into each consuming project, so releases are simple
checkpoints rather than a separate package registry. The version in
`_extensions/altmejd-slides/_extension.yml` is tagged as `vX.Y.Z`; GitHub
Releases records the notes, and consuming decks can opt into that tag. The
root `package.json` remains private to prevent accidental npm publication—its
tools are for developing the Quarto extension, not a JavaScript package.
