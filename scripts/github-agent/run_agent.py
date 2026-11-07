#!/usr/bin/env python3
"""Launch the agent. This is the only place where Claude and Codex differ.

Both are driven as CLIs so that one dispatcher serves issues, pull requests and
discussions, and so that both can authenticate with OAuth:

* Claude — `claude -p`, authenticated by `CLAUDE_CODE_OAUTH_TOKEN`.
* Codex  — `codex exec`, authenticated by a `CODEX_AUTH_JSON` secret written into
  a private `CODEX_HOME/auth.json` (the file `codex login` produces locally).
  `openai/codex-action` is deliberately not used: it starts a Responses API proxy
  and its `read-server-info` step fails whenever `openai-api-key` is empty, so it
  cannot run on OAuth credentials. `OPENAI_API_KEY` is still honoured as a
  fallback for anyone who prefers key auth.

The authorized model runs without GitHub mutation credentials in a disposable
execution job. Read-only requests restrict local tools/sandbox; writable work is
collected as a patch for validation in a fresh, trusted publisher job.

The status file also carries what the reply signature needs: the start time, the
measured duration, and the model and effort the CLI itself reported. Prompt text
and launcher flags are never evidence of the model that ran.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
import time
import signal
import tempfile
from datetime import datetime
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from agent_lib import load_config, load_context, log, warn  # noqa: E402


# Both CLIs read the prompt from stdin: a long thread as one argument exceeds the
# kernel's per-argument limit (E2BIG) before the CLI starts.
def claude_command(config) -> tuple[list[str], dict[str, str], str]:
    argv = [
        "claude",
        "-p",
        "--output-format",
        "json",
        "--max-turns",
        str(min(100, max(1, config.number("MAX_TURNS")))),
        "--setting-sources", "",
        "--strict-mcp-config",
        "--no-session-persistence",
    ]
    if config.get("MODEL"):
        argv.extend(["--model", config.get("MODEL")])
    if config.get("EFFORT"):
        argv.extend(["--effort", config.get("EFFORT")])
    allowed = config.get("ALLOWED_TOOLS")
    if allowed:
        argv.append("--allowedTools")
        argv.extend(tool.strip() for tool in allowed.split(",") if tool.strip())
    else:
        argv.append("--dangerously-skip-permissions")
    # Claude prints one JSON result on stdout: the final message plus the models it used.
    return argv, {}, "stdout"


def codex_command(config, result_file: str) -> tuple[list[str], dict[str, str], str]:
    home = Path(tempfile.mkdtemp(prefix="agent-codex-", dir=os.environ.get("RUNNER_TEMP")))
    home.chmod(0o700)
    env: dict[str, str] = {"CODEX_HOME": str(home)}
    auth_json = os.environ.get("CODEX_AUTH_JSON", "").strip()
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if auth_json:
        json.loads(auth_json)  # reject malformed credentials before launching
        auth_path = home / "auth.json"
        auth_path.write_text(auth_json, encoding="utf-8")
        auth_path.chmod(0o600)
        env["CODEX_HOME"] = str(home)
        log(f"codex using OAuth credentials from CODEX_AUTH_JSON ({home})")
    elif api_key:
        # Non-interactive Codex 0.154.0 reads CODEX_API_KEY. Keep the
        # repository secret name stable, but map it to the actual CLI contract.
        env["CODEX_API_KEY"] = api_key
        log("codex using OPENAI_API_KEY (no CODEX_AUTH_JSON secret set)")
    else:
        raise SystemExit(
            "neither CODEX_AUTH_JSON nor OPENAI_API_KEY is set — cannot authenticate Codex. "
            "Run `codex login` locally and store ~/.codex/auth.json as the CODEX_AUTH_JSON secret."
        )

    argv = [
        "codex",
        "exec",
        "--ignore-user-config", "--ignore-rules", "--ephemeral",
        "--output-last-message",
        result_file,
    ]
    if config.get("MODEL"):
        argv.extend(["--model", config.get("MODEL")])
    sandbox = config.get("SANDBOX")
    if sandbox == "danger-full-access":
        argv.append("--dangerously-bypass-approvals-and-sandbox")
    else:
        argv.extend(["--sandbox", sandbox])
        if sandbox == "workspace-write":
            # Authorized implementation may install dependencies and run local checks.
            argv.extend(["-c", "sandbox_workspace_write.network_access=true"])
    effort = config.get("EFFORT")
    if effort:
        argv.extend(["-c", f"model_reasoning_effort={effort}"])
    argv.append("-")  # read the prompt from stdin
    # `--output-last-message` already writes the reply; stdout is the final message
    # and stderr the transcript, which opens with the session header we read.
    return argv, env, "stderr"


# Codex's session header sits at the top of stderr; the rest is transcript.
HEADER_LINES = 200


def launch(argv: list[str], env: dict[str, str], cwd: str, capture: str) -> subprocess.Popen:
    """Start the CLI with the `capture` stream ("stdout" or "stderr") piped back to us.

    Raises like `Popen` does when the executable or working directory is missing,
    in which case no process exists and the run must not be signed as started.
    """
    environment = {name: value for name, value in os.environ.items()
                   if not name.startswith(("GH_", "GITHUB_", "ACTIONS_"))}
    environment.update(env)
    environment.pop("CODEX_AUTH_JSON", None)
    environment.pop("OPENAI_API_KEY", None)
    if argv[0] == "claude":
        environment.pop("CODEX_API_KEY", None)
    else:
        environment.pop("CLAUDE_CODE_OAUTH_TOKEN", None)
        if "CODEX_API_KEY" not in env:
            # An OAuth selection must not accidentally inherit API-key auth.
            environment.pop("CODEX_API_KEY", None)
    log(f"launching {argv[0]} (prompt and transcript omitted from logs)")

    return subprocess.Popen(
        argv,
        cwd=cwd,
        env=environment,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
        text=True,
        bufsize=1,
    )


def run(process: subprocess.Popen, capture: str, prompt: str = "") -> tuple[int, str]:
    """Send the prompt on stdin, capture CLI output privately, and kill the process group before the job deadline."""
    config = load_config()
    timeout = min(25, max(1, config.number("TIMEOUT_MINUTES"))) * 60
    try:
        stdout, stderr = process.communicate(input=prompt, timeout=timeout)
        code = process.returncode
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            stdout, stderr = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
        code = 124
    captured = stdout if capture == "stdout" else "\n".join(stderr.splitlines()[:HEADER_LINES])
    return code, captured


def requested_effort(config) -> str:
    """How the signature shows an effort the CLI did not report."""
    effort = config.get("EFFORT")
    return f"{effort} (requested)" if effort else "N/A (not emitted)"


def claude_observed(stdout: str, config) -> tuple[str, dict[str, str]]:
    """Split Claude's JSON result into the reply text and the session's model and effort.

    `modelUsage` names every model the session billed. A run can also bill a small
    helper model, so the session's model is the one that wrote the most output.
    Claude does not report effort, so only a requested value is shown, marked as
    requested. Output that is not the expected JSON is kept as the reply.
    """
    try:
        result = json.loads(stdout)
    except json.JSONDecodeError:
        result = None
    if not isinstance(result, dict):
        return stdout.strip(), {"model": "unknown", "effort": requested_effort(config)}
    usage = {name: entry for name, entry in (result.get("modelUsage") or {}).items() if isinstance(entry, dict)}
    model = max(usage, key=lambda name: usage[name].get("outputTokens") or 0, default="")
    observed = (usage.get(model) or {}).get("canonicalModel") or model or "unknown"
    return str(result.get("result") or "").strip(), {"model": observed, "effort": requested_effort(config)}


def codex_observed(stderr: str, config) -> dict[str, str]:
    """Model and effort from the session header Codex prints between two dashed lines.

    The header is the dashed block that directly follows the `OpenAI Codex v…`
    banner. Everything else, including dashed blocks that merely look like one,
    is transcript that may quote prompt text, so it is never read as metadata.
    """
    lines = stderr.splitlines()
    rules = [index for index, line in enumerate(lines) if re.fullmatch(r"-{4,}", line.strip())]
    header: dict[str, str] = {}
    if len(rules) >= 2 and rules[0] > 0 and lines[rules[0] - 1].startswith("OpenAI Codex v"):
        for line in lines[rules[0] + 1 : rules[1]]:
            match = re.match(r"^([a-z ]+):\s*(.+)$", line.strip())
            if match:
                header[match.group(1)] = match.group(2).strip()
    return {
        "model": header.get("model") or "unknown",
        "effort": header.get("reasoning effort") or requested_effort(config),
    }


def started_stamp(moment: datetime | None = None) -> str:
    """Wall-clock start as `yyyy-MM-dd HH:mm` with the zone named, like the dev skills."""
    return (moment or datetime.now()).astimezone().strftime("%Y-%m-%d %H:%M %Z")


def elapsed_stamp(seconds: float) -> str:
    """Duration as `H:mm`: unbounded hours, whole minutes, so a sub-minute run is `0:00`."""
    whole = max(int(seconds), 0)
    return f"{whole // 3600}:{whole % 3600 // 60:02d}"


def write_status(status: dict) -> None:
    Path(os.environ.get("STATUS_FILE") or "agent-status.json").write_text(json.dumps(status), encoding="utf-8")


def main() -> int:
    config = load_config()
    context = load_context()
    prompt_file = os.environ.get("PROMPT_FILE") or "agent-prompt.txt"
    result_file = os.environ.get("RESULT_FILE") or "agent-result.md"
    work_dir = os.environ.get("WORK_DIR") or os.getcwd()
    prompt = Path(prompt_file).read_text(encoding="utf-8")

    # Written in a finally block so that a failure to even build the command —
    # missing Codex credentials, say — still reports a real exit code in the reply
    # instead of "unknown". A run that never launched has no start time, so its
    # reply is signed "not run".
    code = 1
    status = {"agent": config.agent, "exit_code": code, "command": context.get("command", "")}
    env = {}
    try:
        if config.agent == "claude":
            argv, env, capture = claude_command(config)
        else:
            argv, env, capture = codex_command(config, result_file)
        if not context.get("writable"):
            if config.agent == "claude":
                argv.extend(["--tools", "Read,Glob,Grep", "--permission-mode", "dontAsk"])
                if "--dangerously-skip-permissions" in argv:
                    argv.remove("--dangerously-skip-permissions")
            else:
                if "--dangerously-bypass-approvals-and-sandbox" in argv:
                    argv.remove("--dangerously-bypass-approvals-and-sandbox")
                if "--sandbox" in argv:
                    argv[argv.index("--sandbox") + 1] = "read-only"
                else:
                    argv[-1:-1] = ["--sandbox", "read-only"]
        process = launch(argv, env, work_dir, capture)
        # The process exists from here on: record its start at once, so a run the
        # job timeout kills still has one, while a failed spawn never gets one.
        status["started"] = started_stamp()
        write_status(status)
        began = time.monotonic()
        code, captured = run(process, capture, prompt)
        status["elapsed"] = elapsed_stamp(time.monotonic() - began)
        if config.agent == "claude":
            message, observed = claude_observed(captured, config)
            Path(result_file).write_text(message, encoding="utf-8")
        else:
            observed = codex_observed(captured, config)
        status.update(observed)
    finally:
        status["exit_code"] = code
        write_status(status)
        auth = Path(env.get("CODEX_HOME", "/nonexistent")) / "auth.json"
        auth.unlink(missing_ok=True)
    log(f"{config.agent} exited with {code}")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
