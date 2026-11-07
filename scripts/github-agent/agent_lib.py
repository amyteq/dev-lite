"""Agent-neutral helpers for the GitHub mention pipeline.

The workflow YAML is only an entry point: it wires GitHub events to these
scripts. Everything that is not "which CLI do we launch" lives here so the
`@claude` and `@codex` pipelines stay a single implementation.

Design notes
------------
* Configuration comes from repository variables, resolved by prefix:
  ``<AGENT>_ACTION_<KEY>`` (e.g. ``CLAUDE_ACTION_MODEL``). The whole ``vars``
  context is not exposed: the workflow passes an explicit allowlist of
  configuration names. Resolution and defaults are testable Python.
* The GitHub API is called through ``urllib`` rather than the ``gh`` CLI: no
  subprocess, and the tests only have to monkeypatch one function.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.request
from dataclasses import dataclass
from typing import Any

AGENTS = ("claude", "codex")

API_ROOT = os.environ.get("GITHUB_API_URL", "https://api.github.com")

# Repository-variable defaults shared by both agents.
COMMON_DEFAULTS: dict[str, str] = {
    # Master switch plus one switch per event the workflows listen to, so any
    # single surface can be turned off, e.g. CODEX_ACTION_ISSUE_COMMENT=false.
    # An unset master switch follows repository visibility; see `enabled()`.
    "ENABLED": "",
    "ISSUE_COMMENT": "true",
    "PR_REVIEW_COMMENT": "true",
    "PR_REVIEW": "true",
    "ISSUES": "true",
    "PULL_REQUEST": "true",
    "DISCUSSION_COMMENT": "true",
    "DISCUSSION": "true",
    # Pipeline knobs.
    "TIMEOUT_MINUTES": "20",
    "CONTEXT_COMMENTS": "20",
    "CONTEXT_CHARS": "4000",
}

# Per-agent defaults; any of these can be overridden by a repository variable.
AGENT_DEFAULTS: dict[str, dict[str, str]] = {
    "claude": {
        "MODEL": "",  # Let the installed CLI choose unless the repository overrides it.
        "EFFORT": "",  # Optional `--effort`; empty keeps the CLI default.
        "MAX_TURNS": "100",
        # Empty keeps every read/edit tool; a list narrows them. It never adds one.
        "ALLOWED_TOOLS": "",
    },
    "codex": {
        "MODEL": "",
        "EFFORT": "",
    },
}

# `<event_name>` -> (handled actions, config key of its on/off variable).
EVENT_ROUTES: dict[str, tuple[tuple[str, ...], str]] = {
    "issue_comment": (("created",), "ISSUE_COMMENT"),
    "pull_request_review_comment": (("created",), "PR_REVIEW_COMMENT"),
    "pull_request_review": (("submitted",), "PR_REVIEW"),
    "issues": (("opened", "edited"), "ISSUES"),
    "pull_request": (("opened", "edited"), "PULL_REQUEST"),
    "pull_request_target": (("opened", "edited"), "PULL_REQUEST"),
    "discussion_comment": (("created",), "DISCUSSION_COMMENT"),
    "discussion": (("created", "edited"), "DISCUSSION"),
}

# The first verb after the mention is passed through as an optional command.
# Read-only commands inspect the captured PR revision. Only explicit, unanimous
# write commands permit a patch to reach the separate publisher.
READ_ONLY_COMMANDS = frozenset(
    {"review", "audit", "plan", "explain", "triage", "summarize", "answer", "ask"}
)
WRITE_COMMANDS = frozenset(
    {"fix", "implement", "test", "refactor", "docs", "design", "chore", "revert"}
)
COMMANDS = READ_ONLY_COMMANDS | WRITE_COMMANDS


def truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class AgentConfig:
    """Repository-variable view for one agent."""

    agent: str
    variables: dict[str, str]

    def __post_init__(self) -> None:
        if self.agent not in AGENTS:
            raise ValueError(f"unknown agent: {self.agent!r}")

    @property
    def prefix(self) -> str:
        return f"{self.agent.upper()}_ACTION_"

    @property
    def mention(self) -> str:
        return f"@{self.agent}"

    def get(self, key: str) -> str:
        """Resolve `<AGENT>_ACTION_<key>`, falling back to the built-in default."""
        default = AGENT_DEFAULTS[self.agent].get(key, COMMON_DEFAULTS.get(key, ""))
        raw = self.variables.get(f"{self.prefix}{key}")
        return default if raw is None or str(raw).strip() == "" else str(raw).strip()

    def flag(self, key: str) -> bool:
        return truthy(self.get(key))

    def enabled(self, private: bool) -> bool:
        """The master switch. Unset means on for private and off for public repositories."""
        raw = self.get("ENABLED")
        return truthy(raw) if raw else private

    def number(self, key: str) -> int:
        try:
            return int(self.get(key))
        except ValueError:
            fallback = AGENT_DEFAULTS[self.agent].get(key) or COMMON_DEFAULTS.get(key) or "0"
            return int(fallback)


CONFIG_PREFIXES = tuple(f"{agent.upper()}_ACTION_" for agent in AGENTS)


def load_config(agent: str | None = None, variables: dict[str, str] | None = None) -> AgentConfig:
    """Read the configuration the workflow placed in the environment.

    The workflow passes each configuration variable by name, to the routing step
    only; every later step reads the copy routing recorded in EVENT_FILE. It
    deliberately does NOT hand us the whole `vars` context: GitHub Actions echoes a job's `env:`
    block into the log of every step, and repository variables are not encrypted,
    so dumping all of them would print anything mis-filed there — a credential
    included — into the run log. Only the names the workflow lists get here.
    """
    agent = (agent or os.environ.get("AGENT", "")).strip().lower()
    if variables is None:
        variables = {
            name: value
            for name, value in os.environ.items()
            if name.startswith(CONFIG_PREFIXES)
        }
    if not variables and os.path.isfile(os.environ.get("EVENT_FILE", "")):
        # Only the routing step receives the variables; it validates them and
        # records them in the request, so no later step renders them in its log.
        variables = load_context().get("config") or {}
    return AgentConfig(agent=agent, variables=variables)


# Even within the allowlisted names, a credential pasted into (say)
# CLAUDE_ACTION_MODEL would end up in the log. Refuse to run instead.
_CREDENTIAL_JSON_KEYS = ("refresh_token", "access_token", "id_token", "client_secret", "private_key")
_CREDENTIAL_PREFIXES = (
    "-----BEGIN",
    "sk-",
    "sk_live",
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
)


def credential_shaped_variables(variables: dict[str, str]) -> list[str]:
    """Names of configuration variables whose value looks like a credential.

    This never flags a value the workflow's earlier gate lets through, so nothing it
    recognises reaches a rendered step: a leading space or control character is refused
    as the gate refuses it, a prefix counts after any whitespace `get` strips (the gate
    matches prefixes anywhere), and a JSON key counts only with its closing quote.
    """
    flagged = []
    for name, value in sorted(variables.items()):
        text = value or ""
        stripped = text.lstrip()
        if text[:1] == " " or (text and ord(text[0]) < 32) or stripped.startswith(_CREDENTIAL_PREFIXES):
            flagged.append(name)
        elif stripped.startswith("{") and any(f'{key}"' in text.lower() for key in _CREDENTIAL_JSON_KEYS):
            flagged.append(name)
    return flagged


# --------------------------------------------------------------------------- #
# GitHub API
# --------------------------------------------------------------------------- #


def _token() -> str:
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
    if not token:
        raise RuntimeError("GH_TOKEN / GITHUB_TOKEN is not set")
    return token


def gh_rest(path: str, method: str = "GET", body: Any = None) -> Any:
    """Call the REST API. `path` may be absolute or relative to the API root."""
    url = path if path.startswith("http") else f"{API_ROOT}/{path.lstrip('/')}"
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Authorization", f"Bearer {_token()}")
    request.add_header("Accept", "application/vnd.github+json")
    request.add_header("X-GitHub-Api-Version", "2022-11-28")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = response.read().decode()
    return json.loads(payload) if payload.strip() else None


def gh_graphql(query: str, variables: dict[str, Any] | None = None) -> Any:
    result = gh_rest("graphql", method="POST", body={"query": query, "variables": variables or {}})
    if isinstance(result, dict) and result.get("errors"):
        raise RuntimeError(f"GraphQL error: {json.dumps(result['errors'])}")
    return (result or {}).get("data")


# --------------------------------------------------------------------------- #
# Actions plumbing
# --------------------------------------------------------------------------- #


def log(message: str) -> None:
    print(message, flush=True)


def notice(message: str) -> None:
    print(f"::notice::{message}", flush=True)


def warn(message: str) -> None:
    print(f"::warning::{message}", flush=True)


def set_outputs(outputs: dict[str, Any]) -> None:
    """Write step outputs in delimiter form so values may contain newlines."""
    lines = []
    for key, value in outputs.items():
        text = "" if value is None else str(value)
        if "\n" in text:
            lines.append(f"{key}<<__AGENT_EOF__\n{text}\n__AGENT_EOF__")
        else:
            lines.append(f"{key}={text}")
    rendered = "\n".join(lines) + "\n"
    target = os.environ.get("GITHUB_OUTPUT")
    if target:
        with open(target, "a", encoding="utf-8") as handle:
            handle.write(rendered)
    else:  # local runs and tests
        sys.stderr.write(rendered)


def read_event() -> dict[str, Any]:
    """Read the raw webhook payload the runner wrote to disk.

    Using ``GITHUB_EVENT_PATH`` keeps untrusted event text out of the workflow
    YAML entirely — nothing from the payload is ever interpolated into a shell
    command.
    """
    path = os.environ.get("GITHUB_EVENT_PATH", "")
    if not path or not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def load_context(path: str | None = None) -> dict[str, Any]:
    """Read the normalized request JSON produced by normalize_event.py."""
    path = path or os.environ.get("EVENT_FILE", "")
    if not path:
        raise RuntimeError("EVENT_FILE is not set")
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


# --------------------------------------------------------------------------- #
# Text handling
# --------------------------------------------------------------------------- #

_MENTION_PATTERNS = tuple(re.compile(rf"@({agent})\b", re.IGNORECASE) for agent in AGENTS)


def sanitize_mentions(text: str) -> str:
    """Defuse agent mentions so our own replies cannot retrigger the workflows.

    ``@<!-- -->claude`` still renders as ``@claude`` for a human reader, but the
    raw comment body no longer contains the trigger string.
    """
    for pattern in _MENTION_PATTERNS:
        text = pattern.sub(lambda match: f"@<!-- -->{match.group(1)}", text or "")
    return text


# Blockquote markers that open a line; code inside a quote is still code.
_QUOTE_PREFIX = re.compile(r"(?: {0,3}>[ \t]?)*")
_FENCE_OPEN = re.compile(r" {0,3}(`{3,}|~{3,})")
# shortcut: any line indented four or more columns inside its quote is treated as an
# indented code block, even a list continuation; a mention there is ignored, never obeyed.
_INDENTED_CODE = re.compile(r"(?: {4}| {0,3}\t)[ \t]*\S")
# Backtick or tilde runs paired anywhere, such as a multi-line inline code span.
_PAIRED_FENCES = re.compile(r"```.*?```|~~~.*?~~~", re.DOTALL)
_INLINE_CODE = re.compile(r"(`+)[^\n]*?\1")
_LINES = re.compile(r"[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$")


def _blank(match: re.Match[str]) -> str:
    """Replace a span with spaces, keeping line breaks so offsets stay aligned."""
    return "".join(char if char in "\r\n" else " " for char in match.group(0))


def _code_lines(text: str) -> list[tuple[int, int]]:
    """Spans of fenced and indented code lines, read through blockquote markers.

    Lines end at LF, CRLF or CR. A fence closes on a run of its own character at
    least as long, or when its blockquote ends; an unclosed fence runs to the end.
    """
    spans = []
    fence = None  # (character, length, quote depth) of the open fence
    for line in _LINES.finditer(text):
        content = line.group(0).rstrip("\r\n")
        prefix = _QUOTE_PREFIX.match(content).group(0)
        depth, rest = prefix.count(">"), content[len(prefix):]
        if fence and depth < fence[2]:
            fence = None
        if fence:
            closer = rest.strip(" \t")
            if len(rest) - len(rest.lstrip(" ")) <= 3 and closer and set(closer) == {fence[0]} and len(closer) >= fence[1]:
                fence = None
        elif opener := _FENCE_OPEN.match(rest):
            run = opener.group(1)
            if not (run[0] == "`" and "`" in rest[opener.end():]):
                fence = (run[0], len(run), depth)
        elif not _INDENTED_CODE.match(rest):
            continue
        spans.append((line.start() + len(prefix), line.start() + len(content)))
    return spans


def mask_code(text: str) -> str:
    """Blank out fenced, indented and inline code, preserving character offsets.

    Backticks are how you talk *about* an agent without summoning it — which is
    what documentation, and this repository's own pull requests about these
    workflows, have to do.
    """
    text = text or ""
    chars = list(text)
    spans = _code_lines(text) + [match.span() for match in _PAIRED_FENCES.finditer(text)]
    for start, end in spans:
        for index in range(start, end):
            if chars[index] not in "\r\n":
                chars[index] = " "
    return _INLINE_CODE.sub(_blank, "".join(chars))


def _mention_pattern(mention: str) -> re.Pattern[str]:
    return re.compile(rf"(?<![\w/-]){re.escape(mention)}\b", re.IGNORECASE)


def find_mention(text: str, mention: str) -> int:
    """Index of the first standalone `mention` in `text`, or -1.

    Mentions inside code are ignored. A word boundary is required on both sides,
    so neither `@claudebot` nor an email-ish `foo@claude` trips the `@claude`
    pipeline. The returned index is valid for the original `text`.
    """
    match = _mention_pattern(mention).search(mask_code(text))
    return match.start() if match else -1


def _split_request(remainder: str) -> tuple[str, str]:
    """Split the text that follows a mention into `(command, request)`."""
    remainder = remainder.strip().lstrip(":,-—　").strip()
    for separator in (" ", "\n"):
        head, _, tail = remainder.partition(separator)
        candidate = head.strip().lower().strip(".,:;!?，。：；！？")
        if candidate in COMMANDS:
            return candidate, tail.strip() or remainder
    return "", remainder


def parse_request(text: str, mention: str) -> tuple[str, str]:
    """Split the text after `mention` into `(command, request)`.

    The command is the first bare verb after the mention, and only when it is one
    we know; otherwise the command is empty and the whole remainder is the
    request. An unknown verb is deliberately kept in the request rather than
    silently dropped.
    """
    index = find_mention(text, mention)
    if index < 0:
        return "", ""
    return _split_request((text or "")[index + len(mention) :])


def mention_commands(text: str, mention: str) -> set[str]:
    """The command after every standalone `mention` in `text`, code included.

    Code masking is a best guess, so it never grants write access on its own:
    callers compare this set with the selected command instead.
    """
    text = text or ""
    return {_split_request(text[match.end() :])[0] for match in _mention_pattern(mention).finditer(text)}


def code_may_be_open_at_mention(text: str, mention: str) -> bool:
    """Whether code could still be open where the selected mention starts.

    A writable run needs certainty, and Markdown containers such as list items let
    fences and multi-line code spans open where the masking above does not look. So
    any fence before the mention counts as open code, and so does a backtick run not
    closed by an equal-length run in the same stretch: a run across a line break,
    table pipe or tag end may sit in another paragraph, cell, HTML tag or autolink,
    and a backtick after a backslash is literal in prose but not in code or HTML, so
    neither can be trusted to close the real opener. The request then runs read-only.
    """
    before = (text or "")[: max(find_mention(text, mention), 0)]
    if "```" in before or "~~~" in before:
        return True
    for stretch in re.split(r"[\r\n|>]", before):
        open_run = None
        for run in re.findall(r"`+", stretch):
            open_run = None if run == open_run else open_run or run
        if open_run is not None or "\\`" in stretch:
            return True
    return False


def branch_list(text: str | None) -> list[str]:
    """Split a comma- or whitespace-separated branch list, dropping blanks and duplicates."""
    return list(dict.fromkeys(filter(None, re.split(r"[\s,]+", text or ""))))


def draft_pr_base(context: dict[str, Any]) -> str:
    """Where the publisher opens its draft PR: a pull request's own head, else the base branch."""
    return (context.get("pull_request") or {}).get("head_ref") or context["base_ref"]


def truncate(text: str, limit: int, marker: str = "\n…[truncated]") -> str:
    text = text or ""
    return text if len(text) <= limit else text[:limit].rstrip() + marker
