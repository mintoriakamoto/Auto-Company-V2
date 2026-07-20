#!/bin/bash
# ============================================================
# Auto Company — Install Linux systemd user daemon
# ============================================================
# Works on native Linux (e.g. Ubuntu 26.04) and WSL with systemd
# enabled. Installs a per-user systemd service:
#   ~/.config/systemd/user/auto-company.service
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SERVICE_NAME="auto-company.service"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
SERVICE_PATH="$SYSTEMD_USER_DIR/$SERVICE_NAME"
CURRENT_USER="$(id -un)"

if ! command -v systemctl >/dev/null 2>&1; then
    echo "Error: systemctl not found. On WSL, enable systemd first."
    exit 1
fi

if ! systemctl --user --version >/dev/null 2>&1; then
    echo "Error: systemctl --user is unavailable for this session."
    echo "Check WSL systemd setup and login session."
    exit 1
fi

mkdir -p "$SYSTEMD_USER_DIR"

# The env file may carry credentials; keep it private to the user.
if [ -f "$PROJECT_DIR/.auto-loop.env" ]; then
    chmod 600 "$PROJECT_DIR/.auto-loop.env"
fi

cat > "$SERVICE_PATH" << EOF
[Unit]
Description=Auto Company Loop
After=default.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
EnvironmentFile=-$PROJECT_DIR/.auto-loop.env
ExecStart=/usr/bin/bash $PROJECT_DIR/scripts/core/auto-loop.sh
Restart=always
RestartSec=10
TimeoutStopSec=45

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME" >/dev/null

echo "Installed: $SERVICE_PATH"
echo "Enabled: $SERVICE_NAME"

if command -v loginctl >/dev/null 2>&1; then
    linger_state="$(loginctl show-user "$CURRENT_USER" -p Linger --value 2>/dev/null || true)"
    if [ "$linger_state" = "no" ]; then
        echo ""
        echo "Note: linger is disabled for user '$CURRENT_USER'."
        echo "Run once to improve background persistence:"
        echo "  sudo loginctl enable-linger $CURRENT_USER"
    fi
fi

echo ""
echo "Next commands:"
echo "  systemctl --user start $SERVICE_NAME"
echo "  systemctl --user status $SERVICE_NAME --no-pager"
