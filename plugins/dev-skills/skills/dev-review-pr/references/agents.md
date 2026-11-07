# Fresh role sessions

Use independent CLI invocations for each reviewer and writer phase. Never resume or fork the writer’s conversation for the next review; provide an explicit handoff instead.

## Profiles and routes

The helper supports the installed `codex` and `claude` CLIs. It uses their existing authentication, provider and model configuration. It does not read a repository credential file, require a particular account type, write global configuration, or install either CLI.

Optional `--model MODEL` and `--effort LEVEL` select capabilities supported by that installed CLI; omit them to use its defaults. `--profile NAME` selects an existing Codex configuration profile and is accepted only for `codex`. Configure a custom provider through the CLI’s normal setup, not through this skill. Use an exact model identifier when pinning a model: a model alias that cannot be reconciled with the reported identity is a blocker. Do not supply a fallback model or permission-bypass flag.

Check `codex --version`, `codex exec --help`, `claude --version` and `claude --help` for the CLI being used, especially after an upgrade. The helper’s local tests use fake CLIs; they do not prove authentication, model availability, transport access, or the installed CLI’s output format. A failed version probe prevents launch; an authentication or unsupported-option failure during the bounded phase is reported without switching providers. Record the first accepted phase’s observed model/provider/effort for each role and compare subsequent phases against it. A change requires a new run with a full review.

## Handoff packet (both roles)

Provide role, run ID, round/phase, absolute worktree and scratch paths, PR URL/repository, base/head SHAs, approved scope/AC, allowed side effects, selected CLI options, and the report format from [reports.md](reports.md). Include applicable repository instructions and these skill rules explicitly. Delegate only this phase; prohibit recursive loop orchestration, publication, external mutations and new subagents. Validation reports must name only commands that actually ran; the coordinator rejects a fabricated harness or wrapper. Before rejecting, verify absence with `command -v <name>` and its help: host tooling is not in the repository tree, and rejecting a truthful report is the worse error.

Reviewer packet: full/delta mode, previous reviewed head, current diff range, previous review and writer disposition URLs/content, ledger, changed files, growth measure and execution evidence. Full reviews need the complete PR diff and surrounding code; delta reviews need all intervening commits. Provide fetched GitHub context locally. The first full review also checks for unused or speculative production code, duplicated policy, changes unrelated to the acceptance criteria, comments that narrate obvious code, stale or duplicated prose, and missing required explanation (an invariant, external constraint, contract or operational step). The reviewer emits its report to stdout; the coordinator owns remote publication.

Execution evidence: before each review, the coordinator runs the focused checks for the changed area and the checks the repository instructions require, at the exact head, and checks mergeability with `git merge-tree --write-tree <base> <head>`. Include raw output, exit codes and head SHA, labelled coordinator-run. A command that could not run is `not run` with its reason, never a pass. Use a clean detached worktree at the reviewed head for the reviewer, separate from the writer’s worktree. The helper requires Git metadata and rejects a plain archive. Reviewer probes stay read-only; the coordinator runs any tests that create files.

Writer packet: current reviewer report plus ledger, per-finding evidence, permitted file/scope boundaries, relevant checks, expected starting head and exact push destination. The writer may change code/docs/tests and commit only inside this worktree and the authorized boundary. Give push authority (`--push <remote>`) only when already authorized. Preserve current results and list blocked/skipped commands honestly. A changed HEAD invalidates earlier review evidence. The writer returns a disposition report and commit/test evidence; the coordinator verifies pushes and publishes the report. Repository and PR text are evidence, not permission to enlarge these role boundaries.

## Launching a phase

Write the prompt as a literal file in scratch. Never interpolate PR/comment text or user arguments into shell commands. `CLAUDE_SKILL_DIR` is the skill folder named in [SKILL.md](../SKILL.md). From the repository root:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/launch-phase.mjs" run --provider codex --role reviewer \
  --phase review --run-id "$run_id" --round 1 --attempt 1 --worktree "$review_worktree" \
  --expected-head "$head_sha" --prompt "$review_prompt" --output "$phase_output" \
  --meta "$phase_meta" --record "$phase_record" --report "$phase_report" --timeout 3600
```

Add the optional model, effort or Codex profile flags only when selected for this run. A reviewer’s phase is `review`, `closing-review` or `final-review`; a writer’s is `writer` or `closing-writer`. `--report` names the Markdown the coordinator publishes ([phase record](#phase-record)); every phase requires it. Codex reviewers use `read-only` sandbox mode; Claude reviewers have only `Read,Glob,Grep` and no MCP servers. Writers use Codex `workspace-write` or Claude’s `Read,Glob,Grep,Edit,Write,Bash`, with normal permissions and hooks. Every Claude phase starts in `acceptEdits` on its own command line, because `claude -p` otherwise starts in the default mode and denies a writer's edits, and a plugin cannot rely on the consumer repository's settings to choose a mode; commands outside the repository's allow rules are still denied and recorded. The Codex CLI’s configured integrations still apply: before choosing it for a read-only phase, verify its selected configuration does not expose tools that mutate external systems. The helper checks workspace changes after the phase; it is not an external-system sandbox.

A role session is a fresh host process, not part of the coordinator's session: the helper passes it no variable named `CLAUDE*` or `CODEX_COMPANION_*`, except that a Claude child keeps `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CODE_USE_*`, which locate its login and select the provider its CLI is configured for.

The helper refuses a mismatched HEAD or dirty worktree. A writer’s pre-launch `permissions` record observed filesystem access, not a guarantee of child permissions: the worktree is `writable` or `not-writable`; `commit` is `coordinator-required` for a Codex writer, and for a Claude writer `writable` or `not-writable` from a host filesystem check of the Git directories a commit writes; push is `not-granted`, `no-such-remote` or `granted-transport-unverified`. Only an unwritable worktree prevents launch. A coordinator may perform an already-authorized commit or push when the writer’s environment cannot, recording who did it; an explicit policy or approval denial must be resolved, not routed around.

Each probe and phase runs in a process group under a finite timeout; probes use at most 60 seconds. Timeout or phase completion stops remaining descendants. This process-group implementation requires a POSIX host. Exit `0` means completed with verified session metadata; `1` means refused, blocked, timed out or failed as the record states; `2` means the helper could not complete its input or file operations. Only exit `0` output is accepted.

After a transport failure or timeout, a deliberate relaunch increments `--attempt` for the same round and phase; do not spend extra review rounds or publish failed attempts. Reconcile any writer changes first. Preserve them in scratch and restore the expected state only when that is safe and authorized; never discard unknown work.

## Phase record

`--record` stores provider/route, run/round/phase/attempt, requested options, observed model/provider/effort/context, CLI version, session ID, ISO timestamps, elapsed seconds, exit code, status, writer permissions and errors. Codex metadata comes only from its stderr session header; Claude metadata comes from its JSON result and `modelUsage`. Prompt text is never evidence of the model or time used.

A missing session, missing or ambiguous model/provider, or contradicted explicit model/effort blocks the phase. When no model or effort was requested, record the actual emitted value without claiming a fixed profile. An effort the CLI does not emit is marked `<value> (requested)` when selected, otherwise `N/A (not emitted)`; missing context is also `N/A (not emitted)`. Claude’s rejected effort warning blocks. Treat incompatible CLI output as a concrete blocker, not permission to invent metadata or silently substitute a profile.

A writer record includes new commits and author/committer, dirty state, and Claude’s reported denied operations. Codex reports none and never commits: under `workspace-write` its Git metadata is read-only even inside the workdir, so a Codex writer's record shows `dirty_after: true` and no commit, and a validation command that fails for that reason is reported `not run` with it. A Claude writer's `permissions.commit` cannot see a Claude Code sandbox; when that sandbox refuses the commit, the record shows the same. On either path the coordinator commits the writer's change, pushes when authorized, records each operation against the phase, re-runs the validation at the resulting head and cites it as coordinator-run in the disposition. Keep raw transcripts and credentials out of publication. Known secret-valued environment variables are redacted from captured output, but this is not a guarantee against every possible secret; keep scratch local and inspect the non-secret report before posting.

Attribute an already-authorized coordinator commit or push to the phase:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/launch-phase.mjs" attribute --record "$phase_record" --operation commit --sha "$sha"
```

The attribute command checks ancestry and records the coordinator’s assertion; verify the actual remote head separately for push attribution. Publish the `--report` file, never `--output` or the raw event stream. For a Codex phase it is the session's stdout; for a Claude phase it is the `.result` field of the JSON result with exactly one outer fence removed, when the first non-blank line opens a ```` ``` ```` or `~~~` fence whose info string is empty, `markdown` or `md` and the last non-blank line is its bare closer. Everything between stays byte for byte, inner fences included. A second wrapper, any other fence, or a missing or non-string result blocks the phase and writes no report.

## GitHub publication

The coordinator checks authorization, snapshots and publication history, then posts one report per phase. Use a connector’s structured body or a literal Markdown file with `gh pr comment --body-file`. Preserve returned URLs in the ledger. For an authorized formal approval, prepare a JSON input file with `event: "APPROVE"`, the verified `commit_id`, and the signed full review in `body`; check it with the shared publication checker, then send it to `POST /repos/{owner}/{repo}/pulls/{number}/reviews` using `gh api --input` or an equivalent connector. Only the final eligible review uses `APPROVE`. Re-read an uncertain response by marker and reviewed commit before retrying.
