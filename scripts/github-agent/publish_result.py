#!/usr/bin/env python3
"""Post the agent's final message back to whichever surface asked for it.

The agent never comments itself — it just produces a final message. Publishing it
from one place keeps the reply consistent across all three surfaces, and lets us
neutralise agent mentions in the outgoing text so a reply can never retrigger the
workflows.

Runs with `if: always()`, so it is also the place that reports a failed run.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from agent_lib import (  # noqa: E402
    gh_graphql,
    gh_rest,
    load_context,
    log,
    mask_code,
    sanitize_mentions,
    truncate,
    warn,
)

# GitHub rejects comment bodies over 65536 characters.
BODY_LIMIT = 60000

AGENT_LABELS = {"claude": "Claude", "codex": "Codex"}

RESOLVE_DISCUSSION = """
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { discussion(number: $number) { id } }
}
"""

RESOLVE_THREAD_ROOT = """
query($id: ID!) {
  node(id: $id) { ... on DiscussionComment { id replyTo { id } } }
}
"""

ADD_DISCUSSION_COMMENT = """
mutation($discussionId: ID!, $body: String!, $replyToId: ID) {
  addDiscussionComment(input: {discussionId: $discussionId, body: $body, replyToId: $replyToId}) {
    comment { url }
  }
}
"""


def read_status() -> dict[str, Any]:
    path = Path(os.environ.get("STATUS_FILE") or "agent-status.json")
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


# Where the checked-out repository keeps its skills, one directory per skill.
SKILL_DIRS = (".claude/skills", ".agents/skills")
# `/name` invokes a skill in Claude, `$name` in Codex.
_SKILL_TOKEN = re.compile(r"(?<![\w/$.-])[/$]([a-z0-9][a-z0-9-]*)\b")


def requested_skill(request: str, work_dir: str) -> str:
    """The first repository skill the request invokes as `/name` or `$name`, else "".

    As with mentions, a name inside backticks or a code fence is quoted, not invoked.
    """
    if not work_dir:
        return ""
    for match in _SKILL_TOKEN.finditer(mask_code(request)):
        name = match.group(1)
        if any((Path(work_dir) / folder / name / "SKILL.md").is_file() for folder in SKILL_DIRS):
            return name
    return ""


def signature(context: dict[str, Any], status: dict[str, Any]) -> str:
    """One signed line in the dev skills' format: agent·model·effort, skill, start, duration.

    The skill is the repository skill the request invoked, otherwise the label the
    calling workflow configured (SKILL_LABEL, default `ask-<agent>`). A run that
    never launched has no start time and is "not run".
    """
    agent = context.get("agent") or "unknown"
    skill = requested_skill(context.get("request") or "", os.environ.get("WORK_DIR") or "")
    label = os.environ.get("SKILL_LABEL", "").strip() or f"ask-{agent}"
    fields = [
        f"💬 {agent}·{status.get('model') or 'unknown'}·{status.get('effort') or 'N/A (not emitted)'}",
        f"skill: {skill or label}",
    ]
    if context.get("command"):
        fields.append(f"command: {context['command']}")
    if status.get("started"):
        fields.extend([status["started"], status.get("elapsed") or "unknown"])
    else:
        fields.append("not run")
    if context.get("run_url"):
        fields.append(f"[Run log]({context['run_url']})")
    return " · ".join(fields)


def compose(context: dict[str, Any]) -> str:
    """The reply body: the agent's message, or an honest failure note."""
    agent = context.get("agent", "")
    label = AGENT_LABELS.get(agent, agent)
    status = read_status()
    result_file = Path(os.environ.get("RESULT_FILE") or "agent-result.md")
    message = result_file.read_text(encoding="utf-8").strip() if result_file.exists() else ""

    if not message:
        message = (
            f"This {label} run produced no reply "
            f"(exit code {status.get('exit_code', 'unknown')}). Check the run log for details."
        )
    elif status.get("exit_code") not in (0, None):
        message += (
            f"\n\n> ⚠️ {label} exited with code {status.get('exit_code')}. "
            "The response above may be incomplete; check the run log."
        )

    # The blank line keeps `---` a separator rather than a heading underline.
    footer = f"\n\n---\n{signature(context, status)}"

    # Truncate the message, not the whole body, so the signature and its run link
    # survive an over-long reply.
    message = truncate(message, BODY_LIMIT - len(footer), marker="\n…[reply truncated]")

    # Last line of loop defence: our own reply must not contain a live trigger.
    return sanitize_mentions(message + footer)


def publish(context: dict[str, Any], body: str) -> str:
    repo = context["repo"]
    reply = context.get("reply") or {}
    kind = reply.get("kind")

    if kind == "pr_review_comment":
        try:
            created = gh_rest(
                f"repos/{repo}/pulls/{reply['pull_number']}/comments/{reply['comment_id']}/replies",
                method="POST",
                body={"body": body},
            )
            return (created or {}).get("html_url", "")
        except Exception as error:  # noqa: BLE001
            # Threads on outdated diffs can refuse replies; the conversation always works.
            warn(f"could not reply in the review thread ({error}); falling back to a PR comment")
            created = gh_rest(
                f"repos/{repo}/issues/{reply['pull_number']}/comments",
                method="POST",
                body={"body": body},
            )
            return (created or {}).get("html_url", "")

    if kind == "discussion_comment":
        discussion_id = reply.get("discussion_node_id") or ""
        if not discussion_id:
            data = gh_graphql(
                RESOLVE_DISCUSSION,
                {
                    "owner": context["repo_owner"],
                    "name": context["repo_name"],
                    "number": int(reply["discussion_number"]),
                },
            )
            discussion_id = (((data or {}).get("repository") or {}).get("discussion") or {}).get("id", "")
        reply_to = None
        comment_node_id = reply.get("comment_node_id") or ""
        if comment_node_id:
            # Land the answer under the question. A reply-to-a-reply must target
            # the thread root, so follow replyTo when it is set.
            node = ((gh_graphql(RESOLVE_THREAD_ROOT, {"id": comment_node_id}) or {}).get("node")) or {}
            reply_to = ((node.get("replyTo") or {}).get("id")) or comment_node_id
        data = gh_graphql(
            ADD_DISCUSSION_COMMENT,
            {"discussionId": discussion_id, "body": body, "replyToId": reply_to},
        )
        return (((data or {}).get("addDiscussionComment") or {}).get("comment") or {}).get("url", "")

    # issue_comment covers issues, pull request conversations and review bodies.
    created = gh_rest(
        f"repos/{repo}/issues/{reply['issue_number']}/comments",
        method="POST",
        body={"body": body},
    )
    return (created or {}).get("html_url", "")


def main() -> int:
    context = load_context()
    body = compose(context)
    try:
        url = publish(context, body)
    except Exception as error:  # noqa: BLE001
        warn(f"failed to publish the reply: {error}")
        log(body)
        return 1
    log(f"reply posted: {url or '(no url returned)'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
