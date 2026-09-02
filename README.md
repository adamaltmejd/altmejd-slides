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
quarto add adamaltmejd/altmejd-slides@v0.7.0
```

The complete copyable front matter lives in [`template.qmd`](template.qmd).

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
routes with `make unpublish`. Setup, authentication, rollback, and the guarded
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

Keep native Reveal and Quarto settings—such as footer, logo, dimensions,
transition, and slide numbers—under the format rather than duplicating them in
`altmejd-slides`.

## Research-slide primitives

Ordinary two-column slides are automatically upgraded to fill-height figure
panels when both columns contain an image. A short panel label, the image, and
an optional internal-link row are enough:

Standalone figures are centered by default. Use `fig-align="left"` or
`fig-align="right"` on an individual image when its alignment should differ;
`.r-stretch` controls sizing independently and is not needed for centering.

```markdown
:::: {.columns}
::: {.column width="50%"}
**Women**

![](women.svg)
:::
::: {.column width="50%"}
**Men**

![](men.svg)
:::
::::

[Number of children](#number-of-children)
```

Use `.figure-panels` explicitly for a one-panel layout or to make the intent
clear. Its direct children may be ordinary `.column` elements or
`.figure-panel` elements. Images preserve their aspect ratio, panel headings
align, and the filter reserves the bottom link row.

Use `.slide-nav` for compact internal navigation. Add `.back` to a return link
or `.primary` only when an action genuinely needs emphasis. The quiet action row
is fixed to the bottom-right footer line, after visible asides and handout notes,
and wraps when needed:

```markdown
::: {.slide-nav}
[Main result](#main-result){.back}
[Women](#women)
[Men](#men)
[Robustness](#robustness)
:::
```

A statement slide carries one takeaway. Add `.statement` to the slide heading
and it becomes a quiet uppercase kicker above the payload — a short bold
sentence, a `.stat-row`, or both. A `.stat-row` holds one to three
number-plus-label pairs; each pair is one paragraph with the `.stat` span
first, and wrapping the number in `**strong**` gives it the accent ink. The
row also works at a smaller scale on ordinary slides:

```markdown
## The headline result {.statement}

::: {.stat-row}
[**+0.18**]{.stat} courses completed per term at the threshold
:::
```

Quarto's native callouts are the semantic box family, restyled to the palette
with their icons removed: `.callout-note` for definitions, `.callout-tip` for
results, `.callout-important` for identifying assumptions, and
`.callout-warning` or `.callout-caution` for caveats. Callouts keep a solid
light surface on `.dark-bg` slides.

Figure build-ups use Reveal's `.r-stack` with `.fragment` layers. Export
layers that share the same base image so each fragment reads as adding to the
plot; both PDF variants keep only the final state:

```markdown
::: {.r-stack}
![](points.svg)

![](points-plus-fit.svg){.fragment}
:::
```

A full-bleed slide puts one image behind the whole canvas. The heading and an
optional caption paragraph sit on fixed scrim chips, the attribution becomes a
bottom-right credit chip, and the footer and slide number yield:

```markdown
## The space itself {.full-bleed background-image="scene.jpg" background-size="cover"}

One caption line.

::: {.attribution}
Image credit
:::
```

A closing slide bookends the cover on the divider surface. `.closing-slide`
reuses the title rule, enlarges the heading, and anchors the contact
paragraphs at the bottom above the same hairline the author grid uses. A
`{.qr}` link renders as a scannable QR code docked top-right — generated at
render time by a vendored offline encoder, with the link text as alt text:

```markdown
## Thank you {.closing-slide}

name\@university.edu · [example.org](https://example.org)

[QR code for the paper](https://example.org/paper){.qr}
```

Content can be gated to one delivery mode: `.handout-only` blocks appear only
under `?handout=true` and in the handout PDF, while `.live-only` blocks
disappear there. Tables set tabular figures for aligned columns; a
`.table-note` div directly under a table renders a quiet source note spanning
exactly the table's width (long notes under wide tables left-align instead of
wrapping into a centered stack), and an
`[0.18]{.emph}` span puts a quiet accent chip on the key value in a table or
sentence.

The palette's usage rules — which colors mean emphasis, structure, and data —
are recorded in [`docs/design.md`](docs/design.md).

Any content immediately below a level-one section heading becomes its agenda
kicker. For explicit markup, wrap the content in `.section-kicker`. Visible
direct-child asides reserve their measured height in live slides and handouts;
speaker notes add a second reserved box only in `?handout=true` mode.

Title slides remain simple for one or two authors. Four authors use one compact
row; five or six use two rows. Each author's affiliations are comma-separated
in the same cell.

The format bundles its typefaces: Schibsted Grotesk for headings and text and
JetBrains Mono for code and slide numbers, both vendored as variable WOFF2
files under the SIL Open Font License. Decks therefore typeset identically on
every machine — including CI-rendered PDFs — without a font CDN.

The format bundles and defaults to KaTeX 0.18.4 for fast, consistent TeX
typography without a runtime CDN dependency. Set `altmejd-slides.math: false`
and choose a native Quarto `html-math-method` only when a different renderer is
deliberately required.

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

[`examples/showcase.qmd`](examples/showcase.qmd) is the canonical visual
development deck: a fully synthetic research talk covering the normal title,
agenda, text, math, table, figure, note, handout, and appendix-navigation
surface. Its committed SVGs require no computation or network access. The
browser check visits every slide in desktop, narrow, and handout modes.

[`tests/fixtures/regression.qmd`](tests/fixtures/regression.qmd) keeps only
adversarial limits such as unusually long metadata, navigation, and code. The
agenda fixtures cover deck-wide variants and an eleven-section research-talk
outline. The supported baseline is the Quarto version pinned in CI; a large
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
