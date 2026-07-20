#!/usr/bin/env bats
# Tests for scripts/preflight.sh (offline config checks).
# Run: bats projects/snapog/test/preflight.bats

setup() {
    PREFLIGHT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)/scripts/preflight.sh"
    WORK="$(mktemp -d)"
}
teardown() { rm -rf "$WORK"; }

run_preflight() {
    PREFLIGHT_TOML="$WORK/wrangler.toml" bash "$PREFLIGHT" --offline
}

@test "NOT READY when config is unfilled" {
    cat > "$WORK/wrangler.toml" << 'EOF'
database_id = "placeholder-set-after-wrangler-d1-create"
APP_URL = ""
STRIPE_PRICE_PRO = ""
STRIPE_PRICE_BUSINESS = ""
LEGAL_ENTITY = ""
LEGAL_EMAIL = ""
LEGAL_JURISDICTION = ""
EOF
    run run_preflight
    [ "$status" -eq 1 ]
    [[ "$output" == *"NOT READY"* ]]
}

@test "READY when all required config is filled" {
    cat > "$WORK/wrangler.toml" << 'EOF'
database_id = "abc123-real-id"
APP_URL = "https://snapog.dev"
STRIPE_PRICE_PRO = "price_pro"
STRIPE_PRICE_BUSINESS = "price_biz"
LEGAL_ENTITY = "Acme LLC"
LEGAL_EMAIL = "legal@acme.test"
LEGAL_JURISDICTION = "Delaware, USA"
EOF
    run run_preflight
    [ "$status" -eq 0 ]
    [[ "$output" == *"READY"* ]]
}

@test "flags the specific missing item" {
    cat > "$WORK/wrangler.toml" << 'EOF'
database_id = "abc123-real-id"
APP_URL = "https://snapog.dev"
STRIPE_PRICE_PRO = "price_pro"
STRIPE_PRICE_BUSINESS = "price_biz"
LEGAL_ENTITY = ""
LEGAL_EMAIL = "legal@acme.test"
LEGAL_JURISDICTION = "Delaware, USA"
EOF
    run run_preflight
    [ "$status" -eq 1 ]
    [[ "$output" == *"LEGAL_ENTITY is empty"* ]]
}
