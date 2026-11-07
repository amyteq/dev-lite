// Deterministic tests for the /dev-refine-story resolver. Plain Node; run with
// `node skills/dev-refine-story/scripts/resolve-story-issue.test.mjs` or `npm test` from the plugin root.
//
// Synthetic evidence: every issue is a fixture, no GitHub call is made and no issue is created.
// The cases prove the decision table, not that a model follows SKILL.md. The resolver and its
// documents name no real Story.
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveStoryIssue, matchesStoryKey, parseStoryKey, parseRunMarker, markerOf, normalizeState, issueNumber,
  canonicalStoryDocPath,
} from './resolve-story-issue.mjs';

let pass = 0;
let failed = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`FAIL - ${name}\n  ${e.message}`); process.exitCode = 1; }
};
const here = (p) => new URL(p, import.meta.url);

// ── Fixtures ────────────────────────────────────────────────────────────────
const REPO = 'example-org/example-repo';
const KEY = 'STY_112';
const DOC = 'docs/stories/STY_112_task_export.md';
const origin = (key = KEY, run = '2026-09-20T00-00-00Z') => `<!-- dev-refine-story:origin story=${key} run=${run} -->`;
const CAN_CREATE = { createAuthorized: true, effectivePermission: 'write' };
const NONE = { createIssue: 0, invokeRefineIssue: 0 };
const REUSE = { createIssue: 0, invokeRefineIssue: 1 };
const CREATE = { createIssue: 1, invokeRefineIssue: 1 };
const url = (n, repo = REPO) => `https://github.com/${repo}/issues/${n}`;

const story = (over = {}) => ({ key: KEY, docPaths: [DOC], lifecycleStatus: 'CURRENT', ...over });
// A row as the open-issue listing returns it.
const row = (number, over = {}) => ({ number, title: `Issue ${number}`, body: 'Unrelated.', state: 'OPEN', locked: false, url: url(number), ...over });
const marked = (number, over = {}) => row(number, { title: 'Task export', body: `${origin()}\nStory: ${KEY}`, authorPermission: 'write', ...over });
const input = (over = {}) => ({ storyKey: KEY, repo: REPO, story: story(), lookup: { complete: true }, candidates: [], authority: { createAuthorized: false }, ...over });
const can = (over = {}) => input({ authority: CAN_CREATE, ...over });
const without = (o, ...keys) => { const c = { ...o }; for (const k of keys) delete c[k]; return c; };

// ── Decision collector ──────────────────────────────────────────────────────
// Every decision is kept so the closing check covers all of them.
const decisions = [];
let sealed = false;
const resolve = (i) => {
  assert.ok(!sealed, 'a decision was produced after the closing check ran; it must stay the last check');
  const d = resolveStoryIssue(i);
  decisions.push(d);
  return d;
};

// Asserts the fields a case names; every stop is also checked for zero writes.
const expect = (d, e, label) => {
  const at = `${label}: ${d.reasonCode}`;
  if (e.code) assert.strictEqual(d.reasonCode, e.code, label);
  if (e.action) assert.strictEqual(d.action, e.action, at);
  if ('selected' in e) assert.strictEqual(d.selected, e.selected, at);
  if (e.duplicates) assert.deepStrictEqual(d.duplicates, e.duplicates, at);
  if (e.conflicts) assert.deepStrictEqual(d.conflicts, e.conflicts, at);
  if (e.writes) assert.deepStrictEqual(d.plannedWrites, e.writes, at);
  if (d.action === 'stop') assert.deepStrictEqual(d.plannedWrites, NONE, `${at}: a stop planned a write`);
  if (e.url) assert.strictEqual(d.issue.url, e.url, at);
  for (const s of e.reason ?? []) assert.ok(d.reason.includes(s), `${at}: reason lacks ${s}: ${d.reason}`);
  return d;
};
// A case table: each row is `[label, input, expected]`.
const cases = (title, rows) => check(title, () => { for (const [label, i, e] of rows) expect(resolve(i), e, label); });
const CREATED = { action: 'create', code: 'CREATE_AUTHORIZED', writes: CREATE };

// ── Identity: an open issue whose first line is the Story's marker ──────────
cases('one marker issue is reused, and none creates only with authority and write access', [
  ['no issue, authorized', can(), CREATED],
  ['no issue, not authorized', input(), { code: 'CREATE_NOT_AUTHORIZED', conflicts: [] }],
  ...['admin', 'maintain', 'write', ' Write '].map((p) => [`permission ${p}`, can({ authority: { createAuthorized: true, effectivePermission: p } }), CREATED]),
  ...['read', 'triage', 'none', '', null, undefined].map((p) => [`permission ${String(p)}`,
    can({ authority: { createAuthorized: true, effectivePermission: p } }), { code: 'INSUFFICIENT_PERMISSION' }]),
  ['authority "true" as a string', can({ authority: { createAuthorized: 'true', effectivePermission: 'write' } }), { code: 'CREATE_NOT_AUTHORIZED' }],
  ['one open marker issue', can({ candidates: [marked(10)] }), { action: 'reuse', code: 'REUSE_MARKED', selected: 10, duplicates: [], writes: REUSE, url: url(10) }],
  ['one open marker issue, not authorized to create', input({ candidates: [marked(10)] }), { code: 'REUSE_MARKED', selected: 10, writes: REUSE }],
  ['a marker line ending in \\r', can({ candidates: [marked(10, { body: `${origin()}\r\nStory` })] }), { code: 'REUSE_MARKED', selected: 10 }],
  ['a marker issue with no other body line', can({ candidates: [marked(10, { body: origin() })] }), { code: 'REUSE_MARKED', selected: 10 }],
]);

const permutations = (xs) => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
cases('several eligible marker issues stop for a human in any order', [
  ...permutations([10, 20, 30]).map((order) => [`order ${order}`, can({ candidates: order.map((n) => marked(n)) }),
    { action: 'stop', code: 'DUPLICATE_MARKERS', conflicts: [10, 20, 30], reason: ['#10, #20, #30'] }]),
  ['two, beside non-marker rows', can({ candidates: [row(5), marked(40), row(99), marked(7)] }), { code: 'DUPLICATE_MARKERS', conflicts: [7, 40] }],
  ['a locked older one still counts', can({ candidates: [marked(10, { locked: true }), marked(20)] }), { code: 'DUPLICATE_MARKERS', conflicts: [10, 20] }],
  ['a closed newer marker issue is not a duplicate', can({ candidates: [marked(10), marked(20, { state: 'CLOSED' })] }), { selected: 10, duplicates: [] }],
]);

cases('a marker copied by an author without write access is never selected', [
  ...['read', 'triage', 'none', null, ' Read '].map((p) => [`a newer copy by ${String(p)}`,
    can({ candidates: [marked(10), marked(20, { authorPermission: p })] }),
    { action: 'reuse', code: 'REUSE_MARKED', selected: 10, duplicates: [20], writes: REUSE, reason: ['#20'] }]),
  ['the only marker issue is a copy: create, reporting it', can({ candidates: [marked(20, { authorPermission: 'read' })] }),
    { ...CREATED, duplicates: [20], reason: ['#20'] }],
  ['the only marker issue is a copy, without authority', input({ candidates: [marked(20, { authorPermission: 'triage' })] }),
    { code: 'CREATE_NOT_AUTHORIZED' }],
  ['one eligible beside two copies', can({ candidates: [marked(30, { authorPermission: 'none' }), marked(5, { authorPermission: 'Admin' }), marked(9, { authorPermission: 'read' })] }),
    { selected: 5, duplicates: [9, 30] }],
]);

cases('an open marker issue without fetched provenance stops', [
  ...[undefined, 1, true, {}].map((p) => [`authorPermission ${JSON.stringify(p)}`,
    can({ candidates: [marked(10, { authorPermission: p })] }), { code: 'CANDIDATE_PROVENANCE_UNKNOWN', conflicts: [10] }]),
  ['a closed marker issue needs none', can({ candidates: [marked(10, { authorPermission: undefined, state: 'closed' })] }), CREATED],
  ['an unmarked row needs none', can({ candidates: [row(10)] }), CREATED],
]);

cases('a locked selected issue stops', [
  ['the only marker issue locked', can({ candidates: [marked(10, { locked: true })] }), { code: 'ISSUE_LOCKED', conflicts: [10] }],
  ['the eligible marker issue locked beside a copy', can({ candidates: [marked(10, { authorPermission: 'read' }), marked(20, { locked: true })] }), { code: 'ISSUE_LOCKED', conflicts: [20] }],
]);

const notTheStorys = [
  ['the key as a whole token in a title', row(10, { title: `${KEY} — Task export` })],
  ['the key in a body only', row(10, { body: `Covers ${KEY} among other Stories.` })],
  ['the Story document path in a body', row(10, { body: `See ${DOC}.` })],
  ['the marker on a later body line', row(10, { body: `Notes\n${origin()}` })],
  ['a first-line marker for a longer key', row(10, { body: `${origin('STY_1120')}\nStory: STY_1120` })],
  ['a first-line marker for another key that mentions this one', row(10, { body: `${origin('STY_113')}\nPart of ${KEY}.` })],
  ['a closed issue carrying the marker', marked(10, { state: 'closed' })],
  ['a closed locked issue carrying the marker', marked(10, { state: 'CLOSED', locked: true })],
  ['a feat tracking issue whose body lists the Story', row(10, { title: 'FT_101 — Reports', body: `| ${KEY} | batch 1 |` })],
  ['a lower-case marker for a longer key', row(10, { body: origin('sty_1120') })],
];
cases('only an open issue with the first-line marker is the Story\'s', [
  ...notTheStorys.map(([label, r]) => [`${label}, alone`, can({ candidates: [r] }), CREATED]),
  ...notTheStorys.map(([label, r]) => [`${label}, beside a marker issue`, can({ candidates: [r, marked(20)] }), { code: 'REUSE_MARKED', selected: 20, duplicates: [] }]),
]);

cases('a near-miss marker for this Story stops', [
  ...[
    ['a bad run token', `<!-- dev-refine-story:origin story=${KEY} run=x -->`],
    ['a missing close', `<!-- dev-refine-story:origin story=${KEY} run=2026-09-20T00-00-00Z`],
    ['text after the close', `${origin()} extra`],
    ['mixed separators', `<!-- dev-refine-story:origin story=${KEY} run=2026-09-20T00:00-00Z -->`],
    ['an out-of-range month', `<!-- dev-refine-story:origin story=${KEY} run=2026-13-20T00-00-00Z -->`],
    ['a day the calendar does not have', `<!-- dev-refine-story:origin story=${KEY} run=2026-02-31T00-00-00Z -->`],
    ['no run token', `<!-- dev-refine-story:origin story=${KEY} -->`],
  ].map(([label, line]) => [label, can({ candidates: [row(10, { body: `${line}\nStory` }), marked(20)] }), { code: 'MARKER_UNREADABLE', conflicts: [10] }]),
  ['a near miss on a closed issue is ignored', can({ candidates: [row(10, { body: `<!-- dev-refine-story:origin story=${KEY} run=x -->`, state: 'closed' })] }), CREATED],
  ['a near miss for a longer key is not this Story\'s', can({ candidates: [row(10, { body: '<!-- dev-refine-story:origin story=STY_1120 run=x -->' })] }), CREATED],
]);

check('the run marker parses in both timestamp spellings, for this Story only', () => {
  for (const run of ['2026-09-21T21:10:50Z', '2026-09-21T21-10-50Z', '2026-09-21T21-10-50.123Z', '2028-02-29T00-00-00Z']) {
    assert.deepStrictEqual(parseRunMarker(origin(KEY, run), KEY), { marker: origin(KEY, run), key: KEY, run });
    assert.strictEqual(markerOf(`${origin(KEY, run)}\nbody`, KEY), 'marked');
  }
  for (const run of ['2026-09-21T21:10-50Z', '2026-09-21T24-00-00Z', '2026-02-31T00-00-00Z', '2027-02-29T00-00-00Z', '2026-09-21', 'x']) assert.strictEqual(parseRunMarker(origin(KEY, run), KEY), null, run);
  assert.strictEqual(parseRunMarker(origin('STY_1120'), KEY), null);
  assert.strictEqual(markerOf(null, KEY), null);
  assert.strictEqual(markerOf('', KEY), null);
});

check('the Story key matches only as a whole token', () => {
  for (const t of [KEY, `${KEY},`, `${KEY}.`, `${KEY}'s`, `(${KEY})`, 'sty_112', `see ${KEY}: done`]) assert.ok(matchesStoryKey(t, KEY), t);
  // The Story document's own file name never matches, so a path mention is not the key.
  for (const t of ['STY_1120', 'STY_11200', 'STY_112abc', 'STY_112-alt', 'STY_112_alt', 'PRE-STY_112', 'XSTY_112', DOC, '', null]) assert.ok(!matchesStoryKey(t, KEY), String(t));
  assert.ok(matchesStoryKey('STY_101', 'STY_101') && !matchesStoryKey('STY_1010 reports', 'STY_101'), 'a key and its longer sibling');
});

// ── The lookup and its rows fail closed ─────────────────────────────────────
cases('an incomplete lookup or unusable candidate set stops', [
  ['lookup incomplete', can({ lookup: { complete: false }, candidates: [marked(10)] }), { code: 'LOOKUP_INCOMPLETE', conflicts: [] }],
  ['lookup "true" as a string', can({ lookup: { complete: 'true' } }), { code: 'LOOKUP_INCOMPLETE' }],
  ['lookup absent', can({ lookup: undefined }), { code: 'LOOKUP_INCOMPLETE' }],
  ['candidates absent', without(can(), 'candidates'), { code: 'MALFORMED_CANDIDATE_SET' }],
  ...[null, {}, { items: [] }, 'none', 3].map((v) => [`candidates ${JSON.stringify(v)}`, can({ candidates: v }), { code: 'MALFORMED_CANDIDATE_SET' }]),
  ['candidates [] from a complete lookup', can({ candidates: [] }), CREATED],
]);

const BIG = 2 ** 53;
cases('an untrustworthy row stops rather than being dropped', [
  ...[null, 'row', 7, [marked(10)]].map((r) => [`row ${JSON.stringify(r)?.slice(0, 20)}`, can({ candidates: [r, marked(20)] }), { code: 'MALFORMED_CANDIDATE', conflicts: [] }]),
  ...[0, -1, 1.5, BIG, '10', null].map((n) => [`number ${String(n)}`, can({ candidates: [marked(20), { ...marked(20), number: n }] }), { code: 'MALFORMED_CANDIDATE', conflicts: [] }]),
  ['one number on two rows', can({ candidates: [marked(10), row(10)] }), { code: 'MALFORMED_CANDIDATE', conflicts: [10] }],
  ...[
    ['no url', undefined],
    ['a pull request url', `https://github.com/${REPO}/pull/10`],
    ['another repository', url(10, 'someone/else')],
    ['an api url', `https://api.github.com/repos/${REPO}/issues/10`],
    ['another number', url(11)],
    ['prose', 'issue ten'],
    ['http rather than https', `http://github.com/${REPO}/issues/10`],
    ['a path suffix', `${url(10)}/extra`],
    ['a query suffix', `${url(10)}?x=1`],
    ['a fragment suffix', `${url(10)}#top`],
  ].map(([label, u]) => [`url: ${label}`, can({ candidates: [marked(10, { url: u }), marked(20)] }), { code: 'MALFORMED_CANDIDATE', conflicts: [10] }]),
  ['a url in upper case', can({ candidates: [marked(10, { url: url(10).toUpperCase().replace('HTTPS', 'https') })] }), { code: 'REUSE_MARKED', selected: 10 }],
  ['body not fetched', can({ candidates: [without(row(10), 'body'), marked(20)] }), { code: 'CANDIDATE_IDENTITY_UNREADABLE', conflicts: [10] }],
  ['body not a string', can({ candidates: [row(10, { body: { text: 'x' } })] }), { code: 'CANDIDATE_IDENTITY_UNREADABLE', conflicts: [10] }],
  ['body null is a fetched empty body', can({ candidates: [row(10, { body: null })] }), CREATED],
  ...[undefined, 'merged', '', 1].map((s) => [`state ${JSON.stringify(s)}`, can({ candidates: [row(10, { state: s }), marked(20)] }), { code: 'CANDIDATE_STATE_UNKNOWN', conflicts: [10] }]),
  ...[undefined, null, 'false', 0].map((l) => [`locked ${JSON.stringify(l)}`, can({ candidates: [row(10, { locked: l }), marked(20)] }), { code: 'CANDIDATE_LOCK_UNKNOWN', conflicts: [10] }]),
  ['every row a gate catches is named', can({ candidates: [without(row(10), 'body'), without(row(11), 'body'), marked(20)] }), { code: 'CANDIDATE_IDENTITY_UNREADABLE', conflicts: [10, 11] }],
]);

check('states normalise across casings', () => {
  for (const s of ['open', 'OPEN', ' Open ']) assert.strictEqual(normalizeState(s), 'open');
  for (const s of ['closed', 'CLOSED']) assert.strictEqual(normalizeState(s), 'closed');
  for (const s of ['merged', '', null, 1]) assert.strictEqual(normalizeState(s), null);
});

check('issue IDs are positive safe integers', () => {
  for (const v of [1, 10, BIG - 1]) assert.strictEqual(issueNumber(v), v);
  for (const v of [0, -1, 1.5, BIG, '10', '#10', null, Infinity]) assert.strictEqual(issueNumber(v), null, String(v));
});

// ── The Story gates ─────────────────────────────────────────────────────────
cases('a malformed key or target stops first', [
  ...['STY_0', 'STY_0112', 'sty_112x', '112', '', null, 'STY_112 STY_113', 'STY-112', 'FT_0', 'FT_112x'].map((k) => [`key ${JSON.stringify(k)}`, can({ storyKey: k, candidates: [marked(10)] }), { code: 'MALFORMED_KEY', conflicts: [] }]),
  ...['FT_101', ' ft_101 '].map((k) => [`feat key ${JSON.stringify(k)}`, can({ storyKey: k, candidates: [marked(10)] }), { code: 'FEAT_KEY_NOT_STORY', conflicts: [], reason: ['FT_101'] }]),
  ...[undefined, 'repo', 'a/b/c', 'a b/c'].map((r) => [`repo ${JSON.stringify(r)}`, can({ repo: r }), { code: 'MALFORMED_INPUT' }]),
  ['a lower-case key is read as the key', can({ storyKey: ' sty_112 ', candidates: [marked(10)] }), { code: 'REUSE_MARKED', selected: 10 }],
]);

cases('a missing, mismatched, incomplete or terminal Story stops', [
  ['unknown Story', can({ story: null }), { code: 'STORY_NOT_FOUND' }],
  ['two documents', can({ story: story({ docPaths: [DOC, 'docs/stories/STY_112_duplicate.md'] }) }), { code: 'STORY_AMBIGUOUS' }],
  ['another Story\'s key', can({ story: story({ key: 'STY_113' }) }), { code: 'STORY_KEY_MISMATCH' }],
  ['a non-string key', can({ story: story({ key: 112 }) }), { code: 'STORY_KEY_MISMATCH' }],
  ...['key', 'docPaths', 'lifecycleStatus'].map((f) => [`${f} absent`, can({ story: without(story(), f) }), { code: 'STORY_ENVELOPE_INCOMPLETE' }]),
  ...[[], [''], [7]].map((p) => [`docPaths ${JSON.stringify(p)}`, can({ story: story({ docPaths: p }) }), { code: 'STORY_ENVELOPE_INCOMPLETE' }]),
  ['lifecycle unrecognised', can({ story: story({ lifecycleStatus: 'ACTIVE' }) }), { code: 'STORY_ENVELOPE_INCOMPLETE' }],
  ['lifecycle in lower case', can({ story: story({ lifecycleStatus: 'current' }) }), CREATED],
  ['SUPERSEDED', can({ story: story({ lifecycleStatus: 'SUPERSEDED', supersededBy: 'STY_113' }), candidates: [marked(10)] }), { code: 'STORY_TERMINAL', reason: ['STY_113'] }],
  ['RETIRED', can({ story: story({ lifecycleStatus: 'RETIRED' }), candidates: [marked(10)] }), { code: 'STORY_TERMINAL' }],
  ['a Story gate runs before an incomplete lookup', can({ story: null, lookup: { complete: false } }), { code: 'STORY_NOT_FOUND' }],
]);

check('only the Story document path is accepted', () => {
  for (const p of ['docs/stories/STY_1120_task_export.md', 'docs/stories/sty_112_task_export.md', 'docs/stories/STY_112_Task.md',
    'docs/stories/STY_112.md', 'docs/feats/STY_112_task_export.md', 'STY_112_task_export.md', 'docs/stories/STY_112_task_export.md.bak']) {
    assert.strictEqual(canonicalStoryDocPath(p, 112), null, p);
    expect(resolve(can({ story: story({ docPaths: [p] }) })), { code: 'STORY_ENVELOPE_INCOMPLETE' }, p);
  }
  // A slug may end in any word, `review` included.
  for (const [p, n] of [[DOC, 112], ['docs/stories/STY_101_a.md', 101], ['docs/stories/STY_105_pr_review.md', 105], ['docs/stories/STY_1001_two_word_slug_2.md', 1001]]) {
    assert.strictEqual(canonicalStoryDocPath(p, n), p);
    expect(resolve(can({ storyKey: `STY_${n}`, story: story({ key: `STY_${n}`, docPaths: [p] }) })), CREATED, p);
  }
});

check('no decision reads or reports readiness', () => {
  for (const i of [can(), can({ candidates: [marked(10)] }), can({ story: story({ readiness: 'ready' }), candidates: [marked(10)] })]) {
    assert.ok(!('readiness' in resolve(i)));
  }
});

check('a repeated invocation selects the same issue and creates nothing', () => {
  const i = can({ candidates: [row(5), marked(10, { authorPermission: 'read' }), marked(20)] });
  const first = resolve(i);
  for (let k = 0; k < 3; k++) assert.deepStrictEqual(resolve(structuredClone(i)), first);
  assert.strictEqual(first.selected, 20);
  assert.deepStrictEqual(first.plannedWrites, REUSE);
});

// ── Inputs the resolver does not read change nothing ────────────────────────
check('unknown keys such as featIssues, attestation and receipt are not read', () => {
  const bases = [can(), input(), can({ candidates: [marked(10), marked(20)] }), can({ candidates: [row(10, { title: `${KEY} — x` })] }), can({ lookup: { complete: false } })];
  const noise = [
    { story: { canonicalIssues: [10], featIssues: [5] } },
    { story: { canonicalIssues: null, featIssues: 'x' } },
    { attestation: { storyIssue: 10, notStoryIssues: [20] } },
    { attestation: 'unusable' },
    { receipt: { runMarker: origin(), createAttempts: 2, confirmedIssue: 99 } },
    { receipt: null },
  ];
  for (const base of bases) {
    const expected = resolve(base);
    for (const n of noise) {
      const noisy = { ...base, ...n, story: n.story ? { ...base.story, ...n.story } : base.story };
      assert.deepStrictEqual(resolve(noisy), expected, JSON.stringify(n));
    }
  }
});

// The plugin cache or a linked skill directory may reach the CLI through a symlink.
check('the CLI runs its checks directly and through a symlink', () => {
  const real = fileURLToPath(here('./resolve-story-issue.mjs'));
  const dir = mkdtempSync(join(tmpdir(), 'refine-story-'));
  try {
    const link = join(dir, 'resolve-story-issue.mjs');
    symlinkSync(real, link);
    for (const entry of [real, link]) {
      const r = spawnSync(process.execPath, [entry, '-'], { input: '{}', encoding: 'utf8' });
      assert.strictEqual(r.status, 3, `${entry}: exit ${r.status} ${r.stderr}`);
      assert.strictEqual(JSON.parse(r.stdout).reasonCode, 'MALFORMED_INPUT', entry);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Documents stay generic and match the resolver ───────────────────────────
check('the resolver and skill documents name no real Story', () => {
  for (const f of ['./resolve-story-issue.mjs', '../SKILL.md', '../references/resolver-contract.md', '../references/scenarios.md']) {
    const hits = readFileSync(here(f), 'utf8').split('\n').filter((l) => /STY_[0-9]/.test(l));
    assert.deepStrictEqual(hits, [], `${f} names a Story key`);
  }
});

// Every run artifact belongs in the per-run scratch directory; a path relative to the
// checkout would make a documented command write into the repository.
check('SKILL.md keeps run artifacts in the scratch directory', () => {
  const skill = readFileSync(here('../SKILL.md'), 'utf8');
  assert.ok(skill.includes('WORK=$(mktemp -d)'), 'SKILL.md sets up no per-run scratch directory');
  for (const artifact of ['open-issues.json', 'lookup.json', 'decision-input.json', 'refine-story-receipt.json', 'refine-story-body.md']) {
    const uses = skill.split(/\s+/).filter((t) => t.includes(artifact));
    assert.ok(uses.length > 0, `SKILL.md names no ${artifact}`);
    for (const u of uses) assert.ok(u.slice(0, u.indexOf(artifact)).endsWith('$WORK/'), `${u} is outside the scratch directory`);
  }
});

// An issue created without its marker is not the Story's, and the skill never adds a marker to an
// existing issue, so Step 4 must stop before such a create and after a readback that shows one.
check('SKILL.md Step 4 checks before the create call and stops on a marker-less readback', () => {
  const step4 = readFileSync(here('../SKILL.md'), 'utf8').split('## Step 4')[1]?.split('## Step 5')[0] ?? '';
  const gate = step4.indexOf('**Check both files before the create call.**');
  const create = step4.indexOf('**Create the issue once**');
  assert.ok(gate >= 0 && create > gate, 'Step 4 has no check before the create call');
  for (const part of ['createAttempts === 1', 'markerOf(r.runMarker', 'split("\\n")[0] === r.runMarker', 'no create call']) {
    assert.ok(step4.slice(gate, create).includes(part), `Step 4's pre-create check omits ${part}`);
  }
  const stop = step4.indexOf('**Otherwise stop:**', step4.indexOf('**Read the identity back**'));
  assert.ok(stop > create, 'Step 4 names no stop for a readback without the marker');
  const outcome = step4.slice(stop, step4.indexOf('\n\n', stop));
  for (const part of ['`confirmedIssue` stays `null`', 'add no marker', 'no second create call', 'do not hand off']) {
    assert.ok(outcome.includes(part), `the readback stop omits "${part}"`);
  }
});

// ── Whole-suite invariants: keep this the last check ────────────────────────
check('every decision keeps its write budget, and the contract lists exactly the codes produced', () => {
  sealed = true;
  const WRITES = { stop: NONE, reuse: REUSE, create: CREATE };
  for (const d of decisions) {
    assert.deepStrictEqual(d.plannedWrites, WRITES[d.action], `${d.reasonCode}: ${d.action}`);
    assert.strictEqual(new Set(d.duplicates).size, d.duplicates.length, `${d.reasonCode}: a duplicate named twice`);
    assert.strictEqual(new Set(d.conflicts).size, d.conflicts.length, `${d.reasonCode}: a conflict named twice`);
    if (d.action === 'reuse') {
      assert.ok(!d.duplicates.includes(d.selected), `${d.reasonCode}: the selected issue is its own duplicate`);
      assert.strictEqual(d.issue.number, d.selected);
    } else {
      assert.strictEqual(d.selected, null);
      if (d.action === 'stop') assert.deepStrictEqual(d.duplicates, []);
    }
  }
  const table = readFileSync(here('../references/resolver-contract.md'), 'utf8').split('## Reason codes')[1] ?? '';
  const listed = new Set([...table.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]));
  assert.deepStrictEqual([...new Set(decisions.map((d) => d.reasonCode))].sort(), [...listed].sort());
});

console.log(`\n${pass} passed, ${failed} failed, ${decisions.length} decisions checked`);
