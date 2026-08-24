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
routes, or Workers.

## Project configuration

```yaml
altmejd-slides:
  publish:
    cloudflare:
      host: slides.altmejd.se
      # zone: altmejd.se        # default: host minus its first label
      # slug: ucls26            # default: the QMD file stem, sanitized
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

Publishing records the deployed slug and content hash in
`.altmejd-slides-publish.json` next to the deck; commit it so the unchanged
check and collision protection follow the repository.

## Updating an existing talk

Run `make publish` again. Unchanged content is detected by hash and skipped;
changed content deploys a new version of that talk's Worker only. Asset
uploads are content-addressed, so only changed files transfer.

## Rollback

Each talk keeps Cloudflare's version history:

```sh
npx wrangler@4 rollback --name altmejd-slides-<slug>
```

## Deleting a published talk

```sh
npx wrangler@4 delete --name altmejd-slides-<slug>
```

This removes the Worker and its routes; the gateway then answers 404 for the
path. Remove the entry from `.altmejd-slides-publish.json` afterwards.

## Limits

On the current Workers free tier: 100,000 requests per day across all
Workers, 100 Workers per account (each talk uses one, plus the gateway), and
static assets are free to serve with per-Worker asset-count and 25 MiB
per-file limits. Well beyond what a personal slides host needs; the paid plan
raises the request cap if a link ever goes wide.
