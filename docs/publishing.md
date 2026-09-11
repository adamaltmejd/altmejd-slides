# Publishing to Cloudflare

Decks publish to `https://slides.altmejd.se/<slug>/` through an explicit
`make publish`. Nothing in the format itself deploys: `quarto render`,
`quarto preview`, and IDE rendering never touch Cloudflare, and the extension
registers no render hooks. Publishing only happens when the publisher script
is run deliberately.

## Architecture

- One small **gateway Worker** (`altmejd-slides-gateway`) owns the host as a
  Cloudflare Custom Domain. It lists published decks at `/`, redirects bare
  `/slug` to `/slug/`, and answers 404 for other unpublished paths. The gateway
  is deployed separately from this repository. Deploying its Custom Domain
  creates the DNS record for the configured host.
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

Keep one checkout of this format repository as the gateway's deployment home.
Its configuration is independent of individual deck projects. From that checkout:

```sh
cp gateway/wrangler.example.jsonc gateway/wrangler.jsonc
```

Edit `gateway/wrangler.jsonc` for your Cloudflare account and domain:

| Setting | Value |
| --- | --- |
| `name` | Gateway Worker name. Keep `altmejd-slides-gateway` when upgrading the existing gateway; use a distinct name for each additional host in the same account. |
| `account_id` | The Cloudflare account containing your deck Workers and zone. |
| `routes[0].pattern` | Your hostname, such as `talks.example.org`, with `custom_domain: true`. |
| `vars.PUBLISH_HOST` | The same hostname, without a scheme, port, or path. |
| `vars.CLOUDFLARE_ZONE_ID` | The zone's ID from Cloudflare, not its name. |
| `vars.INDEX_TITLE` | The homepage heading and browser title. |
| `vars.WORKER_PREFIX` | Keep `altmejd-slides-` for this extension's publisher. This only configures discovery; it does not rename deck Workers. |

The example uses `talks.example.org`; the gateway code contains no personal
hostname. For `slides.altmejd.se`, set both hostname fields to that value and
use the `altmejd.se` zone ID. The local `wrangler.jsonc` is ignored by Git;
keep a backup of your deployment configuration.

Create a dedicated Cloudflare API token with **Zone · Workers Routes · Read**,
restricted to the selected zone. The gateway uses this token only to read the
[route inventory](https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/list/).
Store it as a Worker secret through Wrangler's interactive prompt:

```sh
wrangler secret put CLOUDFLARE_API_TOKEN --config gateway/wrangler.jsonc
```

Use your deployment login or CI credentials to run Wrangler; the read-only
token belongs in the gateway secret, not in your shell's deployment credentials.
For a new Worker, Wrangler may ask to create it while setting the first secret.
Review and deploy the gateway explicitly:

```sh
wrangler deploy --dry-run --config gateway/wrangler.jsonc
wrangler deploy --config gateway/wrangler.jsonc
```

The Custom Domain must belong to the configured account. DNS and certificate
activation can take time on the first deployment. This deploy replaces only
the configured gateway; existing deck routes continue to serve their own
Workers. Configure each deck with the same hostname:

```yaml
altmejd-slides:
  publish:
    cloudflare:
      host: talks.example.org
      zone: example.org
```

`make publish` and `make unpublish` stay project-local. Existing published decks
are discovered automatically, including decks published with older extension
versions. No backfill or republish is needed.

### Upgrading the original gateway

Use the existing gateway Worker name and Custom Domain in the new configuration.
Retire `make bootstrap-gateway` in existing deck Makefiles. The current template
target and publisher flag stop with setup guidance before doing any work.
**Older installed copies still redeploy the old 404 gateway**; updating this
repository cannot disable those copies. Replace their Makefile target with the
current one, or remove it, before reusing that workflow. Ordinary old
`make publish` and `make unpublish` commands do not touch the gateway.

### Index behavior and validation

The index includes canonical `host/<slug>/*` routes whose Worker name is exactly
`WORKER_PREFIX + slug`. It excludes other hosts and unrelated Workers, then
deduplicates and sorts the links. Labels are URL slugs; route discovery provides
neither talk titles and dates nor an HTTP health check. Every matching published
deck is listed publicly.

Successful results stay fresh for five minutes. The gateway retains each result
in the edge Cache API for up to 24 hours and can show it with a notice if a later
refresh fails. Cache storage is local to each data center and may be evicted;
this is a best-effort fallback, not durable storage. Without a usable result,
an API or configuration failure returns 503, not an empty directory. A successful
empty route inventory displays an explicit empty state. Unknown deck paths keep
their existing redirects and 404s.

Run `bun run check` for source checks and the mocked gateway tests. Validate the
gateway bundle with the dry run above. Binding types are generated from the
example configuration and kept separate from runtime type definitions:

```sh
wrangler types gateway/worker-configuration.d.ts \
  --config gateway/wrangler.example.jsonc --include-runtime false --strict-vars false
```

The gateway intentionally calls the route management API: there is no runtime
binding for enumerating the zone's deployed routes. It does not fetch deck HTML
for labels or require a shared publishing registry.

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
`make publish PUBLISH_ARGS="--input talk.qmd"`. Nested inputs such as
`--input talks/talk.qmd` also work when run from the project root.

## Authentication

- **Locally**: `wrangler login` once; the publisher uses the stored OAuth
  session. If that login can access several accounts, set
  `CLOUDFLARE_ACCOUNT_ID` explicitly so the first publish cannot select the
  wrong one.
- **CI**: set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. A
  least-privilege token needs Account · Workers Scripts · Edit and Zone ·
  Workers Routes · Edit. Gateway Custom Domain setup additionally needs the
  relevant zone DNS permissions. These deployment credentials are separate
  from the gateway's zone-scoped read-only runtime secret.

Tokens are read by wrangler itself; the publisher never stores or prints
them. The non-secret account ID is stored with each publish record and pinned
in every later publish or unpublish command.

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

To review exactly what would be uploaded, run
`make publish PUBLISH_ARGS="--stage-only"` and open the printed
`staged-files.json` path. It lists every public file, its size, and its source
or configured artifact name. The manifest stays beside `public/` and is never
published. A failed staging run removes any previous manifest in that staging
directory so it cannot be mistaken for a successful preflight.

Both deck layouts work: a standalone QMD that renders beside its source, and
a Quarto project whose `_quarto.yml` sets `project.output-dir` (assets are
then staged from that output directory). Nested decks retain their asset
paths inside the public slug. Their entry HTML moves to `index.html`, with
relative URLs adjusted to keep figures, self links, and shared `../site_libs`
working. CSS `url()` and `@import` references are followed recursively from
each stylesheet's own directory. Paths may traverse within the rendered output
tree but cannot escape it or select its root for wholesale copying.

Referenced asset directories are copied in full, including their non-hidden
contents. Keep those directories dedicated to public assets and review the
manifest before publishing; an unrelated file inside an explicitly referenced
asset directory is part of that directory's upload. A direct reference such
as `./figure.svg` copies that file only. Resources loaded only by JavaScript,
or through absolute site-root URLs, still need a compatible relative asset
layout; the publisher does not infer or rewrite them.

If a deploy succeeds but the public URL cannot be verified (typically DNS
still propagating after the first gateway setup), the publish exits non-zero but
records the deployment as `verification: pending`. Rerunning `make publish`
later retries only the verification — it does not redeploy unchanged content
and does not require `--adopt` for the Worker this project just created.

Publishing records the deployed slug, host, zone, Cloudflare account ID, and
content hash in `.altmejd-slides-publish.json` next to the deck; commit it so
the unchanged check and collision protection follow the repository.

## Publishing PDFs and other artifacts

Extra files outside referenced public asset directories publish only when
explicitly configured. A handout or speaker-note PDF beside the deck is not
included unless it is linked from the HTML or configured as an artifact:

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
`.altmejd-slides-publish.json`, requires you to type its exact slug, and pins
Wrangler to the Cloudflare account saved during publishing. Wrangler then asks
for its own deletion confirmation. Only that recorded Worker and its routes are
deleted; the publisher verifies that it is gone before removing its state
entry. It does not render or stage the deck and never touches the shared
gateway. The gateway then answers 404 for the path.

If the state file contains several talks, choose one explicitly:

```sh
make unpublish PUBLISH_ARGS="--slug ucls26"
```

Non-interactive use fails closed. To authorize it deliberately, repeat the
exact slug as the confirmation value:

```sh
make unpublish PUBLISH_ARGS="--slug ucls26 --confirm ucls26"
```

Unpublishing fails closed when the slug is not recorded or the recorded Worker
name does not match the extension's deterministic name. If the Worker was
already removed outside this workflow, the command cleans up its stale state
entry. A failed or declined Wrangler deletion keeps the state entry so it can
be retried safely.

Publish records created before account binding was added need one explicit
account selection before they can be deleted:

```sh
CLOUDFLARE_ACCOUNT_ID=<account-id> make unpublish
```

If that account does not contain the recorded Worker, the legacy state is kept
rather than guessing another account.

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
