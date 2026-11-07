// Tests for the dev-analyse-rp planning index. Plain Node; run with
// `node skills/dev-analyse-rp/planning-index.test.mjs` or `npm test` from the plugin root.
// Every build runs against a temporary git repository, never the live docs/.
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildIndex, BuildStop, indexFromDocs, nextKeys, parseFrontmatter, serializeIndex, verifyHomes } from './planning-index.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'planning-index.mjs');

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { console.error(`FAIL - ${name}\n  ${e.message}`); process.exitCode = 1; }
};

// Every temp path is removed on exit, pass or fail, so runs do not exhaust a shared tmpfs.
const temps = [];
const temp = (p) => { temps.push(p); return p; };
process.on('exit', () => { for (const p of temps) fs.rmSync(p, { recursive: true, force: true }); });

const doc = (fields) => `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n# Body\n`;
const feat = (id, extra = {}) => doc({ id, title: `Feat ${id}`, label: `core:${id.toLowerCase().replace('_', '-')}`, tracking_issue: 'null',
  status: 'current', superseded_by: 'null', ...extra });
const story = (id, feats, extra = {}) => doc({ id, title: `Story ${id}`, feats: `[${feats.join(', ')}]`, status: 'current', superseded_by: 'null', ...extra });

const BASE = {
  'docs/feats/README.md': '# Feats\n\n## Index\n',
  'docs/feats/FT_101_task_board.md': feat('FT_101', { label: 'tasks:board', tracking_issue: 12 }),
  'docs/feats/FT_102_progress.md': feat('FT_102', { label: '"tasks:reports"' }),
  'docs/stories/README.md': '# Stories\n\n## Index\n',
  'docs/stories/STY_101_add_task.md': story('STY_101', ['FT_101']),
  'docs/stories/STY_102_old_board.md': story('STY_102', ['FT_101', 'FT_102'], { status: 'superseded', superseded_by: 'STY_103' }),
  'docs/stories/STY_103_board.md': `---\nid: STY_103\ntitle: 'Board: it''s shared'\nfeats:\n  - FT_102\nstatus: current\nsuperseded_by: ~\n---\n`,
};

const git = (root, ...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });

function repo(overrides = {}) {
  const root = temp(fs.mkdtempSync(path.join(os.tmpdir(), 'planning-index-')));
  for (const [rel, content] of Object.entries({ ...BASE, ...overrides })) {
    if (content === undefined) continue;
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'base');
  return root;
}

const cli = (args, cwd) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
const docsOf = (overrides = {}) => Object.entries({ ...BASE, ...overrides }).filter(([, t]) => t !== undefined).map(([p, text]) => ({ path: p, text }));

function stops(overrides, pattern) {
  assert.throws(() => indexFromDocs('c'.repeat(40), docsOf(overrides)), (e) => e instanceof BuildStop && pattern.test(e.message), String(pattern));
}

// --- frontmatter ---------------------------------------------------------------

check('frontmatter: scalars, quotes, null, numbers, flow and block lists', () => {
  const fm = parseFrontmatter('---\na: plain text: with colon\nb: "q \\"x\\""\nc: \'it\'\'s\'\nd: null\ne: ~\nf: 12\ng: [A, B]\nh: []\ni:\n  - X\n  - Y\nj:\n---\nbody', 'x.md');
  assert.deepStrictEqual(fm, { a: 'plain text: with colon', b: 'q "x"', c: "it's", d: null, e: null, f: 12, g: ['A', 'B'], h: [], i: ['X', 'Y'], j: null });
});

check('frontmatter: anything outside the subset stops', () => {
  for (const [text, pattern] of [
    ['# no frontmatter', /does not start with/], ['---\na: 1\n', /no closing/], ['---\n# comment\n---', /key: value/],
    ['---\na: 1\na: 2\n---', /repeats a/], ['---\n  - x\n---', /outside a list/], ['---\na: 1\n  - x\n---', /outside a list/],
    ['---\na: [x\n---', /unterminated \[list\]/], ['---\na: "x\n---', /quoted/], ['---\na: x #c\n---', /quote the value/],
    ['---\na: {b: 1}\n---', /quote the value/], ['---\na: |\n---', /quote the value/],
  ]) assert.throws(() => parseFrontmatter(text, 'x.md'), (e) => e instanceof BuildStop && pattern.test(e.message), text);
});

// --- build -------------------------------------------------------------------

check('a clean repository builds a sorted, digested index of feats then stories', () => {
  const root = repo();
  const index = buildIndex(root);
  assert.strictEqual(index.schema, 'PlanningIndexV1');
  assert.strictEqual(index.commit, git(root, 'rev-parse', 'HEAD').trim());
  assert.deepStrictEqual(index.rows.map((r) => r.key), ['FT_101', 'FT_102', 'STY_101', 'STY_102', 'STY_103']);
  assert.deepStrictEqual(index.counts, { feat: 2, story: 3 });
  const bodies = [...index.rows].sort((a, b) => (a.path < b.path ? -1 : 1)).map((r) => [r.path,
    crypto.createHash('sha256').update(git(root, 'show', `HEAD:${r.path}`)).digest('hex')]);
  assert.strictEqual(index.digest, `sha256:${crypto.createHash('sha256').update(JSON.stringify({ rows: index.rows, bodies })).digest('hex')}`);
});

check('a body-only edit to a feat scope or a story criterion changes the digest, with the rows unchanged', () => {
  const before = indexFromDocs('c', docsOf());
  for (const at of ['docs/feats/FT_101_task_board.md', 'docs/stories/STY_101_add_task.md']) {
    const after = indexFromDocs('c', docsOf({ [at]: `${BASE[at]}\n- AC-1: a revised criterion\n` }));
    assert.deepStrictEqual(after.rows, before.rows, at);
    assert.notStrictEqual(after.digest, before.digest, at);
  }
  assert.strictEqual(indexFromDocs('c', docsOf()).digest, before.digest, 'same docs, same digest');
});

check('rows take their fields from the frontmatter and record the doc path', () => {
  const rows = Object.fromEntries(buildIndex(repo()).rows.map((r) => [r.key, r]));
  assert.deepStrictEqual(rows.FT_101, { key: 'FT_101', level: 'feat', title: 'Feat FT_101', label: 'tasks:board', tracking_issue: 12,
    status: 'current', superseded_by: null, path: 'docs/feats/FT_101_task_board.md' });
  assert.deepStrictEqual(rows.STY_102, { key: 'STY_102', level: 'story', title: 'Story STY_102', feats: ['FT_101', 'FT_102'],
    status: 'superseded', superseded_by: 'STY_103', path: 'docs/stories/STY_102_old_board.md' });
  assert.deepStrictEqual([rows.STY_103.title, rows.STY_103.feats], ["Board: it's shared", ['FT_102']]);
});

check('no planning directories is an empty index, not a stop', () => {
  const index = buildIndex(repo(Object.fromEntries(Object.keys(BASE).map((k) => [k, undefined]))));
  assert.deepStrictEqual([index.rows, index.counts], [[], { feat: 0, story: 0 }]);
});

check('the same commit builds byte-identical output, and uncommitted edits are never read', () => {
  const root = repo();
  const [a, b] = ['a.json', 'b.json'].map((name) => temp(path.join(os.tmpdir(), `${path.basename(root)}-${name}`)));
  assert.strictEqual(cli(['build', '--out', a], root).status, 0);
  fs.writeFileSync(path.join(root, 'docs/feats/FT_101_task_board.md'), 'broken');
  fs.writeFileSync(path.join(root, 'docs/feats/FT_103_new.md'), feat('FT_103'));
  assert.strictEqual(cli(['build', '--out', b], root).status, 0);
  assert.ok(fs.readFileSync(a).equals(fs.readFileSync(b)));
  assert.strictEqual(fs.readFileSync(a, 'utf8'), serializeIndex(buildIndex(root)));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(a, 'utf8')), buildIndex(root));
});

// --- build stop cases --------------------------------------------------------

check('a misnamed or misplaced doc stops the build', () => {
  stops({ 'docs/feats/FT_0101_x.md': feat('FT_0101') }, /is not named FT_<n>_<snake_slug>\.md/);
  stops({ 'docs/feats/STY_104_x.md': story('STY_104', ['FT_101']) }, /is not named FT_/);
  stops({ 'docs/feats/notes.md': 'x' }, /notes\.md: is not named/);
  stops({ 'docs/stories/STY_104_Bad-Slug.md': story('STY_104', ['FT_101']) }, /is not named STY_/);
  stops({ 'docs/stories/old/STY_104_x.md': story('STY_104', ['FT_101']) }, /directly under docs\/stories/);
});

check('an id other than the file name, a duplicate id, an unknown or missing key stops the build', () => {
  stops({ 'docs/feats/FT_103_x.md': feat('FT_104') }, /FT_103_x\.md: id "FT_104" is not the file name's FT_103/);
  stops({ 'docs/feats/FT_101_again.md': feat('FT_101', { label: 'core:again' }) }, /id FT_101 is also/);
  stops({ 'docs/feats/FT_103_x.md': feat('FT_103', { readiness: 'ready' }) }, /unknown frontmatter key readiness/);
  stops({ 'docs/stories/STY_104_x.md': doc({ id: 'STY_104', title: 't', feats: '[FT_101]', status: 'current' }) }, /has no superseded_by/);
  stops({ 'docs/feats/FT_103_x.md': feat('FT_103', { title: '""' }) }, /title must be non-empty text/);
});

check('an unknown status or an inconsistent superseded_by stops the build', () => {
  stops({ 'docs/feats/FT_103_x.md': feat('FT_103', { status: 'ready' }) }, /status "ready" is not one of current, superseded, retired/);
  stops({ 'docs/feats/FT_103_x.md': feat('FT_103', { status: 'superseded' }) }, /is superseded without superseded_by/);
  stops({ 'docs/feats/FT_103_x.md': feat('FT_103', { superseded_by: 'FT_101' }) }, /is current but names superseded_by/);
  stops({ 'docs/feats/FT_103_x.md': feat('FT_103', { status: 'superseded', superseded_by: 'FT_999' }) }, /superseded_by FT_999 has no doc/);
  stops({ 'docs/feats/FT_103_x.md': feat('FT_103', { status: 'superseded', superseded_by: 'STY_101' }) }, /superseded_by must be null or a FT_<n> key/);
  stops({ 'docs/feats/FT_103_x.md': feat('FT_103', { status: 'superseded', superseded_by: 'FT_103' }) }, /supersedes itself/);
});

check('a malformed or duplicated label or tracking issue stops the build', () => {
  stops({ 'docs/feats/FT_103_x.md': feat('FT_103', { label: 'task-board' }) }, /label must match/);
  stops({ 'docs/feats/FT_103_x.md': feat('FT_103', { label: 'tasks:board' }) }, /label tasks:board is also/);
  stops({ 'docs/feats/FT_103_x.md': feat('FT_103', { tracking_issue: 0 }) }, /tracking_issue must be null or a positive/);
  stops({ 'docs/feats/FT_103_x.md': feat('FT_103', { tracking_issue: '"12"' }) }, /tracking_issue must be null or a positive/);
  stops({ 'docs/feats/FT_103_x.md': feat('FT_103', { tracking_issue: 12 }) }, /tracking issue 12 is also/);
});

check('a story with no feats, a malformed one or one with no doc stops the build', () => {
  stops({ 'docs/stories/STY_104_x.md': story('STY_104', []) }, /feats must be a non-empty list/);
  stops({ 'docs/stories/STY_104_x.md': story('STY_104', ['FT_1x']) }, /feats must be a non-empty list of FT_<n> keys/);
  stops({ 'docs/stories/STY_104_x.md': story('STY_104', ['FT_101', 'FT_101']) }, /feats repeats a key/);
  stops({ 'docs/stories/STY_104_x.md': story('STY_104', ['FT_109']) }, /feats names FT_109, which has no doc/);
});

check('invalid build usage exits 2, and a committed break exits 1 naming its path', () => {
  const root = repo({ 'docs/feats/FT_103_x.md': 'no frontmatter' });
  for (const args of [['build'], ['build', '--out'], ['build', 'x.json'], ['build', '--out', 'a', 'b'], ['rebuild', '--out', 'a']]) {
    assert.strictEqual(cli(args, root).status, 2, args.join(' '));
  }
  const out = path.join(root, 'index.json');
  const r = cli(['build', '--out', out], root);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /docs\/feats\/FT_103_x\.md: does not start with/);
  assert.ok(!fs.existsSync(out), 'a stopped build writes nothing');
  assert.throws(() => buildIndex(root), (e) => e instanceof BuildStop && e.where === 'docs/feats/FT_103_x.md');
});

// --- next free numbers ---------------------------------------------------------

check('an empty category allocates nothing, so a story-only amendment can proceed', () => {
  const dir = temp(fs.mkdtempSync(path.join(os.tmpdir(), 'next-')));
  fs.writeFileSync(path.join(dir, 'index.json'), serializeIndex(indexFromDocs('a'.repeat(40), docsOf())));
  const r = cli(['next', path.join(dir, 'index.json'), 'feat', '0']);
  assert.deepStrictEqual([r.status, r.stdout], [0, '']);
});

// The materialize step's open-PR scan, run as written with a stub `gh`: the files endpoint stops at
// 3,000 paths, so a PR whose listing is shorter than its `changed_files` must stop the scan.
check('materialize stops when a PR lists fewer files than it changed', () => {
  const md = fs.readFileSync(path.join(path.dirname(SCRIPT), 'references/materialize.md'), 'utf8');
  const script = /paginate to the end[^]*?```bash\n([^]*?)```/.exec(md)[1];
  const dir = temp(fs.mkdtempSync(path.join(os.tmpdir(), 'scan-')));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'gh'), `#!/bin/sh
case "$*" in
  *'pulls?state=open'*) echo 7 ;;
  *pulls/7/files*) echo src/a.ts; echo docs/stories/STY_150_x.md ;;
  *pulls/7*) echo "$CHANGED" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const run = (changed) => spawnSync('bash', ['-c', script.replaceAll('$S', dir)], { encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, CHANGED: changed } });
  const whole = run('2');
  assert.strictEqual(whole.status, 0, whole.stderr);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'open-pr-docs.txt'), 'utf8'), '7 docs/stories/STY_150_x.md\n');
  assert.notStrictEqual(run('3001').status, 0, 'a truncated file list must stop the scan');
});

check('next numbers start at 101, pass every held number and never fill a gap', () => {
  const empty = { rows: [] };
  assert.deepStrictEqual(nextKeys(empty, 'feat'), ['FT_101']);
  assert.deepStrictEqual(nextKeys(empty, 'story', 2), ['STY_101', 'STY_102']);
  const index = indexFromDocs('c'.repeat(40), docsOf({ 'docs/stories/STY_102_old_board.md': undefined, 'docs/stories/STY_103_board.md': undefined,
    'docs/stories/STY_150_x.md': story('STY_150', ['FT_101'], { status: 'retired' }) }));
  assert.deepStrictEqual(nextKeys(index, 'story', 2), ['STY_151', 'STY_152'], 'a retired number is never reused');
  assert.deepStrictEqual(nextKeys(index, 'feat'), ['FT_103'], 'feats and stories are independent sequences');
  const dir = temp(fs.mkdtempSync(path.join(os.tmpdir(), 'next-')));
  fs.writeFileSync(path.join(dir, 'index.json'), serializeIndex(index));
  const r = cli(['next', path.join(dir, 'index.json'), 'story', '3']);
  assert.deepStrictEqual([r.status, r.stdout], [0, 'STY_151\nSTY_152\nSTY_153\n']);
  for (const args of [['next', path.join(dir, 'index.json')], ['next', path.join(dir, 'index.json'), 'task'], ['next', path.join(dir, 'index.json'), 'feat', '-1'],
    ['next', path.join(dir, 'missing.json'), 'feat']]) assert.strictEqual(cli(args).status, 2, args.join(' '));
});

// --- verify-homes ------------------------------------------------------------

const INDEX = buildIndex(repo({ 'docs/feats/FT_103_old.md': feat('FT_103', { status: 'retired' }) }));
const proposal = (homes, units = []) => ({
  baseline: { commit: INDEX.commit, planning_index: { digest: INDEX.digest } }, homes, units,
});
const findings = (p, index = INDEX) => verifyHomes(p, index).map((x) => [x.code, x.where]);

check('a consistent proposal and index give no findings', () => {
  const p = proposal([{ key: 'FT_101', level: 'feat' }, { key: 'STY_101', level: 'story' }], [
    { id: 'U-1', home: { relation: 'extend', key: 'STY_101', level: 'story' } },
    { id: 'U-2', home: { relation: 'new', key: 'FT_101', level: 'feat' } },
  ]);
  assert.deepStrictEqual(findings(p), []);
});

check('INDEX_MISMATCH: another commit, another digest or a non-index document', () => {
  const p = proposal([]);
  assert.deepStrictEqual(findings({ ...p, baseline: { ...p.baseline, commit: '0'.repeat(40) } }), [['INDEX_MISMATCH', 'baseline.commit']]);
  assert.deepStrictEqual(findings({ ...p, baseline: { ...p.baseline, planning_index: { digest: 'sha256:0' } } }),
    [['INDEX_MISMATCH', 'baseline.planning_index.digest']]);
  assert.deepStrictEqual(findings(p, { schema: 'Other', rows: [] }), [['INDEX_MISMATCH', 'index']]);
});

check('HOME_KEY_UNKNOWN: an absent key, a wrong level, or a superseded or retired doc', () => {
  const p = proposal([{ key: 'STY_107', level: 'story' }, { key: 'FT_101', level: 'story' }, { key: 'STY_102', level: 'story' }, { key: 'FT_103', level: 'feat' }]);
  assert.deepStrictEqual(findings(p), [['HOME_KEY_UNKNOWN', 'homes[0]'], ['HOME_KEY_UNKNOWN', 'homes[1]'], ['HOME_KEY_UNKNOWN', 'homes[2]'], ['HOME_KEY_UNKNOWN', 'homes[3]']]);
  assert.match(verifyHomes(p, INDEX)[2].message, /STY_102 is superseded by STY_103/);
});

check('HOME_DEPENDENTS: amend and supersede declare a list, and every dependent is an indexed story', () => {
  const unit = (relation, dependents) => proposal([], [{ id: 'U-1', home: { relation, key: 'STY_101', level: 'story', dependents } }]);
  assert.deepStrictEqual(findings(unit('supersede', ['STY_103'])), []);
  assert.deepStrictEqual(findings(unit('amend', [])), [], 'a declared empty set passes');
  assert.deepStrictEqual(findings(unit('amend', undefined)), [['HOME_DEPENDENTS', 'units.U-1.home.dependents']]);
  assert.match(verifyHomes(unit('supersede', undefined), INDEX)[0].message, /declares no list/);
  assert.deepStrictEqual(findings(unit('amend', ['STY_103', 'STY_999', 'FT_101'])), [['HOME_DEPENDENTS', 'units.U-1.home.dependents']]);
  assert.match(verifyHomes(unit('amend', ['STY_999', 'FT_101']), INDEX)[0].message, /STY_999, FT_101 are not stories/);
  assert.deepStrictEqual(findings(unit('extend', undefined)), [], 'extend leaves dependents unchecked');
});

check('verify-homes CLI: exit statuses, --json shape and input errors', () => {
  const dir = temp(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-homes-')));
  const write = (name, value) => { fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value)); return path.join(dir, name); };
  const index = write('index.json', serializeIndex(INDEX));
  const ok = cli(['verify-homes', write('ok.json', proposal([{ key: 'STY_101', level: 'story' }])), index, '--json']);
  assert.strictEqual(ok.status, 0);
  assert.deepStrictEqual(JSON.parse(ok.stdout), { schema: 'PlanningIndexV1', ok: true, findings: [] });
  const bad = cli(['verify-homes', write('bad.json', proposal([{ key: 'STY_107', level: 'story' }])), index, '--json']);
  assert.strictEqual(bad.status, 1);
  assert.strictEqual(JSON.parse(bad.stdout).findings[0].code, 'HOME_KEY_UNKNOWN');
  const unreadable = cli(['verify-homes', write('broken.json', '{'), index, '--json']);
  assert.strictEqual(unreadable.status, 2);
  assert.strictEqual(JSON.parse(unreadable.stdout).error.code, 'INPUT_ERROR');
  for (const args of [['verify-homes', index], ['verify-homes', index, index, index], ['verify-homes', index, index, '--yaml'],
    ['verify-homes', index, index, '--json', '--json'], []]) {
    assert.strictEqual(cli(args).status, 2, args.join(' '));
  }
});

console.log(`\n${pass} checks passed.`);
