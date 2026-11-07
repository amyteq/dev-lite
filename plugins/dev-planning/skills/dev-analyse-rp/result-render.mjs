#!/usr/bin/env node
// Result rendering for a feat tracking issue (references/result-comment.md): every table,
// count and identifier comes from the packet files, the model's prose fills only the slots
// prose.json declares, and the result splits into numbered parts of at most 60,000
// characters. Pure functions over the packet root, with no git, GitHub, network or clock,
// so the same packet renders byte for byte the same.
//
// `node result-render.mjs render --root <packet-root>`
// Exit 0 = rendered, 1 = stop (the result cannot post as rendered), 2 = usage, or an unreadable, unparseable or mistyped input.
import fs from 'node:fs';
import path from 'node:path';
import { isMainModule, KEY_RES } from './check-proposal.mjs';
import { MANIFEST, sha256 } from './result-packet.mjs';
import { MAX_PART, resultMarkerFor } from './summary-comment.mjs';

export const MAX_PARTS = 5;
// The part-1 link is budgeted at this many id digits, so the split never depends on the id.
const LINK_ID = '9'.repeat(20);
const runId = (v) => /^\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(v ?? '');
const sha = (v) => /^[0-9a-f]{40}$/.test(v ?? '');
const FOOTER_RE = /^🧭 \S+ · \[[0-9a-f]{8}\]\(\S+\) · (?:\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC|unknown) · (?:\d+:\d{2}|unknown)$/u;
// AC4.5: an absolute or home path in any form — a POSIX root of any depth, `~/`, a drive letter or a
// UNC share — wherever it falls, punctuation included. A `/` continues a path instead of rooting one
// only after a character that can end a segment: a name character, a glob metacharacter, or the `>`
// closing a `<placeholder>`; so `<domain>/v1/` is relative, while `</secret>` and `](/secret)` are not.
// The match carries the first segment with any separator after it, so the one exempt value is the
// skill's own name alone: `/dev-analyse-rp/notes.md` matches `/dev-analyse-rp/`.
const ABS_PATH_RE = /(?<![\w*?\]}.>-])(?:\/[^\s/`'")\]]+\/?|~\/|[A-Za-z]:[\\/]|\\\\[^\s\\/])/g;
// The rooted shapes the renderer itself writes: a link's scheme and its own closing tags. Blanked in
// place before the scan, keeping every offset, so what still looks rooted came from the packet.
const RENDERED_RE = /https?:\/\/|<\/(?:details|summary|code)>/g;
const SKILL_TOKEN = '/dev-analyse-rp';
const RELATIONS = ['reuse', 'extend', 'amend', 'supersede', 'new'];
const NOT_DONE = [
  'No FT_ or STY_ number was allocated, no feat or story doc was written, and no issue was created or refined.',
  'No label, readiness or decision state changed, and the issue body, title and assignees are untouched.',
  'Nothing in the packet root was committed, pushed or uploaded.',
];

class InputError extends Error {}
class RenderStop extends Error { constructor(reason, detail) { super(detail); this.reason = reason; } }
const fail = (message) => { throw new InputError(message); };

// --- input shapes ------------------------------------------------------------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' && v.trim() !== '';
const line = (v) => text(v) && !/[\r\n]/.test(v);
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const positive = (v) => Number.isSafeInteger(v) && v > 0;
const bool = (v) => typeof v === 'boolean';
const nullable = (spec) => ({ nullable: spec });
const oneOf = (...values) => (v) => values.includes(v);
const texts = (v) => Array.isArray(v) && v.every(text);
const someTexts = (v) => texts(v) && v.length > 0;

// A spec is a predicate, [row spec], { nullable: spec } or { key: spec }, where a key ending
// in `?` may be absent. Packet files may carry fields the renderer does not read.
function shape(v, spec, at) {
  if (typeof spec === 'function') return spec(v) || fail(`${at} is missing or mistyped`);
  if (Object.hasOwn(spec, 'nullable')) return v === null || shape(v, spec.nullable, at);
  if (Array.isArray(spec)) return (Array.isArray(v) || fail(`${at} must be a list`)) && v.every((x, i) => shape(x, spec[0], `${at}[${i}]`));
  if (!isObject(v)) fail(`${at} must be an object`);
  for (const [k, s] of Object.entries(spec)) {
    const key = k.replace(/\?$/, '');
    if (key === k || v[key] !== undefined) shape(v[key], s, `${at}.${key}`);
  }
  return true;
}
// Closed inputs the procedure writes for this render: an unknown key is a mistake, not an extension.
function closed(v, spec, at) {
  shape(v, spec, at);
  for (const key of Object.keys(v)) if (!Object.hasOwn(spec, key)) fail(`${at} has the unknown key "${key}"`);
}

const BASELINE = { repo: text, ref: text, commit: sha, 'request_pack?': { id: text, 'digest?': nullable(text) } };
const VERDICT = { state: oneOf('proposal_complete', 'proposal_blocked', 'analysis_stopped'), next_human_action: text, evidence_limits: text };
const STOP_PROPOSAL = { baseline: BASELINE, verdict: VERDICT };
const PROPOSAL = {
  baseline: { ...BASELINE, planning_index: { digest: text, counts: { feat: count, story: count } } },
  path: oneOf('direct', 'skeleton'),
  journey: [{ id: text, step: text, 'deferral?': text }],
  sources: [{ included: bool }],
  coverage: [{ disposition: oneOf('owned', 'deferred', 'blocked', 'existing') }],
  slices: [{ id: text, outcome: text, journey_step: text }],
  units: [{
    id: text, slice_id: text, kind: oneOf('unit', 'skeleton'), outcomes: someTexts, decision_surface: text, seam: text,
    scope: texts, non_goals: texts, acceptance: texts, validation: texts, write_boundary: someTexts, rollback: text,
    split_rationale: text, owner: nullable(text), 'open_decisions?': texts, 'blockers?': texts, 'provisional?': bool,
    home: { relation: text, key: nullable(text), level: text, evidence: text },
  }],
  edges: [{ from: text, to: text, type: text, blocks_pickup: bool, reason: text, 'conflict_path?': nullable(text) }],
  decisions: [{ id: text, question: text, status: text, owner: nullable(text) }],
  'downstream?': nullable({ units: texts }),
  review: {
    reviewer: text, verdict: text, 'rounds?': positive, 'unreviewed_fixes?': texts,
    findings: [{ id: text, severity: oneOf('P0', 'P1', 'P2'), claim: text, disposition: text, 'owner?': nullable(text) }],
  },
  'amendments?': [{ target: text, change: text, evidence: text }],
  'divergences?': [{ subject: text, statement: text, reason: text }],
  verdict: VERDICT,
};
// A blocked or deferred source has no home yet, so real packets record its relation as null.
const CROSSWALK = { index_digest: text, source_id: text, relation: nullable(oneOf(...RELATIONS)), key: nullable(text), 'level?': nullable(text), 'evidence?': text, 'dependents?': texts };
const CHECK = { ok: bool, findings: Array.isArray, graph: { roots: texts, cycles: Array.isArray, critical_path: texts, batches: [texts], hard_edges: count,
  prerequisites: (v) => isObject(v) && Object.values(v).every(texts) } };
const DRIFT = { action: oneOf('proceed'), baseline: sha, head: sha, changed: count,
  overlap: [{ path: text, citedBy: someTexts }], digest: { baseline: text, head: text }, digestChanged: bool };
const CONTEXT = {
  repo: text, issue: positive, feat: (v) => KEY_RES.feat.test(v ?? ''), run: runId, root: text,
  previous: nullable({ id: positive, run: runId }), part1: nullable(positive),
  footer: (v) => FOOTER_RE.test(v ?? ''), verifyHomes: nullable(oneOf(0, 1, 2)),
};
const PROSE = {
  summary: line, findings: [{ class: oneOf('verified', 'assumption'), text: line }], changed: nullable(line),
  not_done: (v) => Array.isArray(v) && v.every(line), stop: nullable({ reason: line, missing: line }),
};

function read(root, name, encoding = 'utf8') { try { return fs.readFileSync(path.join(root, name), encoding); } catch (e) { return fail(`cannot read ${name}: ${e.message}`); } }
function json(raw, name) { try { return JSON.parse(raw); } catch (e) { return fail(`${name} is not JSON: ${e.message}`); } }

/** The one input boundary: the packet root to a validated render input, or InputError. Nothing downstream re-checks. */
export function readPacket(root) {
  const ctx = json(read(root, 'context.json'), 'context.json');
  closed(ctx, CONTEXT, 'context.json');
  const prose = json(read(root, 'prose.json'), 'prose.json');
  closed(prose, PROSE, 'prose.json');
  const p = json(read(root, 'proposal.json'), 'proposal.json');
  shape(p, STOP_PROPOSAL, 'proposal.json');
  const kind = p.verdict.state === 'analysis_stopped' ? 'stop' : 'result';
  const manifestText = read(root, MANIFEST);
  const manifest = json(manifestText, MANIFEST);
  shape(manifest, { run: text, baseline: text, verdict: text, files: [{ path: text, bytes: count, sha256: text }] }, MANIFEST);
  if (ctx.root !== `temp/dev-analyse-rp/${ctx.run}/` && ctx.root !== `$DEV_ANALYSE_RP_ROOT/${ctx.run}/`) fail('context.json root must cite the packet root relatively');
  if ((kind === 'stop') !== (prose.stop !== null)) fail('prose.json stop must be set exactly when the verdict is analysis_stopped');
  if (kind === 'result' && ctx.previous && prose.changed === null) fail('prose.json changed must say what changed since the previous result');
  if (!ctx.previous && prose.changed !== null) fail('prose.json changed needs a previous result');
  if (manifest.run !== ctx.run || manifest.baseline !== p.baseline.commit || manifest.verdict !== p.verdict.state) fail(`${MANIFEST} records another run, baseline or verdict`);
  // AC3.3: the result cites the manifest's digest, so every file the manifest lists must still be
  // the bytes it hashed; a packet file fixed after the verdict needs the manifest written again.
  for (const f of manifest.files) {
    const raw = read(root, f.path, null);
    if (raw.length !== f.bytes || sha256(raw) !== f.sha256) fail(`${f.path} no longer matches ${MANIFEST}: write the manifest again after fixing a packet file`);
  }
  const input = { kind, ctx, prose, p, packetDigest: `sha256:${sha256(manifestText)}` };
  if (kind === 'stop') return input;
  shape(p, PROPOSAL, 'proposal.json');
  if (ctx.verifyHomes === null) fail('context.json verifyHomes must record the verify-homes exit status');
  const crosswalk = read(root, 'crosswalk.jsonl').split('\n').filter((l) => l.trim()).map((l, i) => json(l, `crosswalk.jsonl line ${i + 1}`));
  crosswalk.forEach((row, i) => shape(row, CROSSWALK, `crosswalk.jsonl line ${i + 1}`));
  if (crosswalk.some((row) => row.index_digest !== p.baseline.planning_index.digest)) fail('crosswalk.jsonl was built against another planning index');
  const check = json(read(root, 'check.json'), 'check.json');
  shape(check, CHECK, 'check.json');
  const drift = json(read(root, 'drift.json'), 'drift.json');
  shape(drift, DRIFT, 'drift.json');
  if (drift.baseline !== p.baseline.commit) fail('drift.json was computed for another baseline');
  return { ...input, crosswalk, check, drift };
}

// --- text --------------------------------------------------------------------

const HANDLE = /(^|[^\w`])@([A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9_.-]+)?)/g;
/** One line, with every handle outside a code span put in one, so the post notifies nobody. */
export const inline = (s) => s.replace(/\s*[\r\n]+\s*/g, ' ').split(/(`[^`]*`)/).map((x, i) => (i % 2 ? x : x.replace(HANDLE, '$1`@$2`'))).join('');
const cell = (s) => inline(s).replace(/\|/g, '\\|');
const code = (s) => (s.includes('`') ? `\`\` ${s} \`\`` : `\`${s}\``).replace(/\|/g, '\\|');
const ids = (list) => (list.length ? list.map(code).join(', ') : 'none');
const html = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const commit = (repo, sha) => `[\`${sha.slice(0, 8)}\`](https://github.com/${repo}/commit/${sha})`;
const items = (list) => list.map((x) => `  - ${inline(x)}`).join('\n') || '  - none';

// A table splits between rows and repeats its header row; every other block is atomic.
function table(section, lead, columns, rows, empty) {
  if (!rows.length) return { section, text: `${lead}${empty}` };
  return { section, lead, head: `| ${columns.join(' | ')} |\n|${columns.map(() => '---').join('|')}|`, rows: rows.map((r) => `| ${r.join(' | ')} |`) };
}
const blockText = (b) => (b.rows ? `${b.lead}\n\n${b.head}\n${b.rows.join('\n')}` : b.text);

// --- sections ----------------------------------------------------------------

function header({ kind, ctx, p, drift, packetDigest }, m) {
  const b = p.baseline;
  const pack = b.request_pack ? `${code(b.request_pack.id)}${b.request_pack.digest ? ` (${code(b.request_pack.digest)})` : ''}` : 'not recorded';
  const index = kind === 'result' && b.planning_index;
  const rows = [
    ['Skill', '`/dev-analyse-rp`'], ['Target', `[#${ctx.issue}](https://github.com/${ctx.repo}/issues/${ctx.issue})`], ['Feat', code(ctx.feat)],
    ['Request pack', pack], ['Baseline', `${code(b.ref)} at ${commit(ctx.repo, b.commit)}`],
    ...(drift ? [['`HEAD` at post time', `${commit(ctx.repo, drift.head)}${drift.head === b.commit ? ', the baseline' : ''}`]] : []),
    ...(index ? [['Planning index', `${code(index.digest)} (feat ${index.counts.feat} · story ${index.counts.story})${drift.digestChanged ? ' · **changed at `HEAD`**' : ''}`]] : []),
    ['Packet', `${code(packetDigest)} in ${code(ctx.root)} on the invoking host; not published`], ['Run', code(ctx.run)], ['Part', `1/${m}`],
  ];
  const title = kind === 'result' ? 'result' : 'analysis stopped';
  return { section: 'header', part1: true, text: `## \`/dev-analyse-rp\` ${title}: ${code(ctx.feat)} on #${ctx.issue}\n\n| Field | Value |\n|---|---|\n${rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n')}` };
}

function previous({ ctx, prose }) {
  const link = ctx.previous && `[run ${code(ctx.previous.run)}](https://github.com/${ctx.repo}/issues/${ctx.issue}#issuecomment-${ctx.previous.id})`;
  const text = link ? `**Previous result:** ${link}.${prose.changed ? ` What changed: ${inline(prose.changed)}` : ''}` : '**Previous result:** none; this is the first result on this issue.';
  return { section: 'previous result', part1: true, text };
}

function decisions({ p }) {
  const blocked = (id) => p.units.filter((u) => (u.open_decisions ?? []).includes(id)).map((u) => u.id);
  const rows = p.decisions.map((d) => `| ${code(d.id)} | ${code(d.status)} | ${d.owner ? code(d.owner) : 'unassigned'} | ${ids(blocked(d.id))} | ${cell(d.question.split(/\r?\n/)[0])} |`);
  const ownerless = p.units.filter((u) => u.owner === null).map((u) => `${code(u.id)} (${(u.blockers ?? []).map(inline).join('; ') || 'no blocker recorded'})`);
  const list = rows.length ? `| Decision | Status | Owner | Blocks | Question |\n|---|---|---|---|---|\n${rows.join('\n')}` : 'No decisions recorded.';
  return { section: 'decisions', part1: true, text: `### Decisions and units without an owner\n\n${list}\n\n**Units without an owner:** ${ownerless.join('; ') || 'none'}.` };
}

function storyMap({ p }) {
  const cov = (d) => p.coverage.filter((c) => c.disposition === d).length;
  const journey = p.journey.map((j, i) => `${i + 1}. ${code(j.id)} ${inline(j.step)}${j.deferral ? ` (deferred: ${inline(j.deferral)})` : ''}`).join('\n');
  const intro = `### Story Map and units\n\n**Path:** ${code(p.path)}${p.path === 'skeleton' ? '; the downstream map stays provisional until the merged skeleton `HEAD`' : ''}.\n\n`
    + `**Coverage:** ${p.sources.filter((s) => s.included).length} of ${p.sources.length} sources included · owned ${cov('owned')} · existing ${cov('existing')} · deferred ${cov('deferred')} · blocked ${cov('blocked')}\n\n**Journey:**\n\n${journey || 'none recorded'}`;
  const downstream = p.downstream ? [{ section: 'story map', text: `**Provisional downstream map:** ${p.downstream.units.map(inline).join('; ') || 'none'}.` }] : [];
  const units = (slice) => p.units.filter((u) => u.slice_id === slice).map((u) => u.id);
  const home = (h) => `${code(h.relation)} ${h.key ? code(h.key) : 'a proposed new feat'}`;
  return [
    { section: 'story map', text: intro }, ...downstream,
    table('story map', '**Delivery Slices:**', ['Slice', 'Outcome', 'Journey', 'Units'], p.slices.map((s) => [code(s.id), cell(s.outcome), code(s.journey_step), ids(units(s.id))]), ' none.'),
    table('story map', '**Units:**', ['Unit', 'Slice', 'Kind', 'Home', 'Owner', 'Outcome'],
      p.units.map((u) => [code(u.id), code(u.slice_id), code(u.kind), home(u.home), u.owner ? code(u.owner) : '**none**', cell(u.outcomes[0])]), ' none.'),
    ...p.units.map((u) => ({ section: `story map: ${u.id} detail`, text: `<details><summary><code>${html(u.id)}</code> in full</summary>\n\n`
      + `- **Outcome:** ${inline(u.outcomes[0])}\n- **Decision surface:** ${inline(u.decision_surface)}\n- **Seam:** ${inline(u.seam)}\n`
      + `- **Scope:**\n${items(u.scope)}\n- **Non-goals:**\n${items(u.non_goals)}\n- **Acceptance:**\n${items(u.acceptance)}\n- **Validation:**\n${items(u.validation)}\n`
      + `- **Write boundary:** ${u.write_boundary.map(code).join(', ')}\n- **Rollback:** ${inline(u.rollback)}\n- **Split rationale:** ${inline(u.split_rationale)}\n`
      + `- **Home:** ${home(u.home)} (${inline(u.home.level)}): ${inline(u.home.evidence)}\n- **Open decisions:** ${ids(u.open_decisions ?? [])}\n`
      + `- **Blockers:** ${(u.blockers ?? []).map(inline).join('; ') || 'none'}${u.provisional ? '\n- **Provisional:** yes' : ''}\n\n</details>` })),
  ];
}

function dependencies({ p, check: { graph: g } }) {
  const critical = g.critical_path.length ? g.critical_path.map(code).join(' → ') : g.cycles.length ? 'undefined while a cycle stands' : 'none';
  const waits = Object.keys(g.prerequisites).sort().map((u) => `${code(u)} ← ${ids(g.prerequisites[u])}`).join(' · ');
  const intro = `### Dependencies\n\n**Hard graph:** ${p.units.length} units and ${g.hard_edges} pickup-blocking edges between them; roots ${ids(g.roots)}.\n\n`
    + `**Critical path:** ${critical}\n\n**Parallel batches:** ${g.batches.map((b, i) => `${i + 1}. ${ids(b)}`).join(' · ') || 'none'}${waits ? `\n\n**Existing prerequisites:** ${waits}` : ''}`;
  const edge = (e) => [code(e.from), code(e.to), code(e.type)];
  return [
    { section: 'dependencies', text: intro },
    table('dependencies', '**Pickup-blocking edges:**', ['From', 'To', 'Type', 'Reason'], p.edges.filter((e) => e.blocks_pickup).map((e) => [...edge(e), cell(e.reason)]), ' none.'),
    table('dependencies', '**Non-blocking edges** (the coordination graph: they order work and never block pickup):', ['From', 'To', 'Type', 'Conflict path', 'Reason'],
      p.edges.filter((e) => !e.blocks_pickup).map((e) => [...edge(e), e.conflict_path ? code(e.conflict_path) : '—', cell(e.reason)]), ' none.'),
  ];
}

function amendments({ p }) {
  return [
    table('amendments', '### Proposed amendments and divergences\n\n**Amendments:**', ['Target', 'Change', 'State', 'Evidence'],
      (p.amendments ?? []).map((a) => [cell(a.target), cell(a.change), 'proposed, not enacted', cell(a.evidence)]), ' none recorded.'),
    table('divergences', '**Intentional divergences:**', ['Subject', 'Divergence', 'Reason'], (p.divergences ?? []).map((d) => [cell(d.subject), cell(d.statement), cell(d.reason)]), ' none recorded.'),
  ];
}

function review({ p: { review: r } }) {
  const severity = ['P0', 'P1', 'P2'].map((s) => `${s} ${r.findings.filter((f) => f.severity === s).length}`).join(' · ');
  const fixes = r.unreviewed_fixes ? r.unreviewed_fixes.map(inline).join('; ') || 'none' : 'none recorded';
  const lead = `### Independent review\n\n**Reviewer:** ${inline(r.reviewer)} · **rounds:** ${r.rounds ?? 'unknown'} · **verdict:** ${code(r.verdict)}\n\n`
    + `**Findings by severity:** ${severity}\n\n**Fixes not re-reviewed:** ${fixes}\n\n**Open dispositions:**`;
  return table('review', lead, ['Finding', 'Severity', 'Disposition', 'Owner', 'Claim'],
    r.findings.filter((f) => f.disposition === 'deferred').map((f) => [code(f.id), code(f.severity), code(f.disposition), f.owner ? code(f.owner) : '—', cell(f.claim)]), ' none.');
}

function delta({ ctx, drift: d }) {
  const lead = '### Baseline delta\n\n';
  if (d.head === d.baseline) return { section: 'baseline delta', text: `${lead}\`HEAD\` is the baseline commit, so nothing was committed since; uncommitted changes are out of scope.` };
  const digest = d.digestChanged ? `**The planning-index digest changed at \`HEAD\`:** ${code(d.digest.baseline)} is now ${code(d.digest.head)}, so the homes may be stale.\n\n` : '';
  const summary = `${digest}\`HEAD\` is ${commit(ctx.repo, d.head)}: ${d.changed} files changed in commits since the baseline, with ${d.overlap.length ? `${d.overlap.length} cited by this packet` : 'no overlap'}.`
    + `${d.digestChanged ? '' : ' The planning-index digest is unchanged.'} Uncommitted changes are out of scope.`;
  return table('baseline delta', `${lead}${summary}`, ['Changed path', 'Cited by'], d.overlap.map((o) => [code(o.path), ids(o.citedBy)]), '');
}

export function blocks(input, m) {
  const { kind, ctx, p, prose, check } = input;
  const limits = { section: 'evidence limits', text: `### Evidence limits\n\n${inline(p.verdict.evidence_limits)}` };
  const footer = { section: 'footer', text: `---\n${ctx.footer}` };
  if (kind === 'stop') {
    return [header(input, m), previous(input), { section: 'stop', part1: true, text: `### Analysis stopped\n\n**Reason:** ${inline(prose.stop.reason)}\n\n`
      + `**Missing:** ${inline(prose.stop.missing)}\n\n**Next human action:** ${inline(p.verdict.next_human_action)}` }, limits, footer];
  }
  const rel = (r) => `${r ?? 'none'} ${input.crosswalk.filter((x) => x.relation === r).length}`;
  const crosswalk = table('crosswalk', `### Existing-home crosswalk\n\n**Rows per relation:** ${[...RELATIONS, null].map(rel).join(' · ')}, over ${input.crosswalk.length} rows.`,
    ['Source', 'Relation', 'Home', 'Level', 'Evidence', 'Dependents'],
    input.crosswalk.filter((x) => ['new', 'amend', 'supersede'].includes(x.relation)).map((x) => [code(x.source_id), code(x.relation),
      x.key ? code(x.key) : 'a proposed new feat', x.level ? code(x.level) : '—', cell(x.evidence ?? '—'), ids(x.dependents ?? [])]), '\n\nNo `new`, `amend` or `supersede` row.');
  const checks = `| \`node check-proposal.mjs proposal.json --json\` | ${check.ok ? '0' : `1 (${check.findings.length} findings)`} |\n`
    + `| \`node planning-index.mjs verify-homes proposal.json index.json\` | ${ctx.verifyHomes} |`;
  const notDone = [...NOT_DONE, ...(p.amendments?.length ? ['The proposed amendments are not enacted.'] : []), ...prose.not_done.map(inline)];
  return [
    header(input, m), previous(input),
    { section: 'verdict', part1: true, text: `### Verdict\n\n${code(p.verdict.state)}: ${inline(prose.summary)}\n\n**Next human action:** ${inline(p.verdict.next_human_action)}` },
    decisions(input),
    { section: 'key findings', text: `### Key findings\n\n${prose.findings.map((f) => `- **${f.class}:** ${inline(f.text)}`).join('\n') || 'None recorded.'}` },
    crosswalk, ...storyMap(input), ...dependencies(input), ...amendments(input), review(input),
    { section: 'checks', text: `### Deterministic checks\n\n| Command | Exit |\n|---|---|\n${checks}` },
    delta(input), limits, { section: 'not done', text: `### Not done\n\n${notDone.map((x) => `- ${x}`).join('\n')}` }, footer,
  ];
}

// --- parts -------------------------------------------------------------------

const partLink = ({ ctx }, i, m, id) => `Part ${i} of ${m}, continued from [part 1](https://github.com/${ctx.repo}/issues/${ctx.issue}#issuecomment-${id}).`;
const marker = ({ ctx }, i, m) => resultMarkerFor({ repo: ctx.repo, issue: ctx.issue, feat: ctx.feat, run: ctx.run, part: i, parts: m });

/** Greedy packing between blocks and between table rows; part 1 must hold every block marked part1. */
export function split(input, list) {
  const parts = [];
  let chunks, size, cap;
  const open = () => {
    const i = parts.length + 1;
    // Budgeted with one-digit counts and the longest link: neither moves a boundary once m is known.
    cap = MAX_PART - marker(input, i, 1).length - 3 - (i > 1 ? partLink(input, i, 1, LINK_ID).length + 1 : 0);
    chunks = [];
    size = 0;
    parts.push(chunks);
  };
  const room = () => cap - size - (chunks.length ? 2 : 0);
  const add = (s) => { size += s.length + (chunks.length ? 2 : 0); chunks.push(s); };
  open();
  for (const b of list) {
    if (!b.rows) {
      if (b.text.length > room() && chunks.length) open();
      if (b.part1 && parts.length > 1) throw new RenderStop('part-1-crowded', `the header, verdict, next action and decisions do not fit in part 1 (at ${b.section})`);
      if (b.text.length > room()) throw new RenderStop('block-too-long', `the ${b.section} block alone exceeds one part`);
      add(b.text);
      continue;
    }
    let rows = b.rows;
    let prefix = `${b.lead}\n\n${b.head}`;
    while (rows.length) {
      let n = 0;
      let len = prefix.length;
      while (n < rows.length && len + 1 + rows[n].length <= room()) len += 1 + rows[n++].length;
      if (n === 0) {
        if (!chunks.length) throw new RenderStop('block-too-long', `a ${b.section} table row alone exceeds one part`);
        open();
        continue;
      }
      add([prefix, ...rows.slice(0, n)].join('\n'));
      rows = rows.slice(n);
      if (rows.length) open();
      prefix = b.head;
    }
  }
  return parts;
}

/** Render the one-piece result and its parts. `part1` is null until part 1 is posted. */
export function render(input) {
  const m = split(input, blocks(input, 1)).length;
  if (m > MAX_PARTS) throw new RenderStop('too-many-parts', `the result needs ${m} parts; the limit is ${MAX_PARTS}`);
  if (input.kind === 'stop' && m > 1) throw new RenderStop('block-too-long', 'the stop notice exceeds one part');
  const list = blocks(input, m);
  const full = `${list.map(blockText).join('\n\n')}\n`;
  const scan = full.replace(RENDERED_RE, (t) => ' '.repeat(t.length));
  const found = [...scan.matchAll(ABS_PATH_RE)].find((x) => x[0] !== SKILL_TOKEN);
  if (found) throw new RenderStop('absolute-path', `line ${full.slice(0, found.index).split('\n').length} names an absolute or home path`);
  const id = input.ctx.part1 ?? 'PART-1';
  const parts = split(input, list).map((chunks, k) => `${marker(input, k + 1, m)}\n${k ? `${partLink(input, k + 1, m, id)}\n` : ''}\n${chunks.join('\n\n')}\n`);
  return { full, parts };
}

/** AC5.6: strip each marker, part-1 link and repeated table header, and the parts give back the one-piece result. */
export function joinParts(parts) {
  return `${parts.map((t, i) => {
    const rows = t.replace(/\n$/, '').split('\n').slice(i ? 3 : 2);
    return i && rows[0].startsWith('|') ? `\n${rows.slice(2).join('\n')}` : `${i ? '\n\n' : ''}${rows.join('\n')}`;
  }).join('')}\n`;
}

// --- CLI ---------------------------------------------------------------------

export function main(argv) {
  if (argv.length !== 3 || argv[0] !== 'render' || argv[1] !== '--root') {
    console.error('usage: result-render.mjs render --root <packet-root>');
    return 2;
  }
  const root = argv[2];
  let result;
  try {
    const input = readPacket(root);
    const { full, parts } = render(input);
    fs.writeFileSync(path.join(root, 'result.full.md'), full);
    parts.forEach((t, k) => fs.writeFileSync(path.join(root, `result.${k + 1}.md`), t));
    result = { action: 'proceed', kind: input.kind, parts: parts.length, files: parts.map((_, k) => `result.${k + 1}.md`), sizes: parts.map((t) => t.length) };
  } catch (e) {
    if (e instanceof RenderStop) result = { action: 'stop', reason: e.reason, detail: e.message };
    else if (e instanceof InputError) {
      console.error(`result-render: ${e.message}`);
      return 2;
    } else throw e;
  }
  console.log(JSON.stringify(result));
  return result.action === 'stop' ? 1 : 0;
}

if (isMainModule(import.meta.url, process.argv[1])) process.exit(main(process.argv.slice(2)));
