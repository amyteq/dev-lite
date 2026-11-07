# Result comment template

Read the [skill](../SKILL.md) first. Fill every slot; never publish a slot, an estimate or an invented link. The comment is English and soft-wrapped.

- **People.** Name people by login without `@`. `neutralize` adds a word joiner after any `@` left, including in the verbatim notes, so nobody is notified and no workflow starts.
- **Format.** Escape `|` as `\|` inside table cells. Leave a blank line before any thematic `---` separator; the publication check enforces it.
- **Size.** At most 65,536 characters. Over that, shorten the summaries of changed blocks; never split the result across comments.
- **Optional parts.** Include the notes block only when notes are present, and each list only when it has an entry.

````markdown
## Compacted — #N

| Field | Value |
|---|---|
| Skill | `dev-compact` |
| Target | [Issue, PR or discussion #N](TARGET_URL) · open, closed or merged · TITLE |
| Level | `LEVEL` (argument or default) |
| Threshold | THRESHOLD characters (argument or default) |
| Wrap | `soft` or `keep` (argument or default) |
| Notes | `none`, or "verbatim below" |
| Body | BEFORE → AFTER characters, or "unchanged: below the threshold" or "unchanged: no compaction needed" |
| Warnings | `none`, or each warning in a code span, separated by `<br>` |

NOTES, verbatim, in a `text` fence longer than any backtick run they contain.

One or two sentences: what the body now opens with, what left it and where it went, and that nothing was dropped (at `none`) or what was dropped.

| Request | Result |
|---|---|
| Compact at `LEVEL` | What the body now holds, and the archive parts: [Part 1 of K](PART_URL), each with what it holds |
| EACH NOTE, briefly | How it was applied, with links, or why it was not |

**Changes beyond moving text**, for you to check:

- Each `summarize`, `condense` and `discard` block: its disposition, size and first words, and where its original is, either an archive part or the edit history of the body.
- Each hidden comment, linked, with its classifier and the reason.
- Each write to another artifact: the link, the field, and the previous and new title, a summary of the appended text, or the labels added and removed.

**Not made:** each change considered or asked for but not made, with its reason and, when one exists, the route that would make it.

**Your call:**

1. Each uncertain hide, protection or category choice, and each follow-up only the owner can take.

GitHub's edit history keeps the previous body, under the body's "edited" menu.

🗜️ AGENT·MODEL·EFFORT · STARTED · ELAPSED
````

## Archive parts

The helper writes each part as its first line `<!-- dev-compact:archive kind=KIND n=N part=I/K -->`, the plan's title, and the moved blocks verbatim, joined as they were in the body. Later runs recognize a part by that first line and treat it as an earlier run's archive: link it, never edit it.
