#!/bin/bash
# ============================================================
# Auto Company — Start on Linux (dashboard/CLI entry point)
# ============================================================
# Installs the systemd --user unit if missing, then starts it.
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="auto-company.service"
SERVICE_PATH="$HOME/.config/systemd/user/$SERVICE_NAME"

if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user --version >/dev/null 2>&1; then
    echo "Error: systemctl --user unavailable. Run the loop in the foreground instead:"
    echo "  make start"
    exit 1
fi

if [ ! -f "$SERVICE_PATH" ]; then
    "$SCRIPT_DIR/install-linux-daemon.sh"
fi

systemctl --user start "$SERVICE_NAME"
echo "Started: $SERVICE_NAME"
systemctl --user status "$SERVICE_NAME" --no-pager --lines 0 2>/dev/null || true
