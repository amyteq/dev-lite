# The `ft-sty` work model

`dev-analyse-rp` and `dev-refine-story` plan into one work model, `ft-sty`: feats and stories kept as small Markdown docs with `FT_<n>` and `STY_<n>` keys, plus one GitHub tracking issue per feat and usually one issue per story. Version 0.1 supports only this model, and the values below are fixed in the skills and their scripts. When a repository documents the same files (`docs/feats/README.md`, `docs/stories/README.md`, `.github/labels.yml`), those files are its record of them; this page is the default they follow.

## Keys and docs

| | Feat | Story |
|---|---|---|
| Key | `FT_<n>` | `STY_<n>` |
| Doc | `docs/feats/FT_<n>_<snake_slug>.md` | `docs/stories/STY_<n>_<snake_slug>.md` |
| GitHub | One tracking issue, labels `feat` and its feat label | Usually one issue, labels `story` and its feats' labels |
| Created by | `/dev-analyse-rp` materialize step | Doc: the materialize step. Issue: `/dev-refine-story` |

- **Numbers** have no padding and start at 101; 1 to 100 are reserved. The two sequences are independent, and a number is never reused, even after its doc is retired.
- **Slugs** are lower-case `snake_case`, and each doc sits directly in its directory; `README.md` there is the index, not a doc.
- **Frontmatter** is the only machine-read planning state. It uses plain `key: value` lines, `key: [a, b]` lists, or `key:` followed by `  - item` lines; anything else stops the planning index.
- **Readiness and progress** live only on issues, never in a doc.

## Frontmatter

Feat:

| Field | Value |
|---|---|
| `id` | `FT_<n>`, equal to the file name's prefix |
| `title` | Short title |
| `label` | The feat label, `<area>:<feature>` in lower case |
| `tracking_issue` | The tracking issue's number, or `null` until it exists |
| `status` | `current`, `superseded` or `retired` |
| `superseded_by` | `FT_<n>` when `status` is `superseded`, otherwise `null` |

Story:

| Field | Value |
|---|---|
| `id` | `STY_<n>`, equal to the file name's prefix |
| `title` | Short title |
| `feats` | The feats it serves, at least one: `[FT_<n>, …]` |
| `status` | `current`, `superseded` or `retired` |
| `superseded_by` | `STY_<n>` when `status` is `superseded`, otherwise `null` |

No other key is allowed. Ids, feat labels and tracking issues are unique, and every `feats` or `superseded_by` key must have a doc.

## Templates

```markdown
---
id: FT_101
title: Task export
label: tasks:export
tracking_issue: 12
status: current
superseded_by: null
---

# FT_101: Task export

Tracking issue: #12 (story map, dependency map, open decisions, batches).

## Goal

One or two sentences: the outcome and who it serves.

## Scope

- In: …
- Out: …

## Stories

| Story | Title |
|---|---|
| [STY_101](../stories/STY_101_export_tasks_as_csv.md) | Export tasks as CSV |
```

```markdown
---
id: STY_101
title: Export tasks as CSV
feats: [FT_101]
status: current
superseded_by: null
---

# STY_101: Export tasks as CSV

Feats: [FT_101](../feats/FT_101_task_export.md).

## Outcome

As a <actor>, I can <capability>, so that <value>.

## Acceptance criteria

- AC-1: <named case> → <expected outcome>, shown by <test or artifact>.
```

Each directory's `README.md` keeps an `## Index` table: feats as `ID | Title | Feat label | Tracking issue | Status`, stories as `ID | Title | Feats | Status`.

## Labels and issues

| Label | Meaning |
|---|---|
| `feat` | A feat's tracking issue |
| `story` | A story's issue, opened by `/dev-refine-story` |
| `task` | Any other bounded piece of work, including a story's extra issues |
| `ready`, `blocked` | Readiness, applied only by the repository's readiness rule; these skills never apply either |
| `<area>:<feature>` | One per feat, colour `fbca04`, listed in `.github/labels.yml` under `# Feats` |

- A feat's **tracking issue** holds its story map, dependency map, open decisions and batches, and links its doc.
- A story's **issue** is the open issue whose first body line is `/dev-refine-story`'s origin marker. When a story needs more issues, the extra ones are `task` issues that mention `STY_<n>` and carry its feats' labels, and never the marker.
- `docs/adrs/` holds decision records and `docs/specs/` specifications; both are authority for what they record.
