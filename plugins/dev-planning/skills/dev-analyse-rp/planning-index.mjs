#!/usr/bin/env node
// Planning index for dev-analyse-rp (references/reconciliation.md): the feats and stories
// their docs' frontmatter declares at one commit, a check of a proposal's existing homes
// against that index, and the next free FT_/STY_ numbers. It reads committed repository
// files through git only; it never calls GitHub, so issue labels and tracking-issue bodies
// can never become index input.
//
// `node planning-index.mjs build --out <index.json>`, run from the repository root; reads HEAD.
// `node planning-index.mjs verify-homes <proposal.json> <index.json> [--json]`
// `node planning-index.mjs next <index.json> feat|story [count]`
// Exit 0 = built / no findings, 1 = build stopped / findings, 2 = CLI usage or unreadable input.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { FEAT_LABEL_RE as LABEL_RE, isMainModule, KEY_RES as KEY_RE, parseArguments } from './check-proposal.mjs';

const SCHEMA_TAG = 'PlanningIndexV1';
export const LEVELS = {
  feat: { dir: 'docs/feats', prefix: 'FT', fields: ['id', 'title', 'label', 'tracking_issue', 'status', 'superseded_by'] },
  story: { dir: 'docs/stories', prefix: 'STY', fields: ['id', 'title', 'feats', 'status', 'superseded_by'] },
};
const FILE_RE = /^(?<key>(?<prefix>FT|STY)_[1-9][0-9]*)_[a-z0-9]+(?:_[a-z0-9]+)*\.md$/;
const STATUSES = ['current', 'superseded', 'retired'];
const TERMINAL = ['superseded', 'retired'];
// Numbers 1 to 100 are reserved, so the first real FT_ or STY_ number is 101.
export const FIRST_NUMBER = 101;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;
const arr = (v) => (Array.isArray(v) ? v : []);
const keyNumber = (key) => Number(key.slice(key.indexOf('_') + 1));

// A stop names the repository path that made the index untrustworthy; the build writes nothing.
export class BuildStop extends Error {
  constructor(where, message) {
    super(`${where}: ${message}`);
    this.where = where;
  }
}

// --- frontmatter ---------------------------------------------------------------

function scalar(raw, at) {
  const v = raw.trim();
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v.startsWith('"')) {
    try { return JSON.parse(v); } catch { throw new BuildStop(at, `has an unterminated or malformed "quoted" value`); }
  }
  if (v.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(v)) throw new BuildStop(at, "has an unterminated 'quoted' value");
    return v.slice(1, -1).replace(/''/g, "'");
  }
  // shortcut: no YAML comments, anchors, flow maps or multi-line values; a plain value that could be one stops.
  if (/ #|^[&*!|>{]/.test(v)) throw new BuildStop(at, `quote the value ${JSON.stringify(v)}`);
  return v;
}

/**
 * The frontmatter subset the planning docs use: `key: value`, `key: [a, b]`, and `key:` followed by
 * `  - item` lines. Anything else stops rather than being read some other way.
 */
export function parseFrontmatter(text, where) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') throw new BuildStop(where, 'does not start with a --- frontmatter line');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new BuildStop(where, 'has no closing --- frontmatter line');
  const out = {};
  let list = null;
  for (const [i, raw] of lines.slice(1, end).entries()) {
    const at = `${where} frontmatter line ${i + 2}`;
    if (!raw.trim()) continue;
    const item = /^\s+-\s+(.*)$/.exec(raw);
    if (item) {
      if (!list) throw new BuildStop(at, 'has a list item outside a list');
      (out[list] ??= []).push(scalar(item[1], at));
      continue;
    }
    const m = /^([a-z_]+):(?:[ \t]+(.*))?$/.exec(raw);
    if (!m) throw new BuildStop(at, 'is not a `key: value` line');
    if (Object.hasOwn(out, m[1])) throw new BuildStop(at, `repeats ${m[1]}`);
    const value = (m[2] ?? '').trim();
    list = value === '' ? m[1] : null;
    if (value === '') out[m[1]] = null; // a bare key is null until an item follows
    else if (value.startsWith('[')) {
      if (!value.endsWith(']')) throw new BuildStop(at, 'has an unterminated [list]');
      const inner = value.slice(1, -1).trim();
      out[m[1]] = inner ? inner.split(',').map((x) => scalar(x, at)) : [];
    } else out[m[1]] = scalar(value, at);
  }
  return out;
}

// --- build ---------------------------------------------------------------------

function docRow(level, path, text) {
  const fm = parseFrontmatter(text, path);
  const { fields } = LEVELS[level];
  for (const key of Object.keys(fm)) if (!fields.includes(key)) throw new BuildStop(path, `has the unknown frontmatter key ${key}`);
  for (const key of fields) if (!Object.hasOwn(fm, key)) throw new BuildStop(path, `has no ${key}`);
  const expected = FILE_RE.exec(path.slice(path.lastIndexOf('/') + 1)).groups.key;
  if (fm.id !== expected) throw new BuildStop(path, `id ${JSON.stringify(fm.id)} is not the file name's ${expected}`);
  if (!isText(fm.title)) throw new BuildStop(path, 'title must be non-empty text');
  if (!STATUSES.includes(fm.status)) throw new BuildStop(path, `status ${JSON.stringify(fm.status)} is not one of ${STATUSES.join(', ')}`);
  if (fm.superseded_by !== null && !(typeof fm.superseded_by === 'string' && KEY_RE[level].test(fm.superseded_by))) {
    throw new BuildStop(path, `superseded_by must be null or a ${LEVELS[level].prefix}_<n> key`);
  }
  if ((fm.status === 'superseded') !== (fm.superseded_by !== null)) {
    throw new BuildStop(path, fm.status === 'superseded' ? 'is superseded without superseded_by' : `is ${fm.status} but names superseded_by`);
  }
  if (fm.superseded_by === fm.id) throw new BuildStop(path, 'supersedes itself');
  const row = { key: fm.id, level, title: fm.title };
  if (level === 'feat') {
    if (!(typeof fm.label === 'string' && LABEL_RE.test(fm.label))) throw new BuildStop(path, `label must match ${LABEL_RE}`);
    if (fm.tracking_issue !== null && !(Number.isSafeInteger(fm.tracking_issue) && fm.tracking_issue > 0)) {
      throw new BuildStop(path, 'tracking_issue must be null or a positive issue number');
    }
    Object.assign(row, { label: fm.label, tracking_issue: fm.tracking_issue });
  } else {
    const feats = fm.feats;
    if (!Array.isArray(feats) || !feats.length || !feats.every((f) => typeof f === 'string' && KEY_RE.feat.test(f))) {
      throw new BuildStop(path, 'feats must be a non-empty list of FT_<n> keys');
    }
    if (new Set(feats).size !== feats.length) throw new BuildStop(path, 'feats repeats a key');
    row.feats = feats;
  }
  return { ...row, status: fm.status, superseded_by: fm.superseded_by, path };
}

const unique = (rows, field, what) => {
  const seen = new Map();
  for (const r of rows) {
    if (r[field] === null) continue;
    if (seen.has(r[field])) throw new BuildStop(r.path, `${what} ${r[field]} is also ${seen.get(r[field])}'s`);
    seen.set(r[field], r.path);
  }
};

/** The index of `docs` ({path, text} at one commit), or a BuildStop naming the first doc that cannot be trusted. */
export function indexFromDocs(commit, docs) {
  const rows = [];
  for (const { path, text } of [...docs].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const level = Object.keys(LEVELS).find((l) => path.startsWith(`${LEVELS[l].dir}/`));
    if (!level || !path.endsWith('.md') || path === `${LEVELS[level].dir}/README.md`) continue;
    const name = path.slice(LEVELS[level].dir.length + 1);
    if (FILE_RE.exec(name)?.groups.prefix !== LEVELS[level].prefix) {
      throw new BuildStop(path, `is not named ${LEVELS[level].prefix}_<n>_<snake_slug>.md directly under ${LEVELS[level].dir}`);
    }
    rows.push(docRow(level, path, text));
  }
  unique(rows, 'key', 'id');
  const feats = rows.filter((r) => r.level === 'feat');
  unique(feats, 'label', 'label');
  unique(feats, 'tracking_issue', 'tracking issue');
  const known = new Set(rows.map((r) => r.key));
  for (const r of rows) {
    if (r.superseded_by !== null && !known.has(r.superseded_by)) throw new BuildStop(r.path, `superseded_by ${r.superseded_by} has no doc`);
    for (const f of arr(r.feats)) if (!known.has(f)) throw new BuildStop(r.path, `feats names ${f}, which has no doc`);
  }
  rows.sort((a, b) => (a.level === b.level ? keyNumber(a.key) - keyNumber(b.key) : a.level === 'feat' ? -1 : 1));
  const counts = { feat: feats.length, story: rows.length - feats.length };
  const digest = `sha256:${crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')}`;
  return { schema: SCHEMA_TAG, commit, digest, counts, rows };
}

const git = (root, args) => execFileSync('git', ['--no-optional-locks', '-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** The committed planning docs at `commit`: uncommitted edits are never read. */
export function readDocs(root, commit) {
  const dirs = Object.values(LEVELS).map((l) => l.dir);
  const paths = git(root, ['ls-tree', '-r', '-z', '--name-only', commit, '--', ...dirs]).split('\0').filter(Boolean);
  return paths.map((path) => ({ path, text: git(root, ['show', `${commit}:${path}`]) }));
}

export function buildIndex(root) {
  const commit = git(root, ['rev-parse', 'HEAD']).trim();
  return indexFromDocs(commit, readDocs(root, commit));
}

// One row per line: the reconciliation pass reads rows, and indentation would
// inflate the file the feat-first size rule measures.
export const serializeIndex = (index) =>
  `${JSON.stringify({ ...index, rows: undefined }).slice(0, -1)},"rows":[\n${index.rows.map((r) => JSON.stringify(r)).join(',\n')}\n]}\n`;

const isIndex = (index) => isObject(index) && index.schema === SCHEMA_TAG && Array.isArray(index.rows);

// --- next free numbers -----------------------------------------------------------

/** The next `count` numbers at a level: past every number the index holds, superseded and retired included, never below 101. */
export function nextKeys(index, level, count = 1) {
  const used = index.rows.filter((r) => r.level === level).map((r) => keyNumber(r.key));
  const first = Math.max(FIRST_NUMBER - 1, ...used) + 1;
  return Array.from({ length: count }, (_, i) => `${LEVELS[level].prefix}_${first + i}`);
}

// --- verify-homes ------------------------------------------------------------

// Checks only what needs the index; check-proposal.mjs owns the projection's own shape.
export function verifyHomes(proposal, index) {
  const findings = [];
  const add = (code, where, message) => findings.push({ code, where, message });
  if (!isIndex(index)) {
    add('INDEX_MISMATCH', 'index', `the index is not a ${SCHEMA_TAG} document`);
    return findings;
  }
  const p = isObject(proposal) ? proposal : {};
  const baseline = isObject(p.baseline) ? p.baseline : {};
  if (index.commit !== baseline.commit) add('INDEX_MISMATCH', 'baseline.commit', `index commit ${index.commit} is not the baseline commit`);
  if (index.digest !== baseline.planning_index?.digest) {
    add('INDEX_MISMATCH', 'baseline.planning_index.digest', 'the index digest differs from the one the packet recorded');
  }
  const byKey = new Map(index.rows.filter(isObject).map((r) => [r.key, r]));
  for (const [i, h] of arr(p.homes).filter(isObject).entries()) {
    const row = byKey.get(h.key);
    const at = `homes[${i}]`;
    if (!row) add('HOME_KEY_UNKNOWN', at, `${h.key} is not in the index`);
    else if (row.level !== h.level) add('HOME_KEY_UNKNOWN', at, `${h.key} is a ${row.level}, not a ${h.level}`);
    else if (TERMINAL.includes(row.status)) {
      add('HOME_KEY_UNKNOWN', at, `${h.key} is ${row.status}${row.superseded_by ? ` by ${row.superseded_by}` : ''} and cannot be a home`);
    }
  }
  for (const u of arr(p.units).filter(isObject)) {
    const home = isObject(u.home) ? u.home : {};
    if (home.relation !== 'amend' && home.relation !== 'supersede') continue;
    const at = `units.${u.id ?? '?'}.home.dependents`;
    // An omitted list is a reconciliation nobody performed, never an empty dependent set.
    if (!Array.isArray(home.dependents)) add('HOME_DEPENDENTS', at, `${home.key} declares no list of the stories that depend on it`);
    else {
      const strays = home.dependents.filter((d) => byKey.get(d)?.level !== 'story');
      if (strays.length) add('HOME_DEPENDENTS', at, `${strays.join(', ')} ${strays.length > 1 ? 'are not stories' : 'is not a story'} in the index`);
    }
  }
  return findings;
}

// --- CLI ---------------------------------------------------------------------

const USAGE = 'usage: planning-index.mjs build --out <index.json> | verify-homes <proposal.json> <index.json> [--json] | next <index.json> feat|story [count]';

function next(rest) {
  const [file, level, count = '1'] = rest;
  if (rest.length < 2 || rest.length > 3 || !Object.hasOwn(LEVELS, level) || !/^[1-9]\d{0,2}$/.test(count)) {
    console.error(USAGE);
    return 2;
  }
  let index;
  try {
    index = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`cannot read input: ${e.message}`);
    return 2;
  }
  if (!isIndex(index)) {
    console.error(`${file} is not a ${SCHEMA_TAG} document`);
    return 2;
  }
  console.log(nextKeys(index, level, Number(count)).join('\n'));
  return 0;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'next') return next(rest);
  if (command === 'build') {
    if (rest.length !== 2 || rest[0] !== '--out') {
      console.error(USAGE);
      return 2;
    }
    try {
      const index = buildIndex(process.cwd());
      fs.writeFileSync(rest[1], serializeIndex(index));
      console.log(`${index.commit} ${index.digest} feat ${index.counts.feat} · story ${index.counts.story}`);
      return 0;
    } catch (e) {
      if (!(e instanceof BuildStop)) throw e;
      console.error(`build stopped — ${e.message}`);
      return 1;
    }
  }
  const { asJson, jsonFlags, unknownFlags, paths } = parseArguments(rest);
  const inputError = (message) => {
    if (asJson) console.log(JSON.stringify({ schema: SCHEMA_TAG, ok: false, error: { code: 'INPUT_ERROR', message } }, null, 2));
    else console.error(message);
    return 2;
  };
  if (command !== 'verify-homes' || paths.length !== 2 || jsonFlags.length > 1 || unknownFlags.length) return inputError(USAGE);
  let proposal;
  let index;
  try {
    [proposal, index] = paths.map((p) => JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch (e) {
    return inputError(`cannot read input: ${e.message}`);
  }
  const findings = verifyHomes(proposal, index);
  if (asJson) console.log(JSON.stringify({ schema: SCHEMA_TAG, ok: findings.length === 0, findings }, null, 2));
  else console.log(findings.length ? findings.map((x) => `  ${x.code}  ${x.where}: ${x.message}`).join('\n') : 'no findings — every home matches the index.');
  return findings.length ? 1 : 0;
}

if (isMainModule(import.meta.url, process.argv[1])) process.exit(main(process.argv.slice(2)));
