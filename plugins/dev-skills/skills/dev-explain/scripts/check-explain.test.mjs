// One test per case in the dev-explain closed case lists: target parsing (AC-1, including a discussion comment
// fragment) and the rest of argument resolution, append-only bodies and label limits (AC-2, AC-5.3, AC-5.5). Run with
// `node --test skills/dev-explain/scripts/check-explain.test.mjs` or `npm test` from the plugin root.
// Every input is a fixture; no GitHub call is made.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { branchCandidates, planAppend, resolveArgs, verifyAppend, vetLabels } from './check-explain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, 'check-explain.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'check-explain-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const REPO = 'example-org/example-repo';
const args = (text, over = {}) => resolveArgs({ repo: REPO, text, typeEnv: '', langEnv: '', candidates: [], ...over });
const proceed = (text, over) => {
  const result = args(text, over);
  assert.equal(result.action, 'proceed', JSON.stringify(result));
  return result;
};
const file = (name, text) => {
  const path = join(scratch, name);
  writeFileSync(path, text);
  return path;
};
const response = (name, body) => file(name, JSON.stringify({ number: 1, body }));
const cli = (...argv) => spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });

// AC-1 — target parsing

const BASE = `https://github.com/${REPO}`;

test('AC-1.1 a #N or N token is the target with kind any, and context is ignored', () => {
  for (const [token, number] of [['#870', 870], ['870', 870], ['#971', 971], ['971', 971]]) {
    const result = proceed(token, { candidates: [1, 2] });
    assert.deepEqual([result.target, result.warnings], [{ number, kind: 'any', source: 'argument' }, []]);
  }
});

test('AC-1.2 an issues, pull or discussions URL of this repository is the target with its kind', () => {
  for (const [token, number, kind] of [[`${BASE}/issues/871`, 871, 'issue-or-pr'], [`${BASE}/pull/888`, 888, 'issue-or-pr'],
    [`${BASE}/discussions/971`, 971, 'discussion'], ['https://github.com/Example-Org/Example-Repo/discussions/5', 5, 'discussion']]) {
    const result = proceed(token, { candidates: [1] });
    assert.deepEqual([result.target, result.warnings], [{ number, kind, source: 'argument' }, []]);
  }
});

test('AC-1.3 a URL fragment is ignored with one warning that quotes it', () => {
  for (const [path, number, kind, fragment] of [['issues/870', 870, 'issue-or-pr', '#issuecomment-1'],
    ['pull/888', 888, 'issue-or-pr', '#discussion_r1']]) {
    const result = proceed(`${BASE}/${path}${fragment} type=ALL`);
    assert.deepEqual([result.target, result.warnings],
      [{ number, kind, source: 'argument' }, [`ignored the URL fragment "${fragment}"`]]);
  }
});

test('AC-1.4 one context candidate is the target with kind any; a number and its URL are two targets', () => {
  assert.deepEqual(proceed('type=ALL', { candidates: [971] }).target, { number: 971, kind: 'any', source: 'context' });
  const both = args(`971 ${BASE}/discussions/971`);
  assert.deepEqual([both.reason, both.candidates], ['ambiguous-target', [971, 971]]);
});

test('AC-1.5 every other reference-like token stops and never becomes notes', () => {
  for (const token of ['https://github.com/other/repo/discussions/1', 'https://github.com/other/repo/issues/1',
    `http://github.com/${REPO}/discussions/1`, `github.com/${REPO}/discussions/1`, `${REPO}#870`, `${REPO}/issues/870`,
    `${BASE}/pull/888/files`, `${BASE}/issues/870/`, `${BASE}/issues/870?x=1`, `${BASE}/discussions/0`,
    `${BASE}/issues/99999999999999999999`, `${BASE}/wiki/1`, '#0', '0', '007', '#abc', '#99999999999999999999']) {
    const result = args(`${token} type=OD`, { candidates: [893] });
    assert.equal(result.reason, 'bad-target', token);
    assert.match(result.detail, /^"/);
  }
});

// AC-1 — a discussion URL's comment fragment

test('AC-1.6 a discussions URL with #discussioncomment-ID names that comment, without a warning', () => {
  for (const [path, number, comment] of [['discussions/971', 971, 1001], ['discussions/972', 972, 1002],
    ['discussions/972', 972, 1003]]) {
    const result = proceed(`${BASE}/${path}#discussioncomment-${comment} type=ALL`);
    assert.deepEqual([result.target, result.warnings], [{ number, kind: 'discussion', source: 'argument', comment }, []]);
  }
});

test('AC-1.7 a malformed #discussioncomment- fragment on a discussions URL stops with exit 1 and never becomes notes', () => {
  for (const fragment of ['0', '007', 'abc', '', '12x', '99999999999999999999']) {
    const text = `${BASE}/discussions/971#discussioncomment-${fragment} type=OD`;
    const run = cli('args', '--input', file('input.json', JSON.stringify({ repo: REPO, text, typeEnv: '', langEnv: '', candidates: [893] })));
    assert.equal(run.status, 1, fragment);
    assert.equal(JSON.parse(run.stdout).reason, 'bad-target', fragment);
  }
});

test('AC-1.8 any other fragment is ignored with one warning that quotes it and names no comment', () => {
  for (const [path, number, kind, fragment] of [['discussions/971', 971, 'discussion', '#top'],
    ['issues/870', 870, 'issue-or-pr', '#issuecomment-1'], ['pull/888', 888, 'issue-or-pr', '#discussion_r1'],
    ['issues/870', 870, 'issue-or-pr', '#discussioncomment-5']]) {
    const result = proceed(`${BASE}/${path}${fragment}`);
    assert.deepEqual([result.target, result.warnings],
      [{ number, kind, source: 'argument' }, [`ignored the URL fragment "${fragment}"`]]);
  }
});

test('AC-1.9 a number, a discussions URL without a fragment or a context candidate names no comment', () => {
  for (const [text, candidates] of [['#972', []], ['972', []], [`${BASE}/discussions/972`, []], ['type=ALL', [972]]]) {
    assert.equal(Object.hasOwn(proceed(text, { candidates }).target, 'comment'), false, text);
  }
});

// AC-2 — the rest of argument resolution

test('AC-2.2 with no target token, exactly one distinct context candidate is the target', () => {
  assert.deepEqual(proceed('', { candidates: [893] }).target, { number: 893, kind: 'any', source: 'context' });
  assert.deepEqual(proceed('type=SD', { candidates: [893, 893] }).target, { number: 893, kind: 'any', source: 'context' });
});

test('AC-2.3 with no target token and no candidate the run stops', () => {
  assert.deepEqual(args('lang=en'), { action: 'stop', reason: 'no-target', detail: 'no issue, PR or discussion identified' });
});

test('AC-2.4 two context candidates or two target tokens stop and list them', () => {
  const fromContext = args('', { candidates: [870, 888] });
  assert.equal(fromContext.reason, 'ambiguous-target');
  assert.deepEqual(fromContext.candidates, [870, 888]);
  const fromTokens = args('870 type=SD #870', { candidates: [1] });
  assert.equal(fromTokens.reason, 'ambiguous-target');
  assert.deepEqual(fromTokens.candidates, [870, 870]);
});

test('AC-2.6 type=OD, SD or ALL in any letter case is accepted and upper-cased', () => {
  for (const [given, value] of [['od', 'OD'], ['Sd', 'SD'], ['ALL', 'ALL'], ['all', 'ALL']]) {
    const result = proceed(`893 type=${given}`, { typeEnv: 'SD' });
    assert.deepEqual(result.type, { value, source: 'argument' });
    assert.deepEqual(result.warnings, []);
  }
});

test('AC-2.7 an absent type comes from DEV_EXPLAIN_TYPE, else OD, warning only on an invalid variable', () => {
  assert.deepEqual(proceed('893', { typeEnv: 'all' }).type, { value: 'ALL', source: 'environment' });
  const unset = proceed('893');
  assert.deepEqual([unset.type, unset.warnings], [{ value: 'OD', source: 'default' }, []]);
  const invalid = proceed('893', { typeEnv: 'XYZ' });
  assert.deepEqual(invalid.type, { value: 'OD', source: 'default' });
  assert.deepEqual(invalid.warnings, ['DEV_EXPLAIN_TYPE="XYZ" is not OD, SD or ALL; using OD (default)']);
});

test('AC-2.8 an invalid, empty or repeated type falls back as AC-2.7 would, with a warning naming it', () => {
  const unknown = proceed('893 type=XYZ');
  assert.deepEqual([unknown.type, unknown.warnings], [{ value: 'OD', source: 'default' },
    ['type="XYZ" is not OD, SD or ALL; using OD (default)']]);
  assert.deepEqual(proceed('893 type=', { typeEnv: 'SD' }).type, { value: 'SD', source: 'environment' });
  assert.deepEqual(proceed('893 type=', { typeEnv: 'SD' }).warnings, ['type="" is not OD, SD or ALL; using SD from DEV_EXPLAIN_TYPE']);
  const repeated = proceed('893 type=OD type=SD');
  assert.deepEqual(repeated.type, { value: 'OD', source: 'default' });
  assert.deepEqual(repeated.warnings, ['type= was given 2 times ("OD", "SD"); using OD (default)']);
  const both = proceed('893 type=XYZ', { typeEnv: 'bad' });
  assert.deepEqual(both.warnings, ['type="XYZ" is not OD, SD or ALL; using OD (default)',
    'DEV_EXPLAIN_TYPE="bad" is not OD, SD or ALL; using OD (default)']);
});

test('AC-2.9 a known BCP 47 language tag is accepted in canonical form', () => {
  for (const [given, value] of [['en-au', 'en-AU'], ['zh', 'zh'], ['zh-cn', 'zh-CN'], ['EN', 'en'], ['zh-Hans-CN', 'zh-Hans-CN']]) {
    const result = proceed(`893 lang=${given}`);
    assert.deepEqual(result.lang, { value, source: 'argument' });
    assert.deepEqual(result.warnings, []);
  }
});

test('AC-2.10 an absent language comes from DEV_EXPLAIN_LANG, else en, warning only on an invalid variable', () => {
  assert.deepEqual(proceed('893', { langEnv: 'en-us' }).lang, { value: 'en-US', source: 'environment' });
  const unset = proceed('893');
  assert.deepEqual([unset.lang, unset.warnings], [{ value: 'en', source: 'default' }, []]);
  const invalid = proceed('893', { langEnv: 'en_US' });
  assert.deepEqual(invalid.lang, { value: 'en', source: 'default' });
  assert.deepEqual(invalid.warnings,
    ['DEV_EXPLAIN_LANG="en_US" is not a well-formed BCP 47 tag (did you mean "en-US"?); using en (default)']);
});

test('AC-2.11 an ill-formed, unknown, empty or repeated language falls back as AC-2.10 would, with a warning', () => {
  for (const [given, why] of [['en_US', 'is not a well-formed BCP 47 tag (did you mean "en-US"?)'],
    ['en_', 'is not a well-formed BCP 47 tag'], ['xx', 'names no known language'],
    ['klingon', 'names no known language'], ['und', 'names no known language'], ['', 'is not a well-formed BCP 47 tag']]) {
    const result = proceed(`893 lang=${given}`);
    assert.deepEqual(result.lang, { value: 'en', source: 'default' }, given);
    assert.deepEqual(result.warnings, [`lang="${given}" ${why}; using en (default)`]);
  }
  assert.deepEqual(proceed('893 lang=xx', { langEnv: 'en' }).lang, { value: 'en', source: 'environment' });
  const repeated = proceed('893 lang=en lang=zh');
  assert.deepEqual(repeated.lang, { value: 'en', source: 'default' });
  assert.deepEqual(repeated.warnings, ['lang= was given 2 times ("en", "zh"); using en (default)']);
  const both = proceed('893 lang=xx', { langEnv: 'en_US' });
  assert.deepEqual(both.lang, { value: 'en', source: 'default' });
  assert.deepEqual(both.warnings, ['lang="xx" names no known language; using en (default)',
    'DEV_EXPLAIN_LANG="en_US" is not a well-formed BCP 47 tag (did you mean "en-US"?); using en (default)']);
});

test('AC-2.12 the first other token starts the notes, kept verbatim to the end', () => {
  const text = 'type=SD 870 lang=en  Why A  over B?\nAlso: type=ALL lang=fr 888 \n';
  const result = proceed(text);
  assert.equal(result.notes, 'Why A  over B?\nAlso: type=ALL lang=fr 888');
  assert.deepEqual([result.target.number, result.type.value, result.lang.value], [870, 'SD', 'en']);
  assert.equal(proceed('870 type=ALL').notes, '');
  assert.equal(proceed('Explain O-2 870', { candidates: [893] }).target.number, 893);
});

// AC-5.3 — append-only body updates

test('AC-5.3 a planned body keeps the current body as a byte prefix and a read-back must too', () => {
  for (const [before, expected] of [['Body', 'Body\n\nAdded.'], ['Body\n', 'Body\n\nAdded.'],
    ['Body\n\n', 'Body\n\nAdded.'], ['Body\r\n', 'Body\r\n\nAdded.'], ['', 'Added.']]) {
    const plan = planAppend({ before, addition: 'Added.' });
    assert.deepEqual(plan, { action: 'append', body: expected });
    assert.ok(plan.body.startsWith(before));
  }
  assert.equal(planAppend({ before: 'Body', addition: 'Note <!-- hidden -->' }).reason, 'html-comment');
  assert.equal(planAppend({ before: 'Body', addition: ' \n ' }).reason, 'empty-addition');
  assert.equal(planAppend({ before: 'A\n<!-- AUTO:BEGIN x -->\nB', addition: 'Added.' }).reason, 'open-region');
  assert.equal(planAppend({ before: '<!-- AUTO:BEGIN x -->\nB\n<!-- AUTO:END -->', addition: 'Added.' }).action, 'append');
  assert.deepEqual(verifyAppend({ before: 'Body', planned: 'Body\n\nAdded.', after: 'Body\n\nAdded.\n\nSomeone else.' }),
    { action: 'proceed' });
  assert.equal(verifyAppend({ before: 'Body', planned: 'Body\n\nAdded.', after: 'Body' }).reason, 'addition-missing');
  assert.equal(verifyAppend({ before: 'Body', planned: 'Body\n\nAdded.', after: 'Edited body\n\nAdded.' }).reason,
    'prefix-changed');

  const out = file('planned.md', 'stale plan');
  const refused = cli('append', '--before', response('before.json', 'Body'), '--addition', file('add.md', '<!-- x -->'), '--out', out);
  assert.equal(refused.status, 1);
  assert.equal(existsSync(out), false);
  const planned = cli('append', '--before', response('before.json', 'Body'), '--addition', file('add.md', 'Added.'), '--out', out);
  assert.equal(planned.status, 0);
  assert.equal(readFileSync(out, 'utf8'), 'Body\n\nAdded.');
  const emptyBodyOut = file('empty-body-plan.md', 'stale plan');
  assert.equal(cli('append', '--before', response('null.json', null), '--addition', file('add.md', 'Added.'),
    '--out', emptyBodyOut).status, 0);
  assert.equal(readFileSync(emptyBodyOut, 'utf8'), 'Added.');
  assert.equal(cli('verify', '--before', response('b.json', 'Body'), '--planned', out,
    '--after', response('a.json', 'Body')).status, 1);
  assert.equal(cli('verify', '--before', response('b.json', 'Body'), '--planned', out,
    '--after', response('a.json', 'Body\n\nAdded.')).status, 0);
});

// A failed or unreadable read must stop before planning: as an empty prefix, the "append" would replace the whole body.
test('AC-5.3 an unread, failed or malformed body response stops append and verify before any plan', () => {
  const out = file('planned.md', 'stale plan');
  for (const [name, text] of [['error.json', '{"message":"Server Error","status":"502"}'], ['empty.json', ''],
    ['null.json', 'null'], ['list.json', '[]'], ['number.json', '{"body":1}'], ['raw.md', 'Body']]) {
    const appended = cli('append', '--before', file(name, text), '--addition', file('add.md', 'Added.'), '--out', out);
    assert.equal(appended.status, 2, name);
    assert.equal(existsSync(out), false, name);
    assert.equal(cli('verify', '--before', file(name, text), '--planned', file('plan.md', 'Added.'),
      '--after', response('a.json', 'Added.')).status, 2, name);
    assert.equal(cli('verify', '--before', response('b.json', ''), '--planned', file('plan.md', 'Added.'),
      '--after', file(name, text)).status, 2, name);
  }
  assert.equal(cli('verify', '--before', response('b.json', 'Body'), '--planned', file('empty-plan.md', ''),
    '--after', response('a.json', 'Body')).status, 2);
  assert.equal(cli('verify', '--before', response('b.json', 'Body'), '--planned', file('bad-plan.md', 'Replacement'),
    '--after', response('a.json', 'Replacement')).status, 2);
});

// AC-5.5 — label limits

test('AC-5.5 protected workflow and decision transitions and unknown labels are refused; the rest apply', () => {
  const live = ['ai:ready', 'ai:implementing', 'ai:blocked', 'decision:confirmed', 'decision:needed', 'area:skills',
    'area:tools', 'type:feature'];
  const result = vetLabels({
    live,
    current: ['ai:blocked', 'decision:needed', 'type:feature', 'area:tools'],
    // area:tools is already present, so adding it is a no-op: neither applied nor refused.
    add: ['AI:Ready', 'ai:implementing', 'decision:confirmed', 'Area:Skills', 'area:tools', 'no:such-label', 'area:docs'],
    remove: ['ai:blocked', 'decision:needed', 'type:feature', 'area:docs'],
  });
  assert.deepEqual(result.apply, {
    add: ['area:skills'],
    remove: [{ name: 'type:feature', encodedPathSegment: 'type%3Afeature' }],
  });
  assert.deepEqual(result.refused.map(({ label, change }) => `${change} ${label}`), [
    'add AI:Ready', 'add ai:implementing', 'add decision:confirmed', 'add no:such-label', 'add area:docs',
    'remove ai:blocked', 'remove decision:needed', 'remove area:docs',
  ]);
  assert.match(result.refused[0].reason, /protected workflow or decision transition/);
  assert.equal(result.refused[3].reason, 'not in the repository label list');
  assert.equal(result.refused[4].reason, 'both added and removed');
});

test('readiness labels and caller-declared transition labels are refused in both directions', () => {
  const live = ['ready', 'blocked', 'Status: Approved', 'area:skills'];
  const result = vetLabels({ live, current: ['blocked', 'Status: Approved'], add: ['Ready', 'area:skills'],
    remove: ['BLOCKED', 'status: approved'], protected: ['Status: Approved'] });
  assert.deepEqual(result.apply, { add: ['area:skills'], remove: [] });
  assert.deepEqual(result.refused.map(({ label, change }) => `${change} ${label}`),
    ['add Ready', 'remove BLOCKED', 'remove status: approved']);
  for (const entry of result.refused) assert.match(entry.reason, /protected workflow or decision transition/);
  const reverse = vetLabels({ live, current: ['ready'], add: ['blocked'], remove: ['ready'] });
  assert.deepEqual(reverse.apply, { add: [], remove: [] });
  assert.equal(reverse.refused.length, 2);
});

test('label removals emit the live name and its URI-encoded path segment', () => {
  const result = vetLabels({
    live: ['needs triage', 'bug/#?%', "owner's choice"],
    current: ['needs triage', 'bug/#?%', "owner's choice"],
    add: [],
    remove: ['Needs Triage', 'bug/#?%', "owner's choice"],
  });
  assert.deepEqual(result, {
    apply: {
      add: [],
      remove: [
        { name: 'needs triage', encodedPathSegment: 'needs%20triage' },
        { name: 'bug/#?%', encodedPathSegment: 'bug%2F%23%3F%25' },
        { name: "owner's choice", encodedPathSegment: 'owner%27s%20choice' },
      ],
    },
    refused: [],
  });
});

// CLI contract — exit 0 proceeds, 1 stops or refuses, 2 did not run

test('the CLI exits 0, 1 or 2 and never treats a malformed input as a pass', () => {
  const input = (value) => file('input.json', JSON.stringify(value));
  const ok = cli('args', '--input', input({ repo: REPO, text: '893 lang=en', typeEnv: '', langEnv: '', candidates: [] }));
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).lang.value, 'en');
  assert.equal(cli('args', '--input', input({ repo: REPO, text: '', typeEnv: '', langEnv: '', candidates: [] })).status, 1);
  assert.equal(cli('labels', '--input', input({ live: ['a'], current: [], add: ['ai:ready'], remove: [] })).status, 1);
  assert.equal(cli('labels', '--input', input({ live: ['a'], current: [], add: ['a'], remove: [] })).status, 0);
  assert.equal(cli('labels', '--input', input({ live: ['a', 'b'], current: [], add: ['b'], remove: [], protected: ['b'] })).status, 1);
  assert.equal(cli('labels', '--input', input({ live: ['a'], current: [], add: ['a'], remove: [], protected: 'a' })).status, 2);
  assert.equal(cli('args', '--input', input({ repo: REPO, text: '' })).status, 2);
  assert.equal(cli('args', '--input', input({ repo: REPO, text: '', typeEnv: '', langEnv: '', candidates: [], extra: 1 })).status, 2);
  assert.equal(cli('args', '--input', file('bad.json', '{')).status, 2);
  assert.equal(cli('nope').status, 2);
  assert.equal(cli('verify', '--before', 'x').status, 2);
});

// F025: the branch's PR is the one whose head is the repository and branch it publishes to.
const pull = (number, owner, name, headRefName) => ({ number, headRefName, headRepository: { name }, headRepositoryOwner: { login: owner } });
const PULLS = [pull(1, 'example-org', 'example-repo', 'develop'), pull(2, 'example-org', 'example-repo', 'topic'),
  pull(3, 'someone', 'example-repo', 'topic'), pull(4, 'another', 'example-repo', 'topic')];

test('the current branch selects the PR from its published head, never its pull upstream or a same-name fork', () => {
  const mapped = (remote) => ({ branch: 'topic', remote, fetch: `+refs/heads/*:refs/remotes/${remote}/*`, pushSpecs: '' });
  const origin = { ...mapped('origin'), remoteUrl: 'https://github.com/example-org/example-repo.git', pulls: PULLS };
  assert.deepEqual(branchCandidates({ ...origin, push: 'refs/remotes/origin/topic' }), [2]);
  assert.deepEqual(branchCandidates({ ...mapped('fork'), remoteUrl: 'git@github.com:Someone/example-repo.git', pulls: PULLS,
    push: 'refs/remotes/fork/topic' }), [3]);
  assert.deepEqual(branchCandidates({ ...mapped('fork'), remoteUrl: 'ssh://git@github.com/someone/example-repo', pulls: PULLS,
    push: 'refs/remotes/fork/topic' }), [3]);
  const topic = { push: 'refs/remotes/origin/topic' };
  for (const uncertain of [{ push: '' }, { push: 'refs/remotes/origin/' }, { push: 'refs/remotes/fork/topic' },
    { ...topic, remoteUrl: 'https://gitlab.example.com/example-org/example-repo.git' }, { ...topic, remote: '' },
    { ...topic, branch: '' }, { push: 'refs/remotes/origin/topic\nrefs/remotes/origin/topic' },
    { ...topic, fetch: '+refs/heads/main:refs/remotes/origin/topic' }, { ...topic, fetch: '' },
    { ...topic, fetch: '+refs/heads/*:refs/remotes/origin/*\n+refs/heads/x:refs/remotes/origin/topic' },
    { ...topic, pushSpecs: 'refs/heads/topic:refs/heads/main' }]) {
    assert.deepEqual(branchCandidates({ ...origin, ...uncertain }), [], JSON.stringify(uncertain));
  }
});

test('the documented git commands and the helper pick the topic PR when the branch pulls from an integration branch', () => {
  const repo = join(scratch, 'branch-repo');
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).stdout.trim();
  spawnSync('git', ['init', '-q', repo]);
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'x');
  git('remote', 'add', 'origin', 'https://github.com/example-org/example-repo.git');
  git('update-ref', 'refs/remotes/origin/develop', 'HEAD');
  git('checkout', '-q', '-b', 'topic');
  git('branch', '-q', '--set-upstream-to=origin/develop');
  // The documented lookup, step by step: a detached HEAD stops before any ref is read.
  const input = () => {
    const branch = git('branch', '--show-current');
    if (!branch) return null;
    const remote = git('for-each-ref', '--format=%(push:remotename)', `refs/heads/${branch}`);
    return { branch, push: git('for-each-ref', '--format=%(push)', `refs/heads/${branch}`), remote,
      fetch: remote ? git('config', '--get-all', `remote.${remote}.fetch`) : '', pushSpecs: remote ? git('config', '--get-all', `remote.${remote}.push`) : '',
      remoteUrl: remote ? git('remote', 'get-url', '--push', remote) : '', pulls: PULLS };
  };
  assert.deepEqual(branchCandidates(input()), [], 'a simple push to a differently named upstream has no published head');
  git('config', 'push.default', 'current');
  assert.deepEqual(branchCandidates(input()), [2]);
  const run = cli('branch', '--input', file('branch.json', JSON.stringify(input())));
  assert.deepEqual([run.status, JSON.parse(run.stdout)], [0, [2]]);
  // F025 round 3: a fetch mapping that renames the tracking ref, so `%(push)` no longer names the remote branch.
  git('config', 'push.default', 'upstream');
  git('config', '--replace-all', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/develop');
  git('config', 'branch.topic.merge', 'refs/heads/main');
  assert.equal(git('for-each-ref', '--format=%(push)', 'refs/heads/topic'), 'refs/remotes/origin/develop');
  assert.deepEqual(branchCandidates(input()), [], 'a renamed tracking ref never selects the integration PR');
  git('config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  git('config', 'remote.origin.push', 'refs/heads/topic:refs/heads/main');
  assert.deepEqual(branchCandidates(input()), [], 'a push refspec is not resolved');
  // A detached HEAD in a checkout whose only branch has a PR selects nothing.
  git('config', '--unset', 'remote.origin.push');
  git('config', 'push.default', 'current');
  git('checkout', '-q', '--detach');
  assert.equal(input(), null);
  assert.deepEqual(branchCandidates({ branch: '', push: 'refs/remotes/origin/topic', remote: 'origin', fetch: '+refs/heads/*:refs/remotes/origin/*',
    pushSpecs: '', remoteUrl: 'https://github.com/example-org/example-repo.git', pulls: PULLS }), []);
});
