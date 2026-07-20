#!/bin/bash
# Compatibility wrapper: implementation moved to scripts/linux/.
# The systemd --user daemon is identical on WSL and native Linux.
exec "$(cd "$(dirname "$0")/.." && pwd)/linux/install-linux-daemon.sh" "$@"
