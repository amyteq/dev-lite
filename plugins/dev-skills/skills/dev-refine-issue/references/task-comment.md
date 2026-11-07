# Standalone task comment

This comment is a complete handoff that links the canonical contract; the issue region only summarises it. It must not promote informal decisions or override the current authorization. Cite each owner requirement's canonical source and label each engineering suggestion as a suggestion, which the executor may replace with another way of meeting the same requirement. Follow [the skill](../SKILL.md) for target checks, current-revision selection, first publication, dispatch state and recovery.

Use a stable first-line marker. A new task begins at revision 1; replacing a dispatched contract creates the next revision only after the active execution and canonical amendment gates are resolved. Updating an undispatched draft keeps its revision. The operative AC block between `<!-- acs:begin -->` and `<!-- acs:end -->` is byte-identical to the issue region's; keep each marker on its own line and write no other copy of either marker line.

````markdown
<!-- dev-refine-issue:task repo=<owner>/<repo> issue=<n> revision=<r> -->
## Task — <bounded deliverable>

**Repository:** `<owner>/<repo>` · **Issue:** [#N](<issue-url>) · **Owner/reviewer:** <observed identities> · **Revision:** <r>

<Prepared and not dispatched, or factual dispatch state with evidence.>

### Goal

<Observable outcome, destination and completion artifact.>

### Read first

- AGENTS.md and CLAUDE.md, then the documentation of the affected component.
- <Current approved task, decisions, dependencies and linked primary evidence; say what each settles.>
- <Applicable issue/PR templates and validation instructions.>

### Scope and deliverables

<Exact write boundary, deliverables and non-goals. Base branch and relevant frozen identities; distinguish an exact source identity from a requirement to re-read live state at execution. For a checker or decision function: its important invariants, supported cases and stop behavior.>

### Implementation instructions

1. Retrieve this task and verify the issue still points to this revision; reconcile any disagreement before acting.
2. Confirm current authorization, canonical contract, readiness/dependencies and allowed actions. A task comment alone does not satisfy these prerequisites.
3. Establish a clean dedicated worktree at the approved base and record base/HEAD. Preserve unrelated work.
4. <Ordered implementation steps for the single bounded outcome.>
5. Validate against the exact resulting HEAD and deliver only through the authorized route. Human merge remains separate where policy requires it.

### Acceptance criteria

<!-- acs:begin -->
<The operative stable AC IDs and text from the issue/canonical contract, each a closed case list with observable evidence per case. If they disagree, stop and reconcile; do not choose whichever is easier.>
<!-- acs:end -->

### Validation and evidence

<How each AC is checked; focused commands, checks required by repository instructions, evidence for every AC and explicit live/offline limits. Label suggested sample inputs as suggestions. Unknown/skipped/failed checks are never PASS.>

### Authorization and boundaries

<The actual authorizing request and its scope. State separately whether edits, commits, branch push, PR creation and comments are permitted. Name protected actions and human gates. Refinement itself does not dispatch this task.>

### Stop conditions and closeout

- Success: <observable acceptance and completion artifact>.
- Blocked: a named decision, stale identity, dependency, permission, capability, required evidence or conflicting edit prevents the next step. Preserve progress and report the concrete unblock action.
- Cancellation/budget: stop within the stated bound and preserve a usable continuation point.

Closeout: exact base/final HEAD and branch, deliverable links, AC/evidence mapping, changed paths, command outcomes and skipped reasons, independent review identity, unresolved findings and remaining human gates.
````

## Select, publish and read back

Use literal files or structured connector arguments. Never interpolate issue/comment text into shell commands. Examples use placeholders only for documentation; substitute verified values before execution. Save the issue body with `jq -j '.body // ""'` so no newline is added, and set `scanComplete` to `true` only when the paginated comments command exited `0`:

```bash
gh api repos/<owner>/<repo>/issues/<n> > issue.json && jq -j '.body // ""' issue.json > issue-body.md
gh api repos/<owner>/<repo>/issues/<n>/comments --paginate --jq '.[] | {id, author: .user.login, body}' > comments.jsonl
jq -n --arg repo <owner>/<repo> --argjson issue <n> --arg login "$(gh api user --jq .login)" --argjson scanComplete true \
  --rawfile issueBody issue-body.md --slurpfile comments comments.jsonl \
  '{$repo, $issue, $login, $scanComplete, $issueBody, $comments}' > select.json
node "${CLAUDE_SKILL_DIR}/scripts/check-refinement.mjs" select --input select.json
```

`select` reads the `**Current task:**` pointer only from a visible line in the `## Execution` section, from that heading to the next depth 1 or 2 heading, inside the skill's own `<!-- AUTO:BEGIN -->` region, where the issue template writes it; a copy in another section, in human-owned prose, a code fence or a longer HTML comment is not the live pointer; a region without that heading carries none, which is the no-pointer state; and a body whose AUTO regions are malformed, duplicated or another generator's, or that repeats the heading, stops because the pointer cannot be located at all. It prints one JSON decision: `use-current` with `commentId` and `revision`, `publish-revision-1`, or `stop` with `reason: "ambiguous"` and the `commentIds` to report. Each also lists `foreign` markers by other logins, which are never adopted. It exits `0` to proceed, `1` to stop and `2` on any missing, mistyped or unknown key.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/check-refinement.mjs" acs --issue-body region.md --task task-comment.md
node "${CLAUDE_SKILL_DIR}/scripts/check-refinement.mjs" outgoing --body task-comment.md --repo <owner>/<repo> --issue <n> --revision <r>
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-publication.mjs" --body-file task-comment.md
gh issue comment <n> --repo <owner>/<repo> --body-file task-comment.md
gh api repos/<owner>/<repo>/issues/comments/<id> --jq '{id, html_url, updated_at, body}'
```

`outgoing` checks only that the first line is the exact marker for this repository, issue and revision; whether each section is complete is reviewer judgment. Only a proven undispatched draft is updated in place, with `gh api repos/<owner>/<repo>/issues/comments/<id> -X PATCH -F body=@task-comment.md` after the same three checks. Every non-zero exit blocks the write that follows; re-run the checks whenever the file changes before it. For an uncertain write, re-run `select` rather than retrying. Reuse a successfully created comment if only the issue update failed.

## Revisions and dispatch

A dispatched task comment is never edited in place. When the contract changes, and only after any active execution has stopped and the canonical amendment is authorized:

1. Publish revision `r + 1` as a new comment whose marker names the new revision and whose body links the predecessor.
2. Post an ordinary comment, without a marker, that links the predecessor forward to the successor.
3. Repoint the generated region's `**Current task:**` line to the successor and require explicit redispatch.

A note or dispatch record that changes no contract goes in an ordinary comment without a marker; its first line must not contain `dev-refine-issue:task`. Record only an observed date, actor and evidence. Unknown dispatch state is treated as dispatched. A human edit survives reconciliation even when its author shares the coordinator's GitHub account.

Use soft-wrapped English operational text. Leave a blank line before thematic `---` separators. Return both goal and plain-language launch prompts using the real read-back permalink, with identical scope, finish line and stop conditions. Blocked tasks' prompts remain visibly non-dispatchable.
