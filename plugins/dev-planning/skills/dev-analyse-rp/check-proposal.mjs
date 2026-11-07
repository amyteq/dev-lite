#!/usr/bin/env node
// Deterministic bookkeeping checks for an AnalyseRpProposalV1 projection
// (references/projection.md) — only what a planning skill cannot do reliably in
// prose. A clean run means the packet is internally consistent, not that the
// plan is good; that judgement stays with the independent review.
//
// Plain Node, no dependencies: `node check-proposal.mjs <proposal.json> [--json]`.
// Exit 0 = no findings, 1 = projection findings, 2 = CLI usage or unreadable JSON.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const SCHEMA_TAG = 'AnalyseRpProposalV1';
const EDGE_TYPES = ['contract', 'implementation', 'integration', 'qualification', 'coordination'];
const HARD_EDGE_TYPES = ['contract', 'implementation'];
const PATHS = ['direct', 'skeleton'];
const DISPOSITIONS = ['owned', 'deferred', 'blocked', 'existing'];
const UNIT_RELATIONS = ['extend', 'amend', 'supersede', 'new'];
const HOME_LEVELS = ['feat', 'story'];
// A key's prefix fixes its level: FT_<n> is a feat, STY_<n> a story, each its own sequence.
export const KEY_RES = { feat: /^FT_[1-9][0-9]*$/, story: /^STY_[1-9][0-9]*$/ };
export const FEAT_LABEL_RE = /^[a-z0-9-]+:[a-z0-9-]+$/;
const keyLevel = (key) => HOME_LEVELS.find((level) => KEY_RES[level].test(String(key)));
const NEW_FEAT_FIELDS = ['name', 'label', 'scope', 'approved_by', 'approved_at', 'answer'];
const VERDICTS = ['proposal_complete', 'proposal_blocked', 'analysis_stopped'];
const OVERSIZE_DISPOSITIONS = ['split', 'reduce', 'skeleton', 'justified_oversize'];
const REVIEW_VERDICTS = ['sound', 'needs_changes', 'not_reviewable'];
const FINDING_DISPOSITIONS = ['accepted', 'rejected', 'deferred'];
const SEVERITIES = ['P0', 'P1', 'P2'];
const MAX_REPOSITORY_PATH_BYTES = 4096;

const ID_PATTERNS = Object.fromEntries(
  [['sources', 'SRC'], ['slices', 'SL'], ['units', 'U'], ['decisions', 'D'], ['journey', 'J']]
    .map(([section, prefix]) => [section, new RegExp(`^${prefix}-[A-Za-z0-9][A-Za-z0-9_-]*$`)]),
);
const COMMIT_RE = /^[0-9a-f]{40}$/;
const ROW_SECTIONS = ['journey', 'sources', 'coverage', 'slices', 'units', 'edges', 'decisions', 'homes'];
const UNIT_LISTS = ['outcomes', 'scope', 'non_goals', 'acceptance', 'validation', 'write_boundary', 'open_decisions', 'blockers'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;
const isTextList = (v) => Array.isArray(v) && v.length > 0 && v.every(isText);
const present = (v) => v !== undefined && v !== null;
const arr = (v) => (Array.isArray(v) ? v : []);
const rows = (v) => arr(v).filter(isObject);
const textLists = (names) => Object.fromEntries(names.map((name) => [name, 'text-list']));

// Declared field types from the projection reference: a present value of the
// wrong type fails closed; missing required fields keep their own findings.
const FIELD_TYPES = {
  proposal: { schema: 'text', path: 'text' },
  baseline: { repo: 'text', ref: 'text', commit: 'text', worktree_status_porcelain: 'string' },
  planning_index: { digest: 'text' },
  homes: { key: 'text', level: 'text' },
  home: { relation: 'text', key: 'nullable-text', level: 'text', evidence: 'text', ...textLists(['search', 'invalidates_proof', 'dependents']) },
  request_pack: { id: 'text', origin: 'text', digest: 'text' },
  boundary: { statement: 'text', ...textLists(['actors', 'outcomes', 'exclusions']) },
  journey: { id: 'text', step: 'text', deferral: 'text' },
  sources: { id: 'text', title: 'text', origin: 'text', included: 'boolean', omission_reason: 'nullable-text', baseline_commit: 'nullable-text' },
  coverage: { source_id: 'text', disposition: 'text', unit_id: 'text', reason: 'text', evidence: 'text', decision_id: 'text' },
  slices: { id: 'text', outcome: 'text', journey_step: 'text' },
  units: {
    id: 'text', slice_id: 'text', kind: 'text', decision_surface: 'text', seam: 'text', rollback: 'text',
    split_rationale: 'text', owner: 'nullable-text', provisional: 'boolean', frozen_signatures: 'boolean', ...textLists(UNIT_LISTS),
  },
  tripwires: { files: 'number', acs: 'number', breached: 'boolean', disposition: 'nullable-text', owner_gate: 'nullable-text' },
  edges: { from: 'text', to: 'text', type: 'text', blocks_pickup: 'boolean', conflict_path: 'text', reason: 'text', evidence: 'text' },
  decisions: { id: 'text', question: 'text', status: 'text', owner: 'nullable-text', evidence: 'nullable-text' },
  seam_evidence: { contract: 'text', location: 'text' },
  downstream: { provisional: 'boolean', ...textLists(['units']) },
  trigger: { kind: 'text', commit: 'nullable-text', description: 'text' },
  review: { reviewer: 'text', verdict: 'text' },
  review_finding: { id: 'text', severity: 'text', claim: 'text', disposition: 'text', reason: 'text', owner: 'text' },
  verdict: { state: 'text', next_human_action: 'text', evidence_limits: 'text' },
};
const TYPE_CHECKS = {
  text: isText,
  string: (v) => typeof v === 'string',
  boolean: (v) => typeof v === 'boolean',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
};

// Readiness lives only on issue labels and lifecycle only in the feat and story docs, so a
// proposal asserts neither: not the status labels, and not a doc status value.
const FORBIDDEN_STATES = new Set(['ready', 'blocked', 'current', 'superseded', 'retired']);
const STATE_FIELD_SUFFIXES = ['status', 'state', 'lifecycle', 'phase', 'label', 'labels'];

// Each rule is [code, field, predicate, message]; a failing predicate adds one finding at `${at}.${field}`.
function requireFields(record, at, rules, f) {
  for (const [code, field, ok, message] of rules) if (!ok(record[field])) f.add(code, `${at}.${field}`, message);
}

// --- projection schema -------------------------------------------------------

function checkDeclaredTypes(record, spec, at, f) {
  if (!isObject(record)) return;
  for (const [field, declared] of Object.entries(spec)) {
    const value = record[field];
    const where = at === '$' ? field : `${at}.${field}`;
    if (declared === 'text-list') {
      // A non-list value is reported by the shape check; only entries are typed here.
      for (const [i, entry] of arr(value).entries()) if (!isText(entry)) f.add('SCHEMA_TYPE', `${where}[${i}]`, 'list entry must be non-empty text');
    } else if (field in record) {
      const type = declared.replace('nullable-', '');
      const nullable = type !== declared;
      if (!((nullable && value === null) || TYPE_CHECKS[type](value))) {
        f.add('SCHEMA_TYPE', where, `field must be ${nullable ? 'null or ' : ''}${type}`);
      }
    }
  }
}

function checkProjectionTypes(p, f) {
  const types = (record, spec, at) => checkDeclaredTypes(record, FIELD_TYPES[spec], at, f);
  types(p, 'proposal', '$');
  types(p.baseline, 'baseline', 'baseline');
  types(p.baseline?.request_pack, 'request_pack', 'baseline.request_pack');
  types(p.baseline?.planning_index, 'planning_index', 'baseline.planning_index');
  types(p.boundary, 'boundary', 'boundary');
  for (const section of [...ROW_SECTIONS, 'seam_evidence']) {
    for (const [i, record] of rows(p[section]).entries()) {
      types(record, section, `${section}[${i}]`);
      if (section === 'units') types(record.tripwires, 'tripwires', `${section}[${i}].tripwires`);
      if (section === 'units' || section === 'coverage') types(record.home, 'home', `${section}[${i}].home`);
    }
  }
  types(p.downstream, 'downstream', 'downstream');
  types(p.downstream?.trigger, 'trigger', 'downstream.trigger');
  types(p.review, 'review', 'review');
  for (const [i, record] of rows(p.review?.findings).entries()) types(record, 'review_finding', `review.findings[${i}]`);
  types(p.verdict, 'verdict', 'verdict');
}

function checkProjectionShape(p, f) {
  const section = (key, list, required) => {
    if (!present(p[key])) {
      if (required) f.add('SCHEMA_FIELD', key, `required ${list ? 'list' : 'object'} section is missing`);
    } else if (list ? !Array.isArray(p[key]) : !isObject(p[key])) {
      f.add('SCHEMA_TYPE', key, `section must be ${list ? 'a list' : 'an object'}${required ? '' : ' when present'}`);
    }
  };
  for (const key of ['baseline', 'boundary', 'verdict']) section(key, false, true);
  for (const key of ROW_SECTIONS) section(key, true, true);
  section('seam_evidence', true, p.path === 'direct');
  section('downstream', false, false);
  section('review', false, false);

  for (const key of [...ROW_SECTIONS, 'seam_evidence']) {
    for (const [i, value] of arr(p[key]).entries()) if (!isObject(value)) f.add('SCHEMA_TYPE', `${key}[${i}]`, 'row must be an object');
  }
  if (isObject(p.baseline) && present(p.baseline.request_pack) && !isObject(p.baseline.request_pack)) {
    f.add('SCHEMA_TYPE', 'baseline.request_pack', 'request_pack must be an object');
  }
  for (const u of rows(p.units)) {
    const at = `units.${u.id ?? '?'}`;
    for (const key of UNIT_LISTS) {
      if (present(u[key]) && !Array.isArray(u[key])) f.add('SCHEMA_TYPE', `${at}.${key}`, 'field must be a list');
    }
    if (present(u.tripwires) && !isObject(u.tripwires)) f.add('SCHEMA_TYPE', `${at}.tripwires`, 'field must be an object');
  }
  if (isObject(p.review)) {
    if (!Array.isArray(p.review.findings)) f.add('SCHEMA_TYPE', 'review.findings', 'field must be a list');
    for (const [i, value] of arr(p.review.findings).entries()) if (!isObject(value)) f.add('SCHEMA_TYPE', `review.findings[${i}]`, 'row must be an object');
  }
  if (isObject(p.downstream)) {
    if (!Array.isArray(p.downstream.units)) f.add('SCHEMA_TYPE', 'downstream.units', 'field must be a list');
    if (!isObject(p.downstream.trigger)) f.add('SCHEMA_TYPE', 'downstream.trigger', 'field must be an object');
  }
  checkProjectionTypes(p, f);
}

function checkEnvelope(p, f) {
  checkProjectionShape(p, f);
  if (p.schema !== SCHEMA_TAG) f.add('SCHEMA_TAG', 'schema', `expected "${SCHEMA_TAG}", found ${JSON.stringify(p.schema ?? null)}`);
  if (!PATHS.includes(p.path)) f.add('SCHEMA_FIELD', 'path', `expected one of ${PATHS.join(', ')}, found ${JSON.stringify(p.path ?? null)}`);
  if (isObject(p.boundary)) {
    requireFields(p.boundary, 'boundary', [
      ['SCHEMA_FIELD', 'statement', isText, 'one declared programme boundary is required'],
      ['SCHEMA_FIELD', 'actors', isTextList, 'one or more actors are required'],
      ['SCHEMA_FIELD', 'outcomes', isTextList, 'one or more in-scope outcomes are required'],
      ['SCHEMA_FIELD', 'exclusions', (v) => Array.isArray(v) && v.every(isText), 'exclusions must be a text list (empty is allowed, absent is not)'],
    ], f);
  }
  if (!Array.isArray(p.journey) || p.journey.length === 0) {
    f.add('JOURNEY_MISSING', 'journey', 'the Story Map needs a journey backbone: slices hang off actor steps');
  } else {
    // An uncovered backbone step is either outside the boundary or uncovered
    // work that needs a deferral; either way it must not stay invisible.
    const covered = new Set(rows(p.slices).map((s) => s.journey_step));
    for (const j of rows(p.journey)) {
      if (!covered.has(j.id) && !isText(j.deferral)) {
        f.add('JOURNEY_UNCOVERED', `journey.${j.id ?? '?'}`, 'no slice covers this step and it records no deferral');
      }
    }
  }
  if (isObject(p.verdict)) {
    requireFields(p.verdict, 'verdict', [
      ['VERDICT_FIELD', 'state', (v) => VERDICTS.includes(v), `expected one of ${VERDICTS.join(', ')}`],
      ['VERDICT_FIELD', 'next_human_action', isText, 'the single next human-authorized action is required'],
      ['VERDICT_FIELD', 'evidence_limits', isText, 'this run\'s evidence limits are required'],
    ], f);
  }
  checkReview(p, f);
}

// A completeness or blocked verdict rests on a recorded independent review, so
// a packet cannot claim a review that exists only as a reference.
function checkReview(p, f) {
  const r = isObject(p.review) ? p.review : null;
  if (r) {
    if (!isText(r.reviewer)) f.add('REVIEW_FIELD', 'review.reviewer', 'the reviewer identity and context are required');
    if (!REVIEW_VERDICTS.includes(r.verdict)) f.add('REVIEW_FIELD', 'review.verdict', `expected one of ${REVIEW_VERDICTS.join(', ')}`);
    for (const [i, x] of rows(r.findings).entries()) {
      const at = `review.findings[${i}]`;
      if (!isText(x.id)) f.add('REVIEW_FIELD', at, 'every finding keeps a stable id');
      if (!SEVERITIES.includes(x.severity)) f.add('REVIEW_FIELD', at, `severity must be one of ${SEVERITIES.join(', ')}`);
      if (!FINDING_DISPOSITIONS.includes(x.disposition)) f.add('REVIEW_FIELD', at, `disposition must be one of ${FINDING_DISPOSITIONS.join(', ')}`);
      if (x.disposition === 'rejected' && !isText(x.reason)) f.add('REVIEW_FIELD', at, 'a rejected finding records why');
      if (x.disposition === 'deferred' && !isText(x.owner)) f.add('REVIEW_FIELD', at, 'a deferred finding records its owner');
    }
  }
  const state = isObject(p.verdict) ? p.verdict.state : null;
  if (state !== 'proposal_complete' && state !== 'proposal_blocked') return;
  if (!r) {
    const message = state === 'proposal_complete'
      ? 'a complete proposal requires a recorded independent review; an unwritten review is not evidence'
      : 'a blocked proposal requires a recorded independent review; only an analysis that stopped before a proposal existed may omit review evidence';
    f.add('VERDICT_UNSUPPORTED', 'verdict.state', message);
  } else if (state === 'proposal_complete') {
    if (r.verdict !== 'sound') f.add('VERDICT_UNSUPPORTED', 'verdict.state', `the review verdict is "${r.verdict}", so the proposal is not complete`);
    // An unclassifiable finding counts as open: nobody graded it.
    const open = rows(r.findings).filter((x) => (['P0', 'P1'].includes(x.severity) || !SEVERITIES.includes(x.severity))
      && x.disposition !== 'accepted' && x.disposition !== 'rejected');
    if (open.length) {
      f.add('VERDICT_UNSUPPORTED', 'verdict.state', `${open.length} P0/P1 finding(s) are neither accepted nor rejected: ${open.map((x) => x.id).join(', ')}`);
    }
  }
}

function checkBaseline(p, f) {
  const b = p.baseline;
  if (!isObject(b)) return;
  requireFields(b, 'baseline', [
    ['BASELINE_FIELD', 'repo', isText, 'one repository is required'],
    ['BASELINE_FIELD', 'ref', isText, 'one ref is required'],
    ['BASELINE_FIELD', 'worktree_status_porcelain', (v) => typeof v === 'string',
      'the exact git status --porcelain output is required as text (an empty string means no entries)'],
    ['BASELINE_COMMIT', 'commit', (v) => COMMIT_RE.test(String(v ?? '')),
      'a full 40-character commit sha is required; an abbreviated or absent sha cannot bind evidence'],
    ['BASELINE_PACK', 'request_pack', (v) => isObject(v) && isText(v.id) && isText(v.origin),
      'exactly one request pack with an id and origin is required'],
    ['BASELINE_FIELD', 'planning_index', (v) => isObject(v) && isText(v.digest),
      'the digest of the planning index this run reconciled against is required'],
  ], f);
  // A source pinning another repository state is a conflict to resolve, never an average to analyse.
  for (const s of rows(p.sources)) {
    if (present(s.baseline_commit) && s.baseline_commit !== b.commit) {
      f.add('BASELINE_CONFLICT', `sources[${s.id ?? '?'}].baseline_commit`, `source pins ${s.baseline_commit}, run baseline is ${b.commit}`);
    }
  }
}

function collectIds(p, f) {
  const known = {};
  for (const [section, pattern] of Object.entries(ID_PATTERNS)) {
    const seen = new Set();
    for (const item of rows(p[section])) {
      const id = item.id;
      if (!isText(id)) {
        f.add('ID_FORMAT', section, `an entry has no id (${JSON.stringify(item)?.slice(0, 60)})`);
        continue;
      }
      if (!pattern.test(id)) f.add('ID_FORMAT', `${section}.${id}`, `id does not match ${pattern}`);
      if (seen.has(id)) f.add('ID_DUPLICATE', `${section}.${id}`, 'id is declared more than once');
      seen.add(id);
    }
    known[section] = seen;
  }
  return known;
}

function checkReferences(p, known, f) {
  const ref = (section, id, where, required) => { // when `required`, an absent id is reported, not skipped
    if ((required || present(id)) && !known[section].has(id)) {
      f.add('REF_UNKNOWN', where, `${JSON.stringify(id ?? null)} is not a declared ${section.replace(/s$/, '')} id`);
    }
  };
  for (const s of rows(p.slices)) ref('journey', s.journey_step, `slices.${s.id}.journey_step`);
  for (const c of rows(p.coverage)) {
    ref('sources', c.source_id, `coverage.${c.source_id ?? '?'}.source_id`);
    ref('units', c.unit_id, `coverage.${c.source_id ?? '?'}.unit_id`);
    ref('decisions', c.decision_id, `coverage.${c.source_id ?? '?'}.decision_id`);
  }
  for (const u of rows(p.units)) {
    ref('slices', u.slice_id, `units.${u.id}.slice_id`);
    for (const d of arr(u.open_decisions)) ref('decisions', d, `units.${u.id}.open_decisions`);
  }
  // Existing keys are declared once in `homes`; an edge may wait on one, but only a unit depends.
  const homes = homeKeys(p);
  const homeRef = (key, where) => {
    if (present(key) && !homes.has(key)) f.add('REF_UNKNOWN', where, `${JSON.stringify(key)} is not a declared homes key`);
  };
  for (const c of rows(p.coverage)) homeRef(c.home?.key, `coverage.${c.source_id ?? '?'}.home.key`);
  for (const u of rows(p.units)) homeRef(u.home?.key, `units.${u.id}.home.key`);
  for (const [i, e] of rows(p.edges).entries()) {
    ref('units', e.from, `edges[${i}].from`, true); // an omitted endpoint would drop a pickup-blocking prerequisite
    if (!homes.has(e.to)) ref('units', e.to, `edges[${i}].to`, true);
  }
}

// Key -> the level `homes` declares for it; every reference to that key must agree.
const homeKeys = (p) => new Map(rows(p.homes).filter((h) => isText(h.key)).map((h) => [h.key, h.level]));

// Where each unit and each already-covered source lives today (references/reconciliation.md).
function checkHomes(p, f) {
  const field = (at, message) => f.add('HOME_FIELD', at, message);
  const declaredOnce = new Set();
  for (const [i, h] of rows(p.homes).entries()) {
    if (!HOME_LEVELS.includes(h.level) || keyLevel(h.key) !== h.level) field(`homes[${i}]`, 'a home is an FT_<n> key at level feat or an STY_<n> key at level story');
    else if (declaredOnce.has(h.key)) f.add('ID_DUPLICATE', `homes.${h.key}`, 'id is declared more than once');
    declaredOnce.add(h.key);
  }
  const homed = [
    ...rows(p.coverage).filter((c) => c.disposition === 'existing').map((c) => [`coverage.${c.source_id ?? '?'}.home`, c.home, ['reuse']]),
    ...rows(p.units).map((u) => [`units.${u.id ?? '?'}.home`, u.home, UNIT_RELATIONS]),
  ];
  const superseded = new Map();
  const homedAt = new Map();
  for (const [at, h, relations] of homed) {
    if (!isObject(h)) { field(at, 'a home object is required'); continue; }
    if (!relations.includes(h.relation)) { field(`${at}.relation`, `expected one of ${relations.join(', ')}`); continue; }
    if (!HOME_LEVELS.includes(h.level)) field(`${at}.level`, `expected one of ${HOME_LEVELS.join(', ')}`);
    else if ((h.relation === 'new') !== (h.level === 'feat')) field(`${at}.level`, 'a new unit is homed in a feat; every other relation names a story');
    // The key's prefix fixes its level, so a reference and its `homes` row cannot disagree unseen.
    else if (keyLevel(h.key) && keyLevel(h.key) !== h.level) field(`${at}.level`, `${h.key} is a ${keyLevel(h.key)} key, not a ${h.level}`);
    if (!isText(h.evidence)) field(`${at}.evidence`, 'the evidence for this home is required');
    for (const key of ['search', 'invalidates_proof', 'dependents']) {
      if (present(h[key]) && !Array.isArray(h[key])) f.add('SCHEMA_TYPE', `${at}.${key}`, 'field must be a list');
    }
    // An amend or supersede carries the reconciled dependent set; an absent list is not an empty one.
    if (['amend', 'supersede'].includes(h.relation) && !present(h.dependents)) field(`${at}.dependents`, 'an amend or supersede declares the index dependents it reconciled, empty list included');
    if (h.relation === 'new' && !isTextList(h.search)) f.add('HOME_SEARCH_MISSING', `${at}.search`, 'a new home records the searches that found no existing one');
    if (h.relation === 'new' && h.key === null) {
      // D-a: a feat the human approved in this run; it has no key until it is materialized.
      if (!(isObject(h.new_feat) && NEW_FEAT_FIELDS.every((k) => isText(h.new_feat[k])) && FEAT_LABEL_RE.test(h.new_feat.label))) {
        f.add('HOME_FEAT_UNAPPROVED', `${at}.new_feat`, `a new feat needs the recorded human approval: ${NEW_FEAT_FIELDS.join(', ')}, with an <area>:<feature> label`);
      }
      continue;
    }
    if (!keyLevel(h.key)) field(`${at}.key`, 'a home key is FT_<n> or STY_<n>; only an approved new feat leaves it null');
    if (present(h.new_feat)) f.add('HOME_FEAT_UNAPPROVED', `${at}.new_feat`, 'a proposed new feat has no key yet, so key must be null');
    if (relations === UNIT_RELATIONS && isText(h.key)) {
      const into = h.relation === 'supersede' ? superseded : homedAt;
      into.set(h.key, [...(into.get(h.key) ?? []), at]);
    }
  }
  for (const [key, [first, ...more]] of superseded) {
    const others = [...more, ...(homedAt.get(key) ?? [])];
    if (others.length) f.add('HOME_CONFLICT', first, `${key} is superseded here and also homed at ${others.join(', ')}`);
  }
}

function checkCoverage(p, decisionStatus, f) {
  const owners = new Map(); // source id -> unit ids claiming primary ownership
  const dispositions = new Map();
  for (const c of rows(p.coverage)) {
    const sid = c.source_id ?? '?';
    const at = `coverage.${sid}`;
    if (!DISPOSITIONS.includes(c.disposition)) {
      f.add('COVERAGE_UNJUSTIFIED', at, `disposition must be one of ${DISPOSITIONS.join(', ')}`);
      continue;
    }
    dispositions.set(sid, (dispositions.get(sid) ?? 0) + 1);
    // One disposition, one kind of cover: `existing` points at a home, every other at a unit of this run.
    if (c.disposition === 'existing' ? present(c.unit_id) : present(c.home)) {
      f.add('COVERAGE_UNJUSTIFIED', at, c.disposition === 'existing'
        ? 'an existing item is covered by its home; a unit_id beside it leaves the cover ambiguous'
        : `only an existing item reuses a home, and this item is ${c.disposition}`);
    }
    if (c.disposition === 'owned') {
      if (isText(c.unit_id)) owners.set(sid, [...(owners.get(sid) ?? []), c.unit_id]);
      else f.add('COVERAGE_UNJUSTIFIED', at, 'an owned item needs its one primary owning unit');
    }
    if (c.disposition === 'deferred' && !(isText(c.reason) && isText(c.evidence))) {
      f.add('COVERAGE_UNJUSTIFIED', at, 'a deferral needs an explicit reason and evidence');
    }
    if (c.disposition === 'blocked' && !(isText(c.reason) && isText(c.decision_id))) {
      f.add('COVERAGE_UNJUSTIFIED', at, 'a blocked item needs a reason and the blocking decision id');
    } else if (c.disposition === 'blocked' && decisionStatus.has(c.decision_id) && decisionStatus.get(c.decision_id) !== 'needed') {
      f.add('COVERAGE_UNJUSTIFIED', at,
        `a blocked item needs an unresolved decision with status "needed"; ${c.decision_id} is ${JSON.stringify(decisionStatus.get(c.decision_id))}`);
    }
  }
  for (const [sid, units] of owners) {
    if (units.length > 1) f.add('COVERAGE_DUPLICATE', `coverage.${sid}`, `duplicate primary ownership: ${units.join(', ')}`);
  }
  for (const [sid, n] of dispositions) {
    if (n > 1 && !(owners.get(sid)?.length > 1)) {
      f.add('COVERAGE_DUPLICATE', `coverage.${sid}`, `${n} dispositions for one source item; exactly one is required`);
    }
  }
  for (const s of rows(p.sources)) {
    if (!isText(s.id)) continue;
    // An absent inclusion state would otherwise skip both the omission and the coverage check.
    if (!present(s.included)) f.add('SCHEMA_FIELD', `sources.${s.id}.included`, 'every source states included: true or false');
    if (s.included === false) {
      if (!isText(s.omission_reason)) f.add('SOURCE_OMISSION_REASON', `sources.${s.id}`, 'an excluded source needs its omission reason');
      if (dispositions.has(s.id)) f.add('COVERAGE_UNJUSTIFIED', `coverage.${s.id}`, 'an excluded source cannot also carry an in-scope disposition');
    } else if (s.included === true && !dispositions.has(s.id)) { // SCHEMA_TYPE owns malformed inclusion state.
      f.add('COVERAGE_MISSING', `sources.${s.id}`, 'included source has no owner, deferral or blocker: an unexplained gap');
    }
  }
}

const UNIT_REQUIRED = [
  ['decision_surface', isText], ['seam', isText], ['scope', isTextList], ['non_goals', isTextList], ['acceptance', isTextList],
  ['validation', isTextList], ['write_boundary', isTextList], ['rollback', isText], ['slice_id', isText],
].map(([field, ok]) => ['UNIT_FIELD_MISSING', field, ok, 'required for a final candidate unit']);

function checkUnits(p, decisionStatus, f) {
  for (const d of rows(p.decisions)) {
    const at = `decisions.${d.id ?? '?'}`;
    if (!['needed', 'confirmed'].includes(d.status)) f.add('DECISION_FIELD', at, 'status must be "needed" or "confirmed"');
    if (!isText(d.question)) f.add('DECISION_FIELD', at, 'a decision needs its question');
    if (d.status === 'confirmed' && !isText(d.evidence)) f.add('DECISION_FIELD', at, 'a confirmed decision needs its evidence');
  }

  for (const u of rows(p.units)) {
    const at = `units.${u.id ?? '?'}`;
    // One observable outcome: the list form makes "one" checkable.
    const outcomes = arr(u.outcomes);
    if (outcomes.length !== 1 || !isText(outcomes[0])) {
      f.add('UNIT_MULTI_OUTCOME', at, `a candidate unit carries exactly one observable outcome, found ${outcomes.length}`);
    }
    requireFields(u, at, UNIT_REQUIRED, f);
    // Rationale is mandatory whatever the size metrics say; only the review can judge it.
    if (!isText(u.split_rationale)) {
      f.add('UNIT_SPLIT_RATIONALE', `${at}.split_rationale`, 'split or keep-together rationale is required; size metrics alone cannot pass a unit');
    }
    if (u.kind !== undefined && !['unit', 'skeleton'].includes(u.kind)) f.add('UNIT_FIELD_MISSING', `${at}.kind`, 'kind must be "unit" or "skeleton"');
    // A missing owner or an unresolved decision must be visible on the unit.
    const blockers = arr(u.blockers).filter(isText);
    if (!isText(u.owner) && blockers.length === 0) {
      f.add('UNIT_BLOCKER_HIDDEN', `${at}.owner`, 'no owner and no recorded blocker: an owner-needed state must be visible, never invented or silently dropped');
    }
    for (const d of arr(u.open_decisions)) {
      if (decisionStatus.get(d) === 'needed' && blockers.length === 0) {
        f.add('DECISION_UNRESOLVED_HIDDEN', `${at}.open_decisions`, `${d} is unresolved but the unit records no blocker`);
      }
    }
    const t = u.tripwires;
    if (t && t.breached === true) {
      if (!OVERSIZE_DISPOSITIONS.includes(t.disposition)) {
        f.add('UNIT_TRIPWIRE_DISPOSITION', `${at}.tripwires`, `a breached tripwire needs a disposition (${OVERSIZE_DISPOSITIONS.join(', ')})`);
      } else if (t.disposition === 'justified_oversize' && !isText(t.owner_gate)) {
        f.add('UNIT_TRIPWIRE_DISPOSITION', `${at}.tripwires`, 'justified_oversize requires the named owner gate');
      }
    }
  }
}

function checkPath(p, f) {
  const units = rows(p.units);
  if (p.path === 'direct') {
    if (!rows(p.seam_evidence).some((s) => isText(s.contract) && isText(s.location))) {
      f.add('PATH_SEAM_EVIDENCE', 'seam_evidence', 'the direct path requires named existing seams with locations; unproven seams take the skeleton-backed path');
    }
    if (units.some((u) => u.kind === 'skeleton')) f.add('PATH_SKELETON_COUNT', 'units', 'the direct path proposes no skeleton candidates');
  }
  if (p.path !== 'skeleton') return;
  const skeletons = units.filter((u) => u.kind === 'skeleton').length;
  if (skeletons < 1 || skeletons > 3) {
    f.add('PATH_SKELETON_COUNT', 'units', `the skeleton-backed path proposes one to three skeleton candidates, found ${skeletons}`);
  }
  const d = p.downstream;
  if (!d || d.provisional !== true) {
    f.add('PATH_DOWNSTREAM_MAP', 'downstream', 'the skeleton-backed path requires a downstream map explicitly marked provisional');
  }
  const trigger = d && d.trigger;
  if (!trigger || trigger.kind !== 'merged_skeleton_head') {
    f.add('PATH_TRIGGER', 'downstream.trigger', 'the downstream trigger must be the exact merged skeleton HEAD');
  } else if (present(trigger.commit)) {
    f.add('PATH_TRIGGER', 'downstream.trigger.commit',
      'the merged skeleton commit is unknown at planning time; a filled commit claims evidence this run cannot hold');
  }
  // Premature Pass-2 freeze: a downstream unit finalized before the skeleton it depends on is merged.
  for (const u of units) {
    if (u.kind === 'skeleton') continue;
    const at = `units.${u.id ?? '?'}`;
    if (u.provisional !== true) {
      f.add('FREEZE_PREMATURE', `${at}.provisional`, 'downstream units stay provisional until the exact merged skeleton HEAD is reconciled');
    }
    if (u.frozen_signatures === true) {
      f.add('FREEZE_PREMATURE', `${at}.frozen_signatures`, 'contract signatures cannot be frozen from a hypothetical skeleton');
    }
  }
}

// Greedy wildcard matching that backtracks only to the most recent star, so a
// pattern never becomes a backtracking regular expression. Used at two levels:
// `*` within one path segment and `**` across segments.
function wildcardMatches(pattern, candidate, star, same) {
  let [p, c, starAt, starCandidate] = [0, 0, -1, -1];
  while (c < candidate.length) {
    if (pattern[p] === star) {
      starAt = p++;
      starCandidate = c;
    } else if (p < pattern.length && same(pattern[p], candidate[c])) {
      p++;
      c++;
    } else if (starAt !== -1) {
      p = starAt + 1;
      c = ++starCandidate;
    } else {
      return false;
    }
  }
  while (pattern[p] === star) p++;
  return p === pattern.length;
}

const segmentMatches = (pattern, candidate) => wildcardMatches(pattern, candidate, '*', (a, b) => a === b);

export function pathMatches(pattern, candidate) {
  if (!isText(pattern) || !isText(candidate)) return false;
  return wildcardMatches(pattern.split('/'), candidate.split('/'), '**', segmentMatches);
}

function repositoryPathProblem(value, { allowGlob }) {
  if (!isText(value)) return null; // Scalar/list type checks own non-text values.
  if (/[\u0000-\u001F\u007F]/u.test(value)) return 'must not contain control characters U+0000 through U+001F or U+007F';
  if (Buffer.byteLength(value, 'utf8') > MAX_REPOSITORY_PATH_BYTES) return `must be at most ${MAX_REPOSITORY_PATH_BYTES} UTF-8 bytes`;
  if (/^[A-Za-z]:/.test(value)) return 'must not start with a drive-letter prefix';
  if (value.startsWith('/')) return 'must not start with /';
  if (value.endsWith('/')) return 'must name a file or glob, not end with /';
  if (value.includes('\\')) return 'must use repository-relative / separators, not backslashes';
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0)) return 'must not contain an empty path segment';
  if (segments.some((segment) => segment === '.')) return 'must not contain a . path segment; use the canonical spelling without .';
  if (segments.some((segment) => segment === '..')) return 'must not contain a .. path segment';
  if (!allowGlob && value.includes('*')) return 'must be an exact file path, not a glob';
  return null;
}

function checkEdges(p, f) {
  const writeBoundary = new Map();
  for (const u of rows(p.units)) {
    const valid = [];
    for (const [i, entry] of arr(u.write_boundary).entries()) {
      const problem = repositoryPathProblem(entry, { allowGlob: true });
      if (problem) f.add('PATH_SHAPE', `units.${u.id ?? '?'}.write_boundary[${i}]`, `write-boundary entry ${problem}`);
      else if (isText(entry)) valid.push(entry);
    }
    writeBoundary.set(u.id, valid);
  }
  for (const [i, e] of rows(p.edges).entries()) {
    const at = `edges[${i}]`;
    if (!EDGE_TYPES.includes(e.type)) f.add('EDGE_TYPE', at, `type must be one of ${EDGE_TYPES.join(', ')}, found ${JSON.stringify(e.type ?? null)}`);
    if (!isText(e.reason) || !isText(e.evidence)) f.add('EDGE_EVIDENCE', at, 'every edge needs a reason and evidence');
    if (isText(e.from) && e.from === e.to) f.add('EDGE_SELF', at, `self edge on ${e.from}`);
    if (e.blocks_pickup === true && !HARD_EDGE_TYPES.includes(e.type)) {
      f.add('EDGE_FALSE_HARD', at,
        `only ${HARD_EDGE_TYPES.join(' and ')} edges may block pickup; a ${e.type} edge recorded as blocking falsely serializes implementation`);
    }
    if (e.blocks_pickup !== true && e.blocks_pickup !== false) f.add('EDGE_EVIDENCE', at, 'blocks_pickup must be stated explicitly as true or false');
    // A claimed shared-file conflict must name a file inside both units' write
    // boundaries; otherwise the conflict it schedules around does not exist.
    if (!isText(e.conflict_path)) continue;
    const problem = repositoryPathProblem(e.conflict_path, { allowGlob: false });
    if (problem) {
      f.add('PATH_SHAPE', `${at}.conflict_path`, `conflict_path ${problem}`);
      continue;
    }
    for (const end of ['from', 'to']) {
      const boundary = writeBoundary.get(e[end]);
      if (boundary !== undefined && !boundary.some((pattern) => pathMatches(pattern, e.conflict_path))) {
        f.add('EDGE_CONFLICT_UNDECLARED', `${at}.conflict_path`,
          `${e.conflict_path} is not in ${e[end]}'s write boundary, so the claimed conflict does not exist`);
      }
    }
  }
}

// --- hard graph --------------------------------------------------------------

// An edge {from, to} reads "from depends on to": `to` must land first.
function hardEdges(p) {
  return rows(p.edges).filter((e) => e.blocks_pickup === true && HARD_EDGE_TYPES.includes(e.type) && isText(e.from) && isText(e.to) && e.from !== e.to);
}

function dependencies(nodes, edges) {
  const deps = new Map(nodes.map((n) => [n, []]));
  for (const e of edges) if (deps.has(e.from) && deps.has(e.to)) deps.get(e.from).push(e.to);
  for (const list of deps.values()) list.sort();
  return deps;
}

export function findCycles(nodes, edges) {
  const deps = dependencies(nodes, edges);
  const cycles = [];
  const state = new Map(nodes.map((n) => [n, 0])); // 0 unvisited, 1 on stack, 2 done
  const stack = [];
  const visit = (n) => {
    state.set(n, 1);
    stack.push(n);
    for (const next of deps.get(n) ?? []) {
      if (state.get(next) === 1) cycles.push([...stack.slice(stack.indexOf(next)), next]);
      else if (state.get(next) === 0) visit(next);
    }
    stack.pop();
    state.set(n, 2);
  };
  for (const n of [...nodes].sort()) if (state.get(n) === 0) visit(n);
  return cycles;
}

// Topological levels over the hard graph: level n becomes pickable once level
// n-1 has landed. Nodes in or behind a cycle get no wave; the cycle is a finding.
export function batches(nodes, edges) {
  const deps = dependencies(nodes, edges);
  const level = new Map();
  let remaining = [...nodes].sort();
  const out = [];
  while (remaining.length) {
    const ready = remaining.filter((n) => deps.get(n).every((d) => level.has(d)));
    if (ready.length === 0) break; // cycle: reported separately
    for (const n of ready) level.set(n, out.length);
    out.push(ready);
    remaining = remaining.filter((n) => !level.has(n));
  }
  return out;
}

// Longest chain of hard edges, i.e. the sequence no parallelism can shorten.
export function criticalPath(nodes, edges) {
  const deps = dependencies(nodes, edges);
  const memo = new Map();
  const walk = (n, seen = new Set()) => {
    if (memo.has(n)) return memo.get(n);
    if (seen.has(n)) return [];
    seen.add(n);
    let best = [];
    for (const d of deps.get(n) ?? []) {
      const chain = walk(d, new Set(seen));
      if (chain.length > best.length) best = chain;
    }
    const result = [n, ...best];
    memo.set(n, result);
    return result;
  };
  let longest = [];
  for (const n of [...nodes].sort()) {
    const chain = walk(n);
    if (chain.length > longest.length) longest = chain;
  }
  return [...longest].reverse(); // earliest prerequisite first
}

function graphReport(p) {
  const nodes = rows(p.units).map((u) => u.id).filter(isText);
  // A hard edge to an existing key is a prerequisite outside this map, not a graph node.
  const homes = homeKeys(p);
  const prerequisites = {};
  for (const e of hardEdges(p)) if (homes.has(e.to)) (prerequisites[e.from] ??= []).push(e.to);
  for (const list of Object.values(prerequisites)) list.sort();
  const edges = hardEdges(p).filter((e) => !homes.has(e.to));
  const fanOut = Object.fromEntries(nodes.map((n) => [n, edges.filter((e) => e.to === n).length]));
  const fanIn = Object.fromEntries(nodes.map((n) => [n, edges.filter((e) => e.from === n).length]));
  const cycles = findCycles(nodes, edges);
  return {
    nodes: nodes.length,
    hard_edges: edges.length,
    coordination_edges: rows(p.edges).filter((e) => e.type === 'coordination').length,
    roots: nodes.filter((n) => fanIn[n] === 0).sort(),
    cycles,
    // Undefined while a cycle stands: report none rather than a walk that reads like a plan.
    critical_path: cycles.length ? [] : criticalPath(nodes, edges),
    batches: batches(nodes, edges),
    fan_in: fanIn,
    fan_out: fanOut,
    prerequisites,
  };
}

function checkForbiddenReadiness(value, f, at = '$', seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkForbiddenReadiness(item, f, `${at}[${i}]`, seen));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const where = at === '$' ? key : `${at}.${key}`;
    if (key === 'readiness') {
      f.add('READINESS_FORBIDDEN', where, 'planning never emits a readiness field');
      continue;
    }
    const carriesState = key.includes('readiness') || STATE_FIELD_SUFFIXES.some((suffix) => key.endsWith(suffix));
    // A label list asserts each entry, so one level of list is read as well as a single value.
    const asserted = carriesState ? [item].flat().filter((v) => typeof v === 'string' && FORBIDDEN_STATES.has(v)) : [];
    if (asserted.length) {
      f.add('READINESS_FORBIDDEN', where, `planning projections cannot assert the reserved readiness or lifecycle value ${asserted.join(', ')} in the ${key} field`);
    }
    checkForbiddenReadiness(item, f, where, seen);
  }
}

function resultFor(p, f) {
  const graph = graphReport(p);
  for (const cyc of graph.cycles) f.add('GRAPH_CYCLE', 'edges', `pickup-blocking cycle: ${cyc.join(' -> ')}`);
  const units = rows(p.units);
  return {
    schema: SCHEMA_TAG,
    ok: f.findings.length === 0,
    findings: f.findings,
    counts: {
      sources: rows(p.sources).length,
      included_sources: rows(p.sources).filter((s) => s.included === true).length,
      slices: rows(p.slices).length,
      units: units.length,
      skeletons: units.filter((u) => u.kind === 'skeleton').length,
      edges: rows(p.edges).length,
      decisions_needed: rows(p.decisions).filter((d) => d.status === 'needed').length,
    },
    graph,
  };
}

export function checkProposal(proposal) {
  const findings = [];
  const f = { findings, add: (code, where, message) => { findings.push({ code, where, message }); } };
  if (!isObject(proposal)) {
    f.add('SCHEMA_TYPE', '$', 'projection root must be an object');
    return resultFor({}, f);
  }
  const decisionStatus = new Map(rows(proposal.decisions).map((d) => [d.id, d.status]));
  checkEnvelope(proposal, f);
  checkForbiddenReadiness(proposal, f);
  checkBaseline(proposal, f);
  checkReferences(proposal, collectIds(proposal, f), f);
  checkCoverage(proposal, decisionStatus, f);
  checkHomes(proposal, f);
  checkUnits(proposal, decisionStatus, f);
  checkPath(proposal, f);
  checkEdges(proposal, f);
  return resultFor(proposal, f);
}

export function formatReport(result) {
  const { counts, graph } = result;
  const lines = [
    `sources ${counts.included_sources}/${counts.sources} included · slices ${counts.slices} · units ${counts.units} (skeleton ${counts.skeletons}) · edges ${counts.edges} (hard ${graph.hard_edges}, coordination ${graph.coordination_edges}) · decisions needed ${counts.decisions_needed}`,
    `roots: ${graph.roots.join(', ') || '(none)'}`,
    `critical path: ${graph.critical_path.join(' -> ') || (graph.cycles.length ? '(undefined while a cycle stands)' : '(none)')}`,
    ...graph.batches.map((b, i) => `batch ${i + 1}: ${b.join(', ')}`),
  ];
  // Printed so the packet carries the whole read-out the procedure asks for.
  const degrees = Object.keys(graph.fan_in).sort().map((n) => `${n} ${graph.fan_in[n]}/${graph.fan_out[n]}`).join(' · ');
  if (degrees) lines.push(`fan-in/fan-out: ${degrees}`);
  const waits = Object.keys(graph.prerequisites).sort().map((n) => `${n} <- ${graph.prerequisites[n].join(', ')}`).join(' · ');
  if (waits) lines.push(`existing prerequisites: ${waits}`);
  lines.push('');
  if (result.ok) {
    lines.push('no findings — bookkeeping is consistent. Semantic decomposition still needs the independent review.');
  } else {
    lines.push(`${result.findings.length} finding(s):`, ...result.findings.map((x) => `  ${x.code}  ${x.where}: ${x.message}`));
  }
  return lines.join('\n');
}

export function parseArguments(argv) {
  const jsonFlags = [];
  const unknownFlags = [];
  const paths = [];
  let parsingOptions = true;
  for (const arg of argv) {
    if (parsingOptions && arg === '--') parsingOptions = false;
    else if (parsingOptions && arg === '--json') jsonFlags.push(arg);
    else if (parsingOptions && arg.startsWith('--')) unknownFlags.push(arg);
    else paths.push(arg);
  }
  return { asJson: jsonFlags.length > 0, jsonFlags, unknownFlags, paths };
}

function main(argv) {
  const { asJson, jsonFlags, unknownFlags, paths } = parseArguments(argv);
  const inputError = (message) => {
    if (asJson) console.log(JSON.stringify({ schema: SCHEMA_TAG, ok: false, error: { code: 'INPUT_ERROR', message } }, null, 2));
    else console.error(message);
    return 2;
  };
  if (paths.length !== 1 || jsonFlags.length > 1 || unknownFlags.length > 0) {
    const detail = unknownFlags.length ? `unknown option ${unknownFlags[0]}`
      : paths.length > 1 ? 'exactly one proposal path is accepted'
        : jsonFlags.length > 1 ? '--json may be supplied at most once' : 'one proposal path is required';
    return inputError(`usage: check-proposal.mjs <proposal.json> [--json] (${detail})`);
  }
  let proposal;
  try {
    proposal = JSON.parse(fs.readFileSync(paths[0], 'utf8'));
  } catch (e) {
    return inputError(`cannot read proposal projection: ${e.message}`);
  }
  const result = checkProposal(proposal);
  console.log(asJson ? JSON.stringify(result, null, 2) : formatReport(result));
  return result.ok ? 0 : 1;
}

// Resolve symlinks before comparing: through a symlinked skill or plugin directory
// a naive comparison silently imports this file instead of running it — an
// exit 0 that checked nothing.
export function isMainModule(url, argv1) {
  if (!argv1) return false;
  try {
    return url === pathToFileURL(fs.realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) process.exit(main(process.argv.slice(2)));
