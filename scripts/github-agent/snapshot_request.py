#!/usr/bin/env python3
"""Capture immutable revisions after authorization, before an agent sees the checkout."""
import json
import os
import re
from pathlib import Path
from urllib.parse import quote
from agent_lib import gh_rest, load_context, set_outputs


def main():
    context = load_context()
    # Pull request payloads can be stale, but resolving the selected ref now captures
    # one immutable revision shared by execution and publication.
    ref = context['ref']
    revision = gh_rest(f"repos/{context['repo']}/commits/{quote(ref, safe='')}") or {}
    sha = revision.get('sha', '')
    if not re.fullmatch(r'[a-f0-9]{40}', sha):
        raise ValueError('GitHub did not return a full commit SHA')
    context['checkout_sha'] = sha
    Path(os.environ['EVENT_FILE']).write_text(json.dumps(context), encoding='utf-8')
    set_outputs({'checkout_sha': sha})

if __name__ == '__main__':
    main()
