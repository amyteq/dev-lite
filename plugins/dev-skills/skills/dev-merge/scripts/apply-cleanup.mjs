// Collect, plan and apply /dev-merge cleanup (AC-5). Project settings may allow-list only this script
// for deletions, so it re-validates: `apply` collects and plans again and runs only the
// removals present in both the saved plan and the fresh plan. Every command is one child process
// without a shell, and its exit code is recorded. Exit 0 done, 1 stopped, 2 did not run.
//
//   node "${CLAUDE_SKILL_DIR}/scripts/apply-cleanup.mjs" plan  --pr N --mode stale|own|none --out DIR
//   node "${CLAUDE_SKILL_DIR}/scripts/apply-cleanup.mjs" apply --plan DIR/plan.json
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planCleanup } from './check-merge.mjs';

// Rebuildable caches from .gitignore; any other ignored file (temp/, outputs/, private/, .env …) keeps its worktree.
const CACHE = /(^|\/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|node_modules|\.venv|venv)(\/|$)|\.py[cod]$|(^|\/)\.DS_Store$/;

const run = (cmd, args, options = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...options });
function read(cmd, args) {
  const result = run(cmd, args);
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
  return result.stdout;
}
const quote = (value) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`);
export const commandText = (argv) => argv.map(quote).join(' ');

export function parseWorktrees(porcelain) {
  return porcelain.split('\n\n').filter((block) => block.trim()).map((block) => {
    const fields = Object.fromEntries(block.split('\n').map((line) => [line.split(' ')[0], line.slice(line.indexOf(' ') + 1)]));
    return { path: fields.worktree, head: fields.HEAD, branch: fields.branch?.replace(/^refs\/heads\//, '') ?? null, locked: 'locked' in fields };
  });
}

// The sandbox mounts placeholders as character devices; they are not the owner's files.
const placeholder = (path, entry) => lstatSync(join(path, entry.slice(3))).isCharacterDevice();

/** Tracked changes, or untracked files other than the sandbox's character-device placeholders. */
export function dirtyOf(path, git = run) {
  const result = git('git', ['-C', path, 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (result.status !== 0) return null;
  for (const entry of result.stdout.split('\0').filter(Boolean)) {
    if (!entry.startsWith('?? ')) { if (/^[ MADRCUT!]{2} /.test(entry)) return true; continue; }
    try { if (!placeholder(path, entry)) return true; } catch { return null; }
  }
  return false;
}

/** Ignored files other than caches and placeholders: removing the worktree would delete them with it. */
export function ignoredOf(path, git = run) {
  const result = git('git', ['-C', path, 'status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all']);
  if (result.status !== 0) return null;
  for (const entry of result.stdout.split('\0').filter((line) => line.startsWith('!! '))) {
    if (CACHE.test(entry.slice(3))) continue;
    try { if (!placeholder(path, entry)) return true; } catch { return null; }
  }
  return false;
}

const isAncestor = (sha, main) => Boolean(sha) && run('git', ['merge-base', '--is-ancestor', sha, main]).status === 0;
// Inside the sandbox's PID namespace other sessions' processes are invisible, so busy is unknowable.
const processCheck = () => (/(^|\/)(systemd|init)$/.test(readFileSync('/proc/1/cmdline', 'utf8').split('\0')[0]) ? 'ok' : 'unavailable');

/** The immediate entries of a directory, or null when it cannot be read. */
const entriesOf = (path) => { try { return readdirSync(path).map((name) => join(path, name)); } catch { return null; } };

function busyPaths() {
  const cwds = [];
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    try { cwds.push(realpathSync(`/proc/${pid}/cwd`)); } catch { /* exited or not ours */ }
  }
  return cwds;
}

export function collect({ pr, mode }) {
  const repo = read('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
  const info = JSON.parse(read('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', 'number,state,headRefName,headRefOid,isCrossRepository']));
  const defaultBranch = read('gh', ['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']).trim();
  const main = read('gh', ['api', `repos/${repo}/commits/${defaultBranch}`, '--jq', '.sha']).trim();
  const prs = JSON.parse(read('gh', ['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '400', '--json', 'number,state,headRefName,headRefOid']));
  const prsByName = {};
  const prsByHead = {};
  for (const item of prs) {
    prsByName[item.headRefName] ??= { number: item.number, state: item.state };
    prsByHead[item.headRefOid] ??= { number: item.number, state: item.state };
  }
  const commonDir = realpathSync(resolve(read('git', ['rev-parse', '--git-common-dir']).trim()));
  const worktrees = parseWorktrees(read('git', ['worktree', 'list', '--porcelain']));
  const mainCheckout = worktrees[0].path;
  const top = run('git', ['rev-parse', '--show-toplevel']).stdout.trim();
  const sessionWorktree = top && top !== mainCheckout ? top : null;
  const check = processCheck();
  const cwds = check === 'ok' ? busyPaths() : [];
  const scratchRoot = (process.env.TMPDIR ?? '/tmp').replace(/\/$/, '');
  // The name alone never decides: the plan also needs to see whether the entry is a directory and what it holds.
  const scratch = readdirSync(scratchRoot, { withFileTypes: true }).filter((entry) => new RegExp(`^pr${pr}(?![0-9])`).test(entry.name))
    .map((entry) => ({ path: join(scratchRoot, entry.name), directory: entry.isDirectory() }));
  const branches = read('git', ['for-each-ref', 'refs/heads', '--format=%(refname:short) %(objectname)']).split('\n').filter(Boolean)
    .map((line) => { const [name, head] = line.split(' '); return { name, head, ancestorOfMain: isAncestor(head, main), containedInPr: isAncestor(head, info.headRefOid) }; });
  const remote = run('gh', ['api', `repos/${repo}/branches/${encodeURIComponent(info.headRefName)}`, '--jq', '.commit.sha']);
  return {
    repo, commonDir, mode, main, mainMissing: run('git', ['cat-file', '-e', `${main}^{commit}`]).status !== 0, defaultBranch, mainCheckout, sessionWorktree, scratchRoot, processCheck: check,
    pr: { number: info.number, state: info.state, headRefName: info.headRefName, headRefOid: info.headRefOid, sameRepo: !info.isCrossRepository },
    prsByName, prsByHead, branches, remoteHead: remote.status === 0 ? remote.stdout.trim() || null : null,
    worktrees: worktrees.map((wt) => ({
      ...wt,
      dirty: existsSync(wt.path) ? dirtyOf(wt.path) : null,
      hasIgnored: existsSync(wt.path) ? ignoredOf(wt.path) : null,
      busy: cwds.some((cwd) => cwd === wt.path || cwd.startsWith(`${wt.path}/`)),
      ancestorOfMain: isAncestor(wt.head, main),
      containedInPr: isAncestor(wt.head, info.headRefOid), // needs pull/<n>/head fetched; false when absent
    })),
    scratch: scratch.map((dir) => ({ ...dir, entries: dir.directory ? entriesOf(dir.path) : null })),
  };
}

/** The exact command each removal runs; scratch runs in-process. */
export function commandFor(item, inv) {
  switch (item.kind) {
    case 'worktree': return ['git', 'worktree', 'remove', item.target];
    case 'local-branch': return ['git', 'branch', '-D', item.target];
    // The lease makes the push refuse when the branch moved past the inventoried head.
    case 'remote-branch': return ['git', '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', `--force-with-lease=refs/heads/${item.target}:${item.head}`, `https://github.com/${inv.repo}.git`, '--delete', item.target];
    // rmdir refuses a directory that is not empty, so nothing inside it is ever deleted along with it.
    case 'scratch': return ['rmdir', item.target];
    default: return null;
  }
}

export function ownerCommand(item, inv) {
  const argv = commandFor(item, inv);
  return argv ? commandText(argv) : null;
}

export function execute(item, inv, sh = run) {
  const argv = commandFor(item, inv);
  const record = { kind: item.kind, target: item.target, command: ownerCommand(item, inv) };
  try {
    if (item.kind === 'scratch') {
      // Never recursive: a file created after the inventory keeps the directory instead of being deleted with it.
      try { rmdirSync(item.target); } catch (error) {
        if (error.code === 'ENOENT') return { ...record, exit: 0 }; // already gone, with the worktree that was this directory
        if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error;
        return { ...record, exit: null, reason: 'holds-other-files' };
      }
      return { ...record, exit: 0 };
    }
    const result = sh(argv[0], argv.slice(1));
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(-400);
    return { ...record, exit: result.status ?? 'signal', detail: output };
  } catch (error) {
    return { ...record, exit: 'error', detail: error.message };
  }
}

/** The results to record when the whole `apply` is refused: the owner reruns it, so the re-validation stays in the helper. */
export function deniedResults(plan, planPath) {
  const rerun = commandText(['node', fileURLToPath(import.meta.url), 'apply', '--plan', planPath]);
  return [...plan.remove.map((item) => ({ kind: item.kind, target: item.target, exit: 'denied' })), { kind: 'all', target: planPath, exit: 'denied', command: rerun }];
}

const key = (item) => `${item.kind}\0${item.target}`;

export function apply(saved, fresh, inv, exec = execute) {
  // A plan copied to another checkout must not delete that repository's same-named branches or worktrees.
  if (!saved.repo || !saved.commonDir || saved.repo.toLowerCase() !== String(inv.repo).toLowerCase() || saved.commonDir !== inv.commonDir) {
    throw new Error(`the plan was made for ${saved.repo ?? 'an unknown repository'} at ${saved.commonDir ?? 'unknown Git storage'}, not this checkout`);
  }
  // Walk the fresh plan in its order and run only items the saved plan also lists, so a saved plan can only
  // narrow what runs, never change a target or the lease.
  const planned = new Set(saved.remove.map(key));
  const now = new Set(fresh.remove.map(key));
  const results = [];
  const removed = (path) => results.some((done) => done.kind === 'worktree' && done.target === path && done.exit === 0);
  for (const item of fresh.remove) {
    if (!planned.has(key(item))) {
      results.push({ kind: item.kind, target: item.target, exit: null, reason: 'not-in-saved-plan' });
      continue;
    }
    if (item.kind === 'exit-worktree') { results.push({ kind: item.kind, target: item.target, exit: null, reason: 'exit-worktree' }); continue; }
    // A scratch directory goes only when every worktree inside it, the session one included, was removed in this run.
    const keptInside = inv.worktrees.some((wt) => (wt.path === item.target || wt.path.startsWith(`${item.target.replace(/\/$/, '')}/`)) && !removed(wt.path));
    if (item.kind === 'scratch' && keptInside) { results.push({ kind: item.kind, target: item.target, exit: null, reason: 'holds-kept-worktree' }); continue; }
    results.push(exec(item, inv));
  }
  for (const item of saved.remove) if (!now.has(key(item))) results.push({ kind: item.kind, target: item.target, exit: null, reason: 'replanned-away' });
  return [...results, ...saved.skip.map((item) => ({ ...item, exit: null }))];
}

/**
 * The second pass after ExitWorktree keeps the first pass's outcomes: a re-planned item reports its latest
 * execution outcome (a skip never hides an earlier execution), and the session worktree counts as removed once the
 * fresh inventory no longer lists it.
 */
export function mergeResults(prior, latest, inv) {
  const ran = new Set(prior.filter((item) => item.exit !== null).map(key));
  latest = latest.filter((item) => item.exit !== null || !ran.has(key(item)));
  const seen = new Set(latest.map(key));
  const exited = (item) => item.kind === 'exit-worktree' && item.exit === null && item.reason === 'exit-worktree' &&
    !inv.worktrees.some((wt) => wt.path === item.target);
  return [...prior.filter((item) => !seen.has(key(item))).map((item) => (exited(item) ? { kind: item.kind, target: item.target, exit: 0 } : item)), ...latest];
}

const invoked = () => {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
};
if (invoked()) {
  const [command, ...rest] = process.argv.slice(2);
  const flags = Object.fromEntries(rest.flatMap((value, index) => (value.startsWith('--') ? [[value.slice(2), rest[index + 1]]] : [])));
  try {
    if (command === 'plan' && /^[1-9]\d*$/.test(flags.pr ?? '') && ['stale', 'own', 'none'].includes(flags.mode) && flags.out) {
      const dryRun = rest.includes('--dry-run');
      const inv = collect({ pr: Number(flags.pr), mode: flags.mode });
      if (inv.pr.state !== 'MERGED' && !dryRun) { console.error(`PR #${flags.pr} is ${inv.pr.state}; cleanup runs only after the merge`); process.exitCode = 1; }
      else {
        const plan = planCleanup(inv);
        mkdirSync(flags.out, { recursive: true });
        writeFileSync(join(flags.out, 'inventory.json'), `${JSON.stringify(inv, null, 2)}\n`);
        writeFileSync(join(flags.out, 'plan.json'), `${JSON.stringify({ pr: inv.pr.number, mode: inv.mode, dryRun, ...plan, denied: deniedResults(plan, resolve(flags.out, 'plan.json')) }, null, 2)}\n`);
        console.log(JSON.stringify({ ok: true, dryRun, remove: plan.remove.length, skip: plan.skip.length, processCheck: inv.processCheck, plan: join(flags.out, 'plan.json') }));
      }
    } else if (command === 'apply' && flags.plan) {
      const saved = JSON.parse(readFileSync(flags.plan, 'utf8'));
      if (saved.dryRun) throw new Error('a dry-run plan is never applied');
      if (!Number.isInteger(saved.pr) || saved.pr < 1 || !['stale', 'own', 'none'].includes(saved.mode) || !Array.isArray(saved.remove) || !Array.isArray(saved.skip)) {
        throw new Error('the plan file is not one that plan wrote');
      }
      const prior = flags.previous ? JSON.parse(readFileSync(flags.previous, 'utf8')) : null; // read before anything is removed
      if (prior && !Array.isArray(prior)) throw new Error('--previous is not a results file');
      const inv = collect({ pr: saved.pr, mode: saved.mode });
      if (inv.pr.state !== 'MERGED') throw new Error(`PR #${saved.pr} is ${inv.pr.state}`);
      const latest = apply(saved, planCleanup(inv), inv);
      const results = prior ? mergeResults(prior, latest, inv) : latest;
      const out = flags.plan.replace(/plan\.json$/, 'results.json');
      writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
      const failed = results.filter((item) => item.exit !== 0 && item.exit !== null).length;
      console.log(JSON.stringify({ ok: !failed, results: out, done: results.filter((item) => item.exit === 0).length, failed }));
      process.exitCode = failed ? 1 : 0;
    } else {
      console.error('Usage: apply-cleanup.mjs plan --pr N --mode stale|own|none --out DIR | apply --plan DIR/plan.json [--previous FILE]');
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(`apply-cleanup ${command}: ${error.message}`);
    process.exitCode = 2;
  }
}
