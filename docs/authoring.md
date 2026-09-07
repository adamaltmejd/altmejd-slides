# Authoring guide

Start from [`template.qmd`](../template.qmd). Write the question, evidence, and
takeaway first; add a component when it helps the audience follow that argument.
The [showcase source](../examples/showcase.qmd) is a synthetic research talk
using these recipes. The [design guide](design.md) records the complete palette
and its roles.

## Write and check a deck

The starter includes the [Makefile](../Makefile):

```sh
make preview
make render
```

It detects a Quarto project or a sole top-level QMD. If there are several
standalone decks, choose one with `DECK_INPUT=talk.qmd`. Existing projects that
only ran `quarto add` can copy this Makefile or use Quarto directly.

Headings should state what the evidence supports. For example, “Eligibility
raises access by 31 percentage points” is more useful than “First stage” when
the displayed figure supports that magnitude. Keep qualifications next to the
claim: a descriptive difference, an estimate, and an identified mechanism are
different kinds of evidence.

Before presenting, open the rendered deck with `?check=true`. The optional
browser check visits the final state of every slide and reports:

- content extending beyond the slide;
- clipped code, visible asides, and speaker notes;
- missing image `alt` attributes or images that failed to load;
- internal links whose targets do not exist.

The report stays in the browser and links to the affected slides. Run
`?handout=true&check=true` as well to inspect visible speaker notes. The check
does not judge the meaning of alt text, the accuracy of a claim, or every
accessibility requirement; review the slides visually too. Slide Remote stays
inactive while the check runs.

## Present, read, and distribute

| URL mode | Use |
|:---------|:----|
| `talk.html` | Present the fixed slide canvas with its normal fragments. |
| `talk.html?reading=true` | Read the final slide content as a flowing document with normal links. |
| `talk.html?handout=true` | Show speaker notes below each slide. |
| `talk.html?reading=true&handout=true` | Read the document with speaker notes included. |

On narrow screens, **Read slides** opens reading mode. It is also available
from the slide menu. **Present slides** returns to the presentation; reading
mode also offers **Print / save PDF** for the flowing document. Slide Remote
stays inactive in reading mode.

For PDFs that retain the presentation's fixed layout, use the installed
renderer. With Bun and Chrome or Chromium available:

```sh
make pdf-setup   # one-time installation of the locked capture tools
make pdf         # render the deck and capture both PDF variants
```

Setup may download packages. Subsequent PDF capture uses the installed,
pinned DeckTape and runs offline; it does not install packages or download a
browser. Keep fonts, figures, and other capture assets local. A project that
renders to `_site` uses `make pdf PDF_SITE_DIR=_site`.

The outputs are `NAME-slides.pdf`, without speaker notes, and
`NAME-handout.pdf`, with notes. Both keep the final fragment state. If several
standalone decks share a directory, use
`make pdf DECK_INPUT=talk.qmd PDF_ARGS="--glob talk.html"`. See the
[PDF tool guide](../tools/README.md) for browser selection, output paths,
caching, and capture without rerendering Quarto.

## Sections and appendix

Use `# Section` for a section divider and `## Slide title` for a content slide.
The extension generates a main-talk agenda at each section divider. A short
paragraph immediately below `# Section` becomes its kicker.

```yaml
altmejd-slides:
  agenda:
    clickable: true
    bullets: none       # also: bullet, numbered
    heading: false      # or a short heading such as "Outline"
```

The current section is marked visually and with `aria-current`. To keep a
normal section divider without a generated agenda, add `.no-agenda` to its
heading; `agenda.enabled: false` disables agendas throughout the deck.

`# Appendix` or a level-one heading with `.appendix` starts backup material.
That section and all later sections are omitted from the main agenda by
default. Set `agenda.include-appendix: true` to include them. Appendix slides
remain navigable and printable, but stop increasing the slide number and
total. An explicit `visibility` attribute on an individual slide wins.

## Figures, panels, and build-ups

A standalone figure is centered. Give it a meaningful description separate
from its optional visible caption:

```markdown
![Estimated effect with a 95% interval](estimate.svg){fig-alt="The point estimate is positive and its interval excludes zero"}
```

Use `fig-align="left"` or `fig-align="right"` for another alignment.
`.r-stretch` requests available slide space. `.nostretch width="600"` keeps a
deliberately fixed figure size, including when a source aside is present.
Native fixed-height and slide-level `.nostretch` settings also remain in force.

Two ordinary columns that both contain an image become equal figure panels:

```markdown
:::: {.columns}
::: {.column width="50%"}
**Outcome A**

![](outcome-a.svg){fig-alt="Description of the first outcome estimate"}
:::
::: {.column width="50%"}
**Outcome B**

![](outcome-b.svg){fig-alt="Description of the second outcome estimate"}
:::
::::
```

For a native layout with unequal widths or text-heavy columns, use
`::: {.columns .no-figure-panels}` on the outer container. For a single
fill-height panel, use `.figure-panels` with one `.figure-panel` child.

Reveal's stack and fragments support adding a fit or annotation to a plot:

```markdown
::: {.r-stack}
![](points.svg){fig-alt="Binned outcomes around the cutoff"}

![](points-and-fit.svg){.fragment fig-alt="The same points with local fitted lines"}
:::
```

Keep identical base geometry in every image so only the new evidence changes.
Reading mode and the two slide PDFs show the final state.

## Notes and navigation

Put a brief source or qualification in a direct slide aside. Put the speaking
cue in a notes block:

```markdown
::: {.aside}
Synthetic illustration. Intervals show uncertainty, not the spread of outcomes.
:::

::: notes
Pause on the interval before discussing the point estimate.
:::
```

Visible asides and handout notes reserve their space above the navigation.
Keep them short; long notes can be clipped on the fixed canvas. The reading
view with `handout=true` is useful for longer explanations.

`.handout-only` content appears when `handout=true`; `.live-only` content
disappears there. These classes also compose with `.aside`, `.notes`, and
`.slide-nav`. For example, `::: {.notes .live-only}` keeps a speaking cue out
of the handout. A block's mode follows the handout setting in reading mode too.
Mode gates control display; hidden content remains in the delivered HTML.

Use compact navigation when the audience may ask for an alternative result:

```markdown
::: {.slide-nav}
[Main result](#main-result){.back}
[Robustness](#robustness)
:::
```

Internal-link-only paragraphs are docked automatically. Separate paragraphs
and explicit navigation groups share one row and retain their delivery-mode
gates. `.back` adds a return arrow; use `.primary` for at most the action that
needs emphasis. Prose containing an internal link remains ordinary prose.

## Takeaways, statistics, and tables

A statement slide supports one concise claim and, optionally, one to three
numbers. Give each number a unit or denominator:

```markdown
## A local gain in the synthetic example {.statement}

::: {.stat-row}
[**+0.18**]{.stat} courses completed per term at the eligibility cutoff
:::

The local estimate does not establish an effect for every applicant.
```

The `.stat-row` also works on an ordinary slide. Bold gives a number the
emphasis color; reserve it for the value the audience should retain.

Put a `.table-note` directly after a table to align a source or qualification
with its width. `[0.18]{.emph}` highlights a key coefficient inside a table or
sentence. A good result table states the outcome and units, shows uncertainty,
and explains what changes across rows.

Quarto callouts keep a consistent light surface, including on dark slides:

| Class | Suggested use |
|:------|:--------------|
| `.callout-note` | Define a term or estimand. |
| `.callout-tip` | State a result. |
| `.callout-important` | State an identifying assumption. |
| `.callout-warning` or `.callout-caution` | Qualify the interpretation. |

Supply a short `title`, such as `::: {.callout-important title="Assumption"}`.

## Image and closing slides

```markdown
## The setting {.full-bleed background-image="room.jpg" background-size="cover" background-alt="A university reading room in the evening"}

One sentence connecting the setting to the question.

::: {.attribution}
Image credit
:::
```

The title and caption use contrast backgrounds; the credit sits at the
bottom-right. `background-alt` supplies a description for the image in reading
mode. For a color background, pair `.dark-bg` or `.light-bg` with an appropriate
`background-color` and check every component you place on it.

```markdown
## Thank you {.closing-slide}

name\@university.edu · [example.org](https://example.org)

[Read the paper](https://example.org/paper){.qr}
```

The QR code is generated offline and remains a clickable, keyboard-accessible
link. Its link text becomes the image description. Include a readable resource
link as well when readers should recognize the destination without scanning.

## Optional configuration

The starter inherits the palette and bundled KaTeX without repeating their
defaults. Override only the colors you need under `altmejd-slides.colors`;
consult the [complete palette](design.md). Native options such as footer,
transition, and dimensions stay under `format.altmejd-slides-revealjs`.

To use a different math renderer, set `altmejd-slides.math: false` and configure
Quarto's `html-math-method`. Otherwise the bundled KaTeX and typefaces need no
network access at presentation time.

Slide Remote is optional. A deck activates it only when configured with its
Worker URL; see the [README](../README.md#slide-remote). Reading and check mode
are automatically added to its disabled modes. Publishing is also explicit:
`make publish` deploys, and `make unpublish` removes the deployed talk. Neither
previewing nor rendering publishes anything. See the
[publishing guide](publishing.md) for setup and the publication options.
