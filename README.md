# dev-lite

Lightweight agent skills, hooks and GitHub workflows for small teams that work with Claude Code and Codex. One marketplace, several plugins; install only what a project needs.

| Plugin | What it adds |
| --- | --- |
| [`dev-skills`](plugins/dev-skills) | `dev-review-pr` (bounded review/fix rounds with independent sessions), `dev-refine-issue` (issue → bounded work order), `dev-explain` (explain pending decisions), `dev-compact` (compress an issue, PR or discussion thread), `dev-merge` (squash merge a reviewed PR and close it out; beta), `dev-track` (register a discussion series such as meeting notes in its tracker; beta) |
| [`dev-planning`](plugins/dev-planning) | `dev-refine-story` and `dev-analyse-rp` for feature/story planning (`FT_`/`STY_` docs, tracking issues and labels) |
| [`dev-hooks`](plugins/dev-hooks) | Guardrail and audit hooks for Claude Code |

GitHub Actions: a reusable "Ask agent" workflow ([`.github/workflows/ask-agent.yml`](.github/workflows/ask-agent.yml)) lets Claude Code or Codex answer mentions in issues, PRs and discussions. Copy the thin callers from [`templates/github/`](templates/github).

## Install

### Claude Code

Per project (shared with the team): merge [`templates/claude/settings.json`](templates/claude/settings.json) into the project's `.claude/settings.json`. Teammates are prompted to trust the marketplace on first run.

Per user (every project on this machine): run the commands below, or merge the same `extraKnownMarketplaces` and `enabledPlugins` blocks into your user settings (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json` when you set that variable). Project settings win over user settings: a project that declares `dev-lite` itself uses its own entry, and cloud sessions, teammates and CI see only what the repository declares.

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

Releases are tagged `vX.Y.Z`, and the major tag (`v0`) moves to the latest release of that major line. Reference `v0` to receive compatible updates, or pin an exact tag (`v0.1.0`). Each plugin's `version` in `.claude-plugin/plugin.json` must change for installed copies to update. See [CHANGELOG.md](CHANGELOG.md).

### Channels

| Channel | Marketplace | Ref | Plugin ids | Template |
| --- | --- | --- | --- | --- |
| Stable (default) | `dev-lite` | the `v0` tag | `dev-skills@dev-lite` … | [`templates/claude/settings.json`](templates/claude/settings.json) |
| Beta | `dev-lite-beta` ([catalog](channels/beta/.claude-plugin/marketplace.json)) | the head of `main`, versions like `0.2.0-beta.1` | `dev-skills@dev-lite-beta` … | [`templates/claude/settings.beta.json`](templates/claude/settings.beta.json) |

A project opts into beta by putting the beta template in its `.claude/settings.json` instead of the stable one. The two marketplaces have different names because Claude Code registers one marketplace per name; the beta template also sets the stable plugins to `false`, so a user-level stable install does not load the same skills twice in that project. Codex has no second channel: point the project's `[marketplaces.dev-lite]` `ref` in `.codex/config.toml` at `main` instead of `v0`. When a beta becomes a release, its plugins' versions drop the `-beta.N` suffix, `vX.Y.Z` and `v0` are tagged, and beta projects can switch back to the stable template.

To pin a commit, use the full 40-character SHA where each tool accepts one:

- **Claude Code** before v2.1.324 reads the `#…` suffix of a marketplace URL, and a marketplace `ref`, as a branch or tag only; a SHA there fails as a missing branch (v2.1.324 and later also accept a full SHA as a marketplace `ref`). To support older versions, pin each plugin instead, in a marketplace of your own (for example a project `.claude-plugin/marketplace.json`), with a `git-subdir` source and its `sha`:

  ```json
  { "name": "dev-skills", "source": { "source": "git-subdir", "url": "https://github.com/amyteq/dev-lite.git", "path": "plugins/dev-skills", "sha": "<full commit SHA>" } }
  ```

- **Codex** accepts a SHA as the marketplace ref: `codex plugin marketplace add amyteq/dev-lite --ref <full commit SHA>`.
- **The Ask workflow** accepts a SHA after `@` in the caller's `uses:`.

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
