#!/bin/bash
# ============================================================
# Auto Company — Linux Status Report for Dashboard
# ============================================================
# Emits the same sectioned format as scripts/macos/status-mac.sh
# so the dashboard can reuse one parser. Works on native Linux
# (e.g. Ubuntu 26.04) and WSL with systemd enabled.
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_DIR="$PROJECT_DIR/logs"
STATE_FILE="$PROJECT_DIR/.auto-loop-state"
PID_FILE="$PROJECT_DIR/.auto-loop.pid"
CONSENSUS_FILE="$PROJECT_DIR/memories/consensus.md"
SERVICE_NAME="auto-company.service"
SERVICE_PATH="$HOME/.config/systemd/user/$SERVICE_NAME"

HAS_SYSTEMD_USER=0
if command -v systemctl >/dev/null 2>&1 && systemctl --user --version >/dev/null 2>&1; then
    HAS_SYSTEMD_USER=1
fi

loop_pid=""
if [ -f "$PID_FILE" ]; then
    loop_pid="$(cat "$PID_FILE")"
fi

echo "=== Guardian ==="
echo "State=not_applicable"
echo "Raw=No sleep guard needed under systemd on Linux"

echo ""
echo "=== Daemon ==="
daemon_state="not_installed"
daemon_raw="systemd user unit not installed"
daemon_pid=""
if [ "$HAS_SYSTEMD_USER" -eq 0 ]; then
    daemon_state="unavailable"
    daemon_raw="systemctl --user unavailable in this session"
elif [ -f "$SERVICE_PATH" ]; then
    active_state="$(systemctl --user is-active "$SERVICE_NAME" 2>/dev/null || true)"
    if [ "$active_state" = "active" ]; then
        daemon_state="active"
        daemon_raw="systemd --user $SERVICE_NAME active"
        daemon_pid="$(systemctl --user show "$SERVICE_NAME" -p MainPID --value 2>/dev/null || true)"
    else
        daemon_state="inactive"
        daemon_raw="systemd --user $SERVICE_NAME ${active_state:-inactive}"
    fi
fi
echo "State=$daemon_state"
if [[ "$daemon_pid" =~ ^[0-9]+$ ]] && [ "$daemon_pid" != "0" ]; then
    echo "MainPID=$daemon_pid"
fi
echo "Raw=$daemon_raw"

echo ""
echo "=== Autostart ==="
if [ "$HAS_SYSTEMD_USER" -eq 1 ]; then
    enabled_state="$(systemctl --user is-enabled "$SERVICE_NAME" 2>/dev/null || true)"
    if [ "$enabled_state" = "enabled" ]; then
        echo "State=configured"
        echo "Raw=systemd unit enabled"
    else
        echo "State=not_configured"
        echo "Raw=systemd unit ${enabled_state:-not installed}"
    fi
else
    echo "State=not_configured"
    echo "Raw=systemctl --user unavailable"
fi

echo ""
echo "=== Loop ==="
loop_state="stopped"
loop_raw="Loop not running"
if [ -n "$loop_pid" ]; then
    if kill -0 "$loop_pid" 2>/dev/null; then
        loop_state="running"
        loop_raw="Loop running"
    else
        loop_raw="Loop stopped (stale PID $loop_pid)"
    fi
fi
echo "State=$loop_state"
if [ "$loop_state" = "running" ]; then
    echo "Pid=$loop_pid"
fi
echo "Raw=$loop_raw"

echo ""
echo "=== State File ==="
if [ -f "$STATE_FILE" ]; then
    cat "$STATE_FILE"
fi

echo ""
echo "=== Latest Consensus ==="
if [ -f "$CONSENSUS_FILE" ]; then
    head -30 "$CONSENSUS_FILE"
else
    echo "(no consensus file)"
fi

echo ""
echo "=== Recent Log ==="
if [ -f "$LOG_DIR/auto-loop.log" ]; then
    tail -20 "$LOG_DIR/auto-loop.log"
else
    echo "(no log file)"
fi
