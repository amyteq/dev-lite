#!/usr/bin/env node
// Packet decisions for a feat tracking-issue result (references/result-comment.md):
// whether an issue target is a feat's tracking issue, where the durable packet
// lives, what packet.manifest.json records, and which commits since the baseline
// touch a path the packet cites. It reads the repository through git and never
// calls GitHub; every non-zero exit blocks the step after it.
//
// Run from the repository root:
// `node result-packet.mjs classify --issue <n> --baseline <sha>`
// `node result-packet.mjs root --run <run-id>`
// `node result-packet.mjs manifest --root <dir> --run <run-id> --baseline <sha> --verdict <state>`
// `node result-packet.mjs drift --root <dir>`
// Exit 0 = proceed, 1 = stop, 2 = usage, or an unreadable, unparseable or mistyped input.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isMainModule, pathMatches } from './check-proposal.mjs';
import { BuildStop, indexFromDocs, readDocs } from './planning-index.mjs';

const RUN_RE = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const VERDICTS = ['proposal_complete', 'proposal_blocked', 'analysis_stopped'];
const ENV = 'DEV_ANALYSE_RP_ROOT';
const DEFAULT_ROOT = 'temp/dev-analyse-rp';
export const MANIFEST = 'packet.manifest.json';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.length > 0;
export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const stop = (reason, detail, extra = {}) => ({ action: 'stop', reason, detail, ...extra });
class PacketStop extends Error {}

// --- classify ----------------------------------------------------------------

/**
 * The feat docs' `tracking_issue` at the baseline decides, and labels play no part. Every planning
 * doc must index cleanly, because a malformed one could be the match that is missing; the index
 * already refuses two feats that claim one tracking issue.
 */
export function classify({ issue, commit, docs }) {
  let index;
  try { index = indexFromDocs(commit, docs); } catch (e) {
    if (e instanceof BuildStop) return stop('malformed-planning-docs', e.message);
    throw e;
  }
  const feat = index.rows.find((r) => r.level === 'feat' && r.tracking_issue === issue);
  return feat ? { action: 'proceed', target: 'feat', feat: feat.key, path: feat.path, status: feat.status }
    : { action: 'proceed', target: 'other', feat: null, path: null, status: null };
}

// --- root and manifest -------------------------------------------------------

/** AC3.1 and AC3.4: where the packet lives, and how a result cites it without an absolute path. */
export function resolveRoot({ run, env, top, cwd }) {
  if (isText(env)) return { root: path.resolve(cwd, env, run), cite: `$${ENV}/${run}/` };
  return { root: path.join(top, DEFAULT_ROOT, run), cite: `${DEFAULT_ROOT}/${run}/` };
}

/** AC3.3: every file the verdict found in the root, except the manifest itself, with its size and hash. */
export function packetManifest({ root, run, baseline, verdict }) {
  const files = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      const stat = fs.lstatSync(abs);
      if (stat.isDirectory()) walk(abs);
      else if (!stat.isFile()) throw new PacketStop(`${rel} is neither a file nor a directory`);
      else if (rel !== MANIFEST) {
        const bytes = fs.readFileSync(abs);
        files.push({ path: rel, bytes: bytes.length, sha256: sha256(bytes) });
      }
    }
  };
  walk(root);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const text = `${JSON.stringify({ schema: 'AnalyseRpPacketManifestV1', run, baseline, verdict, files }, null, 2)}\n`;
  return { text, digest: `sha256:${sha256(text)}`, files: files.length };
}

// --- drift -------------------------------------------------------------------

/**
 * AC6: the committed changes since the baseline that touch a cited path. A unit cites its
 * write boundary (the checker's glob rules), an edge its conflict path, and a source an
 * origin that names a file at the baseline commit, which a `#section` anchor may follow.
 */
export function delta({ proposal, head, changed, baselineFiles, headDigest }) {
  const { commit: baseline, planning_index: { digest } } = proposal.baseline;
  const atBaseline = new Set(baselineFiles);
  const cites = [
    ...proposal.units.flatMap((u) => u.write_boundary.map((p) => ({ matches: (f) => pathMatches(p, f), by: [u.id] }))),
    ...proposal.edges.filter((e) => isText(e.conflict_path)).map((e) => ({ matches: (f) => f === e.conflict_path, by: [e.from, e.to] })),
    ...proposal.sources.map((s) => ({ id: s.id, file: s.origin.split('#')[0] })).filter((s) => atBaseline.has(s.file))
      .map((s) => ({ matches: (f) => f === s.file, by: [s.id] })),
  ];
  const overlap = changed
    .map((f) => ({ path: f, citedBy: [...new Set(cites.filter((c) => c.matches(f)).flatMap((c) => c.by))] }))
    .filter((x) => x.citedBy.length);
  return { action: 'proceed', baseline, head, changed: changed.length, overlap, digest: { baseline: digest, head: headDigest }, digestChanged: headDigest !== digest };
}

// --- CLI ---------------------------------------------------------------------

class InputError extends Error {}
const fail = (message) => { throw new InputError(message); };
const FLAGS = {
  classify: ['issue', 'baseline'], root: ['run'],
  manifest: ['root', 'run', 'baseline', 'verdict'], drift: ['root'],
};

const isList = (v, item) => Array.isArray(v) && v.every(item);
const UNIT = (u) => isObject(u) && isText(u.id) && isList(u.write_boundary, isText);
const EDGE = (e) => isObject(e) && isText(e.from) && isText(e.to) && (e.conflict_path == null || isText(e.conflict_path));
const SOURCE = (s) => isObject(s) && isText(s.id) && isText(s.origin);

// Only the fields drift reads; check-proposal.mjs owns the projection's shape.
function driftProposal(p) {
  if (!isObject(p) || !isObject(p.baseline) || !SHA_RE.test(p.baseline.commit ?? '')) fail('proposal.json baseline.commit is missing or not a 40-hex commit');
  if (!isText(p.baseline.planning_index?.digest)) fail('proposal.json baseline.planning_index.digest is missing or mistyped');
  for (const [field, row] of [['units', UNIT], ['edges', EDGE], ['sources', SOURCE]]) {
    if (!isList(p[field], row)) fail(`proposal.json ${field} is missing, or a row lacks a field drift reads`);
  }
  return p;
}

function directory(dir) {
  try { if (fs.statSync(dir).isDirectory()) return dir; } catch { /* reported below */ }
  return fail(`--root ${dir} is not a directory`);
}

/** The one input boundary: argv to a validated command input, or InputError. Nothing downstream re-checks. */
export function readInput(argv, env = process.env) {
  const [command, ...args] = argv;
  const flags = Object.hasOwn(FLAGS, command ?? '') ? FLAGS[command] : fail('unknown or missing command');
  if (args.length !== flags.length * 2) fail(`${command} takes exactly ${flags.map((f) => `--${f} VALUE`).join(' ')}`);
  const given = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !flags.includes(flag) || Object.hasOwn(given, flag)) fail(`${command} does not accept ${args[i]} here`);
    given[flag] = args[i + 1];
  }
  if (given.issue !== undefined && !/^[1-9]\d*$/.test(given.issue)) fail('--issue must be a positive integer');
  if (given.run !== undefined && !RUN_RE.test(given.run)) fail('--run must be <YYYYMMDDTHHMMSSZ>-<8 hex>');
  if (given.baseline !== undefined && !SHA_RE.test(given.baseline)) fail('--baseline must be a 40-hex commit');
  if (given.verdict !== undefined && !VERDICTS.includes(given.verdict)) fail(`--verdict must be one of ${VERDICTS.join(', ')}`);
  if (given.root !== undefined) given.root = path.resolve(directory(given.root));
  if (command === 'classify') return { command, issue: Number(given.issue), baseline: given.baseline };
  if (command === 'root') return { command, run: given.run, env: env[ENV] };
  if (command === 'manifest') return { command, ...given };
  let proposal;
  try { proposal = JSON.parse(fs.readFileSync(path.join(given.root, 'proposal.json'), 'utf8')); } catch (e) { fail(`cannot read proposal.json: ${e.message}`); }
  return { command, root: given.root, proposal: driftProposal(proposal) };
}

// Each repository step that fails is a stop naming the step, never an empty answer.
function step(name, fn) {
  try { return fn(); } catch (e) { throw new PacketStop(`${name} failed: ${(e.stderr || e.message || '').toString().trim()}`); }
}
const git = (args) => execFileSync('git', ['--no-optional-locks', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const nulList = (out) => out.split('\0').filter(Boolean);

const RUN = {
  classify({ issue, baseline }) {
    return classify({ issue, commit: baseline, docs: step('planning docs', () => readDocs(process.cwd(), baseline)) });
  },
  root({ run, env }) {
    const top = step('toplevel', () => git(['rev-parse', '--show-toplevel']).trim());
    const { root, cite } = resolveRoot({ run, env, top, cwd: process.cwd() });
    step(`create ${cite}`, () => fs.mkdirSync(root, { recursive: true }));
    step(`write ${cite}`, () => fs.accessSync(root, fs.constants.W_OK));
    const rel = path.relative(top, root);
    // A root inside the checkout must be ignored, so nothing in it can be committed.
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) step(`check-ignore ${cite}`, () => git(['check-ignore', '-q', `${rel.split(path.sep).join('/')}/`]));
    return { action: 'proceed', root, cite };
  },
  manifest({ root, run, baseline, verdict }) {
    // AC3.3: the manifest is the verdict's file set, recorded once. Every later step writes into the
    // root, so a second manifest would cite a digest over bytes the verdict never saw; render refuses
    // a listed file whose bytes moved, which leaves a new run as the only way to fix a packet.
    if (fs.existsSync(path.join(root, MANIFEST))) return stop('manifest-exists', `${MANIFEST} already records this packet's verdict; fixing a packet file needs a new run`);
    const { text, digest, files } = packetManifest({ root, run, baseline, verdict });
    step(`write ${MANIFEST}`, () => fs.writeFileSync(path.join(root, MANIFEST), text));
    return { action: 'proceed', digest, files };
  },
  drift({ proposal }) {
    const head = step('rev-parse', () => git(['rev-parse', 'HEAD']).trim());
    const base = proposal.baseline.commit;
    if (head === base) return delta({ proposal, head, changed: [], baselineFiles: [], headDigest: proposal.baseline.planning_index.digest });
    const changed = step('diff', () => nulList(git(['diff', '-z', '--name-only', '--no-renames', base, head])));
    const baselineFiles = step('ls-tree', () => nulList(git(['ls-tree', '-r', '-z', '--name-only', base])));
    const top = step('toplevel', () => git(['rev-parse', '--show-toplevel']).trim());
    // Committed files only, read through git: uncommitted changes stay out of scope, and the repository is never written.
    const headDigest = step('index rebuild', () => indexFromDocs(head, readDocs(top, head)).digest);
    return delta({ proposal, head, changed, baselineFiles, headDigest });
  },
};

export function main(argv, env = process.env) {
  let result;
  try {
    const { command, ...input } = readInput(argv, env);
    result = RUN[command](input);
  } catch (e) {
    if (e instanceof PacketStop) result = stop('step-failed', e.message);
    else if (e instanceof InputError) {
      console.error(`result-packet: ${e.message}`);
      console.error(`usage: result-packet.mjs ${Object.entries(FLAGS).map(([c, f]) => `${c} ${f.map((x) => `--${x} VALUE`).join(' ')}`).join(' | ')}`);
      return 2;
    } else throw e;
  }
  console.log(JSON.stringify(result));
  return result.action === 'stop' ? 1 : 0;
}

if (isMainModule(import.meta.url, process.argv[1])) process.exit(main(process.argv.slice(2)));
