// Tests for the dev-analyse-rp result-packet helper: classification, the durable packet and the baseline delta.
// Plain Node; run with `node skills/dev-analyse-rp/result-packet.test.mjs` or `npm test` from the plugin root.
// Every repository read runs against a temporary git repository, never the live docs/.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildIndex } from './planning-index.mjs';
import { classify, delta, MANIFEST, packetManifest, resolveRoot, sha256 } from './result-packet.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'result-packet.mjs');

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { console.error(`FAIL - ${name}\n  ${e.message}`); process.exitCode = 1; }
};
// Every temp path is removed on exit, pass or fail, so runs do not exhaust a shared tmpfs.
const temps = [];
const temp = (p) => { temps.push(p); return p; };
process.on('exit', () => { for (const p of temps) fs.rmSync(p, { recursive: true, force: true }); });
const cli = (args, cwd, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env: { ...process.env, DEV_ANALYSE_RP_ROOT: '', ...env } });
const git = (root, ...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
// The analyst's sandbox mounts the git directory read-only, so a step that writes into it fails there.
const readOnly = (dir, fn) => {
  try { execFileSync('chmod', ['-R', 'a-w', dir]); return fn(); } finally { execFileSync('chmod', ['-R', 'u+w', dir]); }
};

function repo(files) {
  const root = temp(fs.mkdtempSync(path.join(os.tmpdir(), 'result-packet-')));
  git(root, 'init', '-q');
  commit(root, { '.gitignore': 'temp/\n', ...files });
  return root;
}
function commit(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'step');
  return git(root, 'rev-parse', 'HEAD').trim();
}

const RUN = '20261018T030000Z-afff0571';
const SHA = 'a'.repeat(40);
const featDoc = (id, issue, extra = '') => `---\nid: ${id}\ntitle: Feat ${id}\nlabel: core:${id.toLowerCase().replace('_', '-')}\ntracking_issue: ${issue}\nstatus: current\nsuperseded_by: null\n${extra}---\n`;
const storyDoc = (id, feat) => `---\nid: ${id}\ntitle: Story ${id}\nfeats: [${feat}]\nstatus: current\nsuperseded_by: null\n---\n`;
const DOCS = {
  'docs/feats/FT_101_task_board.md': featDoc('FT_101', 12),
  'docs/feats/FT_102_progress.md': featDoc('FT_102', 'null'),
  'docs/stories/STY_101_add_task.md': storyDoc('STY_101', 'FT_101'),
};
const of = (issue, docs = DOCS) => classify({ issue, commit: SHA, docs: Object.entries(docs).map(([p, text]) => ({ path: p, text })) });

// --- classification ---------------------------------------------------------------

check('a feat whose tracking_issue is the target classifies as that feat, whatever the labels', () => {
  assert.deepStrictEqual(of(12), { action: 'proceed', target: 'feat', feat: 'FT_101', path: 'docs/feats/FT_101_task_board.md', status: 'current' });
});

check('no feat naming the issue, or no planning docs at all, is other', () => {
  for (const [issue, docs] of [[13, DOCS], [12, {}]]) {
    assert.deepStrictEqual(of(issue, docs), { action: 'proceed', target: 'other', feat: null, path: null, status: null }, `#${issue}`);
  }
});

check('a malformed planning doc, or two feats claiming one tracking issue, stops and names the path', () => {
  for (const [extra, pattern] of [
    [{ 'docs/feats/FT_103_x.md': 'no frontmatter' }, /docs\/feats\/FT_103_x\.md: does not start with/],
    [{ 'docs/feats/FT_103_x.md': featDoc('FT_103', 12) }, /docs\/feats\/FT_103_x\.md: tracking issue 12 is also docs\/feats\/FT_101_task_board\.md's/],
    [{ 'docs/stories/STY_102_x.md': storyDoc('STY_102', 'FT_109') }, /STY_102_x\.md: feats names FT_109/],
  ]) {
    const r = of(13, { ...DOCS, ...extra });
    assert.deepStrictEqual([r.action, r.reason], ['stop', 'malformed-planning-docs']);
    assert.match(r.detail, pattern);
  }
});

check('the CLI reads the docs committed at the baseline, not the working tree or a later commit', () => {
  const root = repo(DOCS);
  const base = git(root, 'rev-parse', 'HEAD').trim();
  commit(root, { 'docs/feats/FT_102_progress.md': featDoc('FT_102', 7) });
  fs.writeFileSync(path.join(root, 'docs/feats/FT_103_x.md'), 'broken');
  assert.deepStrictEqual(JSON.parse(cli(['classify', '--issue', '7', '--baseline', base], root).stdout).target, 'other');
  const r = cli(['classify', '--issue', '7', '--baseline', git(root, 'rev-parse', 'HEAD').trim()], root);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), { action: 'proceed', target: 'feat', feat: 'FT_102', path: 'docs/feats/FT_102_progress.md', status: 'current' });
  const missing = cli(['classify', '--issue', '7', '--baseline', 'f'.repeat(40)], root);
  assert.strictEqual(missing.status, 1);
  assert.match(JSON.parse(missing.stdout).detail, /^planning docs failed/);
});

// --- the durable packet --------------------------------------------------------

check('the default root is ignored under the toplevel and cited relatively', () => {
  const root = repo({ 'README.md': 'x' });
  const r = cli(['root', '--run', RUN], root);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.cite, `temp/dev-analyse-rp/${RUN}/`);
  assert.strictEqual(fs.realpathSync(out.root), fs.realpathSync(path.join(root, 'temp/dev-analyse-rp', RUN)));
  assert.strictEqual(git(root, 'status', '--porcelain'), '');
});

check('the variable root is cited literally, never as an absolute path', () => {
  const home = temp(fs.mkdtempSync(path.join(os.tmpdir(), 'result-root-')));
  assert.deepStrictEqual(resolveRoot({ run: RUN, env: home, top: '/repo', cwd: '/elsewhere' }), { root: path.join(home, RUN), cite: `$DEV_ANALYSE_RP_ROOT/${RUN}/` });
  const r = cli(['root', '--run', RUN], repo({ 'README.md': 'x' }), { DEV_ANALYSE_RP_ROOT: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).cite, `$DEV_ANALYSE_RP_ROOT/${RUN}/`);
  assert.ok(fs.statSync(path.join(home, RUN)).isDirectory());
});

check('a root that cannot be created stops, naming it, with no fallback', () => {
  const blocker = path.join(temp(fs.mkdtempSync(path.join(os.tmpdir(), 'result-root-'))), 'file');
  fs.writeFileSync(blocker, 'not a directory');
  const r = cli(['root', '--run', RUN], repo({ 'README.md': 'x' }), { DEV_ANALYSE_RP_ROOT: blocker });
  assert.strictEqual(r.status, 1);
  assert.match(JSON.parse(r.stdout).detail, new RegExp(`^create \\$DEV_ANALYSE_RP_ROOT/${RUN}/ failed`));
});

check('a root inside the checkout that git does not ignore stops', () => {
  const root = repo({ 'README.md': 'x' });
  const r = cli(['root', '--run', RUN], root, { DEV_ANALYSE_RP_ROOT: path.join(root, 'packets') });
  assert.strictEqual(r.status, 1);
  assert.match(JSON.parse(r.stdout).detail, /^check-ignore/);
});

check('the manifest lists every file with size and sha256, and its digest tracks every byte', () => {
  const root = temp(fs.mkdtempSync(path.join(os.tmpdir(), 'result-packet-')));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'proposal.json'), '{}');
  fs.writeFileSync(path.join(root, 'src/note.md'), 'note\n');
  const of = () => packetManifest({ root, run: RUN, baseline: SHA, verdict: 'proposal_blocked' });
  const first = cli(['manifest', '--root', root, '--run', RUN, '--baseline', SHA, '--verdict', 'proposal_blocked'], root);
  assert.strictEqual(first.status, 0, first.stderr);
  const text = fs.readFileSync(path.join(root, MANIFEST), 'utf8');
  assert.deepStrictEqual(JSON.parse(text), { schema: 'AnalyseRpPacketManifestV1', run: RUN, baseline: SHA, verdict: 'proposal_blocked',
    files: [{ path: 'proposal.json', bytes: 2, sha256: sha256('{}') }, { path: 'src/note.md', bytes: 5, sha256: sha256('note\n') }] });
  assert.deepStrictEqual(JSON.parse(first.stdout), { action: 'proceed', digest: `sha256:${sha256(text)}`, files: 2 });
  assert.strictEqual(of().digest, JSON.parse(first.stdout).digest, 'unchanged files, same digest');
  fs.writeFileSync(path.join(root, 'src/note.md'), 'nope\n');
  const changed = of();
  assert.notStrictEqual(changed.digest, JSON.parse(first.stdout).digest);
  assert.notStrictEqual(JSON.parse(changed.text).files[1].sha256, sha256('note\n'));
});

check('the manifest lists every file the verdict found, whatever its name, and is written once', () => {
  const root = temp(fs.mkdtempSync(path.join(os.tmpdir(), 'result-packet-')));
  const names = ['context.json', 'drift.json', 'post-commands.txt', 'post.1.json', 'proposal.json', 'prose.json',
    'readback.1.md', 'result.1.md', 'result.full.md', 'scan.json', 'select.json'];
  for (const name of names) fs.writeFileSync(path.join(root, name), `${name}\n`);
  const run = () => cli(['manifest', '--root', root, '--run', RUN, '--baseline', SHA, '--verdict', 'proposal_blocked'], root);
  const first = run();
  assert.strictEqual(first.status, 0, first.stderr);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8')).files.map((f) => f.path), names);
  // The digest the result cites is the verdict's, so a packet fixed afterwards needs a new run.
  const again = run();
  assert.strictEqual(again.status, 1);
  assert.strictEqual(JSON.parse(again.stdout).reason, 'manifest-exists');
});

check('a symbolic link in the root stops, and bad flags exit 2', () => {
  const root = temp(fs.mkdtempSync(path.join(os.tmpdir(), 'result-packet-')));
  fs.symlinkSync('/etc/hostname', path.join(root, 'link'));
  const r = cli(['manifest', '--root', root, '--run', RUN, '--baseline', SHA, '--verdict', 'proposal_blocked'], root);
  assert.strictEqual(r.status, 1);
  assert.match(JSON.parse(r.stdout).detail, /link is neither a file nor a directory/);
  for (const args of [['manifest', '--root', root, '--run', RUN, '--baseline', SHA, '--verdict', 'done'], ['root'], ['root', '--run', 'x'],
    ['classify', '--issue', '0', '--baseline', SHA], ['classify', '--repo', 'a/b', '--issue', '1', '--baseline', SHA],
    ['drift', '--root', path.join(root, 'missing')], ['drift', '--root', root]]) {
    assert.strictEqual(cli(args, root).status, 2, args.join(' '));
  }
});

// --- the baseline delta ----------------------------------------------------------

const BASE_SHA = 'b'.repeat(40);
const DIGEST = 'sha256:1111';
const proposal = {
  baseline: { commit: BASE_SHA, planning_index: { digest: DIGEST } },
  units: [{ id: 'U-1', write_boundary: ['docs/notes/a.md', 'src/*.ts'] }, { id: 'U-2', write_boundary: ['tests/**', 'package.json'] }],
  edges: [{ from: 'U-2', to: 'U-1', conflict_path: 'package.json' }, { from: 'U-1', to: 'STY_109', conflict_path: null }],
  sources: [{ id: 'SRC-1', origin: 'docs/spec.md' }, { id: 'SRC-2', origin: 'https://github.com/acme/tools/issues/1' }],
};
const drift = (changed, headDigest = DIGEST) => delta({ proposal, head: 'c'.repeat(40), changed, baselineFiles: ['docs/spec.md'], headDigest });

check('a moved HEAD with no cited path changed reports the count and no overlap', () => {
  assert.deepStrictEqual(drift(['README.md', 'src/deep/x.ts']), { action: 'proceed', baseline: BASE_SHA, head: 'c'.repeat(40), changed: 2, overlap: [],
    digest: { baseline: DIGEST, head: DIGEST }, digestChanged: false });
});

check('overlap lists each cited path: exact, *, **, conflict path and source origin; a near name is no match', () => {
  const r = drift(['docs/notes/a.md', 'docs/notes/a.md.bak', 'src/x.ts', 'tests/a/b/c.test.ts', 'package.json', 'docs/spec.md']);
  assert.deepStrictEqual(r.overlap, [
    { path: 'docs/notes/a.md', citedBy: ['U-1'] }, { path: 'src/x.ts', citedBy: ['U-1'] }, { path: 'tests/a/b/c.test.ts', citedBy: ['U-2'] },
    { path: 'package.json', citedBy: ['U-2', 'U-1'] }, { path: 'docs/spec.md', citedBy: ['SRC-1'] },
  ]);
  assert.strictEqual(r.changed, 6);
});

check('a source origin that carries a #section anchor still matches its file at the baseline', () => {
  const anchored = { ...proposal, sources: [{ id: 'SRC-3', origin: 'docs/spec.md#6' }, { id: 'SRC-4', origin: 'https://github.com/acme/tools/issues/1#issuecomment-1' }] };
  const r = delta({ proposal: anchored, head: 'c'.repeat(40), changed: ['docs/spec.md'], baselineFiles: ['docs/spec.md'], headDigest: DIGEST });
  assert.deepStrictEqual(r.overlap, [{ path: 'docs/spec.md', citedBy: ['SRC-3'] }]);
});

check('a planning-index digest rebuilt at HEAD that differs is flagged', () => {
  const r = drift([], 'sha256:2222');
  assert.strictEqual(r.digestChanged, true);
  assert.deepStrictEqual(r.digest, { baseline: DIGEST, head: 'sha256:2222' });
});

const FEAT = 'docs/feats/FT_101_task_board.md';
function driftRepo() {
  const root = repo({ [FEAT]: featDoc('FT_101', 12), 'src/a.ts': 'a', 'README.md': 'r' });
  const base = git(root, 'rev-parse', 'HEAD').trim();
  const packet = temp(fs.mkdtempSync(path.join(os.tmpdir(), 'result-packet-')));
  fs.writeFileSync(path.join(packet, 'proposal.json'), JSON.stringify({ ...proposal, baseline: { commit: base, planning_index: { digest: buildIndex(root).digest } },
    units: [{ id: 'U-1', write_boundary: ['src/*.ts'] }], edges: [], sources: [] }));
  return { root, base, packet };
}

check('the CLI compares commits only: an unmoved HEAD is no drift, even over a dirty tree', () => {
  const { root, base, packet } = driftRepo();
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'uncommitted');
  const r = cli(['drift', '--root', packet], root);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), { action: 'proceed', baseline: base, head: base, changed: 0, overlap: [],
    digest: { baseline: buildIndex(root).digest, head: buildIndex(root).digest }, digestChanged: false });
});

check('the CLI reports a committed overlap and a planning digest rebuilt at HEAD', () => {
  const { root, packet } = driftRepo();
  const head = commit(root, { 'src/a.ts': 'changed', 'README.md': 'changed', 'docs/feats/FT_102_progress.md': featDoc('FT_102', 'null') });
  const r = cli(['drift', '--root', packet], root);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.head, head);
  assert.strictEqual(out.changed, 3);
  assert.deepStrictEqual(out.overlap, [{ path: 'src/a.ts', citedBy: ['U-1'] }]);
  assert.strictEqual(out.digestChanged, true);
});

check('a moved HEAD with an uncommitted planning doc measures drift from the commits alone, reading the repository only', () => {
  const { root, base, packet } = driftRepo();
  const head = commit(root, { 'README.md': 'moved' });
  fs.writeFileSync(path.join(root, FEAT), featDoc('FT_101', 99));
  const out = readOnly(path.join(root, '.git'), () => {
    const r = cli(['drift', '--root', packet], root);
    assert.strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  });
  assert.deepStrictEqual([out.baseline, out.head, out.changed, out.overlap, out.digestChanged], [base, head, 1, [], false]);
  assert.strictEqual(git(root, 'status', '--porcelain').trim(), `M ${FEAT}`);
});

check('a failing diff or index rebuild stops and names the step', () => {
  const { root, packet } = driftRepo();
  // Only a committed break fails the rebuild, because it reads HEAD's committed files.
  commit(root, { [FEAT]: 'no frontmatter' });
  const index = cli(['drift', '--root', packet], root);
  assert.strictEqual(index.status, 1);
  assert.match(JSON.parse(index.stdout).detail, /^index rebuild failed: docs\/feats\/FT_101_task_board\.md: does not start with/);
  commit(root, { [FEAT]: featDoc('FT_101', 12) });
  const p = JSON.parse(fs.readFileSync(path.join(packet, 'proposal.json'), 'utf8'));
  fs.writeFileSync(path.join(packet, 'proposal.json'), JSON.stringify({ ...p, baseline: { ...p.baseline, commit: 'e'.repeat(40) } }));
  const diff = cli(['drift', '--root', packet], root);
  assert.strictEqual(diff.status, 1);
  assert.match(JSON.parse(diff.stdout).detail, /^diff failed/);
});

console.log(`\n${pass} checks passed.`);
