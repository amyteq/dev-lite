# `AnalyseRpProposalV1` projection

`proposal.json` is the machine-checkable projection of `proposal.md`. It holds the facts a script can verify; the reasoning stays in the Markdown. It is not a second truth — where they disagree, the packet is wrong.

Check it with:

```bash
node "${CLAUDE_SKILL_DIR}/check-proposal.mjs" <scratch>/proposal.json
```

## Shape

```jsonc
{
  "schema": "AnalyseRpProposalV1",
  "baseline": {
    "repo": "owner/name",
    "ref": "main",
    "commit": "<40 hex>",              // full sha; abbreviated cannot bind evidence
    "worktree_status_porcelain": "", // exact command output; empty means no entries
    "request_pack": { "id": "RP-…", "origin": "…", "digest": "…" },  // digest optional
    "planning_index": { "digest": "sha256:…", "counts": { "feat": 3, "story": 12 } }  // from planning-index.mjs build
  },
  "homes": [                            // every existing key the packet names, once; filled from index.json
    { "key": "STY_<n>", "level": "story" }   // FT_<n> at level feat, STY_<n> at level story
  ],
  "boundary": { "statement": "…", "actors": ["…"], "outcomes": ["…"], "exclusions": ["…"] },
  "path": "direct",                     // or "skeleton"
  "seam_evidence": [                    // required, non-empty, on the direct path
    { "contract": "…", "location": "path:line | symbol | PR" }
  ],
  "journey": [
    { "id": "J-1", "step": "…" },
    { "id": "J-3", "step": "…", "deferral": "…" }   // a step no slice covers states why
  ],
  "sources": [
    { "id": "SRC-1", "title": "…", "origin": "…", "included": true,
      "omission_reason": null,          // required text when "included": false
      "baseline_commit": null }         // optional; any value other than baseline.commit is a conflict
  ],
  "coverage": [
    { "source_id": "SRC-1", "disposition": "owned",    "unit_id": "U-1" },
    { "source_id": "SRC-2", "disposition": "deferred", "reason": "…", "evidence": "…" },
    { "source_id": "SRC-3", "disposition": "blocked",  "reason": "…", "decision_id": "D-1" }, // D-1 status is needed
    { "source_id": "SRC-4", "disposition": "existing",
      "home": { "relation": "reuse", "key": "STY_<n>", "level": "story", "evidence": "path:line" } }
  ],
  "slices": [ { "id": "SL-1", "outcome": "…", "journey_step": "J-1" } ],
  "units": [
    {
      "id": "U-1", "slice_id": "SL-1", "kind": "unit",   // or "skeleton"
      "outcomes": ["…"],                                  // exactly one entry
      "decision_surface": "…", "seam": "…",
      "scope": ["…"],
      "non_goals": ["…"], "acceptance": ["…"], "validation": ["…"],
      "write_boundary": ["src/exact-file.ts", "references/*.md", "tests/**"],
      "rollback": "…",
      "split_rationale": "…",                             // always required
      "owner": "@login",                                  // null requires a blocker entry
      "open_decisions": ["D-1"], "blockers": ["…"],
      "provisional": false, "frozen_signatures": false,
      "tripwires": { "files": 6, "acs": 4, "breached": false, "disposition": null, "owner_gate": null },
      "home": {                                           // required on every unit
        "relation": "extend",                             // extend | amend | supersede | new
        "key": "STY_<n>", "level": "story",               // new: an FT_<n> key at level feat, or null for an approved new feat
        "evidence": "path:line",
        "search": ["…"],                                  // required for new
        "invalidates_proof": ["…"],                       // amend of a delivered story (D-b)
        "dependents": ["STY_…"],                          // required on amend and supersede: the stories that depend on the home
        "new_feat": null                                  // { name, label, scope, approved_by, approved_at, answer }
      }
    }
  ],
  "edges": [
    { "from": "U-2", "to": "U-1", "type": "contract",
      "blocks_pickup": true, "reason": "…", "evidence": "…" },
    { "from": "U-1", "to": "STY_<n>", "type": "contract",  // `to` may be a homes key
      "blocks_pickup": true, "reason": "…", "evidence": "…" },
    { "from": "U-3", "to": "U-2", "type": "coordination", "blocks_pickup": false,
      "conflict_path": "package.json",      // the shared file; must be in both write boundaries
      "reason": "…", "evidence": "…" }
  ],
  "decisions": [
    { "id": "D-1", "question": "…", "status": "needed", "owner": null, "evidence": null }
  ],
  "downstream": {                        // skeleton path only
    "provisional": true,
    "units": ["…"],
    "trigger": { "kind": "merged_skeleton_head", "commit": null, "description": "…" }
  },
  "review": {                            // required for proposal_complete and proposal_blocked
    "reviewer": "…",                     // identity and context of the independent reviewer
    "verdict": "sound",                  // or needs_changes | not_reviewable
    "findings": [
      { "id": "F-1", "severity": "P1", "claim": "…", "disposition": "accepted" },
      { "id": "F-2", "severity": "P2", "claim": "…", "disposition": "rejected", "reason": "…" },
      { "id": "F-3", "severity": "P2", "claim": "…", "disposition": "deferred", "owner": "@login" }
    ],
    "rounds": 2,                         // optional: review rounds held
    "unreviewed_fixes": ["…"]            // optional: fixes made after the last round
  },
  "amendments": [                        // optional: proposed changes to existing artifacts, not enacted
    { "target": "FT_<n> | STY_<n> | path", "change": "…", "evidence": "…" }
  ],
  "divergences": [                       // optional: intentional departures from current canonical planning
    { "subject": "…", "statement": "…", "reason": "…" }
  ],
  "verdict": {
    "state": "proposal_complete",        // or proposal_blocked | analysis_stopped
    "next_human_action": "…",
    "evidence_limits": "…"
  }
}
```

Identifier prefixes are fixed: `SRC-`, `SL-`, `U-`, `D-`, `J-`. An edge `{from, to}` reads *`from` depends on `to`* — `to` lands first. Existing work keeps its `FT_<n>` or `STY_<n>` key and is declared once in `homes`; the prefix fixes the level.

## Homes

Every unit has one `home` ([reconciliation.md](reconciliation.md)). Nobody passes `homes` in: the reconciliation pass (R0–R3) fills it, and each unit's `home`, from the matching `index.json` rows. A source an existing story already covers takes the `existing` disposition with a `reuse` home instead of a unit. `extend`, `amend` and `supersede` name a story. A `new` home names the existing feat the unit joins and the searches that found nothing closer; a proposed new feat has a null key and the human approval in `new_feat`, whose `label` is the proposed `<area>:<feature>` feat label. An edge to a `homes` key is a prerequisite outside this map: the graph read-out lists it per unit and keeps it out of roots, critical path and batches.

Every declared scalar field has the shown type; fields shown as `null` accept null or non-empty text, and `worktree_status_porcelain` is text that may be empty. Every declared object/list section must have the shown container type, every row in a list of records must be an object, and every declared text-list entry must be non-empty text. These type checks do not make fields newly required: the purpose-specific rules below continue to decide which fields are mandatory.

A unit's `write_boundary` is a non-empty list of canonical repository-relative paths or globs. `*` matches characters within one segment; a `**` segment matches across segments. A boundary entry is at most 4,096 UTF-8 bytes and has no control character U+0000 through U+001F or U+007F, drive-letter prefix, leading or trailing `/`, backslash, empty segment, `.` segment or `..` segment. The checker rejects `./file.md` rather than normalizing it. `conflict_path` is an exact canonical repository-relative file path, not a glob, with the same shape and length restrictions, and must match a boundary entry or glob on both units. The checker validates this shape before testing membership and does not parse prose into paths.

Planning authority is rejected two ways. A property named exactly `readiness` is forbidden at any depth, whatever its value. Independently, a reserved value is forbidden when its property's case-sensitive name contains `readiness` or ends with `status`, `state`, `lifecycle`, `phase`, `label` or `labels`: the status labels `ready` and `blocked`, which only issue labels carry, and the doc lifecycle values `current`, `superseded` and `retired`, which only feat and story frontmatter carries. The value is checked when it is a string, or a string entry of a list one level deep. Reserved-value matching is case-sensitive and exact. Free-text fields such as source titles, decision questions and edge evidence are not scanned unless their key has that state-carrying shape.

## Result fields

`amendments`, `divergences`, `review.rounds` and `review.unreviewed_fixes` are optional, and feed only the feat result ([result-comment.md](result-comment.md)). The checker accepts them without checking them. The renderer exits `2` on a mistyped one, naming it, and renders an absent one as `none recorded`, or `rounds` as `unknown`. The next action stays in `verdict.next_human_action`.

## What the checker enforces

| Code | Meaning |
|---|---|
| `SCHEMA_TAG`, `SCHEMA_FIELD`, `SCHEMA_TYPE` | Wrong schema tag; a required field/section missing; or a declared scalar, text-list entry, root, section or row with the wrong type |
| `JOURNEY_MISSING` | No journey backbone for the Story Map |
| `JOURNEY_UNCOVERED` | A backbone step no slice covers and no deferral explains |
| `BASELINE_FIELD`, `BASELINE_COMMIT`, `BASELINE_PACK` | Missing repo/ref, porcelain status or planning-index digest, a non-40-character commit, or not exactly one identified request pack |
| `BASELINE_CONFLICT` | A source pins a repository state other than the run baseline |
| `ID_FORMAT`, `ID_DUPLICATE`, `REF_UNKNOWN` | Malformed id, a repeated id or `homes` key, a reference to an id that was never declared, a home key or edge `to` missing from `homes`, or an edge `from` that is not a unit |
| `HOME_FIELD` | A missing or malformed `home` or `homes` row: a key that is neither `FT_<n>` nor `STY_<n>`, unknown level or relation, no evidence, `reuse` on a unit or another relation on an `existing` row, a non-`new` home at feat level, `new` at story level, a level its key's prefix contradicts, or an `amend` or `supersede` that declares no `dependents` |
| `HOME_SEARCH_MISSING` | A `new` home without a `search` list |
| `HOME_CONFLICT` | A key one unit supersedes that another unit also supersedes or names as its home |
| `HOME_FEAT_UNAPPROVED` | A null-key `new` home without a complete `new_feat` approval with an `<area>:<feature>` label, or a `new_feat` beside a key |
| `COVERAGE_MISSING` | An included source with no owner, deferral or blocker |
| `COVERAGE_DUPLICATE` | Two primary owners, or two dispositions, for one source item |
| `COVERAGE_UNJUSTIFIED` | A disposition without its required owner, reason, evidence or decision id, a blocked row whose decision status is not `needed`, or a row carrying another disposition's cover: an `existing` row with a `unit_id`, or any other row with a `home` |
| `SOURCE_OMISSION_REASON` | An excluded source with no omission reason |
| `UNIT_MULTI_OUTCOME` | A unit with zero or several observable outcomes |
| `UNIT_FIELD_MISSING` | A final candidate missing seam, positive scope, non-goals, acceptance, validation, write/rollback boundary or slice |
| `UNIT_SPLIT_RATIONALE` | No semantic split or keep-together rationale |
| `UNIT_BLOCKER_HIDDEN` | No owner and no recorded blocker |
| `DECISION_UNRESOLVED_HIDDEN`, `DECISION_FIELD` | An unresolved decision with no blocker on the unit; a malformed decision row |
| `UNIT_TRIPWIRE_DISPOSITION` | A breached tripwire with no disposition, or `justified_oversize` with no owner gate |
| `READINESS_FORBIDDEN` | A `readiness` field anywhere, or an exact reserved readiness or lifecycle value under a key that contains `readiness` or ends with `status`, `state`, `lifecycle`, `phase`, `label` or `labels` |
| `PATH_SEAM_EVIDENCE` | Direct path without named seam evidence |
| `PATH_SKELETON_COUNT` | Not one to three skeleton candidates, or skeletons on the direct path |
| `PATH_DOWNSTREAM_MAP`, `PATH_TRIGGER` | Downstream map not marked provisional, or a trigger that is not an unresolved merged skeleton HEAD |
| `FREEZE_PREMATURE` | A downstream unit finalized or signature-frozen before the skeleton is merged |
| `EDGE_TYPE`, `EDGE_EVIDENCE`, `EDGE_SELF` | Invalid edge type, missing reason/evidence/`blocks_pickup`, or a self edge |
| `EDGE_FALSE_HARD` | An integration, qualification or coordination edge recorded as pickup-blocking |
| `EDGE_CONFLICT_UNDECLARED` | A coordination edge names a shared file that is not in both units' write boundaries |
| `PATH_SHAPE` | A write-boundary entry or `conflict_path` contains a forbidden control character or is not a repository-relative file/glob shape permitted above |
| `GRAPH_CYCLE` | A cycle among pickup-blocking edges |
| `REVIEW_FIELD` | A review with no reviewer or verdict, or a finding with no stable id, severity or disposition |
| `VERDICT_FIELD` | A verdict with an unknown state or without its next human action or evidence limits |
| `VERDICT_UNSUPPORTED` | `proposal_complete` or `proposal_blocked` over an unrecorded review; additionally, a complete proposal whose review is not `sound` or has a P0/P1 finding that was neither accepted nor rejected |
| `INPUT_ERROR` | Invalid CLI usage or an unreadable or unparseable JSON input; reported at exit `2`, not as a projection finding |

The checker also computes and prints roots, the critical path, fan-in, fan-out and the feasible parallel batches over the hard graph, and each unit's existing prerequisites. It never reads the repository; `planning-index.mjs verify-homes` checks the homes against the index ([reconciliation.md](reconciliation.md#checks-against-the-index)).

Exit `0` means no projection findings, exit `1` means schema/bookkeeping findings, and exit `2` is reserved for CLI usage or unreadable/unparseable JSON input. Usage is exactly one projection path plus at most one `--json` flag in either order. A bare `--` ends option parsing; all remaining tokens are paths, which permits `-- --proposal.json`. Extra paths, repeated `--json` before the marker, and unknown `--flags` before the marker exit `2`. With `--json`, both findings and input errors are machine-readable; parseable JSON with the wrong projection shape reports `SCHEMA_TYPE` at exit `1`.

## What it cannot enforce

It cannot tell whether an outcome is genuinely observable, whether a seam is genuinely stable, whether a rationale is sound, or whether a hard edge is real. It checks that the required judgement was recorded — not that it was right. That is the independent review's job, and no clean checker run substitutes for it.

Three limits are worth naming, because they look like checks and are not:

- **`tripwires.breached` is your assertion, not a measurement.** Nothing here computes a threshold, so a green tripwire row means you said the counts were fine. The checker only reacts once you mark a breach.
- **`worktree_status_porcelain` preserves an observation; it is not a cleanliness judgement.** Record the exact `git status --porcelain` text, including an empty string when the command printed nothing. The checker validates only that this is text; it never looks at the repository.
- **The coverage arithmetic runs over the sources you listed.** A source the pack names and the manifest omits is invisible to `COVERAGE_MISSING` — which is why the enumerated-source rule in the skill matters more than the check does.
