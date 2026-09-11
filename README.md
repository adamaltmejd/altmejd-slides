# Altmejd Slides

`altmejd-slides` is Adam Altmejd Selder's personal Quarto Reveal format for
research talks and lectures. It has one opinionated default design, built
around a burgundy, cream, coral, and slate palette, and a small YAML surface
for the choices that should vary between decks.

Quarto and Pandoc remain responsible for document processing and slide
construction. The extension adds the theme, automatic section agendas,
speaker-note handouts, a document reading view, an optional slide check, and a
pinned copy of
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
quarto add adamaltmejd/altmejd-slides@v0.8.0
```

The lean starter lives in [`template.qmd`](template.qmd). Its defaults are
ready to use; the [authoring guide](docs/authoring.md) contains recipes and
optional settings. Existing decks installed with `quarto add` can copy the
starter's [Makefile](Makefile) for the workflow commands below.

## Preview

The current showcase is published at
[adamaltmejd.github.io/altmejd-slides](https://adamaltmejd.github.io/altmejd-slides/).
It uses the real extension but deliberately leaves Slide Remote unconfigured,
so opening the public preview does not allocate a remote-control session.

## Publish a talk

Decks publish deliberately to `https://slides.altmejd.se/<slug>/` with

```sh
make publish
```

Each talk becomes its own Cloudflare Static Assets Worker behind a shared
gateway domain, so republishing one talk never touches another, and rendering
or previewing never deploys anything. After the talk, remove its Worker and
routes with `make unpublish`. A separately deployed gateway can list published
decks at the domain root by reading their Cloudflare routes. Both the deck
publisher and the gateway support your own hostname.
Setup, authentication, rollback, and the guarded
unpublish workflow are documented in [docs/publishing.md](docs/publishing.md).

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
    heading: false # false by default, or any text
    bullets: none # none by default; bullet and numbered are available
    clickable: false
    include-appendix: false
```

Valid color overrides are emitted as CSS custom properties after the compiled
theme. Omitted values inherit the defaults. Invalid values produce a warning
and are ignored. Add `.no-agenda` to an individual level-one heading to omit
its generated agenda slide, or set `agenda.enabled: false` for the whole deck.

A `# Appendix` section (or any level-one heading carrying `.appendix`) marks
the start of backup material: every slide from there on is excluded from the
slide counter, so the total reflects the talk and the number freezes while
presenting appendix slides. The slides themselves remain fully navigable and
appear in PDFs; an explicit `visibility` attribute on a slide still wins.
Appendix sections are omitted from the main agenda by default. Set
`agenda.include-appendix: true` to include them. The current section has a
visual marker and an accessible `aria-current` state.

Keep native Reveal and Quarto settings—such as footer, logo, dimensions,
transition, and slide numbers—under the format rather than duplicating them in
`altmejd-slides`.

## Authoring and reading

Use a heading that states the evidence, a legible figure or table, and a short
qualification. The extension provides figures and panels, statement slides,
statistic rows, callouts, source notes, navigation, and closing slides. Copy
complete recipes from the [authoring guide](docs/authoring.md); the
[design guide](docs/design.md) explains the palette and typography.

Figures remain centered by default. `.nostretch` preserves deliberate sizing,
and `.no-figure-panels` keeps native columns when the automatic equal-panel
layout is inappropriate. Separate navigation groups share one dock without
losing their `.handout-only` or `.live-only` gates. Generated QR codes remain
clickable links as well as scannable images.
Mode gates control display; hidden content remains in the delivered HTML.

Open `talk.html?reading=true` to read the final slide content as a flowing
document. Add `&handout=true` to include speaker notes. **Read slides** is also
available in the slide menu and on narrow screens; **Present slides** returns
to the presentation. The reading view includes a browser print option.

Before presenting, open `talk.html?check=true`. The optional local report
finds slide overflow, clipped code or notes, missing image alt attributes,
broken images, and broken internal links. Use `?handout=true&check=true` to
check the handout too. It checks these specific conditions; visual review and
judgment about content and accessibility still matter.

The format bundles Schibsted Grotesk, JetBrains Mono, and KaTeX 0.18.7. Text and
math therefore need no font or renderer CDN. To select a different math
renderer, set `altmejd-slides.math: false` and choose Quarto's
`html-math-method`.

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
normal Reveal plugin API. PDF, handout, reading, and check modes keep the
remote silent. The extension adds `reading` and `check` to the disabled
parameters while preserving any custom entries.

## HTML and PDFs

A starter deck supports these commands:

```sh
make preview
make pdf-setup   # one-time installation of the locked capture tools
make pdf         # render and capture the deck
```

PDF setup requires Bun; capture requires an installed Chrome or Chromium.
After setup, capture uses the pinned local DeckTape and stays offline.
It does not install packages or download a browser. For a project that renders
to `_site`, run `make pdf PDF_SITE_DIR=_site`.

Each deck produces `NAME-slides.pdf` without speaker notes and
`NAME-handout.pdf` with notes. Both retain the final fragment state. The
renderer captures normal Reveal mode, derives the viewport from the deck,
preflights local assets, blocks network access, writes atomically, and caches
the two modes independently. See the [PDF tool guide](tools/README.md) for
output options and capture of already-rendered HTML.

## Development

```sh
bun install --frozen-lockfile
bun run check
bun run render:examples
```

[`examples/showcase.qmd`](examples/showcase.qmd) is the canonical visual
development deck: a fully synthetic research talk covering the normal title,
agenda, text, math, table, figure, note, handout, and appendix-navigation
surface. Its committed SVGs require no computation or network access. The
browser check visits every slide in desktop, narrow, and handout modes.

[`tests/fixtures/regression.qmd`](tests/fixtures/regression.qmd) keeps only
adversarial limits such as unusually long metadata, navigation, and code. The
authoring fixture checks combinations such as gated navigation, fixed-size
figures with notes, and clickable QR codes. The agenda fixtures cover deck-wide
variants and an eleven-section outline with appendix inclusion enabled. The
supported baseline is the Quarto version pinned in CI; a large
consumer deck is an occasional release soak test, not the routine design fixture.

The architecture and public boundaries are recorded in
[`docs/architecture.md`](docs/architecture.md).

## Releases

Quarto copies extensions into each consuming project, so releases are simple
checkpoints rather than a separate package registry. The version in
`_extensions/altmejd-slides/_extension.yml` is tagged as `vX.Y.Z`; GitHub
Releases records the notes, and consuming decks can opt into that tag. The
root `package.json` remains private to prevent accidental npm publication—its
tools are for developing the Quarto extension, not a JavaScript package.
