"""Regression tests for the GitHub mention dispatcher.

Run them with:

    python3 -m unittest discover -s scripts/github-agent/tests

They cover the parts that are easy to get quietly wrong: which event maps to
which surface, where the reply goes, and — the classic mistake — which ref a
pull request request should be reviewed or fixed on.
"""

from __future__ import annotations

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import agent_lib  # noqa: E402
import normalize_event  # noqa: E402
from agent_lib import (  # noqa: E402
    AgentConfig,
    credential_shaped_variables,
    find_mention,
    load_config,
    mention_commands,
    parse_request,
    sanitize_mentions,
)
from normalize_event import Skip, extract, resolve_checkout  # noqa: E402

REPO = "example-org/example-repo"


def config(agent: str = "claude", **variables: str) -> AgentConfig:
    return AgentConfig(agent=agent, variables=dict(variables))


def normalize(payload: dict, event_name: str, agent: str = "claude", **variables: str) -> dict:
    """extract() + the request parsing and checkout resolution main() applies."""
    cfg = config(agent, **variables)
    context = extract(payload, event_name, cfg)
    command, request = parse_request(context["search_text"], cfg.mention)
    context.update({"command": command, "request": request, "surface": context["surface"]})
    return context


# --------------------------------------------------------------------------- #
# Mention and command parsing
# --------------------------------------------------------------------------- #


class TestMentionParsing(unittest.TestCase):
    def test_command_is_the_first_known_verb(self):
        self.assertEqual(
            parse_request("@claude review this PR against the issue AC", "@claude"),
            ("review", "this PR against the issue AC"),
        )

    def test_unknown_verb_stays_in_the_request(self):
        command, request = parse_request("@codex please look at this error", "@codex")
        self.assertEqual(command, "")
        self.assertEqual(request, "please look at this error")

    def test_command_may_be_followed_by_a_newline(self):
        self.assertEqual(
            parse_request("@claude fix\nthe encoding bug", "@claude"),
            ("fix", "the encoding bug"),
        )

    def test_punctuation_after_the_mention_is_dropped(self):
        self.assertEqual(parse_request("@claude: plan the migration", "@claude"), ("plan", "the migration"))

    def test_bare_command_keeps_itself_as_the_request(self):
        self.assertEqual(parse_request("@codex review", "@codex"), ("review", "review"))

    def test_mention_inside_a_longer_word_does_not_match(self):
        self.assertEqual(find_mention("ask @claudebot about it", "@claude"), -1)
        self.assertEqual(find_mention("mail me at person@claude.example", "@claude"), -1)

    def test_mention_is_case_insensitive(self):
        self.assertGreaterEqual(find_mention("hey @Claude review this", "@claude"), 0)

    def test_agents_do_not_answer_each_other_by_accident(self):
        self.assertEqual(parse_request("@codex review this", "@claude"), ("", ""))


class TestMentionsInsideCode(unittest.TestCase):
    """Talking *about* an agent must not summon it — otherwise every pull request
    that documents these workflows triggers both of them."""

    def test_inline_code_does_not_trigger(self):
        self.assertEqual(find_mention("Unify the `@claude` / `@codex` pipelines", "@claude"), -1)

    def test_fenced_code_does_not_trigger(self):
        text = "usage:\n\n```\n@claude review\n```\n\nthat is all"
        self.assertEqual(find_mention(text, "@claude"), -1)

    def test_tilde_fences_too(self):
        self.assertEqual(find_mention("~~~\n@codex fix\n~~~", "@codex"), -1)

    def test_indented_and_unterminated_code_does_not_trigger(self):
        # A pasted example that is the only mention would otherwise select a write
        # command that every raw mention agrees with, and so run writable.
        for text in (
            "Example from the docs:\n\n    @claude fix the bug\n",
            "Example:\n\n\t@claude implement it\n",
            "```\n@claude fix the bug\n",
            "~~~~\n@claude fix\n~~~\nstill inside the four-tilde fence\n",
            "- step one\n  ```\n  @claude fix\n  ```\n",
            "Use ```\n@claude fix\n``` as the example.",
        ):
            with self.subTest(text=text):
                self.assertEqual(find_mention(text, "@claude"), -1)
                self.assertEqual(parse_request(text, "@claude"), ("", ""))

    def test_a_mention_after_a_closed_fence_still_triggers(self):
        self.assertEqual(parse_request("```\nlog\n```\n@claude review this", "@claude"), ("review", "this"))

    def test_a_real_mention_outside_code_still_triggers(self):
        text = "`@codex` is the other one. @claude review this please"
        command, request = parse_request(text, "@claude")
        self.assertEqual(command, "review")
        self.assertEqual(request, "this please")

    def test_every_mention_is_listed_with_its_command_code_included(self):
        text = "`@claude fix it` is quoted; @claude review this, thanks @claude"
        self.assertEqual(mention_commands(text, "@claude"), {"fix", "review", ""})

    def test_masking_keeps_offsets_so_the_request_is_intact(self):
        # The mention index is found in the masked text but sliced from the
        # original, so backticked code inside the request survives.
        command, request = parse_request("@claude fix the `a=1` line", "@claude")
        self.assertEqual((command, request), ("fix", "the `a=1` line"))


class TestSanitizeMentions(unittest.TestCase):
    def test_outgoing_replies_cannot_retrigger_the_workflows(self):
        body = sanitize_mentions("Handing this to @codex, and thanks @claude")
        self.assertNotIn("@codex", body)
        self.assertNotIn("@claude", body)
        self.assertIn("@<!-- -->codex", body)
        self.assertIn("@<!-- -->claude", body)

    def test_other_mentions_are_untouched(self):
        self.assertEqual(sanitize_mentions("thanks @collaborator"), "thanks @collaborator")


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #


class TestConfig(unittest.TestCase):
    def test_defaults(self):
        self.assertEqual(config("claude").get("MODEL"), "")
        self.assertEqual(config("codex").get("MODEL"), "")
        self.assertEqual(config("claude").get("MAX_TURNS"), "100")
        self.assertNotIn("SANDBOX", agent_lib.AGENT_DEFAULTS["codex"])

    def test_an_unset_master_switch_follows_repository_visibility(self):
        self.assertTrue(config("claude").enabled(private=True))
        self.assertFalse(config("claude").enabled(private=False))

    def test_an_explicit_master_switch_wins_over_visibility(self):
        self.assertTrue(config("codex", CODEX_ACTION_ENABLED="true").enabled(private=False))
        self.assertFalse(config("codex", CODEX_ACTION_ENABLED="false").enabled(private=True))
        self.assertTrue(config("codex", CODEX_ACTION_ENABLED=" ").enabled(private=True))

    def test_repository_variables_override_defaults(self):
        cfg = config("codex", CODEX_ACTION_MODEL="configured-codex-model")
        self.assertEqual(cfg.get("MODEL"), "configured-codex-model")

    def test_the_other_agents_variables_are_ignored(self):
        cfg = config("claude", CODEX_ACTION_MODEL="configured-codex-model")
        self.assertEqual(cfg.get("MODEL"), "")

    def test_an_empty_variable_falls_back_to_the_default(self):
        self.assertEqual(config("claude", CLAUDE_ACTION_MODEL="  ").get("MODEL"), "")

    def test_a_non_numeric_limit_falls_back_to_the_default(self):
        self.assertEqual(config("claude", CLAUDE_ACTION_CONTEXT_COMMENTS="lots").number("CONTEXT_COMMENTS"), 20)


class TestConfigComesFromAnAllowlist(unittest.TestCase):
    """The pipeline must never hand the whole `vars` context to the job: Actions
    echoes job env into every step's log and variables are not encrypted."""

    def test_only_prefixed_environment_names_are_read(self):
        env = {
            "CLAUDE_ACTION_MODEL": "configured-claude-model",
            "CODEX_ACTION_SANDBOX": "workspace-write",
            "CODEX_AUTH_JSON": "should-never-be-picked-up",
            "AWS_SECRET_ACCESS_KEY": "nope",
            "PATH": "/usr/bin",
        }
        original = os.environ.copy()
        os.environ.clear()
        os.environ.update({**env, "AGENT": "claude"})
        self.addCleanup(lambda: (os.environ.clear(), os.environ.update(original)))
        cfg = load_config()
        self.assertEqual(
            sorted(cfg.variables), ["CLAUDE_ACTION_MODEL", "CODEX_ACTION_SANDBOX"]
        )


class TestCredentialShapedVariables(unittest.TestCase):
    """A credential mis-filed as a variable must stop the run, not be logged."""

    def test_a_codex_auth_json_is_flagged(self):
        variables = {
            "CODEX_ACTION_EXTRA": '{"auth_mode":"chatgpt","tokens":{"refresh_token":"rt.1.AAA"}}'
        }
        self.assertEqual(credential_shaped_variables(variables), ["CODEX_ACTION_EXTRA"])

    def test_keys_and_tokens_are_flagged(self):
        self.assertEqual(
            credential_shaped_variables(
                {
                    "A_ACTION_EXTRA": "-----BEGIN OPENSSH PRIVATE KEY-----",
                    "B_ACTION_EXTRA": "ghp_abcdefghijklmnop",
                    "C_ACTION_EXTRA": "sk-proj-abcdef",
                }
            ),
            ["A_ACTION_EXTRA", "B_ACTION_EXTRA", "C_ACTION_EXTRA"],
        )

    def test_leading_whitespace_is_refused_like_the_workflow_gate(self):
        for padding in (" ", "\n", "\t", "\r\n  "):
            with self.subTest(padding=repr(padding)):
                self.assertEqual(credential_shaped_variables({"X_ACTION_EXTRA": padding + "sk-" + "proj-abc"}), ["X_ACTION_EXTRA"])

    def test_ordinary_configuration_is_not_flagged(self):
        self.assertEqual(
            credential_shaped_variables(
                {
                    "CLAUDE_ACTION_MODEL": "configured-claude-model",
                    "CLAUDE_ACTION_ALLOWED_TOOLS": "Bash(gh pr:*),Bash(gh api:*)",
                    "CODEX_ACTION_EXTRA": "-c model_reasoning_effort=high",
                    "CODEX_ACTION_ENABLED": "",
                }
            ),
            [],
        )


# --------------------------------------------------------------------------- #
# Event routing
# --------------------------------------------------------------------------- #


class TestEventRouting(unittest.TestCase):
    def test_issue_comment_on_an_issue(self):
        context = normalize(
            {
                "action": "created",
                "issue": {"number": 7, "title": "bug"},
                "comment": {"id": 11, "body": "@claude triage this", "html_url": "u"},
            },
            "issue_comment",
        )
        self.assertEqual(context["surface"], "issue")
        self.assertEqual(context["number"], 7)
        self.assertEqual(context["command"], "triage")
        self.assertEqual(context["reply"], {"kind": "issue_comment", "issue_number": 7})
        self.assertEqual(context["react"], {"kind": "issue_comment", "id": 11})

    def test_a_pull_request_conversation_comment_is_still_an_issue_comment(self):
        context = normalize(
            {
                "action": "created",
                "issue": {"number": 639, "title": "feat", "pull_request": {"url": "…"}},
                "comment": {"id": 12, "body": "@claude review", "html_url": "u"},
            },
            "issue_comment",
        )
        self.assertEqual(context["surface"], "pull_request")
        self.assertEqual(context["number"], 639)

    def test_inline_review_comment_replies_in_its_own_thread(self):
        context = normalize(
            {
                "action": "created",
                "pull_request": {"number": 639, "title": "feat"},
                "comment": {
                    "id": 99,
                    "body": "@codex fix this off-by-one",
                    "html_url": "u",
                    "path": "src/a.py",
                    "line": 12,
                    "diff_hunk": "@@ -1 +1 @@",
                },
            },
            "pull_request_review_comment",
            agent="codex",
        )
        self.assertEqual(context["surface"], "pull_request")
        self.assertEqual(context["command"], "fix")
        self.assertEqual(context["reply"]["kind"], "pr_review_comment")
        self.assertEqual(context["reply"]["comment_id"], 99)
        self.assertEqual(context["inline"]["path"], "src/a.py")

    def test_review_body_answers_in_the_conversation(self):
        context = normalize(
            {
                "action": "submitted",
                "pull_request": {"number": 640, "title": "feat"},
                "review": {"body": "@claude audit the migration", "html_url": "u"},
            },
            "pull_request_review",
        )
        self.assertEqual(context["command"], "audit")
        self.assertEqual(context["reply"], {"kind": "issue_comment", "issue_number": 640})
        self.assertEqual(context["react"], {"kind": "issue", "id": 640})

    def test_issue_body_and_title_are_both_searched(self):
        context = normalize(
            {
                "action": "opened",
                "issue": {"number": 8, "title": "@claude implement the form", "body": "details here"},
            },
            "issues",
        )
        self.assertEqual(context["command"], "implement")
        self.assertIn("details here", context["request"])

    def test_pull_request_description(self):
        context = normalize(
            {
                "action": "opened",
                "pull_request": {"number": 641, "title": "feat", "body": "@codex review the schema"},
            },
            "pull_request",
            agent="codex",
        )
        self.assertEqual(context["surface"], "pull_request")
        self.assertEqual(context["command"], "review")

    def test_discussion_comment_targets_the_thread(self):
        context = normalize(
            {
                "action": "created",
                "discussion": {"number": 2, "title": "Worklog", "node_id": "D_1"},
                "comment": {"node_id": "DC_9", "body": "@claude plan the workflows", "html_url": "u"},
            },
            "discussion_comment",
        )
        self.assertEqual(context["surface"], "discussion")
        self.assertEqual(context["reply"]["discussion_node_id"], "D_1")
        self.assertEqual(context["reply"]["comment_node_id"], "DC_9")
        self.assertEqual(context["react"], {"kind": "node", "node_id": "DC_9"})

    def test_discussion_body(self):
        context = normalize(
            {
                "action": "created",
                "discussion": {"number": 3, "title": "TODO", "body": "@codex plan this", "node_id": "D_3"},
            },
            "discussion",
            agent="codex",
        )
        self.assertEqual(context["reply"]["comment_node_id"], "")
        self.assertEqual(context["react"], {"kind": "node", "node_id": "D_3"})

    def test_an_unhandled_action_is_skipped(self):
        with self.assertRaises(Skip):
            normalize({"action": "deleted", "issue": {}, "comment": {}}, "issue_comment")

    def test_an_unhandled_event_is_skipped(self):
        with self.assertRaises(Skip):
            normalize({"action": "created"}, "label")

    def test_a_disabled_event_is_skipped(self):
        with self.assertRaises(Skip) as caught:
            normalize(
                {
                    "action": "created",
                    "issue": {"number": 7},
                    "comment": {"id": 1, "body": "@claude review"},
                },
                "issue_comment",
                CLAUDE_ACTION_ISSUE_COMMENT="false",
            )
        self.assertIn("CLAUDE_ACTION_ISSUE_COMMENT", str(caught.exception))

    def test_each_agent_has_its_own_switch(self):
        payload = {
            "action": "created",
            "issue": {"number": 7},
            "comment": {"id": 1, "body": "@codex review"},
        }
        # Turning Claude's switch off must not silence Codex.
        context = normalize(payload, "issue_comment", agent="codex", CLAUDE_ACTION_ISSUE_COMMENT="false")
        self.assertEqual(context["command"], "review")


class TestEditGuard(unittest.TestCase):
    def test_an_edit_that_adds_the_mention_runs(self):
        context = normalize(
            {
                "action": "edited",
                "issue": {"number": 9, "title": "t", "body": "@claude fix the typo"},
                "changes": {"body": {"from": "no mention here"}},
            },
            "issues",
        )
        self.assertEqual(context["command"], "fix")

    def test_an_edit_that_already_had_the_mention_is_skipped(self):
        with self.assertRaises(Skip):
            normalize(
                {
                    "action": "edited",
                    "issue": {"number": 9, "title": "t", "body": "@claude fix the typo again"},
                    "changes": {"body": {"from": "@claude fix the typo"}},
                },
                "issues",
            )

    def test_an_edit_of_something_other_than_the_text_is_skipped(self):
        with self.assertRaises(Skip):
            normalize(
                {
                    "action": "edited",
                    "issue": {"number": 9, "title": "t", "body": "@claude fix"},
                    "changes": {"labels": {}},
                },
                "issues",
            )

    # An edit runs only when it introduces the mention. The previous text is the whole
    # routed text before the edit, so a mention left untouched in the other field must
    # not become a new request attributed to whoever made the unrelated edit.
    SURFACES = (("issues", "issue"), ("pull_request", "pull_request"), ("discussion", "discussion"))

    def test_a_title_only_edit_does_not_rerun_a_mention_left_in_the_body(self):
        for event_name, key in self.SURFACES:
            with self.subTest(event_name), self.assertRaises(Skip):
                normalize(
                    {
                        "action": "edited",
                        key: {"number": 9, "title": "clearer title", "body": "@claude fix the typo"},
                        "changes": {"title": {"from": "unclear title"}},
                    },
                    event_name,
                )

    def test_a_body_only_edit_does_not_rerun_a_mention_left_in_the_title(self):
        for event_name, key in self.SURFACES:
            with self.subTest(event_name), self.assertRaises(Skip):
                normalize(
                    {
                        "action": "edited",
                        key: {"number": 9, "title": "@claude fix the typo", "body": "clearer body"},
                        "changes": {"body": {"from": "unclear body"}},
                    },
                    event_name,
                )

    def test_a_mention_moved_between_title_and_body_is_not_a_new_request(self):
        with self.assertRaises(Skip):
            normalize(
                {
                    "action": "edited",
                    "issue": {"number": 9, "title": "t", "body": "@claude fix the typo"},
                    "changes": {"title": {"from": "@claude fix the typo"}, "body": {"from": "Body"}},
                },
                "issues",
            )

    def test_a_mention_masked_as_code_before_the_edit_still_counts(self):
        # Code masking is a best guess, so the previous text is searched raw: a
        # mention it hid before the edit must not become the editor's request.
        edits = (
            ({"title": "Error on login", "body": "@claude fix the login failure"}, {"title": {"from": "```Error on login"}}),
            (
                {"title": "t", "body": "> ```text\n> example\n> ```\n> @claude fix the spelling"},
                {"body": {"from": "> ```text\n> example\n>\t```\n> @claude fix the spelling"}},
            ),
            ({"title": "t", "body": "@claude fix the typo"}, {"body": {"from": "`@claude fix the typo`"}}),
        )
        for event_name, key in self.SURFACES:
            for current, changes in edits:
                with self.subTest(event_name, changes=changes), self.assertRaises(Skip):
                    normalize({"action": "edited", key: {"number": 9, **current}, "changes": changes}, event_name)

    def test_an_edit_that_adds_the_mention_to_the_title_runs(self):
        for event_name, key in self.SURFACES:
            with self.subTest(event_name):
                context = normalize(
                    {
                        "action": "edited",
                        key: {"number": 9, "title": "@claude fix the typo", "body": "plain body"},
                        "changes": {"title": {"from": "t"}},
                    },
                    event_name,
                )
                self.assertEqual(context["command"], "fix")


# --------------------------------------------------------------------------- #
# Checkout resolution — the trap the requirements called out
# --------------------------------------------------------------------------- #


class TestCheckoutResolution(unittest.TestCase):
    def setUp(self):
        self.api_calls: list[str] = []
        self.pull = {
            "head": {"ref": "feat/x", "sha": "aaa", "repo": {"full_name": REPO}},
            "base": {"ref": "main", "sha": "bbb"},
        }
        original = normalize_event.gh_rest

        def fake_gh_rest(path, method="GET", body=None):
            self.api_calls.append(path)
            return self.pull

        normalize_event.gh_rest = fake_gh_rest
        self.addCleanup(setattr, normalize_event, "gh_rest", original)

    def resolve(self, surface, command, number=639, payload_pr=None, text=None, base="main", protected=("main",),
                agent="claude"):
        context = {
            "agent": agent,
            "surface": surface,
            "command": command,
            "number": number,
            "payload_pull_request": payload_pr,
            "mention": "@claude",
            "search_text": f"@claude {command}".strip() if text is None else text,
        }
        resolve_checkout(context, REPO, base, protected)
        return context

    def test_issue_requests_work_on_the_default_branch(self):
        context = self.resolve("issue", "fix", number=7)
        self.assertEqual(context["ref"], "main")
        self.assertTrue(context["writable"])
        self.assertEqual(self.api_calls, [])

    def test_issue_requests_start_on_the_configured_base_branch(self):
        context = self.resolve("issue", "fix", number=7, base="develop")
        self.assertEqual((context["ref"], context["base_ref"]), ("develop", "develop"))
        self.assertTrue(context["writable"])

    def test_a_protected_head_branch_is_never_writable(self):
        for head in ("lovable", "develop", "main"):
            with self.subTest(head=head):
                self.pull["head"]["ref"] = head
                context = self.resolve("pull_request", "fix", protected=("main", "develop", "lovable"))
                self.assertEqual(context["ref"], "refs/pull/639/head")
                self.assertFalse(context["writable"])

    def test_review_gets_the_head_ref_read_only(self):
        context = self.resolve("pull_request", "review")
        self.assertEqual(context["ref"], "refs/pull/639/head")
        self.assertFalse(context["writable"])
        self.assertEqual(context["base_ref"], "main")
        self.assertEqual(context["fetch_depth"], 0)

    def test_fix_gets_the_writable_head_branch(self):
        context = self.resolve("pull_request", "fix")
        self.assertEqual(context["ref"], "feat/x")
        self.assertTrue(context["writable"])

    def test_no_command_on_a_pull_request_is_read_only(self):
        context = self.resolve("pull_request", "")
        self.assertEqual(context["ref"], "refs/pull/639/head")
        self.assertFalse(context["writable"])

    def test_a_fork_pull_request_is_never_writable(self):
        self.pull["head"]["repo"]["full_name"] = "someone/example-repo"
        context = self.resolve("pull_request", "fix")
        self.assertEqual(context["ref"], "refs/pull/639/head")
        self.assertFalse(context["writable"])
        self.assertTrue(context["pull_request"]["is_fork"])

    def test_refs_are_resolved_from_the_api_when_the_payload_lacks_them(self):
        # This is the issue_comment-on-a-pull-request case: the payload has no
        # head or base, and using the event's own ref would review the default branch.
        self.resolve("pull_request", "review", payload_pr=None)
        self.assertEqual(self.api_calls, [f"repos/{REPO}/pulls/639"])

    def test_the_api_is_not_called_when_the_payload_already_has_the_refs(self):
        self.resolve("pull_request", "review", payload_pr=self.pull)
        self.assertEqual(self.api_calls, [])

    # Code masking is a best guess. Whatever command it selects, a quoted example
    # it misses must not turn a request into a writable run.
    QUOTED_WRITE_EXAMPLES = (
        ">\t```text\n> @claude fix the spelling in README.md\n> ```\n\n@claude review this PR",
        "> Someone wrote:\n>\n>     @claude fix everything\n",
        "> ```\r\n> @claude fix\r\n> ```\r\n",
        "````markdown\n```text\n@claude fix the spelling\n```\n````\n\n@claude review this PR",
        "Use `@claude\nfix the spelling` as an example.\n\n@claude review this PR",
        # F005 round 3: the only mention sits in a code span crossing lines, or in a list item's fence.
        "Use `the bot like\n@claude fix the spelling` in docs.",
        "- Example:\n  ```\n  @claude fix the spelling\n  ```",
        "1. ```text\n   @claude fix the spelling\n   ```",
        "- ~~~\n  @claude fix\n  ~~~",
    )

    def test_a_quoted_write_command_never_makes_the_branch_writable(self):
        for text in self.QUOTED_WRITE_EXAMPLES:
            with self.subTest(text=text):
                command, _ = parse_request(text, "@claude")
                context = self.resolve("pull_request", command, text=text)
                self.assertEqual(context["ref"], "refs/pull/639/head")
                self.assertFalse(context["writable"])

    def test_an_indented_example_in_a_blockquote_never_triggers(self):
        text = "> Someone wrote:\n>\n>     @claude fix everything\n"
        self.assertEqual(parse_request(text, "@claude"), ("", ""))

    def test_a_closed_crlf_or_cr_fence_keeps_the_request_after_it(self):
        for newline in ("\r\n", "\r"):
            text = newline.join(["```", "@claude fix this", "```", "@claude review this PR", ""])
            with self.subTest(newline=repr(newline)):
                self.assertEqual(parse_request(text, "@claude"), ("review", "this PR"))
                self.assertEqual(len(agent_lib.mask_code(text)), len(text))

    def test_both_agents_get_a_writable_checkout_for_an_unambiguous_fix(self):
        for agent in ("claude", "codex"):
            for surface, number in (("issue", 7), ("pull_request", 639)):
                with self.subTest(agent=agent, surface=surface):
                    self.assertTrue(self.resolve(surface, "fix", number=number, agent=agent)["writable"])

    def test_closed_code_before_the_mention_keeps_a_fix_writable(self):
        for text in ("See `a.py` and ``b`c``. @claude fix it", "Plain text.\n\n@claude fix it"):
            with self.subTest(text=text):
                self.assertTrue(self.resolve("pull_request", "fix", text=text)["writable"])

    def test_mentions_naming_different_commands_run_read_only(self):
        context = self.resolve("pull_request", "fix", text="@claude fix the typo, then @claude review it")
        self.assertFalse(context["writable"])

    def test_code_without_a_mention_keeps_a_fix_writable(self):
        text = "@claude fix the `a=1` line\n\n```\nTraceback: a=1\n```"
        context = self.resolve("pull_request", "fix", text=text)
        self.assertEqual(context["ref"], "feat/x")
        self.assertTrue(context["writable"])


if __name__ == "__main__":
    unittest.main()
