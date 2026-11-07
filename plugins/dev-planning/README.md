# dev-planning

Planning skills for the `ft-sty` work model: feats (`docs/feats/FT_<n>_<slug>.md`) and stories (`docs/stories/STY_<n>_<slug>.md`) are source-controlled, and each feat has a GitHub tracking issue with sub-issues and labels. Decisions go in `docs/adrs/`, designs in `docs/specs/`. See [`references/work-model.md`](references/work-model.md).

| Skill | Use it to |
| --- | --- |
| `dev-analyse-rp` | Analyse a requirements programme into a reviewed proposal of feats and stories, then, on explicit authorization, materialize the docs, labels and tracking issues in one docs PR. |
| `dev-refine-story` | Create the issue for one `STY_<n>` story from its doc, then hand it to `dev-refine-issue` (in the `dev-skills` plugin). |

Install `dev-skills` alongside this plugin. Paths, labels and key formats are fixed to the `ft-sty` defaults in v0.1; making them configurable and adding an issues-only `free` mode is tracked separately.

## Setup and test

The helper scripts need Node.js 20+ and one locked npm package. Claude Code installs it from the plugin's `package-lock.json`; with Codex, run `npm ci --prefix "<installed plugin folder>"` once after installing or updating. In this repository: `npm ci && npm test`.
