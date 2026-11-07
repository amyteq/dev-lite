import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromMarkdown } from 'mdast-util-from-markdown';

// Deterministic checks for dev-refine-issue. Each one inspects only what this skill writes: its
// AUTO region, task marker, Execution pointer and marked AC block. Any other shape stops. Exit 0
// proceeds, 1 stops, and 2 means the check did not run, which never counts as a pass.

const GENERATOR = 'dev-refine-issue';
const BEGIN = '<!-- AUTO:BEGIN -->';
const END = '<!-- AUTO:END -->';
const BODY_MARKER = /^<!--\s*([a-z0-9-]+):body\s*-->$/;
const ACS_BEGIN = '<!-- acs:begin -->';
const ACS_END = '<!-- acs:end -->';
const EXECUTION = '## Execution';
const POINTER = '**Current task:**';
const COMMENT_LINK = /https:\/\/github\.com\/([^/\s()]+\/[^/\s()]+)\/issues\/(\d+)#issuecomment-(\d+)/g;

const stop = (reason, detail) => ({ action: 'stop', reason, detail });
const lines = (text) => text.split(/\r\n|\n|\r/);

function splitKeepingTerminators(text) {
  const rows = [];
  let start = 0;
  for (const match of text.matchAll(/\r\n|\n|\r/g)) {
    rows.push([text.slice(start, match.index), match[0]]);
    start = match.index + match[0].length;
  }
  rows.push([text.slice(start), '']);
  return rows;
}

// Line numbers the parser reads as a one-line HTML node, where a marker is a region edge; numbers inside a
// code block or longer HTML comment, where a marker or pointer is quoted; and where a depth 1 or 2 heading starts.
function classifyLines(markdown) {
  const standalone = new Set();
  const quoted = new Set();
  const headings = new Set();
  const pending = [fromMarkdown(markdown)];
  while (pending.length) {
    const { type, depth, position: { start, end }, children } = pending.pop();
    if (type === 'html' && start.line === end.line) standalone.add(start.line);
    else if (type === 'html' || type === 'code') for (let n = start.line; n <= end.line; n += 1) quoted.add(n);
    else if (type === 'heading' && depth <= 2) headings.add(start.line);
    if (children) pending.push(...children);
  }
  return { standalone, quoted, headings };
}

/** Every AUTO region with byte offsets, plus every marker that could not be paired or seen. */
export function findAutoRegions(text) {
  const regions = [];
  const problems = [];
  const { standalone } = classifyLines(text);
  let open = null;
  let offset = 0;
  let number = 0;
  for (const [line, terminator] of splitKeepingTerminators(text)) {
    const start = offset;
    number += 1;
    offset += line.length + terminator.length;
    const marker = line.trim();
    if (marker !== BEGIN && marker !== END) continue;
    if (!standalone.has(number)) problems.push({ kind: 'hidden-marker', line: number });
    else if (marker === BEGIN) {
      if (open) problems.push({ kind: 'nested-begin', line: number });
      else open = { start, contentStart: offset, line: number };
    } else if (!open) problems.push({ kind: 'unopened-end', line: number });
    else {
      regions.push({ start: open.start, contentStart: open.contentStart, contentEnd: start, end: offset });
      open = null;
    }
  }
  if (open) problems.push({ kind: 'unclosed-begin', line: open.line });
  for (const region of regions) {
    const first = lines(text.slice(region.contentStart, region.contentEnd)).find((row) => row.trim() !== '');
    region.generator = first?.trim().match(BODY_MARKER)?.[1] ?? null;
  }
  return { regions, problems };
}

// Plan the one issue-body write. `snapshot` is the body this run prepared against and `live`
// the body read just before writing, so a concurrent edit stops instead of being overwritten.
export function planBodyAmendment({ snapshot, live, region }) {
  if (live !== snapshot) return stop('concurrent-edit', 'the live body differs from the snapshot this run prepared against');
  const prepared = findAutoRegions(region);
  const [only] = prepared.regions;
  if (prepared.problems.length || prepared.regions.length !== 1 || only.generator !== GENERATOR ||
      region.slice(0, only.start).trim() !== '' || region.slice(only.end).trim() !== '') {
    return stop('invalid-region', `the prepared region must be exactly one ${GENERATOR} AUTO region`);
  }
  const exact = region.slice(only.start, only.end);
  const block = exact.endsWith('\n') ? exact : `${exact}\n`;

  const found = findAutoRegions(live);
  if (found.problems.length) return stop('malformed-regions', found.problems.map((p) => `${p.kind} at line ${p.line}`).join('; '));
  if (found.regions.length > 1) return stop('multiple-regions', `the body carries ${found.regions.length} AUTO regions`);
  if (found.regions.length === 1) {
    const [target] = found.regions;
    if (target.generator !== GENERATOR) {
      return stop('foreign-region', `the existing AUTO region declares ${target.generator ?? 'no generator'}`);
    }
    return { action: 'replace', body: live.slice(0, target.start) + block + live.slice(target.end) };
  }
  // One blank line separates the human body from the new region, counted in the body's own
  // line terminators so a CRLF body gains no extra blank line.
  const newline = live.includes('\r\n') ? '\r\n' : '\n';
  const trailing = live.match(/(?:\r\n|\n|\r)*$/)[0].match(/\r\n|\n|\r/g)?.length ?? 0;
  const gap = live === '' ? '' : newline.repeat(Math.max(0, 2 - trailing));
  return { action: 'append', body: live + gap + block };
}

// Compare the stored body with the body read before writing. This proves the human-owned
// bytes survived; the read-back permalink and pointer prove that the write landed.
export function verifyPublishedBody({ before, after }) {
  const violations = [];
  const published = findAutoRegions(after);
  const original = findAutoRegions(before);
  const [landed] = published.regions, [target] = original.regions;
  if (published.problems.length) violations.push('the published body has malformed AUTO regions');
  if (published.regions.length !== 1 || landed.generator !== GENERATOR) {
    violations.push(`the published body must carry exactly one ${GENERATOR} AUTO region`);
  }
  // Cut each body at its own region boundary: an unanchored test passes when the lost bytes repeat the region's own edge.
  const replaced = !original.problems.length && original.regions.length === 1 && target.generator === GENERATOR;
  if (replaced && (!landed || after.slice(0, landed.start) !== before.slice(0, target.start) ||
      after.slice(landed.end) !== before.slice(target.end))) {
    violations.push('human-owned bytes outside the generated region changed');
  } else if (!replaced && !after.startsWith(before)) {
    violations.push('the original body is no longer a byte prefix of the published body');
  }
  return violations;
}

// The bytes between the one begin line and the one end line, or null for any other shape.
// Only whole lines equal to a marker count, so a marker quoted inside AC text is ignored.
function acBlock(text) {
  const begins = [];
  const ends = [];
  let offset = 0;
  for (const [line, terminator] of splitKeepingTerminators(text)) {
    if (line === ACS_BEGIN) begins.push(offset + line.length + terminator.length);
    if (line === ACS_END) ends.push(offset);
    offset += line.length + terminator.length;
  }
  const single = begins.length === 1 && ends.length === 1 && ends[0] >= begins[0];
  return single ? text.slice(begins[0], ends[0]) : null;
}

export function compareAcBlocks({ issueBody, taskComment }) {
  const issue = acBlock(issueBody);
  const task = acBlock(taskComment);
  const violations = [];
  for (const [name, block] of [['issue body', issue], ['task comment', task]]) {
    if (block === null) violations.push(`${name}: needs exactly one ${ACS_BEGIN} line followed by one ${ACS_END} line`);
  }
  if (issue !== null && task !== null && issue !== task) {
    violations.push('the marked AC blocks in the issue body and the task comment are not byte-equal');
  }
  return violations;
}

const taskMarkerPrefix = (repo, issue) => `<!-- ${GENERATOR}:task repo=${repo} issue=${issue} revision=`;

// The revision of an exact task marker for this repository and issue, or null.
function markerRevision(line, repo, issue) {
  const prefix = taskMarkerPrefix(repo, issue);
  if (!line.startsWith(prefix) || !line.endsWith(' -->')) return null;
  const revision = line.slice(prefix.length, -' -->'.length);
  return /^[1-9]\d*$/.test(revision) ? Number(revision) : null;
}

export function checkOutgoingMarker({ body, repo, issue, revision }) {
  const expected = `${taskMarkerPrefix(repo, issue)}${revision} -->`;
  return lines(body)[0] === expected ? [] : [`the first line must be exactly ${expected}`];
}

// The live Execution pointer is a visible line in the `## Execution` section of this skill's own generated
// region, where the template writes it: that heading to the next depth 1 or 2 heading the parser reads. A copy
// outside that section, in prose, a code fence or a longer HTML comment is not it, and a region without the
// heading holds none. Null means the pointer cannot be located at all: malformed, multiple or foreign
// regions, or two Execution headings.
function executionPointers(text) {
  const { regions, problems } = findAutoRegions(text);
  const [only] = regions;
  if (problems.length || regions.length > 1 || (only && only.generator !== GENERATOR)) return null;
  const content = only ? text.slice(only.contentStart, only.contentEnd) : '';
  const { quoted, headings } = classifyLines(content);
  const visible = lines(content).map((line, index) => (quoted.has(index + 1) ? '' : line));
  const heading = visible.indexOf(EXECUTION);
  if (heading !== visible.lastIndexOf(EXECUTION)) return null;
  const end = visible.findIndex((line, index) => index > heading && headings.has(index + 1));
  return heading < 0 ? [] : visible.slice(heading + 1, end < 0 ? undefined : end).filter((line) => line.startsWith(POINTER));
}

// Choose the task comment to work on. Two states proceed, each only on a complete scan: one
// pointer to this login's exact marker with no later task comment of ours, or no pointer and
// no task comment of ours. A partial scan cannot show that no later task comment exists, so it
// stops even when the pointer and its comment were found. Every other state stops and lists
// the comment IDs. Another login's marker is reported and never adopted.
export function selectTask({ repo, issue, login, scanComplete, issueBody, comments }) {
  const firstLine = (entry) => lines(entry.body)[0];
  const markerLike = comments.filter((entry) => firstLine(entry).includes(`${GENERATOR}:task`));
  const own = markerLike.filter((entry) => entry.author === login);
  const foreign = markerLike.filter((entry) => entry.author !== login).map((entry) => entry.id);
  const pointers = executionPointers(issueBody);
  const links = (pointers ?? []).flatMap((line) => [...line.matchAll(COMMENT_LINK)]);

  if (pointers?.length === 0 && scanComplete === true && own.length === 0) {
    return { action: 'publish-revision-1', foreign };
  }
  if (scanComplete === true && pointers?.length === 1 && links.length === 1) {
    const [, linkRepo, linkIssue, linkId] = links[0];
    const target = comments.find((entry) => entry.id === Number(linkId));
    const revision = target ? markerRevision(firstLine(target), repo, issue) : null;
    if (linkRepo === repo && Number(linkIssue) === issue && target?.author === login &&
        revision !== null && !own.some((entry) => entry.id > target.id)) {
      return { action: 'use-current', commentId: target.id, revision, foreign };
    }
  }
  const commentIds = [...new Set([...links.map((link) => Number(link[3])), ...own.map((entry) => entry.id)])]
    .sort((a, b) => a - b);
  return { action: 'stop', reason: 'ambiguous', commentIds, foreign };
}

// ---- One input boundary: every flag and key is required, exactly typed and checked here. ----

class InputError extends Error {}
const fail = (message) => { throw new InputError(message); };

const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POSITIVE = /^[1-9]\d*$/;
const types = {
  repo: [(value) => typeof value === 'string' && REPO_NAME.test(value), 'an owner/name string'],
  positive: [(value) => Number.isSafeInteger(value) && value > 0, 'a positive integer'],
  login: [(value) => typeof value === 'string' && /^\S+$/.test(value), 'a non-empty login string'],
  boolean: [(value) => typeof value === 'boolean', 'a boolean'],
  string: [(value) => typeof value === 'string', 'a string'],
  array: [(value) => Array.isArray(value), 'an array'],
};
const SELECTION = { repo: 'repo', issue: 'positive', login: 'login', scanComplete: 'boolean', issueBody: 'string', comments: 'array' };
const COMMENT = { id: 'positive', author: 'login', body: 'string' };

function exactObject(value, schema, at) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${at} must be a JSON object`);
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(schema, key)) fail(`${at} has the unknown key "${key}"`);
  }
  for (const [key, type] of Object.entries(schema)) {
    const [valid, expected] = types[type];
    if (!Object.hasOwn(value, key) || !valid(value[key])) fail(`${at}.${key} must be ${expected}`);
  }
  return value;
}

const readText = (path) => readFileSync(path, 'utf8');
const COMMANDS = {
  plan: ['snapshot', 'live', 'region', 'out'], preserve: ['before', 'after'], acs: ['issue-body', 'task'],
  outgoing: ['body', 'repo', 'issue', 'revision'], select: ['input'],
};

/** Parse argv into a validated command input, or throw InputError. Nothing downstream re-checks. */
export function readInput(argv) {
  const [command, ...args] = argv;
  const flags = Object.hasOwn(COMMANDS, command ?? '') ? COMMANDS[command] : fail('unknown or missing command');
  const given = {};
  if (args.length !== flags.length * 2) fail(`${command} takes exactly ${flags.map((flag) => `--${flag}`).join(' ')}`);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index].replace(/^--/, '');
    if (!args[index].startsWith('--') || !flags.includes(flag) || Object.hasOwn(given, flag)) {
      fail(`${command} does not accept ${args[index]} here`);
    }
    given[flag] = args[index + 1];
  }
  if (command === 'plan') {
    return { command, out: given.out, snapshot: readText(given.snapshot), live: readText(given.live), region: readText(given.region) };
  }
  if (command === 'preserve') return { command, before: readText(given.before), after: readText(given.after) };
  if (command === 'acs') return { command, issueBody: readText(given['issue-body']), taskComment: readText(given.task) };
  if (command === 'outgoing') {
    if (!REPO_NAME.test(given.repo) || !POSITIVE.test(given.issue) || !POSITIVE.test(given.revision)) {
      fail('outgoing needs --repo owner/name and positive integers for --issue and --revision');
    }
    return { command, body: readText(given.body), repo: given.repo, issue: Number(given.issue), revision: Number(given.revision) };
  }
  let parsed;
  try {
    parsed = JSON.parse(readText(given.input));
  } catch (error) {
    fail(`--input is not readable JSON: ${error.message}`);
  }
  const input = exactObject(parsed, SELECTION, 'input');
  const ids = new Set();
  for (const [index, entry] of input.comments.entries()) {
    exactObject(entry, COMMENT, `input.comments[${index}]`);
    if (ids.has(entry.id)) fail(`input.comments[${index}].id repeats ${entry.id}`);
    ids.add(entry.id);
  }
  return { command, ...input };
}

// Each command returns whether the run may proceed and the lines to print.
const verdict = (check) => (input) => {
  const violations = check(input);
  return [violations.length === 0, violations];
};
const run = {
  plan: ({ out, ...input }) => {
    const result = planBodyAmendment(input);
    if (result.action === 'stop') {
      // A plan an earlier run left at --out must not survive to be published by mistake.
      rmSync(out, { force: true });
      return [false, [`${result.reason}: ${result.detail}`]];
    }
    writeFileSync(out, result.body);
    return [true, [`${out}: ${result.action}`]];
  },
  preserve: verdict(verifyPublishedBody),
  acs: verdict(compareAcBlocks),
  outgoing: verdict(checkOutgoingMarker),
  select: (input) => {
    const decision = selectTask(input);
    return [decision.action !== 'stop', [JSON.stringify(decision)]];
  },
};

export function main(argv) {
  let proceed, output;
  try {
    const { command, ...input } = readInput(argv);
    [proceed, output] = run[command](input);
  } catch (error) {
    // A read, parse or write failure is a check that did not run, never a stop or a pass.
    console.error(`check-refinement: ${error.message}`);
    if (error instanceof InputError) {
      console.error(`Usage: node check-refinement.mjs ${Object.entries(COMMANDS)
        .map(([name, flags]) => `${name} ${flags.map((flag) => `--${flag} VALUE`).join(' ')}`).join(' | ')}`);
    }
    return 2;
  }
  for (const line of output) console.log(line);
  return proceed ? 0 : 1;
}

function isDirectInvocation(entryPath) {
  try { return Boolean(entryPath) && realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isDirectInvocation(process.argv[1])) process.exitCode = main(process.argv.slice(2));
