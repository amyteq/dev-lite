# Ask agent

A reusable GitHub Actions pipeline that lets Claude Code and Codex answer mentions in issues, pull requests, inline review comments, review bodies and discussions. A consumer repository adds two thin caller workflows; everything else lives here:

| Path | Role |
| --- | --- |
| `.github/workflows/ask-agent.yml` | The reusable workflow (`on: workflow_call`): prepare, execute and publish jobs |
| `templates/github/ask-claude.yml`, `ask-codex.yml` | Caller files a consumer copies into its `.github/workflows/` |
| `scripts/github-agent/cli/` | Pinned Claude Code and Codex CLI versions with their lockfile |
| `agent_lib.py` | Configuration, GitHub API, mention parsing and output sanitizing |
| `normalize_event.py` | Event routing, edit and mixed-command guards, base and protected branches, fork/read-only decisions |
| `authorize_actor.py` | Requires `write`, `maintain` or `admin`; any lookup failure denies |
| `snapshot_request.py` | Captures the immutable target revision after authorization |
| `build_prompt.py` | Authorized request, project rules, and thread context fenced off as data |
| `run_agent.py` | Launches the pinned CLI without GitHub credentials, with a timeout and observed metadata |
| `collect_changes.py`, `validate_result.py` | Collect local edits as an untrusted patch; bound the result files |
| `publish_changes.py` | Validates the patch in a fresh job and opens a draft PR from a generated branch |
| `publish_result.py` | Posts the reply or an honest failure note, signed, to the originating thread |

The scripts use only the Python standard library.

## Set up a repository

1. Copy `templates/github/ask-claude.yml` and/or `ask-codex.yml` into `.github/workflows/` and merge them into the **default branch**; issue, comment and discussion events only fire from workflow files there.
2. Add Actions secrets for the agents you use: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), and `CODEX_AUTH_JSON` (the whole `~/.codex/auth.json` written by `codex login`) or `OPENAI_API_KEY`. Codex prefers OAuth when both exist. The caller passes each secret by name because `secrets: inherit` does not cross organizations.
3. Optionally set the repository variables `CLAUDE_ACTION_ENABLED` / `CODEX_ACTION_ENABLED`. When unset, an agent is **on in private repositories and off in public ones**; `true` or `false` overrides that. Changing a variable does not stop a run already in progress.
4. In **Settings → Actions → General**, allow this reusable workflow if the organization restricts actions (for example `amyteq/dev-lite/.github/workflows/ask-agent.yml@*`), and allow GitHub Actions to create pull requests if write commands should publish drafts.
5. As a maintainer, try a read-only request such as `@claude explain the repository layout` on a test issue and check that exactly one reply with a run link appears.

The requester needs `write`, `maintain` or `admin` permission; it is checked before the model runs and again before publishing. Bots are always ignored. If a ChatGPT Codex connector is installed on the repository it also answers `@codex`, so disable one of the two.

## Inputs

All inputs except `agent` are optional and go under the caller's `with:`.

| Input | Default | Meaning |
| --- | --- | --- |
| `agent` | required | `claude` or `codex` |
| `base_branch` | default branch | Branch issue and discussion work starts from and its draft PR targets |
| `protected_branches` | empty | Comma-separated branches never pushed to; a PR whose head is one of them is read-only. The default branch is always protected. Example for a project whose integration owns a branch: `develop,lovable` |
| `project_rules` | empty | Extra rules text appended to the prompt's repository rules (checks to run, reply language, ...) |
| `project_rules_file` | empty | Path in the repository the agent must read first, in addition to `AGENTS.md`, `README.md` and `CLAUDE.md` |
| `skill_label` | `ask-<agent>` | Skill shown in the reply signature when the request invokes no repository skill |
| `node_version` | `24.19.0` | Node.js on the execute runner |
| `bun_version` | empty | Installs Bun for project checks when set |

Replies, failure notes and draft PRs are English; ask for another reply language in `project_rules`.

## Variables

Prefix `CLAUDE_ACTION_` or `CODEX_ACTION_`. Only these names are read; the whole `vars` context is never passed. Only the routing step receives them, and it records them in the request artifact, which every later step reads instead. GitHub renders that step's environment in its log, so a step before it stops the job when any repository variable looks like a credential; only its condition reads the values, and it prints a fixed message. Variables are not secret: move such a value to an Actions secret and delete the variable. A run with step debug logging enabled also prints evaluated conditions, so keep debug logging off.

| Suffix | Default | Meaning |
| --- | --- | --- |
| `ENABLED` | by visibility | Master switch, also for manual runs |
| `ISSUE_COMMENT`, `PR_REVIEW_COMMENT`, `PR_REVIEW`, `ISSUES`, `PULL_REQUEST`, `DISCUSSION_COMMENT`, `DISCUSSION` | `true` | Per-event switches; `PULL_REQUEST` matters only after opting in below |
| `MODEL`, `EFFORT` | CLI default | The reply records the observed values, never the requested ones as fact |
| `TIMEOUT_MINUTES` | `20` | CLI timeout, clamped to 1–25 |
| `CONTEXT_COMMENTS` | `20` | Newest thread comments in the prompt, clamped to 1–100 |
| `CONTEXT_CHARS` | `4000` | Characters per context section, clamped to 100–20000 |
| `MAX_TURNS` | `100` | Claude only, clamped to 1–100 |
| `ALLOWED_TOOLS` | empty | Claude only: narrows `Read`, `Glob`, `Grep`, `Edit` and `Write`; it never adds a tool |

## Commands and routing

Read commands are `review`, `audit`, `plan`, `explain`, `triage`, `summarize`, `answer` and `ask`; write commands are `fix`, `implement`, `test`, `refactor`, `docs`, `design`, `chore` and `revert`, given as the first word after the mention. A request is writable only when every mention in the raw text, code included, names the same write command. Missing, unknown or mixed commands, fork PRs, PRs whose head is protected and every Codex request are read-only. Mentions inside backticks, code fences (including an unclosed fence, which runs to the end of the text) or lines indented four or more columns, also inside a `>` quote, do not trigger a run. An inline review comment's file, line and bounded diff hunk reach the prompt as quoted thread data. Editing a comment never re-runs; editing an issue or discussion runs only when the edit adds a mention that was not there before. Manual **Run workflow** takes `surface`, `number` and `request`.

## Trust boundary

| Job | Token and role |
| --- | --- |
| prepare | Read-only token. Routes, authorizes, captures the target SHA, builds the prompt and uploads it as an immutable artifact. No model credentials. |
| execute | `contents: read`, no persisted checkout credentials, and a CLI environment stripped of GitHub tokens. Only the run step gets the selected agent's credential, and that session runs no checkout command (below). Produces an untrusted reply, status and patch; a reply or patch with a credential-shaped value, a binary change or a protected path is refused, and only a successful collection is uploaded. |
| publish | Fresh runner with trusted scripts. Rechecks authorization, validates bounded results and the patch, pushes a new `agent/<agent>/<run>-<attempt>` branch and opens a **draft PR** against the PR's head branch or the base branch, then posts the reply. Never pushes to existing branches, force-pushes, approves or merges. |

The publisher rejects patches over 2 MB or 100 files, path traversal, Git metadata, `.github/`, local credential and state files, binary changes, added credential-shaped values (private keys, GitHub tokens, provider keys, OAuth token fields), symlinks and submodules, and a reply carrying such a value. A push made with the Actions token does not trigger the usual `pull_request` CI; run it manually on the draft. This narrows the publication surface; it does not replace review.

The session that holds the agent credential never executes checkout code. Anything the CLI spawns runs as the same user and could read the credential from the CLI's environment, its process entry or Codex's `auth.json`, and permission to change a test is not permission to read the operator's login. So Claude gets `Read`, `Glob` and `Grep`, plus `Edit` and `Write` on writable requests, with no shell, web or subagent tool and no reads under `/proc`. Codex cannot work without running commands, so it is never writable: it answers in its read-only, network-less sandbox. Installs and tests are the separated step: they run on the draft PR, under the repository's own CI, after a maintainer starts it.

Residual: Codex's read-only commands can still read its credential, and only the credential-shape check stands between them and the reply. Use a dedicated, revocable Codex credential, or turn Codex off with `CODEX_ACTION_ENABLED=false`.

## How the workflow finds its own scripts

Inside a called workflow, `github.workflow_ref` and `github.workflow_sha` describe the **caller's** workflow, and the caller's checkout does not contain these scripts. Each job therefore checks out `job.workflow_repository` at `job.workflow_sha`, which GitHub documents as the repository and commit of the workflow file that defines the current job. The scripts are always the exact commit the caller's `@v0` (or `@<sha>`) resolved to, with no second ref to keep in sync. An explicit `tools_ref` input was rejected because it can drift from the workflow version and lets a caller run scripts from an unreviewed ref.

These properties need a current hosted runner and are not available on GitHub Enterprise Server; the prepare job fails with an explanation when they are empty. actionlint 1.7.12 does not know them yet; run it with `-ignore 'property "workflow_(repository|sha)" is not defined'`.

`@v0` is a moving major tag. Pin a full commit SHA instead when the consumer must review every update; the scripts follow the pin automatically.

## Opting into PR title and description mentions

The templates do not subscribe to pull request events, because each subscribed event leaves a skipped check on every PR opened or edited without a mention. To answer mentions in a PR title or description, add this to the caller's `on:`:

```yaml
  pull_request_target: { types: [opened, edited] }
```

Use `pull_request_target`, not `pull_request`: fork PRs get neither secrets nor a write token under `pull_request`. The pipeline never runs PR code with a write token and still authorizes the event's sender, so a fork PR stays read-only. Turn it off again with `<AGENT>_ACTION_PULL_REQUEST=false` or by removing the trigger.

## Versions

Python 3.12.12, pnpm 11.25.0, Claude Code 2.1.302 and Codex CLI 0.154.0 are pinned, and actions are pinned by commit SHA. To upgrade a CLI, change `cli/package.json`, regenerate `cli/pnpm-lock.yaml` with `pnpm install --lockfile-only`, update the version assertions in `ask-agent.yml`, and rerun the tests.

## Tests

```sh
python3 -m unittest discover -s scripts/github-agent/tests
```

They cover parsing, routing, configuration, branch selection, prompts, CLI arguments, credential stripping, timeouts, artifact and patch validation against a real Git repository, and reply composition, all with mocked GitHub calls. They do not prove that an authenticated agent run or a live GitHub Actions run succeeds.
