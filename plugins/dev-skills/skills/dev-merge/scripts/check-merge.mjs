// Decision helpers for /dev-merge. Every exported function is pure: it reads JSON the agent or
// apply-cleanup.mjs collected and returns one decision. Only the `edit` subcommand talks to GitHub,
// through the injected runner in runGuardedEdit. Exit 0 proceeds, 1 stops, 2 the check did not run.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fail = (reason, detail = '') => ({ ok: false, reason, detail });

// Human-facing text lives in ../locales.json so this file stays English; codes stay English everywhere.
const LOCALES = JSON.parse(readFileSync(new URL('../locales.json', import.meta.url), 'utf8'));

/** Localized text for key with {name} placeholders filled; English, then the key itself, when it is missing. */
export function t(lang, key, vars = {}) {
  // An unknown key must never abort a closeout, so the key stands in for the missing text.
  const text = LOCALES[lang]?.[key] ?? LOCALES.en[key] ?? key;
  return String(text).replace(/\{(\w+)\}/g, (match, name) => String(vars[name] ?? match));
}

/** 'zh' when CJK characters carry the prose (code, markers and links removed), otherwise 'en'. */
export function detectLang(text = '') {
  // Sample data inside a fence is not prose, whatever fence it uses, so the shared scanner drops those lines first.
  const prose = unfenced(text).replace(/`[^`\n]*`|<!--[\s\S]*?-->|\]\([^)]*\)|https?:\/\/\S+/g, '');
  // Every Han block a body could carry, as in the English-only validator: extension A, the basic range,
  // the compatibility ideographs and all of planes 2-3, so later extensions need no edit here.
  const cjk = (prose.match(/[\u3400-\u9fff\uf900-\ufaff\u{20000}-\u{3ffff}]/gu) ?? []).length;
  const latin = (prose.match(/[A-Za-z]/g) ?? []).length;
  // One CJK character reads as roughly one word; an English word averages about five letters.
  return cjk > 0 && cjk * 5 >= latin ? 'zh' : 'en';
}

// ---------- AC-2: arguments ----------

const KEYS = ['mode', 'cleanup', 'issues', 'tracker', 'next'];
const CHOICES = { mode: ['closeout', 'handover'], cleanup: ['stale', 'own', 'none'] };

function issueList(value) {
  const items = value.split(',').map((item) => item.trim().replace(/^#/, ''));
  if (!items.length || items.some((item) => !/^[1-9]\d*$/.test(item))) return null;
  return [...new Set(items.map(Number))];
}

function nextTarget(value, repo) {
  const bare = value.replace(/^#/, '');
  if (/^[1-9]\d*$/.test(bare)) return { issue: Number(bare) };
  const match = value.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)#issuecomment-([1-9]\d*)$/);
  if (match && match[1] === repo) return { issue: Number(match[2]), comment: Number(match[3]) };
  return null;
}

/** Parse `/dev-merge` arguments. Text after a standalone `--` is kept verbatim as owner notes. */
export function parseArgs(text = '', repo = '') {
  const cut = text.match(/(^|\s)--(\s|$)/);
  const head = cut ? text.slice(0, cut.index) : text;
  const notes = cut ? text.slice(cut.index + cut[0].length).trim() : '';
  const tokens = head.trim().split(/\s+/).filter(Boolean);
  const args = { pr: null, mode: 'closeout', cleanup: 'stale', issues: null, tracker: null, next: null, dryRun: false, notes };
  const seen = new Set();
  for (const [index, token] of tokens.entries()) {
    if (token.startsWith('pr=')) {
      if (index !== 0) return fail('usage', 'pr=<n> is accepted only as the first token, once');
      if (!/^[1-9]\d*$/.test(token.slice(3))) return fail('usage', `pr= takes a bare positive number such as pr=<n>, not ${token.slice(3) || 'an empty value'}`);
      args.pr = Number(token.slice(3));
      continue;
    }
    if (token === 'dry-run') {
      if (args.dryRun) return fail('usage', 'dry-run is repeated');
      args.dryRun = true;
      continue;
    }
    const match = token.match(/^([a-z]+)=(.+)$/);
    if (!match || !KEYS.includes(match[1])) return fail('usage', `unknown argument ${token}; put free text after --`);
    const [, key, value] = match;
    if (seen.has(key)) return fail('usage', `${key}= is repeated`);
    seen.add(key);
    if (CHOICES[key]) {
      if (!CHOICES[key].includes(value)) return fail('usage', `${key}= takes ${CHOICES[key].join(' or ')}, not ${value}`);
      args[key] = value;
    } else if (key === 'next') {
      args.next = nextTarget(value, repo);
      if (!args.next) return fail('usage', `next= takes an issue number or an issue comment link in ${repo}`);
    } else {
      args[key] = issueList(value);
      if (!args[key]) return fail('usage', `${key}= takes issue numbers such as ${key}=<n>,<n>`);
    }
  }
  return { ok: true, args };
}

/** AC-2b: with no pr=, the current branch must have exactly one open PR. */
export function resolvePr(args, branchPrs = []) {
  if (args.pr) return { ok: true, pr: args.pr };
  if (branchPrs.length === 1) return { ok: true, pr: branchPrs[0].number };
  return fail(branchPrs.length ? 'ambiguous-pr' : 'no-pr', `open PRs for this branch: ${branchPrs.map((p) => p.number).join(', ') || 'none'}`);
}

// ---------- AC-3: merge gate ----------

// A review-loop skill (`review-pr` or `<prefix>-review-pr`) marks each full, closing or final review with this first line, and the body
// carries `Reviewed head: [..](…/commit/<sha>)`, `Base: [..](…/commit/<sha>)` and `Verdict: <state>`.
const REVIEW = /^<!-- (?:[a-z0-9]+-)*review-pr: \S+ round=\d+ phase=(?:review|closing-review|final-review) -->$/;
const sha = (text, label) => text.match(new RegExp(`${label}[^\\n]*?/commit/([0-9a-f]{40})`))?.[1] ?? null;
// Anyone may comment on a PR, so evidence counts only from an author the repository itself trusts.
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const trusted = (item) => TRUSTED.has(item?.authorAssociation);
const when = (item) => String(item?.createdAt ?? item?.submittedAt ?? '');
// GitHub keeps one decisive state per reviewer; a COMMENTED review leaves the previous one in place.
const DECISIVE = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);
// A position in the array is not a time: both a reviewer's own latest state and the latest approval of all go by submittedAt.
const byTime = (a, b) => (when(a) < when(b) ? -1 : when(a) > when(b) ? 1 : 0);
/** The latest decisive formal review of each reviewer, oldest submission first. */
const currentReviews = (reviews = []) =>
  [...reviews.filter((r) => DECISIVE.has(r.state)).sort(byTime).reduce((map, r) => map.set(r.author?.login ?? '', r), new Map()).values()].sort(byTime);

/**
 * The fields of a marked report, read only outside code fences, or null when the report is ambiguous.
 * A fenced example must never decide the gate, so no verdict line, two of them, or an unclosed fence
 * hiding one all count as no evidence.
 */
function markedFields(body = '') {
  const text = unfenced(body);
  const verdicts = text.split('\n').filter((line) => /^Verdict:/.test(line));
  if (verdicts.length !== 1) return null;
  return { eligible: /^Verdict:\s*approval-eligible\b/.test(verdicts[0]), head: sha(text, 'Reviewed head:'), base: sha(text, 'Base:') };
}

/** AC-3d: the latest trusted marked review when it is approval-eligible at the head, or a trusted APPROVED review of the head that is newer than it. */
export function reviewEvidence(pr) {
  const head = pr.headRefOid;
  const marked = (c) => REVIEW.test((c.body ?? '').split('\n')[0]);
  const approves = (r) => r.state === 'APPROVED' && r.commit?.oid === head;
  // A withdrawn approval is no longer evidence: a reviewer's standing CHANGES_REQUESTED blocks until that same
  // reviewer approves again or it is dismissed, and another reviewer's approval does not clear it.
  const current = currentReviews(pr.reviews);
  if (current.some((r) => r.state === 'CHANGES_REQUESTED' && trusted(r))) {
    return fail('review-changes-requested', 'a trusted reviewer requested changes; it takes a new approval from them, or a dismissal, to clear it');
  }
  const terminal = (pr.comments ?? []).filter((c) => marked(c) && trusted(c)).at(-1);
  const report = terminal ? markedFields(terminal.body ?? '') : null;
  if (report?.eligible && report.head === head) {
    return { ok: true, kind: 'terminal-comment', url: terminal.url, base: report.base };
  }
  const approval = current.filter((r) => approves(r) && trusted(r)).at(-1);
  // A marked review that is not approval-eligible at this head withdraws eligibility; only a later approval overrides it.
  if (approval && (!terminal || when(approval) > when(terminal))) return { ok: true, kind: 'approved-review', url: approval.url ?? null, base: null };
  const untrusted = (pr.comments ?? []).some((c) => marked(c) && !trusted(c)) || current.some((r) => approves(r) && !trusted(r));
  return fail(terminal ? 'review-evidence-stale' : untrusted ? 'review-evidence-untrusted' : 'no-review-evidence',
    'needs a marked review with Verdict: approval-eligible, or an APPROVED review on the current head, from an owner, member or collaborator');
}

const docsOnly = (paths) => paths.every((path) => path.startsWith('docs/') || path.endsWith('.md'));
// A tree the merge can be verified against is a full hex object id, sha-1 or sha-256.
const objectId = (value) => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);

// Workflows may be path-filtered, so no single check is required; every check that ran must be green or skipped.
const GREEN = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);

/**
 * Decide whether the PR may be merged now. Verdicts: pass (merge), collect (supply mergeTree and
 * mainChanges), verify (run the repository's `AGENTS.md` checks and the matching CI test commands on the merge tree and supply verifyExit), stop.
 */
export function gate(input) {
  const { pr, main } = input;
  // Every comment the skill writes for this PR follows the language of the PR body.
  const lang = detectLang(pr.body ?? '');
  const stop = (reason, detail = '') => ({ verdict: 'stop', reason, detail, head: pr.headRefOid, main, lang });
  // The pre-merge recheck reuses merge-tree facts only for the head and main they were collected on.
  if (input.expected && (input.expected.head !== pr.headRefOid || input.expected.main !== main)) return stop('moved-since-gate');
  if (pr.state !== 'OPEN') return stop('pr-not-open', pr.state);
  if (pr.isDraft) return stop('draft');
  if ((pr.labels ?? []).some((label) => label.name === 'hold')) return stop('hold-label');
  const red = (pr.statusCheckRollup ?? []).filter((check) => !GREEN.has(check.conclusion ?? check.state));
  if (red.length) return stop('checks-not-success', red.map((c) => `${c.name ?? c.context}:${c.conclusion || c.status || c.state}`).join(','));
  const evidence = reviewEvidence(pr);
  if (!evidence.ok) return stop(evidence.reason, evidence.detail);
  const moved = pr.mergeStateStatus === 'BEHIND' || evidence.base !== main;
  if (pr.mergeStateStatus !== 'CLEAN' && pr.mergeStateStatus !== 'BEHIND') return stop(`merge-state-${pr.mergeStateStatus}`);
  const result = { head: pr.headRefOid, main, base: evidence.base, moved, evidence: { kind: evidence.kind, url: evidence.url }, lang };
  // Without the head tree the merge could not be verified afterwards, so the gate stops instead of passing.
  if (!moved) return objectId(input.headTree) ? { verdict: 'pass', reason: 'base-unchanged', expectedTree: input.headTree, ...result } : stop('head-tree-missing');
  if (!input.mergeTree || !Array.isArray(input.mainChanges)) return { verdict: 'collect', reason: 'main-moved', need: ['mergeTree', 'mainChanges'], ...result };
  if (input.mergeTree.conflict) return stop('merge-conflict');
  const expectedTree = input.mergeTree.tree;
  // The merge tree is what verify-merge checks the squash against, so no path passes or verifies without it.
  if (!objectId(expectedTree)) return stop('merge-tree-missing');
  if (docsOnly(input.mainChanges)) return { verdict: 'pass', reason: 'main-moved-docs-only', expectedTree, ...result };
  if (input.verifyExit === 0) return { verdict: 'pass', reason: 'merge-tree-verified', expectedTree, ...result };
  // A dry-run never creates or removes the verification worktree, so it stops here instead.
  if (input.verifyExit === undefined || input.verifyExit === null) return input.dryRun ? stop('dry-run-no-verify') : { verdict: 'verify', reason: 'main-moved-code', expectedTree, ...result };
  return stop('merge-tree-verify-failed', String(input.verifyExit));
}

// ---------- AC-4: squash body and merged commit ----------

const CLOSING = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+([\w.-]+\/[\w.-]+)?#(\d+)/gi;
// A reference may name another repository, whose numbers say nothing about this one's issues. An
// unqualified reference is always local, and GitHub compares repository names case-insensitively. A full issue
// URL counts as its <owner>/<repo>#<n> form, as GitHub reads it after a closing keyword too.
const shortRefs = (text) => text.replace(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\b/gi, '$1#$2');
const repoRefs = (text = '', repo = '', re = CLOSING) =>
  [...shortRefs(text).matchAll(re)].filter((m) => !m[2] || m[2].toLowerCase() === String(repo).toLowerCase());

/** AC-4b: a closing keyword may name only an issue whose acceptance criteria are all delivered. */
export function lintSquashBody(body, issues = [], prBody = '', closingIssues = [], repo = '') {
  const partial = new Set(issues.filter((issue) => !issue.complete).map((issue) => issue.number));
  const findings = repoRefs(body, repo).filter((m) => partial.has(Number(m[3])))
    .map((m) => `#${m[3]} is not complete: write Ref #${m[3]} instead of ${m[1]}`);
  // GitHub also closes what the PR body or a manual link closes, whatever the squash body says.
  const prCloses = new Set([...repoRefs(prBody, repo).map((m) => Number(m[3])), ...closingIssues]);
  for (const n of partial) if (prCloses.has(n)) findings.push(`#${n} is not complete but the PR closes it: change the PR body to Ref #${n} or unlink it`);
  // An issue nobody judged would be closed without its acceptance criteria ever being checked.
  const judged = new Set(issues.map((issue) => issue.number));
  const closes = new Set([...prCloses, ...repoRefs(body, repo).map((m) => Number(m[3]))]);
  for (const n of closes) if (!judged.has(n)) findings.push(`#${n} would be closed but was not judged: add it to issues or unlink it`);
  return findings.length ? { ok: false, reason: 'closing-keyword', findings } : { ok: true };
}

/** AC-4b: GitHub reads closing keywords in the squash subject as well as its body, so both are linted together. */
export function lintSquashMessage({ subject, body = '', issues, prBody, closingIssues, repo }) {
  if (typeof subject !== 'string' || !subject.trim()) return fail('subject-missing', 'lint the squash subject with its body');
  return lintSquashBody(`${subject}\n\n${body}`, issues, prBody, closingIssues, repo);
}

/** AC-4c: the squash commit sits on the pre-merge main and carries the verified tree. */
export function verifyMerge({ parents = [], tree, expectedParent, expectedTree }) {
  if (parents.length !== 1 || parents[0] !== expectedParent) return fail('parent-mismatch', `${parents.join(',')} != ${expectedParent}`);
  if (!expectedTree || tree !== expectedTree) return fail('tree-mismatch', `${tree} != ${expectedTree}`);
  return { ok: true };
}

// ---------- AC-5: cleanup plan ----------

const ownPrefix = (n) => new RegExp(`^pr${n}(?![0-9])`);
const inside = (path, root) => path === root || path.startsWith(`${root.replace(/\/$/, '')}/`);
// A pr<n>* entry directly under root, such as $TMPDIR/pr<n> or .claude/worktrees/pr<n>-review.
const ownUnder = (path, root, n) => Boolean(root) && inside(path, root) && ownPrefix(n).test(path.slice(root.replace(/\/$/, '').length + 1));
const finished = (state) => state === 'MERGED' || state === 'CLOSED';

/**
 * AC-5: turn a collected inventory into removals and skips. Removal kinds run in this order:
 * worktree, local-branch, remote-branch, scratch. The session worktree is reported as
 * exit-worktree for the agent's ExitWorktree call, never run by a script.
 */
export function planCleanup(inv) {
  const n = inv.pr.number;
  const remove = [];
  const skip = [];
  // apply refuses a saved plan whose repository or Git storage differs from the checkout it runs in.
  const bound = { repo: inv.repo, commonDir: inv.commonDir };
  if (inv.mode === 'none') return { ...bound, remove, skip: [{ kind: 'all', target: 'cleanup=none', reason: 'cleanup-not-requested' }] };
  // Without main's commit every ancestry answer is "no", which would misreport merged heads as unmerged.
  if (inv.mainMissing) throw new Error(`main commit ${inv.main} is not in the local repository; fetch main, then plan again`);
  const ownBranch = (name) => name === inv.pr.headRefName || new RegExp(`^pr${n}-w\\d+$`).test(name);
  const prState = (item) => inv.prsByName?.[item.branch ?? item.name]?.state ?? inv.prsByHead?.[item.head]?.state ?? null;
  // A same-named merged PR is not enough: the head itself must be in main, in this PR, or a finished PR's head,
  // otherwise the branch may carry commits that exist nowhere else.
  const safeHead = (item) => Boolean(item.ancestorOfMain || item.containedInPr || item.head === inv.pr.headRefOid ||
    finished(inv.prsByHead?.[item.head]?.state));
  // The worktree this run was launched from is own only when it matches this PR too: an explicit pr=<n>
  // may target another PR, and `own` must never discard an unrelated session checkout.
  const isOwnWorktree = (wt) => ownUnder(wt.path, inv.scratchRoot, n) ||
    ownUnder(wt.path, `${inv.mainCheckout}/.claude/worktrees`, n) || (wt.branch && ownBranch(wt.branch));
  const kept = new Set();
  for (const wt of inv.worktrees) {
    const own = isOwnWorktree(wt);
    kept.add(wt.branch);
    if (!own && inv.mode === 'own') continue;
    const why = wt.path === inv.mainCheckout ? 'main-checkout'
      : wt.dirty === null || wt.dirty === undefined || wt.hasIgnored === null ? 'state-unknown'
      : wt.dirty ? 'uncommitted-changes'
      : wt.locked ? 'locked'
      // `git worktree remove` and ExitWorktree delete ignored files too (build output, drafts, .env …); keep them for the owner.
      : wt.hasIgnored ? 'ignored-files'
      : !own && !(finished(prState(wt)) || wt.ancestorOfMain) ? (prState(wt) === 'OPEN' ? 'pr-open' : 'state-unknown')
      : !safeHead(wt) ? 'unmerged-commits'
      // Only the session worktree is known to be idle: this run is the process whose cwd is inside it, so neither
      // a hidden process list nor its own cwd decides anything there. A pr<n> name proves nothing about the others.
      : wt.path === inv.sessionWorktree ? ''
      : inv.processCheck !== 'ok' ? 'process-check-unavailable'
      : wt.busy ? 'busy'
      : '';
    if (why) { skip.push({ kind: 'worktree', target: wt.path, reason: why }); continue; }
    // The session worktree's branch stays until ExitWorktree frees it; a second plan run then removes it.
    if (wt.path === inv.sessionWorktree) { remove.push({ kind: 'exit-worktree', target: wt.path }); continue; }
    kept.delete(wt.branch);
    remove.push({ kind: 'worktree', target: wt.path });
  }
  for (const branch of inv.branches) {
    if (branch.name === inv.defaultBranch || kept.has(branch.name)) continue;
    const own = ownBranch(branch.name);
    if (!own && inv.mode === 'own') continue;
    if (!own && !(finished(prState(branch)) || branch.ancestorOfMain)) continue; // live or unknown branches are not stale
    if (!safeHead(branch)) { skip.push({ kind: 'local-branch', target: branch.name, reason: 'unmerged-commits' }); continue; }
    remove.push({ kind: 'local-branch', target: branch.name });
  }
  const remoteName = inv.pr.headRefName;
  if (!inv.remoteHead) skip.push({ kind: 'remote-branch', target: remoteName, reason: 'remote-missing' });
  else if (!inv.pr.sameRepo || remoteName === inv.defaultBranch || inv.pr.state !== 'MERGED') skip.push({ kind: 'remote-branch', target: remoteName, reason: 'not-merged-head' });
  else if (inv.remoteHead !== inv.pr.headRefOid) skip.push({ kind: 'remote-branch', target: remoteName, reason: 'remote-moved' });
  else remove.push({ kind: 'remote-branch', target: remoteName, head: inv.remoteHead });
  // A pr<n> name proves nothing about who created the directory, so a scratch entry goes only when it is a
  // directory holding nothing but worktrees this run removes. An owner's same-named files keep it.
  const goes = new Set(remove.filter((item) => item.kind === 'worktree' || item.kind === 'exit-worktree').map((item) => item.target));
  for (const dir of inv.scratch ?? []) {
    if (!ownUnder(dir.path, inv.scratchRoot, n)) continue;
    const why = inv.worktrees.some((wt) => inside(wt.path, dir.path) && skip.some((s) => s.target === wt.path)) ? 'holds-skipped-worktree'
      : dir.directory !== true ? 'not-a-directory'
      : !Array.isArray(dir.entries) ? 'state-unknown'
      : dir.entries.some((entry) => !goes.has(entry)) ? 'holds-other-files'
      : '';
    if (why) { skip.push({ kind: 'scratch', target: dir.path, reason: why }); continue; }
    remove.push({ kind: 'scratch', target: dir.path });
  }
  const order = ['worktree', 'local-branch', 'remote-branch', 'scratch', 'exit-worktree'];
  remove.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return { ...bound, remove, skip };
}

// ---------- AC-8: related issues, discussions, trackers, next ----------

// The group layout matches CLOSING, so both share the repository filter: 2 = repository, 3 = number.
const REF = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\b:?\s+([\w.-]+\/[\w.-]+)?#(\d+)/gi;
export const isFeatLabel = (name) => /^[^:\s]+:[^:\s]+$/.test(name);
// Next-steps headings of every locale, so a tracker written in any of them is recognized.
const NEXT = new Set(Object.values(LOCALES).flatMap((texts) => texts['next.headings'] ?? []));

/** One pass over a body: { lines, fenced, unclosed, headings, offset }, so heading and marker lookups agree on what is inside a fence. */
// CommonMark fences: 0-3 spaces then three or more backticks or tildes, a backtick opener's info
// string holding no backtick. Only the same character, at least as long and alone on its line
// closes it, so a shorter or foreign fence inside stays content and an unclosed one runs to the end.
// An ATX heading may be indented 0-3 spaces; four or more make it an indented code block, not a heading.
function scan(body) {
  const lines = body.split('\n');
  const fenced = [];
  const found = [];
  let open = null;
  lines.forEach((line, index) => {
    const [, run, rest] = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/) ?? [];
    const was = open;
    if (run && !open && (run[0] === '~' || !rest.includes('`'))) open = run;
    else if (run && open && run[0] === open[0] && run.length >= open.length && !rest.trim()) open = null;
    fenced.push(Boolean(was || open));
    const match = !open && line.match(/^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (match) found.push({ depth: match[1].length, text: match[2], line: index });
  });
  const offset = (line) => lines.slice(0, line).reduce((sum, text) => sum + text.length + 1, 0);
  return { lines, fenced, unclosed: Boolean(open), headings: found, offset };
}

/** Headings of depth 2-3 outside code fences: { depth, text, line }. */
export const headings = (body) => scan(body).headings;

/** The body without its fenced lines, so prose and field lookups never read an example; an unclosed fence hides the rest. */
const unfenced = (body = '') => { const doc = scan(body); return doc.lines.filter((line, index) => !doc.fenced[index]).join('\n'); };

// A repository name may hold dots and other metacharacters, which must match literally inside a link pattern.
const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function discoverTargets(input) {
  const warnings = [];
  const body = input.prBody ?? '';
  const tracking = input.tracking ?? [];
  const trackingNumbers = new Set(tracking.map((t) => t.number));
  // Whatever the arguments or the tracking labels say, an issue this PR closes has to be judged.
  const closed = [...new Set([...repoRefs(body, input.repo).map((m) => Number(m[3])), ...(input.closingIssues ?? [])])];
  const referenced = [...new Set([...repoRefs(body, input.repo, REF).map((m) => Number(m[3])), ...closed])];
  const chosen = input.args?.issues ?? referenced.filter((n) => !trackingNumbers.has(n));
  const added = closed.filter((n) => !chosen.includes(n));
  const issues = [...chosen, ...added];
  if (added.length) warnings.push({ code: 'issues-closed-added', issues: added });
  if (!issues.length) warnings.push({ code: 'no-issue' });
  // GitHub reads a link case-insensitively, so a link that cases the host or the repository differently is still local.
  const discussions = [...new Set([...body.matchAll(new RegExp(`https://github\\.com/${escapeRe(input.repo)}/discussions/(\\d+)`, 'gi'))].map((m) => Number(m[1])))];
  if (!discussions.length) warnings.push({ code: 'no-discussion' });
  const prFeat = (input.prLabels ?? []).filter(isFeatLabel);
  const issueFeat = [...new Set(issues.flatMap((n) => (input.issueMeta?.[n]?.labels ?? []).filter(isFeatLabel)))];
  for (const label of issueFeat.filter((label) => !prFeat.includes(label))) warnings.push({ code: 'feat-label-missing', label });
  let trackers = input.args?.tracker;
  if (!trackers) {
    // A mention may name this repository, as a closing keyword may; the groups follow CLOSING (2 = repository, 3 = number), so repoRefs drops every other repository here too.
    const mention = new RegExp(`()(?:(?<![\\w/])([\\w.-]+/[\\w.-]+)?#|https://github\\.com/${escapeRe(input.repo)}/issues/)(\\d+)\\b`, 'gi');
    const mentioned = repoRefs(body, input.repo, mention).map((m) => Number(m[3])).filter((n) => trackingNumbers.has(n));
    const byLabel = [];
    for (const label of prFeat.length ? prFeat : issueFeat) {
      const found = tracking.filter((t) => t.labels.includes(label));
      if (found.length === 1) byLabel.push(found[0].number);
      else warnings.push(found.length ? { code: 'tracker-ambiguous', label, issues: found.map((item) => item.number) } : { code: 'tracker-missing', label });
    }
    trackers = [...new Set([...mentioned, ...byLabel])];
  }
  if (!trackers.length) warnings.push({ code: 'no-tracker' });
  const next = [];
  // A created heading is written into the tracker, so it follows the language every comment of this run uses.
  const lang = input.lang ?? detectLang(body);
  if (input.args?.next) next.push({ ...input.args.next, action: 'update' });
  else {
    for (const tracker of trackers) {
      const trackerBody = input.trackerBodies?.[tracker];
      if (trackerBody === undefined) { warnings.push({ code: 'tracker-unread', issue: tracker }); continue; }
      const found = headings(trackerBody).filter((h) => h.depth >= 2 && h.depth <= 3 && NEXT.has(h.text.trim().toLowerCase()));
      if (found.length === 1) next.push({ issue: tracker, action: 'update', section: found[0].text });
      else if (!found.length) next.push({ issue: tracker, action: 'create', section: t(lang, 'next.heading') });
      else warnings.push({ code: 'next-ambiguous', issue: tracker });
    }
  }
  if (!next.length) warnings.push({ code: 'no-next' });
  return { issues, discussions, trackers, next, warnings };
}

// ---------- AC-9: guarded edits ----------

const AUTO_BEGIN = '<!-- AUTO:BEGIN -->';

/** Byte range of the named section (heading line excluded), or a stop reason when it is not exactly one or the body is unsafe to edit. */
export function sectionRange(body, title) {
  const doc = scan(body);
  // An unclosed fence swallows every heading and marker after its opener, so no range in this body can be trusted.
  if (doc.unclosed) return { ok: false, reason: 'unclosed-fence' };
  const hits = doc.headings.filter((h) => h.depth >= 2 && h.depth <= 3 && h.text.trim() === title);
  if (hits.length !== 1) return { ok: false, reason: hits.length ? 'section-duplicate' : 'section-missing' };
  const [hit] = hits;
  const nextHeading = doc.headings.find((h) => h.line > hit.line && h.depth <= hit.depth);
  // Only the real AUTO region ends the section; a marker inside an example is owner content and stays whole.
  const autoLine = doc.lines.findIndex((line, index) => index > hit.line && !doc.fenced[index] && line.trim() === AUTO_BEGIN);
  const endLine = Math.min(nextHeading?.line ?? doc.lines.length, autoLine === -1 ? doc.lines.length : autoLine);
  return { ok: true, start: doc.offset(hit.line + 1), end: Math.min(doc.offset(endLine), body.length) };
}

/**
 * Apply edits to a body. Each edit is one of:
 *   { section, find, replace }  exact-once replacement inside the section (whole body without section)
 *   { section, content }        replace the section's content
 *   { create: { heading, content } }  new section before the first AUTO region, or at the end
 * `{{now}}` in new text becomes the write-time stamp.
 */
export function applyEdits(body, edits, now) {
  let text = body;
  for (const edit of edits) {
    const fill = (value) => String(value).replaceAll('{{now}}', now);
    if (edit.create) {
      const title = edit.create.heading.replace(/^#+\s*/, '');
      const doc = scan(text);
      if (doc.unclosed) return fail('unclosed-fence', title);
      if (doc.headings.some((h) => h.text.trim() === title)) return fail('section-exists', title);
      const block = `${edit.create.heading}\n\n${fill(edit.create.content).replace(/\n*$/, '\n')}`;
      // The new section goes before the real AUTO region; a marker inside an example is not one, so it is appended after it.
      const marker = doc.lines.findIndex((line, index) => !doc.fenced[index] && line.trim() === AUTO_BEGIN);
      const at = marker <= 0 ? marker : doc.offset(marker) - 1;
      let next;
      if (at === 0) next = `${block}\n${text}`;
      else next = at === -1 ? `${text.replace(/\n*$/, '')}\n\n${block}` : `${text.slice(0, at).replace(/\n*$/, '')}\n\n${block}\n${text.slice(at)}`;
      // A heading that landed inside a fence, or twice, is not a section: stop before writing.
      if (scan(next).headings.filter((h) => h.text.trim() === title).length !== 1) return fail('create-unverified', title);
      text = next;
      continue;
    }
    const range = edit.section ? sectionRange(text, edit.section) : { ok: true, start: 0, end: text.length };
    if (!range.ok) return fail(range.reason, edit.section);
    const part = text.slice(range.start, range.end);
    let replaced;
    if (edit.content !== undefined) replaced = `\n${fill(edit.content).replace(/^\n*/, '').replace(/\n*$/, '\n')}\n`;
    else {
      const count = part.split(edit.find).length - 1;
      if (count !== 1) return fail(count ? 'anchor-duplicate' : 'anchor-missing', edit.find.slice(0, 80));
      replaced = part.replace(edit.find, () => fill(edit.replace));
    }
    const next = text.slice(0, range.start) + replaced + text.slice(range.end);
    if (next.slice(0, range.start) !== text.slice(0, range.start) || next.slice(range.start + replaced.length) !== text.slice(range.end)) return fail('outside-bytes-changed');
    text = next;
  }
  return { ok: true, body: text };
}

// GitHub and `gh --jq` may add or drop one trailing newline; nothing else counts as equal.
const sameBody = (a, b) => a === b || a === `${b}\n` || `${a}\n` === b;

/**
 * AC-9: read, plan, re-read for freshness, write, read back. The freshness read and the write are
 * sequential by construction. `gh.get()` returns { body, updated_at }; `gh.patch(body)` writes.
 */
export function runGuardedEdit({ edits, gh, now = () => new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', retries = 2, dryRun = false }) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const first = gh.get();
    const planned = applyEdits(first.body ?? '', edits, now());
    if (!planned.ok) return planned;
    if (planned.body === first.body) return { ok: true, status: 'unchanged', attempts: attempt + 1 };
    if (dryRun) return { ok: true, status: 'planned', attempts: attempt + 1, body: planned.body, before: first.body };
    const fresh = gh.get();
    if (fresh.updated_at !== first.updated_at || fresh.body !== first.body) continue;
    gh.patch(planned.body);
    const back = gh.get();
    if (!sameBody(back.body ?? '', planned.body)) return fail('readback-mismatch');
    return { ok: true, status: 'written', attempts: attempt + 1, body: planned.body };
  }
  return fail('drift', `the target kept changing across ${retries + 1} attempts`);
}

// ---------- AC-7, AC-10, AC-11: rendering ----------

const commit = (repo, value) => (value ? `[${String(value).slice(0, 7)}](https://github.com/${repo}/commit/${value})` : '❓');

function renderRun(run, lang) {
  const link = run.url ? t(lang, 'ci.link', { url: run.url }) : '';
  if (run.status !== 'completed') return t(lang, 'ci.running', { link });
  if (run.conclusion === 'success') return t(lang, 'ci.success', { link });
  if (run.conclusion === 'cancelled' && run.supersededBy) {
    const state = run.supersededBy.status === 'completed' ? run.supersededBy.conclusion : t(lang, 'ci.inProgress');
    return t(lang, 'ci.superseded', { link, state, url: run.supersededBy.url });
  }
  return run.conclusion === 'cancelled' ? t(lang, 'ci.cancelled', { link }) : t(lang, 'ci.failed', { conclusion: run.conclusion, link });
}

/** AC-10: the merge commit's workflow runs as observed at report time; path-filtered workflows may yield none. */
export function renderCi(runs, lang = 'en') {
  if (!runs?.length) return t(lang, 'ci.none');
  return runs.map((run) => `${run.workflowName ? `${run.workflowName} ` : ''}${renderRun(run, lang)}`).join(t(lang, 'semicolon'));
}

export const closeoutMarker = (pr, head) => `<!-- dev-merge:closeout pr=${pr} head=${head} -->`;

/** AC-7b: the existing closeout comment of this login for this PR, if any. */
export function closeoutTarget(comments, pr, login) {
  const mine = comments.filter((c) => (c.author?.login ?? c.author) === login && (c.body ?? '').split('\n')[0].startsWith(`<!-- dev-merge:closeout pr=${pr} `));
  if (mine.length > 1) return fail('ambiguous-closeout', mine.map((c) => c.id).join(','));
  if (!mine.length) return { ok: true, id: null };
  // The REST PATCH needs the numeric id; `gh pr view --json comments` gives a node id and the URL carries the number.
  const id = /^\d+$/.test(String(mine[0].id)) ? Number(mine[0].id) : Number(/#issuecomment-(\d+)$/.exec(mine[0].url ?? '')?.[1]) || null;
  return id ? { ok: true, id } : fail('closeout-id', `no numeric id for ${mine[0].id}`);
}

// A reason is a code from the helpers or free text the agent wrote in the comment's language.
const reasonText = (lang, reason) => (LOCALES[lang]?.[`reason.${reason}`] ?? LOCALES.en[`reason.${reason}`] ?? reason);
const kindText = (lang, kind) => (LOCALES.en[`kind.${kind}`] ? t(lang, `kind.${kind}`) : kind);

/** AC-7c: an outcome renders as done only when its exit code 0 was recorded. */
export function cleanupOutcome(item, lang = 'en') {
  if (item.exit === 0) return { mark: t(lang, 'outcome.done'), owner: false };
  if ((item.exit === undefined || item.exit === null) && item.reason) return { mark: t(lang, 'outcome.skipped', { reason: reasonText(lang, item.reason) }), owner: false };
  if (item.exit === undefined || item.exit === null) return { mark: t(lang, 'outcome.unknown'), owner: true };
  return { mark: item.exit === 'denied' ? t(lang, 'outcome.denied') : t(lang, 'outcome.failed', { exit: item.exit }), owner: true };
}

function cleanupSection(items, lang) {
  const rows = items.map((item) => `| 🧹 ${kindText(lang, item.kind)} | \`${item.target}\` | ${cleanupOutcome(item, lang).mark} |`);
  const owner = items.filter((item) => cleanupOutcome(item, lang).owner && item.command);
  const block = owner.length ? `\n\n${t(lang, 'cleanup.owner')}\n\n\`\`\`bash\n${owner.map((item) => item.command).join('\n')}\n\`\`\`` : '';
  return `${t(lang, 'cleanup.columns')}\n| --- | --- | --- |\n${rows.join('\n') || `| 🧹 ${t(lang, 'none')} | — | — |`}${block}`;
}

const list = (items, lang) => (items?.length ? items.map((item) => `- ${item}`).join('\n') : `- ${t(lang, 'none')}`);

/** A warning is a code object from `discover` or free text the agent wrote in the comment's language. */
export function warningText(warning, lang = 'en') {
  if (typeof warning === 'string') return warning;
  const issues = (warning.issues ?? []).map((n) => `#${n}`).join(t(lang, 'sep'));
  // A code no locale knows yet still has to render, so it stands for itself.
  return LOCALES.en[`warning.${warning.code}`] ? t(lang, `warning.${warning.code}`, { ...warning, issues }) : `⚠️ ${warning.code}`;
}

/** AC-7a: the closeout or handover comment in the PR body's language, built only from recorded outcomes. */
export function renderCloseout(input) {
  const { repo, pr, merge, gate: gated, mode } = input;
  const lang = input.lang ?? 'en';
  const reuse = gated.verdict === 'stop' ? t(lang, 'gate.stop', { reason: gated.reason })
    : LOCALES.en[`gate.${gated.reason}`] ? t(lang, `gate.${gated.reason}`) : gated.reason;
  const evidence = gated.evidence ? `[${t(lang, 'evidence.link')}](${gated.evidence.url ?? `https://github.com/${repo}/pull/${pr.number}`})` : t(lang, 'evidence.none');
  const parts = [
    closeoutMarker(pr.number, gated.head),
    t(lang, mode === 'handover' ? 'closeout.titleHandover' : 'closeout.title'),
    '',
    input.dryRun ? t(lang, 'closeout.dryRun', { pr: pr.number }) : t(lang, 'closeout.merged', { pr: pr.number, commit: commit(repo, merge.sha) }),
    '',
    t(lang, 'closeout.checks'),
    '',
    t(lang, 'closeout.columns'),
    '| --- | --- |',
    `| ${t(lang, 'closeout.head')} | ${commit(repo, gated.head)}${t(lang, 'comma')}${evidence} |`,
    `| ${t(lang, 'closeout.parent')} | ${commit(repo, merge.parent)}${t(lang, 'semicolon')}${reuse} |`,
    `| ${t(lang, 'closeout.result')} | ${input.dryRun ? t(lang, 'closeout.notMerged') : merge.verified ? t(lang, 'closeout.verified') : t(lang, 'closeout.mismatch')} |`,
    `| ${t(lang, 'closeout.ci')} | ${renderCi(input.ci, lang)} |`,
    '',
    t(lang, 'closeout.validation'),
    '',
    list(input.validation, lang),
  ];
  if (mode === 'handover') parts.push('', t(lang, 'closeout.handover'), '', list(input.handover, lang));
  parts.push('', t(lang, 'closeout.cleanup'), '', cleanupSection(input.cleanup ?? [], lang));
  if (input.warnings?.length) parts.push('', t(lang, 'closeout.warnings'), '', list(input.warnings.map((w) => warningText(w, lang).replace(/^⚠️\s*/, '')), lang));
  return `${parts.join('\n')}\n`;
}

/** AC-11: the terminal report in the user's language; delivery gaps and warnings come first. */
export function renderReport(input) {
  const lang = input.lang ?? 'en';
  const cleanup = input.cleanup ?? [];
  const gaps = [...(input.gaps ?? []), ...cleanup.filter((item) => cleanupOutcome(item, lang).owner).map((item) => t(lang, 'report.unfinished', { kind: kindText(lang, item.kind), target: item.target }))];
  const owner = cleanup.filter((item) => cleanupOutcome(item, lang).owner && item.command).map((item) => item.command);
  return [
    t(lang, 'report.gaps'),
    '',
    list([...gaps, ...(input.warnings ?? []).map((w) => warningText(w, lang))], lang),
    '',
    t(lang, 'report.merge'),
    '',
    t(lang, 'report.mergeLine', { commit: commit(input.repo, input.merge?.sha), ci: renderCi(input.ci, lang) }),
    '',
    t(lang, 'report.links'),
    '',
    list(input.links, lang),
    '',
    t(lang, 'report.owner'),
    '',
    owner.length ? `\`\`\`bash\n${owner.join('\n')}\n\`\`\`` : `- ${t(lang, 'none')}`,
    '',
    t(lang, 'report.next'),
    '',
    list(input.next, lang),
    '',
  ].join('\n');
}

// ---------- CLI ----------

function ghRunner(path) {
  const run = (args) => {
    const result = spawnSync('gh', args, { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`gh ${args.join(' ')} failed: ${result.stderr.trim()}`);
    return result.stdout;
  };
  return {
    get: () => { const data = JSON.parse(run(['api', path])); return { body: data.body ?? '', updated_at: data.updated_at }; },
    patch: (body) => {
      const file = `${process.env.TMPDIR ?? '/tmp'}/dev-merge-patch-${process.pid}.json`;
      writeFileSync(file, JSON.stringify({ body }));
      run(['api', '-X', 'PATCH', path, '--input', file]);
    },
  };
}

const COMMANDS = {
  args: (i) => { const parsed = parseArgs(i.text, i.repo); if (!parsed.ok) return parsed; const pr = resolvePr(parsed.args, i.branchPrs); return pr.ok ? { ok: true, args: { ...parsed.args, pr: pr.pr } } : pr; },
  // Exit 1 means stop, so collect and verify, which the procedure continues on, are successful exits.
  gate: (i) => { const g = gate(i); return { ok: g.verdict !== 'stop', ...g }; },
  'lint-body': (i) => lintSquashMessage(i),
  'verify-merge': (i) => verifyMerge(i),
  plan: (i) => ({ ok: true, ...planCleanup(i) }),
  discover: (i) => ({ ok: true, ...discoverTargets(i) }),
  'closeout-target': (i) => closeoutTarget(i.comments, i.pr, i.login),
  render: (i) => ({ ok: true, markdown: i.kind === 'report' ? renderReport(i) : renderCloseout(i) }),
  edit: (i) => {
    const path = i.comment ? `repos/${i.repo}/issues/comments/${i.comment}` : `repos/${i.repo}/issues/${i.issue}`;
    return runGuardedEdit({ edits: i.edits, gh: ghRunner(path), dryRun: Boolean(i.dryRun) });
  },
};

const invoked = () => {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
};
if (invoked()) {
  const [command, flag, file, outFlag, out] = process.argv.slice(2);
  if (!COMMANDS[command] || flag !== '--input' || !file || (outFlag && outFlag !== '--out')) {
    console.error(`Usage: node check-merge.mjs <${Object.keys(COMMANDS).join('|')}> --input FILE.json [--out FILE]`);
    process.exitCode = 2;
  } else {
    try {
      const result = COMMANDS[command](JSON.parse(readFileSync(file, 'utf8')));
      if (out && result.markdown !== undefined) writeFileSync(out, result.markdown);
      else if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
      // With --out the file holds the full result; print only a summary so large bodies stay out of the log.
      const summary = { ok: result.ok, out, ...['verdict', 'status', 'reason'].reduce((acc, k) => (result[k] ? { ...acc, [k]: result[k] } : acc), {}) };
      console.log(JSON.stringify(out ? summary : result));
      process.exitCode = result.ok ? 0 : 1;
    } catch (error) {
      console.error(`check-merge ${command}: ${error.message}`);
      process.exitCode = 2;
    }
  }
}
