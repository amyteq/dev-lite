// Fixture tests for the dev-analyse-rp proposal checker. Plain Node (matches
// the repo's script-test style); run with
// `node skills/dev-analyse-rp/check-proposal.test.mjs` or
// `npm test` from the plugin root.
//
// Scope note: these prove the deterministic helper only. Whether a
// decomposition is semantically right is decided by the independent planning
// review in references/review.md, and no test here claims otherwise.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkProposal, formatReport, findCycles, batches, criticalPath, pathMatches, isMainModule, parseArguments } from './check-proposal.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
const codes = (result) => [...new Set(result.findings.map((f) => f.code))].sort();

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { console.error(`FAIL - ${name}\n  ${e.message}`); process.exitCode = 1; }
};

// --- the two paths, clean ----------------------------------------------------

check('valid-direct passes with no findings', () => {
  const r = checkProposal(load('valid-direct'));
  assert.deepStrictEqual(r.findings, [], `unexpected findings:\n${formatReport(r)}`);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.counts.units, 3);
  assert.strictEqual(r.counts.skeletons, 0);
});

check('valid-skeleton passes with no findings', () => {
  const r = checkProposal(load('valid-skeleton'));
  assert.deepStrictEqual(r.findings, [], `unexpected findings:\n${formatReport(r)}`);
  assert.strictEqual(r.counts.skeletons, 2);
  assert.strictEqual(r.counts.decisions_needed, 1);
});

// --- projection schema boundary ---------------------------------------------

check('wrong section types and missing baseline/boundary fields cannot pass vacuously', () => {
  const p = load('valid-direct');
  p.sources = {};
  p.coverage = {};
  delete p.boundary.actors;
  delete p.boundary.outcomes;
  delete p.baseline.worktree_status_porcelain;
  const r = checkProposal(p);
  assert.ok(codes(r).includes('SCHEMA_TYPE'));
  assert.ok(codes(r).includes('SCHEMA_FIELD'));
  assert.ok(codes(r).includes('BASELINE_FIELD'));
  assert.strictEqual(r.ok, false);
});

check('baseline worktree status preserves porcelain text and rejects missing or non-text observations', () => {
  const observed = load('valid-direct');
  observed.baseline.worktree_status_porcelain = ' M tracked-file.md\n?? untracked-directory/';
  assert.deepStrictEqual(checkProposal(observed).findings, []);

  const missing = load('valid-direct');
  delete missing.baseline.worktree_status_porcelain;
  const missingResult = checkProposal(missing);
  assert.deepStrictEqual(codes(missingResult), ['BASELINE_FIELD']);
  assert.strictEqual(missingResult.findings[0].where, 'baseline.worktree_status_porcelain');

  const nonText = load('valid-direct');
  nonText.baseline.worktree_status_porcelain = true;
  const nonTextResult = checkProposal(nonText);
  assert.deepStrictEqual(codes(nonTextResult), ['BASELINE_FIELD', 'SCHEMA_TYPE']);
  assert.ok(nonTextResult.findings.every((f) => f.where === 'baseline.worktree_status_porcelain'));
});

check('documented scalar fields reject malformed inclusion and owner values', () => {
  const inclusion = load('valid-direct');
  inclusion.sources[0].included = 'false';
  const inclusionResult = checkProposal(inclusion);
  assert.deepStrictEqual(codes(inclusionResult), ['SCHEMA_TYPE']);
  assert.ok(inclusionResult.findings.some((f) => f.where === 'sources[0].included'));
  assert.strictEqual(inclusionResult.counts.included_sources, 3, 'malformed inclusion is not counted as included');

  const absent = load('valid-direct');
  const dropped = absent.sources[0].id;
  delete absent.sources[0].included;
  absent.coverage = absent.coverage.filter((c) => c.source_id !== dropped);
  const absentResult = checkProposal(absent);
  assert.deepStrictEqual(codes(absentResult), ['SCHEMA_FIELD'], 'an absent inclusion state cannot hide an uncovered source');
  assert.ok(absentResult.findings.some((f) => f.where === `sources.${dropped}.included`));

  const owner = load('valid-direct');
  owner.units[0].owner = {};
  owner.units[0].blockers = ['Owner must be assigned.'];
  const ownerResult = checkProposal(owner);
  assert.deepStrictEqual(codes(ownerResult), ['SCHEMA_TYPE']);
  assert.ok(ownerResult.findings.some((f) => f.where === 'units[0].owner'));
});

check('every declared section enforces its object or list container type', () => {
  for (const section of ['baseline', 'boundary', 'verdict', 'review']) {
    const p = load('valid-direct');
    p[section] = [];
    assert.ok(codes(checkProposal(p)).includes('SCHEMA_TYPE'), `${section} accepted a list`);
  }
  for (const section of ['journey', 'sources', 'coverage', 'slices', 'units', 'edges', 'decisions', 'seam_evidence']) {
    const p = load('valid-direct');
    p[section] = {};
    assert.ok(codes(checkProposal(p)).includes('SCHEMA_TYPE'), `${section} accepted an object`);
  }
  const p = load('valid-skeleton');
  p.downstream = [];
  assert.ok(codes(checkProposal(p)).includes('SCHEMA_TYPE'), 'downstream accepted a list');
});

check('every candidate unit needs an explicit positive scope', () => {
  const p = load('valid-direct');
  delete p.units[0].scope;
  const r = checkProposal(p);
  assert.ok(codes(r).includes('UNIT_FIELD_MISSING'));
  assert.ok(r.findings.some((f) => f.where === 'units.U-1.scope'));
});

check('readiness keys and reserved readiness or lifecycle values in state-carrying fields are forbidden', () => {
  const p = load('valid-direct');
  p.readiness = 'ready';
  assert.deepStrictEqual(codes(checkProposal(p)), ['READINESS_FORBIDDEN']);

  for (const reserved of ['ready', 'blocked', 'current', 'superseded', 'retired']) {
    const status = load('valid-direct');
    status.status = reserved;
    assert.deepStrictEqual(codes(checkProposal(status)), ['READINESS_FORBIDDEN'], `${reserved} was not rejected`);
  }

  const nested = load('valid-direct');
  nested.units[0].metadata = { lifecycle: 'superseded' };
  assert.deepStrictEqual(codes(checkProposal(nested)), ['READINESS_FORBIDDEN']);

  for (const key of ['implementation_status', 'readiness_status', 'delivery_state', 'story_lifecycle', 'planning_phase', 'issue_label']) {
    const alias = load('valid-direct');
    alias[key] = 'ready';
    assert.deepStrictEqual(codes(checkProposal(alias)), ['READINESS_FORBIDDEN'], `${key} was not rejected`);
  }

  const labels = load('valid-direct');
  labels.units[0].labels = ['story', 'tasks:board', 'ready'];
  const labelsResult = checkProposal(labels);
  assert.deepStrictEqual(codes(labelsResult), ['READINESS_FORBIDDEN']);
  assert.match(labelsResult.findings[0].message, /value ready in the labels field/);
  labels.units[0].labels = ['story', 'tasks:board'];
  assert.deepStrictEqual(checkProposal(labels).findings, [], 'type and feat labels are not readiness');

  const freeTextAlias = load('valid-direct');
  freeTextAlias.implementation_status = 'Describes implementation evidence without asserting a lifecycle value.';
  assert.deepStrictEqual(checkProposal(freeTextAlias).findings, []);
});

check('reserved readiness and lifecycle words remain valid when faithfully quoted in free-text fields', () => {
  const p = load('valid-skeleton');
  p.sources[0].title = 'ready';
  p.decisions[0].question = 'current';
  p.edges[0].evidence = 'blocked';
  assert.deepStrictEqual(checkProposal(p).findings, []);
});

check('parseable malformed roots and rows produce schema findings instead of throwing', () => {
  const root = checkProposal(null);
  assert.deepStrictEqual(codes(root), ['SCHEMA_TYPE']);
  assert.strictEqual(root.ok, false);

  for (const section of ['journey', 'sources', 'coverage', 'slices', 'units', 'edges', 'decisions', 'seam_evidence']) {
    const p = load('valid-direct');
    p[section] = [null];
    const row = checkProposal(p);
    assert.ok(codes(row).includes('SCHEMA_TYPE'), `${section} did not report its malformed row`);
    assert.strictEqual(row.ok, false);
  }

  const review = load('valid-direct');
  review.review.findings = [null];
  assert.ok(codes(checkProposal(review)).includes('SCHEMA_TYPE'));
});

check('every emitted result code is documented and has a test or fixture', () => {
  const checkerSource = fs.readFileSync(path.join(HERE, 'check-proposal.mjs'), 'utf8');
  const projectionSource = fs.readFileSync(path.join(HERE, 'references', 'projection.md'), 'utf8');
  const enforcementTable = projectionSource
    .split('## What the checker enforces\n', 2)[1]
    .split('\nThe checker also computes', 1)[0];
  const testSource = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const fixtureSource = fs.readdirSync(FIXTURES)
    .filter((name) => name.endsWith('.json'))
    .map((name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8'))
    .join('\n');
  const emittedCodes = new Set([
    ...[...checkerSource.matchAll(/f\.add\('([A-Z_]+)'/g)].map((match) => match[1]),
    ...[...checkerSource.matchAll(/code: '([A-Z_]+)'/g)].map((match) => match[1]),
    // requireFields rules: [code, 'field', predicate, message].
    ...[...checkerSource.matchAll(/\['([A-Z_]+)', '[a-z_]+', /g)].map((match) => match[1]),
  ]);
  for (const code of [...emittedCodes].sort()) {
    assert.ok(enforcementTable.includes(`\`${code}\``), `${code} is missing from the enforcement table`);
    assert.ok(testSource.includes(`'${code}'`) || fixtureSource.includes(code), `${code} has no test or fixture`);
  }
});

// --- one defect class per fixture -------------------------------------------

check('duplicate ownership of one source item is rejected', () => {
  const r = checkProposal(load('duplicate-ownership'));
  assert.deepStrictEqual(codes(r), ['COVERAGE_DUPLICATE']);
  assert.match(r.findings[0].message, /U-1, U-2/);
});

check('an included source with no disposition, and a unit with no owner, are rejected', () => {
  const r = checkProposal(load('missing-ownership'));
  assert.deepStrictEqual(codes(r), ['COVERAGE_MISSING', 'UNIT_BLOCKER_HIDDEN']);
});

check('unknown and duplicated identifiers are rejected', () => {
  const r = checkProposal(load('unknown-ids'));
  assert.deepStrictEqual(codes(r), ['ID_DUPLICATE', 'REF_UNKNOWN']);
  assert.strictEqual(r.findings.filter((f) => f.code === 'REF_UNKNOWN').length, 2);
});

check('a cycle among pickup-blocking edges is rejected', () => {
  const r = checkProposal(load('hard-cycle'));
  assert.deepStrictEqual(codes(r), ['GRAPH_CYCLE']);
  assert.match(r.findings[0].message, /U-1 -> U-2 -> U-1|U-2 -> U-1 -> U-2/);
  // U-3 hard-depends on U-1, which is inside the cycle, so nothing is pickable:
  // the batch read-out stops rather than inventing a feasible wave, and no
  // critical path is reported for a graph that has no longest chain.
  assert.deepStrictEqual(r.graph.batches, []);
  assert.deepStrictEqual(r.graph.critical_path, []);
  assert.match(formatReport(r), /undefined while a cycle stands/);
});

check('a non-hard edge recorded as pickup-blocking is rejected', () => {
  const r = checkProposal(load('false-hard-dependency'));
  assert.deepStrictEqual(codes(r), ['EDGE_FALSE_HARD']);
  assert.match(r.findings[0].message, /falsely serializes/);
});

check('a unit with two observable outcomes is rejected', () => {
  const r = checkProposal(load('multi-outcome-unit'));
  assert.deepStrictEqual(codes(r), ['UNIT_MULTI_OUTCOME']);
  assert.match(r.findings[0].message, /found 2/);
});

check('counts without a semantic rationale cannot pass a unit', () => {
  const r = checkProposal(load('size-metrics-only'));
  assert.deepStrictEqual(codes(r), ['UNIT_SPLIT_RATIONALE', 'UNIT_TRIPWIRE_DISPOSITION']);
});

check('an unresolved decision with no visible blocker is rejected', () => {
  const r = checkProposal(load('missing-decision'));
  assert.deepStrictEqual(codes(r), ['DECISION_UNRESOLVED_HIDDEN']);
  assert.match(r.findings[0].message, /D-1 is unresolved/);
});

check('a source pinning another repository state is rejected', () => {
  const r = checkProposal(load('conflicting-baseline'));
  assert.deepStrictEqual(codes(r), ['BASELINE_CONFLICT']);
  assert.match(r.findings[0].message, /9a8b7c6d5e4f30219a8b7c6d5e4f30219a8b7c6d/);
});

check('a downstream unit frozen before the skeleton merges is rejected', () => {
  const r = checkProposal(load('premature-pass2-freeze'));
  assert.deepStrictEqual(codes(r), ['FREEZE_PREMATURE', 'PATH_TRIGGER']);
  assert.strictEqual(r.findings.filter((f) => f.code === 'FREEZE_PREMATURE').length, 2);
});

// --- journey, review and coordination-edge checks ---------------------------

check('a journey step with no slice and no deferral is rejected', () => {
  const r = checkProposal(load('journey-uncovered'));
  assert.deepStrictEqual(codes(r), ['JOURNEY_UNCOVERED']);
  assert.match(r.findings[0].where, /J-3/);
});

check('a missing journey backbone is rejected', () => {
  const p = load('valid-direct');
  p.journey = [];
  p.slices.forEach((slice) => { delete slice.journey_step; });
  assert.deepStrictEqual(codes(checkProposal(p)), ['JOURNEY_MISSING']);
});

check('a packet cannot call itself complete with no recorded review', () => {
  const r = checkProposal(load('unreviewed-complete'));
  assert.deepStrictEqual(codes(r), ['VERDICT_UNSUPPORTED']);
  assert.match(r.findings[0].message, /an unwritten review is not evidence/);
});

check('a blocked proposal still requires a recorded independent review', () => {
  const p = load('valid-skeleton');
  delete p.review;
  const r = checkProposal(p);
  assert.deepStrictEqual(codes(r), ['VERDICT_UNSUPPORTED']);
  assert.match(r.findings[0].message, /blocked proposal requires a recorded independent review/);
});

check('analysis_stopped is the only verdict that may omit review evidence', () => {
  const p = load('valid-skeleton');
  delete p.review;
  p.verdict.state = 'analysis_stopped';
  assert.deepStrictEqual(checkProposal(p).findings, []);
});

check('completeness also fails on a non-sound review or an open P0/P1', () => {
  const p = load('valid-direct');
  p.review.verdict = 'needs_changes';
  p.review.findings[0].disposition = 'deferred';
  p.review.findings[0].owner = '@someone';
  const r = checkProposal(p);
  assert.deepStrictEqual(codes(r), ['VERDICT_UNSUPPORTED']);
  assert.strictEqual(r.findings.length, 2, 'both the review verdict and the open finding are reported');
});

check('a malformed verdict field reports VERDICT_FIELD', () => {
  const p = load('valid-direct');
  p.verdict.state = 'not_a_verdict';
  assert.deepStrictEqual(codes(checkProposal(p)), ['VERDICT_FIELD']);
});

check('a review finding needs a stable id, severity and disposition', () => {
  const p = load('valid-direct');
  p.review.findings.push({ claim: 'unlabelled', severity: 'P4', disposition: 'maybe' });
  const r = checkProposal(p);
  assert.deepStrictEqual(codes(r), ['REVIEW_FIELD', 'VERDICT_UNSUPPORTED']);
});

check('a coordination edge naming a file outside both write boundaries is rejected', () => {
  const r = checkProposal(load('phantom-conflict'));
  assert.deepStrictEqual(codes(r), ['EDGE_CONFLICT_UNDECLARED']);
  assert.match(r.findings[0].message, /the claimed conflict does not exist/);
});

check('coordination conflict paths use exact membership, not substring containment', () => {
  const p = load('valid-direct');
  p.units.find((u) => u.id === 'U-3').write_boundary = ['docs/package.json.notes'];
  const r = checkProposal(p);
  assert.deepStrictEqual(codes(r), ['EDGE_CONFLICT_UNDECLARED']);
  assert.match(r.findings[0].message, /package\.json is not in U-3's write boundary/);
});

check('write-boundary globs match one segment with star and nested segments with globstar', () => {
  assert.strictEqual(pathMatches('references/*.md', 'references/projection.md'), true);
  assert.strictEqual(pathMatches('references/*.md', 'references/nested/projection.md'), false);
  assert.strictEqual(pathMatches('references/**/*.md', 'references/nested/projection.md'), true);
  assert.strictEqual(pathMatches('package.json', 'docs/package.json.notes'), false);
  assert.strictEqual(pathMatches('src/reports/**', 'src/reports/csv/rows.ts'), true);
  assert.strictEqual(pathMatches('docs/**', 'docs/help/README.md'), true);
  assert.strictEqual(pathMatches('x*y', 'x*zy'), true, 'a star in the candidate is ordinary text, so the pattern star may cover it');

  const p = load('valid-direct');
  p.units.find((u) => u.id === 'U-2').write_boundary = ['shared/**'];
  p.units.find((u) => u.id === 'U-3').write_boundary = ['shared/**/*.md'];
  p.edges.find((e) => e.type === 'coordination').conflict_path = 'shared/nested/catalogue.md';
  assert.deepStrictEqual(checkProposal(p).findings, []);
});

check('conflict paths and write-boundary entries must have repository-relative file shape', () => {
  for (const conflictPath of ['.', './file.md', 'docs/./file.md', 'C:/outside', 'c:outside', '../outside', '/outside', 'docs/', 'docs//file.md', 'docs/*.md', 'docs\\file.md']) {
    const p = load('valid-direct');
    p.units.forEach((unit) => { unit.write_boundary = ['**']; });
    p.edges.find((e) => e.type === 'coordination').conflict_path = conflictPath;
    const r = checkProposal(p);
    assert.deepStrictEqual(codes(r), ['PATH_SHAPE'], `${conflictPath} was not rejected before membership matching`);
  }

  for (const boundary of ['.', './file.md', 'docs/./file.md', 'C:/outside', 'c:outside', '../outside', '/outside', 'docs/', 'docs//file.md', 'docs\\file.md']) {
    const p = load('valid-direct');
    p.units[0].write_boundary = [boundary];
    const r = checkProposal(p);
    assert.ok(codes(r).includes('PATH_SHAPE'), `${boundary} was accepted as a write-boundary entry`);
  }
});

check('repository path fields reject every ASCII control character', () => {
  const controlCharacters = [...Array.from({ length: 0x20 }, (_, i) => i), 0x7F];
  for (const codePoint of controlCharacters) {
    const control = String.fromCodePoint(codePoint);
    const label = `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;

    const conflict = load('valid-direct');
    conflict.units.forEach((unit) => { unit.write_boundary = ['**']; });
    conflict.edges.find((edge) => edge.type === 'coordination').conflict_path = `control${control}path`;
    assert.deepStrictEqual(codes(checkProposal(conflict)), ['PATH_SHAPE'], `${label} was accepted in conflict_path`);

    const boundary = load('valid-direct');
    boundary.units[0].write_boundary = [`control${control}path`];
    assert.deepStrictEqual(codes(checkProposal(boundary)), ['PATH_SHAPE'], `${label} was accepted in write_boundary`);
  }
});

check('repository path fields reject values over the 4096-byte matching limit', () => {
  const accepted = load('valid-direct');
  accepted.units[0].write_boundary = ['a'.repeat(4096)];
  assert.deepStrictEqual(checkProposal(accepted).findings, []);

  const boundary = load('valid-direct');
  boundary.units[0].write_boundary = ['a'.repeat(4097)];
  assert.ok(codes(checkProposal(boundary)).includes('PATH_SHAPE'));

  const conflict = load('valid-direct');
  conflict.units.forEach((unit) => { unit.write_boundary = ['**']; });
  conflict.edges.find((e) => e.type === 'coordination').conflict_path = 'a'.repeat(4097);
  assert.deepStrictEqual(codes(checkProposal(conflict)), ['PATH_SHAPE']);
});

check('glob matching does not build a backtracking regular expression', () => {
  const start = process.hrtime.bigint();
  const matched = pathMatches('a*'.repeat(12) + 'b', 'a'.repeat(36));
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.strictEqual(matched, false);
  assert.ok(elapsedMs < 500, `pathMatches took ${elapsedMs.toFixed(1)}ms`);
});

check('the read-out carries fan-in and fan-out, not just the batches', () => {
  const text = formatReport(checkProposal(load('valid-direct')));
  assert.match(text, /fan-in\/fan-out: U-1 0\/2/);
});

// --- checks with no durable fixture of their own ------------------------------

check('planning cannot emit a readiness state', () => {
  const p = load('valid-direct');
  p.units[0].readiness = 'ready';
  assert.deepStrictEqual(codes(checkProposal(p)), ['READINESS_FORBIDDEN']);
});

check('the direct path requires named seam evidence', () => {
  const p = load('valid-direct');
  p.seam_evidence = [];
  assert.deepStrictEqual(codes(checkProposal(p)), ['PATH_SEAM_EVIDENCE']);
});

check('the skeleton path requires a provisional downstream map', () => {
  const p = load('valid-skeleton');
  p.downstream.provisional = false;
  assert.deepStrictEqual(codes(checkProposal(p)), ['PATH_DOWNSTREAM_MAP']);
});

check('the direct path proposes no skeleton candidates', () => {
  const p = load('valid-direct');
  p.units[0].kind = 'skeleton';
  assert.deepStrictEqual(codes(checkProposal(p)), ['PATH_SKELETON_COUNT']);
});

check('the skeleton path requires one to three skeleton candidates', () => {
  const p = load('valid-skeleton');
  p.units[0].kind = 'unit';
  p.units[1].kind = 'unit';
  const r = checkProposal(p);
  assert.ok(codes(r).includes('PATH_SKELETON_COUNT'));
  assert.match(r.findings.find((f) => f.code === 'PATH_SKELETON_COUNT').message, /found 0/);
});

check('a self edge and an unknown edge type are rejected', () => {
  const p = load('valid-direct');
  p.edges.push({ from: 'U-1', to: 'U-1', type: 'blocks', blocks_pickup: false, reason: 'r', evidence: 'e' });
  assert.deepStrictEqual(codes(checkProposal(p)), ['EDGE_SELF', 'EDGE_TYPE']);
});

check('an edge without reason, evidence or an explicit blocks_pickup is rejected', () => {
  const p = load('valid-direct');
  p.edges.push({ from: 'U-1', to: 'U-2', type: 'integration' });
  assert.deepStrictEqual(codes(checkProposal(p)), ['EDGE_EVIDENCE']);
});

check('an abbreviated baseline commit is rejected', () => {
  const p = load('valid-direct');
  p.baseline.commit = '8cdfb6bf';
  assert.deepStrictEqual(codes(checkProposal(p)), ['BASELINE_COMMIT']);
});

check('the baseline identifies exactly one request pack', () => {
  const p = load('valid-direct');
  delete p.baseline.request_pack;
  assert.deepStrictEqual(codes(checkProposal(p)), ['BASELINE_PACK']);
});

check('malformed identifiers are rejected', () => {
  const p = load('valid-direct');
  p.sources[0].id = 'source-one';
  p.coverage[0].source_id = 'source-one';
  assert.deepStrictEqual(codes(checkProposal(p)), ['ID_FORMAT']);
});

check('a malformed decision row is rejected', () => {
  const p = load('valid-direct');
  p.decisions.push({ id: 'D-extra', question: 'Is this settled?', status: 'unknown', owner: null, evidence: null });
  assert.deepStrictEqual(codes(checkProposal(p)), ['DECISION_FIELD']);
});

check('an excluded source needs an omission reason and no in-scope disposition', () => {
  const p = load('valid-direct');
  p.sources[4].omission_reason = null;
  p.coverage.push({ source_id: 'SRC-5', disposition: 'owned', unit_id: 'U-1' });
  assert.deepStrictEqual(codes(checkProposal(p)), ['COVERAGE_UNJUSTIFIED', 'SOURCE_OMISSION_REASON']);
});

check('a deferral without reason and evidence is rejected', () => {
  const p = load('valid-direct');
  p.coverage[3] = { source_id: 'SRC-4', disposition: 'deferred', reason: 'later' };
  assert.deepStrictEqual(codes(checkProposal(p)), ['COVERAGE_UNJUSTIFIED']);
});

check('a blocked coverage row must point to a decision that is still needed', () => {
  const p = load('valid-skeleton');
  p.decisions[0].status = 'confirmed';
  p.decisions[0].evidence = 'docs/decisions/adr/ADR-0001-example.md';
  assert.deepStrictEqual(codes(checkProposal(p)), ['COVERAGE_UNJUSTIFIED']);
});

check('a wrong schema tag and a missing verdict are rejected', () => {
  const p = load('valid-direct');
  p.schema = 'SomethingElseV1';
  delete p.verdict;
  assert.deepStrictEqual(codes(checkProposal(p)), ['SCHEMA_FIELD', 'SCHEMA_TAG']);
});

// --- graph helpers ------------------------------------------------------------

check('findCycles reports the cycle and ignores acyclic fan-out', () => {
  const nodes = ['a', 'b', 'c', 'd'];
  assert.deepStrictEqual(findCycles(nodes, [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }]), []);
  const cycles = findCycles(nodes, [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]);
  assert.strictEqual(cycles.length, 1);
  assert.deepStrictEqual(cycles[0], ['a', 'b', 'a']);
});

check('batches are the feasible parallel waves, deepest prerequisite first', () => {
  const nodes = ['a', 'b', 'c', 'd'];
  const edges = [{ from: 'b', to: 'a' }, { from: 'c', to: 'a' }, { from: 'd', to: 'c' }];
  assert.deepStrictEqual(batches(nodes, edges), [['a'], ['b', 'c'], ['d']]);
});

check('criticalPath is the longest hard chain, earliest prerequisite first', () => {
  const nodes = ['a', 'b', 'c', 'd'];
  const edges = [{ from: 'b', to: 'a' }, { from: 'c', to: 'b' }, { from: 'd', to: 'a' }];
  assert.deepStrictEqual(criticalPath(nodes, edges), ['a', 'b', 'c']);
});

check('coordination edges stay out of the hard graph', () => {
  const r = checkProposal(load('valid-direct'));
  assert.strictEqual(r.graph.hard_edges, 2);
  assert.strictEqual(r.graph.coordination_edges, 1);
  assert.deepStrictEqual(r.graph.batches, [['U-1'], ['U-2', 'U-3']]);
  assert.deepStrictEqual(r.graph.roots, ['U-1']);
});

check('isMainModule resolves symlinks, so the discovery link still runs the CLI', () => {
  const real = path.join(HERE, 'check-proposal.mjs');
  const url = pathToFileURL(real).href;
  assert.strictEqual(isMainModule(url, real), true, 'direct invocation must be detected');
  assert.strictEqual(isMainModule(url, undefined), false);
  assert.strictEqual(isMainModule(url, path.join(HERE, 'does-not-exist.mjs')), false);
  // A plugin cache or a linked skill directory can reach the CLI through a symlink. A naive
  // string compare misses that path and silently imports the module instead of running it —
  // an exit 0 that checked nothing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analyse-rp-link-'));
  try {
    const link = path.join(dir, 'check-proposal.mjs');
    fs.symlinkSync(real, link);
    assert.strictEqual(isMainModule(url, link), true, 'symlinked invocation must be detected');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('a bare -- ends option parsing and permits a leading-double-dash path', () => {
  assert.deepStrictEqual(parseArguments(['--', '--proposal.json']), {
    asJson: false,
    jsonFlags: [],
    unknownFlags: [],
    paths: ['--proposal.json'],
  });
  assert.deepStrictEqual(parseArguments(['--json', '--', '--json']), {
    asJson: true,
    jsonFlags: ['--json'],
    unknownFlags: [],
    paths: ['--json'],
  });
});

check('the CLI exits 1 and names the finding when run as a subprocess', () => {
  const cli = path.join(HERE, 'check-proposal.mjs');
  const run = (file) => spawnSync(process.execPath, [cli, file], { encoding: 'utf8' });
  const clean = run(path.join(FIXTURES, 'valid-direct.json'));
  assert.strictEqual(clean.status, 0);
  assert.match(clean.stdout, /no findings/);
  const dirty = run(path.join(FIXTURES, 'hard-cycle.json'));
  assert.strictEqual(dirty.status, 1);
  assert.match(dirty.stdout, /GRAPH_CYCLE/);
  const missing = run(path.join(FIXTURES, 'no-such-fixture.json'));
  assert.strictEqual(missing.status, 2, 'an unreadable projection must not look like a pass');
  const noArgs = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.strictEqual(noArgs.status, 2);
  const extraPath = spawnSync(process.execPath, [cli, path.join(FIXTURES, 'valid-direct.json'), path.join(FIXTURES, 'hard-cycle.json')], { encoding: 'utf8' });
  assert.strictEqual(extraPath.status, 2, 'a second projection path must be rejected rather than ignored');
  assert.match(extraPath.stderr, /exactly one proposal path is accepted/);
  const unknownFlag = spawnSync(process.execPath, [cli, path.join(FIXTURES, 'valid-direct.json'), '--unknown'], { encoding: 'utf8' });
  assert.strictEqual(unknownFlag.status, 2, 'an unknown option must be invalid usage, not a path');
  assert.match(unknownFlag.stderr, /unknown option --unknown/);
  const extraPathJson = spawnSync(process.execPath, [cli, '--json', path.join(FIXTURES, 'valid-direct.json'), path.join(FIXTURES, 'hard-cycle.json')], { encoding: 'utf8' });
  assert.strictEqual(extraPathJson.status, 2);
  assert.strictEqual(JSON.parse(extraPathJson.stdout).error.code, 'INPUT_ERROR');
  const repeatedJson = spawnSync(process.execPath, [cli, '--json', path.join(FIXTURES, 'valid-direct.json'), '--json'], { encoding: 'utf8' });
  assert.strictEqual(repeatedJson.status, 2, 'the output option may be supplied only once');
  assert.strictEqual(JSON.parse(repeatedJson.stdout).error.code, 'INPUT_ERROR');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-analyse-rp-cli-'));
  try {
    const malformedPath = path.join(tempDir, 'malformed-projection.json');
    fs.writeFileSync(malformedPath, 'null');
    const malformed = spawnSync(process.execPath, [cli, '--json', malformedPath], { encoding: 'utf8' });
    assert.strictEqual(malformed.status, 1, 'a parseable projection with schema findings is not an input/parse error');
    const malformedReport = JSON.parse(malformed.stdout);
    assert.strictEqual(malformedReport.ok, false);
    assert.deepStrictEqual(codes(malformedReport), ['SCHEMA_TYPE']);
    assert.strictEqual(malformed.stderr, '', 'schema findings must not leak a stack trace');

    const invalidJsonPath = path.join(tempDir, 'invalid.json');
    fs.writeFileSync(invalidJsonPath, '{');
    const invalidJson = spawnSync(process.execPath, [cli, '--json', invalidJsonPath], { encoding: 'utf8' });
    assert.strictEqual(invalidJson.status, 2, 'invalid JSON is an input error, distinct from projection findings');
    const inputError = JSON.parse(invalidJson.stdout);
    assert.strictEqual(inputError.error.code, 'INPUT_ERROR');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

check('formatReport names the findings and the scope limit', () => {
  const clean = formatReport(checkProposal(load('valid-direct')));
  assert.match(clean, /no findings/);
  assert.match(clean, /independent review/);
  const dirty = formatReport(checkProposal(load('hard-cycle')));
  assert.match(dirty, /GRAPH_CYCLE/);
});

// --- existing homes ----------------------------------------------------------

check('valid-reconciled passes and lists existing prerequisites outside the unit graph', () => {
  const r = checkProposal(load('valid-reconciled'));
  assert.deepStrictEqual(r.findings, [], `unexpected findings:\n${formatReport(r)}`);
  assert.deepStrictEqual(r.graph.prerequisites, { 'U-3': ['STY_1001'] });
  assert.ok(!r.graph.batches.flat().includes('STY_1001'), 'an existing key is never a graph node');
  assert.deepStrictEqual(r.graph.roots, ['U-1', 'U-4']);
  assert.deepStrictEqual(r.graph.critical_path, ['U-1', 'U-2']);
  assert.deepStrictEqual(r.graph.batches, [['U-1', 'U-4'], ['U-2', 'U-3']]);
  assert.match(formatReport(r), /existing prerequisites: U-3 <- STY_1001/);
});

check('each home fixture reports exactly its defect', () => {
  for (const [name, expected] of [
    ['home-field', [['HOME_FIELD', 'units.U-1.home.level']]],
    ['home-search-missing', [['HOME_SEARCH_MISSING', 'units.U-3.home.search']]],
    ['home-conflict', [['HOME_CONFLICT', 'units.U-2.home']]],
    ['home-feat-unapproved', [['HOME_FEAT_UNAPPROVED', 'units.U-4.home.new_feat']]],
    ['home-ref-unknown', [['REF_UNKNOWN', 'edges[4].to'], ['REF_UNKNOWN', 'units.U-1.home.key']]],
  ]) {
    const found = checkProposal(load(name)).findings.map((x) => [x.code, x.where]).sort();
    assert.deepStrictEqual(found, expected, name);
  }
});

check('HOME_FIELD covers every malformed home shape', () => {
  const cases = [
    ['a key that is not FT_<n> or STY_<n>', (p) => { p.units[0].home.key = 'STY_01'; }, 'units.U-1.home.key'],
    ['a null key on a relation other than new', (p) => { p.units[0].home.key = null; }, 'units.U-1.home.key'],
    ['an unknown level', (p) => { p.units[0].home.level = 'slice'; }, 'units.U-1.home.level'],
    ['an unknown relation', (p) => { p.units[0].home.relation = 'expand'; }, 'units.U-1.home.relation'],
    ['missing evidence', (p) => { delete p.units[0].home.evidence; }, 'units.U-1.home.evidence'],
    ['reuse on a unit', (p) => { p.units[0].home.relation = 'reuse'; }, 'units.U-1.home.relation'],
    ['a non-reuse relation on an existing row', (p) => { p.coverage.find((c) => c.disposition === 'existing').home.relation = 'extend'; }, 'coverage.SRC-6.home.relation'],
    ['reuse at feat level', (p) => { p.coverage.find((c) => c.disposition === 'existing').home.level = 'feat'; }, 'coverage.SRC-6.home.level'],
    ['new homed in a story', (p) => { p.units[2].home.level = 'story'; }, 'units.U-3.home.level'],
    ['a unit with no home', (p) => { delete p.units[0].home; }, 'units.U-1.home'],
    ['an existing row with no home', (p) => { delete p.coverage.find((c) => c.disposition === 'existing').home; }, 'coverage.SRC-6.home'],
    ['a malformed homes row', (p) => { p.homes[0].level = 'programme'; }, 'homes[0]'],
    ['a homes row whose level contradicts its key prefix', (p) => { p.homes[1].level = 'feat'; }, 'homes[1]'],
    ['a unit home naming a feat key at story level', (p) => { p.units[0].home.key = 'FT_101'; }, 'units.U-1.home.level'],
    ['a new unit home naming a story key', (p) => { p.units[2].home.key = 'STY_1001'; }, 'units.U-3.home.level'],
    ['an existing home naming a feat key', (p) => { p.coverage.find((c) => c.disposition === 'existing').home.key = 'FT_101'; },
      'coverage.SRC-6.home.level'],
    ['an amend with no declared dependents', (p) => { delete p.units[1].home.dependents; }, 'units.U-2.home.dependents'],
    ['a supersede with no declared dependents', (p) => { p.units[1].home.relation = 'supersede'; delete p.units[1].home.dependents; },
      'units.U-2.home.dependents'],
  ];
  for (const [name, mutate, where] of cases) {
    const p = load('valid-reconciled');
    mutate(p);
    const found = checkProposal(p).findings.filter((x) => x.code === 'HOME_FIELD').map((x) => x.where);
    assert.deepStrictEqual(found, [where], name);
  }
});

check('home list fields must be lists, and the reconciliation sections are required', () => {
  const p = load('valid-reconciled');
  p.units[1].home.dependents = 'STY_1004';
  assert.deepStrictEqual(checkProposal(p).findings.map((x) => [x.code, x.where]), [['SCHEMA_TYPE', 'units.U-2.home.dependents']]);
  const noHomes = load('valid-reconciled');
  delete noHomes.homes;
  assert.ok(checkProposal(noHomes).findings.some((x) => x.code === 'SCHEMA_FIELD' && x.where === 'homes'));
  const noIndex = load('valid-reconciled');
  delete noIndex.baseline.planning_index;
  assert.deepStrictEqual(checkProposal(noIndex).findings.map((x) => [x.code, x.where]), [['BASELINE_FIELD', 'baseline.planning_index']]);
});

check('HOME_FEAT_UNAPPROVED and HOME_CONFLICT cover their remaining shapes', () => {
  const keyed = load('valid-reconciled');
  keyed.units[3].home.key = 'FT_101';
  assert.deepStrictEqual(checkProposal(keyed).findings.map((x) => [x.code, x.where]), [['HOME_FEAT_UNAPPROVED', 'units.U-4.home.new_feat']]);
  for (const label of [undefined, 'calendar-sync', 'Tasks:Calendar']) {
    const unlabelled = load('valid-reconciled');
    unlabelled.units[3].home.new_feat.label = label;
    assert.deepStrictEqual(checkProposal(unlabelled).findings.map((x) => [x.code, x.where]), [['HOME_FEAT_UNAPPROVED', 'units.U-4.home.new_feat']], String(label));
  }
  const twice = load('valid-reconciled');
  for (const u of twice.units.slice(0, 2)) u.home = { relation: 'supersede', key: 'STY_1003', level: 'story', evidence: 'e', dependents: ['STY_1004'] };
  assert.deepStrictEqual(checkProposal(twice).findings.map((x) => [x.code, x.where]), [['HOME_CONFLICT', 'units.U-1.home']]);
});

check('a coverage row carries only its own disposition\'s cover', () => {
  const withUnit = load('valid-reconciled');
  withUnit.coverage.find((c) => c.disposition === 'existing').unit_id = 'U-1';
  assert.deepStrictEqual(checkProposal(withUnit).findings.map((x) => [x.code, x.where]), [['COVERAGE_UNJUSTIFIED', 'coverage.SRC-6']]);
  const withHome = load('valid-reconciled');
  withHome.coverage[0].home = { relation: 'reuse', key: 'STY_1002', level: 'story', evidence: 'docs/stories/STY_1002_x.md AC2' };
  assert.deepStrictEqual(checkProposal(withHome).findings.map((x) => [x.code, x.where]), [['COVERAGE_UNJUSTIFIED', 'coverage.SRC-1']]);
});

check('only a unit may depend: an edge from an existing key is REF_UNKNOWN', () => {
  const p = load('valid-reconciled');
  p.edges.at(-1).from = 'STY_1002';
  assert.deepStrictEqual(checkProposal(p).findings.map((x) => [x.code, x.where]), [['REF_UNKNOWN', 'edges[4].from']]);
});

check('a key declared twice in homes is ID_DUPLICATE', () => {
  const p = load('valid-reconciled');
  p.homes.push({ ...p.homes[1] });
  assert.deepStrictEqual(checkProposal(p).findings.map((x) => [x.code, x.where]), [['ID_DUPLICATE', 'homes.STY_1001']]);
  // A repeat with a contradicting level is malformed at its own row, since the key prefix fixes the level.
  const relevelled = load('valid-reconciled');
  relevelled.homes.push({ key: 'STY_1001', level: 'feat' });
  assert.deepStrictEqual(checkProposal(relevelled).findings.map((x) => [x.code, x.where]), [['HOME_FIELD', 'homes[4]']]);
});

check('an absent edge endpoint is REF_UNKNOWN, not a silently dropped prerequisite', () => {
  // edges[4] is the pickup-blocking U-3 -> STY_1001 prerequisite; an omitted endpoint used to pass and vanish.
  for (const end of ['from', 'to']) {
    const p = load('valid-reconciled');
    delete p.edges.at(-1)[end];
    const r = checkProposal(p);
    assert.deepStrictEqual(r.findings.map((x) => [x.code, x.where]), [['REF_UNKNOWN', `edges[4].${end}`]], end);
    assert.deepStrictEqual(r.graph.prerequisites, {}, end);
  }
  const nulled = load('valid-reconciled');
  nulled.edges.at(-1).to = null;
  assert.deepStrictEqual(checkProposal(nulled).findings.map((x) => [x.code, x.where]),
    [['SCHEMA_TYPE', 'edges[4].to'], ['REF_UNKNOWN', 'edges[4].to']]);
});

console.log(`\n${pass} checks passed.`);
