#!/usr/bin/env python3
"""Claude Code PreToolUse guard: deny host-destructive and secret-reading calls.

Wired by the dev-hooks plugin for Bash|Read|Edit|Write.

Policy:
- Allow normal development work without prompts.
- Deny secret access and host- or history-destructive operations.
- Ask only for irreversible operations (file deletion outside temp dirs,
  git clean, destructive SQL, volume or remote database resets).

Contract (Claude Code hooks):
  - stdin: JSON describing the tool call (tool_name, tool_input, ...).
  - A matching rule prints a `hookSpecificOutput` decision (`deny` or `ask`)
    and exits 0; no match exits 0 silently, leaving the normal permission flow.
  - A hook decision never grants a permission that settings.json denies.

FAIL OPEN on hook errors: unreadable input or an internal error allows the call
so a guard bug never bricks the session. A matched rule always denies or asks.

This recognises literal command spellings; it is not a shell security boundary.
Keep the sandbox and settings.json permissions as the primary controls.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import sys
from pathlib import Path


def emit(decision: str, reason: str) -> None:
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": decision,
                    "permissionDecisionReason": reason,
                }
            }
        )
    )


def normalize_path(value: str) -> str:
    if not value:
        return ""
    return os.path.expanduser(value).replace("\\", "/")


PROTECTED_FRAGMENTS = (
    "/secrets/",
    "/.ssh/",
    "/.aws/",
    "/.config/gcloud/",
    "/.config/gh/hosts.yml",
    "/.netrc",
    "/id_rsa",
    "/id_ed25519",
)
PROTECTED_NAMES = {
    ".env.production",
    ".env.test",
    ".netrc",
    "id_rsa",
    "id_ed25519",
    "hosts.yml",
}


def path_is_protected(path: str) -> bool:
    """System credentials and production/test env files. Local dev `.env` stays readable."""
    p = "/" + normalize_path(path)  # leading slash so relative `secrets/x` matches `/secrets/`
    # A trailing slash lets a protected directory itself (`~/.aws`) match its `/.aws/` fragment.
    return Path(p).name in PROTECTED_NAMES or any(fragment in p + "/" for fragment in PROTECTED_FRAGMENTS)


def compact(command: str) -> str:
    return " ".join(command.strip().split())


# --- command normalisation ----------------------------------------------------
#
# The deny/ask patterns match words in the command string, so they only
# recognise the spellings they were written for:
#
# - `gh` accepts a flag between the binary and the subcommand and runs it the
#   same way: `gh --repo OWNER/REPO issue delete 1` == `gh issue delete 1`.
# - Matching the whole command string would refuse a heredoc or a quoted message
#   that merely writes *about* a gated verb, although it executes nothing.
#
# Every normalisation step is a deletion, never a reordering or re-quoting, so it
# can only make the matcher see less; it never fabricates a word sequence.

# gh flags that may legally precede the subcommand. Boolean forms take no value.
GH_LEADING_FLAGS = re.compile(
    r"\bgh(?:\s+(?:--repo|-R|--hostname)(?:=\S+|\s+\S+)|\s+(?:--help|-h|--version))+",
    flags=re.IGNORECASE,
)

# A heredoc opener: `<<TAG`, `<<'TAG'`, `<<"TAG"`, `<<-TAG`.
HEREDOC_START = re.compile(r"<<-?\s*(?P<quote>['\"]?)(?P<tag>[A-Za-z_][A-Za-z0-9_]*)(?P=quote)")

# Programs that execute what they are handed. If any appears at a command
# position, heredoc bodies stay in scope: `bash <<EOF ... EOF` runs its payload.
INTERPRETERS = {
    "ash", "bash", "csh", "dash", "env", "eval", "fish", "ksh", "node", "perl",
    "php", "python", "python3", "ruby", "sh", "source", "xargs", "zsh",
}

# A word in command position: start, or after a pipe/separator/substitution,
# optionally preceded by VAR=value assignments; quotes and backslashes around it do not hide it.
COMMAND_POSITION = re.compile(r"(?:^|[|;&\n(]|`)\s*(?:\w+=\S+\s+)*[\"'\\]*(?P<program>[\w./-]+)")

# The literal value of a message-carrying flag. Single quotes never expand; double
# quotes count only without `$`, backtick or backslash, so a payload that could
# execute something (`--body "$(cat ~/.ssh/id_rsa)"`) stays in place and is matched.
LITERAL_MESSAGE_PAYLOAD = re.compile(
    r"(?<![\w-])(?:-m|--message|-b|--body|-t|--title|--notes)(?:\s+|=)(?:'[^']*'|\"[^\"$`\\]*\")"
)


def mentions_interpreter(command: str) -> bool:
    return any(Path(match.group("program")).name in INTERPRETERS for match in COMMAND_POSITION.finditer(command))


# Programs that only store or forward what they read on stdin. A heredoc fed to
# anything else (psql, ssh, docker exec, ...) may be executed, so it stays in scope.
DATA_SINKS = {"cat", "tee", "gh", "git"}
EXPANDABLE = re.compile(r"[$`\\]")
PLAIN_ASSIGNMENT = re.compile(r"[A-Za-z_]\w*=[\w./:-]*")


def strip_heredoc_bodies(command: str) -> str:
    """Drop heredoc payloads that are verified literal data written by a data sink.

    A body stays in scope when anything in the command line could execute it, when
    its consumer is not a data sink, or when an unquoted delimiter lets the shell
    expand `$(...)`, backticks or variables inside it.
    """
    if "<<" not in command or mentions_interpreter(command):
        return command

    lines = command.split("\n")
    kept: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        kept.append(line)
        index += 1
        opener = HEREDOC_START.search(line)
        if not opener:
            continue
        tag = opener.group("tag")
        end = index
        while end < len(lines) and lines[end].strip() != tag:
            end += 1
        body = lines[index:end]
        # The body reaches every program of the opener's pipeline, so each stage, including a
        # substitution, must start with a data sink spelled literally. A quoted, escaped, expanded
        # or otherwise unrecognised program is not identified, so the body stays in scope.
        pipeline = [part for part in re.split(r"&&|\|\||;|(?<![|>])&(?!>)", line) if opener.group(0) in part][0]
        stages = [stage.split() for stage in re.split(r"[|(`]", pipeline) if stage.strip()]
        sink = all(next((word for word in words if not PLAIN_ASSIGNMENT.fullmatch(word)), "") in DATA_SINKS
                   for words in stages) and not line.rstrip().endswith(("|", "\\"))
        literal = bool(opener.group("quote")) or not EXPANDABLE.search("\n".join(body))
        if not (sink and literal):
            kept.extend(body)
        index = end
        if index < len(lines):
            kept.append(lines[index])
            index += 1
    return "\n".join(kept)


def normalize_command(command: str, keep_lines: bool = False) -> str:
    """Canonicalise a command for matching: inert payloads out, gh flag noise out."""
    text = strip_heredoc_bodies(command)
    text = LITERAL_MESSAGE_PAYLOAD.sub(" ", text)
    text = GH_LEADING_FLAGS.sub("gh", text)
    return text if keep_lines else compact(text)


# --- shell structure ----------------------------------------------------------
#
# The rules below read words as the shell splits and unquotes them, so `"--force"`,
# `git -C repo push` and `-T.env.production` are the same commands as their plain
# spellings. Unbalanced quoting cannot be read that way and asks instead.

SHELL_KEYWORDS = {"!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "time"}
# Programs that run the program named in their arguments.
WRAPPERS = {"env", "command", "builtin", "exec", "nohup", "nice", "timeout", "xargs", "stdbuf", "sudo", "doas"}
SHELLS = {"sh", "bash", "zsh", "dash", "ksh", "ash"}
ASSIGNMENT = re.compile(r"^[A-Za-z_]\w*=")


def simple_commands(command: str) -> list[list[str]]:
    """The words of each simple command, unquoted; raises ValueError on unbalanced quoting."""
    # A substitution's command is a command too; splitting at it only adds commands.
    text = command.replace("`", " ; ").replace("$(", " ; ( ")
    lexer = shlex.shlex(text, posix=True, punctuation_chars=";&|()<>\n")
    lexer.whitespace = " \t\r"
    lexer.whitespace_split = True
    lexer.commenters = ""  # a `#` word is kept: reading more words only adds matches
    commands, words = [], []
    for token in lexer:
        if token and set(token) <= set(";&|()\n"):
            commands.append(words)
            words = []
        else:
            words.append(token)
    return [words for words in commands + [words] if words]


def invocations(command: str, names: set[str], depth: int = 0) -> list[list[str]]:
    """Arguments of every call to a program in `names`, also through wrappers, `sh -c` and `eval`."""
    found = []
    for words in simple_commands(command):
        index = 0
        while index < len(words) and (words[index] in SHELL_KEYWORDS or ASSIGNMENT.match(words[index])
                                      or set(words[index]) <= set("<>&")):
            index += 2 if set(words[index]) <= set("<>&") else 1
        words = words[index:]
        program = Path(words[0]).name if words else ""
        if program in names:
            found.append(words[1:])
        elif program in WRAPPERS:
            later = [i for i, word in enumerate(words) if Path(word).name in names]
            found.extend([words[later[0] + 1:]] if later else [])
        elif depth < 3 and program == "eval":
            found.extend(invocations(" ".join(words[1:]), names, depth + 1))
        elif depth < 3 and program in SHELLS:
            # `sh -c SCRIPT`, also with bundled options such as `bash -lc SCRIPT`.
            flag = next((i for i, word in enumerate(words[1:-1], 1) if re.fullmatch(r"-[a-z]*c[a-z]*", word)), None)
            found.extend(invocations(words[flag + 1], names, depth + 1) if flag else [])
    return found


# Git options before the subcommand that take a separate value.
GIT_VALUE_OPTIONS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"}
PUSH_VALUE_OPTIONS = {"--repo", "--receive-pack", "--exec", "--push-option", "-o"}
FORCE_OPTIONS = ("--force", "--force-with-lease", "--mirror")
DELETE_OPTIONS = ("--delete", "--prune")


def push_decision(command: str) -> tuple[str | None, str | None]:
    """Deny a force push or remote deletion in any spelling Git accepts; ask when config could imply one."""
    for args in invocations(command, {"git"}):
        index, configured = 0, False
        while index < len(args) and args[index].startswith("-"):
            name = args[index].split("=", 1)[0]
            configured |= name in ("-c", "--config-env")
            index += 2 if name in GIT_VALUE_OPTIONS and "=" not in args[index] else 1
        if args[index:index + 1] != ["push"]:
            continue
        force = delete = ended = False
        positional, rest = [], iter(args[index + 1:])
        for word in rest:
            if ended or not word.startswith("-") or word == "-":
                positional.append(word)
            elif word == "--":
                ended = True
            elif word.startswith("--"):
                name = word.split("=", 1)[0]
                if name.startswith("--no-"):
                    continue
                # Git accepts any unambiguous prefix of a long option.
                force |= any(option.startswith(name) for option in FORCE_OPTIONS) and len(name) > 3
                delete |= any(option.startswith(name) for option in DELETE_OPTIONS + ("--mirror",)) and len(name) > 3
                if name in PUSH_VALUE_OPTIONS and "=" not in word:
                    next(rest, None)
            else:
                for position, letter in enumerate(word[1:], 1):
                    if letter == "o":  # `-o` takes the rest of the word, or the next word, as its value
                        if position == len(word) - 1:
                            next(rest, None)
                        break
                    force |= letter == "f"
                    delete |= letter == "d"
        # The repository is positional only without `--repo`; no remote name starts with `+` or `:`.
        # A bare `:` is Git's matching refspec, which pushes existing branches and deletes none.
        force |= any(word.startswith("+") for word in positional)
        delete |= any(word.startswith(":") and word != ":" for word in positional)
        if force:
            return "deny", "Refusing force push."
        if delete:
            return "deny", "Refusing remote branch deletion (preserve published branch history)."
        if configured:
            return "ask", "A push with command-line Git configuration requires approval."
    return None, None


def temp_roots() -> list[str]:
    """/tmp, plus $TMPDIR only when it is set to an absolute path other than `/`."""
    tmpdir = os.path.normpath(os.environ.get("TMPDIR") or ".")
    return ["/tmp"] + ([tmpdir] if os.path.isabs(tmpdir) and tmpdir != "/" else [])


TMPDIR_PREFIX = re.compile(r"^\$(?:TMPDIR|\{TMPDIR\})/")


def rm_targets_only_temp(command: str) -> bool:
    """True when every `rm` removes only paths strictly inside /tmp or the hook's own $TMPDIR.

    Case is kept, and a command that may change TMPDIR for the shell leaves `$TMPDIR` unresolved.
    """
    roots = temp_roots()
    calls = invocations(command, {"rm"})
    words = [Path(word).name for words in simple_commands(command) for word in words]
    if not calls or words.count("rm") != len(calls):
        return False  # an `rm` this reading did not resolve, such as `find -exec rm`
    redefined = re.search(r"(?<![$\w{])TMPDIR(?!\w)", command) is not None
    for args in calls:
        targets = [arg for index, arg in enumerate(args) if not arg.startswith("-") or "--" in args[:index]]
        if not targets:
            return False
        for target in targets:
            prefix = TMPDIR_PREFIX.match(target)
            # An unquoted $TMPDIR holding whitespace or a glob character splits or expands into other paths.
            if prefix and (len(roots) < 2 or redefined or re.search(r"[\s*?\[]", roots[-1])):
                return False  # $TMPDIR is empty, unusable or not the hook's value
            path = (roots[-1] + "/" + target[prefix.end():] if prefix else target).rstrip("/")
            if ".." in target or "$" in path or "~" in target[:1] or \
                    not any(path.startswith(root + "/") for root in (roots[-1:] if prefix else roots)):
                return False
    return True


# A transfer or read operand may be attached to its option (`-T.env.production`,
# `--upload-file=x`), prefixed by `@` or `<`, or follow a `host:` part.
TRANSFER_PROGRAMS = {"curl", "wget", "scp", "rsync", "sftp"}
READ_PROGRAMS = {"cat", "less", "more", "head", "tail", "grep", "rg", "awk", "sed", "xxd", "od", "strings", "base64"}


def operand_forms(word: str) -> set[str]:
    forms = {word, word.split("=", 1)[-1], word.split(":", 1)[-1], word.rsplit("@", 1)[-1], word.lstrip("@<")}
    if word.startswith("-") and not word.startswith("--"):
        # Bundled short options (`-sT.env.production`) can attach the value after any letter.
        forms |= {form for start in range(2, len(word)) for form in (word[start:], word[start:].lstrip("@<"))}
    return {form for form in forms if form}


def protected_operand(command: str, programs: set[str]) -> bool:
    return any(path_is_protected(form) for args in invocations(command, programs) for word in args
               for form in operand_forms(word))


# The shell rules use the file tools' policy: a fragment matches from a path boundary
# (a directory fragment also as the directory itself), a name only as a whole path part.
SECRET_PATHS = r"(?<![\w.-])(?:" + "|".join(
    [re.escape(f.strip("/")) + (r"(?:/|(?![\w.-]))" if f.endswith("/") else "") for f in PROTECTED_FRAGMENTS]
    + [re.escape(name) + r"(?![\w.-])" for name in sorted(PROTECTED_NAMES)]
) + ")"

DENY_PATTERNS = [
    (r"\bsudo\b", "Refusing sudo from the agent."),
    (r"\bsu\s+", "Refusing su from the agent."),
    (r"\bdoas\b", "Refusing doas from the agent."),
    (r"\brm\s+-rf\s+(/|~|\$HOME)(\s|$)", "Refusing recursive deletion of root/home."),
    (r"\brm\s+-rf\s+/(?!tmp/)\S+", "Refusing recursive deletion of absolute filesystem paths."),
    (r"\bchmod\s+777\b", "Refusing chmod 777."),
    (r"\bchown\s+.*\s+(/|~|\$HOME)\b", "Refusing ownership change on broad paths."),
    (r"\bdd\s+.*\bof=/dev/", "Refusing raw disk write."),
    (r"\bmkfs(\.|\s|$)", "Refusing filesystem formatting command."),
    (r"\bshutdown\b|\breboot\b|\bhalt\b", "Refusing host power command."),
    (r"\bgit\s+filter-(branch|repo)\b", "Refusing history rewrite."),
    (
        r"\bgh\s+(issue|label|release|repo|secret|variable|webhook|ssh-key|gpg-key|cache|run)\s+delete\b",
        "Refusing permanent GitHub deletion.",
    ),
    (r"\bgh\s+extension\s+remove\b", "Refusing gh extension removal."),
    (r"\bdocker\s+run\b.*\s--privileged\b", "Refusing privileged Docker container."),
    (
        r"\b(cat|less|more|head|tail|grep|rg|awk|sed|xxd|od|strings|base64)\b.*(" + SECRET_PATHS + ")",
        "Refusing shell read of protected secrets.",
    ),
    (
        r"\b(curl|wget|scp|rsync)\b.*(" + SECRET_PATHS + r"|metadata\.google|169\.254\.169\.254)",
        "Refusing shell exfiltration/metadata access pattern.",
    ),
    # In either order: a heredoc piped into the client puts the statement first.
    (r"^(?=.*\b(psql|sqlite3|mysql)\b).*\b(drop\s+database|drop\s+schema)\b", "Refusing database/schema drop from the agent."),
]

ASK_PATTERNS = [
    (r"\brmdir\b", "Directory deletion requires approval."),
    (r"\bfind\b.*\s-delete\b", "find -delete requires approval."),
    (r"\bgit\s+clean\b", "git clean requires approval."),
    (r"\bsupabase\s+db\s+(push|reset)\b", "Remote/destructive Supabase database operation requires approval."),
    (r"^(?=.*\b(psql|sqlite3|mysql)\b).*\b(truncate|delete\s+from)\b", "Destructive SQL requires approval."),
    (r"\bdocker\s+compose\s+down\b.*\s-v\b", "Docker volume deletion requires approval."),
]


# Words whose command the structural rules must read; unreadable quoting around one asks.
STRUCTURAL_WORDS = re.compile(r"\b(?:push|rm|curl|wget|scp|rsync|sftp|cat|less|more|head|tail|grep|rg|awk|sed|xxd|od|strings|base64)\b")
# Shell text these rules cannot resolve: a command or process substitution, whose output becomes
# words or a program, and a variable or substitution in command position.
UNRESOLVED = re.compile(r"\$\(|`|[<>]\(|(?:^|[|;&\n(])\s*(?:\w+=\S*\s+)*[\"'\\]*\$")
# The one closed literal form allowed through: `$(cat <<'TAG'` with its body already removed as data.
LITERAL_SUBSTITUTION = re.compile(r"\$\(cat <<-?\s*'(?P<tag>[A-Za-z_]\w*)'\n\s*(?P=tag)\n\s*\)")


def bash_decision(command: str) -> tuple[str | None, str | None]:
    lc = normalize_command(command).lower()
    text = normalize_command(command, keep_lines=True)

    for pattern, reason in DENY_PATTERNS:
        if re.search(pattern, lc, flags=re.IGNORECASE):
            return "deny", reason

    try:
        decision = push_decision(text)
        if decision[0]:
            return decision
        if protected_operand(text, READ_PROGRAMS):
            return "deny", "Refusing shell read of protected secrets."
        if protected_operand(text, TRANSFER_PROGRAMS):
            return "deny", "Refusing shell exfiltration/metadata access pattern."
        removes_outside_temp = re.search(r"\brm\b", lc) and not rm_targets_only_temp(text)
    except ValueError:
        if STRUCTURAL_WORDS.search(lc):
            return "ask", "This command's quoting cannot be read safely; split or simplify it."
        removes_outside_temp = False
    if STRUCTURAL_WORDS.search(lc) and UNRESOLVED.search(LITERAL_SUBSTITUTION.sub(" ", text)):
        return "ask", "A substitution or variable decides what this command runs or reads; spell it out literally."
    if removes_outside_temp:
        return "ask", "File deletion outside /tmp or $TMPDIR requires approval."
    for pattern, reason in ASK_PATTERNS:
        if re.search(pattern, lc, flags=re.IGNORECASE):
            return "ask", reason

    return None, None


def main() -> int:
    payload = json.load(sys.stdin)
    tool = payload.get("tool_name", "")
    tool_input = payload.get("tool_input") or {}

    if tool in {"Read", "Edit", "Write"}:
        file_path = tool_input.get("file_path") or tool_input.get("path") or ""
        if path_is_protected(file_path):
            emit("deny", f"Protected path blocked: {file_path}")
            return 0

    if tool == "Bash":
        decision, reason = bash_decision(tool_input.get("command") or "")
        if decision and reason:
            emit(decision, reason)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)  # fail open on hook errors (bad input, internal bug)
