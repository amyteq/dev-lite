#!/usr/bin/env node
// Comment decisions for dev-analyse-rp (references/summary.md, references/result-comment.md):
// whether the invocation opts out or dry-runs, which of the issue's or discussion's comments
// are this run's or earlier runs' summaries and results, and whether a payload carries this
// run's marker, footer and size. Pure functions over files, with no GitHub call, network or
// clock: posting and hiding stay procedure steps, and every non-zero exit blocks the write that follows.
//
// `node summary-comment.mjs args --file <rest.txt>`
// `node summary-comment.mjs select --input <select.json>`
// `node summary-comment.mjs outgoing --body <file> --repo <owner>/<repo> --issue <n>|--discussion <n> --run <run-id> --baseline <sha> [--feat FT_<k> --part <i>/<m>]`
// Exit 0 = proceed, 1 = stop, 2 = usage, or an unreadable, unparseable or mistyped input.
import fs from 'node:fs';
import { isMainModule, KEY_RES } from './check-proposal.mjs';

const OPT_OUT = 'no-publish';
const DRY_RUN = 'dry-run';
const TOKEN = 'dev-analyse-rp:summary';
const RESULT_TOKEN = 'dev-analyse-rp:result';
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RUN_RE = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const KEY_RE = KEY_RES.feat;
// A summary names its target's kind, so an issue's summary never passes for a discussion's.
const MARKER_RE = /^<!-- dev-analyse-rp:summary repo=(?<repo>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+) (?<kind>issue|discussion)=(?<number>[1-9]\d*) run=(?<run>\d{8}T\d{6}Z-[0-9a-f]{8}) -->$/;
const RESULT_RE = /^<!-- dev-analyse-rp:result repo=(?<repo>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+) issue=(?<number>[1-9]\d*) feat=FT_[1-9]\d* run=(?<run>\d{8}T\d{6}Z-[0-9a-f]{8}) part=(?<part>[1-9])\/(?<parts>[1-9]) -->$/;
// GitHub rejects a longer comment body. UTF-16 length is never below the character count, so this errs toward stopping.
export const MAX_BODY = 65536;
// A result part stays well under that limit (D-4), leaving room for GitHub's own rendering.
export const MAX_PART = 60000;
export const FOOTER_EMOJI = '🧭';

const lines = (text) => text.split(/\r\n|\n|\r/);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// The target is an issue, or a discussion when `discussion` is set; a result part is always on a feat tracking issue.
const target = ({ issue, discussion }) => (discussion === undefined ? { kind: 'issue', number: issue } : { kind: 'discussion', number: discussion });
export const markerFor = ({ repo, run, ...t }) => `<!-- ${TOKEN} repo=${repo} ${target(t).kind}=${target(t).number} run=${run} -->`;
export const resultMarkerFor = ({ repo, issue, feat, run, part, parts }) =>
  `<!-- ${RESULT_TOKEN} repo=${repo} issue=${issue} feat=${feat} run=${run} part=${part}/${parts} -->`;

/** Classify the token that follows the target. A near miss stops before any analysis. */
export function resolveArgs(rest) {
  const trimmed = rest.trim();
  const [first = ''] = trimmed.split(/\s+/, 1);
  const after = trimmed.slice(first.length).trim();
  if (first === OPT_OUT) return { action: 'proceed', noPublish: true, dryRun: false, instructions: after };
  if (first === DRY_RUN) return { action: 'proceed', noPublish: false, dryRun: true, instructions: after };
  const normalized = first.toLowerCase().replace(/^-+/, '').replace(/_/g, '-');
  for (const [token, squashed, name] of [[OPT_OUT, 'nopublish', 'opt-out'], [DRY_RUN, 'dryrun', 'dry-run']]) {
    if (normalized === token || normalized === squashed) {
      return { action: 'stop', reason: 'near-miss', detail: `"${first}" is not the ${name} token; write exactly ${token}` };
    }
  }
  return { action: 'proceed', noPublish: false, dryRun: false, instructions: trimmed };
}

/**
 * Decide from one complete comment scan: post, adopt this run's comments, or stop; and which
 * earlier comments of ours to hide. Our exact summaries and results for this repository and
 * target are one family: only they can be adopted, hidden or linked, and any family-like first
 * line of ours that is not exact suspends hiding. With `feat` set, the run posts a result in
 * parts, and `previous` names the latest earlier run's part 1 or summary, minimized or not.
 */
export function selectComments({ repo, issue, discussion, login, run, scanComplete, comments, feat }) {
  const { kind: targetKind, number } = target({ issue, discussion });
  const mode = feat === undefined ? {} : { previous: null, parts: null };
  const empty = { thisRun: [], hide: [], foreign: [], unrecognised: [], ...mode };
  if (!scanComplete) return { action: 'stop', reason: 'incomplete-scan', run, ...empty };
  const ids = comments.map((c) => c.id);
  const repeated = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (repeated.length) return { action: 'stop', reason: 'duplicate-comment-id', detail: repeated.join(', '), run, ...empty };

  const mine = [], others = [], candidates = [], foreign = [], unrecognised = [];
  for (const c of comments) {
    const first = lines(c.body)[0];
    const kind = first.includes(TOKEN) ? 'summary' : first.includes(RESULT_TOKEN) ? 'result' : null;
    if (!kind) continue;
    if (c.author !== login) { foreign.push(c.id); continue; }
    const m = first.match(kind === 'summary' ? MARKER_RE : RESULT_RE)?.groups;
    if (!m || m.repo !== repo || (m.kind ?? 'issue') !== targetKind || Number(m.number) !== number || Number(m.part) > Number(m.parts)) unrecognised.push(c.id);
    else if (m.run === run) mine.push({ id: c.id, kind, part: Number(m.part ?? 0), parts: Number(m.parts ?? 0) });
    else {
      others.push({ id: c.id, run: m.run, head: kind === 'summary' || m.part === '1' });
      if (!c.minimized) candidates.push({ id: c.id, nodeId: c.nodeId });
    }
  }
  const lists = { hide: unrecognised.length ? [] : candidates, foreign, unrecognised };
  const kinds = (want) => mine.filter((x) => x.kind !== want).map((x) => x.id).join(', ');
  if (feat === undefined) {
    const thisRun = mine.map((x) => x.id);
    const out = { run, thisRun, ...lists };
    if (kinds('summary')) return { action: 'stop', reason: 'mixed-run', detail: kinds('summary'), ...out };
    if (thisRun.length > 1) return { action: 'stop', reason: 'duplicate-run', detail: thisRun.join(', '), ...out };
    if (thisRun.length === 1) return { action: 'adopt', commentId: thisRun[0], ...out };
    return { action: 'post', ...out };
  }
  const latest = others.at(-1)?.run;
  const first = others.find((o) => o.run === latest && o.head);
  mine.sort((a, b) => a.part - b.part);
  const out = { run, previous: first ? { id: first.id, run: first.run } : null, parts: mine[0]?.parts ?? null, thisRun: mine.map((x) => x.id), ...lists };
  const twice = mine.filter((x, i) => mine.some((y, j) => j !== i && y.part === x.part)).map((x) => x.id);
  if (kinds('result')) return { action: 'stop', reason: 'mixed-run', detail: kinds('result'), ...out };
  if (twice.length) return { action: 'stop', reason: 'duplicate-part', detail: twice.join(', '), ...out };
  if (new Set(mine.map((x) => x.parts)).size > 1) return { action: 'stop', reason: 'part-count', detail: mine.map((x) => `${x.id} ${x.part}/${x.parts}`).join(', '), ...out };
  if (mine.some((x, i) => x.part !== i + 1)) return { action: 'stop', reason: 'part-gap', detail: mine.map((x) => `${x.id} part ${x.part}`).join(', '), ...out };
  // AC7.2 names an earlier run's part 1 or summary as `previous`. A latest earlier run that kept
  // only a continuation is an unlisted shape: stop rather than link a part without its header.
  if (latest && !first) {
    const kept = others.filter((o) => o.run === latest).map((o) => o.id).join(', ');
    return { action: 'stop', reason: 'previous-incomplete', detail: `run ${latest} kept ${kept}, with no part 1 or summary`, ...out };
  }
  if (mine.length && mine.length === mine[0].parts) return { action: 'adopt', ...out };
  return { action: 'post', next: mine.length + 1, ...out };
}

/**
 * Check the exact payload: this run's marker first, the footer last, and the size limit. A
 * result part (`feat` and `part` set) carries the footer only when it is the last part.
 */
export function checkOutgoing({ body, repo, issue, discussion, run, baseline, feat, part }) {
  const violations = [];
  const rows = lines(body);
  const marker = feat === undefined ? markerFor({ repo, issue, discussion, run }) : resultMarkerFor({ repo, issue, feat, run, part: part.i, parts: part.m });
  if (rows[0] !== marker) violations.push(`the first line is not ${marker}`);
  const last = [...rows].reverse().find((row) => row.trim() !== '') ?? '';
  const link = `\\[${baseline.slice(0, 8)}\\]\\(https://github\\.com/${escape(repo)}/commit/${baseline}\\)`;
  // STARTED stops at the field separator, so an extra field cannot be read as a long STARTED.
  const footer = new RegExp(`^${FOOTER_EMOJI} [^\\s·]+·[^\\s·]+·[^\\s·]+ · ${link} · \\S[^·]* · (?:\\d+:\\d{2}|unknown)$`, 'u');
  if (feat !== undefined && part.i < part.m) {
    if (rows.some((row) => row.startsWith(`${FOOTER_EMOJI} `))) violations.push(`part ${part.i}/${part.m} carries a footer, which belongs to the last part only`);
  } else if (!footer.test(last)) violations.push('the last non-empty line is not the footer with this baseline');
  const limit = feat === undefined ? MAX_BODY : MAX_PART;
  if (body.length > limit) violations.push(`the body is ${body.length} characters; the limit is ${limit}`);
  return { action: violations.length ? 'stop' : 'proceed', violations };
}

// --- CLI ---------------------------------------------------------------------

class InputError extends Error {}
const fail = (message) => { throw new InputError(message); };
const FLAGS = { args: ['file'], select: ['input'], outgoing: ['body', 'repo', 'run', 'baseline'] };
// Exactly one of issue and discussion names the target; a result part names its feat and part,
// both or neither, and only on an issue; a summary names neither.
const OPTIONAL = { select: ['issue', 'discussion', 'feat'], outgoing: ['issue', 'discussion', 'feat', 'part'] };
const isInt = (v) => Number.isSafeInteger(v) && v > 0;
const isText = (v) => typeof v === 'string' && v.length > 0;
const COMMENT = { id: isInt, nodeId: isText, author: (v) => v === null || isText(v), minimized: (v) => typeof v === 'boolean', body: (v) => typeof v === 'string' };
const SELECT = {
  repo: (v) => typeof v === 'string' && REPO_RE.test(v), issue: isInt, discussion: isInt, login: isText,
  run: (v) => typeof v === 'string' && RUN_RE.test(v), scanComplete: (v) => typeof v === 'boolean',
  comments: (v) => Array.isArray(v) && v.every((c) => exact(c, COMMENT, 'a comment')),
  feat: (v) => typeof v === 'string' && KEY_RE.test(v),
};

function oneTarget(given, what) {
  if (Object.hasOwn(given, 'issue') === Object.hasOwn(given, 'discussion')) fail(`${what} takes exactly one of issue and discussion`);
  if (Object.hasOwn(given, 'feat') && Object.hasOwn(given, 'discussion')) fail(`${what}: a feat result posts on its tracking issue, never on a discussion`);
}

function exact(value, schema, what, optional = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${what} must be a JSON object`);
  for (const key of Object.keys(value)) if (!Object.hasOwn(schema, key)) fail(`${what} has the unknown key "${key}"`);
  for (const [key, valid] of Object.entries(schema)) {
    if (!Object.hasOwn(value, key) ? !optional.includes(key) : !valid(value[key])) fail(`${what}.${key} is missing or mistyped`);
  }
  return true;
}

const read = (file) => {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return fail(`cannot read ${file}: ${e.message}`); }
};

/** The one input boundary: argv to a validated command input, or InputError. Nothing downstream re-checks. */
export function readInput(argv) {
  const [command, ...args] = argv;
  const flags = Object.hasOwn(FLAGS, command ?? '') ? FLAGS[command] : fail('unknown or missing command');
  const allowed = command === 'outgoing' ? [...flags, ...OPTIONAL.outgoing] : flags;
  if (args.length % 2) fail(`${command} takes --flag VALUE pairs`);
  const given = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !allowed.includes(flag) || Object.hasOwn(given, flag)) fail(`${command} does not accept ${args[i]} here`);
    given[flag] = args[i + 1];
  }
  for (const flag of flags) if (!Object.hasOwn(given, flag)) fail(`${command} needs --${flag}`);
  if (command === 'args') return { command, rest: read(given.file) };
  if (command === 'select') {
    let input;
    try { input = JSON.parse(read(given.input)); } catch (e) { if (e instanceof InputError) throw e; fail(`--input is not JSON: ${e.message}`); }
    exact(input, SELECT, 'input', OPTIONAL.select);
    oneTarget(input, 'input');
    return { command, ...input };
  }
  oneTarget(given, command);
  const [kind] = ['issue', 'discussion'].filter((k) => Object.hasOwn(given, k));
  if (!REPO_RE.test(given.repo)) fail('--repo must be owner/name');
  if (!/^[1-9]\d*$/.test(given[kind])) fail(`--${kind} must be a positive integer`);
  if (!RUN_RE.test(given.run)) fail('--run must be <YYYYMMDDTHHMMSSZ>-<8 hex>');
  if (!SHA_RE.test(given.baseline)) fail('--baseline must be a 40-hex commit');
  if (Object.hasOwn(given, 'feat') !== Object.hasOwn(given, 'part')) fail('--feat and --part go together');
  const mode = {};
  if (given.feat !== undefined) {
    const [, i, m] = /^([1-9])\/([1-9])$/.exec(given.part) ?? [];
    if (!KEY_RE.test(given.feat)) fail('--feat must be FT_<n>');
    if (!i || Number(i) > Number(m)) fail('--part must be <i>/<m> with 1 <= i <= m <= 9');
    Object.assign(mode, { feat: given.feat, part: { i: Number(i), m: Number(m) } });
  }
  return { command, body: read(given.body), repo: given.repo, [kind]: Number(given[kind]), run: given.run, baseline: given.baseline, ...mode };
}

const RUN = { args: ({ rest }) => resolveArgs(rest), select: selectComments, outgoing: checkOutgoing };

export function main(argv) {
  let result;
  try {
    const { command, ...input } = readInput(argv);
    result = RUN[command](input);
  } catch (e) {
    if (!(e instanceof InputError)) throw e;
    console.error(`summary-comment: ${e.message}`);
    console.error(`usage: summary-comment.mjs ${Object.entries(FLAGS).map(([c, f]) => `${c} ${f.map((x) => `--${x} VALUE`).join(' ')}`).join(' | ')} --issue N|--discussion N [--feat FT_<k> --part <i>/<m>]`);
    return 2;
  }
  console.log(JSON.stringify(result));
  return result.action === 'stop' ? 1 : 0;
}

if (isMainModule(import.meta.url, process.argv[1])) process.exit(main(process.argv.slice(2)));
