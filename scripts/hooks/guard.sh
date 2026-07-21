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

# Split the command into segments on shell separators (; && || | & and
# NEWLINES) and check each independently. Without this, an unbounded pattern in
# one segment could pair with unrelated text in another — e.g.
# `rm -rf build && cat x/.claude` would falsely look like an rm of ~/.claude.
# Tabs -> space (whitespace), but newlines are real separators and are kept as
# line breaks so the read loop below treats them as segment boundaries.
normalized="$(printf '%s' "$command_str" | tr '\t' ' ')"
segments="$(printf '%s' "$normalized" | sed -E 's/(\|\||&&|[;&|])/\n/g')"

check_segment() {
    local seg="$1"
    # Match against a de-quoted copy so quoting can't hide a target, e.g.
    # rm -rf "$HOME" / rm -rf '/' / echo x >> "~/.ssh/authorized_keys".
    local dq
    dq="$(printf '%s' "$seg" | tr -d "\"'")"

    # 1. Filesystem catastrophe: a RECURSIVE rm of a root/home/system path.
    #    Two conditions in one segment: (a) rm is recursive, (b) a catastrophic
    #    target appears as a whole token. Deep subpaths (rm -rf ./dist,
    #    /home/u/proj/dist) are intentionally NOT matched.
    if printf '%s' "$dq" | grep -Eq '(^|[[:space:]])rm([[:space:]]+-[a-zA-Z]*[rR][a-zA-Z]*|[[:space:]]+--recursive|[[:space:]]+--no-preserve-root)' \
       && printf '%s' "$dq" | grep -Eq '([[:space:]]|=)(/|/\*|~|~/|~/\*|\$HOME|\$HOME/|/(etc|usr|bin|boot|lib|lib64|sbin|sys|proc|var|root|home)(/\*)?)([[:space:]]|$)'; then
        block "recursive remove of a root/home/system path"
    fi

    # 2. Removing a protected credential/config dir.
    if printf '%s' "$dq" | grep -Eq 'rm[[:space:]]+[^;]*(~|\$HOME|/root|/home/[^/[:space:]]+)?/\.(ssh|claude|config)([/[:space:]]|$)'; then
        block "removal of a protected directory (~/.ssh, ~/.claude, ~/.config)"
    fi

    # 3. Writing/redirecting into a protected credential dir (e.g.
    #    echo key >> ~/.ssh/authorized_keys, cp x ~/.claude/...).
    if printf '%s' "$dq" | grep -Eq '(>>?[[:space:]]*|(^|[[:space:]])(tee|cp|mv|install|ln|chmod|chown|touch)[[:space:]][^;]*)(~|\$HOME|/root|/home/[^/[:space:]]+)?/\.(ssh|claude)([/[:space:]]|$)'; then
        block "writing into a protected directory (~/.ssh, ~/.claude)"
    fi

    # 4. Repository / infrastructure deletion.
    if printf '%s' "$dq" | grep -Eq '\bgh[[:space:]]+repo[[:space:]]+delete\b'; then
        block "GitHub repository deletion (gh repo delete)"
    fi
    if printf '%s' "$dq" | grep -Eq '\bgh[[:space:]]+api\b[^;]*(-X[[:space:]]*DELETE|--method[[:space:]]*DELETE)[^;]*/repos/' \
       || printf '%s' "$dq" | grep -Eq '\bgh[[:space:]]+api\b[^;]*/repos/[^;]*(-X[[:space:]]*DELETE|--method[[:space:]]*DELETE)'; then
        block "GitHub repository deletion (gh api -X DELETE /repos/...)"
    fi
    if printf '%s' "$dq" | grep -Eq '\bwrangler[[:space:]]+([a-z0-9:-]+[[:space:]]+)*delete\b'; then
        block "Cloudflare resource deletion (wrangler ... delete)"
    fi

    # 5. Force-push to a protected branch — both conditions in the SAME segment.
    #    Condition A allows global git options between `git` and `push`
    #    (git -c ... push, git -C . push).
    if printf '%s' "$dq" | grep -Eq '\bgit\b[^;]*\bpush\b[^;]*(--force|--force-with-lease|[[:space:]]-f([[:space:]]|$))' \
       && printf '%s' "$dq" | grep -Eq '\b(main|master)\b'; then
        block "force-push touching a protected branch (main/master)"
    fi
}

while IFS= read -r segment; do
    [ -n "$segment" ] || continue
    check_segment "$segment"
done <<< "$segments"

exit 0
