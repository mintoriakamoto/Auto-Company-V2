#!/bin/bash
# ============================================================
# Auto Company — Stop on Linux (dashboard/CLI entry point)
# ============================================================
# Stops the systemd --user unit (so it does not auto-restart the
# loop) and then requests a graceful loop stop.
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="auto-company.service"

if command -v systemctl >/dev/null 2>&1 && systemctl --user --version >/dev/null 2>&1; then
    if systemctl --user is-active "$SERVICE_NAME" >/dev/null 2>&1; then
        systemctl --user stop "$SERVICE_NAME"
        echo "Stopped: $SERVICE_NAME"
    fi
fi

"$SCRIPT_DIR/../core/stop-loop.sh"
