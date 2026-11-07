#!/usr/bin/env node
// Per-run record for dev-analyse-rp (references/evaluation.md): the cost and time of one
// analysis call, its record row, and the plan for the one record-table comment the evaluator
// keeps on the request-pack issue. Pure over files: no network, clock or repository access,
// so every timestamp arrives as an argument and every GitHub call stays in the procedure.
//
// node run-record.mjs cost --run <result.json> [--resumed]
// node run-record.mjs cost --transcript <file.jsonl> [--transcript <file.jsonl> ...] --start <utc> --end <utc>
// node run-record.mjs row --cost <cost.json> --input <fields.json>
// node run-record.mjs append --scan <scan.json> --row <row.md> --footer <footer.txt> --out <planned.md>
// Exit 0 = proceed, 1 = stop, 2 = did not run (usage or read error); 1 and 2 both block the write.
import fs from 'node:fs';
import { isMainModule } from './check-proposal.mjs';

export const UNKNOWN = 'unknown';
export const MAX_BODY = 60000; // GitHub rejects a comment body over 65,536 characters.
const MARKER_PREFIX = '<!-- dev-analyse-rp:eval-record';
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
// The shape alone admits hour 25 or 31 September, so a timestamp must also survive a round trip.
const parseUtc = (v) => {
  const t = typeof v === 'string' && UTC_RE.test(v) ? Date.parse(v) : NaN;
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 19) === v.slice(0, 19) ? t : NaN;
};
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// Output name, result-JSON `modelUsage` key, transcript `message.usage` key.
const TOKEN_FIELDS = [
  ['input_tokens', 'inputTokens', 'input_tokens'],
  ['output_tokens', 'outputTokens', 'output_tokens'],
  ['cache_write_tokens', 'cacheCreationInputTokens', 'cache_creation_input_tokens'],
  ['cache_read_tokens', 'cacheReadInputTokens', 'cache_read_input_tokens'],
];
const OUTPUT = TOKEN_FIELDS.findIndex(([name]) => name === 'output_tokens');
const COST_FIELDS = ['source', 'result', 'wall_ms', 'api_ms', 'turns', 'cost_usd', ...TOKEN_FIELDS.map(([name]) => name)];
const COUNT_FIELDS = ['blind_items', 'manifest_rows', 'gaps', 'conflicts', 'homes_missed_or_wrong'];
const EXIT_FIELDS = ['checker_exit', 'verify_homes_exit'];

export const HEADER = '| Evaluated (UTC) | Evaluator | Pack | Baseline | Result | Wall / API (s) | Turns'
  + ' | Tokens in / out / cache write / cache read | Cost (USD) | Cost source | Blind items | Manifest rows'
  + ' | Gaps | Conflicts | Missed or wrong homes | Checker / verify-homes |';
const COLUMNS = HEADER.split('|').length - 2;
const SEPARATOR = `|${'---|'.repeat(COLUMNS)}`;
const PREAMBLE = [
  '## `/dev-analyse-rp` evaluation record',
  '',
  'One row per evaluated analysis call, appended by the `/dev-analyse-rp` evaluator (`references/evaluation.md`). `?` means the source did not record the value.',
  '',
];

export class Stop extends Error {}
export class UsageError extends Error {}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (v) => Number.isInteger(v) && v >= 0;
const count = (v) => (isCount(v) ? v : UNKNOWN);
const amount = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : UNKNOWN);
export const markerFor = (repo, issue) => `<!-- dev-analyse-rp:eval-record repo=${repo} issue=${issue} -->`;

// --- cost ----------------------------------------------------------------------

// Tokens come from `modelUsage`, the per-model totals that `total_cost_usd` is priced from.
// A session that a background task re-invokes prints one result per segment, numbered by
// `result_index`; its API time, cost and `modelUsage` are session totals, but `duration_ms` and
// `num_turns` cover the last segment only. A session resumed with `--resume` keeps
// `result_index` 0 and its totals while those two restart, which can show as API time above
// wall time but need not, so `--resumed` marks a call known to be resumed. They are copied only
// when no sign is present.
export function costFromResult(result, { resumed = false } = {}) {
  const whole = !resumed && result.result_index === 0 && isCount(result.duration_api_ms) && isCount(result.duration_ms)
    && result.duration_api_ms <= result.duration_ms;
  const models = isObject(result.modelUsage) ? Object.values(result.modelUsage) : [];
  const sum = (key) => (models.length && models.every((m) => isObject(m) && isCount(m[key]))
    ? models.reduce((total, m) => total + m[key], 0) : UNKNOWN);
  const subtype = typeof result.subtype === 'string' && result.subtype ? result.subtype : UNKNOWN;
  const out = {
    source: 'headless-json',
    // An API error can report subtype `success` beside `is_error: true`; never record that as a success.
    result: result.is_error === true && subtype === 'success' ? 'error' : subtype,
    wall_ms: whole ? count(result.duration_ms) : UNKNOWN,
    api_ms: count(result.duration_api_ms),
    turns: whole ? count(result.num_turns) : UNKNOWN,
    cost_usd: amount(result.total_cost_usd),
  };
  for (const [name, modelKey] of TOKEN_FIELDS) out[name] = sum(modelKey);
  out.models = isObject(result.modelUsage) ? Object.keys(result.modelUsage).sort() : [];
  out.subagents = count(result.subagent_stats?.spawned);
  return out;
}

// One API response is split across several records, so each `message.id` counts once. Its
// input and cache counts are known when the response starts and must agree. Only the record
// that carries `stop_reason` holds the final output count: earlier records hold the count at
// that point in the stream. A response with no such record never recorded its output, so the
// total is unknown rather than a partial sum.
export function costFromTranscripts(records, start, end) {
  const byId = new Map();
  const models = new Set();
  for (const { where, record } of records) {
    if (!isObject(record) || record.type !== 'assistant') continue;
    const id = record.message?.id;
    const usage = record.message?.usage;
    const at = parseUtc(record.timestamp);
    if (typeof id !== 'string' || !isObject(usage) || Number.isNaN(at)) {
      throw new Stop(`${where}: assistant record without message.id, usage or a UTC timestamp`);
    }
    if (at < start || at > end) continue;
    const counts = TOKEN_FIELDS.map(([, , key]) => usage[key]);
    if (!counts.every(isCount)) throw new Stop(`${where}: usage of ${id} lacks a token count`);
    const held = byId.get(id) ?? { counts, output: UNKNOWN };
    if (held.counts.some((c, i) => i !== OUTPUT && c !== counts[i])) throw new Stop(`${where}: records of ${id} disagree on input or cache usage`);
    if (record.message.stop_reason != null) {
      if (held.output !== UNKNOWN && held.output !== counts[OUTPUT]) throw new Stop(`${where}: final records of ${id} disagree on output`);
      held.output = counts[OUTPUT];
    }
    byId.set(id, held);
    if (typeof record.message.model === 'string') models.add(record.message.model);
  }
  if (byId.size === 0) throw new Stop('no assistant record inside the window');
  const held = [...byId.values()];
  const out = { source: 'transcript', result: UNKNOWN, wall_ms: end - start, api_ms: UNKNOWN, turns: UNKNOWN, cost_usd: UNKNOWN };
  TOKEN_FIELDS.forEach(([name], i) => { out[name] = held.reduce((total, h) => total + h.counts[i], 0); });
  const unfinished = held.filter((h) => h.output === UNKNOWN).length;
  out.output_tokens = unfinished ? UNKNOWN : held.reduce((total, h) => total + h.output, 0);
  out.models = [...models].sort();
  out.api_calls = byId.size;
  out.api_calls_without_final_output = unfinished;
  return out;
}

// --- row -----------------------------------------------------------------------

const cell = (v) => (v === UNKNOWN ? '?' : String(v));
const seconds = (ms) => (ms === UNKNOWN ? '?' : String(Math.round(ms / 1000)));

function text(fields, name, pattern) {
  const v = fields[name];
  if (typeof v !== 'string' || !v.trim()) throw new Stop(`field ${name} is missing or empty`);
  if (/[|\n\r]/.test(v)) throw new Stop(`field ${name} holds a | or a line break`);
  if (pattern && !pattern.test(v)) throw new Stop(`field ${name} is malformed: ${JSON.stringify(v)}`);
  return v;
}

function known(fields, name, valid) {
  if (!(name in fields)) throw new Stop(`field ${name} is missing`);
  const v = fields[name];
  if (v !== UNKNOWN && !valid(v)) throw new Stop(`field ${name} is malformed: ${JSON.stringify(v)}`);
  return v;
}

export function renderRow(cost, fields) {
  for (const name of COST_FIELDS) if (!(name in cost)) throw new Stop(`cost field ${name} is missing`);
  const c = {
    source: text(cost, 'source', /^(headless-json|transcript)$/),
    result: text(cost, 'result'),
    ...Object.fromEntries(['wall_ms', 'api_ms', 'turns', ...TOKEN_FIELDS.map(([name]) => name)]
      .map((name) => [name, known(cost, name, isCount)])),
    cost_usd: known(cost, 'cost_usd', (v) => amount(v) !== UNKNOWN),
  };
  const evaluated = text(fields, 'evaluated', { test: (v) => !Number.isNaN(parseUtc(v)) });
  const evaluator = text(fields, 'evaluator');
  const pack = text(fields, 'pack');
  const baseline = text(fields, 'baseline', /^[0-9a-f]{7,40}$/);
  const counts = Object.fromEntries(COUNT_FIELDS.map((name) => [name, known(fields, name, isCount)]));
  const exits = EXIT_FIELDS.map((name) => known(fields, name, (v) => Number.isInteger(v) && v >= 0 && v <= 255));
  const tokens = TOKEN_FIELDS.map(([name]) => cell(c[name])).join(' / ');
  return `| ${[
    evaluated, evaluator, pack, `\`${baseline.slice(0, 8)}\``, cell(c.result), `${seconds(c.wall_ms)} / ${seconds(c.api_ms)}`,
    cell(c.turns), tokens, c.cost_usd === UNKNOWN ? '?' : c.cost_usd.toFixed(2), c.source,
    ...COUNT_FIELDS.map((name) => cell(counts[name])), exits.map(cell).join(' / '),
  ].join(' | ')} |`;
}

// --- append --------------------------------------------------------------------

const render = (marker, rows, footer) => `${[marker, ...PREAMBLE, HEADER, SEPARATOR, ...rows, '', footer].join('\n')}\n`;
const cells = (line) => line.split('|').length - 2;

// The comment is recognised only in exactly the shape `render` writes; anything else is
// reported with what was found, never repaired.
function parseRecord(body, marker) {
  const lines = body.split('\n');
  const head = [marker, ...PREAMBLE, HEADER, SEPARATOR];
  const differs = head.findIndex((line, i) => lines[i] !== line);
  if (differs !== -1) return { found: `line ${differs + 1} differs from the record template` };
  let i = head.length;
  while (i < lines.length && lines[i].startsWith('|')) i++;
  const rows = lines.slice(head.length, i);
  if (!rows.length) return { found: 'no row under the table header' };
  const bad = rows.findIndex((row) => !row.startsWith('| ') || !row.endsWith(' |') || cells(row) !== COLUMNS);
  if (bad !== -1) return { found: `row ${bad + 1} does not have the table's ${COLUMNS} cells` };
  const tail = lines.slice(i);
  if (tail.slice(2).some((line) => line.startsWith('|'))) return { found: 'a second table after the footer' };
  if (tail.length !== 3 || tail[0] !== '' || !tail[1] || tail[2] !== '') return { found: 'text after the footer' };
  return { rows, prefixLength: lines.slice(0, i).join('\n').length };
}

export function planAppend(scan, row, footer) {
  const stop = (reason, commentIds = []) => ({ action: 'stop', reason, commentIds, foreign });
  const foreign = [];
  if (!scan.scanComplete) return stop('the comment scan is incomplete');
  const marker = markerFor(scan.repo, scan.issue);
  const ours = [];
  const misplaced = [];
  for (const c of scan.comments) {
    if (!c.body.includes(MARKER_PREFIX)) continue;
    if (c.author !== scan.login) foreign.push(c.id);
    else if (c.body.split('\n', 1)[0] === marker) ours.push(c);
    else misplaced.push(c.id);
  }
  if (misplaced.length) return stop('a record marker names another repository or issue, or is not on the first line', misplaced);
  if (ours.length > 1) return stop('more than one record comment by this login', ours.map((c) => c.id));
  let body;
  let commentId = null;
  if (!ours.length) {
    body = render(marker, [row], footer);
  } else {
    commentId = ours[0].id;
    const parsed = parseRecord(ours[0].body, marker);
    if (parsed.found) return stop(`the record comment is not recognised: ${parsed.found}`, [commentId]);
    if (parsed.rows.at(-1) === row) return { action: 'noop', commentId, foreign };
    if (parsed.rows.includes(row)) return stop('the row is already recorded above the last row', [commentId]);
    body = `${ours[0].body.slice(0, parsed.prefixLength)}\n${row}\n\n${footer}\n`;
  }
  if (body.length > MAX_BODY) return stop(`the planned body has ${body.length} characters, over ${MAX_BODY}`, commentId ? [commentId] : []);
  return { action: commentId ? 'append' : 'create', commentId, body, foreign };
}

// --- CLI: the one input boundary -------------------------------------------------

function readText(path) {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch (e) {
    throw new UsageError(`cannot read ${path}: ${e.code ?? e.message}`);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readText(path));
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError(`${path} does not parse as JSON`);
  }
}

function readObject(path) {
  const v = readJson(path);
  if (!isObject(v)) throw new UsageError(`${path} is not a JSON object`);
  return v;
}

// One line, the trailing newline a shell redirect adds removed.
function readLine(path, what) {
  const v = readText(path).replace(/\n$/, '');
  if (!v || /[\n\r]/.test(v)) throw new UsageError(`${path}: the ${what} must be one non-empty line`);
  return v;
}

function utc(value, flag) {
  const t = parseUtc(value);
  if (Number.isNaN(t)) throw new UsageError(`${flag} must be a UTC timestamp such as 2026-10-17T09:30:00Z`);
  return t;
}

function flags(argv, allowed, repeatable = []) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!allowed.includes(flag) || value === undefined || value.startsWith('--')) throw new UsageError(`unexpected argument ${flag}`);
    if (repeatable.includes(flag)) (out[flag] ??= []).push(value);
    else if (flag in out) throw new UsageError(`${flag} given twice`);
    else out[flag] = value;
  }
  return out;
}

export function readRequest(argv) {
  const [command, ...rest] = argv;
  if (command === 'cost') {
    const resumed = rest.filter((arg) => arg === '--resumed').length;
    const f = flags(rest.filter((arg) => arg !== '--resumed'), ['--run', '--transcript', '--start', '--end'], ['--transcript']);
    if (f['--run'] && !f['--transcript'] && !f['--start'] && !f['--end'] && resumed < 2) {
      return { command, result: readObject(f['--run']), resumed: resumed === 1 };
    }
    if (f['--run'] || !f['--transcript'] || !f['--start'] || !f['--end'] || resumed) {
      throw new UsageError('cost takes --run [--resumed], or --transcript with --start and --end');
    }
    const start = utc(f['--start'], '--start');
    const end = utc(f['--end'], '--end');
    if (start > end) throw new UsageError('--start is after --end');
    const records = f['--transcript'].flatMap((path) => readText(path).split('\n').flatMap((line, n) => {
      if (!line.trim()) return [];
      try {
        return [{ where: `${path}:${n + 1}`, record: JSON.parse(line) }];
      } catch {
        throw new UsageError(`${path}:${n + 1} does not parse as JSON`);
      }
    }));
    return { command, records, start, end };
  }
  if (command === 'row') {
    const f = flags(rest, ['--cost', '--input']);
    if (!f['--cost'] || !f['--input']) throw new UsageError('row takes --cost and --input');
    return { command, cost: readObject(f['--cost']), fields: readObject(f['--input']) };
  }
  if (command === 'append') {
    const f = flags(rest, ['--scan', '--row', '--footer', '--out']);
    if (!f['--scan'] || !f['--row'] || !f['--footer'] || !f['--out']) throw new UsageError('append takes --scan, --row, --footer and --out');
    const scan = readObject(f['--scan']);
    const comments = Array.isArray(scan.comments) ? scan.comments : null;
    if (!REPO_RE.test(scan.repo ?? '') || !isCount(scan.issue) || scan.issue === 0 || typeof scan.login !== 'string' || !scan.login
      || typeof scan.scanComplete !== 'boolean' || !comments
      || !comments.every((c) => isObject(c) && isCount(c.id) && typeof c.author === 'string' && typeof c.body === 'string')) {
      throw new UsageError(`${f['--scan']} needs repo, issue, login, scanComplete and comments of {id, author, body}`);
    }
    const row = readLine(f['--row'], 'row');
    if (!row.startsWith('| ') || !row.endsWith(' |') || cells(row) !== COLUMNS) throw new UsageError(`${f['--row']}: not a ${COLUMNS}-cell record row`);
    const footer = readLine(f['--footer'], 'footer');
    if (footer.startsWith('|') || footer.startsWith(MARKER_PREFIX)) throw new UsageError(`${f['--footer']}: the footer must not start with | or the marker`);
    return { command, scan, row, footer, out: f['--out'] };
  }
  throw new UsageError('usage: run-record.mjs cost | row | append — see the header of run-record.mjs');
}

function main(argv) {
  let request;
  try {
    request = readRequest(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(e.message);
    return 2;
  }
  try {
    if (request.command === 'cost') {
      const cost = request.result
        ? costFromResult(request.result, { resumed: request.resumed })
        : costFromTranscripts(request.records, request.start, request.end);
      console.log(JSON.stringify(cost, null, 2));
    } else if (request.command === 'row') {
      console.log(renderRow(request.cost, request.fields));
    } else {
      const { body, ...decision } = planAppend(request.scan, request.row, request.footer);
      fs.rmSync(request.out, { force: true });
      if (body) fs.writeFileSync(request.out, body);
      console.log(JSON.stringify(decision, null, 2));
      if (decision.action === 'stop') return 1;
    }
    return 0;
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    console.error(`stop — ${e.message}`);
    return 1;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) process.exit(main(process.argv.slice(2)));
