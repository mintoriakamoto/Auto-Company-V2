#!/bin/bash
# Compatibility wrapper: implementation moved to scripts/linux/.
exec "$(cd "$(dirname "$0")/.." && pwd)/linux/uninstall-linux-daemon.sh" "$@"
