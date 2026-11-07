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
import shlex
import subprocess
import sys

RED = "\033[31m"
BOLD = "\033[1m"
RESET = "\033[0m"

# `gh` accepts the repository flag before the subcommand too: `gh -R o/r pr merge 5`.
MERGE_RE = re.compile(r"\bgh(?:\s+(?:-R|--repo)(?:=|\s+)\S+)*\s+pr\s+merge\b", re.IGNORECASE)
# `gh pr merge` flags that take a value, so the value is never read as the selector.
VALUE_FLAGS = {"-A", "--author-email", "-b", "--body", "-F", "--body-file", "-t", "--subject",
               "--match-head-commit", "-R", "--repo"}
CHANGES_DIRECTORY = re.compile(r"(?:^|[;&|(\s])(?:cd|pushd)\s|\s-C\s")


def gh(args):
    """Run gh, return stripped stdout or '' on any failure."""
    try:
        out = subprocess.run(
            ["gh", *args], capture_output=True, text=True, timeout=20
        )
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


def merge_target(cmd):
    """The (selector, repo) of the first `gh pr merge`, read as gh reads them.

    The selector is the first positional argument — a number, URL or branch — or
    None for the current branch's PR. The repository comes from `-R`/`--repo` on
    either side of `pr merge`, else from a `GH_REPO=` assignment prefixing `gh`.
    """
    match = MERGE_RE.search(cmd)
    lexer = shlex.shlex(cmd[match.start() + 2:], posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    words = iter(lexer)
    selector = repo = None
    subcommand = 0  # positional words still to skip: `pr`, then `merge`
    for word in words:
        if set(word) <= set(";&|()<>"):
            break  # end of this command
        if word.startswith("-"):
            name, equals, value = word.partition("=")
            if name.startswith("-R") and len(name) > 2:
                name, value, equals = "-R", name[2:], "="
            if name in VALUE_FLAGS and not equals:
                value = next(words, "")
            if name in ("-R", "--repo"):
                repo = value
        elif subcommand < 2:
            subcommand += 1
        elif selector is None:
            selector = word
    env = re.search(r"\bGH_REPO=(\S+)\s+(?:\w+=\S*\s+)*$", cmd[:match.start()])
    return selector, repo or (env.group(1).strip("'\"") if env else None)


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

    selector, repo = merge_target(cmd)
    if selector is None and CHANGES_DIRECTORY.search(cmd[:MERGE_RE.search(cmd).start()]):
        # The hook resolves "the current branch" in its own directory, not the one the command moved to.
        sys.stderr.write(f"{RED}{BOLD}⛔ Name the PR to merge (number or URL) when the command changes directory first.{RESET}\n")
        sys.exit(2)
    view = ["pr", "view", *([selector] if selector else []), *(["--repo", repo] if repo else []),
            "--json", "author,number,title"]

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
