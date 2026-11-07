#!/usr/bin/env python3
"""Turn any supported GitHub event into one normalized request JSON.

This is the single dispatcher behind both `@claude` and `@codex`, and behind all
three surfaces (issue / pull request / discussion). Downstream steps never touch
the raw webhook payload again — they read the JSON this writes, so the agent does
not need to know how complex a GitHub event payload is.

Emitted step outputs (the workflow consumes `enabled`; the rest are for the log):
    enabled, reason, surface, number, actor, command, checkout_ref, fetch_depth,
    base_ref, writable

Per-repository settings arrive as workflow inputs in the environment:
BASE_BRANCH (empty means the default branch) and PROTECTED_BRANCHES.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from agent_lib import (  # noqa: E402
    EVENT_ROUTES,
    READ_ONLY_COMMANDS,
    WRITE_COMMANDS,
    AgentConfig,
    branch_list,
    credential_shaped_variables,
    find_mention,
    gh_rest,
    load_config,
    log,
    mention_commands,
    notice,
    parse_request,
    read_event,
    set_outputs,
)


class Skip(Exception):
    """Raised when this event is not a request for us."""


def _text(*parts: str | None) -> str:
    return "\n\n".join(part for part in parts if part)


def _pull_request_details(repo: str, number: int, payload_pr: dict[str, Any] | None) -> dict[str, Any]:
    """Head/base refs for a pull request.

    `issue_comment` fires on pull requests too, but its payload carries only the
    issue view — no head or base. GitHub documents the event's own ref/sha as the
    default branch, which is exactly the trap that makes agents review the wrong
    code, so resolve the real refs from the API whenever they are missing.
    """
    pull = payload_pr or {}
    if not pull.get("head") or not pull.get("base"):
        pull = gh_rest(f"repos/{repo}/pulls/{number}") or {}
    head = pull.get("head") or {}
    base = pull.get("base") or {}
    head_repo = (head.get("repo") or {}).get("full_name") or ""
    return {
        "head_ref": head.get("ref") or "",
        "head_sha": head.get("sha") or "",
        "head_repo": head_repo,
        "base_ref": base.get("ref") or "",
        "base_sha": base.get("sha") or "",
        "is_fork": not head_repo or head_repo.lower() != repo.lower(),
        "draft": bool(pull.get("draft")),
        "state": pull.get("state") or "",
    }


def _guard_edit(
    payload: dict[str, Any], action: str, mention: str, current: dict[str, Any], fields: tuple[str, ...]
) -> None:
    """Skip `edited` events where the mention was already there before the edit.

    Without this, every later typo fix on an issue body re-runs the agent. The
    previous text is the whole routed text before the edit: a field listed in
    `changes` takes its `from` value, an untouched field keeps its current value.
    Reconstructing it from the changed fields alone would let an unrelated title
    fix turn a mention someone else left in the body into a new request attributed
    to the editor, which is who the workflow authorizes.

    The previous text is searched raw, code included. Code masking is a best guess,
    and a mention it wrongly hid before the edit would be the same misattribution.
    The cost is that an edit turning a quoted mention into a real one does not run.
    """
    if action != "edited":
        return
    changes = payload.get("changes") or {}
    if not any(field in changes for field in fields):
        raise Skip("edit did not touch the title or body")
    previous = _text(
        *((changes.get(field) or {}).get("from") if field in changes else current.get(field) for field in fields)
    )
    if mention.lower() in previous.lower():
        raise Skip(f"{mention} was already in the text before this edit")


def extract(payload: dict[str, Any], event_name: str, config: AgentConfig) -> dict[str, Any]:
    """Pull the surface, the request text and the reply target out of a payload."""
    action = payload.get("action") or ""
    mention = config.mention
    routes = EVENT_ROUTES.get(event_name)
    if not routes:
        raise Skip(f"event {event_name} is not handled")
    actions, toggle = routes
    if action not in actions:
        raise Skip(f"{event_name}.{action} is not handled")
    if not config.flag(toggle):
        raise Skip(f"{config.prefix}{toggle} is turned off")

    if event_name == "issue_comment":
        issue = payload.get("issue") or {}
        comment = payload.get("comment") or {}
        is_pr = bool(issue.get("pull_request"))
        return {
            "surface": "pull_request" if is_pr else "issue",
            "number": issue.get("number"),
            "title": issue.get("title") or "",
            "search_text": comment.get("body") or "",
            "source_url": comment.get("html_url") or "",
            "reply": {"kind": "issue_comment", "issue_number": issue.get("number")},
            "react": {"kind": "issue_comment", "id": comment.get("id")},
            "payload_pull_request": None,
        }

    if event_name == "pull_request_review_comment":
        pull = payload.get("pull_request") or {}
        comment = payload.get("comment") or {}
        return {
            "surface": "pull_request",
            "number": pull.get("number"),
            "title": pull.get("title") or "",
            "search_text": comment.get("body") or "",
            "source_url": comment.get("html_url") or "",
            # Reply inside the same review thread rather than in the conversation.
            "reply": {
                "kind": "pr_review_comment",
                "pull_number": pull.get("number"),
                "comment_id": comment.get("id"),
            },
            "react": {"kind": "pr_review_comment", "id": comment.get("id")},
            "inline": {
                "path": comment.get("path") or "",
                "line": comment.get("line") or comment.get("original_line"),
                "diff_hunk": comment.get("diff_hunk") or "",
            },
            "payload_pull_request": pull,
        }

    if event_name == "pull_request_review":
        pull = payload.get("pull_request") or {}
        review = payload.get("review") or {}
        return {
            "surface": "pull_request",
            "number": pull.get("number"),
            "title": pull.get("title") or "",
            "search_text": review.get("body") or "",
            "source_url": review.get("html_url") or "",
            # A review body has no reply or reaction endpoint of its own; answer
            # and react in the pull request conversation instead.
            "reply": {"kind": "issue_comment", "issue_number": pull.get("number")},
            "react": {"kind": "issue", "id": pull.get("number")},
            "payload_pull_request": pull,
        }

    if event_name == "issues":
        issue = payload.get("issue") or {}
        _guard_edit(payload, action, mention, issue, ("title", "body"))
        return {
            "surface": "issue",
            "number": issue.get("number"),
            "title": issue.get("title") or "",
            "search_text": _text(issue.get("title"), issue.get("body")),
            "source_url": issue.get("html_url") or "",
            "reply": {"kind": "issue_comment", "issue_number": issue.get("number")},
            "react": {"kind": "issue", "id": issue.get("number")},
            "payload_pull_request": None,
        }

    if event_name in {"pull_request", "pull_request_target"}:
        pull = payload.get("pull_request") or {}
        _guard_edit(payload, action, mention, pull, ("title", "body"))
        return {
            "surface": "pull_request",
            "number": pull.get("number"),
            "title": pull.get("title") or "",
            "search_text": _text(pull.get("title"), pull.get("body")),
            "source_url": pull.get("html_url") or "",
            "reply": {"kind": "issue_comment", "issue_number": pull.get("number")},
            "react": {"kind": "issue", "id": pull.get("number")},
            "payload_pull_request": pull,
        }

    if event_name == "discussion_comment":
        discussion = payload.get("discussion") or {}
        comment = payload.get("comment") or {}
        return {
            "surface": "discussion",
            "number": discussion.get("number"),
            "title": discussion.get("title") or "",
            "search_text": comment.get("body") or "",
            "source_url": comment.get("html_url") or "",
            "reply": {
                "kind": "discussion_comment",
                "discussion_number": discussion.get("number"),
                "discussion_node_id": discussion.get("node_id") or "",
                # publish_result.py resolves the thread root from this so the
                # answer lands under the question, not at the discussion bottom.
                "comment_node_id": comment.get("node_id") or "",
            },
            "react": {"kind": "node", "node_id": comment.get("node_id") or ""},
            "payload_pull_request": None,
        }

    # discussion (created / edited)
    discussion = payload.get("discussion") or {}
    _guard_edit(payload, action, mention, discussion, ("title", "body"))
    return {
        "surface": "discussion",
        "number": discussion.get("number"),
        "title": discussion.get("title") or "",
        "search_text": _text(discussion.get("title"), discussion.get("body")),
        "source_url": discussion.get("html_url") or "",
        "reply": {
            "kind": "discussion_comment",
            "discussion_number": discussion.get("number"),
            "discussion_node_id": discussion.get("node_id") or "",
            "comment_node_id": "",
        },
        "react": {"kind": "node", "node_id": discussion.get("node_id") or ""},
        "payload_pull_request": None,
    }


def extract_dispatch(config: AgentConfig, payload: dict[str, Any]) -> dict[str, Any]:
    """Manual runs: `workflow_dispatch` with surface/number/request inputs."""
    inputs = payload.get("inputs") or {}
    surface = (inputs.get("surface") or "issue").strip().lower()
    if surface not in {"issue", "pull_request", "discussion"}:
        raise Skip(f"unsupported surface input: {surface!r}")
    number = inputs.get("number")
    request = inputs.get("request") or ""
    reply: dict[str, Any] = {"kind": "issue_comment", "issue_number": number}
    if surface == "discussion":
        reply = {
            "kind": "discussion_comment",
            "discussion_number": number,
            "discussion_node_id": "",
            "comment_node_id": "",
        }
    return {
        "surface": surface,
        "number": int(number) if number else None,
        "title": "",
        "search_text": f"{config.mention} {request}".strip(),
        "source_url": "",
        "reply": reply,
        "react": {"kind": "none"},
        "payload_pull_request": None,
    }


def resolve_checkout(
    context: dict[str, Any], repo: str, base_branch: str, protected: tuple[str, ...] | list[str] = ()
) -> None:
    """Decide what to inspect, and whether the separate publisher may accept a patch.

    Issue and discussion requests start on `base_branch`, and their draft pull
    request targets it. A pull request whose head is a `protected` branch is
    read-only: a follow-up draft PR into that branch is a change to it.

    Read-only commands see the pull request exactly as its author wrote it
    (`refs/pull/N/head`, full history so `origin/<base>...HEAD` works). Everything
    else needs a writable branch, so same-repo pull requests are checked out by
    branch name. Fork pull requests are never writable through our token: the
    agent gets the head ref read-only and is told to open a fresh pull request.

    Code masking is a best guess, so a quoted example it misses could select the
    command. The branch is therefore writable only when every mention in the raw
    text, code included, names the selected command.
    """
    command = context["command"]
    agreed = mention_commands(context["search_text"], context["mention"]) == {command}
    read_only = command not in WRITE_COMMANDS or not agreed

    if context["surface"] != "pull_request" or not context.get("number"):
        context["ref"] = base_branch
        context["fetch_depth"] = 1
        context["writable"] = not read_only
        context["base_ref"] = base_branch
        return

    pull = _pull_request_details(repo, int(context["number"]), context.get("payload_pull_request"))
    context["pull_request"] = pull
    context["base_ref"] = pull["base_ref"] or base_branch
    number = context["number"]
    context["fetch_depth"] = 0  # reviews and fixes both need the base to diff against

    if read_only or pull["is_fork"] or not pull["head_ref"] or pull["head_ref"] in protected:
        context["ref"] = f"refs/pull/{number}/head"
        context["writable"] = False
    else:
        context["ref"] = pull["head_ref"]
        context["writable"] = True


def main() -> int:
    config = load_config()
    payload = read_event()
    event_name = os.environ.get("GITHUB_EVENT_NAME", "")
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    repository = payload.get("repository") or {}
    default_branch = repository.get("default_branch") or "main"
    actor = (payload.get("sender") or {}).get("login") or os.environ.get("GITHUB_ACTOR", "")

    def disable(reason: str) -> int:
        notice(f"{config.mention} pipeline skipped: {reason}")
        set_outputs({"enabled": "false", "reason": reason})
        return 0

    # Fail loudly rather than run — and keep printing it — with a credential in
    # a configuration variable.
    leaked = credential_shaped_variables(config.variables)
    if leaked:
        for name in leaked:
            print(
                f"::error::repository variable {name} looks like a credential. Variables are "
                "configuration, not secrets: GitHub does not encrypt them and workflows echo "
                "them into run logs. Move the value to an Actions secret and delete the variable.",
                flush=True,
            )
        return 1

    if not config.enabled(repository.get("private") is True):
        return disable(f"{config.prefix}ENABLED is off (unset means off for public repositories)")

    try:
        if event_name == "workflow_dispatch":
            context = extract_dispatch(config, payload)
        else:
            context = extract(payload, event_name, config)
    except Skip as skip:
        return disable(str(skip))

    if not context.get("number"):
        return disable("could not resolve the issue / pull request / discussion number")

    command, request = parse_request(context["search_text"], config.mention)
    if event_name != "workflow_dispatch" and find_mention(context["search_text"], config.mention) < 0:
        return disable(f"{config.mention} is not in the triggering text")
    if not request and not command:
        return disable(f"{config.mention} was mentioned with no request")

    if actor.endswith("[bot]") or (payload.get("sender") or {}).get("type") == "Bot":
        return disable(f"actor {actor} is a bot; bots are always ignored")

    base_branch = os.environ.get("BASE_BRANCH", "").strip() or default_branch
    # The default branch is always protected; the caller adds shared branches.
    protected = branch_list(f"{default_branch},{os.environ.get('PROTECTED_BRANCHES', '')}")
    context.update(
        {
            "agent": config.agent,
            "mention": config.mention,
            "event_name": event_name,
            "event_action": payload.get("action") or "",
            "actor": actor,
            "command": command,
            "request": request,
            "repo": repo,
            "repo_owner": repo.split("/")[0] if "/" in repo else "",
            "repo_name": repo.split("/")[1] if "/" in repo else "",
            "default_branch": default_branch,
            "protected_branches": protected,
            "read_only_command": command in READ_ONLY_COMMANDS,
            "run_url": (
                f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{repo}"
                f"/actions/runs/{os.environ.get('GITHUB_RUN_ID', '')}"
            ),
        }
    )
    resolve_checkout(context, repo, base_branch, protected)
    context.pop("payload_pull_request", None)

    event_file = os.environ.get("EVENT_FILE") or "agent-event.json"
    with open(event_file, "w", encoding="utf-8") as handle:
        json.dump(context, handle, ensure_ascii=False, indent=2)
    log(f"normalized request written to {event_file}")
    log(f"route: {context['surface']} #{context['number']}, writable={context['writable']}")

    set_outputs(
        {
            "enabled": "true",
            "reason": "",
            "surface": context["surface"],
            "number": context["number"],
            "actor": context["actor"],
            "command": context["command"] or "(none)",
            "checkout_ref": context["ref"],
            "fetch_depth": context["fetch_depth"],
            "base_ref": context["base_ref"],
            "writable": str(context["writable"]).lower(),
        }
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
