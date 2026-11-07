#!/usr/bin/env python3
"""Claude Code PreToolUse guard: deny host-destructive and secret-reading calls.

Wired by the dev-hooks plugin for Bash|Read|Edit|Write.

Policy:
- Allow normal development work without prompts.
- Deny secret access and host- or history-destructive operations.
- Ask only for irreversible operations (file deletion outside temp dirs,
  git clean, destructive SQL, volume or remote database resets).

Contract (Claude Code hooks):
  - stdin: JSON describing the tool call (tool_name, tool_input, ...).
  - A matching rule prints a `hookSpecificOutput` decision (`deny` or `ask`)
    and exits 0; no match exits 0 silently, leaving the normal permission flow.
  - A hook decision never grants a permission that settings.json denies.

FAIL OPEN on hook errors: unreadable input or an internal error allows the call
so a guard bug never bricks the session. A matched rule always denies or asks.

This recognises literal command spellings; it is not a shell security boundary.
Keep the sandbox and settings.json permissions as the primary controls.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path


def emit(decision: str, reason: str) -> None:
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": decision,
                    "permissionDecisionReason": reason,
                }
            }
        )
    )


def normalize_path(value: str) -> str:
    if not value:
        return ""
    return os.path.expanduser(value).replace("\\", "/")


PROTECTED_FRAGMENTS = (
    "/secrets/",
    "/.ssh/",
    "/.aws/",
    "/.config/gcloud/",
    "/.config/gh/hosts.yml",
    "/.netrc",
    "/id_rsa",
    "/id_ed25519",
)
PROTECTED_NAMES = {
    ".env.production",
    ".env.test",
    ".netrc",
    "id_rsa",
    "id_ed25519",
    "hosts.yml",
}


def path_is_protected(path: str) -> bool:
    """System credentials and production/test env files. Local dev `.env` stays readable."""
    p = "/" + normalize_path(path)  # leading slash so relative `secrets/x` matches `/secrets/`
    return Path(p).name in PROTECTED_NAMES or any(fragment in p for fragment in PROTECTED_FRAGMENTS)


def compact(command: str) -> str:
    return " ".join(command.strip().split())


# --- command normalisation ----------------------------------------------------
#
# The deny/ask patterns match words in the command string, so they only
# recognise the spellings they were written for:
#
# - `gh` accepts a flag between the binary and the subcommand and runs it the
#   same way: `gh --repo OWNER/REPO issue delete 1` == `gh issue delete 1`.
# - Matching the whole command string would refuse a heredoc or a quoted message
#   that merely writes *about* a gated verb, although it executes nothing.
#
# Every normalisation step is a deletion, never a reordering or re-quoting, so it
# can only make the matcher see less; it never fabricates a word sequence.

# gh flags that may legally precede the subcommand. Boolean forms take no value.
GH_LEADING_FLAGS = re.compile(
    r"\bgh(?:\s+(?:--repo|-R|--hostname)(?:=\S+|\s+\S+)|\s+(?:--help|-h|--version))+",
    flags=re.IGNORECASE,
)

# A heredoc opener: `<<TAG`, `<<'TAG'`, `<<"TAG"`, `<<-TAG`.
HEREDOC_START = re.compile(r"<<-?\s*(?P<quote>['\"]?)(?P<tag>[A-Za-z_][A-Za-z0-9_]*)(?P=quote)")

# Programs that execute what they are handed. If any appears at a command
# position, heredoc bodies stay in scope: `bash <<EOF ... EOF` runs its payload.
INTERPRETERS = {
    "ash", "bash", "csh", "dash", "env", "eval", "fish", "ksh", "node", "perl",
    "php", "python", "python3", "ruby", "sh", "source", "xargs", "zsh",
}

# A word in command position: start, or after a pipe/separator/substitution,
# optionally preceded by VAR=value assignments.
COMMAND_POSITION = re.compile(r"(?:^|[|;&\n]|\$\(|`)\s*(?:\w+=\S+\s+)*(?P<program>[\w./-]+)")

# The literal value of a message-carrying flag. Single quotes never expand; double
# quotes count only without `$`, backtick or backslash, so a payload that could
# execute something (`--body "$(cat ~/.ssh/id_rsa)"`) stays in place and is matched.
LITERAL_MESSAGE_PAYLOAD = re.compile(
    r"(?<![\w-])(?:-m|--message|-b|--body|-t|--title|--notes)(?:\s+|=)(?:'[^']*'|\"[^\"$`\\]*\")"
)


def mentions_interpreter(command: str) -> bool:
    return any(Path(match.group("program")).name in INTERPRETERS for match in COMMAND_POSITION.finditer(command))


def strip_heredoc_bodies(command: str) -> str:
    """Drop heredoc payloads unless something in the command line would execute them."""
    if "<<" not in command or mentions_interpreter(command):
        return command

    lines = command.split("\n")
    kept: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        kept.append(line)
        index += 1
        opener = HEREDOC_START.search(line)
        if not opener:
            continue
        tag = opener.group("tag")
        while index < len(lines) and lines[index].strip() != tag:
            index += 1
        if index < len(lines):
            kept.append(lines[index])
            index += 1
    return "\n".join(kept)


def normalize_command(command: str) -> str:
    """Canonicalise a command for matching: inert payloads out, gh flag noise out."""
    text = strip_heredoc_bodies(command)
    text = LITERAL_MESSAGE_PAYLOAD.sub(" ", text)
    text = GH_LEADING_FLAGS.sub("gh", text)
    return compact(text)


# `rm` arguments up to the next separator; matched on the lower-cased command.
RM_ARGS = re.compile(r"\brm\b([^|;&\n]*)")
TEMP_ROOTS = ("/tmp/", "$tmpdir/", "${tmpdir}/", '"$tmpdir"/', '"${tmpdir}"/', '"$tmpdir/', '"${tmpdir}/')


def rm_targets_only_temp(lc: str) -> bool:
    """True when every `rm` in the command removes only paths under /tmp or $TMPDIR."""
    for args in RM_ARGS.findall(lc):
        targets = [token for token in args.split() if not token.startswith("-")]
        if not targets or any(not t.startswith(TEMP_ROOTS) or ".." in t for t in targets):
            return False
    return True


SECRET_PATHS = r"id_rsa|id_ed25519|\.aws|\.ssh|\.config/gcloud|secrets/|hosts\.yml|\.netrc|\.env\.production"

DENY_PATTERNS = [
    (r"\bsudo\b", "Refusing sudo from the agent."),
    (r"\bsu\s+", "Refusing su from the agent."),
    (r"\bdoas\b", "Refusing doas from the agent."),
    (r"\brm\s+-rf\s+(/|~|\$HOME)(\s|$)", "Refusing recursive deletion of root/home."),
    (r"\brm\s+-rf\s+/(?!tmp/)\S+", "Refusing recursive deletion of absolute filesystem paths."),
    (r"\bchmod\s+777\b", "Refusing chmod 777."),
    (r"\bchown\s+.*\s+(/|~|\$HOME)\b", "Refusing ownership change on broad paths."),
    (r"\bdd\s+.*\bof=/dev/", "Refusing raw disk write."),
    (r"\bmkfs(\.|\s|$)", "Refusing filesystem formatting command."),
    (r"\bshutdown\b|\breboot\b|\bhalt\b", "Refusing host power command."),
    # The flag is legal anywhere in the push: `git push origin main --force`.
    (r"\bgit\s+push\b[^|;&]*?\s(-f|--force|--force-with-lease)\b", "Refusing force push."),
    (
        r"\bgit\s+push\b[^|;&]*?(--delete\b|\s:\S)",
        "Refusing remote branch deletion (preserve published branch history).",
    ),
    (r"\bgit\s+filter-(branch|repo)\b", "Refusing history rewrite."),
    (
        r"\bgh\s+(issue|label|release|repo|secret|variable|webhook|ssh-key|gpg-key|cache|run)\s+delete\b",
        "Refusing permanent GitHub deletion.",
    ),
    (r"\bgh\s+extension\s+remove\b", "Refusing gh extension removal."),
    (r"\bdocker\s+run\b.*\s--privileged\b", "Refusing privileged Docker container."),
    (
        r"\b(cat|less|more|head|tail|grep|rg|awk|sed|xxd|od|strings|base64)\b.*(" + SECRET_PATHS + ")",
        "Refusing shell read of protected secrets.",
    ),
    (
        r"\b(curl|wget|scp|rsync)\b.*(" + SECRET_PATHS + r"|metadata\.google|169\.254\.169\.254)",
        "Refusing shell exfiltration/metadata access pattern.",
    ),
    (r"\b(psql|sqlite3|mysql)\b.*\b(drop\s+database|drop\s+schema)\b", "Refusing database/schema drop from the agent."),
]

ASK_PATTERNS = [
    (r"\brmdir\b", "Directory deletion requires approval."),
    (r"\bfind\b.*\s-delete\b", "find -delete requires approval."),
    (r"\bgit\s+clean\b", "git clean requires approval."),
    (r"\bsupabase\s+db\s+(push|reset)\b", "Remote/destructive Supabase database operation requires approval."),
    (r"\b(psql|sqlite3|mysql)\b.*\b(truncate|delete\s+from)\b", "Destructive SQL requires approval."),
    (r"\bdocker\s+compose\s+down\b.*\s-v\b", "Docker volume deletion requires approval."),
]


def bash_decision(command: str) -> tuple[str | None, str | None]:
    lc = normalize_command(command).lower()

    for pattern, reason in DENY_PATTERNS:
        if re.search(pattern, lc, flags=re.IGNORECASE):
            return "deny", reason

    if re.search(r"\brm\b", lc) and not rm_targets_only_temp(lc):
        return "ask", "File deletion outside /tmp or $TMPDIR requires approval."
    for pattern, reason in ASK_PATTERNS:
        if re.search(pattern, lc, flags=re.IGNORECASE):
            return "ask", reason

    return None, None


def main() -> int:
    payload = json.load(sys.stdin)
    tool = payload.get("tool_name", "")
    tool_input = payload.get("tool_input") or {}

    if tool in {"Read", "Edit", "Write"}:
        file_path = tool_input.get("file_path") or tool_input.get("path") or ""
        if path_is_protected(file_path):
            emit("deny", f"Protected path blocked: {file_path}")
            return 0

    if tool == "Bash":
        decision, reason = bash_decision(tool_input.get("command") or "")
        if decision and reason:
            emit(decision, reason)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)  # fail open on hook errors (bad input, internal bug)
