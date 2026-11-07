# dev-hooks

Claude Code hooks that keep an agent session from doing irreversible damage, plus a redacted audit trail. Every hook needs `python3` on `PATH`; without it the hook exits 0 and does nothing.

| Hook | Event (matcher) | Behaviour |
| --- | --- | --- |
| `guard_tool.py` | `PreToolUse` (`Bash\|Read\|Edit\|Write`) | **Denies** `sudo`, recursive deletion of `/`, `~` or absolute paths outside `/tmp`, force push (including `+` refspecs, bundled `-f` and `--mirror`), remote branch deletion (including `-d` and `--prune`), `git filter-branch`/`filter-repo`, `gh … delete`, raw disk writes, privileged containers, and reading or sending credentials (`~/.ssh`, `~/.aws`, gcloud, `gh` hosts, `.netrc`, `secrets/`, `.env.production`, `.env.test`). **Asks** before `rm` outside `/tmp` or `$TMPDIR` (an unset, relative or `/` `TMPDIR` is not a temp root), `rmdir`, `find -delete`, `git clean`, `supabase db push/reset`, destructive SQL and `docker compose down -v`. |
| `guard_pr_merge.py` | `PreToolUse` (`Bash`) | Blocks `gh pr merge` when the PR author is not the current `gh` user, resolving the same number, URL or branch and `-R`/`--repo`/`GH_REPO` repository the CLI would act on. Also blocks two merges in one command, a `$` or backtick anywhere in a merge command, and a number or branch without `--repo` after `cd`, `pushd`, `export` or a `GH_REPO` change. Bypass a deliberate case with `ALLOW_FOREIGN_MERGE=1`. |
| `audit_event.py` | `PostToolUse` (`Bash\|Edit\|Write`), `ConfigChange` (`project_settings\|skills`) | Appends one JSON line per event to `.claude/audit/events-YYYYMMDD.log` in the project: event, session, tool, the file path or the Bash executable name when it is a literal word. The folder ignores itself with its own `.gitignore`. Command arguments, file contents and secret values are never recorded. |

## Failure policy

A rule that matches always denies or asks. If a hook itself fails (unreadable input, a missing `gh`, a bug), it allows the call, so a guard defect never locks the session. Push, `rm`, transfer, read and merge rules read the command's words as the shell splits and unquotes them, including through `env`/`xargs`-style wrappers, `sh -c`, `eval` and substitutions, and Git's global and attached or bundled options; quoting they cannot read asks. When a push, `rm`, transfer or read word appears, a `$(…)`, backtick or `<(…)`/`>(…)` substitution, or a variable in command position, also asks, because it decides words these rules cannot see; the one closed literal exception is a `$(cat <<'TAG' … TAG)` message body. The guards are a second line behind the sandbox and `settings.json` permissions, not a security boundary.

Quoted message bodies (`-m`, `--body`, `--title`, `--notes`) and literal heredocs whose every pipeline stage starts with a literal, unquoted `cat`, `tee`, `gh` or `git` are treated as data, so writing *about* a gated command is allowed. A heredoc piped or fed to any other program, an unquoted heredoc whose body could expand `$`, backticks or `\`, and a `$(…)` payload are still matched. `$TMPDIR` counts as a temp root only with the hook's own value and case, never when the command may change it or the value holds whitespace or a glob character.

## Test

```bash
python3 -m unittest discover -s plugins/dev-hooks/tests
```
