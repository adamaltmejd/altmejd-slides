#!/usr/bin/env bash
# End-to-end test of the Cloudflare publisher against a mocked wrangler.
# Requires quarto. Never contacts Cloudflare: a fake wrangler on PATH records
# every invocation and simulates worker existence with marker files.
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
publisher="$repo_dir/_extensions/altmejd-slides/tools/publish-cloudflare.ts"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/altmejd-publish-test.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

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

# --- first publish ----------------------------------------------------------
quarto run "$publisher" --no-verify --keep-staging --staging-dir "$staging" ||
  fail "first publish exited non-zero"

test -f "$staging/public/fixture26/index.html" || fail "entry not staged as <slug>/index.html"
test -f "$staging/public/fixture26/assets/dot.svg" || fail "referenced asset not staged"
test -d "$staging/public/fixture26/mytalk_files" || fail "Quarto dependency tree not staged"
test -f ".altmejd-slides-publish.json" || fail "publish state file not written"

grep -q "deploy --config" "$FAKE_WRANGLER_LOG" || fail "wrangler deploy was not invoked"
config="$FAKE_WRANGLER_STATE/config-altmejd-slides-fixture26.json"
test -f "$config" || fail "deploy did not use the deterministic worker name"
python3 - "$config" <<'PY' || fail "deployed wrangler config is wrong"
import json, sys
c = json.load(open(sys.argv[1]))
assert c["name"] == "altmejd-slides-fixture26"
assert c["workers_dev"] is False
assert c["assets"] == {"directory": "./public"}
patterns = [r["pattern"] for r in c["routes"]]
assert patterns == ["slides.example.test/fixture26", "slides.example.test/fixture26/*"], patterns
assert all(r["zone_name"] == "example.test" for r in c["routes"])
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
quarto run "$publisher" --no-verify --slug stolen --adopt --keep-staging \
  --staging-dir "$work_dir/staging5" || fail "--adopt did not allow the takeover"

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

echo "publish integration: all checks passed"
