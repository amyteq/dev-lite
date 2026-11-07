# dev-hooks

Claude Code hooks that keep an agent session from doing irreversible damage, plus a redacted audit trail. Every hook needs `python3` on `PATH`; without it the hook exits 0 and does nothing.

| Hook | Event (matcher) | Behaviour |
| --- | --- | --- |
| `guard_tool.py` | `PreToolUse` (`Bash\|Read\|Edit\|Write`) | **Denies** `sudo`, recursive deletion of `/`, `~` or absolute paths outside `/tmp`, force push, remote branch deletion, `git filter-branch`/`filter-repo`, `gh … delete`, raw disk writes, privileged containers, and reading or sending credentials (`~/.ssh`, `~/.aws`, gcloud, `gh` hosts, `.netrc`, `secrets/`, `.env.production`, `.env.test`). **Asks** before `rm` outside `/tmp` or `$TMPDIR`, `rmdir`, `find -delete`, `git clean`, `supabase db push/reset`, destructive SQL and `docker compose down -v`. |
| `guard_pr_merge.py` | `PreToolUse` (`Bash`) | Blocks `gh pr merge` when the PR author is not the current `gh` user. Bypass a deliberate case with `ALLOW_FOREIGN_MERGE=1`. |
| `audit_event.py` | `PostToolUse` (`Bash\|Edit\|Write`), `ConfigChange` (`project_settings\|skills`) | Appends one redacted JSON line per event to `.claude/audit/events-YYYYMMDD.log` in the project. The folder ignores itself with its own `.gitignore`. File contents and secret values are never recorded. |

## Failure policy

A rule that matches always denies or asks. If a hook itself fails (unreadable input, a missing `gh`, a bug), it allows the call, so a guard defect never locks the session. The guards match literal command spellings; they are a second line behind the sandbox and `settings.json` permissions, not a security boundary.

Quoted message bodies (`-m`, `--body`, `--title`, `--notes`) and heredocs written to files are treated as data, so writing *about* a gated command is allowed. A heredoc fed to an interpreter, or a `$(…)` payload, is still matched.

## Test

```bash
python3 -m unittest discover -s plugins/dev-hooks/tests
```
