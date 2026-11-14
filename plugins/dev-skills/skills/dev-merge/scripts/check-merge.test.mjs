import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  applyEdits, cleanupOutcome, lintSquashMessage, closeoutTarget, detectLang, discoverTargets, gate, lintSquashBody, parseArgs, planCleanup,
  renderCi, renderCloseout, renderReport, resolvePr, runGuardedEdit, t, verifyMerge, warningText,
} from './check-merge.mjs';
import { apply, commandFor, deniedResults, execute, ignoredOf, mergeResults, parseWorktrees } from './apply-cleanup.mjs';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Non-English expectations come from the locale file, so this test stays English.
const LOCALES = JSON.parse(readFileSync(new URL('../locales.json', import.meta.url), 'utf8'));
const ZH = LOCALES.zh;

const REPO = 'example-org/example-repo';
const H = 'a'.repeat(40);
const B = 'b'.repeat(40);
const M = 'c'.repeat(40);
const D = 'd'.repeat(40);
const T1 = 'e'.repeat(40); // head tree
const T2 = 'f'.repeat(40); // merge tree

// ---------- AC-2 ----------

test('AC-2a pr= is first, bare and positive; every other spelling stops', () => {
  assert.equal(parseArgs('pr=134', REPO).args.pr, 134);
  for (const text of ['pr=#134', 'pr=https://github.com/example-org/example-repo/pull/134', 'pr=example-org/example-repo#134', 'pr=0', 'pr=-3', 'pr=1.5', 'pr=', 'pr=134 pr=135', 'dry-run pr=134']) {
    assert.equal(parseArgs(text, REPO).ok, false, text);
  }
});

test('AC-2b without pr= the branch must have exactly one open PR', () => {
  const { args } = parseArgs('', REPO);
  assert.deepEqual(resolvePr(args, [{ number: 7 }]), { ok: true, pr: 7 });
  assert.equal(resolvePr(args, []).reason, 'no-pr');
  assert.equal(resolvePr(args, [{ number: 7 }, { number: 8 }]).reason, 'ambiguous-pr');
});

test('AC-2c mode defaults to closeout and accepts only handover besides', () => {
  assert.equal(parseArgs('pr=1', REPO).args.mode, 'closeout');
  assert.equal(parseArgs('pr=1 mode=handover', REPO).args.mode, 'handover');
  assert.equal(parseArgs('pr=1 mode=full', REPO).ok, false);
});

test('AC-2d cleanup defaults to stale and accepts own or none', () => {
  assert.equal(parseArgs('pr=1', REPO).args.cleanup, 'stale');
  assert.equal(parseArgs('pr=1 cleanup=own', REPO).args.cleanup, 'own');
  assert.equal(parseArgs('pr=1 cleanup=none', REPO).args.cleanup, 'none');
  assert.equal(parseArgs('pr=1 cleanup=all', REPO).ok, false);
});

test('AC-2e issues, tracker and next take repository-local targets only', () => {
  const { args } = parseArgs(`pr=1 issues=#129,71 tracker=71 next=https://github.com/${REPO}/issues/71#issuecomment-6617205486`, REPO);
  assert.deepEqual(args.issues, [129, 71]);
  assert.deepEqual(args.tracker, [71]);
  assert.deepEqual(args.next, { issue: 71, comment: 6617205486 });
  assert.deepEqual(parseArgs('pr=1 next=96', REPO).args.next, { issue: 96 });
  for (const text of ['pr=1 issues=abc', 'pr=1 issues=', 'pr=1 tracker=0', 'pr=1 next=https://github.com/other/repo/issues/1#issuecomment-2', 'pr=1 issues=1 issues=2']) {
    assert.equal(parseArgs(text, REPO).ok, false, text);
  }
});

test('AC-2f dry-run is a flag; unknown keys and positionals stop; notes follow --', () => {
  assert.equal(parseArgs('pr=1 dry-run', REPO).args.dryRun, true);
  assert.equal(parseArgs('pr=1 dry-run dry-run', REPO).ok, false);
  assert.equal(parseArgs('pr=1 colour=blue', REPO).ok, false);
  assert.equal(parseArgs('pr=1 update #71', REPO).ok, false);
  assert.equal(parseArgs("pr=131 -- the earlier runs count as AC5 evidence", REPO).args.notes, "the earlier runs count as AC5 evidence");
});

// ---------- AC-3 ----------

// The shape a review-loop skill publishes for a full or closing review.
const terminal = (head = H, base = B, { phase = 'closing-review', verdict = 'approval-eligible', skill = 'review-pr', at = '2026-11-14T02:00:00Z', association = 'OWNER' } = {}) => ({
  url: 'https://github.com/example-org/example-repo/pull/1#issuecomment-1', createdAt: at, authorAssociation: association,
  body: `<!-- ${skill}: run1 round=2 phase=${phase} -->\n## PR review — round 2 / 10 — final-full\n\nBase: [bbbbbbb](https://github.com/example-org/example-repo/commit/${base}) · Reviewed head: [aaaaaaa](https://github.com/example-org/example-repo/commit/${head}) · [Scope / AC](https://github.com/example-org/example-repo/issues/1)\n\nNo new findings\n\nValidation: \`python3 scripts/validate-local-skills.py\` passed\nVerdict: ${verdict}\n\n---\n🔎 codex·gpt-5.6-sol·xhigh · read-only head: [aaaaaaa](https://github.com/example-org/example-repo/commit/${head}) · context: N/A (not emitted) · 2026-11-14 10:00 AEST · 0:03 · APPROVAL ELIGIBLE\n`,
});
const check = (conclusion = 'SUCCESS') => ({ name: 'validate', status: 'COMPLETED', conclusion, workflowName: 'Local skills tests' });
// The `gh pr view --json reviews` shape: the state, the commit it is bound to, the author's role and when it arrived.
const approval = (overrides = {}) => ({ state: 'APPROVED', commit: { oid: H }, url: 'https://github.com/example-org/example-repo/pull/1#pullrequestreview-1', authorAssociation: 'MEMBER', submittedAt: '2026-11-14T03:00:00Z', ...overrides });
const pr = (overrides = {}) => ({
  state: 'OPEN', isDraft: false, mergeStateStatus: 'CLEAN', labels: [], headRefOid: H,
  statusCheckRollup: [{ name: 'claude', conclusion: 'SKIPPED' }, check()], comments: [terminal()], reviews: [], ...overrides,
});

test('AC-3a open, ready, CLEAN, checks green and reviewed head on an unchanged base passes', () => {
  const result = gate({ pr: pr(), main: B, headTree: T1 });
  assert.equal(result.verdict, 'pass');
  assert.equal(result.expectedTree, T1);
  // Path-filtered workflows may not run at all; the review is then the only evidence.
  assert.equal(gate({ pr: pr({ statusCheckRollup: [] }), main: B, headTree: T1 }).verdict, 'pass');
  // Without the head tree nothing could verify the merge afterwards, so passing would be unverifiable.
  const noTree = gate({ pr: pr(), main: B });
  assert.deepEqual([noTree.verdict, noTree.reason], ['stop', 'head-tree-missing']);
  assert.equal(gate({ pr: pr(), main: B, headTree: 'HEAD^{tree}' }).reason, 'head-tree-missing', 'only an object id can be compared');
});

test('AC-3b each blocking state stops with its reason', () => {
  const cases = {
    'pr-not-open': pr({ state: 'MERGED' }),
    draft: pr({ isDraft: true }),
    'hold-label': pr({ labels: [{ name: 'hold' }] }),
    'checks-not-success': pr({ statusCheckRollup: [check(), { name: 'test', status: 'IN_PROGRESS', conclusion: null }] }),
    'no-review-evidence': pr({ comments: [] }),
    'review-evidence-stale': pr({ comments: [terminal('d'.repeat(40))] }),
    'review-changes-requested': pr({ comments: [], reviews: [approval({ state: 'CHANGES_REQUESTED' })] }),
    'merge-state-DIRTY': pr({ mergeStateStatus: 'DIRTY' }),
    'merge-state-BLOCKED': pr({ mergeStateStatus: 'BLOCKED' }),
    'merge-state-UNKNOWN': pr({ mergeStateStatus: 'UNKNOWN' }),
    'merge-state-UNSTABLE': pr({ mergeStateStatus: 'UNSTABLE' }),
  };
  for (const [reason, input] of Object.entries(cases)) {
    assert.deepEqual([gate({ pr: input, main: B }).verdict, gate({ pr: input, main: B }).reason], ['stop', reason], reason);
  }
  assert.equal(gate({ pr: pr({ statusCheckRollup: [check('FAILURE')] }), main: B }).reason, 'checks-not-success');
  assert.equal(gate({ pr: pr({ statusCheckRollup: [{ context: 'ci/x', state: 'PENDING' }] }), main: B }).detail, 'ci/x:PENDING');
});

test('AC-3c a moved main needs merge-tree facts, then docs-only reuse, verify or stop', () => {
  const moved = { pr: pr(), main: M };
  assert.equal(gate(moved).verdict, 'collect');
  assert.equal(gate({ ...moved, mergeTree: { conflict: true }, mainChanges: [] }).reason, 'merge-conflict');
  assert.deepEqual(gate({ ...moved, mergeTree: { conflict: false, tree: T2 }, mainChanges: ['docs/a.md', 'README.md'] }), { ...gate({ ...moved, mergeTree: { conflict: false, tree: T2 }, mainChanges: ['docs/a.md', 'README.md'] }), verdict: 'pass', reason: 'main-moved-docs-only', expectedTree: T2 });
  assert.equal(gate({ ...moved, mergeTree: { conflict: false, tree: T2 }, mainChanges: ['server/x.ts'] }).verdict, 'verify');
  assert.equal(gate({ ...moved, mergeTree: { conflict: false, tree: T2 }, mainChanges: ['server/x.ts'], verifyExit: 0 }).reason, 'merge-tree-verified');
  assert.equal(gate({ ...moved, mergeTree: { conflict: false, tree: T2 }, mainChanges: ['server/x.ts'], verifyExit: 1 }).reason, 'merge-tree-verify-failed');
  assert.equal(gate({ pr: pr({ mergeStateStatus: 'BEHIND' }), main: B }).verdict, 'collect');
  // Nothing could verify the squash afterwards, so a missing or malformed merge tree stops every moved-main path.
  for (const extra of [{ mainChanges: ['docs/a.md'] }, { mainChanges: ['server/x.ts'], verifyExit: 0 }, { mainChanges: ['server/x.ts'] }]) {
    for (const mergeTree of [{ conflict: false }, { conflict: false, tree: 'tree' }, { conflict: false, tree: null }]) {
      const missing = gate({ ...moved, mergeTree, ...extra });
      assert.deepEqual([missing.verdict, missing.reason], ['stop', 'merge-tree-missing'], JSON.stringify({ mergeTree, ...extra }));
    }
  }
});

test('AC-3c moved-base verification runs the checks the repository AGENTS.md requires, not workflow commands alone', () => {
  const skill = readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8');
  const verify = skill.split('\n').find((line) => line.trimStart().startsWith('- `verify` →'));
  assert.match(verify, /every check command the repository's `AGENTS\.md` requires/);
  assert.match(verify, /When `AGENTS\.md` names no check command, the workflow commands alone verify, and the report says so/);
});

test('AC-3d evidence is the latest marked review on the head, or an APPROVED review of the head', () => {
  const older = terminal();
  const newer = terminal('d'.repeat(40));
  assert.equal(gate({ pr: pr({ comments: [older, newer] }), main: B }).reason, 'review-evidence-stale');
  assert.equal(gate({ pr: pr({ comments: [terminal(H, B, { verdict: 'continue' })] }), main: B }).reason, 'review-evidence-stale');
  assert.equal(gate({ pr: pr({ comments: [older, terminal(H, B, { verdict: 'blocked' })] }), main: B }).reason, 'review-evidence-stale', 'a later verdict on the same head wins');
  assert.equal(gate({ pr: pr({ comments: [terminal(H, B, { phase: 'review' })] }), main: B, headTree: T1 }).verdict, 'pass', 'a clean round-1 full review is terminal too');
  assert.equal(gate({ pr: pr({ comments: [terminal(H, B, { phase: 'final-review' })] }), main: B, headTree: T1 }).verdict, 'pass', 'the review after the closing writer is terminal too');
  assert.equal(gate({ pr: pr({ comments: [terminal(H, B, { phase: 'final-review', verdict: 'blocked' })] }), main: B }).reason, 'review-evidence-stale');
  // Writer, approval-status and closeout comments carry the marker but are not reviews.
  for (const skill of ['review-pr', 'team-review-pr', 'a-b-review-pr']) assert.equal(gate({ pr: pr({ comments: [terminal(H, B, { skill })] }), main: B, headTree: T1 }).verdict, 'pass', skill);
  for (const skill of ['dev-merge', 'review-prs', 'Review-pr']) assert.equal(gate({ pr: pr({ comments: [terminal(H, B, { skill })] }), main: B }).reason, 'no-review-evidence', skill);
  for (const phase of ['writer', 'approval', 'closeout']) assert.equal(gate({ pr: pr({ comments: [terminal(H, B, { phase })] }), main: B }).reason, 'no-review-evidence', phase);
  assert.equal(gate({ pr: pr({ comments: [older, terminal(H, B, { phase: 'writer', verdict: 'continue' })] }), main: B, headTree: T1 }).verdict, 'pass');
  const approved = gate({ pr: pr({ comments: [], reviews: [approval()] }), main: B });
  assert.equal(approved.verdict, 'collect'); // an approval carries no reviewed base, so main counts as moved
  assert.equal(gate({ pr: pr({ comments: [], reviews: [approval({ commit: { oid: B } })] }), main: B }).reason, 'no-review-evidence');
});

test('AC-3d evidence counts only from a trusted author, and only a newer approval revives a withdrawn review', () => {
  const outsider = terminal(H, B, { association: 'NONE' });
  assert.equal(gate({ pr: pr({ comments: [outsider] }), main: B, headTree: T1 }).reason, 'review-evidence-untrusted');
  assert.equal(gate({ pr: pr({ comments: [], reviews: [approval({ authorAssociation: 'CONTRIBUTOR' })] }), main: B }).reason, 'review-evidence-untrusted');
  assert.equal(gate({ pr: pr({ comments: [outsider, terminal()] }), main: B, headTree: T1 }).verdict, 'pass', 'a forged marker does not hide the trusted review before it');
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    assert.equal(gate({ pr: pr({ comments: [terminal(H, B, { association })] }), main: B, headTree: T1 }).verdict, 'pass', association);
  }
  // The newest evidence decides: an approval from before the withdrawal does not override it.
  const withdrawn = terminal(H, B, { verdict: 'blocked', at: '2026-11-14T02:00:00Z' });
  assert.equal(gate({ pr: pr({ comments: [withdrawn], reviews: [approval({ submittedAt: '2026-11-14T01:00:00Z' })] }), main: B, headTree: T1 }).reason, 'review-evidence-stale');
  const revived = gate({ pr: pr({ comments: [withdrawn], reviews: [approval({ submittedAt: '2026-11-14T03:00:00Z' })] }), main: B, headTree: T1 });
  assert.deepEqual([revived.verdict, revived.evidence.kind], ['collect', 'approved-review']); // an approval carries no base, so main counts as moved
});

test('AC-3d only the latest decisive review of each reviewer counts, so a later CHANGES_REQUESTED withdraws an approval', () => {
  const review = (state, login) => approval({ state, author: { login } });
  const run = (reviews, comments = []) => gate({ pr: pr({ comments, reviews }), main: B, headTree: T1 });
  // An approval carries no base, so these passes come out as collect.
  const passes = (result, message) => assert.deepEqual([result.verdict, result.evidence?.kind], ['collect', 'approved-review'], message);
  assert.equal(run([review('APPROVED', 'ann'), review('CHANGES_REQUESTED', 'ann')]).reason, 'review-changes-requested');
  passes(run([review('CHANGES_REQUESTED', 'ann'), review('APPROVED', 'ann')]), 'a new approval clears the request it follows');
  passes(run([review('APPROVED', 'ann'), review('COMMENTED', 'ann')]), 'a COMMENTED review is not decisive');
  assert.equal(run([review('DISMISSED', 'ann')]).reason, 'no-review-evidence', 'a dismissed approval is no evidence');
  // Nobody else can clear a standing request, and it outranks even a marked approval-eligible review.
  assert.equal(run([review('CHANGES_REQUESTED', 'ann'), review('APPROVED', 'bob')]).reason, 'review-changes-requested');
  assert.equal(run([review('CHANGES_REQUESTED', 'ann')], [terminal()]).reason, 'review-changes-requested');
  // Anyone may review, so only a trusted reviewer blocks.
  passes(run([review('APPROVED', 'ann'), approval({ state: 'CHANGES_REQUESTED', authorAssociation: 'NONE', author: { login: 'eve' } })]), 'an untrusted request does not block');
});

test('AC-3d the real verdict decides: a fenced example, a missing one or two of them are no evidence', () => {
  // The reviewer's reproduction: a fenced approval line above the report's actual verdict.
  const real = terminal(H, B, { verdict: 'continue' });
  const fenced = { ...real, body: real.body.replace('No new findings', '```\nVerdict: approval-eligible\n```') };
  assert.equal(gate({ pr: pr({ comments: [fenced] }), main: B, headTree: T1 }).reason, 'review-evidence-stale');
  assert.equal(gate({ pr: pr({ comments: [terminal()] }), main: B, headTree: T1 }).verdict, 'pass', 'one real approval line still passes');
  const twice = { ...terminal(), body: terminal().body.replace('No new findings', 'Verdict: continue') };
  assert.equal(gate({ pr: pr({ comments: [twice] }), main: B, headTree: T1 }).reason, 'review-evidence-stale', 'two verdict lines are ambiguous');
  // A report quoted whole inside a fence supplies neither a verdict nor a reviewed head.
  const quoted = { ...terminal(), body: `<!-- review-pr: run1 round=2 phase=review -->\n\n\`\`\`\n${terminal().body.split('\n').slice(1).join('\n')}\n\`\`\`\n` };
  assert.equal(gate({ pr: pr({ comments: [quoted] }), main: B, headTree: T1 }).reason, 'review-evidence-stale');
});

test('AC-3d the latest approval by submission time restores a withdrawn marked review, in any array order', () => {
  const by = (login, at) => approval({ author: { login }, submittedAt: at });
  const withdrawn = terminal(H, B, { verdict: 'blocked', at: '2026-11-14T02:45:00Z' });
  const ann1 = by('ann', '2026-11-14T01:00:00Z');
  const bob = by('bob', '2026-11-14T02:30:00Z');
  const ann2 = by('ann', '2026-11-14T03:00:00Z');
  // An approval carries no reviewed base, so a restored gate comes out as collect.
  const run = (reviews) => gate({ pr: pr({ comments: [withdrawn], reviews }), main: B, headTree: T1 });
  for (const order of [[ann1, bob, ann2], [ann2, ann1, bob], [bob, ann2, ann1]]) {
    assert.deepEqual([run(order).verdict, run(order).evidence?.kind], ['collect', 'approved-review'], JSON.stringify(order.map((r) => r.submittedAt)));
  }
  // Without Ann's later approval only Bob's older one is left, and it does not override the withdrawal.
  assert.equal(run([ann1, bob]).reason, 'review-evidence-stale');
});

test('AC-3a the pre-merge recheck reruns the whole gate: a later hold stops, and facts bind to their head and main', () => {
  const first = gate({ pr: pr(), main: B, headTree: T1 });
  const expected = { head: first.head, main: first.main };
  assert.equal(gate({ pr: pr(), main: B, headTree: T1, expected }).verdict, 'pass');
  assert.equal(gate({ pr: pr({ labels: [{ name: 'hold' }] }), main: B, headTree: T1, expected }).reason, 'hold-label');
  assert.equal(gate({ pr: pr(), main: M, expected, mergeTree: { conflict: false, tree: T2 }, mainChanges: ['docs/a.md'] }).reason, 'moved-since-gate');
  assert.equal(gate({ pr: pr({ headRefOid: D, comments: [terminal(D)] }), main: B, headTree: T1, expected }).reason, 'moved-since-gate');
});

test('AC-12c a dry-run stops at the gate instead of creating and removing a verification worktree', () => {
  const result = gate({ pr: pr(), main: M, mergeTree: { conflict: false, tree: T2 }, mainChanges: ['server/x.ts'], dryRun: true });
  assert.deepEqual([result.verdict, result.reason], ['stop', 'dry-run-no-verify']);
});

// ---------- AC-4 ----------

test('AC-4b a partial issue that the PR body or a manual link would close stops, whatever the squash body says', () => {
  const issues = [{ number: 129, complete: false }, { number: 75, complete: true }];
  assert.equal(lintSquashBody('Ref #129', issues, 'Closes #129', []).ok, false);
  assert.equal(lintSquashBody('Ref #129', issues, 'Ref #129', [129]).ok, false);
  assert.equal(lintSquashBody('Closes #75\nRef #129', issues, 'Closes #75\nRef #129', [75]).ok, true);
});

test('AC-4b closing keywords may only name complete issues', () => {
  const issues = [{ number: 129, complete: false }, { number: 75, complete: true }];
  assert.equal(lintSquashBody('Fixes the bug.\n\nCloses #129', issues).ok, false);
  assert.equal(lintSquashBody('resolves example-org/example-repo#129', issues, '', [], REPO).ok, false);
  assert.equal(lintSquashBody('resolves EXAMPLE-ORG/Example-Repo#129', issues, '', [], REPO).ok, false, 'repository names compare case-insensitively');
  assert.equal(lintSquashBody('resolves other/project#129', issues, '', [], REPO).ok, true, "another repository's #129 is not this one's issue");
  assert.equal(lintSquashBody('Closes #75\nRef #129', issues).ok, true);
});

test('AC-4b an issue the merge would close but nobody judged stops before the merge', () => {
  assert.equal(lintSquashBody('Closes #9', []).ok, false);
  assert.equal(lintSquashBody('Ref #9', [], 'Closes #9', []).ok, false);
  assert.equal(lintSquashBody('Ref #9', [], '', [9]).findings[0], '#9 would be closed but was not judged: add it to issues or unlink it');
  assert.equal(lintSquashBody('Closes #9', [{ number: 9, complete: true }]).ok, true);
});

test('AC-4b the squash subject is linted with the body, and full issue URLs count as closing references', () => {
  const issues = [{ number: 2, complete: false }];
  assert.equal(lintSquashMessage({ subject: 'Fixes #2 (#1)', body: 'Ref #2', issues, prBody: 'Ref #2', closingIssues: [], repo: REPO }).ok, false);
  assert.equal(lintSquashMessage({ body: 'Ref #2', issues, repo: REPO }).reason, 'subject-missing');
  assert.equal(lintSquashMessage({ subject: 'Add x (#1)', body: 'Ref #2', issues, repo: REPO }).ok, true);
  const url = `https://github.com/${REPO}/issues/2`;
  assert.equal(lintSquashBody(`Fixes ${url}`, issues, '', [], REPO).ok, false, 'squash body');
  assert.equal(lintSquashBody('Ref #2', issues, `Closes ${url}`, [], REPO).ok, false, 'PR body');
  assert.equal(lintSquashBody('Ref #2', [], `Closes ${url}`, [], REPO).findings[0], '#2 would be closed but was not judged: add it to issues or unlink it');
  assert.equal(lintSquashBody('Fixes https://github.com/other/project/issues/2', issues, '', [], REPO).ok, true);
});

test('AC-4c the squash commit must sit on the pre-merge main with the verified tree', () => {
  assert.equal(verifyMerge({ parents: [M], tree: 't', expectedParent: M, expectedTree: 't' }).ok, true);
  assert.equal(verifyMerge({ parents: [B], tree: 't', expectedParent: M, expectedTree: 't' }).reason, 'parent-mismatch');
  assert.equal(verifyMerge({ parents: [M, H], tree: 't', expectedParent: M, expectedTree: 't' }).reason, 'parent-mismatch');
  assert.equal(verifyMerge({ parents: [M], tree: 'u', expectedParent: M, expectedTree: 't' }).reason, 'tree-mismatch');
});

// ---------- AC-5 ----------

const inventory = (overrides = {}) => ({
  mode: 'stale', repo: REPO, commonDir: '/repo/.git', defaultBranch: 'main', mainCheckout: '/repo', sessionWorktree: '/repo/.claude/worktrees/pr134-s',
  scratchRoot: '/tmp/claude-1000', processCheck: 'ok', remoteHead: H,
  pr: { number: 134, state: 'MERGED', headRefName: 'claude/issue-129-image', headRefOid: H, sameRepo: true },
  prsByName: { 'claude/old': { number: 90, state: 'MERGED' }, 'claude/live': { number: 140, state: 'OPEN' },
    'claude/renamed': { number: 91, state: 'MERGED' }, 'claude/renamed-2': { number: 92, state: 'MERGED' } },
  prsByHead: { [D]: { number: 90, state: 'MERGED' } },
  worktrees: [
    { path: '/repo', branch: 'main', head: M, dirty: false },
    { path: '/repo/.claude/worktrees/pr134-s', branch: 'worktree-s', head: H, dirty: false },
    { path: '/tmp/claude-1000/pr134/review-r1', branch: null, head: H, dirty: false },
    { path: '/repo/.claude/worktrees/pr134-review', branch: 'fix/other-name', head: H, dirty: false },
    { path: '/repo/.claude/worktrees/pr1345-review', branch: null, head: B, dirty: false },
    { path: '/repo/.claude/worktrees/temp', branch: 'claude/old3', head: D, dirty: false, hasIgnored: true },
    { path: '/repo/.claude/worktrees/old', branch: 'claude/old', head: D, dirty: false },
    { path: '/repo/.claude/worktrees/renamed', branch: 'claude/renamed', head: B, dirty: false },
    { path: '/repo/.claude/worktrees/live', branch: 'claude/live', head: B, dirty: false },
    { path: '/repo/.claude/worktrees/dirty', branch: 'claude/old2', head: B, dirty: true },
    { path: '/repo/.claude/worktrees/locked', branch: 'x', head: B, dirty: false, locked: true, ancestorOfMain: true },
    { path: '/repo/.claude/worktrees/busy', branch: 'y', head: B, dirty: false, busy: true, ancestorOfMain: true },
    { path: '/repo/.claude/worktrees/unknown', branch: 'z', head: B, dirty: null },
  ],
  branches: [
    { name: 'main', head: M }, { name: 'claude/issue-129-image', head: H }, { name: 'pr134-w1', head: H },
    { name: 'worktree-s', head: H }, { name: 'claude/old', head: D }, { name: 'claude/live', head: B },
    { name: 'claude/renamed-2', head: B },
    { name: 'merged-elsewhere', head: B, ancestorOfMain: true }, { name: 'random', head: B },
  ],
  // What a candidate holds decides whether it goes; the name alone is not evidence of ownership.
  scratch: [{ path: '/tmp/claude-1000/pr134', directory: true, entries: ['/tmp/claude-1000/pr134/review-r1'] },
    { path: '/tmp/claude-1000/pr1345', directory: true, entries: [] }],
  ...overrides,
});
const targets = (plan, kind) => plan.remove.filter((item) => item.kind === kind).map((item) => item.target);
const reasons = (plan) => Object.fromEntries(plan.skip.map((item) => [item.target, item.reason]));

test('AC-5a own resources: head and writer branches, pr<n> worktrees and scratch, remote head', () => {
  const plan = planCleanup(inventory({ mode: 'own' }));
  // Review loops may keep worktrees under .claude/worktrees/pr<n>-*; pr1345 belongs to another PR.
  assert.deepEqual(targets(plan, 'worktree'), ['/tmp/claude-1000/pr134/review-r1', '/repo/.claude/worktrees/pr134-review']);
  assert.deepEqual(targets(plan, 'local-branch').sort(), ['claude/issue-129-image', 'pr134-w1']);
  assert.deepEqual(targets(plan, 'remote-branch'), ['claude/issue-129-image']);
  assert.deepEqual(targets(plan, 'scratch'), ['/tmp/claude-1000/pr134']); // pr1345 belongs to another PR
  assert.deepEqual(targets(plan, 'exit-worktree'), ['/repo/.claude/worktrees/pr134-s']);
  assert.ok(!targets(plan, 'local-branch').includes('worktree-s'), 'the session branch waits for ExitWorktree');
  assert.ok(!targets(plan, 'worktree').includes('/repo/.claude/worktrees/old'), 'own mode leaves stale worktrees alone');
  const order = plan.remove.map((item) => item.kind);
  assert.ok(order.lastIndexOf('worktree') < order.indexOf('local-branch') && order.indexOf('scratch') < order.indexOf('exit-worktree'));
  const cross = planCleanup(inventory({ mode: 'own', pr: { ...inventory().pr, sameRepo: false } }));
  assert.deepEqual(targets(cross, 'remote-branch'), []);
});

test('AC-5a own covers the launching worktree only when it belongs to this PR', () => {
  const base = inventory({ mode: 'own' });
  const other = '/repo/.claude/worktrees/unrelated';
  // pr=<n> may name a PR this session has nothing to do with, so the launching path is no proof of ownership.
  const inv = inventory({ mode: 'own', sessionWorktree: other,
    worktrees: [...base.worktrees, { path: other, branch: 'fix/unrelated', head: H, dirty: false }] });
  const plan = planCleanup(inv);
  assert.deepEqual(targets(plan, 'exit-worktree'), [], "an unrelated session worktree is not this PR's to discard");
  assert.ok(!targets(plan, 'worktree').includes(other));
  assert.equal(reasons(planCleanup({ ...inv, mode: 'stale' }))[other], 'state-unknown', 'stale judges it by the ordinary rules');
  assert.deepEqual(targets(planCleanup(base), 'exit-worktree'), ['/repo/.claude/worktrees/pr134-s'], 'a pr<n> session worktree still goes');
});

test('AC-7c the second cleanup pass keeps first-pass outcomes and records the session worktree as removed', () => {
  const prior = [
    { kind: 'worktree', target: '/tmp/claude-1000/pr134/review-r1', exit: 0 },
    { kind: 'local-branch', target: 'kept', exit: 1, command: 'git branch -D kept' },
    { kind: 'exit-worktree', target: '/repo/.claude/worktrees/s', exit: null, reason: 'exit-worktree' },
    { kind: 'local-branch', target: 'stuck', exit: 1 },
  ];
  const latest = [{ kind: 'local-branch', target: 'worktree-s', exit: 0 }, { kind: 'local-branch', target: 'stuck', exit: 0 }];
  const gone = mergeResults(prior, latest, { worktrees: [{ path: '/repo' }] });
  assert.deepEqual(gone.map((item) => [item.target, item.exit]), [
    ['/tmp/claude-1000/pr134/review-r1', 0], ['kept', 1], ['/repo/.claude/worktrees/s', 0], ['worktree-s', 0], ['stuck', 0],
  ]);
  assert.match(renderCloseout(closeoutInput({ cleanup: gone })), /git branch -D kept/);
  const still = mergeResults(prior, [], { worktrees: [{ path: '/repo/.claude/worktrees/s' }] });
  assert.equal(still.find((item) => item.kind === 'exit-worktree').reason, 'exit-worktree', 'a worktree still listed is not reported as removed');
  const skipped = mergeResults([{ kind: 'remote-branch', target: 'claude/x', exit: 0 }], [{ kind: 'remote-branch', target: 'claude/x', exit: null, reason: 'remote-missing' }], { worktrees: [] });
  assert.deepEqual(skipped, [{ kind: 'remote-branch', target: 'claude/x', exit: 0 }], 'a second-pass skip keeps the first-pass deletion');
});

test('AC-5b stale adds finished, clean, unlocked, idle worktrees and finished or merged branches', () => {
  const plan = planCleanup(inventory());
  assert.ok(targets(plan, 'worktree').includes('/repo/.claude/worktrees/old'));
  assert.ok(targets(plan, 'local-branch').includes('claude/old'));
  assert.ok(targets(plan, 'local-branch').includes('merged-elsewhere'));
  assert.ok(!targets(plan, 'local-branch').includes('random'));
  assert.ok(!targets(plan, 'local-branch').includes('claude/live'));
  // A merged PR with the same name does not cover a different local head: it may hold unpushed commits.
  assert.equal(reasons(plan)['/repo/.claude/worktrees/renamed'], 'unmerged-commits');
  assert.equal(reasons(plan)['claude/renamed-2'], 'unmerged-commits');
  assert.ok(!targets(plan, 'local-branch').includes('claude/renamed-2'));
  const hidden = planCleanup(inventory({ processCheck: 'unavailable' }));
  assert.equal(reasons(hidden)['/repo/.claude/worktrees/old'], 'process-check-unavailable');
});

test('AC-5c skipped worktrees carry their reason', () => {
  const skipped = reasons(planCleanup(inventory()));
  assert.equal(skipped['/repo'], 'main-checkout');
  assert.equal(skipped['/repo/.claude/worktrees/dirty'], 'uncommitted-changes');
  assert.equal(skipped['/repo/.claude/worktrees/locked'], 'locked');
  assert.equal(skipped['/repo/.claude/worktrees/busy'], 'busy');
  assert.equal(skipped['/repo/.claude/worktrees/live'], 'pr-open');
  assert.equal(skipped['/repo/.claude/worktrees/unknown'], 'state-unknown');
  assert.equal(skipped['/repo/.claude/worktrees/temp'], 'ignored-files');
  assert.ok(!targets(planCleanup(inventory()), 'local-branch').includes('claude/old3'), 'a kept worktree keeps its branch');
  assert.ok(!targets(planCleanup(inventory()), 'local-branch').includes('claude/old2'), 'a dirty worktree keeps its branch');
});

test('AC-5c this run\'s own cwd never makes the session worktree busy, while another busy worktree is skipped', () => {
  const inv = inventory({ mode: 'own' });
  // With process inspection available the collector sees this very run inside the launching worktree.
  const worktrees = inv.worktrees.map((wt) => (wt.path === inv.sessionWorktree ? { ...wt, busy: true } : wt));
  assert.deepEqual(targets(planCleanup({ ...inv, worktrees }), 'exit-worktree'), ['/repo/.claude/worktrees/pr134-s']);
  assert.equal(reasons(planCleanup({ ...inventory(), worktrees }))['/repo/.claude/worktrees/busy'], 'busy');
  assert.equal(reasons(planCleanup({ ...inventory(), worktrees }))['/repo/.claude/worktrees/pr134-s'], undefined);
});

test('AC-5c a plan stops when main is not local instead of calling merged heads unmerged', () => {
  for (const mode of ['own', 'stale']) assert.throws(() => planCleanup(inventory({ mode, main: M, mainMissing: true })), /main commit .* is not in the local repository/);
  assert.equal(planCleanup(inventory({ mode: 'none', mainMissing: true })).skip[0].reason, 'cleanup-not-requested');
});

test('AC-5d a worktree holding ignored files is kept, the session worktree included, and its scratch stays', () => {
  const inv = inventory({ mode: 'own' });
  const withIgnored = (path) => ({ ...inv, worktrees: inv.worktrees.map((wt) => (wt.path === path ? { ...wt, hasIgnored: true } : wt)) });
  const review = planCleanup(withIgnored('/tmp/claude-1000/pr134/review-r1'));
  assert.equal(reasons(review)['/tmp/claude-1000/pr134/review-r1'], 'ignored-files');
  assert.equal(reasons(review)['/tmp/claude-1000/pr134'], 'holds-skipped-worktree');
  const session = planCleanup(withIgnored(inv.sessionWorktree));
  assert.equal(reasons(session)[inv.sessionWorktree], 'ignored-files');
  assert.deepEqual(targets(session, 'exit-worktree'), [], 'ExitWorktree would delete them');
  assert.equal(reasons(planCleanup({ ...inv, worktrees: inv.worktrees.map((wt) => ({ ...wt, hasIgnored: null })) }))['/tmp/claude-1000/pr134/review-r1'], 'state-unknown');
  const removedFail = apply(planCleanup(inv), planCleanup(inv), inv, (item) => ({ kind: item.kind, target: item.target, exit: item.kind === 'worktree' ? 1 : 0 }));
  assert.equal(removedFail.find((item) => item.kind === 'scratch' && item.target === '/tmp/claude-1000/pr134').reason, 'holds-kept-worktree');
});

test('AC-5d ignored files other than caches and sandbox placeholders count; git failure is unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-merge-ignored-'));
  const git = (...args) => assert.equal(spawnSync('git', ['-C', dir, ...args]).status, 0, args.join(' '));
  try {
    git('init', '-q');
    writeFileSync(join(dir, '.gitignore'), '__pycache__/\n*.pyc\n.venv/\ntemp/\n.env\n');
    git('add', '.gitignore');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');
    mkdirSync(join(dir, 'scripts/__pycache__'), { recursive: true });
    writeFileSync(join(dir, 'scripts/__pycache__/a.cpython-312.pyc'), '');
    mkdirSync(join(dir, '.venv'));
    writeFileSync(join(dir, '.venv/x'), '');
    assert.equal(ignoredOf(dir), false, 'caches alone do not keep a worktree');
    mkdirSync(join(dir, 'temp'));
    writeFileSync(join(dir, 'temp/draft.md'), 'work');
    assert.equal(ignoredOf(dir), true);
    rmSync(join(dir, 'temp'), { recursive: true });
    writeFileSync(join(dir, '.env'), 'X=1');
    assert.equal(ignoredOf(dir), true);
    assert.equal(ignoredOf(dir, () => ({ status: 128, stdout: '' })), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC-5a the remote head branch is deleted only at the merged head, under a lease on that SHA', () => {
  const moved = planCleanup(inventory({ mode: 'own', remoteHead: D }));
  assert.deepEqual(targets(moved, 'remote-branch'), []);
  assert.equal(reasons(moved)['claude/issue-129-image'], 'remote-moved');
  const item = planCleanup(inventory({ mode: 'own' })).remove.find((entry) => entry.kind === 'remote-branch');
  assert.ok(commandFor(item, inventory()).includes(`--force-with-lease=refs/heads/claude/issue-129-image:${H}`));
});

test('AC-5c without a process check an own pr<n> worktree is skipped; only the session worktree is known idle', () => {
  const hidden = planCleanup(inventory({ mode: 'own', processCheck: 'unavailable' }));
  assert.equal(reasons(hidden)['/tmp/claude-1000/pr134/review-r1'], 'process-check-unavailable');
  assert.equal(reasons(hidden)['/repo/.claude/worktrees/pr134-review'], 'process-check-unavailable');
  assert.deepEqual(targets(hidden, 'worktree'), []);
  assert.deepEqual(targets(hidden, 'scratch'), []);
  assert.deepEqual(targets(hidden, 'exit-worktree'), ['/repo/.claude/worktrees/pr134-s']);
});

test('AC-5d a session worktree or an omitted worktree inside scratch keeps the scratch directory', () => {
  const inv = inventory({ mode: 'own' });
  const fresh = planCleanup(inv);
  const ran = [];
  const exec = (item) => { ran.push(`${item.kind} ${item.target}`); return { kind: item.kind, target: item.target, exit: 0 }; };
  const omitted = apply({ ...fresh, remove: fresh.remove.filter((item) => item.kind !== 'worktree') }, fresh, inv, exec);
  assert.equal(omitted.find((item) => item.kind === 'scratch' && item.target === '/tmp/claude-1000/pr134').reason, 'holds-kept-worktree');
  const session = '/tmp/claude-1000/pr134/writer-r1';
  const inside = inventory({ mode: 'own', sessionWorktree: session, worktrees: [...inv.worktrees, { path: session, branch: 'pr134-w1', head: H, dirty: false }],
    scratch: [{ path: '/tmp/claude-1000/pr134', directory: true, entries: ['/tmp/claude-1000/pr134/review-r1', session] }] });
  const plan = planCleanup(inside);
  assert.ok(targets(plan, 'scratch').includes('/tmp/claude-1000/pr134'));
  const kept = apply(plan, plan, inside, exec);
  assert.equal(kept.find((item) => item.kind === 'scratch' && item.target === '/tmp/claude-1000/pr134').reason, 'holds-kept-worktree');
  assert.ok(!ran.includes('scratch /tmp/claude-1000/pr134'));
});

test('AC-5d a scratch directory goes only when it holds nothing but worktrees this run removes', () => {
  assert.deepEqual(targets(planCleanup(inventory({ mode: 'own' })), 'scratch'), ['/tmp/claude-1000/pr134']);
  const scratch = (overrides) => inventory({ mode: 'own', scratch: [{ path: '/tmp/claude-1000/pr134', directory: true, entries: [], ...overrides }] });
  // An owner's own files must survive a name match, whatever the directory is called.
  assert.equal(reasons(planCleanup(scratch({ entries: ['/tmp/claude-1000/pr134/notes.md'] })))['/tmp/claude-1000/pr134'], 'holds-other-files');
  assert.equal(reasons(planCleanup(scratch({ directory: false, entries: null })))['/tmp/claude-1000/pr134'], 'not-a-directory');
  assert.equal(reasons(planCleanup(scratch({ entries: null })))['/tmp/claude-1000/pr134'], 'state-unknown');
  assert.deepEqual(targets(planCleanup(scratch({})), 'scratch'), ['/tmp/claude-1000/pr134'], 'nothing of the owner\'s is left inside');
});

test('AC-5e a scratch directory is removed only while empty, so a file created after the plan survives', () => {
  const inv = inventory({ mode: 'own' });
  const root = mkdtempSync(join(tmpdir(), 'dev-merge-scratch-'));
  try {
    const empty = join(root, 'pr134-empty');
    mkdirSync(empty);
    assert.deepEqual(commandFor({ kind: 'scratch', target: empty }, inv), ['rmdir', empty]);
    const removed = execute({ kind: 'scratch', target: empty }, inv);
    assert.deepEqual([removed.exit, removed.command], [0, `rmdir ${empty}`]);
    assert.equal(existsSync(empty), false);
    // The owner writes into the directory after the inventory was taken: the removal must refuse, not delete it.
    const late = join(root, 'pr134-late');
    mkdirSync(late);
    writeFileSync(join(late, 'notes.md'), 'written after the plan');
    const kept = execute({ kind: 'scratch', target: late }, inv);
    assert.deepEqual([kept.exit, kept.reason], [null, 'holds-other-files']);
    assert.equal(readFileSync(join(late, 'notes.md'), 'utf8'), 'written after the plan');
    // The scratch directory was itself the worktree git already removed.
    assert.equal(execute({ kind: 'scratch', target: join(root, 'pr134-gone') }, inv).exit, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC-5d a refused apply leaves the owner one apply --plan line and no per-item command', () => {
  const plan = planCleanup(inventory({ mode: 'own' }));
  const text = renderCloseout({ ...closeoutInput(), cleanup: deniedResults(plan, '/tmp/s/cleanup/plan.json') });
  assert.ok(text.includes('| 🧹 worktree | `/tmp/claude-1000/pr134/review-r1` | ⛔ denied |'));
  // The owner reruns the installed helper by its absolute path; the plugin cache is not the checkout.
  assert.ok(text.includes(`\`\`\`bash\nnode ${fileURLToPath(new URL('./apply-cleanup.mjs', import.meta.url))} apply --plan /tmp/s/cleanup/plan.json\n\`\`\``));
  assert.ok(!/git (worktree remove|branch -D)/.test(text));
});

test('AC-5e removals are single argv commands; apply runs only what a fresh plan still contains; none removes nothing', () => {
  const inv = inventory({ mode: 'own' });
  const plan = planCleanup(inv);
  assert.deepEqual(commandFor({ kind: 'local-branch', target: 'pr134-w1' }, inv), ['git', 'branch', '-D', 'pr134-w1']);
  assert.deepEqual(commandFor({ kind: 'remote-branch', target: 'b' }, inv).slice(-3), [`https://github.com/${REPO}.git`, '--delete', 'b']);
  const fresh = { ...plan, remove: plan.remove.filter((item) => item.target !== 'pr134-w1') };
  const ran = [];
  const results = apply(plan, fresh, inv, (item) => { ran.push(item.target); return { kind: item.kind, target: item.target, exit: 0 }; });
  assert.ok(!ran.includes('pr134-w1'));
  assert.equal(results.find((item) => item.target === 'pr134-w1').reason, 'replanned-away');
  assert.ok(!ran.includes('/repo/.claude/worktrees/pr134-s'), 'the session worktree is left to ExitWorktree');
  const forged = { ...plan, remove: plan.remove.map((item) => (item.kind === 'remote-branch' ? { ...item, head: D } : item)) };
  const seen = [];
  apply(forged, plan, inv, (item) => { seen.push(item); return { kind: item.kind, target: item.target, exit: 0 }; });
  assert.ok(seen.every((item) => item.head !== D), 'a saved plan cannot change what a fresh plan runs, the lease included');
  assert.deepEqual(planCleanup(inventory({ mode: 'none' })).remove, []);
});

test('AC-5e a saved plan runs only in the repository and Git storage it was made for', () => {
  const inv = inventory({ mode: 'own' });
  const plan = planCleanup(inv);
  const ran = [];
  const exec = (item) => { ran.push(item); return { kind: item.kind, target: item.target, exit: 0 }; };
  for (const other of [inventory({ mode: 'own', repo: 'example-org/other-repo' }), inventory({ mode: 'own', commonDir: '/elsewhere/.git' })]) {
    assert.throws(() => apply(plan, planCleanup(other), other, exec), /not this checkout/);
  }
  const { repo, commonDir, ...unbound } = plan;
  assert.throws(() => apply(unbound, plan, inv, exec), /not this checkout/);
  assert.deepEqual(ran, [], 'nothing runs, the local and remote branches included');
  apply(plan, planCleanup(inventory({ mode: 'own', repo: REPO.toUpperCase() })), inventory({ mode: 'own', repo: REPO.toUpperCase() }), exec);
  assert.ok(ran.some((item) => item.kind === 'remote-branch') && ran.some((item) => item.kind === 'local-branch'));
});

test('AC-5 worktree porcelain parsing keeps branch, detached and locked state', () => {
  const parsed = parseWorktrees('worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /tmp/x\nHEAD def\ndetached\nlocked claude session\n');
  assert.deepEqual(parsed, [
    { path: '/repo', head: 'abc', branch: 'main', locked: false },
    { path: '/tmp/x', head: 'def', branch: null, locked: true },
  ]);
});

// ---------- AC-7 ----------

const closeoutInput = (overrides = {}) => ({
  repo: REPO, mode: 'closeout', pr: { number: 134 },
  merge: { sha: 'e0bb2b85902a644b5bbdd18ff6cb864770013e9f', parent: M, verified: true },
  gate: { head: H, reason: 'base-unchanged', evidence: { url: 'https://github.com/example-org/example-repo/pull/134#issuecomment-1' } },
  validation: ['`npm test` passed'],
  cleanup: [
    { kind: 'remote-branch', target: 'claude/x', exit: 0, command: 'git push … --delete claude/x' },
    { kind: 'local-branch', target: 'pr134-w1', exit: 'denied', command: 'git branch -D pr134-w1' },
  ],
  warnings: [{ code: 'no-discussion' }], ci: null, ...overrides,
});

test('AC-7a closeout carries the marker, Chinese sections and a warning section when targets are missing', () => {
  const text = renderCloseout(closeoutInput());
  assert.ok(text.startsWith(`<!-- dev-merge:closeout pr=134 head=${H} -->\n## Merge closeout\n`));
  for (const heading of ['### Merge checks', '### Review and validation', '### Cleanup', '### ⚠️ Warnings']) assert.ok(text.includes(heading), heading);
  assert.ok(text.includes('- no linked discussion found'), 'a warning code renders as text without its emoji');
  assert.ok(!/deploy/i.test(text), 'no deployment is reported');
  assert.ok(!text.includes('### Remaining work and handover'));
  assert.ok(renderCloseout(closeoutInput({ mode: 'handover', handover: ['run the migration first'] })).includes('### Remaining work and handover'));
  assert.ok(!renderCloseout(closeoutInput({ warnings: [] })).includes('Warnings'));
});

test('AC-7d the closeout follows the language of the PR body', () => {
  const zhBody = Object.values(ZH).filter((text) => typeof text === 'string').join(' ');
  const enBody = 'Fix the tracker parser so the next-steps heading is found, and add tests for both shapes.';
  assert.equal(detectLang(enBody), 'en');
  assert.equal(detectLang(zhBody), 'zh');
  assert.equal(detectLang(''), 'en');
  assert.equal(detectLang(`${enBody}\n\n\`\`\`\n${zhBody}\n\`\`\``), 'en', 'code blocks do not count');
  assert.equal(detectLang(`${enBody}\n\n~~~\n${zhBody}\n~~~\n`), 'en', 'a tilde fence is a code block too');
  assert.equal(detectLang(`${enBody}\n\n\`\`\`\`\n${zhBody}\n\`\`\`\`\n`), 'en', 'so is a longer backtick fence');
  assert.equal(detectLang(`${enBody}\n\n\`\`\`\n${zhBody}\n`), 'en', 'an unclosed fence hides the rest of the body');
  // Han characters outside the basic blocks are Chinese too, as the English-only validator reads them.
  assert.equal(detectLang('\u{20000}\u{20001}'), 'zh', 'supplementary ideographs count');
  assert.equal(detectLang('\uf900\uf901'), 'zh', 'compatibility ideographs count');
  assert.equal(gate({ pr: pr({ body: zhBody }), main: B }).lang, 'zh');
  assert.equal(gate({ pr: pr({ body: enBody, isDraft: true }), main: B }).lang, 'en', 'a stop carries the language too');
  const zh = renderCloseout(closeoutInput({ lang: 'zh', mode: 'handover', handover: ['x'] }));
  for (const key of ['closeout.titleHandover', 'closeout.checks', 'closeout.validation', 'closeout.handover', 'closeout.cleanup', 'closeout.warnings']) assert.ok(zh.includes(ZH[key]), key);
  assert.ok(zh.includes(`| 🧹 ${ZH['kind.local-branch']} | \`pr134-w1\` | ${ZH['outcome.denied']} |`));
  assert.ok(zh.includes(ZH['warning.no-discussion'].replace(/^⚠️\s*/, '')));
  assert.equal(cleanupOutcome({ exit: null, reason: 'main-checkout' }, 'zh').mark, t('zh', 'outcome.skipped', { reason: ZH['reason.main-checkout'] }));
  assert.equal(cleanupOutcome({ exit: null, reason: 'kept by the owner' }).mark, '⏭️ skipped: kept by the owner', 'free-text reasons pass through');
  assert.equal(warningText({ code: 'tracker-ambiguous', label: 'area:core', issues: [71, 72] }), '⚠️ label `area:core` matches several tracking issues (#71, #72), skipped');
  assert.equal(warningText('⚠️ written by the agent', 'zh'), '⚠️ written by the agent');
});

test('AC-7d an unknown locale key or warning code renders instead of aborting the comment', () => {
  assert.equal(warningText({ code: 'future-warning' }, 'zh'), '⚠️ future-warning');
  assert.equal(t('zh', 'future.key'), 'future.key');
  assert.equal(t('fr', 'closeout.title'), LOCALES.en['closeout.title'], 'an unknown language falls back to English');
  assert.equal(renderCloseout(closeoutInput({ warnings: [{ code: 'future-warning' }] })).includes('- future-warning'), true);
});

test('AC-12c a dry-run draft after a gate stop says nothing was merged or posted', () => {
  const stopped = gate({ pr: { state: 'OPEN', isDraft: false, labels: [], mergeStateStatus: 'CLEAN', headRefOid: H, statusCheckRollup: [check()], comments: [], reviews: [] }, main: M });
  assert.equal(stopped.verdict, 'stop');
  const text = renderCloseout(closeoutInput({ dryRun: true, gate: stopped, merge: { sha: null, parent: M } }));
  assert.ok(text.startsWith(`<!-- dev-merge:closeout pr=134 head=${H} -->`));
  assert.ok(text.includes('⏳ dry-run preview: PR #134 is not merged'));
  assert.ok(text.includes('⛔ gate stopped: `no-review-evidence`') && text.includes('⛔ no review evidence for the current head') && text.includes('| Merge result | ⏳ not merged yet |'));
  assert.ok(!text.includes('was squash merged'));
});

test('AC-7b a rerun updates this login\'s marked comment instead of posting again', () => {
  const comments = [
    { id: 1, author: 'owner', body: '<!-- dev-merge:closeout pr=134 head=x -->\n## Merge closeout' },
    { id: 2, author: 'someone', body: '<!-- dev-merge:closeout pr=134 head=x -->' },
    { id: 3, author: 'owner', body: '<!-- dev-merge:closeout pr=1345 head=x -->' },
  ];
  assert.deepEqual(closeoutTarget(comments, 134, 'owner'), { ok: true, id: 1 });
  assert.deepEqual(closeoutTarget(comments, 9, 'owner'), { ok: true, id: null });
  assert.equal(closeoutTarget([comments[0], { ...comments[0], id: 4 }], 134, 'owner').ok, false);
  const snapshot = comments.map((c) => ({ ...c, author: { login: c.author } })); // `gh pr view --json comments` shape
  assert.deepEqual(closeoutTarget(snapshot, 134, 'owner'), { ok: true, id: 1 });
  const nodeIds = snapshot.map((c) => ({ ...c, id: `IC_kw${c.id}`, url: `https://github.com/example-org/example-repo/pull/134#issuecomment-66257958${c.id}` }));
  assert.deepEqual(closeoutTarget(nodeIds, 134, 'owner'), { ok: true, id: 662579581 });
  assert.equal(closeoutTarget([{ ...nodeIds[0], url: undefined }], 134, 'owner').reason, 'closeout-id');
});

test('AC-7c a denied deletion is never rendered as done and lands in the owner block', () => {
  const text = renderCloseout(closeoutInput());
  assert.ok(text.includes('| 🧹 remote branch | `claude/x` | ✅ done |'));
  assert.ok(text.includes('| 🧹 local branch | `pr134-w1` | ⛔ denied |'));
  assert.ok(text.includes('```bash\ngit branch -D pr134-w1\n```'));
  assert.equal(cleanupOutcome({ exit: null }).mark, '❓ unknown');
  assert.equal(cleanupOutcome({ exit: 1 }).owner, true);
  assert.equal(cleanupOutcome({ exit: null, reason: 'main-checkout' }).owner, false);
});

// ---------- AC-8 ----------

const NEXT_WAS = '\n| # | Step |\n| --- | --- |\n| 1 | a |\n\n';
const NEXT_BODY = `## Current work\n\n- x\n\n## Next steps\n${NEXT_WAS}## Open questions\n`;
const discovery = (overrides = {}) => ({
  repo: REPO,
  prBody: `Fix image display.\n\nRef #129\nCloses #75\nSee https://github.com/${REPO}/discussions/94 and #71`,
  closingIssues: [75], prLabels: ['area:core'],
  issueMeta: { 129: { labels: ['bug', 'area:core'] }, 75: { labels: ['story', 'area:core', 'area:infra'] } },
  tracking: [{ number: 71, labels: ['tracking', 'area:core'] }, { number: 126, labels: ['tracking', 'area:infra'] }],
  trackerBodies: { 71: NEXT_BODY }, args: {}, ...overrides,
});

test('AC-8a issues come from PR-body keywords and closing references; args narrow but never drop what the PR closes', () => {
  assert.deepEqual(discoverTargets(discovery()).issues, [129, 75]);
  const narrowed = discoverTargets(discovery({ args: { issues: [5] } }));
  assert.deepEqual(narrowed.issues, [5, 75], 'the PR closes #75, so it is judged whatever the arguments say');
  assert.ok(narrowed.warnings.some((w) => w.code === 'issues-closed-added' && w.issues.join() === '75'));
  // A closing keyword naming a tracking issue is judged too instead of being filtered out with the trackers.
  assert.deepEqual(discoverTargets(discovery({ prBody: 'Closes #71', closingIssues: [] })).issues, [71]);
  assert.ok(discoverTargets(discovery({ prBody: '', closingIssues: [] })).warnings.some((w) => w.code === 'no-issue'));
});

test("AC-8a a reference to another repository is not this repository's issue, discussion or tracker", () => {
  assert.deepEqual(discoverTargets(discovery({ prBody: 'Closes other/project#7', closingIssues: [] })).issues, []);
  assert.deepEqual(discoverTargets(discovery({ prBody: `Closes ${REPO}#7`, closingIssues: [] })).issues, [7]);
  assert.deepEqual(discoverTargets(discovery({ prBody: `Closes ${REPO.toUpperCase()}#7`, closingIssues: [] })).issues, [7]);
  // A dot in a repository name is a literal, not a wildcard, so a look-alike repository is not this one.
  const lookAlike = discoverTargets(discovery({ repo: 'owner/a.b', prLabels: [], issueMeta: {},
    prBody: 'see https://github.com/owner/axb/discussions/9 and https://github.com/owner/axb/issues/126' }));
  assert.deepEqual(lookAlike.discussions, []);
  assert.deepEqual(lookAlike.trackers, []);
  assert.deepEqual(discoverTargets(discovery({ prBody: 'Ref other/project#7', closingIssues: [] })).issues, []);
  assert.deepEqual(discoverTargets(discovery({ prBody: `Ref ${REPO}#7`, closingIssues: [] })).issues, [7]);
  // A tracking issue the body mentions is a target whether or not the mention spells out this repository.
  const refTracker = (prBody) => discoverTargets(discovery({ prBody, prLabels: [], issueMeta: {}, closingIssues: [] }));
  const bareTracker = refTracker('Ref #71');
  assert.deepEqual(bareTracker.trackers, [71]);
  assert.deepEqual(bareTracker.next, [{ issue: 71, action: 'update', section: 'Next steps', was: NEXT_WAS }]);
  assert.deepEqual(refTracker(`Ref ${REPO.toUpperCase()}#71`), bareTracker, 'a qualified mention of this repository is the same tracker');
  assert.deepEqual(refTracker('Ref other/project#71').trackers, []);
  // GitHub reads a link case-insensitively, so a differently cased link to this repository is still local.
  const mixedCase = discoverTargets(discovery({ prLabels: [], issueMeta: {}, closingIssues: [],
    prBody: `see HTTPS://GitHub.com/${REPO.toUpperCase()}/discussions/94 and https://github.com/${REPO.toUpperCase()}/issues/71` }));
  assert.deepEqual(mixedCase.discussions, [94]);
  assert.deepEqual(mixedCase.trackers, [71]);
});

test('AC-8b discussions are the repository discussions the PR body links', () => {
  assert.deepEqual(discoverTargets(discovery()).discussions, [94]);
  assert.ok(discoverTargets(discovery({ prBody: 'Ref #129' })).warnings.some((w) => w.code === 'no-discussion'));
});

test('AC-8c trackers come from the body or one tracking issue per feat label; gaps and duplicates warn', () => {
  assert.deepEqual(discoverTargets(discovery()).trackers, [71]);
  assert.deepEqual(discoverTargets(discovery({ prBody: 'Ref #129', prLabels: [] })).trackers.sort(), [126, 71]);
  const doubled = discoverTargets(discovery({ prBody: 'Ref #129', tracking: [{ number: 71, labels: ['area:core'] }, { number: 72, labels: ['area:core'] }] }));
  assert.deepEqual(doubled.trackers, []);
  assert.ok(doubled.warnings.some((w) => w.code === 'tracker-ambiguous' && w.issues.join() === '71,72'));
  assert.ok(doubled.warnings.some((w) => w.code === 'no-tracker'));
  assert.deepEqual(discoverTargets(discovery({ args: { tracker: [96] } })).trackers, [96]);
  assert.deepEqual(discoverTargets(discovery({ prBody: `[tracker](https://github.com/${REPO}/issues/71)`, prLabels: [], issueMeta: {} })).trackers, [71]);
});

test('AC-8d next updates one next-steps heading, creates one when absent, skips duplicates', () => {
  assert.deepEqual(discoverTargets(discovery()).next, [{ issue: 71, action: 'update', section: 'Next steps', was: NEXT_WAS }]);
  assert.deepEqual(discoverTargets(discovery({ trackerBodies: { 71: '## Current work\n' } })).next, [{ issue: 71, action: 'create', section: 'Next steps' }]);
  // Headings of every locale count, so two in different languages are still a duplicate.
  assert.deepEqual(discoverTargets(discovery({ trackerBodies: { 71: `### ${ZH['next.headings'][0]}\n\n## Next steps\n` } })).next, []);
  assert.deepEqual(discoverTargets(discovery({ trackerBodies: { 71: `## ${ZH['next.headings'][1]}\n` } })).next, [{ issue: 71, action: 'update', section: ZH['next.headings'][1], was: '' }]);
  assert.deepEqual(discoverTargets(discovery({ trackerBodies: { 71: '```\n## Next steps\n```\n' } })).next[0].action, 'create');
  assert.deepEqual(discoverTargets(discovery({ args: { next: { issue: 71, comment: 9 } } })).next, [{ issue: 71, comment: 9, action: 'update' }]);
  // A created heading is written into the tracker, so it follows the language of this run's comments.
  assert.deepEqual(discoverTargets(discovery({ lang: 'zh', trackerBodies: { 71: '## Current work\n' } })).next, [{ issue: 71, action: 'create', section: ZH['next.heading'] }]);
  const zhBody = `${ZH['closeout.checks']} ${ZH['reason.uncommitted-changes']}`;
  assert.equal(discoverTargets(discovery({ prBody: zhBody, trackerBodies: { 71: '## Current work\n' } })).next[0].section, ZH['next.heading'], 'without lang the PR body decides');
});

test('AC-8e / AC-15 a PR missing a linked issue\'s feat label warns', () => {
  const warnings = discoverTargets(discovery()).warnings;
  assert.ok(warnings.some((w) => w.code === 'feat-label-missing' && w.label === 'area:infra'));
});

// ---------- AC-9 ----------

function fakeGh(bodies) {
  const state = { reads: 0, writes: [], bodies: [...bodies] };
  return {
    state,
    get: () => { const value = state.bodies[Math.min(state.reads, state.bodies.length - 1)]; state.reads += 1; return value; },
    patch: (body) => { state.writes.push(body); state.bodies.splice(state.reads, 0, { body: `${body}\n`, updated_at: 'w' }); },
  };
}

test('AC-9a unchanged target: exact-once section replace, write, newline-tolerant readback', () => {
  const gh = fakeGh([{ body: NEXT_BODY, updated_at: 't1' }, { body: NEXT_BODY, updated_at: 't1' }]);
  const result = runGuardedEdit({ edits: [{ section: 'Next steps', find: '| 1 | a |', replace: '| 1 | b（{{now}}） |' }], gh, now: () => 'NOW' });
  assert.equal(result.status, 'written');
  assert.ok(gh.state.writes[0].includes('| 1 | b（NOW） |'));
});

test('AC-9a a wrong readback or dry-run never counts as written', () => {
  const edits = [{ section: 'Next steps', find: '| 1 | a |', replace: '| 1 | b |' }];
  const lying = { reads: 0, get() { this.reads += 1; return this.reads < 3 ? { body: NEXT_BODY, updated_at: 't' } : { body: 'other', updated_at: 'w' }; }, patch() {} };
  assert.equal(runGuardedEdit({ edits, gh: lying }).reason, 'readback-mismatch');
  const never = { get: () => ({ body: NEXT_BODY, updated_at: 't' }), patch: () => assert.fail('must not write') };
  const planned = runGuardedEdit({ edits, gh: never, dryRun: true });
  assert.equal(planned.status, 'planned');
  assert.ok(planned.body.includes('| 1 | b |'));
});

test('AC-9b drift rebuilds on the fresh body and stops after two retries', () => {
  const edits = [{ section: 'Next steps', find: '| 1 | a |', replace: '| 1 | b |' }];
  const recovered = fakeGh([{ body: NEXT_BODY, updated_at: 't1' }, { body: NEXT_BODY, updated_at: 't2' }, { body: NEXT_BODY, updated_at: 't2' }, { body: NEXT_BODY, updated_at: 't2' }]);
  assert.equal(runGuardedEdit({ edits, gh: recovered }).attempts, 2);
  let tick = 0;
  const moving = { get: () => ({ body: NEXT_BODY, updated_at: `t${tick += 1}` }), patch: () => assert.fail('must not write') };
  assert.equal(runGuardedEdit({ edits, gh: moving }).reason, 'drift');
});

test('AC-9b a section replacement keeps human edits made since its draft: it stops instead of retrying over them', () => {
  const edits = [{ section: 'Next steps', content: '| 1 | done |', was: NEXT_WAS }];
  const added = NEXT_BODY.replace('| 1 | a |\n', '| 1 | a |\n| 2 | human |\n');
  // The follow-up lands during the freshness read; the retry must not write the stale draft over it.
  const raced = fakeGh([{ body: NEXT_BODY, updated_at: 't1' }, { body: added, updated_at: 't2' }, { body: added, updated_at: 't2' }]);
  assert.equal(runGuardedEdit({ edits, gh: raced }).reason, 'section-changed');
  assert.deepEqual(raced.state.writes, []);
  // The same holds when the change landed before the first read.
  assert.equal(runGuardedEdit({ edits, gh: fakeGh([{ body: added, updated_at: 't2' }]) }).reason, 'section-changed');
  assert.equal(applyEdits(NEXT_BODY, [{ section: 'Next steps', content: 'x' }], 'n').reason, 'base-missing');
  const written = runGuardedEdit({ edits, gh: fakeGh([{ body: NEXT_BODY, updated_at: 't1' }, { body: NEXT_BODY, updated_at: 't1' }]) });
  assert.equal(written.status, 'written');
  assert.ok(written.body.includes('| 1 | done |'));
});

test('AC-9c a missing or repeated anchor, or a missing section, stops without writing', () => {
  assert.equal(applyEdits(NEXT_BODY, [{ section: 'Next steps', find: 'zzz', replace: 'y' }], 'n').reason, 'anchor-missing');
  assert.equal(applyEdits(NEXT_BODY, [{ section: 'Next steps', find: '|', replace: 'y' }], 'n').reason, 'anchor-duplicate');
  assert.equal(applyEdits(NEXT_BODY, [{ section: 'Nope', find: 'a', replace: 'y' }], 'n').reason, 'section-missing');
  assert.equal(applyEdits('## A\n\n## A\n', [{ section: 'A', content: 'x' }], 'n').reason, 'section-duplicate');
});

test('AC-9d the freshness read happens before the write and never alongside it', () => {
  const calls = [];
  const gh = { get: () => { calls.push('get'); return { body: NEXT_BODY, updated_at: 't' }; }, patch: () => calls.push('patch') };
  runGuardedEdit({ edits: [{ section: 'Next steps', find: '| 1 | a |', replace: '| 1 | b |' }], gh });
  assert.deepEqual(calls, ['get', 'get', 'patch', 'get']);
});

test('AC-9e bytes outside the edited section, including <details> history, stay identical', () => {
  const body = '## Current work\n\n<details><summary>History</summary>\n\nold\n\n</details>\n\n## Next steps\n\nold table\n\n## Open questions\n\n- q\n\n<!-- AUTO:BEGIN -->\nx\n<!-- AUTO:END -->\n';
  const result = applyEdits(body, [{ section: 'Next steps', content: 'new table', was: 'old table' }], 'n');
  const [before, after] = body.split('old table');
  assert.ok(result.body.startsWith(before.replace(/\n+$/, '')));
  assert.ok(result.body.endsWith(after.replace(/^\n+/, '')));
  assert.ok(result.body.includes('new table'));
  const created = applyEdits('## Current work\n\n- x\n\n<!-- AUTO:BEGIN -->\nx\n<!-- AUTO:END -->\n', [{ create: { heading: '## Next steps', content: '| # |' } }], 'n').body;
  assert.ok(created.indexOf('## Next steps') < created.indexOf('<!-- AUTO:BEGIN -->'));
  assert.ok(created.endsWith('<!-- AUTO:BEGIN -->\nx\n<!-- AUTO:END -->\n'));
});

test('AC-9g a heading inside a code fence is never a section, so owner content survives', () => {
  // A ~~~ line inside a backtick fence is content, not a close, so the heading under it is not real.
  const nested = '## Current work\n\n```md\n~~~\n## Next steps\n~~~\n```\n\nOwner notes.\n';
  assert.equal(applyEdits(nested, [{ section: 'Next steps', content: 'x' }], 'n').reason, 'section-missing');
  assert.equal(discoverTargets(discovery({ trackerBodies: { 71: nested } })).next[0].action, 'create');
  // A longer opener is not closed by a shorter fence; an unclosed one runs to the end and makes the body unsafe to edit at all.
  assert.equal(applyEdits('````\n```\n## Next steps\n````\n', [{ section: 'Next steps', content: 'x' }], 'n').reason, 'section-missing');
  assert.equal(applyEdits('```\n## Next steps\n', [{ section: 'Next steps', content: 'x' }], 'n').reason, 'unclosed-fence');
  // A closed example before the real section still leaves that section editable, fence bytes intact.
  const real = `${nested}\n## Next steps\n\n| 1 | a |\n`;
  const edited = applyEdits(real, [{ section: 'Next steps', find: '| 1 | a |', replace: '| 1 | b |' }], 'n');
  assert.ok(edited.ok);
  assert.ok(edited.body.startsWith(nested), 'the code block and the owner notes stay byte-for-byte');
  assert.ok(edited.body.endsWith('## Next steps\n\n| 1 | b |\n'));
});

test('AC-9g an ATX heading indented up to three spaces is the same section, so nothing is duplicated', () => {
  const body = '## Current work\n\n- x\n\n  ## Next steps\n\n| 1 | a |\n';
  const edited = applyEdits(body, [{ section: 'Next steps', find: '| 1 | a |', replace: '| 1 | b |' }], 'n');
  assert.ok(edited.ok);
  assert.equal(edited.body, body.replace('| 1 | a |', '| 1 | b |'), 'the section is edited in place, indentation and all');
  assert.equal(applyEdits(body, [{ create: { heading: '## Next steps', content: '| # |' } }], 'n').reason, 'section-exists');
  assert.equal(discoverTargets(discovery({ trackerBodies: { 71: body } })).next[0].section, 'Next steps');
  // Four spaces is an indented code block, not a heading.
  assert.equal(applyEdits('## A\n\n    ## Next steps\n', [{ section: 'Next steps', content: 'x' }], 'n').reason, 'section-missing');
});

test('AC-9h an AUTO:BEGIN inside a code fence bounds no section and takes no insertion', () => {
  const fenced = '## Next steps\n\n| 1 | a |\n\n```md\n<!-- AUTO:BEGIN -->\nexample\n<!-- AUTO:END -->\n```\n\n## Open questions\n\n- q\n';
  // The example marker must not end the section, so a replacement never cuts the fence in half.
  const replaced = applyEdits(fenced, [{ section: 'Next steps', content: 'new', was: fenced.slice(14, fenced.indexOf('## Open')) }], 'n');
  assert.ok(replaced.ok);
  assert.ok(replaced.body.endsWith('## Open questions\n\n- q\n'));
  assert.ok(!replaced.body.includes('```'), 'no orphaned half of the fenced example survives');
  const anchored = applyEdits(fenced, [{ section: 'Next steps', find: '| 1 | a |', replace: '| 1 | b |' }], 'n');
  assert.equal(anchored.body, fenced.replace('| 1 | a |', '| 1 | b |'), 'the fenced example stays byte-for-byte');

  // With no real marker, the created section is appended after the example and is a real one, so a second run sees it.
  const example = '## Current work\n\n```md\n<!-- AUTO:BEGIN -->\nexample\n<!-- AUTO:END -->\n```\n';
  const created = applyEdits(example, [{ create: { heading: '## Next steps', content: '| # |' } }], 'n');
  assert.ok(created.body.startsWith(example) && created.body.endsWith('## Next steps\n\n| # |\n'));
  assert.equal(applyEdits(created.body, [{ create: { heading: '## Next steps', content: '| # |' } }], 'n').reason, 'section-exists');
  // The real marker still bounds the insertion, below the example that merely mentions one.
  const placed = applyEdits(`${example}\n<!-- AUTO:BEGIN -->\nreal\n<!-- AUTO:END -->\n`, [{ create: { heading: '## Next steps', content: '| # |' } }], 'n');
  assert.ok(placed.body.indexOf('## Next steps') > placed.body.indexOf('```md'));
  assert.ok(placed.body.endsWith('<!-- AUTO:BEGIN -->\nreal\n<!-- AUTO:END -->\n'));

  // A body that ends inside an open fence hides whatever follows, so neither an edit nor a creation touches it.
  const unclosed = '## Next steps\n\n| 1 | a |\n\n```md\n<!-- AUTO:BEGIN -->\n';
  assert.equal(applyEdits(unclosed, [{ section: 'Next steps', content: 'x' }], 'n').reason, 'unclosed-fence');
  assert.equal(applyEdits(unclosed, [{ create: { heading: '## Later', content: 'x' } }], 'n').reason, 'unclosed-fence');
  // Whatever the placement, the created heading has to end up as exactly one real section.
  assert.equal(applyEdits('## Current work\n\n- x\n', [{ create: { heading: '## Next steps', content: '## Next steps\n\n- y' } }], 'n').reason, 'create-unverified');
});

test('AC-9f the {{now}} stamp is taken at write time, once per attempt', () => {
  let n = 0;
  const gh = fakeGh([{ body: NEXT_BODY, updated_at: 't1' }, { body: NEXT_BODY, updated_at: 't1' }]);
  runGuardedEdit({ edits: [{ section: 'Next steps', find: '| 1 | a |', replace: '{{now}}' }], gh, now: () => `S${n += 1}` });
  assert.ok(gh.state.writes[0].includes('S1'));
});

// ---------- AC-10, AC-11 ----------

test('AC-10 CI is reported as observed, one entry per workflow, and never waited for', () => {
  assert.equal(renderCi([{ status: 'in_progress', url: 'u' }]), '🔄 in progress ([run log](u))');
  assert.equal(renderCi([{ workflowName: 'Tests', status: 'completed', conclusion: 'success', url: 'u' }]), 'Tests ✅ passed ([run log](u))');
  assert.equal(renderCi([{ status: 'completed', conclusion: 'failure', url: 'u' }]), '⛔ failed (failure) ([run log](u))');
  assert.equal(renderCi([{ status: 'completed', conclusion: 'cancelled', url: 'u', supersededBy: { status: 'completed', conclusion: 'success', url: 'v' } }]), '⏭️ superseded ([run log](u)), newer run: [success](v)');
  assert.equal(renderCi([{ workflowName: 'A', status: 'completed', conclusion: 'success' }, { workflowName: 'B', status: 'queued' }]), 'A ✅ passed; B 🔄 in progress');
  assert.equal(renderCi([{ status: 'completed', conclusion: 'success', url: 'u' }], 'zh'), t('zh', 'ci.success', { link: t('zh', 'ci.link', { url: 'u' }) }));
  for (const none of [null, []]) assert.ok(renderCi(none).startsWith('❓ no run found'));
});

test('AC-11 the report lists gaps and warnings first, then merge, links, owner commands and next steps', () => {
  const text = renderReport({ ...closeoutInput(), links: ['[closeout](u)'], next: ['dispatch part two'], gaps: [] });
  const order = ['## Delivery gaps and warnings', '## Merge', '## Links', '## For the owner to run', '## Next steps'].map((h) => text.indexOf(h));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order.every((index) => index >= 0));
  assert.ok(text.includes('🧹 local branch `pr134-w1` not finished'));
  assert.ok(text.includes('- ⚠️ no linked discussion found'));
  assert.ok(text.includes('git branch -D pr134-w1'));
});

// ---------- CLI ----------

const SCRIPT = fileURLToPath(new URL('./check-merge.mjs', import.meta.url));
function cli(command, input) {
  const dir = mkdtempSync(join(tmpdir(), 'dev-merge-cli-'));
  try {
    writeFileSync(join(dir, 'input.json'), JSON.stringify(input));
    const result = spawnSync(process.execPath, [SCRIPT, command, '--input', join(dir, 'input.json')], { encoding: 'utf8' });
    return { status: result.status, json: JSON.parse(result.stdout || '{}') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('AC-3 the gate exits 0 on every verdict the procedure continues on and 1 only on a stop', () => {
  const moved = { pr: pr(), main: M };
  const cases = [['pass', { pr: pr(), main: B, headTree: T1 }], ['collect', moved],
    ['verify', { ...moved, mergeTree: { conflict: false, tree: T2 }, mainChanges: ['server/x.ts'] }]];
  for (const [verdict, input] of cases) {
    const result = cli('gate', input);
    assert.deepEqual([result.json.verdict, result.status], [verdict, 0], verdict);
  }
  const stopped = cli('gate', { pr: pr({ isDraft: true }), main: B, headTree: T1 });
  assert.deepEqual([stopped.json.verdict, stopped.json.reason, stopped.status], ['stop', 'draft', 1]);
  assert.equal(cli('nonsense', {}).status, 2, 'a check that did not run exits 2');
});
