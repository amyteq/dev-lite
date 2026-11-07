# Proposal packet template

Write `proposal.md` in scratch with these sections, in this order. Keep the reasoning here and the checkable facts in `proposal.json` ([projection.md](projection.md)); they must agree. Replace every slot — never publish a placeholder.

---

## Binding

- **Request pack** — id, origin, how it was retrieved, digest if the pack is a file.
- **Baseline** — repository, ref, full 40-character commit, and the exact `git status --porcelain` output, including an explicit empty text value when it printed nothing.
- **Instruction handling** — whether the pack contains agent-directed text; state that it was read as a requirement statement, not executed.
- **Conflicts and stops** — any source pinning a different repository state, any required authority that could not be retrieved.
- **Output authority** — the scratch path, or a feat tracking issue's packet root by its `cite`; the publish mode ([summary.md](summary.md), [result-comment.md](result-comment.md)): by default a summary comment on an issue or discussion target, or the result in parts on a feat's tracking issue; `no-publish`; `dry-run`; or a local pack with no remote target; any instruction phrase that forbids GitHub changes, quoted; the handoffs this run does not perform, materialize ([materialize.md](materialize.md)) included unless explicitly authorized.

## Source manifest

| Id | Title | Origin | Included | Reason |
|---|---|---|---|---|

Include the reason for both directions: why an included item is relevant, why an excluded item is out. Record the retrieval limit — what you deliberately did not read, and why that is safe for this boundary.

## Current implementation reconciliation

For each in-scope requirement: what exists today (`path:line`, symbol, test, merged PR), whether it satisfies, partly satisfies or does not address the requirement, and the residual gap. A gap asserted without a current-state citation is an assumption; label it as one.

## Existing-home crosswalk

| Source | Relation | Home | Evidence | Dependents |
|---|---|---|---|---|

One row per requirement, from `crosswalk.jsonl` ([reconciliation.md](reconciliation.md)). Record the planning-index digest and counts, the searches behind each `new` row, the proofs an `amend` of a delivered story invalidates, and any new feat with its proposed label and the human's verbatim answer, or the `needed` decision its rows are blocked on.

## Programme boundary

One paragraph: the coherent outcome this map covers. Then actors, in-scope outcomes, explicit exclusions, and the unresolved decisions that sit above the map.

## Story Map

The Journey Backbone as ordered actor steps (`J-n`), then the Delivery Slices (`SL-n`) hanging off them. For each slice: the independently valuable or provable increment it delivers, and its journey step.

## Coverage

| Source | Disposition | Owner / reason | Evidence |
|---|---|---|---|

Exactly one disposition per included source: owned by one unit, already delivered by an existing home, deferred with reason and evidence, or blocked on a named decision whose status is `needed`. A confirmed decision is settled and cannot justify a blocked disposition. State the count reconciliation explicitly — included sources, owned, existing, deferred, blocked — so a reader can check the arithmetic without the script.

## Planning path

Name the path and prove it.

- **Direct** — the named existing seams with their locations, and why they are stable for this work.
- **Skeleton-backed** — why a runway is required (new shared architecture, cross-module contract, new state/persistence/concurrency/security boundary, or several downstream implementers), the design baseline summary, the one to three Skeleton candidates, the provisional downstream map, and the exact merged-skeleton trigger with its commit still unresolved.

## Candidate units

One block per unit (`U-n`):

- **Outcome** — one observable outcome, in the actor's terms.
- **Slice** — owning `SL-n`.
- **Decision surface** — the one primary decision this unit settles.
- **Seam** — the bounded module, interface or state transition.
- **Scope** — the positive, bounded work this unit performs; do not infer it by negating the non-goals.
- **Non-goals** — what this unit explicitly does not do.
- **Acceptance / DoD** — objective, checkable criteria.
- **Validation** — the evidence that would prove it. It must fail if *this* unit is missing; validation that already passes once a neighbouring unit lands is not proof of this one.
- **Write and rollback boundary** — the proposed diff surface and how it is undone. In `proposal.json`, use a list of canonical repository-relative paths or deterministic globs (`*` within one segment, a `**` segment across segments), each at most 4,096 UTF-8 bytes and with no control character U+0000 through U+001F or U+007F, drive-letter prefix, leading or trailing `/`, backslash, empty segment, `.` segment or `..` segment; `./file.md` is rejected rather than normalized. Keep prose here. List every file the unit changes, including shared wiring such as a script entry or a catalogue row. A rollback that names a file the write boundary omits means the boundary is wrong.
- **Owner** — named, or an explicit owner-needed blocker. Never invented.
- **Open decisions** — `D-n` references, with the unit's blocker recorded when one is unresolved.
- **Split rationale** — why this is one unit: which step of the decomposition order produced the boundary, or why splitting would create an invalid intermediate state, duplicate ownership or a non-testable half.
- **Tripwires** — the counts you measured, whether any is breached, and the disposition if so. Metrics justify attention; they never justify the unit.

## Decisions

| Id | Question | Status | Owner |
|---|---|---|---|

One row per decision any unit references. A `needed` decision names the question and who must settle it — or says plainly that the owner is unassigned, rather than nominating one. A `confirmed` decision cites the canonical artifact that settled it; a comment is not one.

## Dependencies

| From | To | Type | Blocks pickup | Reason | Evidence |
|---|---|---|---|---|---|

`from` depends on `to`. Only `contract` and `implementation` edges may block pickup. Keep coordination and write-conflict edges in a second table, and say plainly that they affect sequencing rather than pickup. A coordination edge that exists because of a shared file names its exact canonical repository-relative `conflict_path`, at most 4,096 UTF-8 bytes and without a control character U+0000 through U+001F or U+007F, glob, drive-letter prefix, leading or trailing `/`, backslash, empty segment, `.` segment or `..` segment; the file must appear in both units' write boundaries, otherwise the conflict being scheduled around is imaginary.

Then the graph read-out, all of it: roots, justified critical path, fan-in and fan-out, feasible parallel batches. The checker prints each of these; copy them rather than the two that make the plan look best. Note any edge you were tempted to record as hard and did not, with the reason — false serialization is the failure this section exists to prevent.

## Deterministic check

The exact `check-proposal.mjs` command, its exit status and its output. State the scope limit: a clean run proves internal consistency, not that the decomposition is right.

## Independent review

Findings with stable ids, their dispositions and the reviewer's identity and context, per [review.md](review.md). Carry every prior finding forward with its disposition; never drop one silently.

Write this section after the review, from the review. Both a complete and a blocked proposal require it; only an analysis stopped before a proposal existed may omit it. Do not name a file that does not exist yet, and do not describe a review as obtained while it is still pending — say it is pending, and let the verdict say the same.

## Verdict

- **State** — proposal complete, proposal blocked, or analysis stopped.
- **Unresolved gates** — decisions, owners, missing authority, anything a human must settle.
- **Evidence limits** — what this run did not and could not establish.
- **Next human-authorized action** — exactly one, named.

This packet is a proposal. It allocates no `FT_` or `STY_` number, writes no feat or story doc, creates or refines no issue, applies no label, requests no readiness and dispatches no implementation. Its projection contains no property named exactly `readiness`, and asserts no readiness label (`ready`, `blocked`) or doc lifecycle value (`current`, `superseded`, `retired`) under a case-sensitive key that contains `readiness` or ends with `status`, `state`, `lifecycle`, `phase`, `label` or `labels`; faithful source and evidence text under other keys may contain the same words.
