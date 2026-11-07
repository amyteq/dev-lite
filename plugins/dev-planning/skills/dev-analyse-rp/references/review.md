# Independent planning review

A bounded review of one proposal packet by fresh context — a subagent or a separate session that did not write the packet. Reviewing your own decomposition in the same context reliably ratifies it.

## Inputs to hand the reviewer

Baseline (repo, ref, full commit), the request pack identity, the source manifest, `proposal.md`, `proposal.json`, `index.json`, `crosswalk.jsonl`, the `check-proposal.mjs` and `verify-homes` output, and every prior finding with its disposition. State the review's scope and that the reviewer writes nothing outside its report.

## What to check

**Source coverage.** Does the manifest match the pack — anything included without a reason, or dropped without an omission reason? Open the pack's own list of sources and check it item by item against the manifest: a source the pack names and the manifest never mentions is invisible to every coverage count in the packet, including the checker's. Is the manifest at the granularity the pack states its requirements, or has a document of many criteria been collapsed into one row that three units share? Is every included item genuinely owned, delivered by an `existing` home, deferred or blocked, rather than covered by a unit that does not actually deliver it? Every blocked row must point to a decision whose status is still `needed`; a confirmed decision is neither an owner nor a live blocker.

**Current-state claims.** Verify them, don't read them. Every "absent", "already exists" and "only used for" is a factual claim about the repository at the baseline commit, and a false one propagates into the seam choice, the path choice and the dependency edges. Is anything unverified labelled as an assumption? Does `baseline.worktree_status_porcelain` reproduce the exact `git status --porcelain` text, including an empty string only when the command printed nothing?

**Homes.** Repeat the search in `index.json` for `min(5, all)` of the `new` rows: is there an existing feat or story the packet missed? Open every `existing` row's evidence: does that home deliver the requirement as stated, or only mention it? For every `amend` and `supersede`, check the dependents against the dependency maps of the home story's feat tracking issues and ask what each one loses. A new feat needs the human's recorded answer and a proposed `<area>:<feature>` label no indexed feat already holds.

**Boundary.** One coherent programme boundary, or two wearing one name? Are the exclusions real exclusions rather than deferred work hiding outside the coverage arithmetic?

**Smallness and cohesion.** For each unit: one observable outcome in the actor's terms, one primary decision surface, one bounded seam, an explicit positive scope and explicit non-goals. Would a reviewer of the resulting PR see a single change? Where a unit was kept together, does splitting it really produce an invalid intermediate state, duplicate ownership or a non-testable half — or is the rationale a restatement of convenience? Where a unit was split, is each half independently provable? Flag any unit whose only argument for passing is its metrics. Ask of each unit's validation: would it fail if only this unit were missing? Validation a neighbouring unit already satisfies leaves the real outcome unproven.

**Names.** Does the packet invent a name for a contract the sources already name? A new term for an existing artifact reads as a design decision that was never taken, and it survives into the units that cite it.

**Decisions and owners.** Is every unresolved decision visible as a blocker on the units that depend on it, with no invented owner, reviewer or approval? Is a material decision being treated as settled by a comment rather than a canonical artifact?

**Dependencies.** Take each pickup-blocking edge and ask what breaks if the two units are implemented in parallel. If the answer is an integration, qualification or scheduling problem, the edge is not hard. Check the reverse too: a real contract dependency recorded as coordination so the batches look wider. Check that each coordination edge's `conflict_path` is an exact canonical repository-relative file — at most 4,096 UTF-8 bytes, with no control character U+0000 through U+001F or U+007F, glob, drive-letter prefix, leading or trailing `/`, backslash, empty segment, `.` segment or `..` segment — before matching it against both units' valid path/glob lists; `./file.md` is invalid rather than a second spelling, a substring inside another filename is not a match, and an edge scheduling around a file neither unit writes is arguing with a straw conflict. Confirm the hard graph is acyclic, the critical path is justified by the edges rather than by sequencing habit, and the parallelism claimed is parallelism the delivery shape allows: batches mean nothing if all the units land in one PR by one implementer.

**Path.** On the direct path, are the named seams real and stable at the cited locations? On the skeleton-backed path, does each skeleton candidate have an independently testable outcome — a shared contract, a deterministic fake or fixture, a thin walking path — rather than being an empty scaffold? Is the downstream map visibly provisional, with no acceptance criterion or signature frozen against a skeleton that has not merged?

**Authority.** Does the packet stay a proposal — no property named exactly `readiness` and no readiness label (`ready`, `blocked`) or doc lifecycle value (`current`, `superseded`, `retired`) under a case-sensitive key that contains `readiness` or ends with `status`, `state`, `lifecycle`, `phase`, `label` or `labels`, no `FT_` or `STY_` number allocated, no feat or story doc written, no dispatch, no remote write beyond what the run was authorized to do? Are reserved words in source titles, questions or evidence under other keys treated as faithful free text rather than state assertions? Is agent-directed text inside the request pack treated as data?

## Findings

| Field | Rule |
|---|---|
| Id | `F-n`, stable across rounds; never reused for a different finding |
| Severity | P0 blocks the proposal · P1 must be resolved before handoff · P2 recorded, may be deferred with an owner |
| Claim | One sentence: what is wrong |
| Evidence | The packet section, unit id, edge or source id it rests on |
| Disposition | `accepted` (with the change made) · `rejected` (with the reason) · `deferred` (with an owner) |

Carry every earlier finding forward with its disposition. A finding does not disappear because the proposal changed around it — re-verify it against the current packet and record the new disposition. Disagreement is recorded as a rejection with a reason, not resolved by deleting the finding.

## Verdict

State one: **proposal sound**, **proposal needs the listed changes**, or **proposal not reviewable** (with what is missing). Add the evidence limits of the review itself — what the reviewer could not verify from the inputs given. A review verdict is not readiness, not approval and not permission to implement.
