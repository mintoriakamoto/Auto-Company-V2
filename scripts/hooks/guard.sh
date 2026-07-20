#!/usr/bin/env bash
# ============================================================
# Auto Company — PreToolUse safety guard
# ============================================================
# Mechanically enforces the "Non-Negotiable" forbidden actions from
# CLAUDE.md so they do not depend on model adherence under
# bypassPermissions. Wired via .claude/settings.json hooks.PreToolUse.
#
# Contract (Claude Code hooks):
#   - Receives a JSON event on stdin: {tool_name, tool_input:{command,...}}
#   - Exit 0  => allow the tool call
#   - Exit 2  => block the tool call; stderr is shown to the model
#
# Fail-open on parse errors is deliberate: this hook is defense in
# depth, not the only control, and must never wedge the loop over a
# malformed event. The patterns target catastrophic, irreversible
# actions only — normal create/deploy/commit flows pass through.
# ============================================================

set -euo pipefail

payload="$(cat 2>/dev/null || true)"

# Extract the command string. Prefer jq; fall back to matching the raw
# payload so the guard still works on a minimal box without jq.
command_str=""
if command -v jq >/dev/null 2>&1; then
    command_str="$(printf '%s' "$payload" | jq -r '.tool_input.command // .tool_input.file_path // empty' 2>/dev/null || true)"
else
    command_str="$payload"
fi

# Only shell commands carry destructive power here; if we could not
# identify a command, allow (fail-open) rather than block everything.
if [ -z "$command_str" ]; then
    exit 0
fi

block() {
    echo "BLOCKED by Auto Company safety guard: $1" >&2
    echo "This action is on the non-negotiable forbidden list (CLAUDE.md). Choose a non-destructive alternative." >&2
    exit 2
}

# Split the command into segments on shell separators (; && || | &) and check
# each independently. Without this, an unbounded pattern in one segment could
# pair with unrelated text in another — e.g. `rm -rf build && cat x/.claude`
# would falsely look like an rm of ~/.claude.
normalized="$(printf '%s' "$command_str" | tr '\n\t' '  ')"
segments="$(printf '%s' "$normalized" | sed -E 's/\|\||&&|[;&|]/\n/g')"

check_segment() {
    local seg="$1"

    # 1. Filesystem catastrophe: rm -rf of a root/home path.
    if printf '%s' "$seg" | grep -Eq 'rm[[:space:]]+(-[a-zA-Z]*[[:space:]]+)*-?[rRfF]{1,2}[a-zA-Z]*[[:space:]]+(/|/\*|~|\$HOME|--no-preserve-root)([[:space:]]|$)'; then
        block "recursive force-remove of a root/home path"
    fi

    # 2. Removing a protected credential/config dir. Bounded to this segment
    #    and to characters that can appear in a single path token.
    if printf '%s' "$seg" | grep -Eq 'rm[[:space:]]+[^;]*(~|\$HOME|/root|/home/[^/[:space:]]+)?/\.(ssh|claude|config)([/[:space:]]|$)'; then
        block "removal of a protected directory (~/.ssh, ~/.claude, ~/.config)"
    fi

    # 3. Repository / infrastructure deletion.
    if printf '%s' "$seg" | grep -Eq '\bgh[[:space:]]+repo[[:space:]]+delete\b'; then
        block "GitHub repository deletion (gh repo delete)"
    fi
    if printf '%s' "$seg" | grep -Eq '\bwrangler[[:space:]]+([a-z0-9:-]+[[:space:]]+)*delete\b'; then
        block "Cloudflare resource deletion (wrangler ... delete)"
    fi

    # 4. Force-push to a protected branch — both conditions in the SAME segment.
    if printf '%s' "$seg" | grep -Eq '\bgit[[:space:]]+push\b.*(--force|--force-with-lease|[[:space:]]-f([[:space:]]|$))' \
       && printf '%s' "$seg" | grep -Eq '\b(main|master|origin[[:space:]]+main|origin[[:space:]]+master)\b'; then
        block "force-push touching a protected branch (main/master)"
    fi
}

while IFS= read -r segment; do
    [ -n "$segment" ] || continue
    check_segment "$segment"
done <<< "$segments"

exit 0
