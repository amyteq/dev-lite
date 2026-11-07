# Plan format

Read the [skill](../SKILL.md) first. The plan is one JSON object that `check-compact.mjs plan` checks against the body it was made from. An unknown key, a missing key or a value of the wrong type exits `2`; a rule it breaks exits `1` with every violation listed.

```json
{
  "repo": "OWNER/REPO",
  "target": { "kind": "issue", "number": 888 },
  "login": "RUNNING_LOGIN",
  "time": "2026-10-15 11:30 UTC",
  "level": "medium",
  "wrap": "soft",
  "threshold": 49152,
  "blocks": {
    "b1": { "category": "protected", "disposition": "keep" },
    "b2": { "category": "current", "disposition": "keep" },
    "b3": { "category": "log", "disposition": "move" },
    "b4": { "category": "history", "disposition": "summarize" },
    "b5": { "category": "log", "disposition": "fold", "note": true }
  },
  "body": [
    { "block": "b1" },
    { "block": "b2" },
    { "text": "Round-by-round review log: [moved to part 1]({{part:1}})." },
    { "text": "The scope changed twice before the owner's 12 Oct ruling; [the full history]({{part:1}})." },
    { "text": "<details><summary>Validation output</summary>" },
    { "block": "b5" },
    { "text": "</details>" }
  ],
  "archives": [
    { "title": "**Moved from the body of #888** on 2026-10-15 by `dev-compact` at level `medium`: the review log and the scope history.", "items": [{ "block": "b3" }, { "block": "b4" }] }
  ],
  "hides": []
}
```

## Fields

| Field | Value |
|---|---|
| `repo`, `login` | The resolved repository and the running login |
| `target` | `kind` is `issue`, `pr` or `discussion`, as verified in step 2; `number` the target number |
| `time` | The run's start in UTC, `YYYY-MM-DD HH:MM UTC`; it becomes the calls-table row |
| `level`, `wrap`, `threshold` | The values `args` resolved, unchanged |
| `blocks` | One entry for every block `segment` listed, except the calls table: `category`, `disposition`, and `note: true` when a note asked for this change |
| `body` | The new body in order. `{ "block": ID }` places a block's text; `{ "text": "…" }` is text this run writes: a pointer, a summary, a `<details>` wrapper or a short heading, with `"note": true` when a note asked for it |
| `archives` | Groups of moved text. Each has a Markdown `title`, `items` in the same two forms, and in a discussion an optional `replyTo`: the node ID of the top-level comment the part answers |
| `hides` | Discussion only: `id` (comment node ID), `author` (login), `classifier` (`RESOLVED`, `OUTDATED` or `DUPLICATE`), and `note: true` when a note names that comment |

## Rules the helper checks

- Every block has exactly one entry. `keep` and `fold` blocks appear exactly once in `body`; `move` and `summarize` blocks exactly once in `archives`; `condense` and `discard` blocks nowhere. The replacement text of `summarize` and `condense` is a `text` item.
- A `fold` block sits between a `<details>` text item and its `</details>`; a `keep` block sits outside every `<details>`.
- Protected blocks keep their original relative order. Other blocks may be reordered, for example to put the status first.
- A `text` item contains no `<!--` and no `@` followed by a letter or digit. Name people by login without `@`.
- Below the threshold every text item needs `note: true`, and blocks without a note keep their original order.
- `{{part:N}}` in a body text item becomes the permalink of archive part N once it is posted. No other place may hold it or `{{size:after}}`: a kept or folded block that quotes either is refused, and must move instead. Parts are numbered across all groups in order; a group longer than one comment continues in the next part, whose title gains "(continued)". Check the numbering in `plan.out.json` before writing pointers that name a later part.
- A part is split only between items, so one item longer than about 65,000 characters is refused.
- The new body, with 160 characters reserved for each link, fits GitHub's limit: 65,536 characters for an issue or PR, and the larger of that and the old length for a discussion.

## Judgement the helper cannot check

- **Categories.** A ledger, a status table or a live link list is `current`, however long. A round-by-round review record is `log`. An amendment record or a ruling that a later one replaced is `history`; the current ruling is `protected`.
- **Summaries.** State only what the original says, with its numbers and identifiers, updated only by a later amendment recorded in the same body, which the summary names; and name where the original went. Never add a fact, a recommendation or a decision.
- **Titles.** Say what left the body, from which target, when and at which level, so a reader of the part alone understands it. In an issue or PR, link the comment the part relates to, because a reply is not available there.
- **Hides.** Hide a discussion comment only when it is resolved, outdated or duplicated by something still visible, and say which in the result comment. When unsure, leave it shown and list it under "Your call".

## Output

On success `plan.out.json` holds `size.before` and `size.afterAtMost`, the parts with their files, sizes and `replyTo`, the `changed` blocks (`summarize`, `condense` and `discard`, with size and first words for the result comment) and the hides. `--out` holds `body.template.md`, `part-N.md` and `manifest.json`, which `render` reads. `no-change` writes nothing to `--out`.
