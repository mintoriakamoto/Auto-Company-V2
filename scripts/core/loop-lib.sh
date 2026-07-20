#!/bin/bash
# ============================================================
# Auto Company — Loop core library
# ============================================================
# Pure-ish helper functions shared by auto-loop.sh and covered by
# tests/loop/test_loop_lib.bats. Functions read these globals, which
# the caller (auto-loop.sh or a test) must set before use:
#
#   PROJECT_DIR LOG_DIR CONSENSUS_FILE STATE_FILE
#   MAX_LOGS MAIN_LOG_KEEP AUTO_LOOP_PROTECT_GITIGNORE
#   CONSENSUS_HISTORY_DIR CONSENSUS_HISTORY_KEEP
#   ENGINE MODEL_LABEL CLAUDE_BIN CODEX_BIN
#   loop_count error_count total_cost_usd
#
# shellcheck disable=SC2154  # globals are assigned by the sourcing script
# ============================================================

log() {
    local timestamp
    timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    local msg="[$timestamp] $1"
    echo "$msg" >> "$LOG_DIR/auto-loop.log"
    if [ -t 1 ]; then
        echo "$msg"
    fi
}

log_cycle() {
    local cycle_num=$1
    local status=$2
    local msg=$3
    local timestamp
    timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] Cycle #$cycle_num [$status] $msg" >> "$LOG_DIR/auto-loop.log"
    if [ -t 1 ]; then
        echo "[$timestamp] Cycle #$cycle_num [$status] $msg"
    fi
}

check_usage_limit() {
    # Only inspect the tail of the output — engine errors surface at the
    # end — and match narrow phrases. Broad tokens (bare "billing",
    # "quota", "429") false-positive on ordinary business content the
    # cycle may legitimately print, silently stalling the loop for
    # LIMIT_WAIT_SECONDS. Callers must additionally gate on a non-zero
    # engine exit code.
    local output_tail
    output_tail=$(printf '%s\n' "$1" | tail -n 50)
    if printf '%s' "$output_tail" | grep -qiE \
        "usage limit|rate.?limit|too many requests|resource_exhausted|overloaded|quota exceeded|insufficient credits|out of credits"; then
        return 0
    fi
    return 1
}

check_stop_requested() {
    if [ -f "$PROJECT_DIR/.auto-loop-stop" ]; then
        rm -f "$PROJECT_DIR/.auto-loop-stop"
        return 0
    fi
    return 1
}

accumulate_cycle_cost() {
    # Keep a running USD total across cycles. Non-numeric costs
    # (N/A, empty) are ignored.
    local cost="$1"
    if ! printf '%s' "$cost" | grep -qE '^[0-9]+(\.[0-9]+)?$'; then
        return 0
    fi
    total_cost_usd=$(awk -v a="${total_cost_usd:-0}" -v b="$cost" 'BEGIN { printf "%.4f", a + b }')
}

load_total_cost() {
    # Resume the cumulative spend counter from a previous run's state
    # file. Parsed with grep (never sourced) on purpose.
    total_cost_usd="0"
    local saved
    saved=$(grep -E '^TOTAL_COST_USD=' "$STATE_FILE" 2>/dev/null | tail -n1 | cut -d= -f2 || true)
    if printf '%s' "$saved" | grep -qE '^[0-9]+(\.[0-9]+)?$'; then
        total_cost_usd="$saved"
    fi
}

save_state() {
    cat > "$STATE_FILE" << EOF
LOOP_COUNT=$loop_count
ERROR_COUNT=$error_count
LAST_RUN=$(date '+%Y-%m-%d %H:%M:%S')
STATUS=$1
MODEL=$MODEL_LABEL
ENGINE=$ENGINE
TOTAL_COST_USD=${total_cost_usd:-0}
EOF
}

snapshot_gitignore() {
    if [ "$AUTO_LOOP_PROTECT_GITIGNORE" = "0" ]; then
        echo ""
        return
    fi

    local gitignore_file="$PROJECT_DIR/.gitignore"
    local snapshot_file=""
    if [ -f "$gitignore_file" ]; then
        snapshot_file=$(mktemp)
        cp "$gitignore_file" "$snapshot_file"
    fi
    echo "$snapshot_file"
}

restore_gitignore_if_changed() {
    local snapshot_file="$1"
    if [ "$AUTO_LOOP_PROTECT_GITIGNORE" = "0" ]; then
        if [ -n "$snapshot_file" ]; then
            rm -f "$snapshot_file"
        fi
        return 0
    fi

    local gitignore_file="$PROJECT_DIR/.gitignore"
    local changed=0

    if [ -f "$gitignore_file" ]; then
        if [ -z "$snapshot_file" ] || [ ! -f "$snapshot_file" ]; then
            changed=1
        elif ! cmp -s "$gitignore_file" "$snapshot_file"; then
            changed=1
        fi
    else
        if [ -n "$snapshot_file" ] && [ -f "$snapshot_file" ]; then
            changed=1
        fi
    fi

    if [ "$changed" -eq 1 ]; then
        if [ -n "$snapshot_file" ] && [ -f "$snapshot_file" ]; then
            cp "$snapshot_file" "$gitignore_file"
            log_cycle "$loop_count" "GUARD" "Blocked cycle mutation of .gitignore and restored baseline"
        else
            rm -f "$gitignore_file"
            log_cycle "$loop_count" "GUARD" "Blocked cycle-created .gitignore and removed it"
        fi
    fi

    # Guard the final cleanup: a bare `[ -n ] && rm` as the last command
    # returns 1 for an empty snapshot, which aborts a `set -e` caller.
    if [ -n "$snapshot_file" ]; then
        rm -f "$snapshot_file"
    fi
    return 0
}

get_file_size_bytes() {
    local target_file="$1"
    if [ ! -f "$target_file" ]; then
        echo 0
        return
    fi

    if stat -c%s "$target_file" >/dev/null 2>&1; then
        stat -c%s "$target_file"
        return
    fi

    if stat -f%z "$target_file" >/dev/null 2>&1; then
        stat -f%z "$target_file"
        return
    fi

    wc -c < "$target_file" | tr -d ' '
}

rotate_logs() {
    # Keep only the latest N cycle logs
    local count
    count=$(find "$LOG_DIR" -name "cycle-*.log" -type f 2>/dev/null | wc -l | tr -d ' ')
    if [ "$count" -gt "$MAX_LOGS" ]; then
        local to_delete=$((count - MAX_LOGS))
        find "$LOG_DIR" -name "cycle-*.log" -type f | sort | head -n "$to_delete" | xargs rm -f 2>/dev/null || true
        log "Log rotation: removed $to_delete old cycle logs"
    fi

    # Rotate main log if over 10MB; keep MAIN_LOG_KEEP timestamped
    # generations instead of a single .old file.
    local log_size
    log_size=$(get_file_size_bytes "$LOG_DIR/auto-loop.log")
    if [ "$log_size" -gt 10485760 ]; then
        mv "$LOG_DIR/auto-loop.log" "$LOG_DIR/auto-loop.log.$(date '+%Y%m%d-%H%M%S')"
        log "Main log rotated (was ${log_size} bytes)"
    fi
    local old_count
    old_count=$(find "$LOG_DIR" -name "auto-loop.log.*" -type f 2>/dev/null | wc -l | tr -d ' ')
    if [ "$old_count" -gt "$MAIN_LOG_KEEP" ]; then
        find "$LOG_DIR" -name "auto-loop.log.*" -type f | sort | head -n $((old_count - MAIN_LOG_KEEP)) | xargs rm -f 2>/dev/null || true
    fi
}

cleanup_accidental_root_artifacts() {
    local removed=0
    local removed_names=""
    local f base

    # Known accidental artifacts caused by malformed shell redirections in generated commands.
    for f in "$PROJECT_DIR"/=* "$PROJECT_DIR"/口径说明*; do
        [ -f "$f" ] || continue
        if [ ! -s "$f" ]; then
            rm -f "$f"
            removed=$((removed + 1))
            base=$(basename "$f")
            if [ -z "$removed_names" ]; then
                removed_names="$base"
            else
                removed_names="$removed_names, $base"
            fi
        fi
    done

    if [ "$removed" -gt 0 ]; then
        log_cycle "$loop_count" "GUARD" "Removed accidental root zero-byte artifact(s): $removed_names"
    fi
}

backup_consensus() {
    if [ -f "$CONSENSUS_FILE" ]; then
        cp "$CONSENSUS_FILE" "$CONSENSUS_FILE.bak"
    fi
}

restore_consensus() {
    if [ -f "$CONSENSUS_FILE.bak" ]; then
        cp "$CONSENSUS_FILE.bak" "$CONSENSUS_FILE"
        log "Consensus restored from backup after failed cycle"
    fi
}

validate_consensus() {
    if [ ! -s "$CONSENSUS_FILE" ]; then
        return 1
    fi
    if ! grep -q "^# Auto Company Consensus" "$CONSENSUS_FILE"; then
        return 1
    fi
    if ! grep -q "^## Next Action" "$CONSENSUS_FILE"; then
        return 1
    fi
    if ! grep -q "^## Company State" "$CONSENSUS_FILE"; then
        return 1
    fi
    return 0
}

consensus_changed_since_backup() {
    if [ ! -f "$CONSENSUS_FILE" ]; then
        return 1
    fi

    if [ ! -f "$CONSENSUS_FILE.bak" ]; then
        return 0
    fi

    if cmp -s "$CONSENSUS_FILE" "$CONSENSUS_FILE.bak"; then
        return 1
    fi

    return 0
}

snapshot_consensus_history() {
    # Consensus is the company's entire cross-cycle memory; keep a
    # rolling history so a poisoned-but-"valid" consensus can be
    # recovered from more than one .bak generation.
    if [ "${CONSENSUS_HISTORY_KEEP:-0}" -le 0 ]; then
        return 0
    fi
    if [ ! -f "$CONSENSUS_FILE" ]; then
        return 0
    fi
    mkdir -p "$CONSENSUS_HISTORY_DIR"
    cp "$CONSENSUS_FILE" \
        "$CONSENSUS_HISTORY_DIR/consensus-$(printf '%06d' "${loop_count:-0}")-$(date '+%Y%m%d-%H%M%S').md"

    local count
    count=$(find "$CONSENSUS_HISTORY_DIR" -name 'consensus-*.md' -type f 2>/dev/null | wc -l | tr -d ' ')
    if [ "$count" -gt "$CONSENSUS_HISTORY_KEEP" ]; then
        find "$CONSENSUS_HISTORY_DIR" -name 'consensus-*.md' -type f | sort \
            | head -n $((count - CONSENSUS_HISTORY_KEEP)) | xargs rm -f 2>/dev/null || true
    fi
}

resolve_cli_bin() {
    # Resolve an engine CLI without spawning interactive shells:
    # `bash -ic` can hang or fail under systemd (profile scripts that
    # expect a TTY), so resolution is: explicit override, nvm installs,
    # well-known install dirs, then PATH.
    local override="$1"
    local name="$2"
    local candidate

    if [ -n "$override" ]; then
        if [ -x "$override" ]; then
            echo "$override"
            return 0
        fi
        if command -v "$override" >/dev/null 2>&1; then
            command -v "$override"
            return 0
        fi
    fi

    # Prefer nvm-local installs (highest node version wins).
    local nvm_candidate=""
    for candidate in "$HOME"/.nvm/versions/node/*/bin/"$name"; do
        if [ -x "$candidate" ]; then
            nvm_candidate="$candidate"
        fi
    done
    if [ -n "$nvm_candidate" ]; then
        echo "$nvm_candidate"
        return 0
    fi

    # Well-known install locations (native installer, npm -g, homebrew).
    for candidate in \
        "$HOME/.local/bin/$name" \
        "$HOME/.claude/local/$name" \
        "/usr/local/bin/$name" \
        "/opt/homebrew/bin/$name"; do
        if [ -x "$candidate" ]; then
            echo "$candidate"
            return 0
        fi
    done

    if command -v "$name" >/dev/null 2>&1; then
        command -v "$name"
        return 0
    fi

    return 1
}

resolve_claude_bin() {
    resolve_cli_bin "$CLAUDE_BIN" "claude"
}

resolve_codex_bin() {
    resolve_cli_bin "$CODEX_BIN" "codex"
}

resolve_engine_bin() {
    case "$ENGINE" in
        claude)
            resolve_claude_bin
            ;;
        codex)
            resolve_codex_bin
            ;;
        *)
            return 1
            ;;
    esac
}
