// Tests for the dev-analyse-rp summary-comment helper, one per acceptance case.
// Plain Node; run with `node skills/dev-analyse-rp/summary-comment.test.mjs` or `npm test` from the plugin root.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkOutgoing, markerFor, MAX_BODY, MAX_PART, resolveArgs, resultMarkerFor, selectComments } from './summary-comment.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'summary-comment.mjs');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-comment-'));
// Removed on exit, pass or fail, so runs do not exhaust a shared tmpfs.
process.on('exit', () => fs.rmSync(DIR, { recursive: true, force: true }));

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { console.error(`FAIL - ${name}\n  ${e.message}`); process.exitCode = 1; }
};
const write = (name, value) => {
  const file = path.join(DIR, name);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
};
const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

const REPO = 'acme/tools';
const ISSUE = 12;
const RUN = '20261017T105400Z-5e6f7a8b';
const EARLIER = '20261016T090000Z-5e6f7a8b';
const SHA = '5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f';
const ME = 'analyst';
const comment = (id, body, extra = {}) => ({ id, nodeId: `IC_${id}`, author: ME, minimized: false, body, ...extra });
const summary = (run, repo = REPO, issue = ISSUE) => `${markerFor({ repo, issue, run })}\n## Summary\n`;
const scan = (comments, extra = {}) => ({ repo: REPO, issue: ISSUE, login: ME, run: RUN, scanComplete: true, comments, ...extra });
const footer = `🧭 claude·claude-opus-5-5·high · [5e6f7a8b](https://github.com/${REPO}/commit/${SHA}) · 2026-10-17 10:54 UTC · 0:12`;
const payload = (middle = '## Summary\n\nVerdict: proposal_complete.\n') => `${markerFor({ repo: REPO, issue: ISSUE, run: RUN })}\n${middle}\n---\n${footer}\n`;
const outgoing = (body) => checkOutgoing({ body, repo: REPO, issue: ISSUE, run: RUN, baseline: SHA });

// --- AC2.1 args ----------------------------------------------------------------

check('AC2.1.1 empty text or another first token keeps the default post', () => {
  assert.deepStrictEqual(resolveArgs(''), { action: 'proceed', noPublish: false, dryRun: false, instructions: '' });
  assert.deepStrictEqual(resolveArgs('  focus on STY_105 only\n'), { action: 'proceed', noPublish: false, dryRun: false, instructions: 'focus on STY_105 only' });
  assert.strictEqual(resolveArgs('publish everything').noPublish, false);
  assert.strictEqual(resolveArgs('no-publishing').noPublish, false);
});

check('AC2.1.2 exactly no-publish opts out and leaves the rest as instructions', () => {
  assert.deepStrictEqual(resolveArgs('no-publish'), { action: 'proceed', noPublish: true, dryRun: false, instructions: '' });
  assert.deepStrictEqual(resolveArgs('no-publish  keep it short'), { action: 'proceed', noPublish: true, dryRun: false, instructions: 'keep it short' });
});

check('AC2.1.3 a near-miss opt-out token stops and names the token', () => {
  for (const token of ['--no-publish', '-no-publish', 'No-Publish', 'NO-PUBLISH', 'no_publish', 'nopublish', '--nopublish', 'NoPublish']) {
    const r = resolveArgs(`${token} rest`);
    assert.strictEqual(r.action, 'stop', token);
    assert.match(r.detail, new RegExp(token.replace(/-/g, '\\-')));
  }
  const r = cli('args', '--file', write('rest.txt', 'no_publish please'));
  assert.strictEqual(r.status, 1);
  assert.strictEqual(cli('args', '--file', write('rest-ok.txt', 'no-publish')).status, 0);
});

// --- AC2.2 select --------------------------------------------------------------

check('AC2.2.1 no summary comments: post with an empty hide list', () => {
  const r = selectComments(scan([comment(1, 'Looks good.'), comment(2, '')]));
  assert.deepStrictEqual(r, { action: 'post', run: RUN, thisRun: [], hide: [], foreign: [], unrecognised: [] });
  const out = cli('select', '--input', write('none.json', scan([])));
  assert.strictEqual(out.status, 0);
  assert.strictEqual(JSON.parse(out.stdout).action, 'post');
});

check('AC2.2.2 earlier runs of ours are hidden unless already minimized; the action is unchanged', () => {
  const r = selectComments(scan([comment(1, summary(EARLIER)), comment(2, summary('20261015T000000Z-ef1aace1'), { minimized: true }),
    comment(3, summary('20261014T000000Z-ef1aace1'))]));
  assert.strictEqual(r.action, 'post');
  assert.deepStrictEqual(r.hide, [{ id: 1, nodeId: 'IC_1' }, { id: 3, nodeId: 'IC_3' }]);
});

check('AC2.2.3 exactly one comment of ours with this run marker: adopt it', () => {
  const r = selectComments(scan([comment(1, summary(EARLIER)), comment(9, summary(RUN))]));
  assert.strictEqual(r.action, 'adopt');
  assert.strictEqual(r.commentId, 9);
  assert.deepStrictEqual(r.hide, [{ id: 1, nodeId: 'IC_1' }]);
});

check('AC2.2.4 two comments of ours with this run marker: stop, listing them', () => {
  const input = scan([comment(8, summary(RUN)), comment(9, summary(RUN))]);
  const r = selectComments(input);
  assert.strictEqual(r.action, 'stop');
  assert.deepStrictEqual(r.thisRun, [8, 9]);
  assert.strictEqual(cli('select', '--input', write('twice.json', input)).status, 1);
});

check('AC2.2.5 another login\'s summary marker is foreign, never adopted or hidden', () => {
  const r = selectComments(scan([comment(4, summary(RUN), { author: 'someone' }), comment(5, summary(EARLIER), { author: null }),
    comment(6, '<!-- dev-analyse-rp:summary garbled -->', { author: 'someone' })]));
  assert.strictEqual(r.action, 'post');
  assert.deepStrictEqual(r.foreign, [4, 5, 6]);
  assert.deepStrictEqual([r.hide, r.unrecognised], [[], []]);
});

check('AC2.2.6 an unreadable summary marker of ours suspends every hide; the action is unchanged', () => {
  for (const odd of ['<!-- dev-analyse-rp:summary repo=acme/tools issue=12 -->', `${summary(EARLIER).split('\n')[0]} `,
    summary(EARLIER, 'acme/other'), summary(EARLIER, REPO, 13), 'dev-analyse-rp:summary was posted below']) {
    const r = selectComments(scan([comment(1, summary(EARLIER)), comment(7, odd), comment(9, summary(RUN))]));
    assert.strictEqual(r.action, 'adopt', odd);
    assert.deepStrictEqual(r.unrecognised, [7], odd);
    assert.deepStrictEqual(r.hide, [], odd);
  }
});

check('AC2.2.7 a marker that is not on the first line is not a summary comment', () => {
  const r = selectComments(scan([comment(1, `Quoting it:\n${summary(RUN)}`), comment(2, `\n${summary(EARLIER)}`),
    comment(3, `\`\`\`\n${summary(EARLIER)}\`\`\`\n`)]));
  assert.deepStrictEqual(r, { action: 'post', run: RUN, thisRun: [], hide: [], foreign: [], unrecognised: [] });
});

check('AC2.2.8 an incomplete scan stops', () => {
  const input = scan([comment(1, summary(EARLIER))], { scanComplete: false });
  assert.strictEqual(selectComments(input).action, 'stop');
  assert.deepStrictEqual(selectComments(input).hide, []);
  assert.strictEqual(cli('select', '--input', write('partial.json', input)).status, 1);
});

check('select stops on a repeated comment id and rejects a mistyped or unknown input key', () => {
  assert.strictEqual(selectComments(scan([comment(1, 'a'), comment(1, 'a')])).reason, 'duplicate-comment-id');
  const bad = [{ ...scan([]), repo: 'not a repo' },{ ...scan([]), issue: '12' }, { ...scan([]), run: '2026-10-17' }, { ...scan([]), extra: 1 },
    { ...scan([]), comments: [{ ...comment(1, 'x'), minimized: 'no' }] }, { ...scan([]), comments: [{ id: 1, body: 'x' }] }];
  for (const [i, input] of bad.entries()) assert.strictEqual(cli('select', '--input', write(`bad-${i}.json`, input)).status, 2, `bad ${i}`);
  assert.strictEqual(cli('select', '--input', write('broken.json', '{')).status, 2);
});

// --- AC2.3 outgoing ------------------------------------------------------------

check('AC2.3.1 this run marker first, the footer last and the size within the limit: proceed', () => {
  assert.deepStrictEqual(outgoing(payload()), { action: 'proceed', violations: [] });
  assert.strictEqual(outgoing(payload().replace('claude-opus-5-5·high', 'unknown·unknown').replace('0:12', 'unknown')).action, 'proceed');
  assert.strictEqual(outgoing(`${payload()}\n\n`).action, 'proceed');
  const file = write('ok.md', payload());
  assert.strictEqual(cli('outgoing', '--body', file, '--repo', REPO, '--issue', String(ISSUE), '--run', RUN, '--baseline', SHA).status, 0);
});

check('AC2.3.2 a different first line stops', () => {
  for (const body of [payload().replace(RUN, EARLIER), `\n${payload()}`, payload().replace('issue=12', 'issue=13'), `## Summary\n${payload()}`]) {
    assert.strictEqual(outgoing(body).action, 'stop');
    assert.match(outgoing(body).violations[0], /first line/);
  }
});

check('AC2.3.3 a missing footer, one that is not the last non-empty line, or one with an extra field, stops', () => {
  for (const body of [payload().replace(footer, ''), `${payload()}trailing text\n`, payload().replace('5e6f7a8b]', 'ef1aace1]'),
    payload().replace(`commit/${SHA}`, 'commit/main'), payload().replace('🧭 ', '💡 '), payload().replace(' · 0:12', ''),
    payload().replace(' · 0:12', ' · EXTRA · 0:12')]) {
    assert.strictEqual(outgoing(body).action, 'stop');
    assert.match(outgoing(body).violations.join(' '), /footer/);
  }
});

check('AC2.3.4 a body longer than the GitHub comment limit stops with its size', () => {
  const body = payload(`${'x'.repeat(MAX_BODY)}\n`);
  assert.strictEqual(outgoing(body).action, 'stop');
  assert.match(outgoing(body).violations.join(' '), new RegExp(`${body.length} characters`));
  const file = write('big.md', body);
  assert.strictEqual(cli('outgoing', '--body', file, '--repo', REPO, '--issue', String(ISSUE), '--run', RUN, '--baseline', SHA).status, 1);
});

check('AC2.3.5 a malformed run id or baseline, and other invalid usage, exit 2', () => {
  const file = write('usage.md', payload());
  const base = ['outgoing', '--body', file, '--repo', REPO, '--issue', String(ISSUE), '--run', RUN, '--baseline', SHA];
  const swap = (flag, value) => base.map((v, i) => (base[i - 1] === flag ? value : v));
  for (const args of [swap('--run', '20261017-5e6f7a8b'), swap('--run', `${RUN}x`), swap('--baseline', SHA.slice(0, 8)),
    swap('--baseline', SHA.toUpperCase()), swap('--issue', '0'), swap('--repo', 'tools'), swap('--body', path.join(DIR, 'missing.md')),
    base.slice(0, -2), [...base, '--json', 'x'], ['publish'], []]) {
    assert.strictEqual(cli(...args).status, 2, args.join(' '));
  }
});

// --- dry-run, results on a feat tracking issue ------------------------------

const FEAT = 'FT_104';
const result = (run, part = 1, parts = 1, repo = REPO, issue = ISSUE) => `${resultMarkerFor({ repo, issue, feat: FEAT, run, part, parts })}\n## Result\n`;
const featScan = (comments) => scan(comments, { feat: FEAT });

check('AC2.3 and AC2.4 exact no-publish or dry-run as the first token; near misses stop', () => {
  assert.deepStrictEqual(resolveArgs('dry-run'), { action: 'proceed', noPublish: false, dryRun: true, instructions: '' });
  assert.deepStrictEqual(resolveArgs('dry-run  compare with the hand-made post'), { action: 'proceed', noPublish: false, dryRun: true, instructions: 'compare with the hand-made post' });
  assert.strictEqual(resolveArgs('focus dry-run').dryRun, false);
  for (const token of ['--dry-run', 'Dry-Run', 'dry_run', 'dryrun', 'DRY-RUN']) {
    const r = resolveArgs(`${token} rest`);
    assert.strictEqual(r.action, 'stop', token);
    assert.strictEqual(r.reason, 'near-miss');
    assert.match(r.detail, /write exactly dry-run$/);
  }
});

check('AC7.1 our results and summaries are one family: other runs not minimized go into hide, on every target', () => {
  const comments = [comment(1, summary(EARLIER)), comment(2, result(EARLIER, 1, 2)), comment(3, result(EARLIER, 2, 2), { minimized: true }), comment(4, result(EARLIER))];
  const hide = [{ id: 1, nodeId: 'IC_1' }, { id: 2, nodeId: 'IC_2' }, { id: 4, nodeId: 'IC_4' }];
  assert.deepStrictEqual(selectComments(scan(comments)), { action: 'post', run: RUN, thisRun: [], hide, foreign: [], unrecognised: [] });
  assert.deepStrictEqual(selectComments(featScan(comments)).hide, hide);
});

check('AC7.2 previous is the latest earlier run by scan position, minimized or not, and that run\'s first comment', () => {
  const r = selectComments(featScan([comment(1, summary(EARLIER)), comment(5, result('20261017T080000Z-aaaaaaaa', 1, 2), { minimized: true }),
    comment(6, result('20261017T080000Z-aaaaaaaa', 2, 2), { minimized: true })]));
  assert.deepStrictEqual(r, { action: 'post', next: 1, run: RUN, previous: { id: 5, run: '20261017T080000Z-aaaaaaaa' }, parts: null, thisRun: [], hide: [{ id: 1, nodeId: 'IC_1' }], foreign: [], unrecognised: [] });
  assert.deepStrictEqual(selectComments(featScan([comment(1, summary(EARLIER))])).previous, { id: 1, run: EARLIER });
  assert.strictEqual(selectComments(featScan([])).previous, null);
});

check('AC7.2 a latest earlier run without its part 1 or summary stops, and is never linked or hidden', () => {
  const r = selectComments(featScan([comment(1, summary(EARLIER)), comment(5, result('20261017T080000Z-aaaaaaaa', 2, 3))]));
  assert.strictEqual(r.action, 'stop');
  assert.strictEqual(r.reason, 'previous-incomplete');
  assert.match(r.detail, /^run 20261017T080000Z-aaaaaaaa kept 5, with no part 1 or summary$/);
  assert.strictEqual(r.previous, null);
  const input = write('lost-part-1.json', featScan([comment(5, result('20261017T080000Z-aaaaaaaa', 2, 3))]));
  assert.strictEqual(cli('select', '--input', input).status, 1);
});

check('AC7.3 parts 1..j of this run continue at j+1; all m adopt; duplicates, another m, gaps or a summary stop', () => {
  const posted = selectComments(featScan([comment(7, result(RUN, 1, 3)), comment(8, result(RUN, 2, 3))]));
  assert.strictEqual(posted.action, 'post');
  assert.strictEqual(posted.next, 3);
  assert.deepStrictEqual([posted.thisRun, posted.parts], [[7, 8], 3]);
  const all = selectComments(featScan([comment(8, result(RUN, 2, 2)), comment(7, result(RUN, 1, 2))]));
  assert.deepStrictEqual([all.action, all.thisRun], ['adopt', [7, 8]]);
  for (const [comments, reason] of [
    [[comment(7, result(RUN, 1, 2)), comment(9, result(RUN, 1, 2))], 'duplicate-part'],
    [[comment(7, result(RUN, 1, 2)), comment(8, result(RUN, 2, 3))], 'part-count'],
    [[comment(8, result(RUN, 2, 2))], 'part-gap'],
    [[comment(7, summary(RUN))], 'mixed-run'],
  ]) assert.strictEqual(selectComments(featScan(comments)).reason, reason, reason);
  assert.strictEqual(selectComments(scan([comment(7, result(RUN))])).reason, 'mixed-run');
});

check('AC7.4 another login is foreign; an inexact result line of ours is unrecognised and empties hide', () => {
  const r = selectComments(featScan([comment(1, summary(EARLIER)), comment(2, result(EARLIER), { author: 'someone' }),
    comment(3, '<!-- dev-analyse-rp:result repo=acme/tools issue=12 run=x -->'), comment(4, result(EARLIER, 1, 1, REPO, 99)),
    comment(5, result(EARLIER, 3, 2))]));
  assert.deepStrictEqual([r.action, r.foreign, r.unrecognised, r.hide, r.previous], ['post', [2], [3, 4, 5], [], { id: 1, run: EARLIER }]);
});

check('AC7.6 the 16 Oct hand-made posts and the eval record are neither results nor summaries', () => {
  const comments = ['<!-- ft-104-rp18-analysis-2026-10-16 -->', '<!-- dev-analyse-rp:RP-43:2026-10-16 -->', '<!-- dev-analyse-rp-51-2026-10-17 -->',
    '<!-- dev-analyse-rp:eval-record repo=acme/tools issue=12 -->'].map((first, i) => comment(i + 1, `${first}\n## Analysis\n`));
  assert.deepStrictEqual(selectComments(featScan(comments)), { action: 'post', next: 1, run: RUN, previous: null, parts: null, thisRun: [], hide: [], foreign: [], unrecognised: [] });
});

const part = (i, m, middle = '## Result\n') => `${resultMarkerFor({ repo: REPO, issue: ISSUE, feat: FEAT, run: RUN, part: i, parts: m })}\n${middle}${i === m ? `\n---\n${footer}\n` : ''}`;
const outPart = (body, i, m) => checkOutgoing({ body, repo: REPO, issue: ISSUE, run: RUN, baseline: SHA, feat: FEAT, part: { i, m } });

check('AC7.9 outgoing accepts a result part with its exact marker, size and footer only on the last part', () => {
  assert.deepStrictEqual(outPart(part(1, 1), 1, 1), { action: 'proceed', violations: [] });
  assert.deepStrictEqual(outPart(part(1, 2), 1, 2), { action: 'proceed', violations: [] });
  assert.match(outPart(part(1, 2), 1, 3).violations[0], /first line/);
  assert.match(outPart(`${part(1, 2)}\n---\n${footer}\n`, 1, 2).violations[0], /carries a footer/);
  assert.match(outPart(part(2, 2).replace(footer, ''), 2, 2).violations[0], /footer/);
  const big = part(1, 2, `${'x'.repeat(MAX_PART)}\n`);
  assert.match(outPart(big, 1, 2).violations[0], /limit is 60000/);
  assert.deepStrictEqual(outgoing(part(1, 1)).action, 'stop', 'a summary check rejects a result marker');
});

check('the CLI takes --feat and --part together, and a feat in the select input', () => {
  const body = write('part.md', part(1, 2));
  const base = ['outgoing', '--body', body, '--repo', REPO, '--issue', String(ISSUE), '--run', RUN, '--baseline', SHA];
  assert.strictEqual(cli(...base, '--feat', FEAT, '--part', '1/2').status, 0);
  assert.strictEqual(cli(...base, '--part', '1/2', '--feat', FEAT).status, 0);
  for (const extra of [['--feat', FEAT], ['--feat', 'FT-1', '--part', '1/2'], ['--feat', FEAT, '--part', '3/2'], ['--feat', FEAT, '--part', '1/10']]) {
    assert.strictEqual(cli(...base, ...extra).status, 2, extra.join(' '));
  }
  const r = cli('select', '--input', write('feat-select.json', featScan([comment(1, result(EARLIER))])));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout).previous, { id: 1, run: EARLIER });
  assert.strictEqual(cli('select', '--input', write('bad-feat.json', scan([], { feat: 'FT-1' }))).status, 2);
});

// --- discussion targets ---------------------------------------------------------

const DISCUSSION = 1;
const dSummary = (run) => `${markerFor({ repo: REPO, discussion: DISCUSSION, run })}\n## Summary\n`;
const dScan = (comments, extra = {}) => {
  const { issue, ...rest } = scan(comments, extra);
  return { ...rest, discussion: DISCUSSION };
};

check('a discussion summary carries discussion=N, and an issue summary of the same number is not one of its family', () => {
  assert.strictEqual(markerFor({ repo: REPO, discussion: 1, run: RUN }), `<!-- dev-analyse-rp:summary repo=${REPO} discussion=1 run=${RUN} -->`);
  const r = selectComments(dScan([comment(1, dSummary(EARLIER)), comment(2, summary(EARLIER, REPO, DISCUSSION)), comment(3, result(EARLIER, 1, 1, REPO, DISCUSSION)),
    comment(9, dSummary(RUN))]));
  assert.deepStrictEqual([r.action, r.commentId, r.unrecognised, r.hide], ['adopt', 9, [2, 3], []]);
  const clean = selectComments(dScan([comment(1, dSummary(EARLIER)), comment(4, dSummary(EARLIER), { author: 'someone' })]));
  assert.deepStrictEqual([clean.action, clean.hide, clean.foreign], ['post', [{ id: 1, nodeId: 'IC_1' }], [4]]);
  assert.strictEqual(selectComments(scan([comment(1, dSummary(EARLIER))])).unrecognised[0], 1, 'a discussion summary is not an issue one');
});

check('outgoing checks a discussion summary against --discussion, and the CLI takes exactly one target', () => {
  const body = payload().replace(`issue=${ISSUE}`, `discussion=${DISCUSSION}`);
  assert.deepStrictEqual(checkOutgoing({ body, repo: REPO, discussion: DISCUSSION, run: RUN, baseline: SHA }), { action: 'proceed', violations: [] });
  assert.strictEqual(checkOutgoing({ body, repo: REPO, issue: DISCUSSION, run: RUN, baseline: SHA }).action, 'stop');
  const file = write('discussion.md', body);
  const base = ['outgoing', '--body', file, '--repo', REPO, '--run', RUN, '--baseline', SHA];
  assert.strictEqual(cli(...base, '--discussion', String(DISCUSSION)).status, 0);
  for (const extra of [[], ['--discussion', '1', '--issue', '1'], ['--discussion', '0'], ['--discussion', '1', '--feat', FEAT, '--part', '1/1']]) {
    assert.strictEqual(cli(...base, ...extra).status, 2, extra.join(' ') || 'no target');
  }
  assert.strictEqual(cli('select', '--input', write('d-select.json', dScan([]))).status, 0);
  const { discussion, ...noTarget } = dScan([]);
  for (const [i, input] of [{ ...noTarget }, { ...noTarget, discussion, issue: 1 }, { ...noTarget, discussion, feat: FEAT }].entries()) {
    assert.strictEqual(cli('select', '--input', write(`d-bad-${i}.json`, input)).status, 2, `bad ${i}`);
  }
});

console.log(`\n${pass} checks passed.`);
