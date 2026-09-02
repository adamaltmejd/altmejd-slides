#!/usr/bin/env bash
# End-to-end test of the Cloudflare publisher against a mocked wrangler.
# Requires quarto. Never contacts Cloudflare: a fake wrangler on PATH records
# every invocation and simulates worker existence with marker files.
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
publisher="$repo_dir/_extensions/altmejd-slides/tools/publish-cloudflare.ts"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/altmejd-publish-test.XXXXXX")"
server_pid=""
trap '[ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null; rm -rf "$work_dir"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# --- fake wrangler ----------------------------------------------------------
fake_bin="$work_dir/bin"
fake_state="$work_dir/fake-state"
mkdir -p "$fake_bin" "$fake_state"
cat >"$fake_bin/wrangler" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
echo "wrangler $*" >> "$FAKE_WRANGLER_LOG"
case "${1:-}" in
  --version)
    echo "4.0.0"
    ;;
  whoami)
    account_id="${FAKE_WRANGLER_ACCOUNT_ID:-11111111111111111111111111111111}"
    if [ -n "${FAKE_WRANGLER_SECOND_ACCOUNT_ID:-}" ]; then
      printf \
        '{"loggedIn":true,"accounts":[{"id":"%s","name":"One"},{"id":"%s","name":"Two"}]}\n' \
        "$account_id" "$FAKE_WRANGLER_SECOND_ACCOUNT_ID"
    else
      printf '{"loggedIn":true,"accounts":[{"id":"%s","name":"Test"}]}\n' "$account_id"
    fi
    ;;
  deployments)
    # deployments list --name <worker>
    name="${4:?}"
    if [ -f "$FAKE_WRANGLER_STATE/deployed-$name" ]; then
      echo "Created: recently"
    else
      echo "A request to the Cloudflare API failed: workers.api.error.service_not_found [code: 10090]" >&2
      exit 1
    fi
    ;;
  deploy)
    config="${3:?}"
    name="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['name'])" "$config")"
    cp "$config" "$FAKE_WRANGLER_STATE/config-$name.json"
    touch "$FAKE_WRANGLER_STATE/deployed-$name"
    echo "Deployed $name"
    ;;
  delete)
    # delete --name <worker> --config <path>
    name="${3:?}"
    config="${5:?}"
    cp "$config" "$FAKE_WRANGLER_STATE/delete-config-$name.json"
    if [ -n "${FAKE_WRANGLER_DELETE_FAIL:-}" ]; then
      echo "simulated delete failure" >&2
      exit 1
    fi
    if [ -n "${FAKE_WRANGLER_DELETE_KEEP:-}" ]; then
      echo "simulated declined deletion"
      exit 0
    fi
    rm -f "$FAKE_WRANGLER_STATE/deployed-$name"
    echo "Deleted $name"
    ;;
  *)
    echo "fake wrangler: unexpected command: $*" >&2
    exit 64
    ;;
esac
FAKE
chmod +x "$fake_bin/wrangler"
export PATH="$fake_bin:$PATH"
export FAKE_WRANGLER_LOG="$work_dir/wrangler-calls.log"
export FAKE_WRANGLER_STATE="$fake_state"
unset CLOUDFLARE_ACCOUNT_ID
touch "$FAKE_WRANGLER_LOG"

# --- fixture deck -----------------------------------------------------------
deck_dir="$work_dir/deck"
mkdir -p "$deck_dir/assets"
cat >"$deck_dir/mytalk.qmd" <<'QMD'
---
title: "Publish Fixture"
format: revealjs
altmejd-slides:
  publish:
    cloudflare:
      host: slides.example.test
      slug: fixture26
---

## One

![](assets/dot.svg)

## Two

Content.
QMD
cat >"$deck_dir/assets/dot.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><circle cx="4" cy="4" r="4"/></svg>
SVG

cd "$deck_dir"
staging="$work_dir/staging"

# --- ambiguous account selection is refused --------------------------------
if FAKE_WRANGLER_SECOND_ACCOUNT_ID=22222222222222222222222222222222 \
  quarto run "$publisher" --no-verify --keep-staging --staging-dir "$work_dir/staging-multi" \
  >"$work_dir/account-ambiguous.log" 2>&1; then
  fail "publish guessed between several Cloudflare accounts"
fi
grep -q "several Cloudflare accounts are available" "$work_dir/account-ambiguous.log" ||
  fail "ambiguous account refusal lacked an explanation"
if grep -q " deploy " "$FAKE_WRANGLER_LOG"; then
  fail "ambiguous account selection still deployed"
fi
: >"$FAKE_WRANGLER_LOG"

# --- first publish ----------------------------------------------------------
quarto run "$publisher" --no-verify --keep-staging --staging-dir "$staging" ||
  fail "first publish exited non-zero"

test -f "$staging/public/fixture26/index.html" || fail "entry not staged as <slug>/index.html"
test -f "$staging/public/fixture26/assets/dot.svg" || fail "referenced asset not staged"
test -d "$staging/public/fixture26/mytalk_files" || fail "Quarto dependency tree not staged"
test -f "$staging/public/_headers" || fail "_headers not staged at the asset root"
if ! grep -q "stale-while-revalidate" "$staging/public/_headers"; then
  fail "_headers does not allow stale service on failed revalidation"
fi
test -f ".altmejd-slides-publish.json" || fail "publish state file not written"

grep -q "deploy --config" "$FAKE_WRANGLER_LOG" || fail "wrangler deploy was not invoked"
config="$FAKE_WRANGLER_STATE/config-altmejd-slides-fixture26.json"
test -f "$config" || fail "deploy did not use the deterministic worker name"
python3 - "$config" <<'PY' || fail "deployed wrangler config is wrong"
import json, sys
c = json.load(open(sys.argv[1]))
assert c["name"] == "altmejd-slides-fixture26"
assert c["account_id"] == "11111111111111111111111111111111"
assert c["workers_dev"] is False
assert c["assets"] == {"directory": "./public"}
patterns = [r["pattern"] for r in c["routes"]]
assert patterns == ["slides.example.test/fixture26", "slides.example.test/fixture26/*"], patterns
assert all(r["zone_name"] == "example.test" for r in c["routes"])
PY
python3 - ".altmejd-slides-publish.json" <<'PY' || fail "publish state did not record the account"
import json, sys
s = json.load(open(sys.argv[1]))
assert s["decks"]["fixture26"]["accountId"] == "11111111111111111111111111111111"
PY

# Publishing this deck must never touch any other worker.
if grep -v "fixture26" "$FAKE_WRANGLER_LOG" | grep -q "altmejd-slides-"; then
  fail "publish touched a worker other than its own"
fi

# --- unchanged republish is skipped ----------------------------------------
: >"$FAKE_WRANGLER_LOG"
staging2="$work_dir/staging2"
out2="$(quarto run "$publisher" --no-verify --keep-staging --staging-dir "$staging2")" ||
  fail "second publish exited non-zero"
echo "$out2" | grep -q "skipping deploy" || fail "unchanged republish was not skipped"
if grep -q " deploy " "$FAKE_WRANGLER_LOG"; then
  fail "unchanged republish still deployed"
fi

# An explicit account that conflicts with the recorded owner must fail before
# any remote lookup or deployment.
: >"$FAKE_WRANGLER_LOG"
if CLOUDFLARE_ACCOUNT_ID=22222222222222222222222222222222 \
  quarto run "$publisher" --no-verify --keep-staging --staging-dir "$work_dir/staging-account" \
  >"$work_dir/account-mismatch.log" 2>&1; then
  fail "publish ignored an account mismatch"
fi
grep -q "publish record belongs to Cloudflare account" "$work_dir/account-mismatch.log" ||
  fail "account mismatch lacked an explanation"
test ! -s "$FAKE_WRANGLER_LOG" || fail "account mismatch contacted Wrangler"

# --- changed host redeploys despite unchanged content -----------------------
: >"$FAKE_WRANGLER_LOG"
quarto run "$publisher" --no-verify --host other.example.test --keep-staging \
  --staging-dir "$work_dir/staging-host" || fail "host-change publish exited non-zero"
grep -q " deploy " "$FAKE_WRANGLER_LOG" || fail "host change did not trigger a redeploy"
python3 - "$FAKE_WRANGLER_STATE/config-altmejd-slides-fixture26.json" <<'PY' || fail "host change did not update the deployed routes"
import json, sys
c = json.load(open(sys.argv[1]))
assert all(r["pattern"].startswith("other.example.test/") for r in c["routes"])
PY
# Restore the YAML host for the remaining checks.
quarto run "$publisher" --no-verify --keep-staging \
  --staging-dir "$work_dir/staging-host2" >/dev/null || fail "host restore publish failed"

# --- forced republish deploys again ----------------------------------------
: >"$FAKE_WRANGLER_LOG"
staging3="$work_dir/staging3"
quarto run "$publisher" --no-verify --force --keep-staging --staging-dir "$staging3" ||
  fail "forced publish exited non-zero"
grep -q " deploy " "$FAKE_WRANGLER_LOG" || fail "forced republish did not deploy"

# --- unmanaged collision refused -------------------------------------------
touch "$FAKE_WRANGLER_STATE/deployed-altmejd-slides-stolen"
rm -f ".altmejd-slides-publish.json"
: >"$FAKE_WRANGLER_LOG"
staging4="$work_dir/staging4"
if quarto run "$publisher" --no-verify --slug stolen --keep-staging --staging-dir "$staging4" \
  >"$work_dir/collision.log" 2>&1; then
  fail "publish adopted an unmanaged worker without --adopt"
fi
grep -q "already exists" "$work_dir/collision.log" || fail "collision refusal lacked explanation"
if grep -q " deploy " "$FAKE_WRANGLER_LOG"; then
  fail "collision still deployed"
fi
if quarto run "$publisher" --no-verify --slug stolen --force --keep-staging \
  --staging-dir "$work_dir/staging4b" >/dev/null 2>&1; then
  fail "--force bypassed the unmanaged-worker collision guard"
fi
quarto run "$publisher" --no-verify --slug stolen --adopt --keep-staging \
  --staging-dir "$work_dir/staging5" || fail "--adopt did not allow the takeover"

# --- zero-config defaults: host slides.altmejd.se, slug from repo name ------
defaults_dir="$work_dir/my-course-talk"
mkdir -p "$defaults_dir"
cat >"$defaults_dir/slides.qmd" <<'QMD'
---
title: "Defaults Fixture"
format: revealjs
---

## Only slide

Content.
QMD
(cd "$defaults_dir" &&
  quarto run "$publisher" --no-verify --keep-staging --staging-dir "$defaults_dir/staging") ||
  fail "zero-config publish exited non-zero"
defaults_config="$FAKE_WRANGLER_STATE/config-altmejd-slides-my-course-talk.json"
test -f "$defaults_config" || fail "default slug was not taken from the repository name"
python3 - "$defaults_config" <<'PY' || fail "default host or zone is wrong"
import json, sys
c = json.load(open(sys.argv[1]))
patterns = [r["pattern"] for r in c["routes"]]
assert patterns == [
    "slides.altmejd.se/my-course-talk",
    "slides.altmejd.se/my-course-talk/*",
], patterns
assert all(r["zone_name"] == "altmejd.se" for r in c["routes"])
PY

# --- gateway bootstrap ------------------------------------------------------
: >"$FAKE_WRANGLER_LOG"
quarto run "$publisher" --bootstrap-gateway --host slides.example.test ||
  fail "gateway bootstrap exited non-zero"
gateway_config="$FAKE_WRANGLER_STATE/config-altmejd-slides-gateway.json"
test -f "$gateway_config" || fail "gateway deploy did not run"
python3 - "$gateway_config" <<'PY' || fail "gateway wrangler config is wrong"
import json, sys
c = json.load(open(sys.argv[1]))
assert c["name"] == "altmejd-slides-gateway"
assert c["routes"] == [{"pattern": "slides.example.test", "custom_domain": True}]
PY

# --- Quarto project with output-dir, plus artifact publishing ---------------
outdir_proj="$work_dir/outdir-proj"
mkdir -p "$outdir_proj/fig-web"
printf 'project:\n  output-dir: _site\n' >"$outdir_proj/_quarto.yml"
cat >"$outdir_proj/talk.qmd" <<'QMD'
---
title: "OutDir Fixture"
format: revealjs
altmejd-slides:
  publish:
    cloudflare:
      host: slides.example.test
      slug: outdir26
      artifacts:
        presentation-pdf:
          source: slides-src.pdf
          target: slides.pdf
---

## One

![](fig-web/dot.svg)
QMD
printf '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' \
  >"$outdir_proj/fig-web/dot.svg"
printf '%%PDF-1.4 fake\n' >"$outdir_proj/slides-src.pdf"
(cd "$outdir_proj" &&
  quarto run "$publisher" --stage-only --staging-dir "$outdir_proj/staging") ||
  fail "output-dir stage-only exited non-zero"
test -f "$outdir_proj/staging/public/outdir26/index.html" ||
  fail "output-dir project entry not staged as index.html"
test -d "$outdir_proj/staging/public/outdir26/talk_files" ||
  fail "output-dir project _files tree not staged"
test -f "$outdir_proj/staging/public/outdir26/fig-web/dot.svg" ||
  fail "output-dir project asset directory not staged"
test -f "$outdir_proj/staging/public/outdir26/slides.pdf" ||
  fail "configured artifact not staged at its target"

# A configured artifact whose source is missing must fail loudly.
rm "$outdir_proj/slides-src.pdf"
if (cd "$outdir_proj" &&
  quarto run "$publisher" --stage-only --staging-dir "$outdir_proj/staging2") \
  >"$work_dir/artifact-missing.log" 2>&1; then
  fail "missing artifact source did not fail the publish"
fi
grep -q 'artifact "presentation-pdf" source does not exist' "$work_dir/artifact-missing.log" ||
  fail "missing-artifact failure lacked a clear message"

# --- deploy succeeds, verification fails, retry recovers without --adopt ----
verify_deck="$work_dir/verify-deck"
mkdir -p "$verify_deck"
cat >"$verify_deck/talk.qmd" <<'QMD'
---
title: "Verify Fixture"
format: revealjs
altmejd-slides:
  publish:
    cloudflare:
      host: slides.example.test
      slug: verify26
---

## One

Content.
QMD
verify_staging="$work_dir/verify-staging"
: >"$FAKE_WRANGLER_LOG"
if (cd "$verify_deck" &&
  ALTMEJD_SLIDES_VERIFY_BASE="http://127.0.0.1:1" \
    ALTMEJD_SLIDES_VERIFY_ATTEMPTS=1 ALTMEJD_SLIDES_VERIFY_DELAY_MS=1 \
    quarto run "$publisher" --keep-staging --staging-dir "$verify_staging") \
  >"$work_dir/verify-fail.log" 2>&1; then
  fail "publish with unreachable verification URL did not exit non-zero"
fi
grep -q " deploy " "$FAKE_WRANGLER_LOG" || fail "deploy did not happen before verification"
python3 - "$verify_deck/.altmejd-slides-publish.json" <<'PY' || fail "failed verify not recorded as pending"
import json, sys
s = json.load(open(sys.argv[1]))
assert s["decks"]["verify26"]["verification"] == "pending"
PY

python3 -c '
import functools, http.server, socketserver, sys
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=sys.argv[1])
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", 0), handler) as srv:
    print(srv.server_address[1], flush=True)
    srv.serve_forever()
' "$verify_staging/public" >"$work_dir/port.txt" 2>/dev/null &
server_pid=$!
for _ in $(seq 1 50); do
  [ -s "$work_dir/port.txt" ] && break
  sleep 0.1
done
port="$(head -n1 "$work_dir/port.txt")"
[ -n "$port" ] || fail "verification fixture server did not start"

: >"$FAKE_WRANGLER_LOG"
(cd "$verify_deck" &&
  ALTMEJD_SLIDES_VERIFY_BASE="http://127.0.0.1:$port" \
    ALTMEJD_SLIDES_VERIFY_ATTEMPTS=2 ALTMEJD_SLIDES_VERIFY_DELAY_MS=100 \
    quarto run "$publisher" --keep-staging --staging-dir "$work_dir/verify-staging2") \
  >"$work_dir/verify-retry.log" 2>&1 || fail "verification retry exited non-zero"
grep -q "retrying the pending verification" "$work_dir/verify-retry.log" ||
  fail "retry did not recognize the pending deployment"
if grep -q " deploy " "$FAKE_WRANGLER_LOG"; then
  fail "verification retry redeployed unchanged content"
fi
if grep -q -- "--adopt" "$work_dir/verify-retry.log"; then
  fail "retry demanded --adopt for its own worker"
fi
python3 - "$verify_deck/.altmejd-slides-publish.json" <<'PY' || fail "successful retry did not finalize the state"
import json, sys
s = json.load(open(sys.argv[1]))
assert s["decks"]["verify26"]["verification"] == "ok"
PY

(cd "$verify_deck" &&
  quarto run "$publisher" --no-verify --keep-staging --staging-dir "$work_dir/verify-staging3") \
  >"$work_dir/verify-skip.log" 2>&1 || fail "post-verification republish exited non-zero"
grep -q "skipping deploy" "$work_dir/verify-skip.log" ||
  fail "verified unchanged republish was not skipped"

# A malformed state file must fail explicitly before any Cloudflare operation.
malformed_deck="$work_dir/malformed-deck"
mkdir -p "$malformed_deck"
printf '{"version":1,"decks":null}\n' >"$malformed_deck/.altmejd-slides-publish.json"
: >"$FAKE_WRANGLER_LOG"
if (cd "$malformed_deck" &&
  quarto run "$publisher" --unpublish --slug malformed --confirm malformed) \
  >"$work_dir/unpublish-malformed.log" 2>&1; then
  fail "unpublish accepted a malformed publish state"
fi
grep -q "invalid publish state in .altmejd-slides-publish.json" \
  "$work_dir/unpublish-malformed.log" ||
  fail "malformed publish state lacked an explicit error"
test ! -s "$FAKE_WRANGLER_LOG" || fail "malformed publish state contacted Wrangler"

# --- unpublish deletes only a recorded Worker and then updates state --------
# Unpublishing uses the recorded state and must not need a source deck or render.
mv "$verify_deck/talk.qmd" "$verify_deck/talk.qmd.archived"
: >"$FAKE_WRANGLER_LOG"
# Non-interactive use fails closed unless the exact slug is confirmed.
if (cd "$verify_deck" && quarto run "$publisher" --unpublish) \
  >"$work_dir/unpublish-unconfirmed.log" 2>&1; then
  fail "non-interactive unpublish proceeded without explicit confirmation"
fi
grep -q "requires an interactive terminal" "$work_dir/unpublish-unconfirmed.log" ||
  fail "non-interactive refusal lacked confirmation guidance"
test ! -s "$FAKE_WRANGLER_LOG" || fail "unconfirmed unpublish contacted Wrangler"

(cd "$verify_deck" && quarto run "$publisher" --unpublish --confirm verify26) \
  >"$work_dir/unpublish.log" 2>&1 || fail "unpublish exited non-zero"
grep -q "^wrangler delete --name altmejd-slides-verify26 --config " "$FAKE_WRANGLER_LOG" ||
  fail "unpublish did not delete exactly the recorded Worker"
python3 - "$FAKE_WRANGLER_STATE/delete-config-altmejd-slides-verify26.json" <<'PY' || fail "unpublish did not pin the recorded account"
import json, sys
c = json.load(open(sys.argv[1]))
assert c == {
    "name": "altmejd-slides-verify26",
    "account_id": "11111111111111111111111111111111",
}, c
PY
test ! -f "$FAKE_WRANGLER_STATE/deployed-altmejd-slides-verify26" ||
  fail "unpublish left the Worker deployed"
python3 - "$verify_deck/.altmejd-slides-publish.json" <<'PY' || fail "unpublish did not remove the state entry"
import json, sys
s = json.load(open(sys.argv[1]))
assert s == {"version": 1, "decks": {}}, s
PY

# A remote Worker without a local ownership record must never be deleted.
touch "$FAKE_WRANGLER_STATE/deployed-altmejd-slides-unowned"
: >"$FAKE_WRANGLER_LOG"
if (cd "$verify_deck" && quarto run "$publisher" --unpublish --slug unowned) \
  >"$work_dir/unpublish-unowned.log" 2>&1; then
  fail "unpublish deleted an unowned Worker"
fi
grep -q "refusing to delete an unowned Worker" "$work_dir/unpublish-unowned.log" ||
  fail "unowned Worker refusal lacked an explanation"
if grep -q " delete " "$FAKE_WRANGLER_LOG"; then
  fail "unpublish invoked wrangler delete for an unowned Worker"
fi
test -f "$FAKE_WRANGLER_STATE/deployed-altmejd-slides-unowned" ||
  fail "unpublish removed the unowned Worker marker"

# Recreate the owned Worker, then prove failures and declined confirmation keep
# the state entry. The post-delete existence check catches Wrangler's successful
# exit when a user declines its confirmation.
mv "$verify_deck/talk.qmd.archived" "$verify_deck/talk.qmd"
(cd "$verify_deck" &&
  quarto run "$publisher" --no-verify --keep-staging --staging-dir "$work_dir/verify-staging4") \
  >/dev/null 2>&1 || fail "republish after unpublish failed"

# When several records exist, an explicit slug is required before any remote
# lookup or deletion. Add and then remove a second valid record for this check.
python3 - "$verify_deck/.altmejd-slides-publish.json" <<'PY'
import json, sys
path = sys.argv[1]
s = json.load(open(path))
s["decks"]["other-talk"] = {**s["decks"]["verify26"], "worker": "altmejd-slides-other-talk"}
with open(path, "w") as f:
    json.dump(s, f, indent=2)
    f.write("\n")
PY
: >"$FAKE_WRANGLER_LOG"
if (cd "$verify_deck" && quarto run "$publisher" --unpublish) \
  >"$work_dir/unpublish-ambiguous.log" 2>&1; then
  fail "unpublish guessed between several state records"
fi
grep -q "several published talks are recorded" "$work_dir/unpublish-ambiguous.log" ||
  fail "ambiguous unpublish refusal lacked an explanation"
test ! -s "$FAKE_WRANGLER_LOG" || fail "ambiguous unpublish contacted Wrangler"
python3 - "$verify_deck/.altmejd-slides-publish.json" <<'PY'
import json, sys
path = sys.argv[1]
s = json.load(open(path))
del s["decks"]["other-talk"]
with open(path, "w") as f:
    json.dump(s, f, indent=2)
    f.write("\n")
PY

if (cd "$verify_deck" &&
  FAKE_WRANGLER_DELETE_FAIL=1 quarto run "$publisher" --unpublish --confirm verify26) \
  >"$work_dir/unpublish-fail.log" 2>&1; then
  fail "unpublish ignored a Wrangler deletion failure"
fi
python3 - "$verify_deck/.altmejd-slides-publish.json" <<'PY' || fail "delete failure dropped the state entry"
import json, sys
s = json.load(open(sys.argv[1]))
assert "verify26" in s["decks"], s
PY

if (cd "$verify_deck" &&
  FAKE_WRANGLER_DELETE_KEEP=1 quarto run "$publisher" --unpublish --confirm verify26) \
  >"$work_dir/unpublish-declined.log" 2>&1; then
  fail "unpublish accepted a deletion that left the Worker live"
fi
grep -q "still exists; local record kept" "$work_dir/unpublish-declined.log" ||
  fail "declined deletion did not explain that state was preserved"
python3 - "$verify_deck/.altmejd-slides-publish.json" <<'PY' || fail "declined deletion dropped the state entry"
import json, sys
s = json.load(open(sys.argv[1]))
assert "verify26" in s["decks"], s
PY

# Reconcile state when the owned Worker was already deleted elsewhere.
rm -f "$FAKE_WRANGLER_STATE/deployed-altmejd-slides-verify26"
: >"$FAKE_WRANGLER_LOG"
(cd "$verify_deck" && quarto run "$publisher" --unpublish --confirm verify26) \
  >"$work_dir/unpublish-stale.log" 2>&1 || fail "stale-state cleanup failed"
grep -q "already absent; removing its stale local record" "$work_dir/unpublish-stale.log" ||
  fail "stale-state cleanup was not reported"
if grep -q " delete " "$FAKE_WRANGLER_LOG"; then
  fail "stale-state cleanup invoked an unnecessary delete"
fi
python3 - "$verify_deck/.altmejd-slides-publish.json" <<'PY' || fail "stale-state cleanup kept the record"
import json, sys
s = json.load(open(sys.argv[1]))
assert s == {"version": 1, "decks": {}}, s
PY

echo "publish integration: all checks passed"
