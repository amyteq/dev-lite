# Resolver contract

`scripts/resolve-story-issue.mjs` decides which open issue is the Story's and whether a create is permitted. It is pure, with no network, filesystem or clock access; SKILL.md gathers the evidence.

Run it as `node "${CLAUDE_SKILL_DIR}/scripts/resolve-story-issue.mjs" <input.json>` (or `-` for stdin), where `${CLAUDE_SKILL_DIR}` is this skill's directory. It exits `0` for `reuse` or `create`, `3` for `stop` and `2` for unreadable input.

**An absent field is never evidence:** it means "not fetched" and stops, never defaulting to open, unlocked, empty or allowed.

## Input

```json
{
  "storyKey": "STY_<n>",
  "repo": "<owner>/<repo>",
  "story": {
    "key": "STY_<n>",
    "docPaths": ["docs/stories/STY_<n>_<slug>.md"],
    "lifecycleStatus": "current"
  },
  "lookup": { "complete": true },
  "candidates": [
    { "number": 101, "state": "OPEN", "locked": false, "url": "https://github.com/<owner>/<repo>/issues/101", "body": "Mentions STY_<n> in passing." },
    { "number": 205, "state": "OPEN", "locked": false, "url": "https://github.com/<owner>/<repo>/issues/205", "body": "<!-- dev-refine-story:origin story=STY_<n> run=2026-01-02T03-04-05Z -->\n…", "authorPermission": "write" }
  ],
  "authority": { "createAuthorized": false, "effectivePermission": "write" },
  "selection": null
}
```

#205 is reused: its first line is the Story's marker and its author has write access, while #101 only mentions the Story.

- `repo` is one `owner/repo`; anything else is `MALFORMED_INPUT`.
- `storyKey` is `STY_<positive integer>` with no leading zero, trimmed and matched case-insensitively. An `FT_<positive integer>` key is `FEAT_KEY_NOT_STORY`; anything else is `MALFORMED_KEY`.
- `selection` is absent or `null`, or a maintainer's `{ "story": "STY_<n>", "issue": <number> }` naming the Story's original issue ([Selection](#selection)).
- Every other key is ignored, such as `featIssues`, `attestation` or `receipt`.

### The Story envelope

The gates run in this order; the first failure decides.

1. `story: null` means no Story document resolved: `STORY_NOT_FOUND`.
2. `story.key`, read back from the document: absent is `STORY_ENVELOPE_INCOMPLETE`; a non-string or another key is `STORY_KEY_MISMATCH`.
3. `docPaths`, every match: none, or an entry that is not a non-empty string, is `STORY_ENVELOPE_INCOMPLETE`; several is `STORY_AMBIGUOUS`.
4. The path must be `docs/stories/STY_<n>_<slug>.md` for this key, with a lowercase `snake_case` slug; otherwise `STORY_ENVELOPE_INCOMPLETE`.
5. `lifecycleStatus`, the frontmatter `status` in any casing: `superseded` or `retired` is `STORY_TERMINAL`, naming `supersededBy` when present; anything but `current` is `STORY_ENVELOPE_INCOMPLETE`.

Readiness is not an input: it lives only on the issue's `ready` / `blocked` labels, which `dev-refine-issue` reports.

### The lookup and its rows

- `lookup.complete` must be `true`, meaning the listing reached its last page and its node count equals its reported count; otherwise `LOOKUP_INCOMPLETE`.
- `candidates` must be a list; anything else, including an absent key, is `MALFORMED_CANDIDATE_SET`. `[]` states that a complete listing found no open issue.

Every row is checked before any is judged, so an unreadable row cannot hide the Story's issue. The first gate that catches a row decides, naming every row it catches:

| Gate | Stop |
|---|---|
| A row that is not an object, or whose `number` is not a positive safe integer | `MALFORMED_CANDIDATE`, naming none |
| One `number` on two rows | `MALFORMED_CANDIDATE` |
| A `url` that is not exactly `https://github.com/<repo>/issues/<number>` for this repository and number, including `http://`, a `/pull/`, API or foreign URL, or any suffix | `MALFORMED_CANDIDATE` |
| A `body` that is absent or not a string; `null` is a fetched empty body | `CANDIDATE_IDENTITY_UNREADABLE` |
| A `state` that is not `open` or `closed` in any casing | `CANDIDATE_STATE_UNKNOWN` |
| A `locked` that is not a boolean | `CANDIDATE_LOCK_UNKNOWN` |

The repository and URL match case-insensitively. Other row fields, such as `title`, are ignored.

An open row whose first line is this Story's marker must also carry `authorPermission`: the issue author's collaborator permission as a string, or `null` when the author account no longer exists. Anything else is `CANDIDATE_PROVENANCE_UNKNOWN`, naming every such row. Anyone who can open an issue can copy a marker, so only an author with `admin`, `maintain` or `write`, in any casing, makes a marker issue eligible. Other rows need no `authorPermission`.

### Authority

`authority.createAuthorized` must be `true`. `authority.effectivePermission` is the collaborator-permission answer; only `admin`, `maintain` or `write`, in any casing, may create. Both are read only when no open marker issue exists.

## The origin marker

The marker is the exact line SKILL.md Step 4 writes as a created issue's first body line:

```text
<!-- dev-refine-story:origin story=STY_<n> run=<token> -->
```

The token is an ISO-8601 UTC timestamp on a real calendar day, such as `2026-01-02T03:04:05Z`, or `2026-01-02T03-04-05Z` with `-` throughout, with optional milliseconds.

Only the body's first line is read. A trailing `\r` and whitespace around the marker are ignored. The first line is, for this Story:

- **marked** when it is the marker naming this key;
- **unreadable** when it begins `<!-- dev-refine-story:origin` and names this key as a whole token but is not the exact marker, such as a bad run token or a missing ` -->`;
- **unmarked** otherwise, including a marker for another key.

An open unreadable row is `MARKER_UNREADABLE`, naming every such row: it may be the Story's issue, so a create could duplicate it. A closed row never counts.

### Whole-token keys

The key matches case-insensitively, as a token not preceded or followed by a letter, digit, `_` or `-`. `STY_<n>` matches `STY_<n>,`, `STY_<n>.` and `STY_<n>'s`, and never `STY_<n>0`, `STY_<n>abc`, `STY_<n>-alt`, `STY_<n>_alt` (so never the Story document's file name) or `PRE-STY_<n>`.

## Selection

The Story's eligible issues are the open rows whose first line is marked and whose author has write access. Open marked rows by any other author are listed in `duplicates`, ascending, and are never selected automatically. Their provenance is uncertain: a copier and an original author who has since lost write access or deleted their account look the same. The title, a mention in the body, a marker on a later line, a closed marker issue and a feat tracking issue listing the Story never select an issue and never block a create.

- **A maintainer selection:** checked first. Its `story` must be this key and its `issue` an open marked row of this listing, and `authority.effectivePermission` must be write access; it is selected as `REUSE_SELECTED`, echoing `selection` with the canonical key, with every other open marked row in `duplicates`. A selection that names another Story, an issue without the marker, or no usable number is `SELECTION_MISMATCH`; without write access, `INSUFFICIENT_PERMISSION`; a locked one, `ISSUE_LOCKED`.
- **Several eligible:** `DUPLICATE_MARKERS`, naming them all; a maintainer names the Story's issue.
- **One eligible:** it is selected. A locked selected issue is `ISSUE_LOCKED`, naming it.
- **None eligible, but some open marked row:** `MARKER_PROVENANCE_UNCERTAIN`, naming every such row, whatever the creation authority; a maintainer names the original.
- **No open marked row:** without `createAuthorized: true`, `CREATE_NOT_AUTHORIZED`; with it but without write permission, `INSUFFICIENT_PERMISSION`; otherwise `CREATE_AUTHORIZED`.

The whole order is: target, key, Story envelope, lookup, candidate set, row gates, unreadable marker, marker provenance, maintainer selection, eligible selection, uncertain provenance, create gate.

## Output

```json
{
  "action": "reuse",
  "reasonCode": "REUSE_MARKED",
  "reason": "Reusing #205, …",
  "issue": { "number": 205, "url": "https://github.com/<owner>/<repo>/issues/205" },
  "selected": 205,
  "duplicates": [],
  "conflicts": [],
  "plannedWrites": { "createIssue": 0, "invokeRefineIssue": 1 }
}
```

- `plannedWrites` is the invariant to check in review: a `stop` plans `{0, 0}`, a `reuse` `{0, 1}` and a `create` `{1, 1}`.
- `issue` and `selected` name the reused issue, else `null`. `REUSE_SELECTED` also carries `selection`, the Story and issue a maintainer named, for the handoff and any later run to verify.
- `duplicates` lists the other open marker issues on a reuse, each once and never the selected one; a create or a stop lists `[]`.
- `conflicts` lists the issue IDs a stop is about, each once, else `[]`.

## Reason codes

| Code | Action | Meaning |
|---|---|---|
| `REUSE_MARKED` | reuse | The one open marker issue whose author has write access; copies by other authors are `duplicates` |
| `REUSE_SELECTED` | reuse | The open marker issue a maintainer named, confirmed against this listing |
| `CREATE_AUTHORIZED` | create | No open marker issue, and both authority gates pass |
| `MALFORMED_INPUT` | stop | No single `owner/repo` target |
| `MALFORMED_KEY` | stop | Not a `STY_<positive integer>` key |
| `FEAT_KEY_NOT_STORY` | stop | An `FT_<positive integer>` key, which names a feat |
| `STORY_NOT_FOUND` | stop | No Story document for the key |
| `STORY_ENVELOPE_INCOMPLETE` | stop | Unusable `key`, `docPaths` or `lifecycleStatus` |
| `STORY_KEY_MISMATCH` | stop | The resolved document is a different Story, or its key is not a string |
| `STORY_AMBIGUOUS` | stop | More than one document claims the key |
| `STORY_TERMINAL` | stop | `superseded` or `retired`, refused without redirect |
| `LOOKUP_INCOMPLETE` | stop | The listing did not finish |
| `MALFORMED_CANDIDATE_SET` | stop | `candidates` is not a list |
| `MALFORMED_CANDIDATE` | stop | A shapeless row, a repeated number, or a URL that is not this repository's issue URL for that number |
| `CANDIDATE_IDENTITY_UNREADABLE` | stop | A row's `body` was not fetched |
| `CANDIDATE_STATE_UNKNOWN` | stop | A row's `state` is neither `open` nor `closed` |
| `CANDIDATE_LOCK_UNKNOWN` | stop | A row carries no boolean `locked` |
| `MARKER_UNREADABLE` | stop | An open row's first line nearly is this Story's marker |
| `CANDIDATE_PROVENANCE_UNKNOWN` | stop | An open marker row carries no fetched `authorPermission` |
| `DUPLICATE_MARKERS` | stop | Two or more open marker issues by authors with write access |
| `MARKER_PROVENANCE_UNCERTAIN` | stop | Open marker issues exist, but none by an author who has write access now |
| `SELECTION_MISMATCH` | stop | The maintainer selection names another Story, no usable number, or an issue without this Story's open marker |
| `ISSUE_LOCKED` | stop | The selected marker issue is locked |
| `CREATE_NOT_AUTHORIZED` | stop | No open marker issue and no creation authority |
| `INSUFFICIENT_PERMISSION` | stop | Authorized, but the permission cannot open an issue, or a selection comes without write access |
