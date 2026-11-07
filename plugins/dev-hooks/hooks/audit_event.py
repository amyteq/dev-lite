#!/usr/bin/env python3
"""Audit logger: one redacted JSON line per tool call or settings change.

Wired by the dev-hooks plugin as:
  - PostToolUse hook for Bash|Edit|Write
  - ConfigChange hook for project_settings|skills

Appends to a daily log under `$CLAUDE_PROJECT_DIR/.claude/audit/`. The directory
gets its own `.gitignore` (`*`) on first use, so consumers need no ignore rule.
It NEVER blocks (always exits 0) and NEVER records file contents, command
arguments or secret values: a Bash call is logged by its literal executable name
only, or without one when the program is not a plain word.

Contract (Claude Code hooks):
  - stdin: JSON describing the event.
  - exit 0 always (PostToolUse / ConfigChange cannot meaningfully block).
"""

import datetime
import json
import os
import re
import shlex
import sys

MAX_CMD = 240  # truncate config change descriptions in the log
ASSIGNMENT_RE = re.compile(r"[A-Za-z_]\w*=")
LITERAL_PROGRAM_RE = re.compile(r"[\w./+-]+")


def executable(command: str) -> str | None:
    """The literal program of the first simple command, or None when it is not a plain word.

    Words are split as the shell would, so a quoted or standalone assignment is never
    mistaken for the program and its value never reaches the log.
    """
    lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|()<>")
    lexer.whitespace_split = True
    try:
        for word in lexer:
            if not ASSIGNMENT_RE.match(word):
                program = os.path.basename(word)
                return program[:64] if LITERAL_PROGRAM_RE.fullmatch(program) else None
    except ValueError:
        return None
    return None

# Redact anything that looks like a key/token/secret value in a logged string.
SECRET_VALUE_RE = re.compile(
    r"(eyJ[A-Za-z0-9_-]{10,})"                       # JWT-ish
    r"|(sk-[A-Za-z0-9]{8,})"                          # OpenAI-style
    r"|([A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Za-z0-9_]*\s*=\s*\S+)",
    re.IGNORECASE,
)


def redact(text: str) -> str:
    if not text:
        return ""
    return SECRET_VALUE_RE.sub("[REDACTED]", text)


def summarize(data: dict) -> dict:
    """Build a safe, content-free summary of the event."""
    event = (
        data.get("hook_event_name")
        or data.get("hookEventName")
        or data.get("event")
        or "unknown"
    )
    out = {
        "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "event": event,
        "session": data.get("session_id") or data.get("sessionId") or "",
    }

    tool = data.get("tool_name") or data.get("tool")
    if tool:
        out["tool"] = tool
    ti = data.get("tool_input") or data.get("toolInput") or {}
    if isinstance(ti, dict):
        if "command" in ti:
            # Only the program name: arguments, headers and heredoc bodies can carry secrets.
            program = executable(str(ti["command"]))
            if program:
                out["executable"] = program
        for key in ("file_path", "notebook_path", "path"):
            if key in ti:
                out["path"] = str(ti[key])  # path only, never content
                break

    # ConfigChange events carry a matcher/scope rather than a tool.
    for key in ("matcher", "scope", "config_change", "configChange"):
        if key in data:
            out["config"] = redact(str(data[key]))[:MAX_CMD]
            break

    return out


def main() -> None:
    raw = sys.stdin.read()
    data = json.loads(raw) if raw.strip() else {}

    project_dir = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    audit_dir = os.path.join(project_dir, ".claude", "audit")
    os.makedirs(audit_dir, exist_ok=True)
    ignore = os.path.join(audit_dir, ".gitignore")
    if not os.path.exists(ignore):
        with open(ignore, "w", encoding="utf-8") as fh:
            fh.write("*\n")

    day = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d")
    log_path = os.path.join(audit_dir, f"events-{day}.log")

    record = summarize(data)
    with open(log_path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")

    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        # Auditing must never break a tool call.
        sys.exit(0)
