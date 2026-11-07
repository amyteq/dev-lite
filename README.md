# dev-lite

Lightweight agent skills, hooks and GitHub workflows for small teams that work with Claude Code and Codex. One marketplace, several plugins; install only what a project needs.

| Plugin | What it adds |
| --- | --- |
| [`dev-skills`](plugins/dev-skills) | `dev-review-pr` (bounded review/fix rounds with independent sessions), `dev-refine-issue` (issue → bounded work order), `dev-explain` (explain pending decisions), `dev-compact` (compress an issue, PR or discussion thread) |
| [`dev-planning`](plugins/dev-planning) | `dev-refine-story` and `dev-analyse-rp` for feature/story planning (`FT_`/`STY_` docs, tracking issues and labels) |
| [`dev-hooks`](plugins/dev-hooks) | Guardrail and audit hooks for Claude Code |

GitHub Actions: a reusable "Ask agent" workflow ([`.github/workflows/ask-agent.yml`](.github/workflows/ask-agent.yml)) lets Claude Code or Codex answer mentions in issues, PRs and discussions. Copy the thin callers from [`templates/github/`](templates/github).

## Install

### Claude Code

Per project (shared with the team): merge [`templates/claude/settings.json`](templates/claude/settings.json) into the project's `.claude/settings.json`. Teammates are prompted to trust the marketplace on first run.

Per user:

```bash
claude plugin marketplace add https://github.com/amyteq/dev-lite.git#v0
claude plugin install dev-skills@dev-lite
```

Skills keep their bare names (`/dev-review-pr`) unless another installed skill has the same name; then use `/dev-skills:dev-review-pr`.

### Codex

```bash
codex plugin marketplace add amyteq/dev-lite --ref v0
codex plugin add dev-skills@dev-lite
```

Codex lists plugin skills as `dev-skills:dev-review-pr`. Codex does not install plugin npm dependencies: run `npm ci --prefix "<installed plugin folder>"` once for `dev-skills` and `dev-planning` (Claude Code does this automatically).

## Versions

Releases are tagged `vX.Y.Z`, and the major tag (`v0`) moves to the latest release of that major line. Reference `@v0` to receive compatible updates, or pin an exact tag (`@v0.1.0`) or commit. Each plugin's `version` in `.claude-plugin/plugin.json` must change for installed copies to update. See [CHANGELOG.md](CHANGELOG.md).

## Develop

```bash
node scripts/sync-shared.mjs            # copy shared/ helpers into each plugin
node scripts/sync-shared.mjs --check    # CI: fail on drift
(cd plugins/dev-skills && npm ci && npm test)
(cd plugins/dev-planning && npm ci && npm test)
python3 -m unittest discover -s plugins/dev-hooks/tests
python3 -m unittest discover -s scripts/github-agent/tests
```

Edit shared helpers in `shared/` only; plugins carry synced copies because each plugin is installed as its own cache.
