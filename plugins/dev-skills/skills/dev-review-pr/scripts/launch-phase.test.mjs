import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

const HELPER = fileURLToPath(new URL('./launch-phase.mjs', import.meta.url));
const GIT = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
// A git that hangs on one subcommand and hands every other call to the real binary, so a single
// probe can expire while the rest of the launch sees what it normally would.
const gitStub = (hang) => `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('${hang}')) setTimeout(() => {}, 30000);
else process.exit(require('node:child_process').spawnSync('${GIT}', args, { stdio: 'inherit' }).status ?? 1);
`;
const KEY = 'SENTINEL-API-KEY-7f3a';
// The tests may themselves run inside a Claude Code or Codex session; its variables must not reach the fixtures.
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:CLAUDE|CODEX_COMPANION_)/.test(name)));

// One stub serves as both CLIs. It logs its argv and credential environment, then behaves as
// the STUB_* variables ask: the tests' only stand-in for the real providers.
const STUB = `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const { spawn, execFileSync } = require('node:child_process');
const cli = require('node:path').basename(process.argv[1]);
const argv = process.argv.slice(2);
const env = process.env;
appendFileSync(env.STUB_LOG, JSON.stringify({ cli, argv, key: env.AZURE_OPENAI_API_KEY ?? null, openai: env.OPENAI_API_KEY ?? null,
  session: Object.fromEntries(Object.keys(env).filter((n) => /^(CLAUDE|CODEX_COMPANION_)/.test(n)).sort().map((n) => [n, env[n] === 'sentinel:' + n])) }) + '\\n');
const after = (flag) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined;
const config = (name) => (argv.find((a) => a.startsWith(name + '=')) ?? '').split('=').slice(1).join('=').replace(/"/g, '');
if (env.STUB_HANG && argv.includes(env.STUB_HANG)) { setTimeout(() => {}, 30000); return; }
if (argv[0] === '--version') { if (env.STUB_VERSION_FAIL) process.exit(1); console.log(cli + ' 9.9.9'); process.exit(0); }
if (argv[0] === 'login') { console.log(env.STUB_LOGIN ?? 'Logged in using ChatGPT'); process.exit(0); }
readFileSync(0);
if (env.STUB_LEAK) { console.log(env.AZURE_OPENAI_API_KEY); console.error('leak ' + env.AZURE_OPENAI_API_KEY); }
if (env.STUB_DIRTY) writeFileSync((after('-C') ?? '.') + '/change.txt', 'writer change');
if (env.STUB_COMMIT) {
  writeFileSync('commit.txt', 'writer commit');
  execFileSync('git', ['add', 'commit.txt']);
  execFileSync('git', ['-c', 'user.name=Writer', '-c', 'user.email=w@x', 'commit', '-qm', 'writer']);
}
if (env.STUB_CHILD) {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  child.unref();
  writeFileSync(env.STUB_CHILD, [process.pid, child.pid].join(' '));
}
if (env.STUB_SLEEP) setTimeout(() => {}, 30000);
if (env.STUB_FAIL) { console.error('user\\nquoting any error here\\nERROR: Selected model is at capacity.'); process.exit(1); }
if (cli === 'codex') {
  console.error(['OpenAI Codex v9.9.9', '--------', 'model: ' + (env.STUB_MODEL ?? after('-m') ?? 'configured-model'),
    'provider: ' + (env.STUB_PROVIDER ?? 'configured-provider'), 'sandbox: ' + after('-s'),
    'reasoning effort: ' + (env.STUB_EFFORT ?? (config('model_reasoning_effort') || 'medium')), 'session id: stub-session', '--------', 'model: quoted'].join('\\n'));
  console.log('OK');
} else {
  const model = env.STUB_MODEL ?? after('--model') ?? 'configured-claude';
  // The CLI keys modelUsage by the requested model and names the canonical one inside that entry.
  const usage = { contextWindow: Number(env.STUB_CONTEXT ?? 1000000), provider: 'firstParty' };
  if (env.STUB_CANONICAL !== 'omitted') usage.canonicalModel = env.STUB_CANONICAL ?? model;
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'stub-claude',
    ...(env.STUB_RESULT === 'absent' ? {} : { result: env.STUB_RESULT === undefined ? 'OK' : JSON.parse(env.STUB_RESULT) }),
    modelUsage: env.STUB_MULTIPLE ? { [model]: usage, other: usage } : { [model]: usage },
    permission_denials: env.STUB_DENY ? [{ tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' } }] : [] }));
}
if (env.STUB_FLOOD) { const block = 'x'.repeat(1 << 20); for (let i = 0; i < 5; i++) process.stderr.write(block); }
`;

// Fixture roots are removed once the file's tests finish, pass or fail, so runs do not exhaust a shared tmpfs.
const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function fixture({ gitHang } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'launch-phase-'));
  roots.push(root);
  const bin = join(root, 'bin');
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  for (const dir of [bin, repo, join(home, '.codex')]) mkdirSync(dir, { recursive: true });
  for (const cli of ['codex', 'claude']) {
    writeFileSync(join(bin, cli), STUB);
    chmodSync(join(bin, cli), 0o755);
  }
  if (gitHang) { writeFileSync(join(bin, 'git'), gitStub(gitHang)); chmodSync(join(bin, 'git'), 0o755); }
  const gitIn = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@x', ...args]).toString().trim();
  gitIn('init', '-q');
  writeFileSync(join(repo, 'file.txt'), 'base');
  gitIn('add', 'file.txt');
  gitIn('commit', '-qm', 'base');
  // User configuration belongs to the installed CLI and must never be rewritten by this helper.
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "configured-model"\n');
  writeFileSync(join(root, 'prompt.md'), 'Review. model: quoted-in-prompt\n');
  return { root, bin, repo, home, head: gitIn('rev-parse', 'HEAD'), gitIn };
}

function launchSpec(f, { provider = 'codex', role = 'reviewer', phase = role === 'reviewer' ? 'review' : 'writer', env = {}, flags = {} } = {}) {
  const args = { provider, role, phase, 'run-id': 'run-1', round: '1', attempt: '1', worktree: f.repo, 'expected-head': f.head,
    prompt: join(f.root, 'prompt.md'), output: join(f.root, 'out.txt'), meta: join(f.root, 'meta.txt'),
    record: join(f.root, 'record.json'), report: join(f.root, 'report.md'), timeout: '20', ...flags };
  return [[HELPER, 'run', ...Object.entries(args).filter(([, v]) => v !== undefined).flatMap(([k, v]) => [`--${k}`, v])], {
    encoding: 'utf8',
    env: { ...CLEAN_ENV, PATH: `${f.bin}:${process.env.PATH}`, HOME: f.home, CODEX_HOME: join(f.home, '.codex'),
      STUB_LOG: join(f.root, 'stub.log'), ...env },
  }];
}

function launch(f, options = {}) {
  const [argv, spawnOptions] = launchSpec(f, options);
  const result = spawnSync('node', argv, spawnOptions);
  const read = (name) => (existsSync(join(f.root, name)) ? readFileSync(join(f.root, name), 'utf8') : '');
  const log = read('stub.log').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, recordText: read('record.json'),
    record: read('record.json') ? JSON.parse(read('record.json')) : null, output: read('out.txt'), meta: read('meta.txt'), report: read('report.md'),
    log, exec: log.find((entry) => entry.argv[0] === 'exec' || entry.argv[0] === '-p') };
}

const hasPair = (argv, flag, value) => argv.some((arg, index) => arg === flag && argv[index + 1] === value);

test('each supported CLI role uses configured defaults without rewriting configuration', () => {
  for (const provider of ['codex', 'claude']) {
    for (const role of ['reviewer', 'writer']) {
      if (provider === 'codex' && role === 'writer') continue; // refused; see the Codex writer test
      const f = fixture();
      const config = join(f.home, '.codex', 'config.toml');
      const before = readFileSync(config, 'utf8');
      const run = launch(f, { provider, role });
      assert.equal(run.code, 0, run.stderr + run.recordText);
      assert.equal(run.record.route, 'cli-configured');
      assert.deepEqual(run.record.requested, { model: null, effort: null, profile: null });
      const { argv } = run.exec;
      if (provider === 'codex') {
        assert.ok(hasPair(argv, '-s', 'read-only'));
        assert.ok(!argv.includes('--ignore-user-config') && !argv.includes('-m'));
      } else {
        assert.ok(hasPair(argv, '--tools', role === 'reviewer' ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write'));
        assert.ok(argv.includes('--strict-mcp-config') && !argv.includes('--model'));
        assert.ok(hasPair(argv, '--permission-mode', 'acceptEdits'));
        assert.ok(hasPair(argv, '--setting-sources', 'user'), 'PR-controlled project settings must not load');
      }
      assert.equal(readFileSync(config, 'utf8'), before);
      assert.deepEqual(readdirSync(join(f.home, '.codex')), ['config.toml']);
    }
  }
});

test('optional model, effort and existing Codex profile are passed as literal values', () => {
  for (const provider of ['codex', 'claude']) {
    const flags = { model: 'chosen-model', effort: 'high', ...(provider === 'codex' ? { profile: 'work' } : {}) };
    const run = launch(fixture(), { provider, flags });
    assert.equal(run.code, 0, run.recordText);
    assert.ok(hasPair(run.exec.argv, provider === 'codex' ? '-m' : '--model', 'chosen-model'));
    assert.ok(hasPair(run.exec.argv, provider === 'codex' ? '-c' : '--effort', provider === 'codex' ? 'model_reasoning_effort="high"' : 'high'));
    if (provider === 'codex') assert.ok(hasPair(run.exec.argv, '--profile', 'work'));
    assert.equal(run.record.observed.model, 'chosen-model');
  }
});

test('unknown routes and unsupported profile inputs stop before any CLI or record write', () => {
  for (const options of [{ provider: 'codex-azure' }, { provider: 'claude', flags: { profile: 'work' } },
    { flags: { model: 'x; echo unsafe' } }, { flags: { 'azure-env': '/tmp/unread.env' } }]) {
    const run = launch(fixture(), options);
    assert.equal(run.code, 2);
    assert.deepEqual(run.log, []);
    assert.equal(run.recordText, '');
  }
});

test('configured credentials reach the CLI environment and are redacted from saved output', () => {
  const run = launch(fixture(), { env: { STUB_LEAK: '1', AZURE_OPENAI_API_KEY: KEY } });
  assert.equal(run.code, 0, run.recordText);
  assert.equal(run.exec.key, KEY);
  assert.ok(!run.exec.argv.join(' ').includes(KEY));
  for (const text of [run.stdout, run.stderr, run.output, run.meta, run.recordText]) assert.ok(!text.includes(KEY));
  assert.match(run.meta, /leak <redacted>/);
});

test('the phase record distinguishes configuration requests from observed facts', () => {
  const { record } = launch(fixture());
  assert.equal(record.status, 'completed');
  assert.deepEqual(record.observed, { provider: 'configured-provider', model: 'configured-model', effort: 'medium', context: 'N/A (not emitted)',
    session: 'stub-session', sandbox: 'read-only', completed: true });
  assert.equal(record.cli_version, 'codex 9.9.9');
  assert.ok(!Number.isNaN(Date.parse(record.started_at)) && !Number.isNaN(Date.parse(record.ended_at)));
  assert.deepEqual([record.exit_code, record.run_id, record.round, record.phase, record.attempt], [0, 'run-1', 1, 'review', 1]);
  const claude = launch(fixture(), { provider: 'claude', env: { STUB_CANONICAL: 'omitted', STUB_CONTEXT: '200000' } }).record;
  assert.deepEqual([claude.observed.model, claude.observed.effort, claude.observed.context, claude.status],
    ['configured-claude', 'N/A (not emitted)', 200000, 'completed']);
});

test('an explicit model or effort mismatch blocks rather than silently substituting configuration', () => {
  for (const options of [
    { flags: { model: 'requested-model' }, env: { STUB_MODEL: 'other-model' } },
    { flags: { effort: 'high' }, env: { STUB_EFFORT: 'low' } },
    { provider: 'claude', flags: { model: 'requested-model' }, env: { STUB_MODEL: 'other-model' } },
    { provider: 'claude', env: { STUB_MULTIPLE: '1' } },
    { provider: 'claude', flags: { model: 'requested-model' }, env: { STUB_CANONICAL: 'different-model' } },
  ]) {
    const run = launch(fixture(), options);
    assert.equal(run.code, 1, run.recordText);
    assert.equal(run.record.status, 'blocked');
    assert.ok(run.record.blockers.length > 0);
  }
});

test('a failed CLI version probe stops before running a phase', () => {
  const run = launch(fixture(), { env: { STUB_VERSION_FAIL: '1' } });
  assert.equal(run.code, 1);
  assert.equal(run.record.status, 'refused');
  assert.equal(run.exec, undefined);
  assert.match(run.record.blockers[0], /version probe failed/);
});

test('a reviewer that changes the checkout is rejected', () => {
  const run = launch(fixture(), { env: { STUB_DIRTY: '1' } });
  assert.equal(run.code, 1);
  assert.equal(run.record.status, 'blocked');
  assert.match(run.record.blockers[0], /read-only violation/);
});

test('a transport failure is recorded from the CLI log line, never from quoted transcript text', () => {
  const run = launch(fixture(), { env: { STUB_FAIL: '1' } });
  assert.equal(run.code, 1);
  assert.deepEqual([run.record.status, run.record.transport_failure], ['failed', 'ERROR: Selected model is at capacity.']);
  assert.deepEqual(run.record.errors, ['ERROR: Selected model is at capacity.']);
});

function assertGone(pids) {
  const deadline = Date.now() + 5000;
  for (const pid of pids) {
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { break; }
      execFileSync('sleep', ['0.1']);
    }
    assert.throws(() => process.kill(pid, 0), `process ${pid} is still running`);
  }
}

test('a phase that outlives its timeout is stopped with its whole process group', () => {
  const f = fixture();
  const pids = join(f.root, 'pids');
  const run = launch(f, { env: { STUB_SLEEP: '1', STUB_CHILD: pids }, flags: { timeout: '1' } });
  assert.equal(run.code, 1);
  assert.equal(run.record.status, 'timeout');
  assert.match(run.record.transport_failure, /^timeout after \d+s$/);
  assertGone(readFileSync(pids, 'utf8').split(' ').map(Number));
});

test('a child left behind by a finished phase does not keep running', () => {
  const f = fixture();
  const pids = join(f.root, 'pids');
  const run = launch(f, { env: { STUB_CHILD: pids } });
  assert.equal(run.code, 0, run.recordText);
  assertGone(readFileSync(pids, 'utf8').split(' ').map(Number));
});

test('a flooding CLI is capped instead of accumulated without bound', () => {
  const run = launch(fixture(), { env: { STUB_FLOOD: '1' } });
  assert.equal(run.code, 0, run.recordText);
  assert.equal(run.record.observed.model, 'configured-model', 'the session header still parses');
  assert.ok(run.meta.length < (4 << 20) + 4096, `captured ${run.meta.length} bytes of a 5 MiB flood`);
  assert.ok(run.meta.endsWith('\n[stream truncated]\n'));
});

test('a signal to the helper stops its detached group instead of orphaning it', async () => {
  const f = fixture();
  const pids = join(f.root, 'pids');
  const [argv, options] = launchSpec(f, { env: { STUB_CHILD: pids, STUB_SLEEP: '1' } });
  const helper = spawn('node', argv, options);
  const deadline = Date.now() + 10000;
  while (!existsSync(pids) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  helper.kill('SIGTERM');
  const [code, signal] = await new Promise((resolve) => helper.on('exit', (...ended) => resolve(ended)));
  assert.ok(code === 143 || signal === 'SIGTERM', `the helper ended as ${code} / ${signal}`);
  assertGone(readFileSync(pids, 'utf8').split(' ').map(Number));
});

test('a probe that outlives its timeout is recorded as a timeout instead of launching on a missing answer', () => {
  for (const [expected, options] of [
    [/codex --version timed out after \d+s/, { env: { STUB_HANG: '--version' } }],
    [/git rev-parse timed out after \d+s/, { gitHang: 'rev-parse' }],
    [/git remote timed out after \d+s/, { gitHang: 'remote', provider: 'claude', role: 'writer', flags: { push: 'origin' } }],
  ]) {
    const f = fixture({ gitHang: options.gitHang });
    f.gitIn('remote', 'add', 'origin', join(f.root, 'remote.git'));
    const run = launch(f, { ...options, flags: { timeout: '1', ...options.flags } });
    assert.equal(run.code, 1, run.recordText);
    assert.equal(run.record.status, 'timeout');
    assert.match(run.recordText, expected);
    assert.equal(run.exec, undefined, 'no phase launches after a probe that never answered');
  }
});

test('a probe that expires after the phase stops the record claiming the phase completed', () => {
  const f = fixture({ gitHang: 'log' });
  const run = launch(f, { provider: 'claude', role: 'writer', env: { STUB_COMMIT: '1' }, flags: { timeout: '3' } });
  assert.equal(run.code, 1, run.recordText);
  assert.equal(run.record.status, 'timeout');
  assert.match(run.recordText, /git log timed out after \d+s/);
});

test('an artifact destination that cannot be written is refused before the phase, not after it', () => {
  const f = fixture();
  const run = launch(f, { flags: { output: f.repo } });
  assert.equal(run.code, 2);
  assert.match(run.stderr, /--output must name a file, not a directory/);
  assert.deepEqual(run.log, [], 'no phase runs for a destination whose write is already known to fail');
  assert.equal(launch(fixture(), { flags: { record: join(f.root, 'no-such-dir/record.json') } }).code, 2);
});

test('a head mismatch or dirty worktree refuses the launch', () => {
  const mismatch = launch(fixture(), { flags: { 'expected-head': '0'.repeat(40) } });
  assert.equal(mismatch.record.status, 'refused');
  assert.match(mismatch.record.blockers[0], /^head-mismatch: worktree HEAD [0-9a-f]{40} differs from expected 0{40}$/);
  assert.equal(mismatch.exec, undefined);
  const f = fixture();
  writeFileSync(join(f.repo, 'file.txt'), 'dirty');
  assert.match(launch(f).record.blockers[0], /^dirty-worktree/);
});

test('a writer edit, commit and push permission is checked before the launch, not only after it', (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores the write bit, so a denial cannot be staged');
  const f = fixture();
  f.gitIn('remote', 'add', 'origin', join(f.root, 'remote.git'));
  // The remote is a path that does not exist, so the record reports the granted authority and leaves the transport open
  // rather than predicting a push the child could not complete.
  assert.deepEqual(launch(f, { provider: 'claude', role: 'writer', flags: { push: 'origin' } }).record.permissions,
    { edit: 'writable', commit: 'coordinator-required', push: 'granted-transport-unverified' });
  assert.equal(launch(f, { provider: 'claude', role: 'writer' }).record.permissions.push, 'not-granted');
  assert.equal(launch(f, { provider: 'claude', role: 'writer', flags: { push: 'absent' } }).record.permissions.push, 'no-such-remote');
  assert.equal(launch(f, { flags: { push: 'origin' } }).code, 2, 'a reviewer is never given push authority');
  const noCommit = fixture();
  chmodSync(join(noCommit.root, 'repo/.git'), 0o555);
  const run = launch(noCommit, { provider: 'claude', role: 'writer' });
  chmodSync(join(noCommit.root, 'repo/.git'), 0o755);
  assert.deepEqual(run.record.permissions, { edit: 'writable', commit: 'coordinator-required', push: 'not-granted' });
  assert.ok(run.exec, 'a writer that cannot commit still runs, because the coordinator commits for it');
  const noEdit = fixture();
  chmodSync(noEdit.repo, 0o555);
  const refused = launch(noEdit, { provider: 'claude', role: 'writer' });
  chmodSync(noEdit.repo, 0o755);
  assert.equal(refused.record.status, 'refused');
  assert.deepEqual(refused.record.blockers, ['writer-permission: the worktree is not writable, so the phase could produce no change']);
  assert.equal(refused.exec, undefined, 'no phase launches once the writer cannot change the worktree');
});

test('a denied push is reported as that operation, and writer commits are listed', () => {
  const denied = launch(fixture(), { provider: 'claude', role: 'writer', env: { STUB_DENY: '1' } });
  assert.deepEqual(denied.record.denied, ['push']);
  const committed = launch(fixture(), { provider: 'claude', role: 'writer', env: { STUB_COMMIT: '1' } });
  assert.equal(committed.record.commits.length, 1);
  assert.match(committed.record.commits[0].committer, /^Writer <w@x>$/);
});

test('a writer that leaves uncommitted changes completes, and the coordinator commit is attributed to the coordinator', () => {
  const f = fixture();
  const run = launch(f, { provider: 'claude', role: 'writer', env: { STUB_DIRTY: '1' } });
  assert.equal(run.code, 0, run.recordText);
  assert.deepEqual([run.record.status, run.record.commits, run.record.dirty_after, run.record.denied], ['completed', [], true, []]);
  f.gitIn('add', 'change.txt');
  f.gitIn('commit', '-qm', 'coordinator commit of the writer change');
  const sha = f.gitIn('rev-parse', 'HEAD');
  const record = join(f.root, 'record.json');
  const attribute = (commit) => spawnSync('node', [HELPER, 'attribute', '--record', record, '--operation', 'commit', '--sha', commit], { encoding: 'utf8' });
  assert.equal(attribute(sha).status, 0);
  const [entry] = JSON.parse(readFileSync(record, 'utf8')).coordinator;
  assert.deepEqual([entry.actor, entry.operation, entry.sha], ['coordinator', 'commit', sha]);
  f.gitIn('checkout', '-q', '--orphan', 'unrelated');
  f.gitIn('commit', '-qm', 'unrelated');
  const refused = attribute(f.gitIn('rev-parse', 'HEAD'));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /is not a commit descending from/);
});

test('no writer gets a shell, and a Codex writer is refused before launch', () => {
  const f = fixture();
  const linked = join(f.root, 'linked');
  f.gitIn('worktree', 'add', '-q', linked, f.head);
  for (const worktree of [f.repo, linked]) {
    const claude = launch(f, { provider: 'claude', role: 'writer', flags: { worktree } });
    assert.deepEqual([claude.record.permissions.commit, Boolean(claude.exec)], ['coordinator-required', true], `${worktree}: ${claude.recordText}`);
    assert.ok(!claude.exec.argv.join(',').includes('Bash'), 'a writer shell would run PR code under the operator login');
  }
  const codex = launch(fixture(), { provider: 'codex', role: 'writer' });
  assert.equal(codex.record.status, 'refused');
  assert.match(codex.record.blockers[0], /^codex-writer:/);
  assert.equal(codex.exec, undefined);
});

test('a role child receives no coordinator session variable, and a Claude child keeps only its login and provider variables', () => {
  const names = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CODEX_COMPANION_SESSION_ID'];
  const sentinels = Object.fromEntries(names.map((name) => [name, `sentinel:${name}`]));
  for (const provider of ['codex', 'claude']) {
    for (const role of ['reviewer', 'writer']) {
      if (provider === 'codex' && role === 'writer') continue;
      const run = launch(fixture(), { provider, role, env: sentinels });
      assert.equal(run.code, 0, run.recordText);
      assert.ok(run.log.length >= 2, 'the version probe and the phase');
      for (const entry of run.log) {
        assert.deepEqual(entry.session, provider === 'claude'
          ? { CLAUDE_CODE_OAUTH_TOKEN: true, CLAUDE_CODE_USE_BEDROCK: true, CLAUDE_CONFIG_DIR: true } : {}, `${provider} ${role} ${entry.argv[0]}`);
      }
    }
  }
});

test('a Claude report loses exactly one outer fence, and any other wrapper or missing result blocks', () => {
  const body = '# Review\n\n```js\ninner();\n```\n\n| a |\n';
  for (const [phase, result, expected] of [
    ['review', body, body], ['closing-review', `\n\`\`\`markdown\n${body}\`\`\`\n`, `\n${body}`], ['final-review', `~~~~md\n${body}~~~~~\n`, body],
    ['review', ` \`\`\`markdown\n${body}   \`\`\`\n`, body],
    ['writer', `\`\`\`\n${body}\`\`\``, body], ['closing-writer', '```markdown\n ```\n# Review\n ```\n```\n', /two code fences/],
    ['review', `\`\`\`text\n${body}\`\`\`\n`, /unrecognised code fence/], ['review', `\`\`\`\n${body}`, /unrecognised code fence/],
    ['review', `\`\`\`\`\n${body}\`\`\`\n`, /unrecognised code fence/], ['review', `~~~\n${body}\`\`\`\n`, /unrecognised code fence/],
    ['review', null, /missing or not a string/], ['writer', 'absent', /missing or not a string/],
  ]) {
    const run = launch(fixture(), { provider: 'claude', role: phase.endsWith('writer') ? 'writer' : 'reviewer', phase,
      env: { STUB_RESULT: result === 'absent' ? 'absent' : JSON.stringify(result) } });
    if (typeof expected === 'string') assert.deepEqual([run.code, run.record.status, run.report], [0, 'completed', expected], JSON.stringify(result));
    else { assert.deepEqual([run.code, run.record.status, run.report], [1, 'blocked', ''], JSON.stringify(result)); assert.match(run.record.blockers.join('\n'), expected); }
    assert.equal(JSON.parse(run.output).session_id, 'stub-claude', '--output still carries the raw result');
  }
  const codex = launch(fixture(), { phase: 'review' });
  assert.deepEqual([codex.code, codex.report], [0, codex.output], 'a Codex report is its stdout');
  assert.equal(launch(fixture(), { provider: 'claude', flags: { report: undefined } }).code, 2, 'a phase without --report is a usage error');
});
