// Tests for track.mjs and the attachment commands in references/meetings.md. Run with
// `node --test skills/dev-track/scripts/track.test.mjs` or `npm test` from the plugin root.
// Every input is a fixture; no GitHub call is made.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { brief, hasDuplicate, isDone, locate, rebuild, retitle, setTracker, trackerOf } from './track.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, 'track.mjs');
const MEETINGS = join(here, '..', 'references', 'meetings.md');
const scratch = mkdtempSync(join(tmpdir(), 'dev-track-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const file = (name, text) => {
  const path = join(scratch, name);
  writeFileSync(path, text);
  return path;
};
const cli = (...argv) => spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });

// One repository's categories are Chinese (slug = name), another's English (slug differs from name).
const TESTS = { name: '测试记录', slug: '测试记录' }, MEETINGS_ZH = { name: '会议记录', slug: '会议记录' };
const MEETINGS_EN = { name: 'Meeting Notes', slug: 'meeting-notes' }, TRACKING = { name: 'Tracking', slug: 'tracking' };

const node = (number, category, body = '', { created = '2026-11-01T00:00:00Z', closed = false } = {}) =>
  ({ id: `D${number}`, number, title: `#${number}`, url: `u/${number}`, closed, createdAt: created, body, category });
const tracker = (number, cat, category, where = TRACKING) =>
  node(number, where, `<!-- dev-track:tracker cat=${cat} category=${category} -->\n## Ledger\n`);

const ZH = [
  tracker(41, 'meetings', '会议记录'),
  tracker(42, 'tests', '测试记录'),
  node(31, TESTS, 'x\n<!-- dev-meeting-notes:done 2026-11-12 -->\n'),
  node(40, TESTS, 'new', { created: '2026-11-03T00:00:00Z' }),
  node(39, TESTS, 'older', { created: '2026-11-02T00:00:00Z' }),
  node(77, TESTS, '<!-- dev-track:done · #42 · 2026-11-13 -->\nx'),
  node(17, TESTS, 'merged long ago', { closed: true }),
  node(51, MEETINGS_ZH, '<!-- dev-track:done · #41 · 2026-11-13 -->\n## 会议摘要'),
  node(52, MEETINGS_ZH, '## 会议待办\n- [ ] 修复端口', { created: '2026-11-13T00:00:00Z' }),
  node(5, TRACKING, 'plain discussion'),
];
const EN = [
  node(21, MEETINGS_EN, '<!-- dev-meeting-notes:tracker -->\n## TODO\n'),
  node(14, MEETINGS_EN, '<!-- dev-meeting-notes:done 2026-11-12 -->\n'),
  node(22, MEETINGS_EN, '## Summary\nx\n## Transcript\ny'),
];

const numbers = (result, key = 'pending') => result[key].map((item) => item.number);

// Locate

test('neither N nor --cat is an error', () => {
  assert.equal(locate(ZH).flow, 'error');
});

test('N that is a tracker runs F1 with pending oldest first', () => {
  const result = locate(ZH, { number: 42 });
  assert.deepEqual([result.flow, result.cat, result.category], ['F1', 'tests', '测试记录']);
  // Old (#31) and new (#77) done marks, a closed thread (#17), the trackers and other categories are skipped.
  assert.deepEqual(numbers(result), [39, 40]);
});

test('the English key and the Chinese category both find the same tracker', () => {
  for (const cat of ['meetings', 'MEETINGS', '会议记录']) {
    const result = locate(ZH, { cat });
    assert.deepEqual([result.tracker.number, numbers(result)], [41, [52]], cat);
  }
});

test('the English category name and slug find a legacy tracker', () => {
  for (const cat of ['meetings', 'Meeting Notes', 'meeting-notes']) {
    const result = locate(EN, { cat });
    assert.deepEqual([result.flow, result.tracker.number, numbers(result)], ['F1', 21, [22]], cat);
  }
});

test('a category slug finds a tracker whose category holds nothing else', () => {
  const alone = [tracker(21, 'meetings', 'Meeting Notes')]; // the tracker sits in Tracking, Meeting Notes is empty
  for (const cat of ['meetings', 'Meeting Notes', 'meeting-notes']) {
    assert.equal(locate(alone, { cat, cats: [MEETINGS_EN] }).flow, 'F1', cat);
  }
  assert.equal(locate(alone, { cat: 'meeting-notes' }).flow, 'F2'); // without the repository's categories
});

test('N that is not a tracker, or is missing, runs F2', () => {
  assert.deepEqual(locate(ZH, { number: 5 }),
    { flow: 'F2', cat: null, category: null, mark: 5, number: 5, reason: '#5 is not a tracker' });
  assert.equal(locate(ZH, { number: 999 }).mark, null);
});

test('F2 resolves whichever of key and category it can', () => {
  const noTrackers = ZH.filter((n) => !trackerOf(n));
  assert.equal(locate(noTrackers, { cat: '会议记录' }).category, '会议记录');
  assert.equal(locate(noTrackers, { cat: 'meetings' }).cat, 'meetings');
  assert.equal(locate(noTrackers, { cat: 'meetings' }).category, null);
});

test('--cat with several trackers runs F3', () => {
  const result = locate([...ZH, tracker(60, 'tests', '测试记录')], { cat: 'tests' });
  assert.deepEqual([result.flow, numbers(result, 'trackers')], ['F3', [42, 60]]);
});

test('both given and matching runs F1 and reports the others', () => {
  const result = locate([...ZH, tracker(60, 'tests', '测试记录')], { number: 42, cat: '测试记录' });
  assert.deepEqual([result.flow, numbers(result, 'others')], ['F1', [60]]);
});

test('both given but N is not the cat tracker asks', () => {
  const result = locate(ZH, { number: 5, cat: 'tests' });
  assert.deepEqual([result.flow, result.options.map((o) => o.choice)], ['ask', ['T1', 'M1', 'N']]);
  // #41 already tracks meetings, so it cannot be marked for tests.
  assert.deepEqual(locate(ZH, { number: 41, cat: 'tests' }).options.map((o) => o.choice), ['T1', 'N']);
});

test('both given without any cat tracker runs F2 marking N', () => {
  const result = locate(ZH, { number: 5, cat: 'ideas' });
  assert.deepEqual([result.flow, result.mark, result.cat], ['F2', 5, 'ideas']);
});

test('an open thread that already has its mark only needs closing', () => {
  const result = locate(ZH, { number: 42 });
  // #31 (old mark) and #77 (new mark) are registered but still open: a close that did not land.
  assert.deepEqual([numbers(result), numbers(result, 'to_close')], [[39, 40], [31, 77]]);
  assert.ok(!numbers(result, 'to_close').includes(17)); // #17 is closed without a mark, so it stays out
});

test('--only closes no other thread', () => {
  // #31 and #77 are marked and still open, but a --only run reaches no thread except its own, and that one is
  // closed by step 5.3 of its pending entry.
  for (const only of [39, 31, 77]) {
    const result = locate(ZH, { number: 42, only });
    assert.deepEqual([numbers(result), numbers(result, 'to_close')], [[only], []], String(only));
  }
});

test('--only picks one member and flags a redo', () => {
  assert.deepEqual(locate(ZH, { number: 42, only: 31 }).pending, [{ ...brief(ZH[2]), redo: true }]);
  assert.equal(locate(ZH, { number: 42, only: 17 }).pending[0].redo, false);
  assert.equal(locate(ZH, { number: 42, only: 52 }).flow, 'error');
});

test('--only is what repeats a redo, because no full run selects it', () => {
  // A redo thread carries its mark before the run starts, so a full run never selects it again: a marked thread
  // is not pending, and to_close holds it only while it is still open. A title or close that did not land is
  // repeated with the same --only n (SKILL.md, step 5).
  const doneAndClosed = node(80, TESTS, '<!-- dev-track:done · #42 · 2026-11-13 -->\nx', { closed: true });
  const threads = [...ZH, doneAndClosed];
  const full = locate(threads, { number: 42 });
  assert.ok(![...numbers(full), ...numbers(full, 'to_close')].includes(80));
  const again = locate(threads, { number: 42, only: 80 });
  assert.deepEqual([numbers(again), again.pending[0].redo], [[80], true]);
});

test('one cat key with two categories holds two trackers, not duplicates', () => {
  // cat picks the playbook, category is what the tracker collects, so two meeting series are two trackers: F3
  // lists each with its own category, the `then` of each offers no merge, and either category still picks its
  // own tracker and is collected on its own.
  const series = [...ZH, tracker(60, 'meetings', '客户会议')];
  const result = locate(series, { cat: 'meetings' });
  assert.deepEqual([result.flow, numbers(result, 'trackers')], ['F3', [41, 60]]);
  assert.deepEqual(result.trackers.map((t) => [t.cat, t.category]), [['meetings', '会议记录'], ['meetings', '客户会议']]);
  for (const [cat, number] of [['会议记录', 41], ['客户会议', 60]]) {
    const picked = locate(series, { cat });
    assert.deepEqual([picked.flow, picked.tracker.number, picked.category], ['F1', number, cat], cat);
  }
  // the other series is reported, not merged; the report tells it apart by its category
  assert.deepEqual(locate(series, { cat: '会议记录' }).others.map((t) => [t.number, t.category]), [[60, '客户会议']]);
  const asked = locate(series, { number: 5, cat: 'meetings' }); // #5 exists and is not a tracker
  // marking needs a category too, so each series gets its own M carrying the mark it would write
  assert.deepEqual(asked.options.map((o) => [o.choice, o.cat ?? null, o.category ?? null, o.then]), [
    ['T1', null, null, 'F1'], ['T2', null, null, 'F1'],
    ['M1', 'meetings', '会议记录', 'mark+merge+F1'],
    ['M2', 'meetings', '客户会议', 'mark+merge+F1'], ['N', null, null, 'exit']]);
  const twins = locate([...ZH, tracker(60, 'meetings', '会议记录')], { number: 5, cat: 'meetings' });
  assert.deepEqual(twins.options.map((o) => [o.choice, o.then]),
    [['T1', 'merge+F1'], ['T2', 'merge+F1'], ['M1', 'mark+merge+F1'], ['N', 'exit']]);
});

test('a legacy mark and a new one for the same category are duplicates', () => {
  // The legacy mark carries the category's slug and a new one its name, so comparing the raw strings would make
  // two series out of one: both resolve to Meeting Notes, so they are twins that F3 merges, and #22 can only be
  // marked for that one series.
  const twins = [...EN, tracker(30, 'meetings', 'Meeting Notes', MEETINGS_EN)];
  assert.ok(hasDuplicate([MEETINGS_EN], [twins[0], twins.at(-1)], twins[0]));
  const result = locate(twins, { number: 22, cat: 'meetings' }); // #22 is in the category and tracks nothing
  assert.deepEqual(result.options.map((o) => [o.choice, o.category ?? null, o.then]), [
    ['T1', null, 'merge+F1'], ['T2', null, 'merge+F1'], ['M1', 'Meeting Notes', 'mark+merge+F1'], ['N', null, 'exit']]);
  // a tracker in another category is still a second series, legacy mark or not
  const apart = [...EN, tracker(30, 'meetings', '客户会议')];
  assert.deepEqual(locate(apart, { number: 22, cat: 'meetings' }).options.map((o) => o.then),
    ['F1', 'F1', 'mark+merge+F1', 'mark+merge+F1', 'exit']);
});

// Rebuild

const FATHOM = 'Intro line\r\n\r\n## Summary\r\nVIEW RECORDING - 30 mins: https://fathom.video/share/abc\r\n\r\n'
  + '- [Pricing agreed](https://fathom.video/share/abc?timestamp=12.5) by both\r\n\r\n'
  + '## Transcript\r\n  0:01 - Host\r\n    hello [x](https://example.com)\r\n';

test('a Fathom-shaped body unlinks the summary and folds the transcript verbatim', () => {
  const { body } = rebuild(FATHOM, 21, '2026-11-13', { digest: '## Digest\n[Recording](https://fathom.video/share/abc)',
    folds: ['Transcript'], unlinks: ['fathom\\.video'] });
  assert.ok(body.startsWith('<!-- dev-track:done · #21 · 2026-11-13 -->\n\n## Digest\n'
    + '[Recording](https://fathom.video/share/abc)\n\nIntro line'), body);
  assert.ok(body.includes('- Pricing agreed by both'));
  assert.ok(!body.includes('VIEW RECORDING'));
  assert.ok(body.includes('<summary>Transcript</summary>\n\n  0:01 - Host\n    hello [x](https://example.com)\n\n</details>'));
  assert.ok(!body.includes('\r'));
});

test('Chinese notes fold whole with a Chinese label', () => {
  const source = '\n\n  缩进行\n## 会议待办\n- [ ] 修复端口 [链接](https://example.com)\n';
  const { body } = rebuild(source, 41, '2026-11-13', { digest: '## 会议摘要（2026-11-04）\n', folds: ['all'], label: '原始记录' });
  assert.ok(body.endsWith(`<details>\n<summary>原始记录</summary>\n${source}\n</details>\n`), body);
});

test('blank lines and trailing spaces of the original survive', () => {
  const source = '\n\nalpha  \n\n';
  for (const options of [{}, { folds: ['all'] }, { unlinks: ['fathom\\.video'] }]) {
    assert.ok(rebuild(source, 1, '2026-11-13', options).body.includes(source), JSON.stringify(options));
  }
  const kept = rebuild('## Summary\nx  \n\n\n## Transcript\ny\n', 1, '2026-11-13', { folds: ['Transcript'] }).body;
  assert.ok(kept.includes('## Summary\nx  \n\n\n'));
  // --drop/--fold match the stripped name, but a heading that stays keeps its own trailing spaces
  assert.equal(rebuild('## Keep  \nbody\n## Drop\nold\n', 1, '2026-11-13', { drops: ['Drop'] }).body,
    '<!-- dev-track:done · #1 · 2026-11-13 -->\n\n## Keep  \nbody\n');
  assert.equal(rebuild('## Drop\nold\n## Keep  ', 1, '2026-11-13', { drops: ['Drop'] }).body, // no final newline
    '<!-- dev-track:done · #1 · 2026-11-13 -->\n\n## Keep  \n');
});

test('Chinese section names fold and drop', () => {
  const source = '## 旧摘要\nold\n## 转写稿\n说话人 1：你好\n';
  const { body } = rebuild(source, 41, '2026-11-13', { digest: '## 会议摘要\nnew', folds: ['转写稿'], drops: ['旧摘要'] });
  assert.ok(!body.includes('old'));
  assert.ok(body.includes('<summary>转写稿</summary>\n\n说话人 1：你好\n\n</details>'));
});

test('a mark alone keeps the body byte for byte', () => {
  const source = '> 跟踪 issue：#12\n\n\n## 被测版本\n| a |\n';
  assert.equal(rebuild(source, 42, '2026-11-13').body, `<!-- dev-track:done · #42 · 2026-11-13 -->\n\n${source}`);
});

test('rebuild refuses a bad date, a done or tracker body, a missing section and an oversize body', () => {
  assert.equal(rebuild('x', 1, '11-13').action, 'refuse');
  assert.equal(rebuild('<!-- dev-meeting-notes:done · #41 -->\nx', 1, '2026-11-13').action, 'refuse');
  assert.equal(rebuild(setTracker('x', 'tests', '测试记录'), 1, '2026-11-13').action, 'refuse');
  assert.match(rebuild('## Summary\nx', 1, '2026-11-13', { folds: ['Transcript'] }).reason, /Transcript/);
  assert.match(rebuild('x'.repeat(70000), 1, '2026-11-13').reason, /65536/);
});

// Small helpers

test('retitle replaces any leading status', () => {
  assert.equal(retitle('⬜ T01 登录流程测试', '⚠️'), '⚠️ T01 登录流程测试');
  assert.equal(retitle('✅️ ✅ 20261104 会议纪要', '✅️'), '✅️ 20261104 会议纪要');
  assert.equal(retitle('1104会议纪要', '✅️', '20261104 会议纪要'), '✅️ 20261104 会议纪要');
  assert.equal(retitle('Weekly sync @ 20261109', '✅'), '✅ Weekly sync @ 20261109');
  assert.equal(retitle('[Draft] 会议', '⏳'), '⏳ [Draft] 会议');
});

test('setTracker adds, replaces and removes', () => {
  const marked = setTracker('## 台账\n', 'tests', '测试记录');
  assert.deepEqual(trackerOf({ body: marked }), ['tests', '测试记录']);
  assert.equal(setTracker(marked, 'meetings', 'Meeting Notes').split('dev-track:tracker').length - 1, 1);
  assert.equal(setTracker(marked), '## 台账\n');
  const legacy = '<!-- dev-meeting-notes:tracker -->\n## TODO\n'; // --remove has to retire this one too
  assert.equal(setTracker(legacy), '## TODO\n');
  assert.equal(trackerOf({ body: setTracker(legacy) }), null);
});

// Marks: a mark counts only where a helper writes one, a line of its own outside a code block. A thread that
// merely quotes a done mark is still pending, and a quoted tracker mark is no tracker.

const QUOTED = '`<!-- dev-track:done · #42 · 2026-11-13 -->` 是登记标记吗？\n';
const FENCED = '## 问题\n```markdown\n<!-- dev-track:done · #42 · 2026-11-13 -->\n'
  + '<!-- dev-track:tracker cat=tests category=测试记录 -->\n```\n';
const DONE = '<!-- dev-track:done · #42 · 2026-11-14 -->\n';
const TRACK = '<!-- dev-track:tracker cat=tests category=测试记录 -->\n';
// CommonMark fences: an inner ```python line opens nothing inside a block, and a shorter run or a run with an
// info string closes nothing; tildes fence just as backticks do. The last shape never closes.
const NESTED = [(m) => `\`\`\`text\nx\n\`\`\`python\n${m}\`\`\`\n`, (m) => `\`\`\`\`markdown\n\`\`\`\n${m}\`\`\`\`\n`,
  (m) => `~~~\n\`\`\`\n${m}~~~\n`, (m) => `  ~~~~\n~~~ python\n${m}~~~~\n`, (m) => `\`\`\`\n${m}`];
const LIST = '- ```text\n  sample\n  ```\n\n'; // a code block opened on the list item's own line

test('a quoted mark is not live', () => {
  const inlineMiddle = '正文里提到 <!-- dev-track:tracker cat=tests category=测试记录 --> 这个标记\n';
  for (const body of [QUOTED, FENCED, inlineMiddle]) {
    assert.equal(isDone({ body }), false, body);
    assert.equal(trackerOf({ body }), null, body);
  }
});

test('a thread quoting a done mark stays pending and is not closed', () => {
  const asking = node(90, TESTS, QUOTED, { created: '2026-11-04T00:00:00Z' });
  const result = locate([...ZH, asking], { number: 42 });
  assert.deepEqual([numbers(result), numbers(result, 'to_close')], [[39, 40, 90], [31, 77]]);
});

test('a fenced tracker example is not a second tracker', () => {
  const quoting = node(91, TESTS, FENCED, { created: '2026-11-05T00:00:00Z' });
  const result = locate([...ZH, quoting], { cat: 'tests' }); // F3 here would mean it was read as a tracker
  assert.deepEqual([result.flow, result.tracker.number, numbers(result)], ['F1', 42, [39, 40, 91]]);
});

test('every real mark stays live', () => {
  for (const body of [
    '<!-- dev-track:done · #42 · 2026-11-13 -->\nx', // rebuild: the first line
    'x\n<!-- dev-meeting-notes:done 2026-11-12 -->\n', // legacy: after other text
    '<!-- dev-track:done · #41 · 2026-11-13 -->\n## 会议摘要',
    '<!-- dev-meeting-notes:done 2026-11-12 -->\n',
    '<!-- dev-track:done · #42 · 2026-11-13 -->\r\nx', // CRLF: posted on the web
    '<!-- dev-track:done · #42 · 2026-11-13 -->', // nothing after it
  ]) assert.ok(isDone({ body }), body);
  for (const [body, mark] of [
    ['<!-- dev-track:tracker cat=tests category=测试记录 -->\n## 台账\n', ['tests', '测试记录']],
    ['<!-- dev-track:tracker cat=tests category=测试记录 -->\r\n## 台账\r\n', ['tests', '测试记录']],
    ['<!-- dev-meeting-notes:tracker -->\n## TODO\n', ['meetings', 'meeting-notes']],
  ]) assert.deepEqual(trackerOf({ body }), mark, body);
});

test('a quoted mark neither refuses a rebuild nor is removed', () => {
  assert.equal(rebuild(FENCED, 42, '2026-11-13').body, `<!-- dev-track:done · #42 · 2026-11-13 -->\n\n${FENCED}`);
  const marked = setTracker(FENCED, 'tests', '测试记录');
  assert.equal(setTracker(marked), FENCED); // --remove retires only the real mark
});

test('a mark after an inner fence line is still an example', () => {
  for (const shape of NESTED) {
    for (const mark of [DONE, TRACK]) {
      const body = shape(mark);
      assert.equal(isDone({ body }), false, body);
      assert.equal(trackerOf({ body }), null, body);
      assert.equal(setTracker(setTracker(body, 'tests', '测试记录')), body);
      assert.equal(rebuild(body, 42, '2026-11-14').action, 'proceed', body);
    }
  }
});

test('a quoted mark after an inner fence line stays pending', () => {
  const quoting = node(39, TESTS, NESTED[0](DONE), { created: '2026-11-02T00:00:00Z' });
  const result = locate([...ZH.filter((n) => n.number !== 39), quoting], { number: 42 });
  assert.deepEqual([numbers(result), numbers(result, 'to_close')], [[39, 40], [31, 77]]);
});

test('a live mark after a closed fence still counts', () => {
  for (const body of ['```python\nx\n```\n' + DONE, '~~~\n```\n~~~\r\n' + DONE.replace('\n', '\r\n')]) {
    assert.ok(isDone({ body }), body);
  }
  assert.equal(setTracker('~~~\nx\n~~~\n' + TRACK), '~~~\nx\n~~~\n');
});

test('a list code block does not shift what counts as code', () => {
  for (const mark of [DONE, TRACK]) {
    const body = `${LIST}\`\`\`\n${mark}\`\`\`\n`;
    assert.equal(isDone({ body }), false, body);
    assert.equal(trackerOf({ body }), null, body);
    assert.equal(setTracker(body), body);
  }
  const kept = `## Notes\n${LIST}\`\`\`\n## Old digest\nquoted\n\`\`\`\n`;
  const source = `${kept}## Old digest\nreal old\n## Keep\nimportant\n`;
  assert.equal(rebuild(source, 21, '2026-11-14', { drops: ['Old digest'] }).body,
    `<!-- dev-track:done · #21 · 2026-11-14 -->\n\n${kept}## Keep\nimportant\n`);
});

test('a list fence closed at column zero reads as GitHub does', () => {
  // the unindented ``` ends the list, so GitHub opens a block there and shows the mark as live
  assert.ok(isDone({ body: `1. run:\n   \`\`\`\n   cmd\n\`\`\`\n\nexample:\n\n\`\`\`\n${DONE}\`\`\`\n` }));
});

test('a fenced heading is not a section, and neither is a setext one', () => {
  const example = '```markdown\n## Transcript\nquoted\n```python\n## Old digest\n```\n';
  const source = `## Summary\ns\n${example}## Transcript\nreal\n`;
  const { body } = rebuild(source, 21, '2026-11-14', { folds: ['Transcript'] });
  assert.equal(body.split('<details>').length - 1, 1);
  assert.ok(body.includes(`## Summary\ns\n${example}`));
  assert.ok(body.includes('<summary>Transcript</summary>\n\nreal\n\n</details>'));
  const dropped = rebuild(`## Notes\n${example}## Old digest\nold\n`, 21, '2026-11-14', { drops: ['Old digest'] });
  assert.equal(dropped.body, `<!-- dev-track:done · #21 · 2026-11-14 -->\n\n## Notes\n${example}`);
  assert.equal(rebuild(`## Notes\n${example}`, 21, '2026-11-14', { drops: ['Old digest'] }).action, 'refuse');
  assert.equal(rebuild('Old digest\n---\nx\n', 21, '2026-11-14', { drops: ['Old digest'] }).action, 'refuse');
});

// CLI

const page = (nodes) => ({ data: { repository: { discussions: { nodes } } } });

test('locate reads slurped pages and sets the exit code', () => {
  const pages = file('pages.json', JSON.stringify([page(ZH.slice(0, 3)), page(ZH.slice(3))]));
  const run = cli('locate', '--pages', pages, '--cat', '测试记录');
  assert.deepEqual([run.status, JSON.parse(run.stdout).flow], [0, 'F1']);
  assert.equal(cli('locate', '--pages', pages).status, 1);
  assert.equal(cli('locate', '--pages', join(scratch, 'missing.json')).status, 2);
});

test('titles and section names are read from files', () => {
  const title = file('title.txt', '$(printf SHELL) 1104会议纪要\n');
  const run = cli('title', '--title', `@${title}`, '--status', '✅️');
  assert.deepEqual([run.status, run.stdout], [0, '✅️ $(printf SHELL) 1104会议纪要']);
  const source = file('s.md', '## $(printf SHELL)\nx\n'), out = join(scratch, 'o.md');
  const head = file('fold.txt', '$(printf SHELL)\n');
  const body = cli('body', '--source', source, '--tracker', '1', '--date', '2026-11-13', '--fold', `@${head}`, '--out', out);
  assert.deepEqual([body.status, readFileSync(out, 'utf8').includes('<summary>$(printf SHELL)</summary>')], [0, true]);
});

test('locate reads the repository categories', () => {
  const pages = file('categories.json', JSON.stringify([{ data: { repository: {
    discussionCategories: { nodes: [MEETINGS_EN] },
    discussions: { nodes: [tracker(21, 'meetings', 'Meeting Notes')] } } } }]));
  const run = cli('locate', '--pages', pages, '--cat', 'meeting-notes');
  assert.deepEqual([run.status, JSON.parse(run.stdout).flow], [0, 'F1']);
});

test('a bad --unlink regex exits 2', () => {
  const source = file('unlink.md', 'x\n');
  assert.equal(cli('body', '--source', source, '--tracker', '1', '--date', '2026-11-13', '--unlink', '[',
    '--out', join(scratch, 'unlink.out.md')).status, 2);
});

test('zero and negative numbers exit 2', () => {
  const pages = file('zh.json', JSON.stringify(page(ZH))), source = file('n.md', 'x\n');
  for (const argv of [['locate', '--pages', pages, '--number', '-1'], ['locate', '--pages', pages, '--cat', 'tests', '--only', '0'],
    ['body', '--source', source, '--tracker', '0', '--date', '2026-11-13', '--out', join(scratch, 'n.out.md')]]) {
    assert.equal(cli(...argv).status, 2, argv.join(' '));
  }
});

test('body and tracker commands', () => {
  const source = file('bt.md', 'x\n'), out = join(scratch, 'bt.out.md');
  const body = cli('body', '--source', source, '--tracker', '42', '--date', '2026-11-13', '--out', out);
  assert.deepEqual([body.status, readFileSync(out, 'utf8')], [0, '<!-- dev-track:done · #42 · 2026-11-13 -->\n\nx\n']);
  assert.equal(cli('tracker', '--source', source, '--cat', '测试', '--category', '测试记录', '--out', out).status, 1);
  assert.equal(cli('tracker', '--source', source, '--cat', 'tests', '--out', out).status, 2);
  assert.equal(cli('tracker', '--source', source, '--cat', 'tests', '--category', '测试记录', '--out', out).status, 0);
  assert.equal(readFileSync(out, 'utf8'), '<!-- dev-track:tracker cat=tests category=测试记录 -->\nx\n');
  // Files are read with universal newlines, as the Python original read them.
  assert.equal(cli('tracker', '--source', file('crlf.md', 'a\r\nb\r'), '--remove', '--out', out).status, 0);
  assert.equal(readFileSync(out, 'utf8'), 'a\nb\n');
});

// references/meetings.md: attachments

test('the documented attachment grep yields exactly each bare URL next to prose', () => {
  // The grep runs over source.json, where a line break is `\n` and a quote `\"`; a bare URL has to stop at
  // the file name, not take the prose after it.
  const pattern = readFileSync(MEETINGS, 'utf8').match(/grep -oE '([^']+)' \$S\/NUMBER\/source\.json/)?.[1];
  assert.ok(pattern, 'meetings.md no longer documents the attachment grep');
  const url = 'https://github.com/user-attachments/files/1/slides.pptx';
  const encoded = 'https://github.com/user-attachments/files/2/%E4%BC%9A%E8%AE%AE.pptx';
  // A pasted image or screenshot is an /assets/<id> link with no file name.
  const asset = 'https://github.com/user-attachments/assets/619558c7-0a1b-4c2d-8e3f-5a6b7c8d9e0f';
  const body = `${url}。下一句\n${url}.\n${url}, then more\n${url}\nnext line\n[deck](${url})\n"${url}" done\n`
    + `${encoded}、下文\n![shot](${asset})\n${asset}。下一句\n${asset}.\n`;
  const json = file('source.json', JSON.stringify([{ data: { body, comments: [{ body: `see ${url}。` }] } }]));
  const out = spawnSync('grep', ['-oE', pattern, json], { encoding: 'utf8' }).stdout;
  assert.deepEqual([...new Set(out.split('\n').filter(Boolean))].sort(), [url, encoded, asset].sort());
  assert.deepEqual([out.split(`${url}\n`).length - 1, out.split(`${asset}\n`).length - 1], [7, 3]);
});

// An attachment is untrusted data, and a few KB of zip decompress to hundreds of MB, so the .docx/.pptx reader
// in meetings.md bounds a file by its declared sizes before reading. The reader is Python, so these need python3.
const python = spawnSync('python3', ['--version']).status === 0 ? false : 'needs python3';
const snippet = () => {
  const found = readFileSync(MEETINGS, 'utf8').match(/<<'EOF'\n([\s\S]*?\n)EOF\n/);
  assert.ok(found, 'meetings.md no longer documents the extraction snippet');
  return found[1];
};
const readZip = (path) => spawnSync('python3', ['-I', '-', path], { input: snippet(), encoding: 'utf8' });
// Members are [name, text] or [name, a count of NUL bytes].
const ZIP = "import json, sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:\n"
  + "    for name, data in json.load(sys.stdin):\n        z.writestr(name, b'\\0' * data if isinstance(data, int) else data)\n";
const zip = (name, members) => {
  const path = join(scratch, name);
  assert.equal(spawnSync('python3', ['-I', '-c', ZIP, path], { input: JSON.stringify(members) }).status, 0);
  return path;
};
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const docx = (text) => `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;

test('a real document is still read', { skip: python }, () => {
  const done = readZip(zip('real.docx', [['word/document.xml', docx('会议要点')]]));
  assert.deepEqual([done.status, done.stdout], [0, '会议要点\n'], done.stderr);
});

test('too many members or too much data is refused before any read', { skip: python }, () => {
  const bombs = { members: Array.from({ length: 2001 }, (_, i) => [`ppt/slides/slide${i}.xml`, '']),
    bytes: [['word/document.xml', 201 << 20]] }; // 201 MB out of ~200 KB of zip
  for (const [name, members] of Object.entries(bombs)) {
    const done = readZip(zip(`${name}.zip`, members));
    assert.deepEqual([done.status, done.stdout], [1, ''], name);
    assert.match(done.stderr, /over the limit/, name);
  }
});

test('a huge declaration is refused before the directory is parsed', { skip: python }, () => {
  // ZipFile builds one object per central-directory entry, so 100,000 empty members cost tens of MB before any
  // cap on infolist() can refuse them. The end record's own count and directory size have to refuse first.
  // Patching a one-member zip's end record tests that without the fixture: only a run that stops before
  // parsing never learns the directory really holds one entry.
  const path = zip('declared.docx', [['word/document.xml', docx('一个成员')]]);
  const raw = readFileSync(path);
  const end = raw.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1')); // count: 2 bytes at +10, directory size: 4 at +12
  for (const [name, patch] of [['members', (b) => b.writeUInt16LE(60000, end + 10)],
    ['directory', (b) => b.writeUInt32LE(100 << 20, end + 12)]]) {
    const patched = Buffer.from(raw);
    patch(patched);
    writeFileSync(path, patched);
    const done = readZip(path);
    assert.deepEqual([done.status, done.stdout], [1, ''], name);
    assert.match(done.stderr, /declared: over the limit/, name);
  }
  writeFileSync(path, raw); // the same file, its own declaration intact, is still read
  assert.equal(readZip(path).stdout, '一个成员\n');
});

test('an oversize member is skipped and reported', { skip: python }, () => {
  const done = readZip(zip('oversize.docx', [['word/document.xml', 21 << 20]]));
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(done.stdout.split('\n').filter(Boolean), ['## skipped, too large: word/document.xml 22020096']);
});
