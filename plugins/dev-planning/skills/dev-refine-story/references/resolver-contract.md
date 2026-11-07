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
    { "number": 205, "state": "OPEN", "locked": false, "url": "https://github.com/<owner>/<repo>/issues/205", "body": "<!-- dev-refine-story:origin story=STY_<n> run=2026-01-02T03-04-05Z -->\n…" }
  ],
  "authority": { "createAuthorized": false, "effectivePermission": "write" }
}
```

#205 is reused: its first line is the Story's marker, while #101 only mentions the Story.

- `repo` is one `owner/repo`; anything else is `MALFORMED_INPUT`.
- `storyKey` is `STY_<positive integer>` with no leading zero, trimmed and matched case-insensitively. An `FT_<positive integer>` key is `FEAT_KEY_NOT_STORY`; anything else is `MALFORMED_KEY`.
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

The Story's issues are the open rows whose first line is marked. The title, a mention in the body, a marker on a later line, a closed marker issue and a feat tracking issue listing the Story never select an issue and never block a create.

- **One or more:** the newest, the highest number, is selected. Every other open marker issue is listed in `duplicates`, ascending, for a human to reconcile. A locked selected issue is `ISSUE_LOCKED`, naming it; a locked duplicate changes nothing.
- **None:** without `createAuthorized: true`, `CREATE_NOT_AUTHORIZED`; with it but without write permission, `INSUFFICIENT_PERMISSION`; otherwise `CREATE_AUTHORIZED`.

The whole order is: target, key, Story envelope, lookup, candidate set, row gates, unreadable marker, selection, create gate.

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
- `issue` and `selected` name the reused issue, else `null`.
- `duplicates` lists the other open marker issues on a reuse, each once and never the selected one, else `[]`.
- `conflicts` lists the issue IDs a stop is about, each once, else `[]`.

## Reason codes

| Code | Action | Meaning |
|---|---|---|
| `REUSE_MARKED` | reuse | The newest open marker issue; others are `duplicates` |
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
| `ISSUE_LOCKED` | stop | The selected marker issue is locked |
| `CREATE_NOT_AUTHORIZED` | stop | No open marker issue and no creation authority |
| `INSUFFICIENT_PERMISSION` | stop | Authorized, but the permission cannot open an issue |
