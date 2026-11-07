#!/usr/bin/env python3
"""Gate the pipeline on the triggering user's repository permission.

Load-bearing: only authorized collaborators can start model work or publish a
result. Preparation and publication both run this check from trusted tooling.
Any error resolving the permission means "not authorized".
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from agent_lib import gh_rest, load_config, load_context, log, notice, set_outputs  # noqa: E402

WRITE_PERMISSIONS = {"admin", "maintain", "write"}


def main() -> int:
    config = load_config()
    context = load_context()
    actor = context.get("actor") or ""
    repo = context.get("repo") or os.environ.get("GITHUB_REPOSITORY", "")

    if not actor or not repo:
        notice("cannot determine the actor or repository — refusing to run")
        set_outputs({"ok": "false", "permission": "unknown"})
        return 0

    try:
        response = gh_rest(f"repos/{repo}/collaborators/{actor}/permission") or {}
        permission = str(response.get("permission") or "none")
    except Exception as error:  # noqa: BLE001 - any failure must fail closed
        log(f"permission lookup failed: {error}")
        permission = "none"

    ok = permission in WRITE_PERMISSIONS
    log(f"actor={actor} permission={permission} authorized={ok}")
    if not ok:
        notice(f"@{actor} lacks write access — ignoring the {config.mention} request.")
    set_outputs({"ok": str(ok).lower(), "permission": permission, "actor": actor})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
