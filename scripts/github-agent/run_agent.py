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
execution job. The provider credential stays in the CLI process; every
model-directed read, edit and command runs in a bounded worker with the checkout,
a cleared environment, no network and no view of that process or its credential
files (README "Trust boundary"): Codex through its own Linux sandbox and a named
permission profile, Claude through the bubblewrap shell prefix shared with the
dev-review-pr skill. Writable work is collected as a patch for validation in a
fresh, trusted publisher job.

The status file also carries what the reply signature needs: the start time, the
measured duration, and the model and effort the CLI itself reported. Prompt text
and launcher flags are never evidence of the model that ran.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
import signal
import tempfile
from datetime import datetime
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from agent_lib import load_config, load_context, log, warn  # noqa: E402


# The trusted worker shell, checked out beside these scripts (the execute job's sparse checkout).
BOUNDED_SHELL = Path(__file__).resolve().parents[2] / "plugins/dev-skills/skills/dev-review-pr/scripts/bounded-shell.sh"


def toolchain_dirs(path: str, home: str, logins: tuple[str, ...]) -> list[str]:
    """Read-only toolchain mounts, as in launch-phase.mjs: each absolute PATH directory and a `bin`
    directory's installation prefix unless that is the home directory or directly inside it. A
    directory that is or holds the home directory or a login location, or lies in a login location,
    is never mounted."""
    home = os.path.realpath(home) if home else ""
    logins = tuple(os.path.realpath(login) for login in logins if login)
    covers = lambda outer, inner: inner == outer or inner.startswith(outer + "/")  # noqa: E731
    dirs: list[str] = []
    for entry in path.split(":"):
        if not os.path.isabs(entry) or not os.path.isdir(entry):
            continue
        real = os.path.realpath(entry)
        shallow = bool(home) and home in (os.path.dirname(real), os.path.dirname(os.path.dirname(real)))
        for candidate in [real, os.path.dirname(real)] if os.path.basename(real) == "bin" and not shallow else [real]:
            if candidate != "/" and candidate not in dirs and not any(covers(candidate, p) for p in (home, *logins) if p) \
                    and not any(covers(login, candidate) for login in logins):
                dirs.append(candidate)
    return dirs


def worker_bounds(work_dir: str) -> dict:
    """What the bounded worker may see: the toolchain and Git metadata read-only, plus a fresh scratch directory."""
    temp = os.environ.get("RUNNER_TEMP") or tempfile.gettempdir()
    scratch = tempfile.mkdtemp(prefix="agent-worker-", dir=temp)
    path = os.environ.get("PATH", "")
    # The runner's temporary directory holds the Codex login, so neither it nor anything in it is a toolchain.
    return {"scratch": scratch, "path": path, "git": [os.path.join(work_dir, ".git")], "work_dir": work_dir,
            "read": toolchain_dirs(path, os.environ.get("HOME", ""), (temp,))}


def claude_command(config, writable: bool, bounds: dict) -> tuple[list[str], dict[str, str], str]:
    # Bash is the only tool and the trusted shell prefix runs every command in the bounded worker.
    # Native file tools would run in the CLI process that holds the credential, so none is offered.
    tools = ("Bash",)
    allowed = {tool.strip() for tool in config.get("ALLOWED_TOOLS").split(",") if tool.strip()}
    if allowed:
        tools = tuple(tool for tool in tools if tool in allowed)
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
        "--tools", ",".join(tools),
        "--allowedTools", ",".join(tools),
        "--permission-mode", "dontAsk",
    ]
    if config.get("MODEL"):
        argv.extend(["--model", config.get("MODEL")])
    if config.get("EFFORT"):
        argv.extend(["--effort", config.get("EFFORT")])
    env = {"CLAUDE_CODE_SHELL_PREFIX": str(BOUNDED_SHELL), "BOUNDED_WORKTREE": bounds["work_dir"],
           "BOUNDED_MODE": "write" if writable else "read", "BOUNDED_SCRATCH": bounds["scratch"],
           "BOUNDED_READ": "\n".join(bounds["read"]), "BOUNDED_GIT": "\n".join(bounds["git"]),
           "BOUNDED_PATH": bounds["path"], "TMPDIR": bounds["scratch"]}
    # Claude prints one JSON result on stdout: the final message plus the models it used.
    return argv, env, "stdout"


def probe_worker(env: dict[str, str]) -> None:
    """Refuse to launch Claude when the bounded shell cannot start, instead of running it without tools."""
    result = subprocess.run([env["CLAUDE_CODE_SHELL_PREFIX"], "true"], env={"PATH": os.environ.get("PATH", ""), **env},
                            cwd=env["BOUNDED_WORKTREE"], capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise SystemExit(f"the bounded worker could not start: {result.stderr.strip()[:200]}")


def toml(table: dict[str, str]) -> str:
    return "{" + ", ".join(f"{json.dumps(key)}={json.dumps(value)}" for key, value in table.items()) + "}"


def codex_command(config, result_file: str, bounds: dict, writable: bool = False) -> tuple[list[str], dict[str, str], str]:
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

    # The demonstrated bounded profile: Codex's Linux sandbox runs every command with no network, a
    # cleared environment, read access to the system minimum, the toolchain and Git metadata, and
    # the checkout writable only for an authorized writer. No legacy --sandbox flag is passed.
    filesystem = {":minimal": "read", **{path: "read" for path in bounds["read"]},
                  ":workspace_roots": "write" if writable else "read", bounds["scratch"]: "write",
                  **{path: "read" for path in bounds["git"]}}
    shell_env = {"PATH": bounds["path"], "LANG": "C.UTF-8", "HOME": bounds["scratch"], "TMPDIR": bounds["scratch"]}
    argv = [
        "codex",
        "exec",
        "--ignore-user-config", "--ignore-rules", "--ephemeral",
        "-c", 'default_permissions="bounded"',
        "-c", f"permissions.bounded.filesystem={toml(filesystem)}",
        "-c", "permissions.bounded.network.enabled=false",
        "-c", 'shell_environment_policy.inherit="none"',
        "-c", f"shell_environment_policy.set={toml(shell_env)}",
        "-c", 'approval_policy="never"',
        "--output-last-message",
        result_file,
    ]
    if config.get("MODEL"):
        argv.extend(["--model", config.get("MODEL")])
    effort = config.get("EFFORT")
    if effort:
        argv.extend(["-c", f"model_reasoning_effort={effort}"])
    argv.append("-")  # both CLIs read the prompt from stdin: one huge argument fails with E2BIG
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
    bounds = worker_bounds(work_dir)
    try:
        if config.agent == "claude":
            argv, env, capture = claude_command(config, bool(context.get("writable")), bounds)
            probe_worker(env)
        else:
            argv, env, capture = codex_command(config, result_file, bounds, bool(context.get("writable")))
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
        shutil.rmtree(bounds["scratch"], ignore_errors=True)
    log(f"{config.agent} exited with {code}")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
