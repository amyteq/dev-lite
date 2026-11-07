// One test per case in the dev-refine-issue closed case list. Run with
// `node --test skills/dev-refine-issue/scripts/check-refinement.test.mjs`
// or `npm test` from the plugin root. Every input is a fixture; no GitHub call is made.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkOutgoingMarker, compareAcBlocks, findAutoRegions, planBodyAmendment, selectTask,
  verifyPublishedBody,
} from './check-refinement.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, 'check-refinement.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'check-refinement-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const REPO = 'example-org/example-repo';
const ISSUE = 780;
const LOGIN = 'coordinator';
const URL = (id, repo = REPO, issue = ISSUE) => `https://github.com/${repo}/issues/${issue}#issuecomment-${id}`;
const marker = (revision, repo = REPO, issue = ISSUE) =>
  `<!-- dev-refine-issue:task repo=${repo} issue=${issue} revision=${revision} -->`;

const HUMAN = '## Request\n\nKeep every byte of this.\n';
const region = (text = 'Generated.', owner = 'dev-refine-issue') =>
  `<!-- AUTO:BEGIN -->\n<!-- ${owner}:body -->\n${text}\n<!-- AUTO:END -->\n`;
const EXECUTION = '## Execution\n\n';
const pointer = (...ids) => `${EXECUTION}**Current task:** ${ids.map((id) => `[task](${URL(id)})`).join(' ')}.`;
const refined = (execution) => `${HUMAN}\n${region(execution)}`;
const comment = (id, body, author = LOGIN) => ({ id, author, body });
const task = (id, revision = 1, author = LOGIN) => comment(id, `${marker(revision)}\n## Task\n`, author);
const selection = (over = {}) => ({
  repo: REPO, issue: ISSUE, login: LOGIN, scanComplete: true, issueBody: HUMAN, comments: [], ...over,
});

function file(name, text) {
  const path = join(scratch, name);
  writeFileSync(path, text);
  return path;
}
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
const plan = (live, prepared = region('New.'), snapshot = live) =>
  planBodyAmendment({ snapshot, live, region: prepared });

// AC1 — body amendment

test('case 1: a first run appends exactly one region and keeps the original body as a byte prefix', () => {
  const result = plan(HUMAN);
  assert.equal(result.action, 'append');
  assert.ok(result.body.startsWith(HUMAN));
  assert.equal(result.body, `${HUMAN}\n${region('New.')}`);
  assert.equal(findAutoRegions(result.body).regions.length, 1);

  const crlf = 'Line one\r\nLine two\r\n';
  assert.equal(plan(crlf).body, `${crlf}\r\n${region('New.')}`);
  assert.equal(plan('').body, region('New.'));
});

test('case 1: the plan command writes the appended body and exits 0', () => {
  const live = file('case1-live.md', HUMAN);
  const out = join(scratch, 'case1-out.md');
  const result = run('plan', '--snapshot', live, '--live', live, '--region', file('case1-region.md', region('New.')), '--out', out);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(out, 'utf8'), `${HUMAN}\n${region('New.')}`);
});

test('case 2: a repeat run replaces only its own region and every byte outside it is unchanged', () => {
  const before = `${HUMAN}\n`;
  const afterText = '\nA human note written after the region.\r\n';
  const live = `${before}${region('Old.')}${afterText}`;
  const result = plan(live);
  assert.equal(result.action, 'replace');
  assert.equal(result.body, `${before}${region('New.')}${afterText}`);
  assert.equal(result.body.includes('Old.'), false);
});

test('case 3: a malformed region stops', () => {
  const shapes = {
    'unclosed-begin': `${HUMAN}\n<!-- AUTO:BEGIN -->\n<!-- dev-refine-issue:body -->\n`,
    'unopened-end': `${HUMAN}\n<!-- AUTO:END -->\n`,
    'nested-begin': `${HUMAN}\n<!-- AUTO:BEGIN -->\n${region()}`,
  };
  for (const [kind, live] of Object.entries(shapes)) {
    const result = plan(live);
    assert.equal(result.action, 'stop', kind);
    assert.equal(result.reason, 'malformed-regions', kind);
    assert.match(result.detail, new RegExp(kind));
  }
});

test('case 3: a duplicated region stops', () => {
  const result = plan(`${HUMAN}\n${region('One.')}\n${region('Two.')}`);
  assert.deepEqual([result.action, result.reason], ['stop', 'multiple-regions']);
});

test('case 3: a foreign region stops', () => {
  for (const live of [`${HUMAN}\n${region('Theirs.', 'other-tool')}`, `${HUMAN}\n<!-- AUTO:BEGIN -->\nNo owner.\n<!-- AUTO:END -->\n`]) {
    const result = plan(live);
    assert.deepEqual([result.action, result.reason], ['stop', 'foreign-region']);
  }
});

test('case 3: a region hidden inside a code fence stops', () => {
  for (const live of [
    `${HUMAN}\n\`\`\`markdown\n${region()}\`\`\`\n`,
    `${HUMAN}\n- item\n\n  \`\`\`\n${region().replace(/^/gm, '  ')}\`\`\`\n`,
    `${HUMAN}\n\`\`\`\n${region()}`,
    `${HUMAN}\n    <!-- AUTO:BEGIN -->\n`,
  ]) {
    const result = plan(live);
    assert.deepEqual([result.action, result.reason], ['stop', 'malformed-regions']);
    assert.match(result.detail, /hidden/);
  }
});

test('case 3: a region hidden inside an HTML comment stops', () => {
  const result = plan(`${HUMAN}\n<!-- an old draft\n${region()}-->\n`);
  assert.deepEqual([result.action, result.reason], ['stop', 'malformed-regions']);
  assert.match(result.detail, /hidden-marker at line 6/);
});

test('case 3: a prepared region that is not exactly one own region stops', () => {
  for (const prepared of ['No region.\n', region('A', 'other-tool'), `${region('A')}${region('B')}`, `Lead.\n${region('A')}`]) {
    const result = plan(HUMAN, prepared);
    assert.deepEqual([result.action, result.reason], ['stop', 'invalid-region']);
  }
});

test('case 4: a pre-write snapshot that differs from the live body stops', () => {
  const result = plan(`${HUMAN}A concurrent edit.\n`, region('New.'), HUMAN);
  assert.deepEqual([result.action, result.reason], ['stop', 'concurrent-edit']);
});

test('case 4: the plan command exits 1 on a stop and leaves no body at --out', () => {
  const out = file('case4-out.md', 'A stale plan from an earlier run.\n');
  const result = run('plan', '--snapshot', file('case4-snapshot.md', HUMAN),
    '--live', file('case4-live.md', `${HUMAN}Edited.\n`), '--region', file('case4-region.md', region()), '--out', out);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /concurrent-edit/);
  assert.equal(existsSync(out), false);
});

test('case 5: a readback that lost human-owned bytes exits 1', () => {
  const first = file('case5-first.md', HUMAN);
  const repeat = file('case5-repeat.md', `${HUMAN}\n${region('Old.')}Tail.\n`);
  const losses = [
    [first, `## Request\n\nKeep this.\n\n${region()}`],
    [repeat, `${HUMAN}\n${region('New.')}`],
    [repeat, `## Changed\n\n${region('New.')}Tail.\n`],
    [first, HUMAN],
  ];
  for (const [before, published] of losses) {
    const result = run('preserve', '--before', before, '--after', file('case5-after.md', published));
    assert.equal(result.status, 1, published);
  }
  assert.equal(run('preserve', '--before', first, '--after', file('case5-clean.md', `${HUMAN}\n${region()}`)).status, 0);
  assert.deepEqual(verifyPublishedBody({ before: `${HUMAN}\n${region('Old.')}Tail.\n`, after: `${HUMAN}\n${region('New.')}Tail.\n` }), []);
});

test('case 5: a readback that dropped or added human-owned bytes at a region boundary exits 1', () => {
  const changed = ['human-owned bytes outside the generated region changed'];
  const crlf = (text) => text.replace(/\n/g, '\r\n');
  // Suffixes the generated region itself ends with, so an unanchored comparison cannot tell a loss from its own tail.
  for (const [name, suffix] of Object.entries({ 'blank line': '\n', 'comment end': '-->\n', 'quote marker': '>\n' })) {
    const before = `${HUMAN}\n${region('Old.')}${suffix}`;
    assert.deepEqual(verifyPublishedBody({ before, after: `${HUMAN}\n${region('New.')}` }), changed, name);
    assert.deepEqual(verifyPublishedBody({ before, after: `${HUMAN}\n${region('New.')}${suffix}` }), [], name);
  }
  const crlfBody = crlf(`${HUMAN}\n${region('Old.')}\n`);
  assert.deepEqual(verifyPublishedBody({ before: crlfBody, after: crlf(`${HUMAN}\n${region('New.')}`) }), changed);
  assert.deepEqual(verifyPublishedBody({ before: crlfBody, after: crlf(`${HUMAN}\n${region('New.')}\n`) }), []);
  const kept = `${HUMAN}\n${region('Old.')}Tail.\n`;
  assert.deepEqual(verifyPublishedBody({ before: kept, after: `${HUMAN}\n\n${region('New.')}Tail.\n` }), changed);
  const dropped = run('preserve', '--before', file('case5-suffix-before.md', `${HUMAN}\n${region('Old.')}\n`),
    '--after', file('case5-suffix-after.md', `${HUMAN}\n${region('New.')}`));
  assert.equal(dropped.status, 1);
});

// AC2 — task selection

test('case 6: one matching pointer to our exact marker with no later own task gives use-current', () => {
  const comments = [task(10), comment(11, 'An ordinary note.'), task(12, 1, 'someone-else')];
  const decision = selectTask(selection({ issueBody: refined(pointer(10)), comments }));
  assert.deepEqual(decision, { action: 'use-current', commentId: 10, revision: 1, foreign: [12] });
  const revised = selectTask(selection({ issueBody: refined(pointer(20)), comments: [task(10), task(20, 2)] }));
  assert.deepEqual(revised, { action: 'use-current', commentId: 20, revision: 2, foreign: [] });
  const copied = selectTask(selection({ issueBody: `${pointer(99)}\n${refined(pointer(10))}`, comments }));
  assert.deepEqual(copied, { action: 'use-current', commentId: 10, revision: 1, foreign: [12] });
  const below = refined(`${EXECUTION}Ready for explicit human dispatch.\n\n**Current task:** [task](${URL(10)}).`);
  assert.deepEqual(selectTask(selection({ issueBody: below, comments })),
    { action: 'use-current', commentId: 10, revision: 1, foreign: [12] });
  const published = refined(`${pointer(10)}\n\nReady for explicit human dispatch.\n\n**Goal prompt**\n\n\`\`\`text\n# Goal\n\n## Execution\n\`\`\`\n\nThe receiving session verifies authority.`);
  assert.deepEqual(selectTask(selection({ issueBody: published, comments })),
    { action: 'use-current', commentId: 10, revision: 1, foreign: [12] });
});

test('case 7: no pointer, a complete scan and no own task comment gives publish-revision-1', () => {
  const decision = selectTask(selection({ comments: [comment(5, 'Hello.'), comment(6, 'Hello.\nMentions dev-refine-issue:task on a later line.')] }));
  assert.deepEqual(decision, { action: 'publish-revision-1', foreign: [] });
  const quoted = selectTask(selection({ issueBody: refined(`\`\`\`text\n${pointer(10)}\n\`\`\``) }));
  assert.deepEqual(quoted, { action: 'publish-revision-1', foreign: [] });
});

test('case 8: every other state returns one stop: ambiguous that lists the relevant comment IDs', () => {
  const states = {
    'incomplete scan': [selection({ scanComplete: false }), []],
    'incomplete scan with a matching pointer': [selection({ scanComplete: false, issueBody: refined(pointer(10)), comments: [task(10)] }), [10]],
    'own task without a pointer': [selection({ comments: [task(10)] }), [10]],
    'own malformed marker without a pointer': [selection({ comments: [comment(10, `${marker(0)}\n`)] }), [10]],
    'pointer to a missing comment': [selection({ issueBody: refined(pointer(10)) }), [10]],
    'pointer to another repository': [selection({ issueBody: refined(`${EXECUTION}**Current task:** [t](${URL(10, 'other/repo')})`), comments: [task(10)] }), [10]],
    'pointer to another issue': [selection({ issueBody: refined(`${EXECUTION}**Current task:** [t](${URL(10, REPO, 1)})`), comments: [task(10)] }), [10]],
    'pointer to a non-task comment': [selection({ issueBody: refined(pointer(10)), comments: [comment(10, 'Plain.')] }), [10]],
    'pointer to a marker for another issue': [selection({ issueBody: refined(pointer(10)), comments: [comment(10, `${marker(1, REPO, 1)}\n`)] }), [10]],
    'pointer to revision 0': [selection({ issueBody: refined(pointer(10)), comments: [comment(10, `${marker(0)}\n`)] }), [10]],
    'marker not on the first line': [selection({ issueBody: refined(pointer(10)), comments: [comment(10, `\n${marker(1)}\n`)] }), [10]],
    'later own task comment': [selection({ issueBody: refined(pointer(10)), comments: [task(10), task(11, 2)] }), [10, 11]],
    'two links on one pointer': [selection({ issueBody: refined(pointer(10, 11)), comments: [task(10), task(11, 2)] }), [10, 11]],
    'two pointer lines': [selection({ issueBody: refined(`${pointer(10)}\n\n${pointer(10)}`), comments: [task(10)] }), [10]],
    'pointer without a link': [selection({ issueBody: refined(`${EXECUTION}**Current task:** pending.`), comments: [task(10)] }), [10]],
  };
  for (const [name, [input, ids]] of Object.entries(states)) {
    assert.deepEqual(selectTask(input), { action: 'stop', reason: 'ambiguous', commentIds: ids, foreign: [] }, name);
  }
});

test('case 8: a pointer outside the generated region or its Execution section, quoted, or unreadable, stops', () => {
  const bodies = {
    'pointer in an earlier section, above an empty Execution section': refined(`### Plan\n\n**Current task:** [task](${URL(10)}).\n\n${EXECUTION}Readiness pending.`),
    'pointer in a region that carries no Execution heading': refined(`### Plan\n\n**Current task:** [task](${URL(10)}).`),
    'pointer under an Execution heading hidden in a multi-line HTML comment': refined(`<!-- an earlier draft\n${EXECUTION}-->\n\n**Current task:** [task](${URL(10)}).`),
    'pointer in human-owned prose beside the region': `${pointer(10)}\n${refined('Generated.')}`,
    'pointer in a body that carries no region yet': `${HUMAN}\n${pointer(10)}\n`,
    'pointer quoted in a code fence inside the region': refined(`\`\`\`text\n${pointer(10)}\n\`\`\``),
    'pointer quoted in a multi-line HTML comment inside the region': refined(`<!-- an earlier draft\n${pointer(10)}\n-->`),
    'pointer in one of two regions': `${refined(pointer(10))}\n${region()}`,
    "pointer in another generator's region": `${HUMAN}\n${region(pointer(10), 'other-tool')}`,
    'pointer in a region left unpaired by an extra end marker': `${refined(pointer(10))}<!-- AUTO:END -->\n`,
    'pointer below a following ## heading that ends the Execution section': refined(`${EXECUTION}Readiness pending.\n\n## Notes\n\n**Current task:** [task](${URL(10)}).`),
    'pointer below a following # heading': refined(`${EXECUTION}Readiness pending.\n\n# Appendix\n\n**Current task:** [task](${URL(10)}).`),
    'pointer below a following setext heading': refined(`${EXECUTION}Readiness pending.\n\nNotes\n-----\n\n**Current task:** [task](${URL(10)}).`),
    'pointer under the second of two Execution headings': refined(`${EXECUTION}Readiness pending.\n\n${pointer(10)}`),
  };
  for (const [name, issueBody] of Object.entries(bodies)) {
    assert.deepEqual(selectTask(selection({ issueBody, comments: [task(10)] })),
      { action: 'stop', reason: 'ambiguous', commentIds: [10], foreign: [] }, name);
  }
  assert.deepEqual(selectTask(selection({ issueBody: `${HUMAN}\n${region('Generated.', 'other-tool')}` })),
    { action: 'stop', reason: 'ambiguous', commentIds: [], foreign: [] });
});

test('case 9: a marker authored by another login is reported, never adopted, and never stops by itself', () => {
  const foreign = [task(30, 1, 'someone-else')];
  assert.deepEqual(selectTask(selection({ comments: foreign })), { action: 'publish-revision-1', foreign: [30] });
  assert.deepEqual(selectTask(selection({ issueBody: refined(pointer(30)), comments: foreign })),
    { action: 'stop', reason: 'ambiguous', commentIds: [30], foreign: [30] });
});

test('cases 6-9: the select command prints the decision and exits 0 to proceed, 1 to stop', () => {
  const proceed = run('select', '--input', file('select-proceed.json', JSON.stringify(selection())));
  assert.equal(proceed.status, 0, proceed.stderr);
  assert.deepEqual(JSON.parse(proceed.stdout), { action: 'publish-revision-1', foreign: [] });
  const stopped = run('select', '--input', file('select-stop.json', JSON.stringify(selection({ comments: [task(10)] }))));
  assert.equal(stopped.status, 1);
  assert.equal(JSON.parse(stopped.stdout).action, 'stop');
});

// AC3 — one input boundary

test('AC3: a missing, mistyped or unknown select key exits 2 and never yields a proceed outcome', () => {
  const inputs = [];
  for (const key of Object.keys(selection())) {
    const input = selection();
    delete input[key];
    inputs.push(input);
  }
  inputs.push(
    selection({ issue: '780' }), selection({ issue: 0 }), selection({ scanComplete: 'true' }),
    selection({ repo: 'no-slash' }), selection({ login: '' }), selection({ issueBody: null }),
    selection({ comments: {} }), selection({ comments: [{ id: '10', author: LOGIN, body: '' }] }),
    selection({ comments: [{ id: 10, body: '' }] }), selection({ comments: [{ ...task(10), url: 'x' }] }),
    selection({ comments: [task(10), task(10)] }), selection({ scanCompleted: true }),
  );
  for (const [index, input] of inputs.entries()) {
    const result = run('select', '--input', file(`invalid-${index}.json`, JSON.stringify(input)));
    assert.equal(result.status, 2, JSON.stringify(input));
    assert.equal(result.stdout, '');
  }
  assert.equal(run('select', '--input', file('invalid-json.json', '{')).status, 2);
  assert.equal(run('select', '--input', join(scratch, 'absent.json')).status, 2);
});

test('AC3: a missing, repeated or unknown flag and a malformed flag value exit 2', () => {
  const body = file('flags-body.md', `${marker(1)}\n`);
  for (const args of [
    [], ['unknown'], ['select'], ['acs', '--issue-body', body], ['acs', '--issue-body', body, '--issue-body', body],
    ['outgoing', '--body', body, '--repo', REPO, '--issue', '780', '--revision', '1', '--extra', 'x'],
    ['outgoing', '--body', body, '--repo', REPO, '--issue', '0780', '--revision', '1'],
    ['outgoing', '--body', body, '--repo', 'bad repo', '--issue', '780', '--revision', '1'],
    ['outgoing', '--body', body, '--repo', REPO, '--issue', '780', '--revision', 'one'],
  ]) {
    assert.equal(run(...args).status, 2, args.join(' '));
  }
});

// AC4 — AC agreement

const ACS = '| ID | Criterion |\n|---|---|\n| **AC1** | Requires `a  b`. |\n';
const marked = (text, acs = ACS) => `${text}<!-- acs:begin -->\n${acs}<!-- acs:end -->\n`;

test('case 10: the templates write exactly one marked AC block in the issue region and the task comment', () => {
  for (const name of ['issue-body.md', 'task-comment.md']) {
    const rows = readFileSync(join(here, '..', 'references', name), 'utf8').split('\n');
    assert.equal(rows.filter((row) => row === '<!-- acs:begin -->').length, 1, name);
    assert.equal(rows.filter((row) => row === '<!-- acs:end -->').length, 1, name);
  }
});

test('case 10: byte-equal marked blocks pass, even beside an unmarked human AC section', () => {
  const issueBody = marked(`## Acceptance criteria\n\n- AC1 in human words.\n\n${region()}`);
  assert.deepEqual(compareAcBlocks({ issueBody, taskComment: marked(`${marker(1)}\n## Task\n`) }), []);
});

test('case 10: blocks that differ in any byte, or an artifact without exactly one block, exit 1', () => {
  const taskComment = marked(`${marker(1)}\n`);
  for (const issueBody of [
    marked('', ACS.replace('`a  b`', '`a b`')),
    marked('', ACS.replace(/\n/g, '\r\n')),
    ACS,
    `${marked('')}${marked('')}`,
    `<!-- acs:end -->\n${ACS}<!-- acs:begin -->\n`,
    marked('', ACS).replace('<!-- acs:begin -->', ' <!-- acs:begin -->'),
  ]) {
    assert.equal(compareAcBlocks({ issueBody, taskComment }).length > 0, true, issueBody);
  }
  const result = run('acs', '--issue-body', file('acs-issue.md', marked('', 'Other.\n')), '--task', file('acs-task.md', taskComment));
  assert.equal(result.status, 1);
  assert.equal(run('acs', '--issue-body', file('acs-same.md', marked('')), '--task', file('acs-task.md', taskComment)).status, 0);
});

// AC5 — outgoing task

test('AC5: the outgoing check passes only an exact first-line marker for the repository, issue and revision', () => {
  const target = { repo: REPO, issue: ISSUE, revision: 2 };
  assert.deepEqual(checkOutgoingMarker({ ...target, body: `${marker(2)}\n` }), []);
  assert.deepEqual(checkOutgoingMarker({ ...target, body: marker(2) }), []);
  for (const body of [
    `${marker(1)}\n`, `${marker(2, 'other/repo')}\n`, `${marker(2, REPO, 1)}\n`, `\n${marker(2)}\n`,
    ` ${marker(2)}\n`, `${marker(2)} trailing\n`, `> ${marker(2)}\n`,
  ]) {
    assert.equal(checkOutgoingMarker({ ...target, body }).length, 1, body);
  }
});

test('AC5: section completeness is not checked, so a marker with empty sections exits 0', () => {
  const body = file('outgoing.md', `${marker(1)}\n## Goal\n\n## Read first\n`);
  assert.equal(run('outgoing', '--body', body, '--repo', REPO, '--issue', '780', '--revision', '1').status, 0);
  assert.equal(run('outgoing', '--body', body, '--repo', REPO, '--issue', '780', '--revision', '2').status, 1);
});
