import { spawn } from 'node:child_process';
import { accessSync, constants, createReadStream, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync,
  writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Launches one dev-review-pr phase on an explicitly selected route and writes its phase record.
// Exit 0: the phase completed and its observed profile matches the request. Exit 1: refused,
// blocked, timed out or failed, and the record says which. Exit 2: the helper did not run.

const PROBE_SECONDS = 60;
// A role session is a fresh host process, not part of the coordinator's Claude Code or Codex session, so it receives no
// variable of either. A Claude child keeps the ones that locate its login or select the provider its CLI is configured for.
const SESSION_VARIABLE = /^(?:CLAUDE|CODEX_COMPANION_)/;
// shortcut: keeps only login and CLAUDE_CODE_USE_* provider switches; widen it when another env-configured route needs more.
const CLAUDE_ROUTE = /^(?:CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_[A-Z0-9_]+)$/;
const GRACE_MS = 2000;
const STREAM_LIMIT = 4 << 20;
// A detached group survives its launcher, so a signal to the helper stops every group still live.
const groups = new Set();
// An expired subprocess answers nothing, so its phase ends as a timeout instead of continuing from a missing answer.
const timeouts = [];
const killGroup = (pid, signal) => { try { process.kill(-pid, signal); } catch { /* the group has already gone */ } };
const stopGroups = (signal) => { for (const pid of groups) killGroup(pid, 'SIGKILL'); process.exit(signal === 'SIGINT' ? 130 : 143); };
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stopGroups);

const ROUTES = {
  codex: { cli: 'codex' },
  claude: { cli: 'claude' },
};
const PHASES = { reviewer: ['review', 'closing-review', 'final-review'], writer: ['writer', 'closing-writer'] };

// Every probe and phase runs as its own process group, so a timeout, or the end of the phase,
// stops the whole tree, including children that outlive their parent.
function runBounded(command, args, { cwd, env, stdinPath, timeoutSeconds, label }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const out = [];
    const err = [];
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, { cwd, env, detached: true, stdio: [stdinPath ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    groups.add(child.pid);
    const signalGroup = (signal) => killGroup(child.pid, signal);
    const finish = (fields) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); groups.delete(child.pid);
      if (timedOut) timeouts.push(`${label} timed out after ${Math.round((Date.now() - started) / 1000)}s`);
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'),
        timedOut, elapsedMs: Date.now() - started, ...fields });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup('SIGTERM');
      setTimeout(() => {
        signalGroup('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
      }, GRACE_MS).unref();
    }, timeoutSeconds * 1000);
    // Each stream is capped, so a flooding or malfunctioning CLI cannot exhaust the helper before its timeout.
    const capture = (sink) => { let size = 0; return (chunk) => { if (size > STREAM_LIMIT) return; size += chunk.length;
      sink.push(size <= STREAM_LIMIT ? chunk : Buffer.concat([chunk.subarray(0, STREAM_LIMIT + chunk.length - size), Buffer.from('\n[stream truncated]\n')])); }; };
    child.stdout.on('data', capture(out));
    child.stderr.on('data', capture(err));
    child.on('error', (error) => finish({ code: null, signal: null, spawnError: error.code ?? error.message }));
    child.on('exit', () => signalGroup('SIGKILL'));
    child.on('close', (code, signal) => finish({ code, signal }));
    if (stdinPath) {
      child.stdin.on('error', () => {});
      createReadStream(stdinPath).on('error', () => child.stdin.end()).pipe(child.stdin);
    }
  });
}

const git = async (worktree, args, timeoutSeconds) => {
  const result = await runBounded('git', ['-C', worktree, ...args], { env: process.env, timeoutSeconds, label: `git ${args[0]}` });
  return result.code === 0 ? result.stdout.trim() : null; };

// ---- The bounded worker: every model-directed read, edit and command runs apart from the logged-in CLI. ----

export const BOUNDED_SHELL = fileURLToPath(new URL('./bounded-shell.sh', import.meta.url));
const real = (path) => { try { return realpathSync(path); } catch { return null; } };
const covers = (outer, inner) => outer === inner || inner.startsWith(`${outer}/`);

// Read-only toolchain mounts: each absolute PATH directory and, for a `bin` directory deeper than a home subdirectory such
// as ~/.local, its installation prefix. A directory that is or holds the home directory or a CLI login is never mounted.
export function toolchainDirs(path, env) {
  const home = real(env.HOME || homedir());
  const logins = [real(env.CODEX_HOME || join(home ?? '/', '.codex')), real(env.CLAUDE_CONFIG_DIR || join(home ?? '/', '.claude'))].filter(Boolean);
  const dirs = new Set();
  for (const dir of path.split(':').filter(isAbsolute).map(real)) {
    if (!dir || !statSync(dir).isDirectory()) continue;
    const shallow = home && [dirname(dir), dirname(dirname(dir))].includes(home);
    for (const candidate of basename(dir) === 'bin' && !shallow ? [dir, dirname(dir)] : [dir]) {
      if (candidate !== '/' && ![home, ...logins].some((guarded) => guarded && covers(candidate, guarded))
        && !logins.some((login) => covers(login, candidate))) dirs.add(candidate);
    }
  }
  return [...dirs];
}

// The worktree's `.git` entry locates the repository every later Git command trusts, so a phase may not change it.
const gitLink = (worktree) => { const path = join(worktree, '.git');
  try { return lstatSync(path).isFile() ? readFileSync(path, 'utf8') : lstatSync(path).isDirectory() ? 'directory' : 'other'; } catch { return 'missing'; } };

const toml = (table) => `{${Object.entries(table).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(', ')}}`;

// Provider credentials and setup stay in the installed CLI's own process and configuration; model-directed tools reach only
// the bounded worker. Optional model/effort/profile arguments select existing capabilities without copying configuration.
function launchCommand(request, bounds) {
  const write = request.role === 'writer';
  if (request.provider === 'claude') {
    // Bash is the only tool, and the trusted shell prefix runs every command in bounded-shell.sh. Native file tools would
    // run inside the logged-in CLI, so none is offered: reads, diffs, edits and checks all go through the bounded shell.
    return { command: 'claude', env: { CLAUDE_CODE_SHELL_PREFIX: BOUNDED_SHELL, BOUNDED_WORKTREE: request.worktree,
      BOUNDED_MODE: write ? 'write' : 'read', BOUNDED_SCRATCH: bounds.scratch, BOUNDED_READ: bounds.read.join('\n'),
      BOUNDED_GIT: bounds.git.join('\n'), BOUNDED_PATH: bounds.path, TMPDIR: bounds.scratch },
    args: ['-p', ...(request.model ? ['--model', request.model] : []), ...(request.effort ? ['--effort', request.effort] : []),
      '--permission-mode', 'dontAsk', '--allowedTools', 'Bash', '--no-session-persistence',
      // The worktree's `.claude/settings*.json` is PR content: its hooks, permissions and environment never load.
      '--setting-sources', 'user',
      '--output-format', 'json', '--tools', 'Bash', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'] }; }
  // Codex's own Linux sandbox applies a named permission profile to every command it runs: no network, a cleared environment,
  // read access to the system minimum, the toolchain and Git metadata, and the worktree writable only for a writer.
  // Git directories come last and are the most specific entries, so a worktree's own `.git` stays read-only.
  const filesystem = { ':minimal': 'read', ...Object.fromEntries(bounds.read.map((dir) => [dir, 'read'])),
    ':workspace_roots': write ? 'write' : 'read', [bounds.scratch]: 'write', ...Object.fromEntries(bounds.git.map((dir) => [dir, 'read'])) };
  return { command: 'codex', env: {}, args: ['exec', '--color', 'never', '-C', request.worktree,
    ...(request.profile ? ['--profile', request.profile] : []), ...(request.model ? ['-m', request.model] : []),
    ...(request.effort ? ['-c', `model_reasoning_effort="${request.effort}"`] : []),
    '-c', 'default_permissions="bounded"', '-c', `permissions.bounded.filesystem=${toml(filesystem)}`,
    '-c', 'permissions.bounded.network.enabled=false', '-c', 'shell_environment_policy.inherit="none"',
    '-c', `shell_environment_policy.set=${toml({ PATH: bounds.path, LANG: 'C.UTF-8', HOME: bounds.scratch, TMPDIR: bounds.scratch })}`,
    // Configured MCP servers run beside the CLI, outside the sandbox, so none is started.
    '-c', 'approval_policy="never"', '-c', 'mcp_servers={}', '--ephemeral', '-'] };
}

// Codex prints its session header between the first two dashed lines on stderr; anything
// later is transcript and may quote prompt text, so it is never read as metadata.
function codexObserved(stderr) {
  const lines = stderr.split(/\r\n|\n|\r/);
  const open = lines.findIndex((line) => /^-{4,}$/.test(line));
  const close = lines.findIndex((line, index) => index > open && /^-{4,}$/.test(line));
  const header = {};
  for (const line of open < 0 || close < 0 ? [] : lines.slice(open + 1, close)) {
    const match = line.match(/^([a-z ]+):\s*(.+)$/);
    if (match) header[match[1]] = match[2].trim();
  }
  return { provider: header.provider ?? null, model: header.model ?? null, effort: header['reasoning effort'] ?? null,
    context: 'N/A (not emitted)', session: header['session id'] ?? null, sandbox: header.sandbox ?? null, completed: true };
}

function deniedOperation({ tool_name: tool, tool_input: input }) {
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return 'edit';
  const command = tool === 'Bash' ? String(input?.command ?? '') : '';
  return /\bgit\b[^;&|]*\bpush\b/.test(command) ? 'push' : /\bgit\b[^;&|]*\bcommit\b/.test(command) ? 'commit' : tool;
}

function claudeObserved(stdout, stderr, request) {
  let result;
  try { result = JSON.parse(stdout); } catch { result = null; }
  const usage = result?.modelUsage ?? {};
  const names = Object.keys(usage);
  // A single reported usage entry identifies the model. Keep canonical identity separately
  // when this CLI emits it; do not require a source-machine-specific model or context window.
  const model = names.length === 1 ? names[0] : null;
  return { provider: 'claude', model: usage[model]?.canonicalModel ?? model,
    reported_model: model, context: usage[model]?.contextWindow ?? 'N/A (not emitted)',
    effort: /Unknown --effort value/.test(stderr) ? 'rejected' : request.effort ? `${request.effort} (requested)` : 'N/A (not emitted)',
    session: result?.session_id ?? null, completed: result?.subtype === 'success' && result?.is_error === false,
    denied: (result?.permission_denials ?? []).map(deniedOperation), text: result?.result };
}

// The report the coordinator publishes is the result text with exactly one outer fence removed: a fence line is three
// or more backticks or tildes, an accepted opener carries no info string or `markdown`/`md`, and its closer is a bare
// fence of the same character at least as long. Any other wrapper, a second one, or a missing result stops the phase.
function unwrapReport(text) {
  if (typeof text !== 'string') return { blocker: 'report: the result field is missing or not a string' };
  const lines = text.split(/(?<=\n)/);
  const first = lines.findIndex((line) => line.trim());
  const open = first < 0 ? null : lines[first].trimEnd().match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!open) return { text };
  const last = lines.length - 1 - [...lines].reverse().findIndex((line) => line.trim());
  const closed = last > first && new RegExp(`^ {0,3}${open[1][0]}{${open[1].length},}$`).test(lines[last].trimEnd());
  if (!['', 'markdown', 'md'].includes(open[2].trim()) || !closed) return { blocker: 'report: the result is wrapped in an unrecognised code fence' };
  const inner = lines.filter((_, index) => index !== first && index !== last).join('');
  return /^ {0,3}(`{3,}|~{3,})/.test(inner.split(/(?<=\n)/).find((line) => line.trim())?.trimEnd() ?? '')
    ? { blocker: 'report: the result is wrapped in two code fences' } : { text: inner };
}

const writable = (path) => { try { accessSync(path, constants.W_OK); return true; } catch { return false; } };

// Each writer operation is checked before its phase is spent, and recorded as what the check established, not as a
// permission the helper cannot observe. A writer's Git metadata is read-only in the bounded worker, so the coordinator
// commits its change. No local check
// reaches a push transport, so a push is never reported as permitted. Only an unwritable worktree refuses.
async function writerPermissions(request, probeSeconds) {
  const remote = request.push && await git(request.worktree, ['remote', 'get-url', '--push', request.push], probeSeconds);
  return { edit: writable(request.worktree) ? 'writable' : 'not-writable', commit: 'coordinator-required',
    push: !request.push ? 'not-granted' : remote ? 'granted-transport-unverified' : 'no-such-remote' };
}

// Compare what the session reported with what was requested; any gap blocks the phase.
function verify(request, requested, observed) {
  const blockers = [];
  if (!observed.session) blockers.push('session id not observed');
  if (!observed.model) blockers.push('model not observed unambiguously');
  else if (requested.model && observed.model !== requested.model) {
    blockers.push(`model mismatch: requested ${requested.model}, observed ${observed.model}`);
  }
  if (!observed.provider) blockers.push('provider not observed');
  if (observed.effort === null) observed.effort = requested.effort ? `${requested.effort} (requested)` : 'N/A (not emitted)';
  if (observed.effort === 'rejected' || (requested.effort && ![requested.effort, `${requested.effort} (requested)`].includes(observed.effort))) {
    blockers.push(`effort mismatch: requested ${requested.effort ?? 'CLI default'}, observed ${observed.effort}`);
  }
  return blockers;
}

// Only the CLI's own log lines count: stderr also carries the transcript, which may quote "error".
const errorLines = (stderr) => stderr.split(/\r\n|\n|\r/)
  .filter((line) => /^(?:\S+Z\s+)?ERROR\b|^Error:|stream disconnected|error sending request/.test(line)).slice(0, 3).map((line) => line.slice(0, 240));

async function runPhase(request) {
  const route = ROUTES[request.provider];
  const probeSeconds = Math.min(PROBE_SECONDS, request.timeout);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !SESSION_VARIABLE.test(name) || (route.cli === 'claude' && CLAUDE_ROUTE.test(name))));
  const record = { run_id: request.runId, round: request.round, phase: request.phase, attempt: request.attempt,
    role: request.role, provider: route.cli, route: request.profile ? `profile:${request.profile}` : 'cli-configured', worktree: request.worktree,
    requested: { model: request.model ?? null, effort: request.effort ?? null, profile: request.profile ?? null },
    started_at: new Date().toISOString(), blockers: [], coordinator: [] };
  const secrets = Object.entries(env).filter(([name, value]) => /(?:API_KEY|TOKEN|SECRET|PASSWORD)$/.test(name) && value.length >= 8).map(([, value]) => value);
  let scratch;
  const finish = (status, fields = {}) => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    if (timeouts.length) { status = 'timeout'; fields = { timeouts, transport_failure: timeouts[0], ...fields }; }
    Object.assign(record, fields, { status, ended_at: new Date().toISOString() });
    return { status, record, secrets }; };

  record.head_before = await git(request.worktree, ['rev-parse', 'HEAD'], probeSeconds);
  if (record.head_before !== request.expectedHead) {
    record.blockers.push(`head-mismatch: worktree HEAD ${record.head_before ?? 'unreadable'} differs from expected ${request.expectedHead}`);
  } else if ((await git(request.worktree, ['status', '--porcelain'], probeSeconds)) !== '') {
    record.blockers.push('dirty-worktree: the worktree has uncommitted changes or its status is unreadable');
  }
  // The bounded worker is built on Linux namespaces, bubblewrap for Claude and Codex's Linux sandbox; elsewhere no role runs.
  if (process.platform !== 'linux') record.blockers.push(`bounded-tools: role tools run only in the Linux bounded worker, not on ${process.platform}`);
  if (!record.blockers.length && request.role === 'writer') record.permissions = await writerPermissions(request, probeSeconds);
  if (record.permissions?.edit === 'not-writable') record.blockers.push('writer-permission: the worktree is not writable, so the phase could produce no change');
  if (timeouts.length || record.blockers.length) return finish('refused');

  const version = await runBounded(route.cli, ['--version'], { env, timeoutSeconds: probeSeconds, label: `${route.cli} --version` });
  record.cli_version = version.code === 0 ? version.stdout.trim().split('\n').at(-1) : 'unverified';
  if (timeouts.length) return finish('timeout');
  if (version.code !== 0) { record.blockers.push(`${route.cli}: version probe failed; check the installed CLI`); return finish('refused'); }
  scratch = mkdtempSync(join(tmpdir(), 'dev-review-pr-'));
  const gitDirs = await git(request.worktree, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], probeSeconds);
  const bounds = { scratch, path: env.PATH ?? '', read: toolchainDirs(env.PATH ?? '', process.env), git: [...new Set((gitDirs ?? '').split('\n').filter(Boolean))] };
  const { command, args, env: workerEnv } = launchCommand(request, bounds);
  const phaseEnv = { ...env, ...workerEnv };
  if (route.cli === 'claude') {
    const probe = await runBounded(BOUNDED_SHELL, ['true'], { cwd: request.worktree, env: phaseEnv, timeoutSeconds: probeSeconds, label: 'bounded-shell probe' });
    if (timeouts.length) return finish('timeout');
    if (probe.code !== 0) {
      record.blockers.push(`bounded-shell: the worker could not start (${probe.stderr.trim().split('\n')[0]?.slice(0, 160) || `exit ${probe.code}`}); it needs bubblewrap and unprivileged user namespaces`);
      return finish('refused');
    }
  }
  const link = gitLink(request.worktree);
  record.started_at = new Date().toISOString();
  const phase = await runBounded(command, args, { cwd: request.worktree, env: phaseEnv, stdinPath: request.prompt,
    timeoutSeconds: request.timeout, label: `the ${request.role} phase` });
  record.ended_at = new Date().toISOString();
  record.elapsed_seconds = Math.round(phase.elapsedMs / 1000);
  record.exit_code = phase.code;
  // Codex reports no denials; its uncommitted change is the coordinator's to commit, never a denial.
  const { denied = [], text, ...observed } = route.cli === 'codex' ? codexObserved(phase.stderr) : claudeObserved(phase.stdout, phase.stderr, request);
  record.observed = observed;
  record.errors = errorLines(phase.stderr);
  if (gitLink(request.worktree) !== link) {
    record.blockers.push('git-metadata: the phase changed the worktree\'s .git entry, so no Git command runs in it; inspect it before any commit');
    return { ...finish('blocked'), output: { output: phase.stdout, meta: phase.stderr } };
  }
  record.head_after = await git(request.worktree, ['rev-parse', 'HEAD'], probeSeconds);
  record.dirty_after = (await git(request.worktree, ['status', '--porcelain'], probeSeconds)) !== '';
  record.commits = record.head_after && record.head_after !== record.head_before
    ? ((await git(request.worktree, ['log', '--format=%H%x09%an <%ae>%x09%cn <%ce>', `${record.head_before}..${record.head_after}`], probeSeconds)) ?? '')
      .split('\n').filter(Boolean).map((line) => { const [sha, author, committer] = line.split('\t'); return { sha, author, committer }; }) : [];
  record.denied = denied;
  const output = { output: phase.stdout, meta: phase.stderr };

  if (phase.timedOut) return { ...finish('timeout', { transport_failure: `timeout after ${record.elapsed_seconds}s` }), output };
  if (phase.spawnError || phase.code !== 0 || !observed.completed) {
    return { ...finish('failed', { transport_failure: record.errors[0] ?? phase.spawnError ?? `exit ${phase.code}${phase.signal ? ` (${phase.signal})` : ''}` }), output };
  }
  record.blockers.push(...verify(request, record.requested, observed));
  const report = route.cli === 'codex' ? { text: phase.stdout } : unwrapReport(text);
  if (report.blocker) record.blockers.push(report.blocker); else output.report = report.text;
  if (request.role === 'reviewer' && (record.head_after !== record.head_before || record.dirty_after)) record.blockers.push('read-only violation: the reviewer changed the worktree');
  return { ...finish(record.blockers.length ? 'blocked' : 'completed'), output };
}

// A coordinator commit or push is recorded against the writer phase, so the ledger never
// credits the writer with Git operations it could not perform.
async function attribute({ record: path, operation, sha }) {
  const record = JSON.parse(readFileSync(path, 'utf8'));
  if (record.role !== 'writer' || typeof record.head_before !== 'string' || !Array.isArray(record.coordinator)) {
    return [false, [`${path} is not a writer phase record`]];
  }
  const descends = await runBounded('git', ['-C', record.worktree, 'merge-base', '--is-ancestor', record.head_before, sha],
    { env: process.env, timeoutSeconds: PROBE_SECONDS, label: 'git merge-base' });
  if (descends.code !== 0) return [false, [timeouts[0] ?? `${sha} is not a commit descending from ${record.head_before}`]];
  record.coordinator.push({ actor: 'coordinator', operation, sha, recorded_at: new Date().toISOString() });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return [true, [`${path}: coordinator ${operation} ${sha}`]];
}

// ---- One input boundary: every flag is checked here and nothing downstream re-checks. ----

class InputError extends Error {}
const fail = (message) => { throw new InputError(message); };
const FLAGS = {
  run: ['provider', 'role', 'phase', 'run-id', 'round', 'attempt', 'worktree', 'expected-head', 'prompt', 'output', 'meta', 'record', 'report', 'timeout'],
  attribute: ['record', 'operation', 'sha'],
};
const positive = (value, flag) => (/^[1-9]\d*$/.test(value) ? Number(value) : fail(`--${flag} must be a positive integer`));
const absolute = (value, flag) => (isAbsolute(value) ? value : fail(`--${flag} must be an absolute path`));
// Checked before the phase is spent, because a destination that fails only at the final write loses the whole record.
const destination = (value, flag) => { const path = absolute(value, flag);
  const exists = existsSync(path);
  if (exists && statSync(path).isDirectory()) fail(`--${flag} must name a file, not a directory`);
  try { accessSync(exists ? path : dirname(path), constants.W_OK); } catch { fail(`--${flag} must name a writable file in an existing directory`); }
  return value; };

function readInput(argv) {
  const [command, ...args] = argv;
  if (!Object.hasOwn(FLAGS, command ?? '')) fail('unknown or missing command');
  const given = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = String(args[index]).replace(/^--/, '');
    const allowed = [...FLAGS[command], ...(command === 'run' ? ['model', 'effort', 'profile', 'push'] : [])];
    if (!args[index].startsWith('--') || !allowed.includes(flag) || Object.hasOwn(given, flag) || index + 1 >= args.length) {
      fail(`${command} does not accept ${args[index]} here`);
    }
    given[flag] = args[index + 1];
  }
  for (const flag of FLAGS[command]) if (!Object.hasOwn(given, flag)) fail(`${command} requires --${flag}`);
  if (command === 'attribute') {
    if (!['commit', 'push'].includes(given.operation)) fail('--operation must be commit or push');
    if (!/^[0-9a-f]{40}$/.test(given.sha)) fail('--sha must be a full 40-character commit SHA');
    return { command, record: absolute(given.record, 'record'), operation: given.operation, sha: given.sha };
  }
  if (!Object.hasOwn(ROUTES, given.provider)) fail(`unknown provider "${given.provider}": use codex or claude`);
  if (!Object.hasOwn(PHASES, given.role)) fail('--role must be reviewer or writer');
  if (!PHASES[given.role].includes(given.phase)) fail(`--phase for a ${given.role} must be ${PHASES[given.role].join(', ')}`);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(given['run-id'])) fail('--run-id must be 1-64 letters, digits, dots, dashes or underscores');
  if (!/^[0-9a-f]{40}$/.test(given['expected-head'])) fail('--expected-head must be a full 40-character commit SHA');
  if (!existsSync(absolute(given.worktree, 'worktree')) || !statSync(given.worktree).isDirectory()) fail('--worktree must be an existing directory');
  if (!existsSync(absolute(given.prompt, 'prompt')) || !statSync(given.prompt).isFile()) fail('--prompt must be an existing file');
  if (given.model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/.test(given.model)) fail('--model must be one installed CLI model identifier');
  if (given.effort !== undefined && !/^[a-z][a-z0-9-]{0,31}$/.test(given.effort)) fail('--effort must be one installed CLI effort value');
  if (given.profile !== undefined && (given.provider !== 'codex' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(given.profile))) fail('--profile names one existing Codex configuration profile');
  if (Object.hasOwn(given, 'push') && (given.role !== 'writer' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(given.push))) fail('--push names one remote a writer phase is authorized to push to');
  return { command, provider: given.provider, role: given.role, phase: given.phase, runId: given['run-id'],
    round: positive(given.round, 'round'), attempt: positive(given.attempt, 'attempt'), timeout: positive(given.timeout, 'timeout'),
    worktree: given.worktree, expectedHead: given['expected-head'], prompt: given.prompt, push: given.push,
    output: destination(given.output, 'output'), meta: destination(given.meta, 'meta'), record: destination(given.record, 'record'),
    report: destination(given.report, 'report'),
    model: given.model, effort: given.effort, profile: given.profile };
}

const redact = (text, secrets) => secrets.reduce((value, secret) => value.split(secret).join('<redacted>'), text);

async function main(argv) {
  let request;
  try {
    request = readInput(argv);
    if (request.command === 'attribute') {
      const [ok, lines] = await attribute(request);
      for (const line of lines) (ok ? console.log : console.error)(line);
      return ok ? 0 : 1;
    }
    const { status, record, secrets, output } = await runPhase(request);
    if (output) {
      writeFileSync(request.output, redact(output.output, secrets));
      writeFileSync(request.meta, redact(output.meta, secrets));
      if (output.report !== undefined) writeFileSync(request.report, redact(output.report, secrets));
    }
    writeFileSync(request.record, redact(`${JSON.stringify(record, null, 2)}\n`, secrets));
    console.log(JSON.stringify({ status, record: request.record, blockers: redact(JSON.stringify(record.blockers), secrets) }));
    return status === 'completed' ? 0 : 1;
  } catch (error) {
    // A usage, read or write failure is a phase that did not run, never a pass.
    console.error(`launch-phase: ${error.message}`);
    if (error instanceof InputError) {
      console.error(`Usage: node launch-phase.mjs run ${FLAGS.run.map((flag) => `--${flag} VALUE`).join(' ')} [--model MODEL] [--effort LEVEL] [--profile CODEX_PROFILE] [--push REMOTE]`);
      console.error('       node launch-phase.mjs attribute --record PATH --operation commit|push --sha SHA');
    }
    return 2;
  }
}

// Only a direct run executes the CLI; an importing caller gets the module and nothing else.
const isDirectInvocation = () => { try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isDirectInvocation()) process.exitCode = await main(process.argv.slice(2));
