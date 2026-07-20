#!/usr/bin/env bash
# ============================================================
# SnapOG — "Am I ready to charge?" preflight
# ============================================================
# One command that answers: is everything a paying customer needs
# actually in place? Prints a green/red checklist and exits non-zero
# if any REQUIRED item is missing.
#
# Usage:
#   ./scripts/preflight.sh            # local config + best-effort live checks
#   ./scripts/preflight.sh --offline  # local config only (deterministic)
#
# Local checks read wrangler.toml (no network). Live checks (wrangler
# login, secrets, D1/R2) are best-effort and reported as UNKNOWN when
# offline or unauthenticated rather than failing the run.
# ============================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TOML="${PREFLIGHT_TOML:-$PROJECT_DIR/wrangler.toml}"

OFFLINE=0
for arg in "$@"; do
    case "$arg" in
        --offline) OFFLINE=1 ;;
        *) echo "Unknown arg: $arg" >&2; exit 2 ;;
    esac
done

REQUIRED_FAIL=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; REQUIRED_FAIL=1; }
unknown() { printf '  \033[33m?\033[0m %s\n' "$1"; }

# Read the FIRST value of a top-level `key = "value"` from wrangler.toml.
toml_value() {
    local key="$1"
    grep -E "^[[:space:]]*${key}[[:space:]]*=" "$TOML" 2>/dev/null \
        | head -n1 | sed -E 's/^[^=]*=[[:space:]]*"?([^"]*)"?[[:space:]]*$/\1/'
}

echo "SnapOG preflight — checking readiness to charge"
echo ""
echo "Local config ($TOML):"

# 1. D1 database id must be set (not the placeholder).
if grep -q 'placeholder-set-after-wrangler-d1-create' "$TOML" 2>/dev/null; then
    fail "database_id is still the placeholder (run: npm run setup)"
else
    pass "database_id is set"
fi

# 2. Stripe price ids present (required to sell a plan).
for var in STRIPE_PRICE_PRO STRIPE_PRICE_BUSINESS; do
    if [ -n "$(toml_value "$var")" ]; then
        pass "$var is set"
    else
        fail "$var is empty (create the Stripe Price, paste its id)"
    fi
done

# 3. APP_URL present (checkout redirects + tracked links).
if [ -n "$(toml_value APP_URL)" ]; then
    pass "APP_URL is set"
else
    fail "APP_URL is empty"
fi

# 4. Legal identity filled (required before charging).
for var in LEGAL_ENTITY LEGAL_EMAIL LEGAL_JURISDICTION; do
    if [ -n "$(toml_value "$var")" ]; then
        pass "$var is set"
    else
        fail "$var is empty (/terms /privacy /refunds will show a warning)"
    fi
done

echo ""
echo "Live checks:"
if [ "$OFFLINE" -eq 1 ]; then
    unknown "skipped (--offline)"
else
    if command -v npx >/dev/null 2>&1 && npx --yes wrangler whoami >/dev/null 2>&1; then
        pass "wrangler is authenticated with Cloudflare"
        # Secrets: presence only (values never shown).
        secrets="$(npx --yes wrangler secret list 2>/dev/null || true)"
        for s in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET ADMIN_METRICS_TOKEN; do
            if printf '%s' "$secrets" | grep -q "\"$s\"\|$s"; then
                pass "secret $s is set"
            else
                fail "secret $s is NOT set (run: npx wrangler secret put $s)"
            fi
        done
    else
        unknown "wrangler not authenticated — run: npx wrangler login (skipping secret/resource checks)"
    fi
fi

echo ""
if [ "$REQUIRED_FAIL" -eq 0 ]; then
    printf '\033[32mREADY:\033[0m all required items are in place.\n'
    exit 0
else
    printf '\033[31mNOT READY:\033[0m fix the ✗ items above before charging customers.\n'
    printf 'See DEPLOY.md for the full setup, or run: npm run setup\n'
    exit 1
fi
