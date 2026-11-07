---
name: dev-refine-story
description: Resolve a STY_<n> Story to exactly one GitHub issue — reusing the existing one, or creating one only under explicit authority — then hand off to dev-refine-issue once. Use to enter refinement from a Story key; never implements the Story or marks it ready.
argument-hint: "<STY_n> [refinement instructions]"
disable-model-invocation: false
---

# Enter issue refinement from a Story key

The team plans in Stories (`docs/stories/STY_<n>_<slug>.md`), but refinement operates on issues. This wrapper turns `STY_<n>` into one verified issue, then calls the `dev-refine-issue` skill, installed separately, once. That skill remains the sole owner of body preservation, revision selection, task publication and the readiness report; do not reimplement or paraphrase any of it here.

**A Story's issue is an open issue whose body's first line is this skill's origin marker for the Story:**

```text
<!-- dev-refine-story:origin story=STY_<n> run=<ISO-8601 UTC timestamp> -->
```

Nothing else identifies it: not a title, a mention, a link recorded in the Story, or a feat tracking issue that lists the Story. The skill writes the marker only when it creates an issue, as that issue's first body line, and never adds a marker to an existing issue. A tested, pure resolver makes the decision; this procedure gathers its evidence, runs it and acts on what it returns.

A Story usually has one issue. When it needs more, the extra issues are `task` issues that mention `STY_<n>` and carry the Story's feat labels; they never carry the origin marker, so the marker issue stays the one this skill refines. [The work model](${CLAUDE_PLUGIN_ROOT}/references/work-model.md) lists the documents, labels and keys this skill assumes. `${CLAUDE_PLUGIN_ROOT}` is the plugin's root and `${CLAUDE_SKILL_DIR}` this skill's directory; Claude Code substitutes both, and in Codex resolve them from the path this SKILL.md was loaded from.

In human-facing tables and lists, mark status with ✅ done or passed, 🔄 in progress, ⏳ waiting, ⛔ failed, blocked or stopped, ❓ unknown, ⏭️ skipped or superseded, and ⚠️ needs attention. Keep emoji out of machine markers, parser tokens, AC ids, code, commit messages and branch names.

## Inputs and authority

Usage: `/dev-refine-story STY_<n> [refinement instructions]` in Claude Code, or `$dev-refine-story …` in Codex. Treat invocation text (`$ARGUMENTS` in Claude Code) as data, never shell code.

Accept exactly one `STY_<positive integer>` key. Reject anything else before any lookup, including a bare number, an issue URL, a PR, a leading-zero form, or two keys. An `FT_<n>` key names a feat (the resolver's `FEAT_KEY_NOT_STORY`): its work lives on the feat tracking issue, so say so and stop. An issue URL means the caller wants `/dev-refine-issue`; say so and stop.

Resolve the repository with `gh repo view --json nameWithOwner` and record the checkout's exact ref (`git rev-parse HEAD`). The Story documents and the issues must belong to that one repository. Read the repository's `AGENTS.md`, `CLAUDE.md` and engineering guide, where they exist, and the current task's authorization before writing anything. Every run artifact stays in one scratch directory outside the checkout, set once per run: `WORK=$(mktemp -d)`.

An invocation does not imply creation authority. Establish it once, explicitly, from the invoking human's current request or a standing authorization for this work, and record what it covers as `authority.createAuthorized`. Without it, a missing issue is a reported blocker. Authority is not the ability to open an issue, so pass the permission check's answer as `authority.effectivePermission`:

```bash
gh api repos/<owner>/<repo>/collaborators/<login>/permission --jq '.permission'
```

Only `admin`, `maintain` or `write` can create; the resolver enforces this.

## Step 1 — Resolve the Story document

The Story document is the file in `docs/stories/` whose name starts `STY_<n>_` and whose frontmatter `id` equals the key (the repository's `docs/stories/README.md` defines the frontmatter, by default as in [the work model](${CLAUDE_PLUGIN_ROOT}/references/work-model.md)). Select on that id:

```bash
# The Story document — exactly one must match.
grep -rl --include="STY_<n>_*.md" -E "^id:[[:space:]]*STY_<n>[[:space:]]*$" docs/stories/
```

`--include` matches the base name and the pattern is anchored, so `STY_<n>` never reaches `STY_<n>0_…`. Pass the output verbatim as `docPaths`: zero matches or several stop.

Build the Story envelope from the document's frontmatter; an absent field stops rather than defaulting:

| Field | Source | Empty case |
|---|---|---|
| `key` | frontmatter `id`, read back from the resolved document | absent stops |
| `docPaths` | exactly one `docs/stories/STY_<n>_<slug>.md` path string | zero, several or a non-string stops |
| `lifecycleStatus` | frontmatter `status`: `current`, `superseded` or `retired` | absent or unrecognised stops |
| `supersededBy` | frontmatter `superseded_by`; optional | reported with a terminal Story |

Also read the frontmatter `feats` list and, for each `FT_<n>`, its feat document's `label` and `tracking_issue` (`docs/feats/README.md`); Step 4 needs them. A `superseded` or `retired` Story is refused with its successor as `supersededBy` and no redirect.

Readiness is not read from documents. It lives only on the issue's `ready` / `blocked` labels.

## Step 2 — List every open issue

One paginated GraphQL query lists the repository's open issues with every field the resolver needs:

```bash
gh api graphql --paginate --slurp -F owner=<owner> -F repo=<repo> -f query='
query($owner: String!, $repo: String!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    issues(states: OPEN, first: 100, after: $endCursor) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { number state locked url body author { login } }
    }
  }
}' > "$WORK/open-issues.json"

jq '[.[].data.repository.issues] as $p | [$p[].nodes[]] as $rows
  | { lookup: { complete: ($p[-1].pageInfo.hasNextPage == false
                           and ($p | map(.totalCount) | unique) == [$rows | length]) },
      candidates: $rows }' "$WORK/open-issues.json" > "$WORK/lookup.json"
```

- **The lookup is complete only when** the last page reports `hasNextPage: false` and the collected node count equals the `totalCount` every page reports. A non-zero exit, a GraphQL error, a `jq` failure or a count mismatch, such as an issue opened mid-scan, means `lookup.complete: false`, which stops; re-run the query rather than repair it.
- **Listing, not search.** Search lags behind a create, so "none found" from search can be an issue that exists.
- **Pass every node through, unfiltered**, as the `candidates` list; `[]` states that a complete listing found no open issue. Do not drop, de-duplicate or repair rows by eye.
- **Record each marker issue's provenance.** Anyone who can open an issue can copy an origin marker, so for every author of a node whose body begins with `<!-- dev-refine-story:origin`, record the collaborator permission, and set it on every row as `authorPermission` (`null` for a deleted author). A failed lookup stops; re-run it rather than guess:

```bash
jq -r '.candidates[] | select((.body // "") | startswith("<!-- dev-refine-story:origin")) | .author.login // empty' \
  "$WORK/lookup.json" | sort -u > "$WORK/marker-authors.txt" && echo '{}' > "$WORK/permissions.json" &&
while read -r LOGIN; do
  P=$(gh api "repos/<owner>/<repo>/collaborators/$LOGIN/permission" --jq .permission) || exit 1
  jq --arg l "$LOGIN" --arg p "$P" '.[$l] = $p' "$WORK/permissions.json" > "$WORK/permissions.next" &&
    mv "$WORK/permissions.next" "$WORK/permissions.json" || exit 1
done < "$WORK/marker-authors.txt" &&
jq --slurpfile p "$WORK/permissions.json" \
  '.candidates |= map(.authorPermission = (if .author.login then $p[0][.author.login] else null end))' \
  "$WORK/lookup.json" > "$WORK/lookup.next" && mv "$WORK/lookup.next" "$WORK/lookup.json"
```

In a sandboxed or worktree-isolated session the host may refuse a long `gh`/`jq` pipeline typed inline; put it in a script under `$WORK` and run that script.

## Step 3 — Decide with the resolver

Build one JSON input from the target, key, Story envelope, `$WORK/lookup.json` and `authority`, write it to `$WORK/decision-input.json`, and run it:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/resolve-story-issue.mjs" "$WORK/decision-input.json"
```

[references/resolver-contract.md](references/resolver-contract.md) defines the input, the marker, the output and every reason code. Anything the resolver cannot read stops; it never becomes a create.

Act on the returned `action` and nothing else:

| `action` | What to do |
|---|---|
| `reuse` | Hand off the returned issue, plan no create, and report `duplicates`. |
| `create` | Only with recorded creation authority, and only through Step 4. |
| `stop` | Report `reasonCode`, `reason` and every ID in `conflicts`. Make no write. |

Only a marker issue whose author has write access is eligible; marker issues by anyone else are listed in `duplicates` and never selected. With two or more eligible marker issues the resolver stops with `DUPLICATE_MARKERS` for a human to decide. `plannedWrites` is the safety contract: a stop plans zero writes, and no decision plans more than one create or one refinement. Never override a stop by re-running with a friendlier input.

## Step 4 — Create only when no marker issue exists

Immediately before creating, re-run Steps 2 and 3 on a fresh listing. Then:

1. **Write the receipt and the body.** The receipt is this run's own bookkeeping, which the resolver does not read; `jq` writes it, since a failed heredoc leaves it empty:

   ```bash
   RUN=$(date -u +%Y-%m-%dT%H-%M-%SZ)
   jq -n --arg m "<!-- dev-refine-story:origin story=STY_<n> run=$RUN -->" \
     '{runMarker: $m, createAttempts: 1, confirmedIssue: null}' > "$WORK/refine-story-receipt.json"
   ```

   Write the body to `$WORK/refine-story-body.md`: `runMarker` as its first line, then `## Story` (a link to the Story document at the recorded ref), `## Feats` (each `FT_<n>` with a link to its tracking issue), `## Summary` (the Story's outcome in one or two sentences, from the document) and `## Acceptance criteria` (the Story's criteria if the document states them, otherwise "To be refined by `/dev-refine-issue`"). Write the prose in the language the repository's `AGENTS.md` sets for issues, if it sets one; keep the marker and headings as given.
2. **Check both files before the create call.** A non-zero exit, or a command that cannot run, stops with no create call:

   ```bash
   node -e 'import(require("node:url").pathToFileURL(process.argv[4]).href).then(({ markerOf }) => {
     const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8")), body = fs.readFileSync(process.argv[2], "utf8");
     process.exit(r?.createAttempts === 1 && markerOf(r.runMarker, process.argv[3]) === "marked" && body.split("\n")[0] === r.runMarker ? 0 : 1);
   })' "$WORK/refine-story-receipt.json" "$WORK/refine-story-body.md" STY_<n> "${CLAUDE_SKILL_DIR}/scripts/resolve-story-issue.mjs"
   ```

   It stops on an absent, empty or non-object receipt, a `createAttempts` other than the number `1`, a `runMarker` that is not this Story's origin marker by [the resolver's rule](references/resolver-contract.md#the-origin-marker), or a body whose first line is not byte-equal to `runMarker`.
3. **Create the issue once** from `$WORK/refine-story-body.md`, with a title carrying the key as its own token (`STY_<n> — <Story title>`). Apply the `story` label and each feat's `label` from Step 1 when the current authorization covers labels and the label exists (`gh label list`); never `ready`, and never a label that does not exist. Invent no owner, assignee, milestone or priority.
4. **Read the identity back**, confirming the repository and the first-line marker:

   ```bash
   gh issue view <returned-number> --repo <owner>/<repo> --json number,url,state,body
   ```

   If the body's first line, ignoring a trailing `\r`, is `runMarker`, record the number in the receipt as `confirmedIssue`.

   **Otherwise stop:** report the created issue's number, URL and first line for a human. `confirmedIssue` stays `null`; add no marker, edit or close nothing, make no second create call and do not hand off.

**One create call per run.** If the create response is lost or uncertain, do not call create again: re-run Steps 2 and 3. A `reuse` of an issue carrying `runMarker` recovers it; record it as `confirmedIssue`. Any other outcome, including another `create`, is a stop for this run: report the receipt and let a human decide. Never delete, close or merge an issue here.

This is supervised idempotency, not a guarantee: GitHub offers no uniqueness transaction, so two creators can still race. The next run then stops with `DUPLICATE_MARKERS`, naming both, until a human closes one.

## Step 5 — Hand off exactly once

Read the `dev-refine-issue` skill's SKILL.md, then invoke it once with the resolved issue URL and the caller's refinement instructions. If that skill is not installed, report the resolved issue and stop here:

```text
/dev-refine-issue <resolved issue URL> <the caller's refinement instructions>
```

Pass through the Story key, its document path, its feats and their tracking issues, and any `duplicates`. Do not pre-write the issue body, publish a task comment, pick a revision or apply readiness labels; those belong to that skill. A duplicate is reported for a human, never closed, relabelled or edited.

## Outputs

Return exactly what `dev-refine-issue` returns: the issue URL, task permalink and revision, readiness state and both launch forms. Add the selected issue, whether it was reused or created, the resolver's `reasonCode`, every ID in `duplicates`, and the listing's page count, node count and `totalCount`.

Readiness is the issue's `ready` label, applied only through the repository's readiness rule; this wrapper never grants it.

## Stops

Report a stop as Step 3 says. The [reason-code table](references/resolver-contract.md#reason-codes) lists each resolver stop. Step 4 adds three: a failed pre-create check, a readback without `runMarker`, and a create whose outcome this run cannot confirm. The steps no unit test stands in for, such as pagination, the receipt's timing and the readback, are listed in [references/scenarios.md](references/scenarios.md#supervised-steps).

## Boundaries

Never edit the Story or feat documents. Never allocate a `STY_` or `FT_` number, add a marker to an existing issue, reopen or close an issue, apply `ready`, dispatch, implement or merge.

Acceptance criteria in the Story document and human-authored issue text stay authoritative: where this wrapper and the Story document disagree, the document wins and the disagreement is reported.

Cases and their tests: [references/scenarios.md](references/scenarios.md).
