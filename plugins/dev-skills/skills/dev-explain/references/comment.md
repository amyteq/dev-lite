# Result comment template

Read the [skill](../SKILL.md) first. Fill every slot; never publish a slot, an estimate or an invented link.

- **Language.** Tables, including their column headings, and lists, in any slot, use the effective language. Section and item headings, the header table, the footer and prose stay English. Identifiers, code, paths and quoted source text stay exactly as written, apart from the code spans around handles. When the effective language is not English, keep the non-normative sentence below and name the language in English, such as "Chinese (China)"; when it is English, leave that sentence out.
- **People.** Write every GitHub handle in a code span, quoted text included, such as `` `@octocat` ``, never as a live mention: posting would notify them, and this comment asks nobody to act.
- **Format.** Short SHAs have 8 characters. Escape `|` as `\|` inside table cells. Leave a blank line before any thematic `---` separator; the publication check enforces it.
- **Size.** A GitHub comment holds at most 65,536 characters (`wc -m`). Over that, shorten backgrounds and examples; never split the answer across comments.
- **Optional parts.** Include the notes block and the *Notes* section only when notes are present. One English paragraph before the first item may explain how the sources' identifiers relate, such as `Q-2` restating `OD-1`.

## Option comparison

Use one or more matrices per item: one row for each dimension below and one column per option. With more than four options, split them across matrices and repeat every dimension. Use the effective language for option names, column headings and dimension labels, mark options constructed by this explanation, and fill every cell; when evidence is unavailable, say `unknown` in the effective language and explain why.

| Dimension | What every option's cell states |
|---|---|
| Difference | What this option does differently from the status quo and the other options. |
| Risk | Credible failure modes, downsides and affected parties. |
| Impact | Expected effects on users, workflows, data, architecture and delivery. |
| Required effort | Relative implementation, migration, validation and ongoing operating effort. |
| Consistency | Alignment or conflict with existing design, conventions and recorded decisions. |
| Backward compatibility | Effects on existing behavior, data, integrations and contracts, including migration needs. |
| Irreversibility | How difficult, costly or lossy the option would be to undo. |
| Flexibility | What is configurable or extensible, what would be hard-coded, and which future choices remain open. |

````markdown
## Pending decisions explained — TYPE on #N

| Field | Value |
|---|---|
| Skill | `dev-explain` |
| Target | [Issue, PR or Discussion #N](TARGET_URL) · open, closed or merged · TITLE; with a named comment, [Discussion #N](TARGET_URL) · reply in the thread of [comment ID](COMMENT_URL) · open or closed · TITLE |
| Type | `TYPE` (argument, environment or default) |
| Language | `TAG` (argument, environment or default) |
| Notes | `none`, or "verbatim below" |
| Warnings | `none`, or each warning in a code span, separated by `<br>` |
| Read at | `main` [`SHA8`](COMMIT_URL), then every other commit read, such as PR #M head [`SHA8`](COMMIT_URL) |

NOTES, verbatim, in a `text` fence longer than any backtick run they contain.

This comment explains pending decisions; it decides nothing and changes no contract. A decision takes effect only through the repository's canonical route. Content written in LANGUAGE NAME is non-normative human reference.

### IDENTIFIERS — SHORT NAME

Source: [WHERE IT IS DEFINED](LINK), and each further link that defines it.

**Status.** Pending, proposed but not yet binding (say where and what would make it binding), or `status unknown`.

**Background.** What is being decided, why it matters now and the facts it rests on, each with its source.

The option-comparison matrix defined above, with all eight dimensions for every option.

**Example.** At least one simple, concrete example that shows the difference between the options.

**Recommendation.** The recommendation, its reason and whose it is — each sourced recommendation with its link, and this explanation's own labelled as such — or "No recommendation", with the reason.

Repeat for each item. An item without an identifier is headed by a short descriptive name followed by `(no ID)`. When there is no item, replace the item sections with "No pending TYPE item was found.", or with a named comment "No pending TYPE item was found in the named comment."

### Sources and exclusions

A list, in the effective language: the sources read, then each item left out, with its reason — resolved (where), another type, or out of scope. With a named comment, link it and group the items found only outside it as one entry.

### Notes

The answer to each question in the notes, and for each instruction how it was applied or why it was not.

### Action report

A list, in the effective language: each write this run made besides this comment — the artifact link, the field, and the previous and new title, a summary of the appended text, or the labels added and removed — then each change considered but not made, with its reason, including suggestions for the human. When there is neither, a single item: none.

💡 AGENT·MODEL·EFFORT · STARTED · ELAPSED
````
