# Design language

This document records the intent behind the default design so future changes
stay coherent. The theme implements these rules; YAML color overrides inherit
the same roles.

## Palette roles

| Token | Default | Role |
|:------|:--------|:-----|
| `background` | `#f8fafc` | Page ground. Cool near-white, never pure white. |
| `foreground` | `#0f172a` | Body ink and headings. |
| `primary` | `#644043` | Structure and brand: heading-rule gradient start, links, navigation chips, agenda surface, fit lines in figures. |
| `secondary` | `#ffeac2` | Warmth: heading-rule gradient end, agenda foreground. |
| `accent` | `#e26d5c` | Emphasis only. |
| `info` | `#924f5b` | Quiet semantics: list markers, aside and code rails, function tokens. |
| `success` | `#c9cba3` | Tints and confirmation: code background wash, string tokens, result callouts. Always inked toward the foreground when used as text. |
| `surface` | `#f1f5f9` | Box fills: blockquotes, callouts, navigation chips. |
| `border` | `#e2e8f0` | Hairlines and table rules. |
| `muted` | `#5b6a80` | Chrome and metadata: footer, slide number, labels, asides, source notes, definition callouts. The info mauve sits too close to the primary burgundy to title a second callout type. |

## Accent rules

The coral accent is the loudest color in the system, so it is rationed:

1. **Emphasis ink, not decoration.** `**strong**` text, `.emph` chips, and
   emphasized `.stat` numbers take the accent, always mixed toward the
   foreground (65–85%) so it holds contrast at text sizes. Pure accent is
   reserved for focus rings and data marks inside figures.
2. **Data-ink in figures.** Committed SVGs use pure accent for points and
   estimates, primary for fitted lines, and muted slate for axes. Slides never
   compete with their figures for the accent.
3. **Never a surface.** The accent does not fill boxes, backgrounds, or rules;
   surfaces belong to `surface`, `secondary`, and the agenda's `primary`.
4. **One accent moment per slide.** If everything is emphasized, nothing is.

## Typography

Schibsted Grotesk (variable, 400–900) carries everything textual; JetBrains
Mono (variable, 100–800) carries code and the slide number. Both are vendored.
The odd weights are deliberate: 520 metadata, 560 labels and links, 650
headings and emphasis, 680 author names and statements, 740 display (title,
stats), against 400 body. Display sizes tighten letter-spacing (−0.02 to
−0.035 em); uppercase kickers open it (+0.06 to +0.075 em).

Ordinary h1/h2/h3 sizes also set Quarto's native heading variables. This
keeps headings at 66 / 51.2 / 33.6px when `.smaller` reduces body text from
40 to 28px. The same rule applies to slide-level and deck-level `smaller`;
custom `$altmejd-heading-scale` values remain consistent in both modes.

## Spacing

Ordinary paragraphs use `0.65em` block margins. A paragraph or list followed
by text columns gets a larger `1.2em` gap, and columns leave `0.8em` below
their tallest child. At the default 40px body size these are 26, 48, and
32px. Native percentage column widths stay intact.

Subheadings stay close to their content: `0.5em` below an `h3`, without
stacked list or first-item top margins. A subheading after top-level prose
or a list starts a new group with `1.1em` above it. Tables use `0.34em`
vertical and `0.4em` horizontal cell padding so adjacent rows stay distinct.
When speaker notes are shown in handout mode, tables retain compact
`0.16em` / `0.32em` padding and top-level prose uses Reveal's block margin
to leave room for the notes. Slides without speaker notes remain airy.

These defaults govern ordinary content. Figure panels, title slides,
callouts, captions, notes, and navigation retain their component spacing.
Use the available slide area for readable groups; dense source tables and
small labels embedded in figures still need author attention.

## Navigation sizing

In-slide navigation uses 18px labels and a 36px minimum height in slide
coordinates. It scales with the rest of the slide, including in PDF mode.
On narrow screens, the separate navigation toolbar and reading controls
retain 16px labels and at least 44px touch targets outside the slide canvas.
Use the normal presentation URL for responsive previews; `?pdf=true`
intentionally suppresses those mobile controls for export.

## Component inventory

One artboard per row when seeding a design canvas.

| Component | Authoring surface |
|:----------|:------------------|
| Cover | title metadata (1–6 authors) |
| Section agenda | level-one heading + kicker content |
| Content slide | `##` heading, prose, lists |
| Statement slide | `.statement` + `.stat-row`/`.stat` |
| Stat band | `.stat-row` on a content slide |
| Figure panels | two-image columns or `.figure-panels` |
| Figure build-up | `.r-stack` + `.fragment` |
| Full-bleed image | `.full-bleed` + `background-image` |
| Callouts | `.callout-note/-tip/-important/-warning` |
| Table + note + emphasis | pipe table, `.table-note`, `.emph` |
| Code block | fenced block, optional `code-line-numbers` |
| Blockquote | `>` quote |
| Aside / speaker note | `.aside`, `::: notes` |
| Navigation chips | `.slide-nav`, `.back`, `.primary` |
| Attribution spine / credit chip | `.attribution` (rotates on full-bleed) |
| Dark and light slides | `.dark-bg`, `.light-bg` + `background-color` |
| Closing slide | `.closing-slide` + `[alt](url){.qr}` generated QR |
| Chrome | footer, slide number, progress, menu |
| Mode gating | `.handout-only`, `.live-only` |
