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
A command with two merges, unreadable quoting around a merge, a `$` or backtick
anywhere in a merge command, or a numbered or branch merge after a directory or
repository change is blocked: name the PR literally, by URL or `--repo`, one
merge per command.
FAIL OPEN otherwise: a lookup or internal error exits 0 so the session is never bricked.
"""

import json
import os
import re
import shlex
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from guard_tool import invocations, simple_commands  # noqa: E402

RED = "\033[31m"
BOLD = "\033[1m"
RESET = "\033[0m"

# Cheap pre-filter; the shell words decide.
MAYBE_MERGE = re.compile(r"\bgh\b.*\bmerge\b", re.IGNORECASE | re.DOTALL)
# `gh pr merge` flags that take a value, so the value is never read as the selector.
VALUE_FLAGS = {"-A", "--author-email", "-b", "--body", "-F", "--body-file", "-t", "--subject",
               "--match-head-commit", "-R", "--repo"}
# Anything that can make gh resolve a repository other than the hook's own directory.
CONTEXT_CHANGE = re.compile(r"(?:^|[;&|(\s'\"`])(?:cd|pushd|popd|export|source|\.)\s|\bGH_(?:REPO|HOST|CONFIG_DIR)=")


def gh(args):
    """Run gh, return stripped stdout or '' on any failure."""
    try:
        out = subprocess.run(
            ["gh", *args], capture_output=True, text=True, timeout=20
        )
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


def merge_target(args):
    """The (selector, repo) of one `gh` call if it is `pr merge`, read as gh reads them; else None.

    The selector is the first positional argument after `pr merge` — a number, URL
    or branch — or None for the current branch's PR. The repository comes from
    `-R`/`--repo` on either side of `pr merge`.
    """
    words = iter(args)
    selector = repo = None
    subcommand = []
    for word in words:
        if word.startswith("-"):
            name, equals, value = word.partition("=")
            if name.startswith("-R") and len(name) > 2:
                name, value, equals = "-R", name[2:], "="
            if name in VALUE_FLAGS and not equals:
                value = next(words, "")
            if name in ("-R", "--repo"):
                repo = value
        elif len(subcommand) < 2:
            subcommand.append(word)
        elif selector is None:
            selector = word
    return (selector, repo) if subcommand == ["pr", "merge"] else None


def merges(cmd):
    """(selector, repo) of every `gh pr merge` in the command, also behind wrappers, `sh -c` and `eval`.

    A `GH_REPO=` assignment in the same simple command names the repository when no flag does.
    """
    found = []
    for words in simple_commands(cmd):
        env_repo = next((word.split("=", 1)[1] for word in words if word.startswith("GH_REPO=")), None)
        for args in invocations(shlex.join(words), {"gh"}):
            target = merge_target(args)
            if target:
                found.append((target[0], target[1] or env_repo))
    return found


def block(message):
    sys.stderr.write(f"{RED}{BOLD}⛔ {message}{RESET}\n")
    sys.exit(2)


def main():
    raw = sys.stdin.read()
    data = json.loads(raw) if raw.strip() else {}

    tool = data.get("tool_name") or data.get("tool") or ""
    if tool != "Bash":
        sys.exit(0)
    ti = data.get("tool_input") or data.get("toolInput") or {}
    cmd = ti.get("command", "") if isinstance(ti, dict) else ""
    if not cmd or not re.search(r"\bgh\b", cmd):
        sys.exit(0)  # no `gh` call — fast path

    # ON by default: unset/empty/"0"/"false" ≡ guard active; only a real truthy
    # value bypasses.
    if os.environ.get("ALLOW_FOREIGN_MERGE", "") not in ("", "0", "false"):
        sys.exit(0)  # explicit override

    try:
        found = merges(cmd)
    except ValueError:
        if MAYBE_MERGE.search(cmd):
            block("This command's quoting cannot be read; run `gh pr merge` as its own simple command.")
        sys.exit(0)
    if not found:
        sys.exit(0)
    if len(found) > 1:
        block("Merge one PR per command, so each one's author is checked.")
    if re.search(r"[$`]", cmd):
        # An expansion or substitution can supply the PR, repository or directory that gh acts on.
        block("Name the PR and repository literally: a `$` or backtick in this merge command decides its target.")
    [(selector, repo)] = found
    qualified = repo or re.match(r"https://github\.com/[^/\s]+/[^/\s]+/pull/\d+", selector or "")
    if not qualified and CONTEXT_CHANGE.search(cmd):
        # The hook resolves numbers and branches in its own directory, not the one the command moves to.
        block("Name the PR by URL, or add --repo OWNER/REPO, when the command changes directory or gh's repository.")

    me = gh(["api", "user", "--jq", ".login"])
    if not me:
        sys.exit(0)  # can't identify current user -> fail open

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
