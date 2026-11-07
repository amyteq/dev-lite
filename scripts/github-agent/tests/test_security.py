"""Regressions for trust separation, publication and authorization failures."""
from __future__ import annotations
import io
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import authorize_actor
import collect_changes
import normalize_event
import publish_changes
import publish_result
import run_agent
import snapshot_request
import validate_result
from agent_lib import AgentConfig


class Authorization(unittest.TestCase):
    def check(self, permission=None, failure=None, **context):
        outputs = []
        with patch.object(authorize_actor, 'load_config', return_value=AgentConfig('codex', {})), \
             patch.object(authorize_actor, 'load_context', return_value={'actor': 'maintainer', 'repo': 'example-org/example-repo', **context}), \
             patch.object(authorize_actor, 'gh_rest', return_value={'permission': permission}, side_effect=failure), \
             patch.object(authorize_actor, 'set_outputs', side_effect=outputs.append), redirect_stdout(io.StringIO()):
            authorize_actor.main()
        return outputs[-1]['ok']

    def test_only_write_maintain_and_admin_are_authorized(self):
        for permission in ['admin', 'maintain', 'write']:
            self.assertEqual(self.check(permission), 'true')
        for permission in [None, '', 'read', 'triage', 'owner', 'WRITE']:
            self.assertEqual(self.check(permission), 'false')

    def test_permission_lookup_failure_fails_closed(self):
        self.assertEqual(self.check(failure=RuntimeError('unavailable')), 'false')

    def test_missing_actor_fails_closed(self):
        self.assertEqual(self.check('admin', actor=''), 'false')


class Routing(unittest.TestCase):
    def test_mixed_or_unknown_commands_are_read_only_on_issues_too(self):
        for command, text in [('fix', '@codex fix x\n`@codex review y`'), ('', '@codex please fix x'), ('review', '@codex review x')]:
            context = {'surface': 'issue', 'command': command, 'mention': '@codex', 'number': 15, 'search_text': text}
            normalize_event.resolve_checkout(context, 'example-org/example-repo', 'main')
            self.assertFalse(context['writable'])

    def test_pr_target_routing_uses_the_existing_edit_guard(self):
        payload = {'action': 'edited', 'pull_request': {'number': 1, 'title': 'fixed typo', 'body': '@codex fix this'},
                   'changes': {'title': {'from': 'typo'}}}
        with self.assertRaises(normalize_event.Skip):
            normalize_event.extract(payload, 'pull_request_target', AgentConfig('codex', {}))

    def test_an_escaped_backtick_before_a_multiline_code_span_routes_its_example_read_only(self):
        # F005 round 4: the escaped backtick is literal, so the real opener keeps the example request in code.
        quoted = 'Escape a backtick as \\` in prose, then wrap the example in `\n@codex fix the spelling\n` like this.'
        for body, writable in ((quoted, False), ('Plain prose first.\n@codex fix the spelling', True)):
            with self.subTest(body=body), tempfile.TemporaryDirectory() as folder:
                event = Path(folder, 'event.json')
                payload = {'action': 'created', 'repository': {'default_branch': 'main'}, 'sender': {'login': 'maintainer', 'type': 'User'},
                           'issue': {'number': 15}, 'comment': {'body': body}}
                with patch.dict(os.environ, {'AGENT': 'codex', 'CODEX_ACTION_ENABLED': 'true', 'EVENT_FILE': str(event),
                                            'GITHUB_EVENT_NAME': 'issue_comment', 'GITHUB_REPOSITORY': 'example-org/example-repo'}, clear=True), \
                     patch.object(normalize_event, 'read_event', return_value=payload), \
                     patch.object(normalize_event, 'set_outputs'), redirect_stdout(io.StringIO()):
                    self.assertEqual(normalize_event.main(), 0)
                routed = json.loads(event.read_text())
                self.assertEqual((routed['command'], routed['writable']), ('fix', writable))

    def test_bot_cannot_opt_in_with_a_configuration_variable(self):
        payload = {'action': 'created', 'repository': {'default_branch': 'main'}, 'sender': {'login': 'automation', 'type': 'Bot'},
                   'issue': {'number': 15}, 'comment': {'body': '@codex implement this'}}
        outputs = []
        with patch.dict(os.environ, {'AGENT': 'codex', 'CODEX_ACTION_ENABLED': 'true', 'CODEX_ACTION_ALLOW_BOTS': 'true',
                                    'GITHUB_EVENT_NAME': 'issue_comment', 'GITHUB_REPOSITORY': 'example-org/example-repo'}, clear=True), \
             patch.object(normalize_event, 'read_event', return_value=payload), \
             patch.object(normalize_event, 'set_outputs', side_effect=outputs.append), redirect_stdout(io.StringIO()):
            normalize_event.main()
        self.assertEqual(outputs[-1]['enabled'], 'false')


class Publication(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.work = self.folder.name
        self.git('init', '-q')
        self.git('config', 'user.name', 'Test')
        self.git('config', 'user.email', 'test@example.invalid')
        Path(self.work, 'hello.txt').write_text('before\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'initial')
        self.sha = self.git('rev-parse', 'HEAD').decode().strip()

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.work, stderr=subprocess.PIPE)

    def changed_patch(self, path='hello.txt', content='after\n'):
        target = Path(self.work, path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        self.git('add', '-A')
        data = self.git('diff', '--cached', '--binary', '--no-renames', self.sha)
        self.git('reset', '--hard', self.sha)
        return data

    def test_valid_patch_checks_against_the_original_index(self):
        data = self.changed_patch()
        self.assertEqual(publish_changes.validate_patch(self.work, data), ['hello.txt'])
        self.assertEqual(Path(self.work, 'hello.txt').read_text(), 'before\n')

    def test_protected_paths_are_rejected_even_if_git_can_apply(self):
        for path in ['.github/workflows/evil.yml', '.env', 'private/package.zip', '.data/orders.sqlite', '.codex/auth.json', 'token.pem']:
            with self.subTest(path=path):
                data = self.changed_patch(path, 'sensitive\n')
                with self.assertRaises(ValueError):
                    publish_changes.validate_patch(self.work, data)

    def test_traversal_and_git_metadata_are_rejected(self):
        for path in ['../escape', '/absolute', '.git/config', 'a\\b', 'evil\nname']:
            with self.assertRaises(ValueError):
                publish_changes.checked_path(path)

    def test_symlink_patch_is_rejected(self):
        Path(self.work, 'link').symlink_to('/tmp/outside')
        self.git('add', 'link')
        data = self.git('diff', '--cached', '--binary')
        self.git('reset', '--hard', self.sha)
        with self.assertRaises(ValueError):
            publish_changes.validate_patch(self.work, data)

    def test_modifying_an_existing_symlink_is_rejected(self):
        Path(self.work, 'link').symlink_to('hello.txt')
        self.git('add', 'link')
        self.git('commit', '-qm', 'existing link')
        original = self.git('rev-parse', 'HEAD').decode().strip()
        Path(self.work, 'link').unlink()
        Path(self.work, 'link').symlink_to('/tmp/outside')
        self.git('add', 'link')
        data = self.git('diff', '--cached', '--binary', original)
        self.git('reset', '--hard', original)
        self.assertIn(b'120000', data)
        self.assertNotIn(b'new mode', data)
        with self.assertRaises(ValueError):
            publish_changes.validate_patch(self.work, data)

    @staticmethod
    def strip_optional_mode_headers(data):
        return re.sub(rb'^(?:index .*|deleted file mode .*|old mode .*|new mode .*)\n', b'', data, flags=re.M)

    def test_stripped_header_symlink_edits_and_deletions_are_rejected(self):
        Path(self.work, 'link').symlink_to('before')
        self.git('add', 'link')
        self.git('commit', '-qm', 'existing link')
        original = self.git('rev-parse', 'HEAD').decode().strip()
        for change in ['retarget', 'delete']:
            with self.subTest(change=change):
                Path(self.work, 'link').unlink()
                if change == 'retarget':
                    Path(self.work, 'link').symlink_to('after')
                self.git('add', '-A')
                data = self.strip_optional_mode_headers(self.git('diff', '--cached', '--binary', original))
                self.git('reset', '--hard', original)
                self.assertNotIn(b'120000', data)
                # Git itself accepts these header-free changes, which is why a
                # text-only mode filter cannot enforce the publication policy.
                self.git_apply_check(data)
                with self.assertRaisesRegex(ValueError, 'index entries'):
                    publish_changes.validate_patch(self.work, data)
                self.assertEqual(os.readlink(Path(self.work, 'link')), 'before')

    def git_apply_check(self, data):
        subprocess.run(['git', 'apply', '--check', '--index', '-'], cwd=self.work,
                       input=data, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def test_stripped_header_submodule_edits_and_deletions_are_rejected(self):
        self.git('update-index', '--add', '--cacheinfo', f'160000,{self.sha},module')
        self.git('commit', '-qm', 'existing submodule entry')
        original = self.git('rev-parse', 'HEAD').decode().strip()
        for change in ['update', 'delete']:
            with self.subTest(change=change):
                if change == 'update':
                    self.git('update-index', '--cacheinfo', f'160000,{original},module')
                else:
                    self.git('update-index', '--force-remove', 'module')
                data = self.strip_optional_mode_headers(self.git('diff', '--cached', '--binary', original))
                self.git('reset', '--hard', original)
                self.assertNotIn(b'160000', data)
                # A header-free deletion may also be rejected by Git as an
                # ambiguous patch. Neither outcome may mutate the real index.
                with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                    publish_changes.validate_patch(self.work, data)
                self.assertEqual(self.git('rev-parse', ':module').decode().strip(), self.sha)

    def test_submodule_addition_is_rejected(self):
        self.git('update-index', '--add', '--cacheinfo', f'160000,{self.sha},module')
        data = self.git('diff', '--cached', '--binary', self.sha)
        self.git('reset', '--hard', self.sha)
        with self.assertRaises(ValueError):
            publish_changes.validate_patch(self.work, data)

    def test_regular_deletion_passes_without_changing_actual_index(self):
        Path(self.work, 'hello.txt').unlink()
        self.git('add', '-A')
        data = self.git('diff', '--cached', '--binary', self.sha)
        self.git('reset', '--hard', self.sha)
        original_tree = self.git('write-tree')
        self.assertEqual(publish_changes.validate_patch(self.work, data), ['hello.txt'])
        self.assertEqual(self.git('write-tree'), original_tree)
        self.assertTrue(Path(self.work, 'hello.txt').is_file())

    def test_untouched_symlink_does_not_block_regular_changes(self):
        Path(self.work, 'link').symlink_to('hello.txt')
        self.git('add', 'link')
        self.git('commit', '-qm', 'unrelated link')
        self.sha = self.git('rev-parse', 'HEAD').decode().strip()
        data = self.changed_patch()
        self.assertEqual(publish_changes.validate_patch(self.work, data), ['hello.txt'])
        self.assertEqual(os.readlink(Path(self.work, 'link')), 'hello.txt')

    def test_empty_patch_is_a_noop_and_large_patch_is_rejected(self):
        self.assertEqual(publish_changes.validate_patch(self.work, b''), [])
        with self.assertRaises(ValueError):
            publish_changes.validate_patch(self.work, b'x' * (publish_changes.MAX_PATCH_BYTES + 1))

    def test_fork_and_read_only_context_cannot_reach_mutation(self):
        for context in [{'writable': False}, {'writable': True, 'pull_request': {'is_fork': True}}]:
            with patch.object(publish_changes, 'validate_patch') as validate, patch.object(publish_changes, 'gh_rest') as api:
                self.assertEqual(publish_changes.publish_patch(context, self.work, b'untrusted'), '')
                validate.assert_not_called()
                api.assert_not_called()

    def test_checkout_mismatch_cannot_publish(self):
        data = self.changed_patch()
        with self.assertRaisesRegex(ValueError, 'differs'):
            publish_changes.publish_patch({'writable': True, 'checkout_sha': '0' * 40}, self.work, data)

    def test_collector_includes_new_files_and_uses_captured_revision(self):
        Path(self.work, 'new.txt').write_text('new\n')
        with tempfile.TemporaryDirectory() as output:
            dest = Path(output, 'changes.patch')
            with patch.dict(os.environ, {'WORK_DIR': self.work, 'PATCH_FILE': str(dest),
                                         'RESULT_FILE': str(Path(output, 'result.md'))}), \
                 patch.object(collect_changes, 'load_context', return_value={'writable': True, 'checkout_sha': self.sha}):
                collect_changes.main()
            data = dest.read_bytes()
        self.assertIn(b'new.txt', data)

    # Synthetic credential shapes, assembled at runtime so no literal token sits in the source.
    FAKE_KEY = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----\nAAAA\n'
    FAKE_AUTH = '{"tokens": {"refresh_' + 'token": "' + 'r' * 32 + '"}}\n'
    FAKE_GITHUB = 'token = "' + 'gh' + 'p_' + 'A' * 36 + '"\n'

    def test_collector_refuses_sensitive_paths_and_contents_before_upload(self):
        for path, text in [('.env.production', 'A=1\n'), ('.codex/auth.json', '{}\n'), ('deploy.pem', 'x\n'),
                           ('notes.txt', self.FAKE_KEY), ('config/auth.json', self.FAKE_AUTH), ('app.toml', self.FAKE_GITHUB)]:
            with self.subTest(path=path), tempfile.TemporaryDirectory() as output:
                Path(self.work, path).parent.mkdir(parents=True, exist_ok=True)
                Path(self.work, path).write_text(text)
                dest = Path(output, 'changes.patch')
                with patch.dict(os.environ, {'WORK_DIR': self.work, 'PATCH_FILE': str(dest),
                                             'RESULT_FILE': str(Path(output, 'result.md'))}), \
                     patch.object(collect_changes, 'load_context', return_value={'writable': True, 'checkout_sha': self.sha}), \
                     self.assertRaises(ValueError):
                    collect_changes.main()
                self.assertFalse(dest.exists(), 'nothing may reach the uploaded artifact')
                self.git('reset', '-q', '--hard', self.sha)
                self.git('clean', '-qfdx')

    def test_a_credential_in_a_path_context_or_removed_line_is_refused_at_collection_and_publication(self):
        token = 'gh' + 'p_' + 'B' * 36
        Path(self.work, 'kept.txt').write_text(f'{token}\nline\n')
        self.git('add', '-A')
        self.git('commit', '-qm', 'synthetic committed value')
        self.sha = self.git('rev-parse', 'HEAD').decode().strip()
        for change in ['path', 'context', 'removed']:
            with self.subTest(change=change):
                if change == 'path':
                    data = self.changed_patch(f'{token}.txt', 'harmless\n')
                elif change == 'context':
                    data = self.changed_patch('kept.txt', f'{token}\nline changed\n')
                else:
                    data = self.changed_patch('kept.txt', 'line\n')
                self.assertNotRegex(b'\n'.join(l for l in data.splitlines() if l.startswith(b'+') and not l.startswith(b'+++')),
                                    token.encode())
                with self.assertRaisesRegex(ValueError, 'credential'):
                    publish_changes.validate_patch(self.work, data)
                with self.assertRaisesRegex(ValueError, 'credential'):
                    publish_changes.check_patch_content(data)
        Path(self.work, f'{token}.txt').write_text('harmless\n')
        with tempfile.TemporaryDirectory() as output:
            with self.assertRaisesRegex(ValueError, 'credential'):
                self.collect(output)
            self.assertFalse(Path(output, 'changes.patch').exists())

    def collect(self, output, writable=True):
        with patch.dict(os.environ, {'WORK_DIR': self.work, 'PATCH_FILE': str(Path(output, 'changes.patch')),
                                     'RESULT_FILE': str(Path(output, 'result.md'))}), \
             patch.object(collect_changes, 'load_context', return_value={'writable': writable, 'checkout_sha': self.sha}):
            collect_changes.main()

    def test_a_refused_collection_leaves_no_stale_patch_at_the_upload_path(self):
        Path(self.work, 'notes.txt').write_text(self.FAKE_KEY)
        with tempfile.TemporaryDirectory() as output:
            Path(output, 'changes.patch').write_bytes(b'left by an earlier step\n')
            with self.assertRaises(ValueError):
                self.collect(output)
            self.assertFalse(Path(output, 'changes.patch').exists())

    def test_binary_changes_cannot_be_inspected_and_are_refused(self):
        Path(self.work, 'blob.bin').write_bytes(b'\0\x01' + self.FAKE_KEY.encode())
        with tempfile.TemporaryDirectory() as output:
            with self.assertRaisesRegex(ValueError, 'Binary'):
                self.collect(output)
            self.assertFalse(Path(output, 'changes.patch').exists())
        Path(self.work, 'blob.bin').unlink()
        Path(self.work, 'hello.txt').write_bytes(b'\0binary\n')
        self.git('add', '-A')
        data = self.git('diff', '--cached', '--binary', self.sha)
        self.git('reset', '-q', '--hard', self.sha)
        with self.assertRaisesRegex(ValueError, 'Binary'):
            publish_changes.validate_patch(self.work, data)

    def test_a_credential_in_the_reply_is_refused_before_upload_and_at_publication(self):
        for writable in (True, False):
            with self.subTest(writable=writable), tempfile.TemporaryDirectory() as output:
                Path(output, 'result.md').write_text('Here it is: ' + self.FAKE_GITHUB)
                with self.assertRaisesRegex(ValueError, 'Reply'):
                    self.collect(output, writable)
                self.assertFalse(Path(output, 'changes.patch').exists())
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, 'status.json').write_text('{"exit_code":0}')
            Path(folder, 'result.md').write_text(self.FAKE_AUTH)
            with patch.dict(os.environ, {'RESULT_FILE': str(Path(folder, 'result.md'))}), self.assertRaisesRegex(ValueError, 'Reply'):
                validate_result.main()

    def test_an_ordinary_reply_is_collected(self):
        with tempfile.TemporaryDirectory() as output:
            Path(output, 'result.md').write_text('Reviewed; sk-short is not a key.\n')
            self.collect(output, writable=False)
            self.assertEqual(Path(output, 'changes.patch').read_bytes(), b'')

    def test_publisher_repeats_the_content_check(self):
        data = self.changed_patch('notes.txt', self.FAKE_KEY)
        with self.assertRaisesRegex(ValueError, 'credential'):
            publish_changes.validate_patch(self.work, data)
        self.assertEqual(publish_changes.validate_patch(self.work, self.changed_patch('notes.txt', 'sk-short\n')), ['notes.txt'])

    def test_publisher_creates_only_a_generated_branch_and_draft_pr(self):
        data = self.changed_patch()
        with tempfile.TemporaryDirectory() as remote:
            subprocess.run(['git', 'init', '--bare', '-q', remote], check=True)
            self.git('remote', 'add', 'origin', remote)
            context = {'writable': True, 'checkout_sha': self.sha, 'agent': 'codex', 'command': 'fix',
                       'number': 15, 'repo': 'example-org/example-repo', 'default_branch': 'main', 'base_ref': 'develop',
                       'run_url': 'https://github.com/example-org/example-repo/actions/runs/123', 'source_url': ''}
            with patch.dict(os.environ, {'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1'}), \
                 patch.object(publish_changes, 'gh_rest', return_value={'html_url': 'https://github.com/example-org/example-repo/pull/20'}) as api:
                url = publish_changes.publish_patch(context, self.work, data)
            self.assertEqual(url, 'https://github.com/example-org/example-repo/pull/20')
            body = api.call_args.kwargs['body']
            self.assertEqual(body['head'], 'agent/codex/123-1')
            self.assertEqual(body['base'], 'develop')  # the configured base branch, not the default
            self.assertTrue(body['draft'])
            self.assertEqual(body['title'], 'Agent changes: fix #15')
            self.assertIn('Implements the authorized request', body['body'])
            self.assertIn('Needs independent review and the usual CI', body['body'])
            self.assertIn('does not trigger the usual pull_request CI', body['body'])
            self.assertIn(context['run_url'], body['body'])
            refs = subprocess.check_output(['git', '--git-dir', remote, 'for-each-ref', '--format=%(refname)']).decode()
            self.assertEqual(refs.strip(), 'refs/heads/agent/codex/123-1')

    def test_existing_generated_branch_is_never_updated(self):
        data = self.changed_patch()
        with tempfile.TemporaryDirectory() as remote:
            subprocess.run(['git', 'init', '--bare', '-q', remote], check=True)
            self.git('remote', 'add', 'origin', remote)
            self.git('push', '-q', 'origin', 'HEAD:refs/heads/agent/codex/123-1')
            context = {'writable': True, 'checkout_sha': self.sha, 'agent': 'codex', 'command': 'fix', 'number': 15,
                       'base_ref': 'main'}
            with patch.dict(os.environ, {'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1'}), \
                 patch.object(publish_changes, 'gh_rest') as api, self.assertRaisesRegex(ValueError, 'already exists'):
                publish_changes.publish_patch(context, self.work, data)
            api.assert_not_called()
            head = subprocess.check_output(['git', '--git-dir', remote, 'rev-parse', 'refs/heads/agent/codex/123-1']).decode().strip()
            self.assertEqual(head, self.sha)


class ArtifactValidation(unittest.TestCase):
    def test_rejects_symlinks_oversize_unknown_files_and_bad_status(self):
        for kind in ['symlink', 'oversize', 'unknown', 'status']:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as folder:
                path = Path(folder, 'result.md')
                if kind == 'symlink': path.symlink_to('/etc/passwd')
                elif kind == 'oversize': path.write_text('x' * 100001)
                elif kind == 'unknown': Path(folder, 'event.json').write_text('{}')
                else: Path(folder, 'status.json').write_text('{"exit_code":"zero"}')
                with patch.dict(os.environ, {'RESULT_FILE': str(path)}), self.assertRaises(ValueError):
                    validate_result.main()

    def test_missing_status_or_success_without_reply_is_invalid(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'RESULT_FILE': str(Path(folder, 'result.md'))}):
            with self.assertRaisesRegex(ValueError, 'status is missing'):
                validate_result.main()
            Path(folder, 'status.json').write_text('{"exit_code":0}')
            with self.assertRaisesRegex(ValueError, 'has no reply'):
                validate_result.main()

    def test_missing_output_composes_a_failure_reply(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {
                'RESULT_FILE': str(Path(folder, 'result.md')), 'STATUS_FILE': str(Path(folder, 'status.json'))}):
            text = publish_result.compose({'agent': 'codex', 'run_url': 'https://github.com/example-org/example-repo/actions/runs/1'})
            self.assertIn('produced no reply', text)
            self.assertIn('not run', text)
            self.assertIn('Run log', text)


WORKFLOW = (Path(__file__).resolve().parents[3] / '.github/workflows/ask-agent.yml').read_text()


def workflow_step(name):
    start = WORKFLOW.index(f'      - name: {name}\n')
    end = WORKFLOW.find('\n      - ', start + 1)
    return WORKFLOW[start:end]


GATE = workflow_step('Stop before rendering a credential-shaped variable')
# Each check of the rendered values: (format template, listed `vars.NAME` arguments, matched text).
CONSUMED = re.findall(r"contains\(format\('([^']*)',(.*?)\), '([^']*)'\)", GATE, re.DOTALL)


def gate_stops(variables):
    """The gate as Actions evaluates it: `contains` ignores case, `toJSON(vars)` is indented JSON that leaves
    non-ASCII text unescaped, and `format` fills each listed variable, or an empty string when it is unset."""
    rendered = json.dumps(variables, indent=2, ensure_ascii=False).lower()
    needles = [literal.replace("''", "'").lower() for literal in re.findall(r"contains\(toJSON\(vars\), '((?:[^']|'')*)'\)", GATE)]
    filled = [(template.format(*(variables.get(name.strip().removeprefix('vars.'), '') for name in names.split(','))), needle)
              for template, names, needle in CONSUMED]
    return any(text in rendered for text in needles) or any(needle.lower() in text.lower() for text, needle in filled)


class WorkflowGates(unittest.TestCase):
    def test_a_credential_shaped_variable_stops_before_the_routing_step_renders_it(self):
        self.assertLess(WORKFLOW.index(GATE), WORKFLOW.index('      - name: Route mention\n'))
        self.assertNotIn('env:', GATE)
        self.assertNotIn('${{', GATE)
        self.assertIn('exit 1', GATE)
        from agent_lib import _CREDENTIAL_JSON_KEYS, _CREDENTIAL_PREFIXES
        for prefix in _CREDENTIAL_PREFIXES:
            self.assertTrue(gate_stops({'CODEX_ACTION_MODEL': ' ' + prefix + 'x' * 20}), prefix)
        for key in _CREDENTIAL_JSON_KEYS:
            self.assertIn(f"{key.split('_')[-1]}\\\"')", GATE)
        # The values checked for `sk-` and `sk_live` anywhere are exactly the ones the routing step renders, in its order.
        rendered = re.findall(r'^ +((?:CLAUDE|CODEX)_ACTION_\w+): \$\{\{ vars\.\1 \}\}$', workflow_step('Route mention'), re.M)
        self.assertEqual([needle for _, _, needle in CONSUMED], ['sk-', 'sk_live'])
        for template, names, _ in CONSUMED:
            self.assertEqual([name.strip().removeprefix('vars.') for name in names.split(',')], rendered)
            self.assertEqual(template, ' '.join(f'{{{index}}}' for index in range(len(rendered))))

    def test_the_gate_catches_every_value_the_routing_step_recognises(self):
        from agent_lib import credential_shaped_variables
        fake = 'sk-' + 'proj-' + 'x' * 24
        # F004 round 4: Unicode padding, one character or several, before a prefix or JSON credential.
        padded = [' ' + fake, ' 　 ' + fake, ' ghp_' + 'x' * 20, ' {"access_' + 'token": "a"}']
        values = ['configured-model', '', fake, ' ' + fake, '\n' + fake, '\t' + fake, '\r\n' + fake, '\x0b' + fake,
                  '{"tokens": {"refresh_' + 'token": "r"}}', ' {"access_' + 'token": "a"}', 'high', 'Bash(gh pr:*)', *padded]
        for value in values:
            with self.subTest(value=repr(value)):
                stops = gate_stops({'CLAUDE_ACTION_MODEL': value, 'UNRELATED': 'x'})
                flagged = credential_shaped_variables({'CLAUDE_ACTION_MODEL': value})
                if flagged:
                    self.assertTrue(stops, 'the routing step would render a value it then refuses')
                if value in padded:
                    self.assertTrue(flagged and stops, 'configuration consumption strips the padding')
                if value in ('configured-model', '', 'high', 'Bash(gh pr:*)'):
                    self.assertFalse(stops)
        # Ordinary words contain `sk-`: in a variable the routing step never renders, they do not stop the run.
        self.assertFalse(gate_stops({'CLAUDE_ACTION_MODEL': 'configured-model', 'DEPLOY_TARGET': 'flask-app', 'QUEUE': 'Task-runner',
                                     'TASK_LIVE_URL': 'https://example.invalid/disk_live'}))
        self.assertTrue(gate_stops({'CODEX_ACTION_EFFORT': 'high', 'CLAUDE_ACTION_MAX_TURNS': ' ' + fake}))

    def test_debug_logging_stops_before_any_job_evaluates_a_variable(self):
        first_vars = WORKFLOW.index('vars')
        gate_job = WORKFLOW.index('  debug-gate:\n')
        self.assertLess(gate_job, first_vars)
        self.assertIn('needs: debug-gate', WORKFLOW[gate_job:WORKFLOW.index('  execute:\n')])
        prepare = WORKFLOW[WORKFLOW.index('  prepare:\n'):WORKFLOW.index('  execute:\n')]
        self.assertLess(prepare.index("if: runner.debug == '1'"), prepare.index('vars'))

    def test_only_a_successful_collection_is_uploaded(self):
        self.assertIn("if: always() && steps.collect.outcome == 'success'", workflow_step('Save bounded agent output'))
        self.assertIn('id: collect', workflow_step('Collect changes as untrusted patch data'))

    def test_the_credentialed_step_gets_only_its_own_secret_and_tools_only_in_the_bounded_worker(self):
        claude, env, _ = run_agent.claude_command(AgentConfig('claude', {}), True, BOUNDS)
        self.assertEqual([claude[claude.index(flag) + 1] for flag in ('--tools', '--allowedTools', '--permission-mode')],
                         ['Bash', 'Bash', 'dontAsk'])
        self.assertEqual((env['CLAUDE_CODE_SHELL_PREFIX'], env['BOUNDED_MODE'], env['BOUNDED_GIT']),
                         (str(run_agent.BOUNDED_SHELL), 'write', '/work/repo/.git'))
        self.assertTrue(run_agent.BOUNDED_SHELL.is_file())
        self.assertNotIn('--dangerously-skip-permissions', claude)
        narrowed, _, _ = run_agent.claude_command(AgentConfig('claude', {'CLAUDE_ACTION_ALLOWED_TOOLS': 'Edit,Read'}), True, BOUNDS)
        self.assertEqual(narrowed[narrowed.index('--tools') + 1], '', 'narrowing never adds a tool')
        self.assertEqual(run_agent.claude_command(AgentConfig('claude', {}), False, BOUNDS)[1]['BOUNDED_MODE'], 'read')
        for writable, grant in ((False, 'read'), (True, 'write')):
            with patch.dict(os.environ, {'OPENAI_API_KEY': 'test-placeholder'}, clear=True), redirect_stdout(io.StringIO()):
                codex, _, _ = run_agent.codex_command(AgentConfig('codex', {'CODEX_ACTION_SANDBOX': 'danger-full-access'}), '/tmp/r.md',
                                                      BOUNDS, writable)
            self.assertNotIn('--sandbox', codex)
            self.assertFalse(any('danger' in arg or 'network_access' in arg for arg in codex))
            for pair in ('default_permissions="bounded"', 'permissions.bounded.network.enabled=false',
                         'shell_environment_policy.inherit="none"', 'approval_policy="never"'):
                self.assertIn(pair, codex)
            filesystem = next(arg for arg in codex if arg.startswith('permissions.bounded.filesystem='))
            self.assertIn(f'":workspace_roots"="{grant}"', filesystem)
            self.assertIn('"/work/repo/.git"="read"', filesystem)
            self.assertIn('"/opt/tool"="read"', filesystem)

    def test_toolchain_mounts_exclude_home_and_login_locations(self):
        with tempfile.TemporaryDirectory() as root:
            for folder in ('home/.local/bin', 'home/.nvm/v1/bin', 'temp/login/bin', 'opt/tool/bin'):
                Path(root, folder).mkdir(parents=True)
            path = ':'.join(str(Path(root, folder)) for folder in ('home/.local/bin', 'home/.nvm/v1/bin', 'temp/login/bin', 'opt/tool/bin', 'home'))
            dirs = run_agent.toolchain_dirs(path + ':relative/bin', str(Path(root, 'home')), (str(Path(root, 'temp')),))
            real = os.path.realpath(root)
            self.assertEqual(sorted(dirs), sorted(f'{real}/{folder}' for folder in ('home/.local/bin', 'home/.nvm/v1/bin', 'home/.nvm/v1',
                                                                                     'opt/tool/bin', 'opt/tool')))

    def test_execute_job_checks_out_the_worker_shell_and_prepares_namespaces_before_credentials(self):
        execute = WORKFLOW[WORKFLOW.index('  execute:\n'):WORKFLOW.index('  publish:\n')]
        self.assertIn('plugins/dev-skills/skills/dev-review-pr/scripts', execute)
        self.assertLess(execute.index('bubblewrap'), execute.index('CLAUDE_CODE_OAUTH_TOKEN'))


# A synthetic worker description: no path in it is read by the command builders.
BOUNDS = {'scratch': '/scratch', 'path': '/usr/bin:/opt/tool/bin', 'git': ['/work/repo/.git'], 'work_dir': '/work/repo',
          'read': ['/opt/tool/bin', '/opt/tool']}


class BoundedWorker(unittest.TestCase):
    """The real worker shell with synthetic markers; skipped where bubblewrap or user namespaces are unavailable."""

    def test_a_synthetic_credential_and_environment_marker_stay_outside_while_edit_diff_and_check_work(self):
        if subprocess.run(['bwrap', '--unshare-all', '--ro-bind', '/', '/', 'true'], capture_output=True).returncode if shutil.which('bwrap') else 1:
            self.skipTest('bubblewrap or user namespaces unavailable')
        with tempfile.TemporaryDirectory() as root:
            work, login = Path(root, 'repo'), Path(root, 'temp')
            work.mkdir()
            login.mkdir()
            Path(login, 'auth.json').write_text('{"synthetic": "LOGIN-MARKER-5b7a"}')
            subprocess.run(['git', 'init', '-q', str(work)], check=True)
            Path(work, 'app.txt').write_text('before\n')
            subprocess.run(['git', '-C', str(work), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(work), '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'x'], check=True)
            with patch.dict(os.environ, {'RUNNER_TEMP': str(login), 'HOME': str(Path(root, 'home')), 'SYNTHETIC_PROVIDER_TOKEN': 'ENV-MARKER-3c9f'}):
                bounds = run_agent.worker_bounds(str(work))
                _, env, _ = run_agent.claude_command(AgentConfig('claude', {}), True, bounds)
                run_agent.probe_worker(env)
                shell = lambda command: subprocess.run([env['CLAUDE_CODE_SHELL_PREFIX'], command], cwd=work, capture_output=True, text=True,  # noqa: E731
                                                       env={**os.environ, **env})
                seen = shell(f'cat {login}/auth.json; env; cat /proc/*/environ; echo after > app.txt; git diff --stat; '
                             'test "$(cat app.txt)" = after && echo CHECKED')
            self.assertNotIn('LOGIN-MARKER-5b7a', seen.stdout + seen.stderr)
            self.assertNotIn('ENV-MARKER-3c9f', seen.stdout + seen.stderr)
            self.assertIn('app.txt | 2 +-', seen.stdout)
            self.assertIn('CHECKED', seen.stdout)
            self.assertNotEqual(shell('echo x > .git/planted').returncode, 0)
            self.assertFalse(Path(work, '.git/planted').exists())
            shutil.rmtree(bounds['scratch'], ignore_errors=True)


class LaunchBoundary(unittest.TestCase):
    def test_child_has_no_github_or_actions_credentials(self):
        with patch.dict(os.environ, {'GH_TOKEN': 'gh-test', 'GITHUB_TOKEN': 'token-test', 'ACTIONS_RUNTIME_TOKEN': 'artifact-test',
                                    'CODEX_AUTH_JSON': '{}', 'CLAUDE_CODE_OAUTH_TOKEN': 'claude-test'}, clear=True), \
             patch.object(run_agent.subprocess, 'Popen') as popen, redirect_stdout(io.StringIO()):
            run_agent.launch(['codex', 'exec', 'prompt'], {'CODEX_HOME': '/tmp/fake'}, '/tmp', 'stderr')
        environment = popen.call_args.kwargs['env']
        self.assertEqual(environment, {'CODEX_HOME': '/tmp/fake'})
        self.assertTrue(popen.call_args.kwargs['start_new_session'])

    def test_codex_fallback_maps_repository_secret_to_actual_cli_key(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {
                'RUNNER_TEMP': folder, 'OPENAI_API_KEY': 'test-placeholder',
                'CODEX_API_KEY': 'unselected-inherited-key'}, clear=True), \
             patch.object(run_agent.subprocess, 'Popen') as popen, redirect_stdout(io.StringIO()):
            argv, selected, capture = run_agent.codex_command(AgentConfig('codex', {}), str(Path(folder, 'result.md')), BOUNDS)
            run_agent.launch(argv, selected, folder, capture)
            child = popen.call_args.kwargs['env']
            self.assertEqual(child['CODEX_API_KEY'], 'test-placeholder')
            self.assertNotIn('OPENAI_API_KEY', child)
            self.assertFalse(Path(selected['CODEX_HOME'], 'auth.json').exists())

    def test_codex_oauth_selection_strips_both_api_keys_from_child(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {
                'RUNNER_TEMP': folder, 'CODEX_AUTH_JSON': '{"tokens":{"access_token":"test-placeholder"}}',
                'OPENAI_API_KEY': 'unselected-secret', 'CODEX_API_KEY': 'unselected-inherited-key',
                'CLAUDE_CODE_OAUTH_TOKEN': 'unselected-provider'}, clear=True), \
             patch.object(run_agent.subprocess, 'Popen') as popen, redirect_stdout(io.StringIO()):
            argv, selected, capture = run_agent.codex_command(AgentConfig('codex', {}), str(Path(folder, 'result.md')), BOUNDS)
            run_agent.launch(argv, selected, folder, capture)
            child = popen.call_args.kwargs['env']
            for name in ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_AUTH_JSON', 'CLAUDE_CODE_OAUTH_TOKEN']:
                self.assertNotIn(name, child)
            self.assertEqual(json.loads(Path(child['CODEX_HOME'], 'auth.json').read_text())['tokens']['access_token'],
                             'test-placeholder')

    def test_claude_child_strips_all_codex_credentials(self):
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'unselected-secret', 'CODEX_API_KEY': 'unselected-key',
                                    'CODEX_AUTH_JSON': '{}', 'CLAUDE_CODE_OAUTH_TOKEN': 'selected-claude'}, clear=True), \
             patch.object(run_agent.subprocess, 'Popen') as popen, redirect_stdout(io.StringIO()):
            run_agent.launch(['claude', '-p', 'prompt'], {}, '/tmp', 'stdout')
        self.assertEqual(popen.call_args.kwargs['env'], {'CLAUDE_CODE_OAUTH_TOKEN': 'selected-claude'})

    def test_cli_timeout_kills_process_group_and_records_124(self):
        from unittest.mock import Mock
        process = Mock(pid=123)
        process.communicate.side_effect = [subprocess.TimeoutExpired('agent', 60), ('partial', 'header')]
        with patch.object(run_agent, 'load_config', return_value=AgentConfig('codex', {'CODEX_ACTION_TIMEOUT_MINUTES': '999'})), \
             patch.object(run_agent.os, 'killpg') as kill:
            self.assertEqual(run_agent.run(process, 'stderr'), (124, 'header'))
        self.assertEqual(process.communicate.call_args_list[0].kwargs['timeout'], 1500)
        kill.assert_called_once()

    def test_the_prompt_travels_on_stdin_not_as_one_huge_argument(self):
        # A single argument over the kernel's per-argument limit fails with E2BIG before launch.
        prompt = 'x' * 300_000
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'test-placeholder'}, clear=True), redirect_stdout(io.StringIO()):
            codex = run_agent.codex_command(AgentConfig('codex', {}), '/tmp/result.md', BOUNDS)[0]
        claude = run_agent.claude_command(AgentConfig('claude', {}), False, BOUNDS)[0]
        self.assertEqual(codex[-1], '-')
        self.assertLess(max(len(arg) for arg in claude + codex), 1000)
        process = subprocess.Popen([sys.executable, '-c', 'import sys; print(len(sys.stdin.read()))'],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        with patch.object(run_agent, 'load_config', return_value=AgentConfig('claude', {})):
            self.assertEqual(run_agent.run(process, 'stdout', prompt), (0, '300000\n'))
        with patch.object(run_agent.subprocess, 'Popen') as popen, redirect_stdout(io.StringIO()):
            run_agent.launch(claude, {}, '/tmp', 'stdout')
        self.assertEqual(popen.call_args.kwargs['stdin'], subprocess.PIPE)

    def test_both_streams_are_captured_without_printing_transcripts(self):
        with patch.object(run_agent.subprocess, 'Popen') as popen, redirect_stdout(io.StringIO()) as output:
            run_agent.launch(['claude', '-p', 'secret request'], {}, '/tmp', 'stdout')
        self.assertNotIn('secret request', output.getvalue())
        self.assertEqual(popen.call_args.kwargs['stdout'], subprocess.PIPE)
        self.assertEqual(popen.call_args.kwargs['stderr'], subprocess.PIPE)


if __name__ == '__main__':
    unittest.main()
