// Tests for the dev-analyse-rp run record: one named test per case of the record script's
// closed case list, over in-memory and temporary-file fixtures only. Plain Node:
// `node --test skills/dev-analyse-rp/run-record.test.mjs` or `npm test` from the plugin root.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { costFromResult, costFromTranscripts, HEADER, markerFor, MAX_BODY, planAppend, renderRow, Stop, UNKNOWN } from './run-record.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-record.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'run-record-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const file = (name, content) => {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
};
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

const RESULT = {
  type: 'result', subtype: 'success', is_error: false, result_index: 0, duration_ms: 891400, duration_api_ms: 805200, num_turns: 96,
  total_cost_usd: 12.3456,
  modelUsage: {
    'claude-opus-5-5': { inputTokens: 100, outputTokens: 60000, cacheCreationInputTokens: 2000, cacheReadInputTokens: 900000 },
    'claude-haiku-5-5': { inputTokens: 10, outputTokens: 1799, cacheCreationInputTokens: 30, cacheReadInputTokens: 4000 },
  },
  subagent_stats: { spawned: 1 },
};

const at = (s) => `2026-10-17T09:00:${String(s).padStart(2, '0')}.000Z`;
const assistant = (id, s, usage = {}, extra = {}) => ({
  type: 'assistant', timestamp: at(s), ...extra,
  message: { id, model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, ...usage } },
});
// An earlier record of a streamed response: no stop_reason, and the output count so far.
const streaming = (id, s, usage) => {
  const r = assistant(id, s, usage);
  r.message.stop_reason = null;
  return r;
};
const records = (...rs) => rs.map((record, i) => ({ where: `t.jsonl:${i + 1}`, record }));
const START = Date.parse(at(10));
const END = Date.parse(at(20));

const COST = costFromResult(RESULT);
const FIELDS = {
  evaluated: '2026-10-17T10:00:00Z', evaluator: '1', pack: '#43', baseline: '5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f',
  blind_items: 12, manifest_rows: 11, gaps: 1, conflicts: 1, homes_missed_or_wrong: 1, checker_exit: 0, verify_homes_exit: 0,
};
const ROW = renderRow(COST, FIELDS);
const ROW2 = renderRow(COST, { ...FIELDS, evaluated: '2026-10-18T10:00:00Z' });
const FOOTER = '💡 claude·claude-opus-5-5·high · 2026-10-17T10:00:00Z · 4m';
const REPO = 'example-org/example-repo';
const scan = (comments, extra = {}) => ({ repo: REPO, issue: 43, login: 'me', scanComplete: true, comments, ...extra });
const created = planAppend(scan([]), ROW, FOOTER).body;

test('C-1 a headless result with every field copies the totals with cost source headless-json', () => {
  assert.deepEqual(COST, {
    source: 'headless-json', result: 'success', wall_ms: 891400, api_ms: 805200, turns: 96, cost_usd: 12.3456,
    input_tokens: 110, output_tokens: 61799, cache_write_tokens: 2030, cache_read_tokens: 904000,
    models: ['claude-haiku-5-5', 'claude-opus-5-5'], subagents: 1,
  });
  const out = run('cost', '--run', file('c1.json', RESULT));
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), COST);
});

test('C-2 a headless result with a field missing, timed for its last segment only, or marked --resumed, records it unknown, never 0', () => {
  const { duration_api_ms: _api, total_cost_usd: _cost, ...rest } = RESULT;
  const partial = { ...rest, modelUsage: { m: { inputTokens: 5, outputTokens: 6, cacheCreationInputTokens: 7 } } };
  const cost = costFromResult(partial);
  assert.equal(cost.api_ms, UNKNOWN);
  assert.equal(cost.cost_usd, UNKNOWN);
  assert.equal(cost.cache_read_tokens, UNKNOWN);
  assert.equal(cost.input_tokens, 5);
  assert.equal(costFromResult({ ...RESULT, modelUsage: undefined }).output_tokens, UNKNOWN);
  assert.match(renderRow(cost, FIELDS), /\| \? \/ \? \| \? \| 5 \/ 6 \/ 7 \/ \? \| \? \|/);
  const resumed = costFromResult({ ...RESULT, result_index: 1, duration_ms: 45783, num_turns: 5 });
  assert.deepEqual([resumed.wall_ms, resumed.turns, resumed.api_ms, resumed.output_tokens], [UNKNOWN, UNKNOWN, 805200, 61799]);
  const resumed2 = costFromResult({ ...RESULT, duration_api_ms: 806292, duration_ms: 47923, num_turns: 6 });
  assert.deepEqual([resumed2.wall_ms, resumed2.turns, resumed2.api_ms], [UNKNOWN, UNKNOWN, 806292]);
  const { result_index: _index, ...unnumbered } = RESULT;
  assert.deepEqual([costFromResult(unnumbered).wall_ms, costFromResult(unnumbered).turns], [UNKNOWN, UNKNOWN]);
  const whole = file('c2.json', JSON.stringify(RESULT));
  const flagged = JSON.parse(run('cost', '--run', whole, '--resumed').stdout);
  assert.deepEqual([flagged.wall_ms, flagged.turns, flagged.api_ms], [UNKNOWN, UNKNOWN, RESULT.duration_api_ms]);
  assert.equal(run('cost', '--run', whole, '--resumed', '--resumed').status, 2);
  assert.equal(run('cost', '--transcript', whole, '--start', at(10), '--end', at(20), '--resumed').status, 2);
});

test('C-3 a result with is_error true keeps the totals and records its result subtype', () => {
  const failed = costFromResult({ ...RESULT, subtype: 'error_max_turns', is_error: true });
  assert.equal(failed.result, 'error_max_turns');
  assert.equal(failed.output_tokens, 61799);
  assert.equal(costFromResult({ ...RESULT, is_error: true }).result, 'error');
  assert.equal(run('cost', '--run', file('c3.json', { ...RESULT, subtype: 'error_max_turns', is_error: true })).status, 0);
});

test('C-4 an unreadable file, invalid JSON or a non-object exits 2', () => {
  assert.equal(run('cost', '--run', path.join(TMP, 'absent.json')).status, 2);
  assert.equal(run('cost', '--run', file('c4a.json', '{not json')).status, 2);
  assert.equal(run('cost', '--run', file('c4b.json', '[1, 2]')).status, 2);
  assert.equal(run('cost', '--transcript', file('c4c.jsonl', '{"type":"assistant"\n'), '--start', at(10), '--end', at(20)).status, 2);
  assert.equal(run('cost').status, 2);
  assert.equal(run('cost', '--run', file('c4d.json', RESULT), '--start', at(10)).status, 2);
  assert.equal(run('report').status, 2);
});

test('C-5 transcript mode sums only assistant records inside the inclusive window', () => {
  const cost = costFromTranscripts(records(
    assistant('m-before', 9),
    assistant('m-start', 10),
    { type: 'user', timestamp: at(12), message: { content: 'x' } },
    assistant('m-mid', 15, { output_tokens: 5 }),
    assistant('m-end', 20),
    assistant('m-after', 21),
  ), START, END);
  assert.equal(cost.source, 'transcript');
  assert.equal(cost.api_calls, 3);
  assert.equal(cost.output_tokens, 25);
  assert.equal(cost.cache_read_tokens, 3000);
  assert.equal(cost.wall_ms, 10000);
  const main = file('c5-main.jsonl', [assistant('m-a', 11), assistant('m-b', 12)].map((r) => JSON.stringify(r)).join('\n'));
  const sub = file('c5-sub.jsonl', `${JSON.stringify(assistant('m-c', 13, {}, { isSidechain: true }))}\n\n`);
  const out = run('cost', '--transcript', main, '--transcript', sub, '--start', at(10), '--end', at(20));
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).api_calls, 3);
});

test('C-6 transcript records of one message.id count once, with output from the final record only', () => {
  const cost = costFromTranscripts(records(streaming('m-1', 11, { output_tokens: 8 }), assistant('m-1', 12), assistant('m-2', 13)), START, END);
  assert.equal(cost.api_calls, 2);
  assert.equal(cost.output_tokens, 20);
  assert.equal(cost.cache_read_tokens, 2000);
  assert.equal(cost.api_calls_without_final_output, 0);
  const open = costFromTranscripts(records(streaming('m-1', 11, { output_tokens: 8 }), streaming('m-1', 12, { output_tokens: 8 }), assistant('m-2', 13)), START, END);
  assert.equal(open.output_tokens, UNKNOWN);
  assert.equal(open.input_tokens, 2);
  assert.equal(open.api_calls_without_final_output, 1);
  assert.match(renderRow(open, FIELDS), /\| 2 \/ \? \/ 200 \/ 2000 \|/);
  assert.throws(() => costFromTranscripts(records(streaming('m-1', 11), assistant('m-1', 12, { cache_read_input_tokens: 5 })), START, END),
    (e) => e instanceof Stop && /disagree on input or cache usage/.test(e.message));
  assert.throws(() => costFromTranscripts(records(assistant('m-1', 11), assistant('m-1', 12, { output_tokens: 99 })), START, END),
    (e) => e instanceof Stop && /final records of m-1 disagree on output/.test(e.message));
});

test('C-7 a window holding no assistant record exits 1', () => {
  assert.throws(() => costFromTranscripts(records(assistant('m-1', 30)), START, END), Stop);
  assert.throws(() => costFromTranscripts(records({ type: 'assistant', timestamp: at(11), message: {} }), START, END), Stop);
  assert.equal(run('cost', '--transcript', file('c7.jsonl', JSON.stringify(assistant('m-1', 30))), '--start', at(10), '--end', at(20)).status, 1);
});

test('C-8 transcript mode records cost and API time unknown', () => {
  const cost = costFromTranscripts(records(assistant('m-1', 11)), START, END);
  assert.equal(cost.cost_usd, UNKNOWN);
  assert.equal(cost.api_ms, UNKNOWN);
  assert.match(renderRow(cost, FIELDS), /\| 10 \/ \? \|.*\| \? \| transcript \|/);
});

test('C-9 a malformed timestamp or a window start after its end exits 2', () => {
  const t = file('c9.jsonl', JSON.stringify(assistant('m-1', 11)));
  assert.equal(run('cost', '--transcript', t, '--start', '2026-10-17 09:00:10', '--end', at(20)).status, 2);
  assert.equal(run('cost', '--transcript', t, '--start', at(10), '--end', '17 Oct').status, 2);
  assert.equal(run('cost', '--transcript', t, '--start', at(20), '--end', at(10)).status, 2);
  assert.equal(run('cost', '--transcript', t, '--start', '2026-10-17T25:00:00Z', '--end', at(20)).status, 2);
  assert.equal(run('cost', '--transcript', t, '--start', '2026-09-31T09:00:10Z', '--end', at(20)).status, 2);
  assert.throws(() => costFromTranscripts(records({ ...assistant('m-1', 11), timestamp: '2026-02-30T09:00:11Z' }), START, END), Stop);
  assert.throws(() => renderRow(COST, { ...FIELDS, evaluated: '2026-13-01T10:00:00Z' }), Stop);
});

test('C-10 row inputs render one row in column order; a missing field or a | or line break exits 1', () => {
  assert.equal(ROW, '| 2026-10-17T10:00:00Z | 1 | #43 | `5e6f7a8b` | success | 891 / 805 | 96'
    + ' | 110 / 61799 / 2030 / 904000 | 12.35 | headless-json | 12 | 11 | 1 | 1 | 1 | 0 / 0 |');
  assert.equal(ROW.split('|').length, HEADER.split('|').length);
  assert.match(renderRow(COST, { ...FIELDS, gaps: UNKNOWN }), /\| 11 \| \? \| 1 \| 1 \| 0 \/ 0 \|$/);
  const { gaps: _gaps, ...missing } = FIELDS;
  assert.throws(() => renderRow(COST, missing), (e) => e instanceof Stop && /gaps/.test(e.message));
  assert.throws(() => renderRow(COST, { ...FIELDS, pack: 'a|b' }), Stop);
  assert.throws(() => renderRow(COST, { ...FIELDS, pack: 'a\nb' }), Stop);
  assert.throws(() => renderRow(COST, { ...FIELDS, gaps: -1 }), Stop);
  assert.throws(() => renderRow({ ...COST, turns: undefined }, FIELDS), Stop);
  const cost = file('c10-cost.json', COST);
  const ok = run('row', '--cost', cost, '--input', file('c10.json', FIELDS));
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, `${ROW}\n`);
  assert.equal(run('row', '--cost', cost, '--input', file('c10-missing.json', missing)).status, 1);
});

test('C-11 a scan with no record comment by this login plans a create with marker, header, row and footer', () => {
  const plan = planAppend(scan([{ id: 1, author: 'me', body: 'unrelated' }]), ROW, FOOTER);
  assert.equal(plan.action, 'create');
  assert.equal(plan.commentId, null);
  const lines = plan.body.split('\n');
  assert.equal(lines[0], markerFor(REPO, 43));
  assert.ok(lines.includes(HEADER));
  assert.deepEqual(lines.slice(-4), [ROW, '', FOOTER, '']);
});

test('C-12 exactly one record comment plans an append that keeps every byte through the last row', () => {
  const plan = planAppend(scan([{ id: 7, author: 'me', body: created }]), ROW2, 'new footer');
  assert.equal(plan.action, 'append');
  assert.equal(plan.commentId, 7);
  const kept = created.slice(0, created.indexOf(ROW) + ROW.length);
  assert.ok(plan.body.startsWith(kept));
  assert.equal(plan.body, `${kept}\n${ROW2}\n\nnew footer\n`);
  const third = planAppend(scan([{ id: 7, author: 'me', body: plan.body }]), renderRow(COST, { ...FIELDS, evaluated: '2026-10-19T10:00:00Z' }), FOOTER);
  assert.equal(third.action, 'append');
  assert.ok(third.body.startsWith(`${kept}\n${ROW2}\n`));
  const out = path.join(TMP, 'c12-planned.md');
  const cli = run('append', '--scan', file('c12.json', scan([{ id: 7, author: 'me', body: created }])), '--row', file('c12-row.md', `${ROW2}\n`),
    '--footer', file('c12-footer.txt', 'new footer\n'), '--out', out);
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(fs.readFileSync(out, 'utf8'), plan.body);
});

test('C-13 two or more record comments by this login exit 1 and list their IDs', () => {
  const plan = planAppend(scan([{ id: 3, author: 'me', body: created }, { id: 9, author: 'me', body: created }]), ROW2, FOOTER);
  assert.equal(plan.action, 'stop');
  assert.deepEqual(plan.commentIds, [3, 9]);
  const out = file('c13-planned.md', 'stale');
  const cli = run('append', '--scan', file('c13.json', scan([{ id: 3, author: 'me', body: created }, { id: 9, author: 'me', body: created }])),
    '--row', file('c13-row.md', ROW2), '--footer', file('c13-footer.txt', FOOTER), '--out', out);
  assert.equal(cli.status, 1);
  assert.equal(fs.existsSync(out), false);
});

test("C-14 another login's record comment is listed as foreign and never selected", () => {
  const alone = planAppend(scan([{ id: 5, author: 'other', body: created }]), ROW2, FOOTER);
  assert.equal(alone.action, 'create');
  assert.deepEqual(alone.foreign, [5]);
  const beside = planAppend(scan([{ id: 5, author: 'other', body: created }, { id: 6, author: 'me', body: created }]), ROW2, FOOTER);
  assert.equal(beside.action, 'append');
  assert.equal(beside.commentId, 6);
  assert.deepEqual(beside.foreign, [5]);
});

test('C-15 an unrecognised marker, header, table or tail exits 1 and lists what was found', () => {
  const stopFor = (body, comments) => planAppend(scan(comments ?? [{ id: 4, author: 'me', body }]), ROW2, FOOTER);
  const cases = [
    [created.replace('issue=43', 'issue=44'), /another repository or issue/],
    [created.replace(`repo=${REPO}`, 'repo=other/repo'), /another repository or issue/],
    [`note\n${created}`, /not on the first line/],
    [created.replace('| Gaps |', '| Gap |'), /line \d+ differs/],
    [`${created.trimEnd()}\n\n${HEADER}\n|---|\n`, /second table/],
    [`${created}trailing text\n`, /text after the footer/],
    [created.replace(ROW, '| a | b |'), /does not have the table/],
    [created.replace('\n\n💡', '\n💡'), /text after the footer/],
    [created.replace(/\n/g, '\r\n'), /another repository or issue|differs/],
  ];
  for (const [body, reason] of cases) {
    const plan = stopFor(body);
    assert.equal(plan.action, 'stop', body.slice(0, 80));
    assert.match(plan.reason, reason);
    assert.deepEqual(plan.commentIds, [4]);
  }
});

test('C-16 a planned body over 60,000 characters exits 1', () => {
  const longRow = renderRow(COST, { ...FIELDS, pack: `docs/${'p'.repeat(MAX_BODY)}.md` });
  const plan = planAppend(scan([]), longRow, FOOTER);
  assert.equal(plan.action, 'stop');
  assert.match(plan.reason, /over 60000/);
  const nearly = `${created.slice(0, created.indexOf(ROW) + ROW.length)}\n${`${ROW}\n`.repeat(Math.ceil(MAX_BODY / ROW.length)).trimEnd()}\n\n${FOOTER}\n`;
  assert.equal(planAppend(scan([{ id: 8, author: 'me', body: nearly }]), ROW2, FOOTER).action, 'stop');
});

test('C-17 the row already present as the last row plans no write', () => {
  const plan = planAppend(scan([{ id: 7, author: 'me', body: created }]), ROW, 'another footer');
  assert.deepEqual(plan, { action: 'noop', commentId: 7, foreign: [] });
  const withTwo = planAppend(scan([{ id: 7, author: 'me', body: created }]), ROW2, FOOTER).body;
  assert.equal(planAppend(scan([{ id: 7, author: 'me', body: withTwo }]), ROW, FOOTER).action, 'stop');
});

test('C-18 a scan marked incomplete exits 1', () => {
  assert.equal(planAppend(scan([], { scanComplete: false }), ROW, FOOTER).action, 'stop');
  const cli = run('append', '--scan', file('c18.json', scan([], { scanComplete: false })), '--row', file('c18-row.md', ROW),
    '--footer', file('c18-footer.txt', FOOTER), '--out', path.join(TMP, 'c18.md'));
  assert.equal(cli.status, 1);
  assert.equal(run('append', '--scan', file('c18-bad.json', { repo: REPO, issue: 43, login: 'me', comments: [] }), '--row', file('c18-row2.md', ROW),
    '--footer', file('c18-footer2.txt', FOOTER), '--out', path.join(TMP, 'c18b.md')).status, 2);
});
