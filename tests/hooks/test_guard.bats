#!/usr/bin/env bats
# ============================================================
# Auto Company — Tests for the PreToolUse safety guard
# ============================================================
# Run: bats tests/hooks/
#
# Note: payloads live in this file (not on a command line) so the guard
# active in the developer's own session does not intercept the harness.
# ============================================================

setup() {
    GUARD="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)/scripts/hooks/guard.sh"
}

# Feed a tool_input.command JSON payload; returns the guard's exit code.
guard() {
    printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$1" | bash "$GUARD"
}

# jq-quote a raw command string into a JSON string literal.
json() {
    printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

# --- must BLOCK (exit 2) ------------------------------------------

@test "blocks rm -rf /" {
    run guard "$(json 'rm -rf /')"
    [ "$status" -eq 2 ]
}

@test "blocks rm -rf with no-preserve-root" {
    run guard "$(json 'rm -rf --no-preserve-root /')"
    [ "$status" -eq 2 ]
}

@test "blocks rm of ~/.ssh" {
    run guard "$(json 'rm -rf ~/.ssh')"
    [ "$status" -eq 2 ]
}

@test "blocks rm of a protected .claude dir" {
    run guard "$(json 'rm -rf /home/user/.claude')"
    [ "$status" -eq 2 ]
}

@test "blocks gh repo delete" {
    run guard "$(json 'gh repo delete owner/name --yes')"
    [ "$status" -eq 2 ]
}

@test "blocks wrangler resource delete" {
    run guard "$(json 'wrangler d1 delete mydb')"
    [ "$status" -eq 2 ]
    run guard "$(json 'wrangler delete')"
    [ "$status" -eq 2 ]
}

@test "blocks force-push to main and master" {
    run guard "$(json 'git push --force origin main')"
    [ "$status" -eq 2 ]
    run guard "$(json 'git push -f origin master')"
    [ "$status" -eq 2 ]
    run guard "$(json 'git push --force-with-lease origin main')"
    [ "$status" -eq 2 ]
}

# --- must ALLOW (exit 0) — includes prior false-positive cases ----

@test "allows rm of a build dir followed by a .claude path in another segment" {
    run guard "$(json 'rm -rf pkg4 && test -f a/.claude/settings.json')"
    [ "$status" -eq 0 ]
}

@test "allows rm of dist then cat of a .config path in another segment" {
    run guard "$(json 'rm -rf dist; cat proj/.config/foo')"
    [ "$status" -eq 0 ]
}

@test "allows push to a feature branch even if 'main' appears later" {
    run guard "$(json 'git push -u origin feature && echo done with main')"
    [ "$status" -eq 0 ]
}

@test "allows force-push to a disposable branch" {
    run guard "$(json 'git push --force origin claude/tmp-branch')"
    [ "$status" -eq 0 ]
}

@test "allows ordinary relative rm" {
    run guard "$(json 'rm -rf dist build node_modules')"
    [ "$status" -eq 0 ]
}

@test "allows wrangler deploy and gh repo create" {
    run guard "$(json 'wrangler deploy')"
    [ "$status" -eq 0 ]
    run guard "$(json 'gh repo create myproj --public')"
    [ "$status" -eq 0 ]
}

@test "allows an empty command payload" {
    run guard '{"tool_name":"Bash","tool_input":{}}'
    [ "$status" -eq 0 ]
}
