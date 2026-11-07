#!/usr/bin/env bash
# The bounded worker for Claude's Bash tool, set as the trusted CLAUDE_CODE_SHELL_PREFIX by
# launch-phase.mjs and by the Ask workflow's run_agent.py: Claude Code runs every Bash command
# as `bounded-shell.sh COMMAND`. The command runs in a Linux bubblewrap namespace that holds no
# credential: a cleared environment, no network, its own PID, IPC and UTS namespaces and /proc,
# and only these mounts:
#   system directories and BOUNDED_READ (newline-separated toolchain directories), read-only;
#   BOUNDED_WORKTREE, writable when BOUNDED_MODE=write, else read-only;
#   BOUNDED_GIT (newline-separated Git directories) and the worktree's .git entry, read-only, so
#   the coordinator alone commits and no hook, config or link can be planted for it;
#   BOUNDED_SCRATCH, writable, also HOME and TMPDIR.
# Home directories, CLI logins and the calling process are never visible. Any unset setting or
# missing `bwrap` refuses to run anything.
set -euo pipefail
for name in BOUNDED_WORKTREE BOUNDED_MODE BOUNDED_SCRATCH BOUNDED_PATH; do
  [[ -n "${!name:-}" ]] || { echo "bounded-shell: $name is not set; refusing to run" >&2; exit 126; }
done
args=(--die-with-parent --unshare-all --new-session --clearenv --proc /proc --dev /dev --tmpfs /tmp)
for dir in /usr /bin /sbin /lib /lib32 /lib64 /libx32 /etc; do args+=(--ro-bind-try "$dir" "$dir"); done
read_only() { while IFS= read -r dir; do if [[ -n "$dir" ]]; then args+=(--ro-bind "$dir" "$dir"); fi; done <<< "$1"; }
read_only "${BOUNDED_READ:-}"
if [[ "$BOUNDED_MODE" == write ]]; then args+=(--bind "$BOUNDED_WORKTREE" "$BOUNDED_WORKTREE")
else args+=(--ro-bind "$BOUNDED_WORKTREE" "$BOUNDED_WORKTREE"); fi
# Later mounts overlay earlier ones, so Git metadata inside a writable worktree stays read-only.
args+=(--ro-bind-try "$BOUNDED_WORKTREE/.git" "$BOUNDED_WORKTREE/.git")
read_only "${BOUNDED_GIT:-}"
args+=(--bind "$BOUNDED_SCRATCH" "$BOUNDED_SCRATCH" --setenv PATH "$BOUNDED_PATH" --setenv HOME "$BOUNDED_SCRATCH"
  --setenv TMPDIR "$BOUNDED_SCRATCH" --setenv LANG C.UTF-8)
bwrap=$(command -v bwrap) || { echo "bounded-shell: bwrap is not installed; refusing to run" >&2; exit 126; }
# `env -i` empties bwrap's own environment block too, which its namespace init would otherwise expose in /proc/1/environ.
# Claude Code passes one shell string; any other caller passes an argument vector.
if (( $# == 1 )); then exec env -i "$bwrap" "${args[@]}" -- /bin/bash -c "$1"; fi
exec env -i "$bwrap" "${args[@]}" -- "$@"
