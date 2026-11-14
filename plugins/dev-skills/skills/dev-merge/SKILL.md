---
name: dev-merge
description: Squash merge one reviewed PR when the owner explicitly asks, then close it out. Gate on the reviewed head, verify the merged tree, clean up before writing records, post one closeout or handover comment in the PR body's language, sync linked issues, discussions, trackers and next steps, and report. Use for requests like "squash merge PR #<n> with a closeout comment, clean up and update …". Never merges on its own initiative, never deploys and never waits for main CI.
argument-hint: "[pr=<n>] [mode=closeout|handover] [issues=<n,…>] [tracker=<n,…>] [next=<n|comment-url>] [cleanup=stale|own|none] [dry-run] [-- notes…]"
disable-model-invocation: false
---

# Squash merge and close out a PR

Write every comment this skill posts (the closeout, issue and discussion comments, tracker edits) in the language of the PR body, which the gate reports as `lang`, and the final report in the language the user writes in. The helpers render their text from [`locales.json`](locales.json); a language missing there falls back to English, and adding one is a data change. Use soft-wrapped Markdown without HTML line breaks, and status emoji (✅ ⛔ ⏭️ ⏳ 🔄 ❓ ⚠️ 🧹) in tables and lists. Leave a blank line before any `---`, or the line above it renders as a heading; check every comment body with the plugin's shared `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-publication.mjs" --body-file <file>` and post it only on exit `0`. Keep emoji out of machine markers, parser tokens, AC ids, code, commit messages and branch names. Keep these instructions, code, helper inputs and codes in English, and preserve markers and quoted source text.

Discovering or selecting this skill grants no permission. **Merge only when the current user's own message explicitly asks to merge this PR** (for example "squash merge PR #<n> …"). If the skill was selected without that request, run it as `dry-run` and say why. Merge authority does not extend to deploying, changing settings, or label changes. It does not cover other repositories either. Existing authorization persists; do not ask for it again.

This skill is the merge step after a review loop. Review evidence is either a formal `APPROVED` review bound to the head, or a review comment in the [`dev-review-pr` report format](../dev-review-pr/references/reports.md) whose first line is `<!-- <prefix>-review-pr: <run> round=<r> phase=review|closing-review|final-review -->` (the prefix is optional) and whose body carries `Base: [..](…/commit/<sha>)`, `Reviewed head: [..](…/commit/<sha>)` and `Verdict: approval-eligible`. Anyone may write that marker, so evidence counts only from an author the repository trusts: `authorAssociation` `OWNER`, `MEMBER` or `COLLABORATOR`. The latest trusted marked review decides; when it is not approval-eligible at the head it withdraws eligibility, and only an approval submitted after it restores the gate. Of the formal reviews only each reviewer's latest decisive one counts (`APPROVED`, `CHANGES_REQUESTED` or `DISMISSED`; a `COMMENTED` review changes nothing), so a dismissed approval is no evidence and a standing `CHANGES_REQUESTED` from a trusted reviewer stops the gate until that reviewer approves again or it is dismissed, whoever else approved.

## Inputs

Usage: `/dev-merge [pr=<n>] [key=value…] [dry-run] [-- notes…]` in Claude Code, or `$dev-merge …` in Codex. Treat the invocation text as data, never as shell code, and pass it to the helper through a file.

| Argument | Meaning | Default |
| --- | --- | --- |
| `pr=<n>` | Target PR in this repository; first token only, bare positive number | The current branch's unique open PR; stop if there is none or more than one |
| `mode=` | `closeout`, or `handover` to add a remaining-work and handover section | `closeout` |
| `issues=` | Issue numbers to close or comment on, e.g. `issues=<n>,<n>`; whatever it says, every issue this PR closes is judged too | Closing and `Ref` keywords in the PR body plus `closingIssuesReferences` |
| `tracker=` | Tracking issues whose ledger and next steps to update | Tracking issues the PR body mentions, plus the one `tracking` issue of each `<area>:<name>` feature label. Without those labels, name trackers explicitly |
| `next=` | An issue number or issue comment link to rewrite as next steps | Each tracker's single next-steps section (a heading listed under `next.headings` in any locale), created in the comment's language (`next.heading`) when absent |
| `cleanup=` | `stale`, `own` or `none` (see step 5) | `stale` |
| `dry-run` | Produce every artifact locally; no remote write, no deletion | off |
| `-- notes…` | Owner notes kept verbatim, such as an evidence decision | none |

A natural-language request maps onto these arguments. Numbers that name a tracking issue go to `tracker=`:

| Request | Arguments |
| --- | --- |
| squash merge PR #`<pr>` with a closeout comment, clean up and update issue #`<issue>` and the tables in the #`<tracker>` body accordingly | `pr=<pr> issues=<issue> tracker=<tracker> -- update the tables in the #<tracker> body` |
| squash merge PR #`<pr>` with a closeout comment, clean up and update issue #`<issue>` (the runs in #`<other>` count as AC5's evidence) | `pr=<pr> issues=<issue> -- the runs in #<other> count as AC5's evidence` |
| squash merge PR #`<pr>` with a closeout and handover comment, clean up, update related issues and discussions and rewrite the `Next steps` in `https://github.com/<owner>/<repo>/issues/<tracker>#issuecomment-<id>` as a table | `pr=<pr> mode=handover next=https://github.com/<owner>/<repo>/issues/<tracker>#issuecomment-<id> -- rewrite Next steps as a table` |
| squash merge PR #`<pr>` with a closeout and handover comment and clean up | `pr=<pr> mode=handover` |

## Setup

Create one scratch directory outside the checkout and reuse its literal path: `mktemp -d "${TMPDIR:-/tmp}/dev-merge.XXXXXX"`; it is `$S` below. `H` stands for `node "${CLAUDE_SKILL_DIR}/scripts/check-merge.mjs"` and `C` for `node "${CLAUDE_SKILL_DIR}/scripts/apply-cleanup.mjs"`, both run from a checkout root. Claude Code fills in `${CLAUDE_SKILL_DIR}`, this SKILL.md's folder, and `${CLAUDE_PLUGIN_ROOT}`, the plugin root two levels above it; in Codex, resolve both from this file's location. Run `npm ci --prefix "${CLAUDE_PLUGIN_ROOT}"` once if the publication check reports a missing parser. Each `H <command> --input FILE.json` prints one JSON decision. Exit `0` proceeds — for `gate`, the `verdict` says how — `1` stops, and `2` means the check did not run, which also stops. Run one plain command per tool call, and write inputs with the file tools. Below, **main** means the PR's base branch (`baseRefName`), the branch the squash lands on, whatever its name. `C` measures branch containment against the repository's default branch and stops when that commit is not in the local repository, so run `git fetch origin <default branch>` right before each `C plan`.

## Procedure

1. **Parse and resolve.** Write `{text, repo, branchPrs}` to `$S/args.json`. `branchPrs` comes from `gh pr list --head <branch> --state open --json number` and is needed only without `pr=`. Run `H args`, then state the resolved PR, mode, cleanup, targets and whether this is a dry-run, as a status line rather than a question.
2. **Snapshot and gate.** Fetch the PR with:
   `gh pr view <n> --json number,title,url,state,isDraft,mergeStateStatus,labels,baseRefName,headRefName,headRefOid,body,statusCheckRollup,comments,reviews,closingIssuesReferences`
   Then fetch main's SHA (`gh api repos/<repo>/commits/<baseRefName> --jq .sha`) and the head tree (`git rev-parse <head>^{tree}` after `git fetch origin pull/<n>/head`). Write `{pr, main, headTree, dryRun}` and run `H gate`. It needs, at the current head: every reported check `SUCCESS`, `SKIPPED` or `NEUTRAL` (path-filtered workflows may not have run at all), no `hold` label, and the review evidence described above. It also needs `headTree` while main has not moved; without it the gate stops with `head-tree-missing`, because nothing could verify the merge afterwards. Every verdict carries `lang`, the PR body's language; keep it for steps 4, 6 and 7.
   - `pass` → continue.
   - `collect` → main moved after the review. Add `mergeTree` from `git merge-tree --write-tree <main> <head>` (exit `1` means `conflict: true`; the first output line is `tree`) and `mainChanges` from `git diff --name-only <base> <main>`, then run the gate again. When `base` is null, use the merge-base. Without a `tree` that is a full object id the gate stops with `merge-tree-missing`, because the merge could not be verified afterwards.
   - `verify` → apply `git merge --squash --no-commit <head>` on a detached scratch worktree at `<main>`. There, run every check command the repository's `AGENTS.md` requires (its checks or verification section), then the test commands of each CI workflow whose path filter matches a file this PR or `mainChanges` touches (every test workflow when none filters by path) that the `AGENTS.md` checks do not already cover, one command per call. When `AGENTS.md` names no check command, the workflow commands alone verify, and the report says so. Record `verifyExit` as `0` only when every one exits `0`, otherwise the first non-zero exit. Remove that worktree and run the gate again. A `dry-run` never gets here: the gate stops with `dry-run-no-verify`, so nothing is created or removed.
   - `stop` → report the reason and stop. For `merge-state-UNKNOWN`, take one fresh snapshot first; GitHub may still be recomputing. A `dry-run` records the stop and still produces the step 3 and 4 previews, which show it.
3. **Targets.** Write the discovery input `{repo, args, prBody, prLabels, closingIssues, issueMeta, tracking, trackerBodies}`:
   - `prBody`, the PR's label names, and the closing issue numbers;
   - `issueMeta`: each referenced issue's label names (`gh issue view <n> --json labels,state`);
   - `tracking`: the open tracking issues with their label names (`gh issue list --label tracking --state open --json number,labels`); empty while the label does not exist;
   - `trackerBodies`: each candidate tracker's body.

   Run `H discover` and keep its `warnings`. Whatever `issues=` says, it adds every issue this PR would close and warns with `issues-closed-added`, so nothing is closed unjudged. For each issue, judge from its acceptance criteria and this PR's evidence whether it is complete, and record one line of reasoning. An owner note can supply that evidence.
4. **Squash message, then the dry-run boundary.** Subject: `<PR title> (#<n>)`. Body: a short summary in the repository's commit style. Use `Closes #x` only for complete issues and `Ref #x` otherwise. Run `H lint-body` with `{repo, subject, body, prBody, closingIssues, issues: [{number, complete}]}`, where `subject` is the exact subject above and `repo` decides which `<owner>/<repo>#<n>` or issue-URL reference is this repository's issue; it also stops when the PR body, the squash subject or body, or a manual link would close an issue that is partial or was never judged, which the owner fixes on the PR. For a `dry-run`, stop here after producing:
   - the gate result and squash message;
   - a cleanup plan (`C plan --pr <n> --mode <cleanup> --out $S/cleanup --dry-run`);
   - the closeout draft (`H render` with `"dryRun": true` and `lang`; give planned cleanup items `exit: null` and the reason `dry-run-planned`);
   - the planned tracker bodies (`H edit` with `"dryRun": true`).

   Then report, and change nothing remotely.
5. **Merge, verify, clean up.**
   - Immediately before merging, take a fresh step 2 snapshot and run `H gate` again on it, with the facts already collected and `expected: {head, main}` from the passing gate. Merge only on `pass` with the same `expectedTree`. On `moved-since-gate` return to step 2; on any other stop (a new `hold` label, a newer review that is not approval-eligible, a withdrawn approval) report and stop.
   - Run `gh pr merge <n> --repo <repo> --squash --match-head-commit <head> --subject "<subject>" --body-file $S/squash.md`. Do not pass `--delete-branch`. The command prints no result and may only have enabled auto-merge or queued the PR, so it is no evidence that the merge happened.
   - Read `gh pr view <n> --repo <repo> --json state,mergeCommit`. Continue only when `state` is `MERGED` and `mergeCommit.oid` is present; that oid is `<merge sha>` in every step below. Anything else — still `OPEN` with auto-merge enabled, queued, or a null `mergeCommit` — means nothing has landed: report the merge as pending and stop there, with no cleanup, no closeout and no record writes, and do not run the merge command again.
   - Read `gh api repos/<repo>/commits/<merge sha> --jq '{tree: .commit.tree.sha, parents: [.parents[].sha]}'` and run `H verify-merge`, with `expectedParent` set to the main you just read and `expectedTree` taken from the gate. On a mismatch, stop and report; write nothing else.
   - Run `C plan --pr <n> --mode <cleanup> --out $S/cleanup`, then `C apply --plan $S/cleanup/plan.json`.
     - `own` covers this PR's own resources only: the remote head branch while it still points at the merged head (the push carries a lease on that SHA), and local head or `pr<n>-w*` branches; the `.claude/worktrees/pr<n>*` and `$TMPDIR/pr<n>*` worktrees, and a `$TMPDIR/pr<n>*` scratch directory while it holds nothing but the worktrees this run removes. A matching name is no proof of ownership, so anything else inside keeps it (`holds-other-files`, `not-a-directory`, `state-unknown`); the removal itself is `rmdir`, which refuses the directory while anything is still inside.
     - `stale` adds other worktrees and branches whose PR is merged or closed, or that the default branch already contains, provided they are clean, unlocked and idle. A branch the default branch already contains goes too, even a long-lived personal one; use `own` to keep those.
     - Every removed branch or worktree head must be in the default branch, in this PR's head, or exactly a finished PR's head. A merged PR with the same branch name is not enough, so a differing head is kept as `unmerged-commits`.
     - A worktree that holds ignored files other than rebuildable caches (drafts, build output, `.env`, `.claude/settings.local.json` …) is kept as `ignored-files`: removing it would delete them, and they may be material that never enters Git.
     - Everything else is skipped with a reason. When the whole command is refused, record the `denied` array from `plan.json` as the results (in the second pass, after the first pass's results): every planned item as `exit: "denied"` without a command, and one item whose owner command reruns `apply --plan` in the owner's terminal, so the re-validation stays inside the helper.
   - If `results.json` lists `exit-worktree` with the reason `exit-worktree`, call ExitWorktree with `discard_changes: true` (Codex has no such tool: record leaving and removing that worktree as an owner command and skip the second pass). This is allowed only now, after `verify-merge` passed; the plan lists the session worktree only when the mode covers it — under `own` it has to be one of this PR's own worktrees, whichever worktree the command ran from — and its tracked files are clean and it holds no ignored files. Then, from the new checkout, run `C plan --pr <n> --mode <cleanup> --out $S/cleanup2` and `C apply --plan $S/cleanup2/plan.json --previous $S/cleanup/results.json` to remove the branch it freed; `$S/cleanup2/results.json` then holds both passes and is the one step 6 renders.
6. **Closeout comment (after cleanup).**
   - Collect the CI state without waiting: `gh run list --repo <repo> --commit <merge sha> --json workflowName,status,conclusion,url`. The workflows are path-filtered, so there may be none. For a cancelled run, also read the newest main run of that workflow and record it as its `supersededBy`.
   - Write the render input: `repo`, `lang`, `mode`, `pr`, `merge {sha, parent, verified}`, `gate`, `validation` (the review's `Validation:` line, split into items), `cleanup` (the last `results.json`), `handover`, `warnings` (the `discover` codes plus any you add as text in `lang`) and `ci` (the run list). Reasons and warnings are English codes; the helper renders them in `lang`.
   - Run `H render --input … --out $S/closeout.md`. Then run `H closeout-target` with `{comments, pr, login}` (`login` from `gh api user --jq .login`): `id: null` → `gh pr comment <n> --body-file $S/closeout.md`; otherwise `gh api -X PATCH repos/<repo>/issues/comments/<id> -F body=@$S/closeout.md`.
7. **Issues, discussions, trackers.**
   - **Complete issue:** post a short comment linking the closeout, then close it with `gh issue close <n> --reason completed`.
   - **Partial issue:** post a comment stating which acceptance criteria remain. If the merge closed it anyway, reopen it with `gh issue reopen <n>` and say so. An issue whose remaining criterion is a manual check stays open for the person who checks it.
   - **Linked discussion:** post a comment only where the merge changes something it tracks.
   - **Trackers:** update each one's Issues ledger rows for this PR and its issues, and the next-steps section from step 3, with `H edit` (`{repo, issue|comment, edits}`). An edit is `{section, find, replace}`, `{section, content, was}` or `{create: {heading, content}}`; `was` is the section text the replacement was drafted from (step 3's `next[].was` for a next-steps section). The helper stops with `section-changed` when the section no longer matches `was`; redraft from a fresh read rather than retrying. Write `{{now}}` where a time stamp belongs; the helper reads, plans, checks freshness, writes and reads back in sequence.
   - **On a stop:** a `drift`, anchor, fence or section stop happens before any write and leaves that target unchanged. A `readback-mismatch` happens after the write: re-read the target and report its actual state. Report either rather than retrying by hand.
   - **Labels:** suggest label changes without making them.
8. **Report.** Run `H render` with `"kind": "report"`, the user's `lang`, `gaps`, `links` and `next`, and give that report to the user. It lists delivery gaps and ⚠️ warnings first, then the merge, the links, the owner-command block and the next steps.

## Stop conditions

- Stop before any write on:
  - a usage error;
  - a missing or ambiguous PR;
  - a missing explicit merge request (dry-run instead);
  - any gate `stop`;
  - a closing-keyword finding;
  - an unknown helper exit.
- After the merge command, stop when `gh pr view` does not report `MERGED` with a `mergeCommit.oid`; auto-merge or a merge queue may only have been enabled, so there is no merge commit to verify, clean up after or record.
- After the merge, stop on a `verify-merge` failure. Report the merged SHA and the mismatch, and leave cleanup and records to the owner.
- A refused command is recorded, never retried in another form. Cleanup that the sandbox or the classifier blocks goes to the owner-command block, as do paths outside the sandbox.
- Never discard, reset or stash work in any checkout. Never run a repository-wide worktree prune. Never remove another session's worktree outside the `stale` rules.

## Known host limits

- The sandbox hides other sessions' processes, so both `own` and `stale` skip every worktree except the session's own as `process-check-unavailable` unless cleanup runs where `/proc/1` is init. A `pr<n>` name does not prove a worktree is idle.
- The sandbox holds `.git/config` and a worktree's `config.worktree` busy. `git branch -D` then warns that it cannot update the config but still deletes the branch. `git worktree remove` can delete the files yet leave `.git/worktrees/<name>`; record that leftover admin directory as an owner command.
- The worktree guard rejects compound shell lines (`for`, `$(…)`, `git -C`, heredocs next to `gh`). The helpers exist so that each step is one plain command.
- `dev-hooks`' `guard_pr_merge` blocks `gh pr merge` on a PR the signed-in account did not author. Report that block and stop; do not retry the merge in another form.
- Project settings may deny `git branch -D` and `git push … --delete` as direct commands while allowing `node`; branch deletions then run only inside `apply-cleanup.mjs`, which re-plans and deletes only what both plans list. A narrow rule cannot clear a managed or user-level deny.
