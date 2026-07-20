#!/usr/bin/env bash
# ============================================================
# Auto Company — Metrics collector (closes the loop's feedback)
# ============================================================
# Fetches real growth/revenue metrics and writes them to
# memories/metrics.json so auto-loop.sh can inject ground truth into
# every cycle. Without this, the loop only ever sees its own guesses.
#
# Source resolution (first match wins):
#   1. METRICS_URL  — HTTP(S) endpoint returning JSON (e.g. a deployed
#                     product's /admin/metrics). METRICS_TOKEN is sent as
#                     a Bearer token if set.
#   2. METRICS_FILE — path to a local JSON file (dev / manual).
#   3. neither      — no-op (writes nothing); the loop proceeds without
#                     live metrics.
#
# This script never fails the cycle: on any error it leaves the previous
# metrics file untouched and exits 0.
# ============================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_FILE="${METRICS_OUT:-$PROJECT_DIR/memories/metrics.json}"
METRICS_URL="${METRICS_URL:-}"
METRICS_FILE="${METRICS_FILE:-}"
METRICS_TOKEN="${METRICS_TOKEN:-}"
METRICS_TIMEOUT="${METRICS_TIMEOUT:-20}"

mkdir -p "$(dirname "$OUT_FILE")"

valid_json() {
    if command -v jq >/dev/null 2>&1; then
        jq -e . >/dev/null 2>&1 <<< "$1"
    else
        # Fallback: accept a non-empty payload that looks like a JSON object.
        case "$(printf '%s' "$1" | tr -d '[:space:]')" in
            \{*\}) return 0 ;;
            *) return 1 ;;
        esac
    fi
}

write_if_valid() {
    local payload="$1"
    if [ -n "$payload" ] && valid_json "$payload"; then
        printf '%s\n' "$payload" > "$OUT_FILE"
        echo "metrics: wrote $OUT_FILE"
        return 0
    fi
    echo "metrics: source returned invalid/empty JSON; keeping previous metrics" >&2
    return 1
}

if [ -n "$METRICS_URL" ]; then
    if command -v curl >/dev/null 2>&1; then
        auth=()
        [ -n "$METRICS_TOKEN" ] && auth=(-H "Authorization: Bearer $METRICS_TOKEN")
        body="$(curl -fsS --max-time "$METRICS_TIMEOUT" "${auth[@]}" "$METRICS_URL" 2>/dev/null || true)"
        write_if_valid "$body" || true
    else
        echo "metrics: curl not available; cannot fetch METRICS_URL" >&2
    fi
elif [ -n "$METRICS_FILE" ] && [ -f "$METRICS_FILE" ]; then
    write_if_valid "$(cat "$METRICS_FILE")" || true
fi

exit 0
