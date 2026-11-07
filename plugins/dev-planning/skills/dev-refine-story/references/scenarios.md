# Scenarios and their tests

**All evidence here is synthetic.** Every case is proved by fixture objects in `scripts/resolve-story-issue.test.mjs`, which `npm test` runs from the plugin root; nothing calls GitHub, creates an issue or changes a Story. The tests prove the decision table, not that a model follows SKILL.md; a live walkthrough is reported as one.

## Cases

Each test cell names a check; "same" repeats the one above.

| Case | Outcome | Test |
|---|---|---|
| No marker issue: authorized with write access; not authorized; `read`, `triage`, `none` or no permission | `CREATE_AUTHORIZED` `{1, 1}`; `CREATE_NOT_AUTHORIZED`; `INSUFFICIENT_PERMISSION` | *one marker issue is reused, and none creates only with authority and write access* |
| One open marker issue, also with a trailing `\r` | `REUSE_MARKED` `{0, 1}`, `duplicates: []` | same |
| Eligible marker issues `a < b < c`, all six orders; two beside unmarked rows; one of them locked | `DUPLICATE_MARKERS`, naming every eligible issue | *several eligible marker issues stop for a human in any order* |
| A closed newer marker issue | not selected | same |
| A marker copy whose author has `read`, `triage`, `none` or a deleted account, beside an eligible one or alone | never selected, listed in `duplicates`; alone, `MARKER_PROVENANCE_UNCERTAIN` | *a marker copied by an author without write access is never selected* |
| The original's author lost write access or deleted their account; two such issues; a closed one | `MARKER_PROVENANCE_UNCERTAIN`, naming each, never a create; the closed one is ignored | *a marker issue of uncertain provenance never leads to a create* |
| A maintainer selection: an uncertain or eligible marker issue, another key casing; another Story, an unmarked or closed issue, an unusable shape; a selector without write access; a locked issue | `REUSE_SELECTED` with `selection`; `SELECTION_MISMATCH`; `INSUFFICIENT_PERMISSION`; `ISSUE_LOCKED` | *a maintainer-named original is reused only when this listing confirms it* |
| Marker authors for Step 2, with leading whitespace, `\r`, a near miss, another key, no author | the resolver's own marker reading, each login once | *the listing asks for every marker author the resolver reads, leading whitespace included* |
| An open marker row without a string or `null` `authorPermission`; a closed or unmarked row without one | `CANDIDATE_PROVENANCE_UNKNOWN`; decided normally | *an open marker issue without fetched provenance stops* |
| The selected marker issue locked | `ISSUE_LOCKED`, naming it | *a locked selected issue stops* |
| A title or body mention, the marker on a later line, a marker for `STY_<n>0` or another key, a closed marker issue, a feat tracking issue body | never selected, never blocks a create | *only an open issue with the first-line marker is the Story's* |
| A first line that opens like this Story's marker but does not parse | `MARKER_UNREADABLE`, naming it; ignored when closed | *a near-miss marker for this Story stops* |
| Run tokens with `:` or `-`, malformed ones and an impossible day | parsed for this Story only | *the run marker parses in both timestamp spellings, for this Story only* |
| `STY_<n>` against `STY_<n>0`, `STY_<n>abc`, `STY_<n>-alt`, `STY_<n>_alt`, the Story document's path, `PRE-STY_<n>` | never matched | *the Story key matches only as a whole token* |
| `lookup.complete` not `true`; `candidates` absent, `null` or not a list; `[]` | `LOOKUP_INCOMPLETE`; `MALFORMED_CANDIDATE_SET`; create | *an incomplete lookup or unusable candidate set stops* |
| A shapeless row or invalid number; one number twice; a pull-request, API, foreign, `http://` or suffixed URL | `MALFORMED_CANDIDATE` | *an untrustworthy row stops rather than being dropped*; *issue IDs are positive safe integers* |
| An unfetched `body`, unknown `state` or non-boolean `locked` | `CANDIDATE_IDENTITY_UNREADABLE`, `CANDIDATE_STATE_UNKNOWN`, `CANDIDATE_LOCK_UNKNOWN`; `body: null` decides | same; *states normalise across casings* |
| A zero, leading-zero or suffixed key, a hyphenated key, a bare number, an empty key, two keys; an `FT_<n>` key; a malformed `repo` | `MALFORMED_KEY`; `FEAT_KEY_NOT_STORY`; `MALFORMED_INPUT` | *a malformed key or target stops first* |
| Unknown Story, two documents, a wrong key, an absent field, a terminal Story | the matching Story stop | *a missing, mismatched, incomplete or terminal Story stops* |
| A path for a longer key, a lower-case prefix, a capitalised or missing slug, another folder; a slug ending in `review` | `STORY_ENVELOPE_INCOMPLETE`; accepted | *only the Story document path is accepted* |
| Any input | no `readiness` in the decision | *no decision reads or reports readiness* |
| The same input again | the same selection, no create | *a repeated invocation selects the same issue and creates nothing* |
| Any `featIssues`, `attestation` or `receipt` | the decision without them | *unknown keys such as featIssues, attestation and receipt are not read* |
| The CLI run directly and through a symlink | exit `3`, `MALFORMED_INPUT` for `{}` | *the CLI runs its checks directly and through a symlink* |
| A real Story key in SKILL.md, this file, the contract or the resolver; a run artifact outside `$WORK`; Step 4 without its pre-create check or readback stop | fails the suite | *the resolver and skill documents name no real Story*; *SKILL.md keeps run artifacts in the scratch directory*; *SKILL.md Step 4 checks before the create call and stops on a marker-less readback* |

### The closing check

*Every decision keeps its write budget, and the contract lists exactly the codes produced* covers every decision: a stop plans `{0, 0}`, a reuse `{0, 1}` and a create `{1, 1}`; `duplicates` and `conflicts` name each ID once, never the selected issue in `duplicates`; and their codes equal the [reason-code table](resolver-contract.md#reason-codes). No decision may follow it.

## Supervised steps

No test stands in for these SKILL.md steps; reviewing the wrapper means reading them. The Step 4 document check proves its text is present, not that an executor follows it:

- paginating the listing and checking its node count;
- flushing the receipt and passing the pre-create check before the one create call, and never calling create again after a lost response;
- writing the marker as the created issue's first line, reading it back, and recording `confirmedIssue` or stopping without it;
- establishing creation authority and running the permission check;
- the single `/dev-refine-issue` invocation.
