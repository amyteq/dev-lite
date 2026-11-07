#!/usr/bin/env python3
"""Treat the agent artifact as untrusted: validate only bounded regular files."""
import json
import os
from pathlib import Path


def main():
    limits = {'result.md': 100_000, 'status.json': 10_000, 'changes.patch': 2_000_000}
    root = Path(os.environ['RESULT_FILE']).parent
    for entry in root.iterdir():
        if entry.name not in limits or entry.is_symlink() or not entry.is_file():
            raise ValueError('Unexpected result artifact entry')
        if entry.stat().st_size > limits[entry.name]:
            raise ValueError('Result artifact exceeds its size limit')
    path = root / 'status.json'
    if not path.exists():
        raise ValueError('Agent status is missing')
    if path.exists():
        status = json.loads(path.read_text())
        if not isinstance(status, dict) or not isinstance(status.get('exit_code'), int):
            raise ValueError('Invalid agent status')
        if status['exit_code'] == 0 and (not (root / 'result.md').exists() or not (root / 'result.md').read_text().strip()):
            raise ValueError('Successful agent status has no reply')
        for field in ('model', 'effort', 'started', 'elapsed', 'agent', 'command'):
            if field in status and (not isinstance(status[field], str) or len(status[field]) > 300):
                raise ValueError(f'Invalid status field: {field}')

if __name__ == '__main__':
    main()
