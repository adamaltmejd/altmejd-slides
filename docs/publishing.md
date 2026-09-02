# Publishing to Cloudflare

Decks publish to `https://slides.altmejd.se/<slug>/` through an explicit
`make publish`. Nothing in the format itself deploys: `quarto render`,
`quarto preview`, and IDE rendering never touch Cloudflare, and the extension
registers no render hooks. Publishing only happens when the publisher script
is run deliberately.

## Architecture

- One small **gateway Worker** (`altmejd-slides-gateway`) owns the host as a
  Cloudflare Custom Domain. It redirects bare `/slug` to `/slug/` and answers
  404 for everything unpublished. Deploying it creates the DNS record for the
  host; it never touches other records.
- Each talk is an independent **Static Assets Worker** named
  `altmejd-slides-<slug>` with two zone routes: `host/<slug>` and
  `host/<slug>/*`. Zone routes take precedence over the gateway's Custom
  Domain, so each deck answers its own path and everything else falls through
  to the gateway.
- The deck's rendered output is staged beneath `<slug>/` with the entry HTML
  as `<slug>/index.html`, so Cloudflare's default `auto-trailing-slash`
  handling serves `/slug/` and redirects `/slug` itself.

Republishing one talk deploys a new version of only that talk's Worker; other
talks are untouched. Cloudflare keeps previous Worker versions, so rollback is
available per talk.

## One-time gateway setup

From any deck configured with the host (or with explicit flags):

```sh
make bootstrap-gateway
```

or directly:

```sh
quarto run _extensions/adamaltmejd/altmejd-slides/tools/publish-cloudflare.ts \
  --bootstrap-gateway --host slides.altmejd.se
```

This is idempotent: rerunning redeploys the same tiny gateway Worker and
re-asserts the Custom Domain. It does not modify unrelated DNS records,
routes, or Workers. After deploying, the bootstrap reports separately
whether the custom domain already answers — the DNS record can take minutes
to propagate, publishing works in the meantime, and a publish whose
verification hits that window is safely retried by rerunning `make publish`.

## Project configuration

Configuration is optional: with none at all, a deck publishes to
`https://slides.altmejd.se/<repository-name>/`. Override any part in the
deck YAML:

```yaml
altmejd-slides:
  publish:
    cloudflare:
      host: slides.altmejd.se   # default
      # zone: altmejd.se        # default: host minus its first label
      # slug: ucls26            # default: the deck repository's name, sanitized
```

`host` and `zone` are non-secret. The slug must be 1-46 lowercase letters,
digits, or interior hyphens; `index`, `gateway`, and `assets` are reserved. A
project with several QMD files must pick the deck with
`make publish PUBLISH_ARGS="--input talk.qmd"`.

## Authentication

- **Locally**: `wrangler login` once; the publisher uses the stored OAuth
  session.
- **CI**: set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. A
  least-privilege token needs Account · Workers Scripts · Edit and Zone ·
  Workers Routes · Edit (plus Zone · DNS · Edit for the one-time gateway
  bootstrap).

Tokens are read by wrangler itself; the publisher never stores or prints
them.

Wrangler 4 is the supported major. The publisher uses, in order: the
`ALTMEJD_SLIDES_WRANGLER` environment override, a `wrangler` already on
`PATH`, `bunx wrangler@4`, then `npx --yes wrangler@4`.

## Publishing a talk

```sh
make publish
```

The publisher renders the deck (failing the publish if rendering fails),
resolves the slug, prints the target URL, stages the output beneath
`<slug>/`, validates that every referenced stylesheet, script, image, and
font exists in the staged tree, deploys the deck's Worker and routes, then
fetches the public URL and confirms the deck answers before reporting the
final URL. It exits non-zero on any failure.

Useful flags (pass via `PUBLISH_ARGS="..."`):

- `--slug <slug>` — override the public path segment.
- `--stage-only` — render, stage, and validate without deploying.
- `--adopt` — take over an existing `altmejd-slides-<slug>` Worker this
  project has no record of (refused otherwise).
- `--force` — deploy even when the staged content hash is unchanged.
- `--no-verify` — skip the post-deploy URL check.

Both deck layouts work: a standalone QMD that renders beside its source, and
a Quarto project whose `_quarto.yml` sets `project.output-dir` (assets are
then staged from that output directory). Limitations: top-level stylesheets
have one level of relative `url()`/`@import` targets staged; assets
referenced only from deeper CSS chains outside the deck's `_files` tree are
not detected.

If a deploy succeeds but the public URL cannot be verified (typically DNS
still propagating after the first bootstrap), the publish exits non-zero but
records the deployment as `verification: pending`. Rerunning `make publish`
later retries only the verification — it does not redeploy unchanged content
and does not require `--adopt` for the Worker this project just created.

Publishing records the deployed slug, host, zone, and content hash in
`.altmejd-slides-publish.json` next to the deck; commit it so the unchanged
check and collision protection follow the repository.

## Publishing PDFs and other artifacts

Extra files publish only when explicitly configured — handout or
speaker-note PDFs are never included implicitly:

```yaml
altmejd-slides:
  publish:
    cloudflare:
      artifacts:
        presentation-pdf:
          source: output/pdf/talk-slides.pdf
          target: slides.pdf
        # handout-pdf:                      # opt in deliberately
        #   source: output/pdf/talk-handout.pdf
        #   target: handout.pdf
```

Each artifact is staged at `https://<host>/<slug>/<target>` (the URL is
printed during staging), participates in content hashing, and a missing
source fails the publish with a clear error. `target` defaults to the
source's basename and must be a safe relative path. The publisher only
copies existing files — build PDFs first (for example with DeckTape) before
running `make publish`.

## Updating an existing talk

Run `make publish` again. Unchanged content is detected by hash and skipped;
changed content deploys a new version of that talk's Worker only. Asset
uploads are content-addressed, so only changed files transfer.

## Presenting on unreliable networks

Published decks are hardened for flaky venue Wi-Fi in two layers. The
publisher stages a `_headers` file that serves every asset with
`Cache-Control: public, max-age=0, stale-while-revalidate=604800`: each view
still revalidates so a republish shows up immediately, but the browser paints
its cached copy first and keeps it when the network drops the request —
Cloudflare's default `must-revalidate` policy instead blanks previously
loaded figures the moment a revalidation fails. Independently, the format's
runtime re-requests any image that failed to load (Reveal assigns lazy image
sources at reveal time and never retries a failure): once when the slide is
shown, then on a short backoff, and again when the browser reports the
network came back.

A cached page still cannot survive every failure mode; for a talk where the
network is known to be bad, keep the published `slides.pdf` artifact or a
local render as the fallback.

## Rollback

Each talk keeps Cloudflare's version history:

```sh
npx wrangler@4 rollback --name altmejd-slides-<slug>
```

## Unpublishing a talk

```sh
make unpublish
```

The publisher selects the sole talk recorded in
`.altmejd-slides-publish.json`, asks Wrangler for confirmation, deletes only
that recorded Worker and its routes, verifies that it is gone, and then removes
its state entry. It does not render or stage the deck and never touches the
shared gateway. The gateway then answers 404 for the path.

If the state file contains several talks, choose one explicitly:

```sh
make unpublish PUBLISH_ARGS="--slug ucls26"
```

Unpublishing fails closed when the slug is not recorded or the recorded Worker
name does not match the extension's deterministic name. If the Worker was
already removed outside this workflow, the command cleans up its stale state
entry. A failed or declined Wrangler deletion keeps the state entry so it can
be retried safely.

`quarto update` refreshes the publisher inside `_extensions/` but cannot edit an
existing deck's root `Makefile`. For a deck created before this target existed,
copy the `unpublish` target from the current template or run the publisher
directly with `--unpublish`. If the local state record has been lost, the
workflow will not guess ownership; inspect the Worker manually before using
Wrangler's lower-level `delete --name` command.

Deleting the Worker cannot retract copies already downloaded, cached, or
archived elsewhere. Republish later with `make publish`; it creates a fresh
Worker and state entry for the same slug.

## Limits

On the current Workers free tier: 100,000 requests per day across all
Workers, 100 Workers per account (each talk uses one, plus the gateway), and
static assets are free to serve with per-Worker asset-count and 25 MiB
per-file limits. Well beyond what a personal slides host needs; the paid plan
raises the request cap if a link ever goes wide.
