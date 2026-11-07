# dev-skills

Four agent skills for GitHub-centred work in Claude Code and Codex.

| Skill | Use it to |
| --- | --- |
| `dev-review-pr` | Run bounded review and fix rounds on a PR with independent Codex or Claude Code sessions, evidence-linked dispositions and a final full review before approval. |
| `dev-refine-issue` | Turn an existing issue into a bounded work order with observable acceptance criteria, a task comment and copyable launch prompts. |
| `dev-explain` | Explain pending human decisions on an issue, PR or discussion comment and append one result comment. It decides nothing. |
| `dev-compact` | Compress a long issue, PR or discussion thread into a summary and archive parts, after an explicit request. |

Each skill reads the consuming repository's `AGENTS.md` / `CLAUDE.md` for project rules.

**Authority.** A user's explicit request for a skill authorizes the bounded writes that skill describes (comments, issue edits, commits on the PR branch). A skill the model picks on its own writes nothing without asking. `dev-review-pr` runs the writer and reviewer on different providers; a same-provider pair runs only when the owner chooses it.

## Setup

The helper scripts need Node.js 20+ and one locked npm package. Claude Code installs it from the plugin's `package-lock.json` when the plugin is installed. Codex does not; run `npm ci --prefix "<installed plugin folder>"` once after installing or updating.

The skills also need `gh` (authenticated), and `dev-review-pr` needs the `claude` and/or `codex` CLI for the sessions it launches.

## Test

```bash
npm ci && npm test
```
