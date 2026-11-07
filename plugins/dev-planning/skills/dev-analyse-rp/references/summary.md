# Summary comment

When the request pack is an issue or a discussion in the current repository, a run ending `proposal_complete` or `proposal_blocked` posts one signed summary of its packet on that issue or discussion, then hides our earlier summaries and results there as `OUTDATED`. A feat's tracking issue gets the full result instead, by [result-comment.md](result-comment.md). The token `no-publish` right after the target turns posting off, and `dry-run` renders and checks the payload without writing. These are the run's only remote writes; the materialize step ([materialize.md](materialize.md)) is a separate, explicitly authorized write.

[`summary-comment.mjs`](../summary-comment.mjs) makes the deterministic decisions; `H` below stands for `node "${CLAUDE_SKILL_DIR}/summary-comment.mjs"`. Exit `0` proceeds, `1` stops and `2` means the check did not run; every non-zero exit blocks the write after it. "Ours" means a comment by the running `gh` login. Below, `KIND` is `issue` or `discussion`, and where the two differ the issue form comes first.

## 1. At binding

Before analysing, record the start and run id. Write the invocation text after the target to `$S/rest.txt` by a file write, never a shell argument, and classify its first token:

```bash
date +%s > $S/started.epoch && date '+%Y-%m-%d %H:%M %Z' | tr -d '\n' > $S/started &&
printf '%s-%s' "$(date -u +%Y%m%dT%H%M%SZ)" "$(git rev-parse HEAD | cut -c1-8)" > $S/started.run &&
H args --file $S/rest.txt
```

Exit `1` is a near miss such as `--no-publish` or `dry_run`: stop before analysis, naming it. Otherwise `noPublish` and `dryRun` set the publish mode the packet's Output authority records, and `instructions` holds the analysis instructions. Then classify an issue target ([result-comment.md](result-comment.md) §1); a feat tracking issue continues there. A discussion target is never classified: it always gets a summary.

## 2. Whether to post

| Case | Outcome |
|---|---|
| Issue target that is not a feat tracking issue, or a discussion target; no token; verdict `proposal_complete` or `proposal_blocked`; `locked: false`; complete scan; `select` returns `post`; both checks exit `0` | Post one comment, on an open or closed issue, or on any discussion |
| `no-publish`, or a local pack path | No remote write |
| `dry-run` | No remote write; §5's checks run, and `$S/summary.md` and its post command stay in scratch |
| The model selected this skill on its own, without the invoking human's explicit request for it | No remote write unless the invoker answers yes to [result-comment.md §4](result-comment.md#4-the-ask-when-the-invocation-forbids-github-changes)'s ask; until then, as `dry-run` |
| A PR, another repository, or a number that names a PR | Stop before analysis |
| Verdict `analysis_stopped`, or a locked issue or discussion | No remote write; the report says why |
| Incomplete scan, `select` other than `post`, or a check exiting `1` or `2` | No post until a corrected payload passes |

## 3. Scan and select

Read every top-level comment page through GraphQL, since REST issue comments lack the minimized state and discussions have no REST comments. Our summaries are always top-level comments, so replies are not scanned here. `locked` must be `false`, and `scanComplete` is `true` only because the scan exited `0`.

Issue:

```bash
gh api repos/OWNER/REPO/issues/N --jq .locked &&
gh api graphql --paginate --slurp -F owner=OWNER -F repo=REPO -F n=N -f query='query($owner: String!, $repo: String!, $n: Int!, $endCursor: String) { repository(owner: $owner, name: $repo) { issue(number: $n) { comments(first: 100, after: $endCursor) { nodes { databaseId id author { login } isMinimized body } pageInfo { hasNextPage endCursor } } } } }' > $S/scan.json &&
jq --arg repo OWNER/REPO --argjson n N --arg login "$(gh api user --jq .login)" --rawfile run $S/started.run \
  '{repo: $repo, issue: $n, login: $login, run: $run, scanComplete: true, comments: [.[].data.repository.issue.comments.nodes[] | {id: .databaseId, nodeId: .id, author: .author.login, minimized: .isMinimized, body}]}' \
  $S/scan.json > $S/select.json &&
H select --input $S/select.json
```

Discussion — the same scan, also printing the discussion's node id and `locked` from the first page:

```bash
gh api graphql --paginate --slurp -F owner=OWNER -F repo=REPO -F n=N -f query='query($owner: String!, $repo: String!, $n: Int!, $endCursor: String) { repository(owner: $owner, name: $repo) { discussion(number: $n) { id locked comments(first: 100, after: $endCursor) { nodes { databaseId id author { login } isMinimized body } pageInfo { hasNextPage endCursor } } } } }' > $S/scan.json &&
jq -r '.[0].data.repository.discussion | .id, .locked' $S/scan.json &&
jq --arg repo OWNER/REPO --argjson n N --arg login "$(gh api user --jq .login)" --rawfile run $S/started.run \
  '{repo: $repo, discussion: $n, login: $login, run: $run, scanComplete: true, comments: [.[].data.repository.discussion.comments.nodes[] | {id: .databaseId, nodeId: .id, author: .author.login, minimized: .isMinimized, body}]}' \
  $S/scan.json > $S/select.json &&
H select --input $S/select.json
```

`select` reads first lines only and returns `post`, `adopt` with this run's comment, or `stop`. `hide` lists our earlier, unminimized summaries and results of this target; `foreign` lists other logins' markers, never touched; `unrecognised` lists summary-like or result-like first lines of ours it cannot read, and empties `hide`. A summary names its target's kind, so an issue's summary is never one of a discussion's of the same number. Before the post it must return `post`.

## 4. Assemble

Write `$S/summary.md` from this template, in this order, replacing every slot:

````markdown
<!-- dev-analyse-rp:summary repo=OWNER/REPO KIND=N run=RUN -->
## `/dev-analyse-rp` summary — #N PACK-TITLE

**Verdict:** `VERDICT` — one sentence.

**Baseline:** `OWNER/REPO` at `REF`, [`FULL-SHA`](https://github.com/OWNER/REPO/commit/FULL-SHA) · planning index `DIGEST` (feat F · story S)

**Coverage:** included I · owned O · existing X · deferred D · blocked B

**Existing homes:** per relation, `new` included, its count and home keys.

**Units:**

| Unit | Slice | Home | Outcome |
|---|---|---|---|

Critical path: `U-a → U-b`.

**Open decisions:** id, one-line question and blocked units, any D-a new-feat question included; or none.

**Checks:** `check-proposal.mjs` exit X · `verify-homes` exit Y

**Packet:** scratch directory `DIRECTORY-NAME` on the invoking host; not published.

---
🧭 AGENT·MODEL·EFFORT · [SHORT-SHA](https://github.com/OWNER/REPO/commit/FULL-SHA) · STARTED · ELAPSED
````

Leave out pack text beyond source titles and one-line decision questions, other packet content and every absolute local path. Put handles in code spans, so the post notifies nobody. Fill the footer last, from `$S/started` and `$S/started.epoch`. `AGENT` is the CLI actually running, `claude` or `codex`; `MODEL` and `EFFORT` come only from what the session reports, never from self-identification or launcher flags; `ELAPSED` is measured just before the publication check, as `e=$(( $(date +%s) - $(cat $S/started.epoch) )); printf '%d:%02d\n' $((e / 3600)) $((e % 3600 / 60))`. An unobservable field is `unknown`, never estimated.

## 5. Check, post and read back

Check, passing `--issue N` or `--discussion N` to match the marker:

```bash
H outgoing --body $S/summary.md --repo OWNER/REPO --issue N --run "$(cat $S/started.run)" --baseline FULL-SHA &&
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-publication.mjs" --body-file $S/summary.md
```

Then post on the issue, or on the discussion by the node id §3 printed:

```bash
gh api repos/OWNER/REPO/issues/N/comments -X POST -F body=@$S/summary.md > $S/post.json
gh api graphql -F id=DISCUSSION-NODE-ID -F body=@$S/summary.md -f query='mutation($id: ID!, $body: String!) { addDiscussionComment(input: {discussionId: $id, body: $body}) { comment { id databaseId url } } }' > $S/post.json
```

On exit `1`, fix your own text and rerun both checks. Then read the comment back and compare bytes — an issue comment by its `id`, a discussion comment by its node id:

```bash
gh api repos/OWNER/REPO/issues/comments/ID > $S/readback.json && jq -j .body $S/readback.json > $S/readback.md && cmp $S/readback.md $S/summary.md
gh api graphql -F id=COMMENT-NODE-ID -f query='query($id: ID!) { node(id: $id) { ... on DiscussionComment { body } } }' > $S/readback.json && jq -j .data.node.body $S/readback.json > $S/readback.md && cmp $S/readback.md $S/summary.md
```

## 6. Uncertain write

After a post with no response, an error or an unreadable response, re-scan (§3) before anything else:

- `adopt`: no second post. Read it back; if it differs from the payload, report that and edit or hide nothing.
- `post`: one more post. If that is uncertain too, re-scan once more: adopt as above, or report the post as not made and hide nothing.
- `stop`, or an incomplete re-scan: no post and no hide; report the IDs.

## 7. Hide earlier summaries

Only after the new comment reads back equal, re-scan. `select` must return `adopt` with the new id; otherwise hide nothing. Minimize each `hide` entry and read it back:

```bash
gh api graphql -F id=NODE-ID -f query='mutation($id: ID!) { minimizeComment(input: {subjectId: $id, classifier: OUTDATED}) { clientMutationId } }' &&
gh api graphql -F id=NODE-ID -f query='query($id: ID!) { node(id: $id) { ... on IssueComment { isMinimized minimizedReason } ... on DiscussionComment { isMinimized minimizedReason } } }'
```

A failed call, or a read-back other than `isMinimized: true`, is reported as not hidden and never retried; the new comment stands. Hide nothing outside `hide`, and never edit, delete or unhide a comment.

## 8. Report

Add to the session report: the publish mode; the permalink, or why nothing was posted; each hidden ID; and every `foreign` and `unrecognised` ID and write not made, with its reason.
