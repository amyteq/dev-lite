#!/usr/bin/env python3
"""Publish a bounded patch on a new draft PR using trusted tooling in a fresh job.

Neither event routing nor authorization is read from the agent's result artifact.
No checked-out or patched code is executed. All git hooks/filters are disabled by
using a temporary bare index/worktree and explicit Git configuration.
"""
from __future__ import annotations
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tempfile
from agent_lib import draft_pr_base, gh_rest, load_context, sanitize_mentions

MAX_PATCH_BYTES = 2_000_000
BLOCKED_PARTS = {'.git', '.github', '.env', '.aws', '.ssh', '.local', '.data', '.artifacts', 'node_modules'}
BLOCKED_FILES = {'.gitmodules', '.gitattributes'}


def checked_path(path: str) -> None:
    pure = PurePosixPath(path)
    if not path or pure.is_absolute() or any(p in {'..', '.'} | BLOCKED_PARTS for p in pure.parts):
        raise ValueError(f'Unsafe patch path: {path!r}')
    if any(p in BLOCKED_FILES or p.startswith('.env.') and p != '.env.example' for p in pure.parts):
        raise ValueError(f'Protected patch path: {path!r}')
    if path in {'.codex/auth.json', '.claude/settings.local.json', '.codex/config.local.toml'}:
        raise ValueError(f'Private agent configuration: {path!r}')
    if pure.suffix.lower() in {'.pem', '.key', '.sqlite', '.db'}:
        raise ValueError(f'Credential or state file: {path!r}')
    if any(p in {'private', 'secrets'} for p in pure.parts) or '\\' in path or any(ord(c) < 32 for c in path):
        raise ValueError(f'Private or invalid patch path: {path!r}')


# High-confidence credential values anywhere in a patch and the reply: private
# keys, GitHub tokens, Anthropic/OpenAI keys and the token fields of an OAuth auth.json.
CREDENTIAL_CONTENT = re.compile(
    rb"-----BEGIN [A-Z ]*PRIVATE KEY-----"
    rb"|\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}"
    rb"|\bsk-(?:ant-|proj-)[A-Za-z0-9_-]{20,}"
    rb"|\"(?:refresh_token|access_token|id_token)\"\s*:\s*\"[^\"]{20,}\""
)


def check_patch_content(patch: bytes) -> None:
    """Refuse a patch that carries a credential value anywhere, or that cannot be read as text.

    The patch is uploaded and published whole, so headers, paths, context and removed
    lines are scanned as well as added ones.
    """
    for line in patch.splitlines():
        # A binary hunk is base85 (or absent), so its content cannot be inspected.
        if line.startswith((b'GIT binary patch', b'Binary files ')):
            raise ValueError('Binary changes cannot be inspected and are not published')
    if CREDENTIAL_CONTENT.search(patch):
        raise ValueError('Patch carries a credential-shaped value')


def check_reply_content(text: bytes) -> None:
    if CREDENTIAL_CONTENT.search(text):
        raise ValueError('Reply contains a credential-shaped value')


def git(work: str, *args: str, input: bytes | None = None, index_file: str | None = None) -> bytes:
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env['GIT_CONFIG_NOSYSTEM'] = '1'
    env['GIT_CONFIG_GLOBAL'] = '/dev/null'
    if index_file is not None:
        env['GIT_INDEX_FILE'] = index_file
    return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null',
                                    '-c', 'core.attributesFile=/dev/null', *args],
                                   cwd=work, input=input, env=env, stderr=subprocess.PIPE)


def index_modes(work: str, index_file: str | None = None) -> dict[str, bytes]:
    """Read actual stage-zero index entries, never optional patch metadata."""
    modes = {}
    for record in git(work, 'ls-files', '--stage', '-z', index_file=index_file).split(b'\0'):
        if not record:
            continue
        metadata, path = record.split(b'\t', 1)
        mode, _, stage = metadata.split(b' ')
        if stage != b'0':
            raise ValueError('Unmerged index entries cannot be published')
        modes[path.decode('utf-8', errors='strict')] = mode
    return modes


def check_regular_entries(paths: list[str], *indexes: dict[str, bytes]) -> None:
    for path in paths:
        checked_path(path)
        for entries in indexes:
            if path in entries and entries[path] not in {b'100644', b'100755'}:
                raise ValueError('Symlink/submodule index entries cannot be published')


def validate_patch(work: str, patch: bytes) -> list[str]:
    if len(patch) > MAX_PATCH_BYTES:
        raise ValueError('Patch exceeds the 2 MB publication limit')
    if not patch:
        return []
    check_patch_content(patch)
    # --numstat -z decodes Git's quoted path representation correctly.
    records = git(work, 'apply', '--numstat', '-z', '-', input=patch).split(b'\0')
    paths = []
    for record in records:
        if not record:
            continue
        fields = record.split(b'\t', 2)
        if len(fields) != 3:
            raise ValueError('Unsupported rename or malformed patch')
        path = fields[2].decode('utf-8', errors='strict')
        checked_path(path)
        paths.append(path)
    if not paths or len(paths) > 100:
        raise ValueError('Patch must modify between 1 and 100 files')
    # Early rejection is useful, but headers are optional and not authoritative.
    # Only ordinary file modes may be touched, including existing executable files.
    modes = re.findall(rb'^(?:new file mode|new mode|old mode|deleted file mode) (\d+)$', patch, re.M)
    modes += re.findall(rb'^index [a-f0-9]+\.\.[a-f0-9]+ (\d+)$', patch, re.M)
    for mode in modes:
        if mode not in {b'100644', b'100755'}:
            raise ValueError('Symlink/submodule modes cannot be published')
    original_modes = index_modes(work)
    check_regular_entries(paths, original_modes)
    git(work, 'apply', '--check', '--index', '-', input=patch)
    # Trial-apply into a separate index so validation never changes the checkout.
    # Inspect the real before/after entries and actual changed paths, not merely
    # the numstat/header rendering supplied by the untrusted patch.
    original_tree = git(work, 'write-tree').decode().strip()
    with tempfile.TemporaryDirectory() as folder:
        index_file = str(Path(folder) / 'index')
        git(work, 'read-tree', original_tree, index_file=index_file)
        git(work, 'apply', '--cached', '-', input=patch, index_file=index_file)
        actual_paths = [item.decode('utf-8', errors='strict') for item in
                        git(work, 'diff', '--cached', '--name-only', '--no-renames', '-z',
                            original_tree, '--', index_file=index_file).split(b'\0') if item]
        if not actual_paths or len(actual_paths) > 100:
            raise ValueError('Patch must change between 1 and 100 actual files')
        check_regular_entries(actual_paths, original_modes, index_modes(work, index_file))
    return actual_paths


def publish_patch(context: dict, work: str, patch: bytes) -> str:
    if not context.get('writable') or (context.get('pull_request') or {}).get('is_fork'):
        return ''
    paths = validate_patch(work, patch)
    if not paths:
        return ''
    if git(work, 'rev-parse', 'HEAD').decode().strip() != context['checkout_sha']:
        raise ValueError('Publisher checkout differs from authorized snapshot')
    git(work, 'apply', '--index', '-', input=patch)
    # Derive new tree from the validated index; ignore any commit the agent made.
    tree = git(work, 'write-tree').decode().strip()
    branch = f"agent/{context['agent']}/{os.environ['GITHUB_RUN_ID']}-{os.environ['GITHUB_RUN_ATTEMPT']}"
    if not re.fullmatch(r'agent/(claude|codex)/\d+-\d+', branch):
        raise ValueError('Invalid generated publication branch')
    # Push credentials exist only in this subprocess's askpass helper environment.
    commit = git(work, '-c', 'user.name=github-actions[bot]',
                 '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
                 'commit-tree', tree, '-p', context['checkout_sha'],
                 input=f"Agent: {context.get('command') or 'update'} #{context['number']}\n".encode()).decode().strip()
    with tempfile.TemporaryDirectory() as folder:
        helper = Path(folder) / 'askpass'
        helper.write_text('#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" x-access-token;; *) printf "%s\\n" "$GH_TOKEN";; esac\n')
        helper.chmod(0o700)
        env = {**os.environ, 'GIT_ASKPASS': str(helper), 'GIT_TERMINAL_PROMPT': '0',
               'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'}
        existing = subprocess.check_output(['git', '-c', 'credential.helper=', 'ls-remote', '--heads',
                                            'origin', f'refs/heads/{branch}'], cwd=work, env=env)
        if existing.strip():
            raise ValueError('Generated branch already exists; refusing to update it')
        subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=',
                        'push', 'origin', f'{commit}:refs/heads/{branch}'], cwd=work, env=env, check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    base = draft_pr_base(context)
    if base == branch:
        raise ValueError('Publication branch equals the base')
    created = gh_rest(f"repos/{context['repo']}/pulls", method='POST', body={
        'title': f"Agent changes: {context.get('command') or 'update'} #{context['number']}",
        'head': branch, 'base': base, 'draft': True,
        'body': sanitize_mentions(f"Implements the authorized request: {context.get('source_url') or context['run_url']}\n\n"
                                 f"Generated by [this run]({context['run_url']}). Needs independent review and the usual CI "
                                 "before merging.\n\n"
                                 "A push made with the Actions token does not trigger the usual pull_request CI; a "
                                 "maintainer must run CI manually or push a follow-up commit.")})
    return (created or {}).get('html_url', '')


def main():
    context = load_context()
    status_path = Path(os.environ['STATUS_FILE'])
    status = json.loads(status_path.read_text()) if status_path.exists() else {}
    if status.get('exit_code') != 0:
        return
    patch_path = Path(os.environ['PATCH_FILE'])
    if patch_path.is_symlink() or not patch_path.is_file():
        raise ValueError('Patch is missing or is a symlink')
    if patch_path.stat().st_size > MAX_PATCH_BYTES:
        raise ValueError('Patch exceeds the 2 MB publication limit')
    url = publish_patch(context, os.environ['WORK_DIR'], patch_path.read_bytes())
    if url:
        result = Path(os.environ['RESULT_FILE'])
        with result.open('a', encoding='utf-8') as handle:
            handle.write(f'\n\nDraft PR: {url}\n')

if __name__ == '__main__':
    main()
