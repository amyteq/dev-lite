# Review and disposition reports

Use these formats as Markdown comments. Replace placeholders with observed facts; omit no-findings rows rather than inventing findings. Empty tables may be replaced by "No new findings" / "No fixes required" plus the ledger summary. Escape pipes inside table cells. Link exact file lines at the reviewed commit, tests, and prior comments. Include the run/round/phase marker to reconcile uncertain publication.

Do not repeat the PR URL — the comment already lives on the PR. Write each SHA as a short hash linked to its exact full-SHA commit URL, and carry every other reference on descriptive link text; no bare URLs in comment prose. Both signatures are defined in [Signature fields](#signature-fields).

Write every published comment as **soft-wrapped Markdown**: one paragraph, list item or table row per line, with no hard line breaks inside a paragraph. GitHub wraps to the reader's viewport, so a hard-wrapped paragraph renders ragged at every other width.

## Before publishing: the publication check

Leave a blank line before any `---`. Without it the preceding paragraph parses as a setext H2 and renders as a heading, which is how a signature separator silently turns the line above it bold.

That rule does not enforce itself, so check it. Both skills share one checker at the plugin root. Run it against the exact payload about to be published, and call `gh` only on exit `0`:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-publication.mjs" --body-file "$BODY_FILE"
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-publication.mjs" --review-json "$REVIEW_JSON_FILE"
```

`CLAUDE_PLUGIN_ROOT` is the plugin root named in [SKILL.md](../SKILL.md). Run it with Node.js 20+ after installing the plugin's locked dependencies with `npm ci --prefix "${CLAUDE_PLUGIN_ROOT}"`. The checker takes exactly one payload: `--body-file` for the Markdown bound to `gh --body-file`, and `--review-json` for the reviews-API JSON input whose `body` field carries the signed report. A bare path is still accepted as `--body-file`. It prints one `file:line` per offending separator — `file#body:line` for the JSON form — and exits `1`; on a clean payload it prints nothing and exits `0`. Usage, read and parse errors exit `2` and must block publication exactly as a finding does, because a check that did not run is not a check that passed. It preserves original line numbers for LF, CRLF and CR inputs and never modifies the payload.

The rule itself lives in `${CLAUDE_PLUGIN_ROOT}/scripts/check-separators.mjs` and uses the plugin's Markdown parser (`mdast-util-from-markdown`) to exclude code blocks, including fences nested in lists or quotes, tabs, mixed indentation, wider delimiters and unclosed fences. It does not approximate container or fence state. The rule (`check-separators.test.mjs`) and entry-point (`check-publication.test.mjs`) regression tests beside them include the tab-indented list-fence AC2 failure and run through `npm test` in the plugin root.

Outside parsed code blocks, the established publication rule remains deliberately stricter than the rendering defect: `---`, `***`, `___`, longer or spaced runs, with up to three leading spaces measured from column zero, require a blank preceding line. A first-line separator is allowed; a space/tab-only line is blank. Separators after lists, tables or closing fences are checked even when they render as `<hr>`. Widening the transports this check covers did not widen the rule it enforces. This command is for assembled comments; a file with YAML frontmatter will flag its closing delimiter.

The existing policy does not cover quoted separators (`> ---`), list-relative separators indented more than three spaces from column zero, or short setext underlines (`-` / `--`). Those remain a reader's responsibility; parsing code blocks does not expand the separator rule.

Check the **assembled** body, never the template. Both templates below are correct as written, and the Writer template already carries its blank line before the signature separator. A body still fails when the coordinator inserts sections the template does not show — a `Validation:` block, or the scope proposals [SKILL.md](../SKILL.md) asks for — between the findings table and the signature, and the template's blank line does not survive that assembly.

The requirement follows the Markdown, not the transport. The terminal formal approval never reaches `--body-file`: it serialises the signed full-review Markdown into the `body` field of the reviews-API JSON input described in [GitHub publication](agents.md#github-publication). Pass that payload to `--review-json`, which checks the stored Markdown rather than the escaped text, because JSON escaping collapses every newline into `\n` and hides the defect from anything reading the payload, while GitHub renders the stored Markdown exactly as it renders a comment.

## Severity

Use this rubric for the review loop: a coverage, consistency or decision gap is material, and therefore P0/P1, when it matches a P0 or P1 row below.

| Level | Meaning | Blocks approval |
|---|---|---|
| **P0** | Irreversible harm or an action outside authority on a realistic path: permanent data loss, an exposed secret, a write to the wrong repository or branch, a merge, force-push or destructive operation, an auth/RLS bypass | Yes |
| **P1** | On a realistic path: a wrong authorized write, human data loss that needs manual recovery, or a listed acceptance case that fails. Also: a required test or check fails at the exact head; a fixed P0/P1 has no regression test; a listed AC case whose only test is missing or cannot fail | Yes |
| **P2** | Recoverable wrong output, such as a duplicate comment, over-reporting or a misleading message; a missing edge-case test | No; the writer dispositions it |
| **P3** | Crafted or improbable input, precision, naming, wording | No |

- A P0/P1 defect states actor → steps → harm on a realistic path; without one it is capped at P3. The evidence P1s — a failing required check, a missing regression test, an unevidenced AC case — cite the check output or the AC case instead; for a change with no executable surface, a recorded walkthrough of the case is its test.
- Test code is evidence, not product: raise no finding on its quality, structure, naming or duplication beyond the test rows above.
- A shape outside the task's closed case list that ends in a stop is fail-closed behaviour, not a finding.
- A merge conflict with the base is a blocking gate routed to the writer, not a severity.

## Growth

Review-driven growth compares the PR's non-test added lines at the current head with the same count at the first reviewed head, as a percentage of the first. Count the added column of `git diff --numstat <base> <head>`, skipping `*.test.*`, `*_test.*` and `*.spec.*` files and anything under a `test/`, `tests/`, `__tests__/` or `fixtures/` directory. Round 1 reports `0%`; a zero first count makes any later non-test line exceed the limit. Above 20% the loop stops for an owner design decision ([SKILL.md](../SKILL.md) step 4).

## Reviewer

```markdown
<!-- dev-review-pr: RUN_ID round=R phase=review|closing-review|final-review -->
## PR review — round R / LIMIT — full|delta|closing-full|final-full

Base: [BASE_SHA_SHORT](BASE_COMMIT_URL) · Reviewed head: [HEAD_SHA_SHORT](HEAD_COMMIT_URL) · [Scope / AC](SCOPE_URL)
[Previous review](PREVIOUS_REVIEW_URL) · [Writer disposition](DISPOSITION_URL) · Delta range: [PREVIOUS_HEAD_SHORT..HEAD_SHA_SHORT](COMPARE_URL) (full reviews: complete PR diff)

| ID | Priority | Finding / concrete impact / smallest remedy | Evidence at reviewed head | Ledger state / adjudication |
|---|---|---|---|---|
| F001 | P1 | Trigger, resulting defect and smallest remedy | file:line + test/reproduction | open |

Ledger: settled IDs — resolved, accepted rebuttals and accepted deferrals with residual severity — each linked to the review that settled it or marked settled by this review; pending/reopened IDs and new evidence. Do not restate accepted requests as new findings.
Invariant: for each P1, the invariant it breaks; for the first P1 against that invariant, also its sibling instances in the same function.
Growth: PERCENT non-test added lines over the first reviewed head (FIRST_COUNT → CURRENT_COUNT).
Validation: the coordinator-run exact-head checks with exit codes, labelled coordinator-run, plus any probe this review ran; a check that could not run is `not run` with its reason, never a pass. Name only tools and commands that actually ran — an invented tool, harness or wrapper name is a defect in the report itself.
Verdict: continue / approval-eligible / blocked / budget-exhausted.
Unresolved P0/P1: IDs or none. Residual P2/P3: IDs or none.

---
🔎 ACTUAL_AGENT·ACTUAL_MODEL·ACTUAL_EFFORT · read-only head: [HEAD_SHA_SHORT](HEAD_COMMIT_URL) · context: OBSERVED_CONTEXT_OR_NA · STARTED_TIMESTAMP TZ · MEASURED_ELAPSED · VERDICT
```

In round 1 write `previous review: none` and `writer disposition: none` as plain text rather than empty links, and drop the delta range from a full review.

The findings table shows only unsettled work: one row for each ID in `open` (new or reopened), `fixed-pending-review`, `rebutted-pending-review`, `deferred-pending-review` or `residual`. `resolved`, `rebuttal-accepted` and `deferred-accepted` IDs appear only on the `Ledger:` line, each linked to the review that settled it or marked as settled by this review, and never return as rows without new evidence that reopens them. An accepted deferred P0/P1 also stays on the `Unresolved P0/P1:` line, because deferral is not resolution.

## Writer

```markdown
<!-- dev-review-pr: RUN_ID round=R phase=writer|closing-writer -->
## Fix dispositions — round R / LIMIT

Base: [BASE_SHA_SHORT](BASE_COMMIT_URL) · Input head: [REVIEWED_SHA_SHORT](REVIEWED_COMMIT_URL) · Result head: [RESULT_SHA_SHORT](RESULT_COMMIT_URL) · [Review](REVIEW_URL) · [Scope / AC](SCOPE_URL)
Push: verified remote head / no code changes / blocked (reason)

| ID | Disposition | Change or rebuttal/deferral reasoning | Smaller alternative considered | Evidence / commit / tests | Residual risk / next action |
|---|---|---|---|---|---|
| F001 | fixed-pending-review | Concrete fix; for a safety fix, the invariant it restores | delete / narrow / reuse, and why | commit link + test result | reviewer verification |
| F002 | deferred-pending-review | Scope or effort reason | why no smaller change fits | supporting evidence | impact, follow-up proposal |

Cover every open finding handed to this phase. Prefer removal or narrowing to a new guard. A safety fix repairs its invariant wherever it is broken, not only the reported reproduction. Propose follow-ups without filing new issues unless authorized. State failed or unrun tests; do not imply a rebuttal/deferral is accepted.

---
✏️ ACTUAL_AGENT·ACTUAL_MODEL·ACTUAL_EFFORT · head: [RESULT_SHA_SHORT](RESULT_COMMIT_URL) · context: OBSERVED_CONTEXT_OR_NA · STARTED_TIMESTAMP TZ · MEASURED_ELAPSED
```

The closing phases keep `round=LIMIT` under their own tokens: `closing-review` and `final-review` carry the `closing-full` and `final-full` labels, and `closing-writer` heads its report `## Fix dispositions — closing`. Every published report therefore has one marker identity to reconcile an uncertain write against.

## Signature fields

Each signature is a single rendered line: fields joined by ` · `, with the provider triple joined by `·` without spaces. The coordinator fills it from that phase's record, never from estimates or from the launch command text.

| Field | Meaning | Example |
|---|---|---|
| `ACTUAL_AGENT·ACTUAL_MODEL·ACTUAL_EFFORT` | Provider value, which names the route, then the model and reasoning effort for the session | `codex·observed-model·high`, `claude·observed-model·high (requested)` |
| `OBSERVED_CONTEXT_OR_NA` | Context window available to that session as reported — not tokens consumed | `context: 1M`, `context: 200k`, `context: N/A (not emitted)` |
| `STARTED_TIMESTAMP TZ` | Coordinator wall clock when the phase started, `yyyy-MM-dd HH:mm`, zone named | `2026-09-16 08:24 AEST` |
| `MEASURED_ELAPSED` | Measured duration of that phase as `H:mm` | `0:04` (4 minutes), `1:37` (1 hour 37 minutes) |
| `VERDICT` (reviewer only) | Outcome label for this review; always the last field | `CHANGE REQUIRED`, `APPROVAL ELIGIBLE`, `APPROVED`, `BLOCKED`, `BUDGET EXHAUSTED` |

The end timestamp, the requested profile and the rest of the [phase record](agents.md#phase-record) stay in scratch rather than being published here. Elapsed hours are unbounded and minutes are rounded, so a sub-minute phase shows `0:00`; keep raw ISO timestamps and seconds in the record instead of inflating the published value. Use the phase's own wall time, not total loop time.

`ACTUAL_EFFORT` is the value the CLI reported; an unreported effort is published as the requested value plus ` (requested)`, or `N/A (not emitted)` when none was requested, and does not block. Agent, model and phase timing are verify-or-block: mark an unobservable one `unverified` and stop. `N/A (not emitted)` belongs only to a context field the CLI never reports, and a value contradicting the request is a blocker ([phase record](agents.md#phase-record)). Publish only the non-secret summary, never raw transcripts, tokens or credentials; a phase that failed before model execution is "not run", not signed.

The body `Verdict:` line records loop state; the footer `VERDICT` labels the review outcome. Keep them consistent:

| Body `Verdict:` | Footer `VERDICT` |
|---|---|
| `continue` | `CHANGE REQUIRED` |
| `approval-eligible` | `APPROVAL ELIGIBLE`, becoming `APPROVED` only in a review GitHub actually accepted at that head |
| `blocked` | `BLOCKED` |
| `budget-exhausted` | `BUDGET EXHAUSTED` |

`APPROVED` therefore never appears on a plain comment. Self-authored or permission-blocked eligibility stays `APPROVAL ELIGIBLE`, and the terminal coordinator summary states whether GitHub accepted the approval.

`APPROVAL ELIGIBLE` is the same code judgement as `APPROVED` where a formal approval was unavailable or not authorized, normally because the signed-in account authored the PR. It is the terminal success state, not a provisional pass: the loop stops on it, and `APPROVED` differs only in being a review object branch protection can count.
