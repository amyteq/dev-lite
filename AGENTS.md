# Working in dev-lite

This public repository publishes Claude Code / Codex plugins and a reusable GitHub Actions workflow. Consumers install it into private projects, so everything here must stay project-neutral.

## Rules

- Public content only: no private repository names or links, real issue/PR numbers from other projects, people's names, internal hostnames, credentials or machine paths. Tests and examples use `example-org/example-repo`.
- Never write a bare agent mention in Markdown or comments; put it in a code span (`` `@claude` ``) so it does not trigger the Ask workflow.
- Skills load from a plugin cache, not from the consumer repository. Reference consumer files by name ("the repository's `AGENTS.md`"), shared helpers as `${CLAUDE_PLUGIN_ROOT}/scripts/<file>` and a skill's own files as `${CLAUDE_SKILL_DIR}/<path>`.
- Edit helpers in `shared/` only, then run `node scripts/sync-shared.mjs`.
- A plugin change that consumers should receive bumps that plugin's `version` in `.claude-plugin/plugin.json` and adds a `CHANGELOG.md` entry. Changes on `main` ship to the beta channel first, as `X.Y.Z-beta.N`.
- A new or renamed plugin goes into both `.claude-plugin/marketplace.json` and `channels/beta/.claude-plugin/marketplace.json`.
- New prose and status messages in English.

## Checks

```bash
node scripts/sync-shared.mjs --check
(cd plugins/dev-skills && npm ci && npm test)
(cd plugins/dev-planning && npm ci && npm test)
python3 -m unittest discover -s plugins/dev-hooks/tests
python3 -m unittest discover -s scripts/github-agent/tests
claude plugin validate .        # when the Claude CLI is available
```

Local tests do not prove live agent launches or GitHub Actions runs.

## GitHub work

Use a task branch and a focused PR. Do not merge or force-push without an explicit request. Release tags (`vX.Y.Z`, moving `vX`) are created only by the release process.
