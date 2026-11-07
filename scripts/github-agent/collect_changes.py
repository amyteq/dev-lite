#!/usr/bin/env python3
"""Collect local edits as untrusted data. The publisher independently validates them.

The patch becomes a run artifact that repository readers can download, so the
publisher's path and credential-content policy is applied here too, before upload.
"""
import os
import subprocess
from pathlib import Path
from agent_lib import load_context
from publish_changes import check_patch_content, checked_path


def main():
    context = load_context()
    target = Path(os.environ['PATCH_FILE'])
    if not context.get('writable'):
        target.write_bytes(b'')
        return
    work = os.environ['WORK_DIR']
    # Include untracked files but never run commit hooks or execute the result.
    subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', 'add', '-A'], cwd=work, check=True)
    patch = subprocess.check_output(['git', 'diff', '--cached', '--binary', '--no-ext-diff',
                                     '--no-renames', context['checkout_sha'], '--'], cwd=work)
    if len(patch) > 2_000_000:
        raise ValueError('Patch exceeds the 2 MB publication limit')
    names = subprocess.check_output(['git', 'diff', '--cached', '--name-only', '-z', '--no-renames',
                                     context['checkout_sha'], '--'], cwd=work)
    for name in filter(None, names.split(b'\0')):
        checked_path(name.decode('utf-8', errors='replace'))
    check_patch_content(patch)
    target.write_bytes(patch)

if __name__ == '__main__':
    main()
