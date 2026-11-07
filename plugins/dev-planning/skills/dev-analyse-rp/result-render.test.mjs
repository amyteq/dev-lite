// Tests for the dev-analyse-rp result renderer.
// Plain Node; run with `node skills/dev-analyse-rp/result-render.test.mjs` or `npm test` from the plugin root.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkProposal } from './check-proposal.mjs';
import { MANIFEST, packetManifest, sha256 } from './result-packet.mjs';
import { joinParts, readPacket, render } from './result-render.mjs';
import { checkOutgoing, MAX_PART, resultMarkerFor } from './summary-comment.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'result-render.mjs');
const FIXTURE = path.join(HERE, 'fixtures/result-proposal.json');
const BASE = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { console.error(`FAIL - ${name}\n  ${e.message}`); process.exitCode = 1; }
};
// Every temp path is removed on exit, pass or fail, so runs do not exhaust a shared tmpfs.
const temps = [];
const temp = (p) => { temps.push(p); return p; };
process.on('exit', () => { for (const p of temps) fs.rmSync(p, { recursive: true, force: true }); });
const node = (...args) => spawnSync(process.execPath, args, { encoding: 'utf8' });

const REPO = BASE.baseline.repo;
const SHA = BASE.baseline.commit;
const DIGEST = BASE.baseline.planning_index.digest;
const ISSUE = 18;
const FEAT = 'FT_104';
const RUN = '20261018T030000Z-8cdfb6bf';
const EARLIER = '20261017T080000Z-8cdfb6bf';
const FOOTER = `🧭 claude·claude-opus-5-5·high · [${SHA.slice(0, 8)}](https://github.com/${REPO}/commit/${SHA}) · 2026-10-18 03:00 UTC · 0:42`;
const STILL = { action: 'proceed', baseline: SHA, head: SHA, changed: 0, overlap: [], digest: { baseline: DIGEST, head: DIGEST }, digestChanged: false };
const crosswalkOf = (p) => ['SRC-1', 'SRC-2', 'SRC-3'].map((source_id, i) => ({ index_digest: p.baseline.planning_index.digest, source_id,
  relation: i < 2 ? 'new' : 'reuse', key: 'FT_101', level: 'feat', evidence: `fixture row ${i + 1}`, dependents: [], candidates: [] }));

/** A packet root as the procedure leaves it before rendering; each option overrides one file. */
function packet({ proposal = BASE, crosswalk, drift = STILL, context = {}, prose = {} } = {}) {
  const root = temp(fs.mkdtempSync(path.join(os.tmpdir(), 'result-render-')));
  const write = (name, value) => fs.writeFileSync(path.join(root, name), typeof value === 'string' ? value : JSON.stringify(value));
  const stopped = proposal.verdict.state === 'analysis_stopped';
  write('proposal.json', proposal);
  if (!stopped) {
    write('crosswalk.jsonl', `${(crosswalk ?? crosswalkOf(proposal)).map((r) => JSON.stringify(r)).join('\n')}\n`);
    write('check.json', checkProposal(proposal));
  }
  write(MANIFEST, packetManifest({ root, run: RUN, baseline: proposal.baseline.commit, verdict: proposal.verdict.state }).text);
  if (!stopped) write('drift.json', drift);
  write('context.json', { repo: REPO, issue: ISSUE, feat: FEAT, run: RUN, root: `temp/dev-analyse-rp/${RUN}/`, previous: null, part1: null,
    footer: FOOTER, verifyHomes: stopped ? null : 0, ...context });
  write('prose.json', { summary: 'Blocked on D-1, the activation-gate question.', findings: [{ class: 'verified', text: 'No src/notifications/prefs package exists at the baseline.' },
    { class: 'assumption', text: 'Three notification channels will consume the snapshot.' }], changed: null, not_done: ['No skeleton code was written.'], stop: null, ...prose });
  return root;
}
const rendered = (options) => render(readPacket(packet(options)));
const cli = (root) => node(SCRIPT, 'render', '--root', root);
const stopOf = (options) => {
  const r = cli(packet(options));
  assert.strictEqual(r.status, 1, r.stderr);
  return JSON.parse(r.stdout);
};
const usageOf = (options) => {
  const r = cli(packet(options));
  assert.strictEqual(r.status, 2, r.stdout);
  return r.stderr;
};
const withUnits = (n, size) => ({ ...BASE, units: Array.from({ length: n }, (_, i) => ({ ...BASE.units[0], id: `U-${i + 10}`, acceptance: [`${'a'.repeat(size)} ${i}`] })) });
const outgoing = (body, i, m) => checkOutgoing({ body, repo: REPO, issue: ISSUE, run: RUN, baseline: SHA, feat: FEAT, part: { i, m } });

// --- AC4 the result body ----------------------------------------------------------

check('AC4.1 sections in order, AC5.1 one part; AC4.2 the same packet renders byte for byte the same', () => {
  const root = packet();
  const [a, b] = [render(readPacket(root)), render(readPacket(root))];
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.parts.length, 1);
  const body = a.parts[0];
  const order = [resultMarkerFor({ repo: REPO, issue: ISSUE, feat: FEAT, run: RUN, part: 1, parts: 1 }), '## `/dev-analyse-rp` result: `FT_104` on #18',
    '**Previous result:** none; this is the first result on this issue.', '### Verdict', '**Next human action:**', '### Decisions and units without an owner',
    '### Key findings', '### Existing-home crosswalk', '### Story Map and units', '### Dependencies', '### Proposed amendments and divergences',
    '### Independent review', '### Deterministic checks', '### Baseline delta', '### Evidence limits', '### Not done', '---', FOOTER];
  const at = order.map((line) => body.split('\n').findIndex((row) => row.startsWith(line)));
  assert.ok(at.every((n, i) => n >= 0 && (i === 0 || n > at[i - 1])), JSON.stringify(at));
  assert.strictEqual(body.trimEnd().split('\n').at(-1), FOOTER);
});

check('AC4.2 tables, counts and identifiers come from the packet files', () => {
  const root = packet();
  const body = render(readPacket(root)).parts[0];
  assert.ok(body.includes(`| Packet | \`sha256:${sha256(fs.readFileSync(path.join(root, MANIFEST)))}\` in \`temp/dev-analyse-rp/${RUN}/\``));
  assert.ok(body.includes(`| Planning index | \`${DIGEST}\` (feat 1 · story 0) |`));
  assert.ok(body.includes('| `D-1` | `needed` | unassigned | `U-1`, `U-2`, `U-3` |'));
  assert.ok(body.includes('**Units without an owner:** `U-3` ('));
  assert.ok(body.includes('**Rows per relation:** reuse 1 · extend 0 · amend 0 · supersede 0 · new 2 · none 0, over 3 rows.'));
  assert.ok(body.includes('**Critical path:** `U-1` → `U-2` → `U-3`'));
  assert.ok(body.includes('**Coverage:** 3 of 4 sources included · owned 2 · existing 0 · deferred 0 · blocked 1'));
  assert.ok(body.includes('| `node check-proposal.mjs proposal.json --json` | 0 |'));
  assert.ok(body.includes('**rounds:** 2') && body.includes('**Fixes not re-reviewed:** U-2 rollback reworded after round 2'));
  assert.ok(body.includes('| FT_101 | Record the notification-preferences runway under FT_101, reviewed by `@example-owner`. | proposed, not enacted |'));
  assert.ok(body.includes('- **verified:** No src/notifications/prefs package') && body.includes('- **assumption:** Three notification'));
  const blocked = { ...crosswalkOf(BASE)[0], source_id: 'SRC-3', relation: null, key: null, level: null };
  assert.ok(rendered({ crosswalk: [...crosswalkOf(BASE).slice(0, 2), blocked] }).parts[0].includes('new 2 · none 1, over 3 rows.'), 'a blocked row has no relation');
});

check('AC4.3.1 an absent optional field says none recorded, or unknown for the rounds', () => {
  const { amendments, divergences, ...rest } = BASE;
  const { rounds, unreviewed_fixes: fixes, ...review } = BASE.review;
  const body = rendered({ proposal: { ...rest, review } }).parts[0];
  for (const text of ['**Amendments:** none recorded.', '**Intentional divergences:** none recorded.', '**rounds:** unknown', '**Fixes not re-reviewed:** none recorded']) {
    assert.ok(body.includes(text), text);
  }
});

check('AC4.3.2 a mistyped optional field exits 2 and names it', () => {
  for (const [patch, field] of [[{ amendments: {} }, 'proposal.json.amendments'], [{ divergences: [{ subject: 's', statement: 's' }] }, 'proposal.json.divergences[0].reason'],
    [{ review: { ...BASE.review, rounds: '2' } }, 'proposal.json.review.rounds'], [{ review: { ...BASE.review, unreviewed_fixes: [1] } }, 'proposal.json.review.unreviewed_fixes']]) {
    assert.match(usageOf({ proposal: { ...BASE, ...patch } }), new RegExp(field.replace(/[.[\]]/g, '\\$&')));
  }
});

check('AC4.3.3 check-proposal.mjs is unchanged and still exits 0 on the fixture with all four fields', () => {
  const r = node(path.join(HERE, 'check-proposal.mjs'), FIXTURE);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.ok(['amendments', 'divergences'].every((k) => Array.isArray(BASE[k])) && BASE.review.rounds === 2 && BASE.review.unreviewed_fixes.length === 1);
});

check('AC4.4 every handle is in a code span, and the footer must give its start in UTC', () => {
  const body = rendered().parts[0].split('\n').slice(1).join('\n').replace(/`[^`]*`/g, '');
  assert.doesNotMatch(body, /(^|[^\w])@[A-Za-z0-9]/m);
  assert.match(usageOf({ context: { footer: FOOTER.replace('03:00 UTC', '11:00 AWST') } }), /context\.json\.footer/);
});

check('AC4.5 an absolute or home path in the packet stops the render, under any root, drive or share, whatever precedes it', () => {
  for (const sample of ['Read /home/analyst/notes.md only.', 'Read /opt/private/evidence.md only.', 'Read /workspace/repo/note.md only.',
    'Read /secret only.', 'Read /etc only.', 'Read /dev-analyse-rp/notes.md only.',
    'Read ~/notes.md only.', 'Read C:\\Users\\analyst\\note.md only.', 'Read C:/Users/analyst/note.md only.', 'Read \\\\server\\share\\note.md only.',
    // No delimiter before the path: prose punctuation, markup and markdown link syntax all carry one.
    'Read:/secret only.', 'path=/secret', 'Read </secret> only.', 'x|/secret', 'See [the notes](/home/analyst/notes.md).',
    'Kept at,~/notes.md today.', 'run=C:\\secret', 'share=\\\\server\\private']) {
    const r = stopOf({ proposal: { ...BASE, verdict: { ...BASE.verdict, evidence_limits: sample } } });
    assert.strictEqual(r.reason, 'absolute-path', sample);
  }
});

check('AC4.5 the guard passes the skill name, links, globs, placeholders, repository-relative paths and the cited root', () => {
  // Every rendered body also carries the renderer's own `<details>`, `<summary>` and `<code>` tags.
  const kept = 'Checked /dev-analyse-rp against docs/notes/a.md, src/**/*.ts and <api_domain>/v1/x, https://github.com/x/y/pull/1, part=1/3, and/or a / b.';
  const body = rendered({ proposal: { ...BASE, verdict: { ...BASE.verdict, evidence_limits: kept } } }).parts[0];
  assert.ok(body.includes(kept) && body.includes(`\`temp/dev-analyse-rp/${RUN}/\``));
  assert.strictEqual(JSON.parse(cli(packet({ context: { root: `$DEV_ANALYSE_RP_ROOT/${RUN}/` } })).stdout).action, 'proceed');
});

check('AC4 the sample body passes outgoing and the publication check', () => {
  const root = packet();
  const r = cli(root);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout).files, ['result.1.md']);
  const body = path.join(root, 'result.1.md');
  const out = node(path.join(HERE, 'summary-comment.mjs'), 'outgoing', '--body', body, '--repo', REPO, '--issue', String(ISSUE), '--run', RUN, '--baseline', SHA, '--feat', FEAT, '--part', '1/1');
  assert.strictEqual(out.status, 0, out.stdout);
  const publication = node(path.join(HERE, '../../scripts/check-publication.mjs'), '--body-file', body);
  assert.strictEqual(publication.status, 0, publication.stdout + publication.stderr);
});

check('AC3.3 a packet file that no longer matches the manifest stops the render, naming the file', () => {
  const root = packet();
  const crosswalk = path.join(root, 'crosswalk.jsonl');
  fs.writeFileSync(crosswalk, fs.readFileSync(crosswalk, 'utf8').replace('fixture row 1', 'fixture row 7'));
  const changed = cli(root);
  assert.strictEqual(changed.status, 2, changed.stdout);
  assert.match(changed.stderr, /crosswalk\.jsonl no longer matches packet\.manifest\.json/);
  const again = packet();
  fs.rmSync(path.join(again, 'check.json'));
  assert.strictEqual(cli(again).status, 2);
  assert.match(cli(again).stderr, /cannot read check\.json/);
  // A proposal corrected after the verdict cannot render against the check, crosswalk and drift
  // the verdict derived, because the manifest it must still match is the verdict's.
  const corrected = packet();
  fs.writeFileSync(path.join(corrected, 'proposal.json'), JSON.stringify({ ...BASE, units: [] }));
  assert.match(cli(corrected).stderr, /proposal\.json no longer matches packet\.manifest\.json/);
  const stable = packet();
  assert.strictEqual(cli(stable).status, 0);
  assert.strictEqual(cli(stable).status, 0, 'a later step writing into the root does not disturb the render');
});

// --- AC5 parts and size -------------------------------------------------------------

check('AC5.2, AC5.6 and AC5.7 a long result splits between blocks, links part 1, joins back, and signs only the last part', () => {
  const options = { proposal: withUnits(12, 9000) };
  const { full, parts } = rendered(options);
  assert.ok(parts.length >= 2 && parts.length <= 5, String(parts.length));
  parts.forEach((t, k) => {
    assert.ok(t.length <= MAX_PART, `part ${k + 1} is ${t.length}`);
    assert.deepStrictEqual(outgoing(t, k + 1, parts.length), { action: 'proceed', violations: [] }, `part ${k + 1}`);
    if (k) assert.strictEqual(t.split('\n')[1], `Part ${k + 1} of ${parts.length}, continued from [part 1](https://github.com/${REPO}/issues/${ISSUE}#issuecomment-PART-1).`);
  });
  for (const text of ['## `/dev-analyse-rp` result', '### Verdict', '**Next human action:**', '### Decisions and units without an owner']) assert.ok(parts[0].includes(text), text);
  assert.strictEqual(joinParts(parts), full);
  const linked = rendered({ ...options, context: { part1: 6250000001 } });
  assert.strictEqual(linked.parts[0], parts[0]);
  assert.ok(linked.parts[1].split('\n')[1].endsWith('#issuecomment-6250000001).'));
  assert.strictEqual(joinParts(linked.parts), full);
});

check('AC5.3 a table too long for one part splits between rows and repeats its header row', () => {
  const rows = Array.from({ length: 700 }, (_, i) => ({ ...crosswalkOf(BASE)[0], source_id: `SRC-${i + 1}`, evidence: `${'e'.repeat(120)} ${i}` }));
  const { full, parts } = rendered({ crosswalk: rows });
  const continued = parts.slice(1).filter((t) => t.split('\n')[3].startsWith('| Source | Relation | Home |'));
  assert.ok(parts.length >= 2 && continued.length >= 1, `${parts.length} parts`);
  assert.strictEqual(continued[0].split('\n')[4], '|---|---|---|---|---|---|');
  assert.strictEqual(joinParts(parts), full);
});

check('AC5.4 any other block too long for one part stops and names the section', () => {
  const r = stopOf({ proposal: withUnits(1, MAX_PART) });
  assert.deepStrictEqual([r.reason, r.detail], ['block-too-long', 'the story map: U-10 detail block alone exceeds one part']);
});

check('AC5.5 more than five parts, or a part 1 that cannot hold the decisions, stops', () => {
  assert.strictEqual(stopOf({ proposal: withUnits(40, 9000) }).reason, 'too-many-parts');
  const decisions = [{ ...BASE.decisions[0], question: 'q'.repeat(MAX_PART) }];
  assert.strictEqual(stopOf({ proposal: { ...BASE, decisions } }).reason, 'part-1-crowded');
});

// --- AC6 the baseline delta, AC7.5 the previous result, AC2.2 the stop notice ---------------

check('AC6 the baseline delta section renders each drift case, and the header flags a changed digest', () => {
  const section = (drift) => {
    const body = rendered({ drift }).parts[0];
    return [body.split('### Baseline delta\n\n')[1].split('\n\n### ')[0], body];
  };
  const HEAD = 'c'.repeat(40);
  assert.strictEqual(section(STILL)[0], '`HEAD` is the baseline commit, so nothing was committed since; uncommitted changes are out of scope.');
  const moved = { ...STILL, head: HEAD, changed: 4 };
  assert.strictEqual(section(moved)[0], `\`HEAD\` is [\`cccccccc\`](https://github.com/${REPO}/commit/${HEAD}): 4 files changed in commits since the baseline, with no overlap. The planning-index digest is unchanged. Uncommitted changes are out of scope.`);
  const [overlap] = section({ ...moved, overlap: [{ path: 'src/notifications/prefs/index.ts', citedBy: ['U-1'] }] });
  assert.ok(overlap.includes('with 1 cited by this packet') && overlap.endsWith('| Changed path | Cited by |\n|---|---|\n| `src/notifications/prefs/index.ts` | `U-1` |'));
  const [changed, body] = section({ ...moved, digest: { baseline: DIGEST, head: 'sha256:2222' }, digestChanged: true });
  assert.ok(changed.startsWith('**The planning-index digest changed at `HEAD`:**'));
  assert.ok(body.includes('· **changed at `HEAD`** |'));
});

check('AC7.5 part 1 links the previous result and says what changed; a previous result needs that prose', () => {
  const context = { previous: { id: 6200000002, run: EARLIER } };
  const body = rendered({ context, prose: { changed: 'U-3 lost its owner.' } }).parts[0];
  assert.ok(body.includes(`**Previous result:** [run \`${EARLIER}\`](https://github.com/${REPO}/issues/${ISSUE}#issuecomment-6200000002). What changed: U-3 lost its owner.`));
  assert.match(usageOf({ context }), /prose\.json changed must say what changed/);
  assert.match(usageOf({ prose: { changed: 'nothing to compare' } }), /needs a previous result/);
});

check('AC2.2 an analysis_stopped verdict renders one stop notice naming the reason, the missing item and the next action', () => {
  const proposal = { schema: BASE.schema, baseline: { ...BASE.baseline }, verdict: { state: 'analysis_stopped', next_human_action: 'Restore read access to docs/feats, then re-run.', evidence_limits: 'Stopped at binding.' } };
  const { parts } = rendered({ proposal, context: { previous: { id: 77, run: EARLIER } }, prose: { stop: { reason: 'A required source could not be read.', missing: 'docs/feats/FT_104_x.md' } } });
  assert.strictEqual(parts.length, 1);
  const body = parts[0];
  assert.ok(body.startsWith(`${resultMarkerFor({ repo: REPO, issue: ISSUE, feat: FEAT, run: RUN, part: 1, parts: 1 })}\n\n## \`/dev-analyse-rp\` analysis stopped`));
  for (const text of ['**Reason:** A required source could not be read.', '**Missing:** docs/feats/FT_104_x.md', '**Next human action:** Restore read access', '#issuecomment-77']) assert.ok(body.includes(text), text);
  assert.deepStrictEqual(outgoing(body, 1, 1), { action: 'proceed', violations: [] });
  assert.match(usageOf({ proposal, prose: { stop: null } }), /stop must be set exactly/);
});

check('inputs: unknown or multi-line prose, an unknown context key, a stale manifest or crosswalk, and bad usage exit 2', () => {
  assert.match(usageOf({ prose: { summary: 'two\nlines' } }), /prose\.json\.summary/);
  assert.match(usageOf({ prose: { extra: 1 } }), /unknown key "extra"/);
  assert.match(usageOf({ context: { root: '/abs/root/' } }), /cite the packet root relatively/);
  assert.match(usageOf({ crosswalk: crosswalkOf(BASE).map((r) => ({ ...r, index_digest: 'sha256:old' })) }), /another planning index/);
  assert.match(usageOf({ crosswalk: [{ ...crosswalkOf(BASE)[0], relation: 'move' }] }), /relation/);
  assert.match(usageOf({ drift: { ...STILL, baseline: 'd'.repeat(40) } }), /another baseline/);
  const root = packet();
  fs.writeFileSync(path.join(root, MANIFEST), JSON.stringify({ run: EARLIER, baseline: SHA, verdict: BASE.verdict.state, files: [] }));
  assert.strictEqual(cli(root).status, 2);
  assert.strictEqual(node(SCRIPT, 'render').status, 2);
  assert.strictEqual(node(SCRIPT, 'render', '--root', path.join(root, 'missing')).status, 2);
});

console.log(`\n${pass} checks passed.`);
