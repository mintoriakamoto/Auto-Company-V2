#!/usr/bin/env bats
# ============================================================
# Auto Company — Unit tests for scripts/core/loop-lib.sh
# ============================================================
# Run: bats tests/loop/
# ============================================================

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
    WORK="$(mktemp -d)"

    # Globals the lib expects the caller to define.
    PROJECT_DIR="$WORK"
    LOG_DIR="$WORK/logs"
    CONSENSUS_FILE="$WORK/memories/consensus.md"
    STATE_FILE="$WORK/.auto-loop-state"
    MAX_LOGS=5
    MAIN_LOG_KEEP=2
    MAX_TOTAL_COST_USD=0
    AUTO_LOOP_PROTECT_GITIGNORE=1
    CONSENSUS_HISTORY_DIR="$WORK/memories/history"
    CONSENSUS_HISTORY_KEEP=3
    ENGINE=claude
    MODEL_LABEL=test-model
    CLAUDE_BIN=""
    CODEX_BIN=""
    loop_count=7
    error_count=0
    total_cost_usd=0

    mkdir -p "$LOG_DIR" "$WORK/memories"

    # shellcheck source=/dev/null
    source "$REPO_ROOT/scripts/core/loop-lib.sh"
}

teardown() {
    rm -rf "$WORK"
}

write_valid_consensus() {
    cat > "$CONSENSUS_FILE" << 'EOF'
# Auto Company Consensus

## Company State

Day 1.

## Next Action

Ship something.
EOF
}

# --- validate_consensus -------------------------------------------

@test "validate_consensus accepts a well-formed file" {
    write_valid_consensus
    run validate_consensus
    [ "$status" -eq 0 ]
}

@test "validate_consensus rejects a missing or empty file" {
    run validate_consensus
    [ "$status" -eq 1 ]
    : > "$CONSENSUS_FILE"
    run validate_consensus
    [ "$status" -eq 1 ]
}

@test "validate_consensus rejects a file missing required sections" {
    printf '# Auto Company Consensus\n\n## Next Action\n\nx\n' > "$CONSENSUS_FILE"
    run validate_consensus
    [ "$status" -eq 1 ]
}

# --- check_usage_limit --------------------------------------------

@test "check_usage_limit detects real limit errors" {
    run check_usage_limit "API Error: usage limit reached for this billing period"
    [ "$status" -eq 0 ]
    run check_usage_limit "error: rate_limit_error - too many requests"
    [ "$status" -eq 0 ]
    run check_usage_limit "RESOURCE_EXHAUSTED: quota exceeded"
    [ "$status" -eq 0 ]
    run check_usage_limit "overloaded_error"
    [ "$status" -eq 0 ]
}

@test "check_usage_limit ignores ordinary business content" {
    # These previously false-positived on bare quota/billing/429 tokens.
    run check_usage_limit "Updated the pricing page: billing FAQ and quota tiers documented"
    [ "$status" -eq 1 ]
    run check_usage_limit "Wrote docs for HTTP status codes including 429 handling advice"
    [ "$status" -eq 1 ]
}

@test "check_usage_limit only inspects the output tail" {
    local head_noise tail_ok
    head_noise="$(printf 'usage limit mentioned early\n')"
    tail_ok="$(printf 'line %d\n' $(seq 1 60))"
    run check_usage_limit "${head_noise}${tail_ok}"
    [ "$status" -eq 1 ]
}

# --- consensus backup / restore / change detection ----------------

@test "backup and restore round-trip preserves consensus" {
    write_valid_consensus
    backup_consensus
    echo "corrupted" > "$CONSENSUS_FILE"
    restore_consensus
    run validate_consensus
    [ "$status" -eq 0 ]
}

@test "consensus_changed_since_backup reflects file changes" {
    write_valid_consensus
    backup_consensus
    run consensus_changed_since_backup
    [ "$status" -eq 1 ]
    echo "## Extra" >> "$CONSENSUS_FILE"
    run consensus_changed_since_backup
    [ "$status" -eq 0 ]
}

# --- consensus history --------------------------------------------

@test "snapshot_consensus_history keeps at most CONSENSUS_HISTORY_KEEP files" {
    write_valid_consensus
    for i in 1 2 3 4 5; do
        loop_count="$i"
        echo "cycle $i" >> "$CONSENSUS_FILE"
        snapshot_consensus_history
        sleep 0.01
    done
    count=$(find "$CONSENSUS_HISTORY_DIR" -name 'consensus-*.md' | wc -l | tr -d ' ')
    [ "$count" -eq 3 ]
}

@test "snapshot_consensus_history is disabled when keep is zero" {
    CONSENSUS_HISTORY_KEEP=0
    write_valid_consensus
    snapshot_consensus_history
    [ ! -d "$CONSENSUS_HISTORY_DIR" ]
}

# --- cost accounting ----------------------------------------------

@test "accumulate_cycle_cost sums numeric costs and ignores N/A" {
    accumulate_cycle_cost "0.25"
    accumulate_cycle_cost "N/A"
    accumulate_cycle_cost ""
    accumulate_cycle_cost "1.5"
    [ "$total_cost_usd" = "1.7500" ]
}

@test "load_total_cost resumes from state file and rejects garbage" {
    printf 'LOOP_COUNT=3\nTOTAL_COST_USD=2.5000\n' > "$STATE_FILE"
    load_total_cost
    [ "$total_cost_usd" = "2.5000" ]
    printf 'TOTAL_COST_USD=$(rm -rf /)\n' > "$STATE_FILE"
    load_total_cost
    [ "$total_cost_usd" = "0" ]
}

@test "save_state records cumulative cost" {
    total_cost_usd="3.1400"
    save_state "idle"
    grep -q '^TOTAL_COST_USD=3.1400$' "$STATE_FILE"
    grep -q '^STATUS=idle$' "$STATE_FILE"
}

# --- budget cap ---------------------------------------------------

@test "budget_exceeded is false when cap is zero (unlimited)" {
    MAX_TOTAL_COST_USD=0
    total_cost_usd="9999"
    run budget_exceeded
    [ "$status" -ne 0 ]
}

@test "budget_exceeded is false below the cap" {
    MAX_TOTAL_COST_USD=10
    total_cost_usd="9.99"
    run budget_exceeded
    [ "$status" -ne 0 ]
}

@test "budget_exceeded is true at or above the cap" {
    MAX_TOTAL_COST_USD=10
    total_cost_usd="10"
    run budget_exceeded
    [ "$status" -eq 0 ]
    total_cost_usd="12.5"
    run budget_exceeded
    [ "$status" -eq 0 ]
}

@test "budget_exceeded treats a non-numeric cap as unlimited" {
    MAX_TOTAL_COST_USD="abc"
    total_cost_usd="9999"
    run budget_exceeded
    [ "$status" -ne 0 ]
}

# --- log rotation -------------------------------------------------

@test "rotate_logs prunes cycle logs beyond MAX_LOGS" {
    for i in $(seq 1 9); do
        printf 'x\n' > "$LOG_DIR/cycle-$(printf '%04d' "$i").log"
    done
    rotate_logs
    count=$(find "$LOG_DIR" -name 'cycle-*.log' | wc -l | tr -d ' ')
    [ "$count" -eq 5 ]
    # Oldest were removed, newest kept.
    [ ! -f "$LOG_DIR/cycle-0001.log" ]
    [ -f "$LOG_DIR/cycle-0009.log" ]
}

@test "rotate_logs keeps only MAIN_LOG_KEEP rotated main logs" {
    for suffix in 20260101-000000 20260102-000000 20260103-000000 20260104-000000; do
        printf 'x\n' > "$LOG_DIR/auto-loop.log.$suffix"
    done
    rotate_logs
    count=$(find "$LOG_DIR" -name 'auto-loop.log.*' | wc -l | tr -d ' ')
    [ "$count" -eq 2 ]
    [ -f "$LOG_DIR/auto-loop.log.20260104-000000" ]
}

# --- misc helpers -------------------------------------------------

@test "get_file_size_bytes reports size and zero for missing files" {
    printf '12345' > "$WORK/five.bin"
    [ "$(get_file_size_bytes "$WORK/five.bin")" = "5" ]
    [ "$(get_file_size_bytes "$WORK/nope.bin")" = "0" ]
}

@test "gitignore guard restores a mutated .gitignore" {
    printf 'node_modules\n' > "$PROJECT_DIR/.gitignore"
    snap=$(snapshot_gitignore)
    printf 'EVERYTHING\n' > "$PROJECT_DIR/.gitignore"
    restore_gitignore_if_changed "$snap"
    run cat "$PROJECT_DIR/.gitignore"
    [ "$output" = "node_modules" ]
}

@test "gitignore guard removes a cycle-created .gitignore" {
    snap=$(snapshot_gitignore)
    printf 'sneaky\n' > "$PROJECT_DIR/.gitignore"
    restore_gitignore_if_changed "$snap"
    [ ! -f "$PROJECT_DIR/.gitignore" ]
}

# --- consensus section extraction / artifact / seed ---------------

@test "extract_consensus_section returns a section body" {
    write_valid_consensus
    run extract_consensus_section "Next Action"
    [ "$status" -eq 0 ]
    [ "$output" = "Ship something." ]
}

@test "extract_consensus_section is empty for a missing section" {
    write_valid_consensus
    run extract_consensus_section "Nonexistent Heading"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "seed_consensus_if_missing copies the seed when consensus is absent" {
    printf '# Auto Company Consensus\n\n## Company State\n\nseed\n\n## Next Action\n\ngo\n' \
        > "$PROJECT_DIR/memories/consensus.seed.md"
    [ ! -f "$CONSENSUS_FILE" ]
    seed_consensus_if_missing
    [ -f "$CONSENSUS_FILE" ]
    run validate_consensus
    [ "$status" -eq 0 ]
}

@test "seed_consensus_if_missing does not overwrite an existing consensus" {
    write_valid_consensus
    printf 'SEED\n' > "$PROJECT_DIR/memories/consensus.seed.md"
    seed_consensus_if_missing
    run cat "$CONSENSUS_FILE"
    [[ "$output" == *"Ship something."* ]]
}

@test "cycle_produced_artifact ignores memories/docs-only changes" {
    # Fresh git repo with a committed baseline.
    git -C "$PROJECT_DIR" init -q
    git -C "$PROJECT_DIR" config user.email t@t
    git -C "$PROJECT_DIR" config user.name t
    mkdir -p "$PROJECT_DIR/projects" "$PROJECT_DIR/docs"
    echo base > "$PROJECT_DIR/projects/keep.txt"
    git -C "$PROJECT_DIR" add -A && git -C "$PROJECT_DIR" commit -qm base
    # Only a docs change: not an artifact.
    echo x > "$PROJECT_DIR/docs/note.md"
    run cycle_produced_artifact
    [ "$status" -ne 0 ]
    # A projects change: is an artifact.
    echo y > "$PROJECT_DIR/projects/new.txt"
    run cycle_produced_artifact
    [ "$status" -eq 0 ]
}

# --- engine resolution --------------------------------------------

@test "resolve_cli_bin honors explicit override path" {
    printf '#!/bin/sh\necho hi\n' > "$WORK/mycli"
    chmod +x "$WORK/mycli"
    run resolve_cli_bin "$WORK/mycli" claude
    [ "$status" -eq 0 ]
    [ "$output" = "$WORK/mycli" ]
}

@test "resolve_cli_bin finds nvm installs without interactive shells" {
    HOME="$WORK"
    mkdir -p "$WORK/.nvm/versions/node/v20.0.0/bin"
    printf '#!/bin/sh\n' > "$WORK/.nvm/versions/node/v20.0.0/bin/fakecli"
    chmod +x "$WORK/.nvm/versions/node/v20.0.0/bin/fakecli"
    run resolve_cli_bin "" fakecli
    [ "$status" -eq 0 ]
    [ "$output" = "$WORK/.nvm/versions/node/v20.0.0/bin/fakecli" ]
}

@test "resolve_cli_bin fails cleanly when nothing is found" {
    HOME="$WORK"
    run resolve_cli_bin "" definitely-not-a-real-cli-name
    [ "$status" -eq 1 ]
}
