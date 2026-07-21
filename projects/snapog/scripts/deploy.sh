#!/usr/bin/env bash
# ============================================================
# SnapOG — first-deploy / redeploy helper
# ============================================================
# Idempotent-ish walkthrough of everything needed to take SnapOG from
# a clone to a live, billable Worker on Cloudflare.
#
# Usage:
#   ./scripts/deploy.sh --check     # verify prerequisites, change nothing
#   ./scripts/deploy.sh             # provision (D1/R2/migrations) + deploy
#   ./scripts/deploy.sh --env production
#
# It never stores secrets; it tells you which `wrangler secret put` and
# dashboard values to set. Safe to re-run: creating an existing D1/R2
# resource is reported and skipped.
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

ENV_ARG=""
CHECK_ONLY=0
prev=""
for arg in "$@"; do
    if [ "$prev" = "--env" ]; then
        ENV_ARG="$arg"; prev=""; continue
    fi
    case "$arg" in
        --check) CHECK_ONLY=1 ;;
        --env) prev="--env" ;;          # next token is the env name
        --env=*) ENV_ARG="${arg#--env=}" ;;
        production|staging) ENV_ARG="$arg" ;;
        *) echo "Unknown arg: $arg" >&2; exit 2 ;;
    esac
done
ENV_FLAG=()
[ -n "$ENV_ARG" ] && ENV_FLAG=(--env "$ENV_ARG")

wrangler() { npx --yes wrangler "$@"; }

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

# --- 1. Prerequisites ---------------------------------------------
step "Checking prerequisites"
command -v node >/dev/null 2>&1 || { echo "node not found"; exit 1; }
ok "node $(node --version)"
if ! npx --yes wrangler --version >/dev/null 2>&1; then
    echo "wrangler not available (run: npm install)"; exit 1
fi
ok "wrangler $(wrangler --version 2>/dev/null | head -n1)"

if wrangler whoami >/dev/null 2>&1; then
    ok "authenticated with Cloudflare"
else
    warn "not logged in — run: npx wrangler login"
    [ "$CHECK_ONLY" -eq 1 ] || { echo "Aborting: log in first."; exit 1; }
fi

if grep -q 'placeholder-set-after-wrangler-d1-create' wrangler.toml; then
    warn "wrangler.toml still has a placeholder database_id (step 2 will create the DB)"
else
    ok "database_id looks set in wrangler.toml"
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
    step "Check complete (no changes made)"
    echo "Next: run without --check to provision and deploy."
    exit 0
fi

# --- 2. D1 database ------------------------------------------------
step "Provisioning D1 database (snapog-db)"
if wrangler d1 info snapog-db >/dev/null 2>&1; then
    ok "D1 database snapog-db already exists"
else
    wrangler d1 create snapog-db || warn "d1 create returned non-zero (may already exist)"
    warn "Copy the returned database_id into wrangler.toml (all env blocks), then re-run ./scripts/deploy.sh."
    # Stop cleanly here: migrations/deploy can't work until the real
    # database_id is in wrangler.toml (it still holds the placeholder).
    exit 0
fi

# --- 3. Migrations -------------------------------------------------
step "Applying D1 migrations (remote)"
wrangler d1 migrations apply snapog-db --remote "${ENV_FLAG[@]+"${ENV_FLAG[@]}"}"
ok "migrations applied"

# --- 4. R2 bucket --------------------------------------------------
step "Provisioning R2 bucket (snapog-og-cache)"
if wrangler r2 bucket list 2>/dev/null | grep -q 'snapog-og-cache'; then
    ok "R2 bucket snapog-og-cache already exists"
else
    wrangler r2 bucket create snapog-og-cache || warn "r2 create returned non-zero (may already exist)"
fi

# --- 5. Secrets reminder ------------------------------------------
step "Secrets (set once; values never printed)"
cat <<'SECRETS'
  Set these with `npx wrangler secret put <NAME>` (add --env if deploying an env):
    STRIPE_SECRET_KEY       sk_live_... (or sk_test_...)
    STRIPE_WEBHOOK_SECRET   whsec_...  (from the Stripe webhook you create)
    ADMIN_METRICS_TOKEN     a long random string (loop reads /admin/metrics)
    AUTH_SECRET             a long random string (reserved for signed URLs)
  And in wrangler.toml [vars], set (non-secret):
    STRIPE_PRICE_PRO / STRIPE_PRICE_BUSINESS, APP_URL,
    LEGAL_ENTITY / LEGAL_EMAIL / LEGAL_JURISDICTION
SECRETS

# --- 6. Deploy -----------------------------------------------------
step "Deploying"
wrangler deploy "${ENV_FLAG[@]+"${ENV_FLAG[@]}"}"

step "Post-deploy checklist"
cat <<'POST'
  1. Stripe: create Pro ($19) and Business ($49) recurring Prices; paste their
     price ids into wrangler.toml and redeploy.
  2. Stripe: add a webhook -> https://<your-domain>/billing/webhook subscribed to
     customer.subscription.created/updated/deleted. Put its signing secret in
     STRIPE_WEBHOOK_SECRET.
  3. Fill LEGAL_ENTITY / LEGAL_EMAIL / LEGAL_JURISDICTION so /terms /privacy
     /refunds are finalized (required before charging).
  4. Point the autonomous loop at metrics: METRICS_URL=https://<domain>/admin/metrics
     METRICS_TOKEN=<ADMIN_METRICS_TOKEN> in .auto-loop.env.
  5. Smoke test: curl "https://<domain>/health" and register a key.
POST
ok "done"
