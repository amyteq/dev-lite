# Changelog

## 0.2.0-beta.1 (beta channel, unreleased)

- `dev-skills` 0.2.0-beta.1:
  - New `dev-merge`: squash merge one reviewed PR on the owner's explicit request, verify the merged tree, clean up, post a closeout in the PR body's language and update linked issues and trackers (#15). The PR's base branch replaces a hard-coded `main`. A saved cleanup plan runs only in the repository and Git storage it was made for; the closing-keyword lint covers the squash subject and full issue URLs; moved-base verification runs the checks the repository's `AGENTS.md` requires.
  - New `dev-track`: register every unprocessed discussion of one category (the `meetings` playbook digests meeting notes in place and merges their TODOs) in that category's tracker discussion. It replaces the planned `dev-meeting-notes` (#16). Its helper, including the bounded `.docx`/`.pptx` text reader for meeting attachments, is Node only: no skill needs `python3`. The helper also downloads meeting attachments, reading `gh auth token` itself so the token never appears in a command line or log.
  - `dev-review-pr`: published reports follow the PR body's language with the `Base:`, `Reviewed head:` and `Verdict:` labels kept in English for `dev-merge`; selecting the skill grants no write permission.
- Beta channel: the `dev-lite-beta` marketplace (`channels/beta/`) serves the plugins from the head of `main`; projects opt in with `templates/claude/settings.beta.json`.

## 0.1.0 (to be tagged `v0.1.0` and `v0`)

- Marketplace `dev-lite` with plugins `dev-skills`, `dev-planning` and `dev-hooks`.
- Reusable `ask-agent.yml` workflow with caller templates for Claude Code and Codex.
- Consumer template for `.claude/settings.json`.
