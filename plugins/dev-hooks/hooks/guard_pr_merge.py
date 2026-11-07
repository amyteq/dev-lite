#!/usr/bin/env python3
"""PreToolUse guard: don't let a Claude Code session merge someone else's PR.

Wired by the dev-hooks plugin as a PreToolUse hook for Bash (alongside
guard_tool.py). It intercepts `gh pr merge` and blocks the merge when the target
PR's author is NOT the current `gh` user — the common "merged the wrong PR / a
teammate's PR" mistake. It prints a red alert and the exact override to use for
the rare legitimate case.

Why a hook as well as GitHub settings: rulesets decide who may merge into a
branch, not whether this session meant to merge this particular PR.

Contract (Claude Code hooks):
  - stdin: JSON describing the tool call (tool_name, tool_input, ...).
  - exit 0          -> allow (default).
  - exit 2 + stderr -> block; stderr text is shown as the reason.

Override: set ALLOW_FOREIGN_MERGE=1 to bypass.
  The guard is ON by default: unset / empty / "0" / "false" keep it active.
  Any other value bypasses.
FAIL OPEN: any parsing/lookup error exits 0 so the session is never bricked.
"""

import json
import os
import re
import subprocess
import sys

RED = "\033[31m"
BOLD = "\033[1m"
RESET = "\033[0m"

MERGE_RE = re.compile(r"\bgh\s+pr\s+merge\b", re.IGNORECASE)
PR_URL_RE = re.compile(r"github\.com/[^/\s]+/[^/\s]+/pull/(\d+)")
REPO_FLAG_RE = re.compile(r"(?:-R|--repo)[=\s]+(\S+)")


def gh(args):
    """Run gh, return stripped stdout or '' on any failure."""
    try:
        out = subprocess.run(
            ["gh", *args], capture_output=True, text=True, timeout=20
        )
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


def pr_ref_from(cmd):
    """Best-effort extract the PR ref the merge targets: URL # > bare integer > None."""
    m = PR_URL_RE.search(cmd)
    if m:
        return m.group(1)
    # first standalone integer token after 'merge'
    tail = cmd[MERGE_RE.search(cmd).end():]
    for tok in tail.split():
        if tok.isdigit():
            return tok
    return None  # gh will resolve the current branch's PR


def main():
    raw = sys.stdin.read()
    data = json.loads(raw) if raw.strip() else {}

    tool = data.get("tool_name") or data.get("tool") or ""
    if tool != "Bash":
        sys.exit(0)
    ti = data.get("tool_input") or data.get("toolInput") or {}
    cmd = ti.get("command", "") if isinstance(ti, dict) else ""
    if not cmd or not MERGE_RE.search(cmd):
        sys.exit(0)  # not a `gh pr merge` — fast path, no gh calls

    # ON by default: unset/empty/"0"/"false" ≡ guard active; only a real truthy
    # value bypasses.
    if os.environ.get("ALLOW_FOREIGN_MERGE", "") not in ("", "0", "false"):
        sys.exit(0)  # explicit override

    me = gh(["api", "user", "--jq", ".login"])
    if not me:
        sys.exit(0)  # can't identify current user -> fail open

    view = ["pr", "view"]
    ref = pr_ref_from(cmd)
    if ref:
        view.append(ref)
    repo_m = REPO_FLAG_RE.search(cmd)
    if repo_m:
        view += ["--repo", repo_m.group(1)]
    view += ["--json", "author,number,title"]

    info = gh(view)
    if not info:
        sys.exit(0)  # can't resolve the PR -> fail open
    try:
        pr = json.loads(info)
        author = (pr.get("author") or {}).get("login", "")
        num = pr.get("number", "?")
        title = pr.get("title", "")
    except Exception:
        sys.exit(0)

    if not author or author == me:
        sys.exit(0)  # own PR (or unknown author) -> allow

    sys.stderr.write(
        f"{RED}{BOLD}⛔ Refusing to merge PR #{num} — it belongs to @{author}, not you (@{me}).{RESET}\n"
        f"{RED}  \"{title}\"{RESET}\n"
        f"{RED}  Merging teammates' PRs is disabled to prevent merging the wrong PR.{RESET}\n"
        f"  Ask @{author} to merge it, or approve it and let them merge.\n"
        f"  Legitimate exception (rare): re-run with ALLOW_FOREIGN_MERGE=1 prefixed.\n"
    )
    sys.exit(2)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(0)  # never brick the session
