# Result comment on a feat tracking issue

When the target issue is a feat's tracking issue, a run posts its full result there in numbered parts, instead of [summary.md](summary.md)'s summary, then hides our earlier results and summaries there as `OUTDATED`. Every other target, discussions included, follows summary.md.

`R`, `V` and `H` below stand for `node "${CLAUDE_SKILL_DIR}/<script>"` with [`result-packet.mjs`](../result-packet.mjs), [`result-render.mjs`](../result-render.mjs) and [`summary-comment.mjs`](../summary-comment.mjs). Run them from the repository root. Exit `0` proceeds, `1` stops and `2` means the check did not run; every non-zero exit blocks the write after it. "Ours" means a comment by the running `gh` login.

## 1. At binding: classify and open the root

Run summary.md §1 first. `no-publish` and `dry-run` are the only tokens; a near miss such as `--dry-run` stops before analysis. Then classify an issue target from the feat docs committed at the baseline, never from labels:

```bash
R classify --issue N --baseline FULL-SHA
```

| Outcome | Next |
|---|---|
| `target: feat`, with its `FT_<k>` key, doc path and status: the feat whose frontmatter `tracking_issue` is `N` | This reference |
| `target: other` | summary.md, unchanged |
| Exit `1`: `malformed-planning-docs` (a feat or story doc the planning index cannot read, as [reconciliation.md](reconciliation.md) R0 lists) | Stop before analysis, naming the path; no remote write |

For a `feat` target, open the root and move `$S`'s files into it; `$S` now means the root:

```bash
R root --run "$(cat $S/started.run)"
```

The root is `$DEV_ANALYSE_RP_ROOT/<run-id>/` when that variable is set, and otherwise `temp/dev-analyse-rp/<run-id>/` under the checkout's top level. The result cites it as the output's `cite`, never an absolute path. Exit `1` means the root cannot be created or written, or sits in the checkout unignored: stop before analysis, naming it, with no tmpfs fallback. Nothing in the root is committed, pushed or uploaded.

When the analysis instructions forbid GitHub changes or say "scratch only", quote the phrase in the packet's Binding section. §4 then asks before any write.

## 2. Whether to post

| Case | Outcome |
|---|---|
| `feat`, no token, verdict `proposal_complete` or `proposal_blocked` | Post the result as parts 1 to m; no summary |
| `feat`, verdict `analysis_stopped` | Post one stop notice, `part=1/1`, that hides nothing |
| `no-publish` | No remote write |
| `dry-run` | No remote write; the payloads and their commands stay in the root (§6) |
| The model selected this skill on its own, without the invoking human's explicit request for it | No remote write unless the invoker answers yes to §4's ask |
| Classification or root stop | No remote write |
| Locked issue, incomplete scan, `select` other than `post`, or a check exiting `1` or `2` | No post, as in summary.md |

## 3. At the verdict: manifest, scan, drift and render

Save the checker's `--json` output as `$S/check.json`, and note `verify-homes`'s exit status. Then:

```bash
R manifest --root $S --run RUN --baseline FULL-SHA --verdict STATE &&
R drift --root $S > $S/drift.json
```

The manifest lists every file the verdict found in the root, with size and sha256; its own sha256 is the packet digest. It is written once: `manifest` refuses to overwrite one, and `render` refuses a listed file whose bytes moved, so fixing a packet needs a new run. `drift` compares the baseline with `HEAD`, commits only: each changed path a write boundary, conflict path or source origin cites, and the planning index rebuilt from `HEAD`'s committed feat and story docs. Exit `1` names the failed step. A stop notice skips `drift`.

Scan as summary.md §3 does for an issue, adding `feat: "FT_<k>"` to the `select` input. `previous` is our latest earlier run's part 1 or summary, minimized or not; a run with neither stops.

Write two files, by file writes:

- **`context.json`:** `repo`, `issue`, `feat`, `run`, `root` (the `cite`), `previous` (`{id, run}` or null), `part1` (null until part 1 is posted), `footer`, and `verifyHomes` (the exit status; null for a stop notice).
  - Build the footer as summary.md §4 does, except that STARTED is UTC: `date -u '+%Y-%m-%d %H:%M UTC'`.
- **`prose.json`:** the only text you write, each entry one line:
  - `summary`: one verdict sentence;
  - `findings`: `{class, text}` entries, where `class` is `verified` or `assumption`;
  - `changed`: what changed since `previous`, or null without one;
  - `not_done`: extra items, which may be an empty list;
  - `stop`: `{reason, missing}` for an `analysis_stopped` verdict, and null otherwise.

```bash
V render --root $S
```

`render` writes `result.full.md` and `result.1.md` to `result.<m>.md`, filling every table, count and id from `proposal.json`, `crosswalk.jsonl`, `check.json`, `drift.json` and the manifest. Its sections, in order:

````markdown
<!-- dev-analyse-rp:result repo=OWNER/REPO issue=N feat=FT_k run=RUN part=i/m -->
## `/dev-analyse-rp` result: `FT_k` on #N        — header table
**Previous result:** link. What changed: [changed]
### Verdict                                       — [summary]; next human action
### Decisions and units without an owner
### Key findings                                  — [findings]
### Existing-home crosswalk
### Story Map and units
### Dependencies
### Proposed amendments and divergences
### Independent review
### Deterministic checks
### Baseline delta
### Evidence limits
### Not done                                      — fixed lines, then [not_done]
---
🧭 footer                                         — last part only
````

A stop notice keeps the header, the previous-result line, the reason, the missing item, the next human action and the evidence limits.

A part is at most 60,000 characters, split only between blocks or table rows; a continued table repeats its header row. Part 1 holds the header, verdict, next action and decisions. Each later part starts with its marker and a link to part 1.

Exit `1` posts nothing, and its `reason` names the problem:

- `block-too-long` names the section;
- `part-1-crowded`;
- `too-many-parts`, for more than 5;
- `absolute-path`.

Fix `prose.json` or `context.json` and render again; a packet fix needs a new run. Exit `2` names the mistyped or missing field.

## 4. The ask, when the invocation forbids GitHub changes

This also applies when the model selected this skill on its own: such a run has no write authority of its own. Before the first write, ask the invoker once. Name the parts you would post and the comments you would hide.

- **Yes:** post as §5 does.
- **No:** no remote write. Leave the payloads as §6 does, and report "not posted: declined".
- **The host cannot ask, or no answer comes:** no remote write. Report "not posted: the invocation forbids GitHub changes".

## 5. Post the parts

`select` must return `post` with `next: 1`. Post each part in order, checking it first:

```bash
H outgoing --body $S/result.I.md --repo OWNER/REPO --issue N --run RUN --baseline FULL-SHA --feat FT_k --part I/M &&
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-publication.mjs" --body-file $S/result.I.md &&
gh api repos/OWNER/REPO/issues/N/comments -X POST -F body=@$S/result.I.md > $S/post.I.json
```

Read each part back by `id` and compare bytes, as summary.md §5 does. Once part 1 reads back equal, set `part1` in `context.json` to its id and render again: part 1 is unchanged, and parts 2 to m now link it. Post no part before the previous one reads back equal.

## 6. Dry run

With `dry-run`, run §3 through every check in §5. Instead of posting, write each exact POST command to `$S/post-commands.txt`. Parts 2 to m keep the placeholder `#issuecomment-PART-1` link. On another target, summary.md's payload and its command stay in scratch.

## 7. Re-runs, uncertain writes and hiding

Our exact results and summaries for this repository and issue form one family:

- **`post` with `next: J+1`:** this run's parts 1 to J are already ours. Read each back. If all are equal, post only parts J+1 to m. `parts` must equal m.
- **`adopt`:** all m parts exist. Read each back.
- **`stop`:** `duplicate-part`, `part-count`, `part-gap`, `mixed-run`, `previous-incomplete`, `incomplete-scan` or `duplicate-comment-id`. Post and hide nothing, and report the ids.
- **A part that differs from its payload:** report it, and post and hide nothing more.

Another login's result or summary goes into `foreign` and is never touched. A first line of ours that contains `dev-analyse-rp:result` or `dev-analyse-rp:summary` without being exact goes into `unrecognised`, and it empties `hide`. A hand-made post is neither, so it is never linked or hidden.

**Uncertain write.** After a POST with no response, an error or an unreadable response, re-scan first, adopt the part if found, and post only the missing parts. A second uncertain write is reported, and the run stops.

**Hiding.** Only after every part reads back equal, re-scan. `select` must return `adopt` with all m ids. Then minimize each `hide` entry and read it back, using summary.md §7's commands. A failed or unconfirmed minimize is reported as not hidden, and never retried. A stop notice hides nothing.

The only remote writes are these:

- new comments on the target issue;
- minimizing comments of ours that `hide` lists.

Never edit, delete or unhide a comment. Never touch the tracking issue's body — its story map, dependency map, open decisions and batches stay as the humans wrote them — nor its labels, title, assignees or milestone. Never touch another issue, PR or discussion, nor `FT_`/`STY_` numbers, readiness labels or decision state.

## 8. Report

Add these to the session report:

- the classification, with the feat key and doc path;
- the packet root's `cite` and the packet digest;
- the publish mode, or "declined" or "forbidden";
- each part's permalink, or why it was not posted;
- the previous result, each hidden id, and every `foreign` and `unrecognised` id;
- the drift summary, and any render stop with its reason.
