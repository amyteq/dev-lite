// One test per helper case in the dev-compact closed case lists (AC-2, AC-3.3, AC-3.4, AC-4.1,
// AC-4.3 to AC-4.7, AC-5, and the calls table). Run with
// `node --test skills/dev-compact/scripts/check-compact.test.mjs` or `npm test` from the plugin root.
// Every input is a fixture; no GitHub call is made.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { planAppend, vetLabels } from '../../dev-explain/scripts/check-explain.mjs';
import { ALLOWED, LIMIT, assemble, hasHandle, render, resolveArgs, segment, verifyBytes, vetOutgoing } from './check-compact.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, 'check-compact.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'check-compact-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const file = (name, text) => {
  const path = join(scratch, name);
  writeFileSync(path, text);
  return path;
};
const cli = (...argv) => spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });

const REPO = 'example-org/example-repo';
const args = (text) => resolveArgs({ repo: REPO, text });
const proceed = (text) => {
  const result = args(text);
  assert.equal(result.action, 'proceed', JSON.stringify(result));
  return result;
};

/** A plan that keeps every block in place; `over` replaces entries, body items or other fields. */
function plan(body, over = {}) {
  const { blocks } = segment(body);
  const own = blocks.filter((b) => b.shape !== 'calls');
  return {
    repo: REPO, target: { kind: 'issue', number: 7 }, login: 'me', time: '2026-10-15 11:30 UTC', level: 'none',
    wrap: 'keep', threshold: 1, hides: [], archives: [],
    body: own.map((b) => ({ block: b.id })),
    ...over,
    blocks: { ...Object.fromEntries(own.map((b) => [b.id, { category: b.shape ? 'protected' : 'current', disposition: 'keep' }])),
      ...over.blocks },
  };
}
const refused = (body, p, pattern) => {
  const result = assemble({ body, plan: p });
  assert.equal(result.action, 'stop', JSON.stringify(result));
  if (pattern) assert.match(JSON.stringify(result.violations ?? result.detail), pattern);
  return result;
};
const planned = (body, p) => {
  const result = assemble({ body, plan: p });
  assert.equal(result.action, 'plan', JSON.stringify(result));
  return result;
};
const move = (id, title = 'Moved') => ({ archives: [{ title, items: [{ block: id }] }] });

const BODY = '# Title\n\nStatus: green.\n\nRound 1 log line one\nand line two.\n\n## History\n\nOld narrative.\n';

// AC-2 — argument resolution

test('AC-2.1 N or #N is the target of any kind; an unsafe number is not', () => {
  assert.deepEqual(proceed('888').target, { number: 888, kind: 'any' });
  assert.deepEqual(proceed('#760').target, { number: 760, kind: 'any' });
  assert.equal(args('99999999999999999999').action, 'stop');
});

test('AC-2.2 an issues, pull or discussions URL of this repository is the target; a fragment warns', () => {
  assert.deepEqual(proceed(`https://github.com/${REPO}/issues/5`).target, { number: 5, kind: 'issue-or-pr' });
  assert.deepEqual(proceed('https://github.com/Example-Org/Example-Repo/pull/6').target, { number: 6, kind: 'issue-or-pr' });
  const fragment = proceed(`https://github.com/${REPO}/discussions/760#discussioncomment-1`);
  assert.deepEqual(fragment.target, { number: 760, kind: 'discussion' });
  assert.match(fragment.warnings[0], /fragment/);
});

test('AC-2.3 no target, #0, another repository, another path or a leading option stops', () => {
  for (const text of ['', '   ', '#0', '0', 'https://github.com/other/repo/issues/5', `https://github.com/${REPO}/pull/5/files`,
    `https://github.com/${REPO}/commit/abc`, `https://github.com/${REPO}/issues/5?x=1`, 'level=most 5', 'please compact 5']) {
    assert.equal(args(text).action, 'stop', text);
  }
});

test('AC-2.4 level= takes none, less, medium or most in any case; otherwise none with a warning', () => {
  assert.equal(proceed('5 level=MeDiUm').level, 'medium');
  assert.equal(proceed('5').level, 'none');
  for (const text of ['5 level=max', '5 level=', '5 level=less level=most']) {
    const result = proceed(text);
    assert.equal(result.level, 'none');
    assert.match(result.warnings.join(), /level=/);
  }
});

test('AC-2.5 threshold= takes a positive integer; otherwise 49152 with a warning', () => {
  assert.equal(proceed('5 threshold=1024').threshold, 1024);
  assert.equal(proceed('5').threshold, 49152);
  for (const text of ['5 threshold=0', '5 threshold=-1', '5 threshold=1e3', '5 threshold=', '5 threshold=1 threshold=2']) {
    const result = proceed(text);
    assert.equal(result.threshold, 49152, text);
    assert.match(result.warnings.join(), /threshold=/);
  }
});

test('AC-2.6 wrap= takes soft or keep; otherwise soft with a warning', () => {
  assert.equal(proceed('5 wrap=KEEP').wrap, 'keep');
  assert.equal(proceed('5').wrap, 'soft');
  for (const text of ['5 wrap=hard', '5 wrap=', '5 wrap=keep wrap=soft']) assert.match(proceed(text).warnings.join(), /wrap=/);
});

test('AC-2.7 dry-run selects dry-run mode; its absence selects apply mode', () => {
  assert.equal(proceed('5 dry-run').dryRun, true);
  assert.equal(proceed('5 level=less').dryRun, false);
  for (const text of ['5 DRY-RUN', '5 --dry-run', '5 dryrun keep it', '5 keep it dry-run', '5 dry run please', '5 —dry-run', '5 dry-run, then stop']) {
    const result = proceed(text);
    assert.equal(result.dryRun, false, text);
    assert.match(result.warnings.join(), /notes mention/, text);
  }
  assert.deepEqual(proceed('5 dry-run show the dry-run plan').warnings, []);
});

test('AC-2.8 the first other token starts verbatim notes, later option-like text included', () => {
  const result = proceed('5 dry-run keep the ledger;  level=most  stays\n- and this line');
  assert.equal(result.notes, 'keep the ledger;  level=most  stays\n- and this line');
  assert.equal(result.level, 'none');
  assert.equal(proceed('5 level=less').notes, '');
});

// AC-3.3 — markers the helper cannot pair stop

test('AC-3.3 an unpaired, hidden, nested or crossing marker stops', () => {
  const cases = {
    'unclosed AUTO': 'a\n\n<!-- AUTO:BEGIN -->\n\nb\n',
    'unopened AUTO end': 'a\n\n<!-- AUTO:END -->\n',
    'marker in a code fence': '```\n<!-- AUTO:BEGIN -->\n```\n\n<!-- AUTO:END -->\n',
    'marker in a multi-line comment': '<!--\n<!-- acs:begin -->\n-->\n\n<!-- acs:end -->\n',
    'markers as list items': '- <!-- AUTO:BEGIN -->\n- generated\n- <!-- AUTO:END -->\n',
    'markers in a blockquote': '> <!-- AUTO:BEGIN -->\n> generated\n> <!-- AUTO:END -->\n',
    'nested same name': '<!-- x:begin -->\n\n<!-- x:begin -->\n\n<!-- x:end -->\n\n<!-- x:end -->\n',
    'crossing sections': '<!-- AUTO:BEGIN -->\n\n<!-- acs:begin -->\n\n<!-- AUTO:END -->\n\n<!-- acs:end -->\n',
    'two calls tables': '<!-- dev-compact:calls:begin -->\n\n<!-- dev-compact:calls:end -->\n\n<!-- dev-compact:calls:begin -->\n\n<!-- dev-compact:calls:end -->\n',
  };
  for (const [name, body] of Object.entries(cases)) assert.equal(segment(body).action, 'stop', name);
});

// AC-3.4 — the threshold

test('AC-3.4 below the threshold a plan that changes nothing is no-change, and only a note may change a block', () => {
  assert.equal(assemble({ body: BODY, plan: plan(BODY, { threshold: 10000, wrap: 'soft' }) }).action, 'no-change');
  assert.equal(assemble({ body: BODY, plan: plan(BODY, { wrap: 'soft' }) }).action, 'plan');
  assert.equal(assemble({ body: BODY, plan: plan(BODY) }).action, 'no-change');
  const moved = (note) => ({ ...move('b3'), body: [{ block: 'b1' }, { block: 'b2' }, { text: 'Log: {{part:1}}', ...note }, { block: 'b4' }, { block: 'b5' }] });
  refused(BODY, plan(BODY, { threshold: 10000, ...moved({ note: true }), blocks: { b3: { category: 'log', disposition: 'move' } } }), /only a note may change it/);
  refused(BODY, plan(BODY, { threshold: 10000, ...moved({}), blocks: { b3: { category: 'log', disposition: 'move', note: true } } }), /only a note may add text/);
  planned(BODY, plan(BODY, { threshold: 10000, ...moved({ note: true }), blocks: { b3: { category: 'log', disposition: 'move', note: true } } }));
});

test('AC-3.4 below the threshold a reorder or added text needs a note', () => {
  const reordered = [{ block: 'b2' }, { block: 'b1' }, { block: 'b3' }, { block: 'b4' }, { block: 'b5' }];
  refused(BODY, plan(BODY, { threshold: 10000, body: reordered }), /only a note may reorder it/);
  planned(BODY, plan(BODY, { threshold: 10000, body: reordered, blocks: { b2: { category: 'current', disposition: 'keep', note: true } } }));
  const added = (note) => plan(BODY, { threshold: 10000, body: [{ block: 'b1' }, { text: 'Owner note.', ...note }, { block: 'b2' }, { block: 'b3' }, { block: 'b4' }, { block: 'b5' }] });
  refused(BODY, added({}), /only a note may add text/);
  planned(BODY, added({ note: true }));
});

// AC-4.1 / AC-4.2 — protected blocks

const MARKED = 'Intro.\n\n<!-- AUTO:BEGIN gen -->\nGenerated\n\nrows\n<!-- AUTO:END gen -->\n\n<!-- acs:begin -->\n- AC-1\n<!-- acs:end -->\n\n'
  + '<!-- other-tool:begin -->\nx\n<!-- other-tool:end -->\n\nA note <!-- hidden --> here.\n\nTail.\n';

test('AC-4.1 every marked section, acs block and block with an HTML comment is one protected block', () => {
  const { blocks } = segment(MARKED);
  assert.deepEqual(blocks.map((b) => b.shape), [null, 'marked', 'marked', 'marked', 'comment', null]);
  assert.match(blocks[1].text, /^<!-- AUTO:BEGIN gen -->[\s\S]*<!-- AUTO:END gen -->$/);
  refused(MARKED, plan(MARKED, { blocks: { b2: { category: 'current', disposition: 'keep' } } }), /must be protected/);
  refused(MARKED, plan(MARKED, { body: [{ block: 'b1' }, { block: 'b3' }, { block: 'b2' }, { block: 'b4' }, { block: 'b5' }, { block: 'b6' }] }), /original order/);
  const p = plan(MARKED, { body: [{ block: 'b6' }, { block: 'b1' }, { block: 'b2' }, { block: 'b3' }, { block: 'b4' }, { block: 'b5' }] });
  const result = planned(MARKED, p);
  for (const block of blocks.slice(1, 5)) assert.ok(result.template.includes(block.text), block.id);
});

test('AC-4.1 a placeholder quoted in a kept, protected or calls block is refused, so render fills only text the run wrote', () => {
  const body = 'Intro {{size:after}}.\n\n<!-- AUTO:BEGIN -->\n- AC-9 a pointer such as `{{part:1}}` becomes a permalink.\n<!-- AUTO:END -->\n\nOld log.\n';
  refused(body, plan(body, { ...move('b3'), body: [{ block: 'b1' }, { block: 'b2' }, { text: 'Log: {{part:1}}' }], blocks: { b3: { category: 'log', disposition: 'move' } } }),
    /b1 quotes[^\]]*b2 quotes/);
  const quoted = 'Intro.\n\nQuote `{{part:1}}` and {{size:after}}.\n\nKeep.\n';
  const archived = { ...move('b2'), body: [{ block: 'b1' }, { text: 'See {{part:1}}' }, { block: 'b3' }], blocks: { b2: { category: 'log', disposition: 'move' } } };
  assert.ok(planned(quoted, plan(quoted, archived)).parts[0].text.includes('Quote `{{part:1}}` and {{size:after}}.'));
  refused(quoted, plan(quoted, { ...archived, ...move('b2', 'Moved, see {{part:1}}') }), /archive text/);
  refused(quoted, plan(quoted, { ...archived, body: [{ block: 'b1' }, { text: 'See {{part:1}} at {{size:after}}' }, { block: 'b3' }] }), /contains \{\{size:after\}\}/);
  const calls = 'Text.\n\n<!-- dev-compact:calls:begin -->\n| `dev-compact` | x | `none` | 1 | {{size:after}} |\n<!-- dev-compact:calls:end -->\n';
  refused(calls, plan(calls), /calls section quotes a placeholder/);
});

test('AC-4.2 a block the plan marks protected must be kept, byte-identical under soft wrap', () => {
  refused(BODY, plan(BODY, { ...move('b2'), blocks: { b2: { category: 'protected', disposition: 'move' } } }), /not allowed for protected/);
  const body = 'Ruling line one\nline two.\n\nLog line one\nline two.\n';
  const result = planned(body, plan(body, { wrap: 'soft', blocks: { b1: { category: 'protected', disposition: 'keep' } } }));
  assert.ok(result.template.startsWith('Ruling line one\nline two.\n\nLog line one line two.\n\n'), result.template);
});

// AC-4.3 — the level table

test('AC-4.3 each level allows exactly the dispositions in the table, for every category', () => {
  const lossless = ['keep', 'fold', 'move'];
  const expected = {
    none: { current: lossless, history: lossless, log: lossless },
    less: { current: lossless, history: [...lossless, 'summarize'], log: [...lossless, 'summarize', 'condense', 'discard'] },
    medium: { current: [...lossless, 'summarize'], history: [...lossless, 'summarize', 'condense', 'discard'], log: [...lossless, 'summarize', 'condense', 'discard'] },
    most: { current: [...lossless, 'summarize'], history: ['move', 'discard'], log: ['move', 'discard'] },
  };
  assert.deepEqual(ALLOWED, expected);
  const body = 'Keep me.\n\nTarget paragraph.\n';
  for (const [level, byCategory] of Object.entries(expected)) {
    for (const [category, allowed] of Object.entries(byCategory)) {
      for (const disposition of ['keep', 'fold', 'move', 'summarize', 'condense', 'discard']) {
        const items = { keep: [{ block: 'b2' }], fold: [{ text: '<details><summary>x</summary>' }, { block: 'b2' }, { text: '</details>' }] }[disposition] ?? [];
        const p = plan(body, { level, body: [{ block: 'b1' }, ...items], blocks: { b2: { category, disposition } },
          ...(['move', 'summarize'].includes(disposition) ? move('b2') : {}) });
        const result = assemble({ body, plan: p });
        assert.equal(result.action === 'plan' || result.action === 'no-change', allowed.includes(disposition), `${level} ${category} ${disposition}`);
      }
    }
  }
  refused(body, plan(body, { blocks: { b2: { category: 'trivia', disposition: 'keep' } } }), /unknown category/);
});

// AC-4.4 — headings

test('AC-4.4 a heading is kept at none and less, and may move at medium and most', () => {
  const p = (level) => plan(BODY, { level, ...move('b4'), body: [{ block: 'b1' }, { block: 'b2' }, { block: 'b3' }, { block: 'b5' }],
    blocks: { b4: { category: 'history', disposition: 'move' } } });
  for (const level of ['none', 'less']) refused(BODY, p(level), /heading/);
  planned(BODY, p('medium'));
});

// AC-4.5 — verbatim placement under soft wrap

test('AC-4.5 a hard-wrapped paragraph is soft-wrapped; code, tables and quotes keep their lines', () => {
  const body = 'one\ntwo\n\n- item\n  wrapped\n\n```\ncode\nlines\n```\n\n| a |\n| b |\n\n> quote\n> lines\n\nend  \nbreak\n';
  const { blocks } = segment(body);
  assert.deepEqual(blocks.map((b) => b.soft), ['one two', '- item wrapped', null, null, null, null]);
  const soft = planned(body, plan(body, { wrap: 'soft', ...move('b6'), body: [1, 2, 3, 4, 5].map((n) => ({ block: `b${n}` })),
    blocks: { b6: { category: 'log', disposition: 'move' } } }));
  assert.ok(soft.template.startsWith('one two\n\n- item wrapped\n\n```\ncode\nlines\n```\n\n| a |\n| b |\n\n> quote\n> lines'));
  const kept = planned(body, plan(body, { wrap: 'keep', ...move('b1'), body: [2, 3, 4, 5, 6].map((n) => ({ block: `b${n}` })),
    blocks: { b1: { category: 'log', disposition: 'move' } } }));
  assert.ok(kept.parts[0].text.includes('one\ntwo'));
});

test('AC-4.5 a table without leading pipes and lines numbered like a later list item keep their lines', () => {
  const body = 'Name | Value\n---- | -----\nx | y\n\n**Ownership choices:**\n12. first\n13. second\n\nplain\nwrapped\n\n**bold\\\ntext** and [link  \nbreak](u)\n';
  assert.deepEqual(segment(body).blocks.map((b) => b.soft), [null, null, 'plain wrapped', null]);
});

test('AC-4.5 each block is placed exactly where its disposition says', () => {
  const twice = plan(BODY, { ...move('b5'), blocks: { b5: { category: 'history', disposition: 'move' } } });
  refused(BODY, twice, /once in the archive, found body/);
  refused(BODY, plan(BODY, { body: [{ block: 'b1' }, { block: 'b2' }, { block: 'b4' }, { block: 'b5' }] }), /once in the body, found nowhere/);
  refused(BODY, plan(BODY, { level: 'less', blocks: { b3: { category: 'log', disposition: 'condense' } } }), /nowhere, found body/);
  refused(BODY, plan(BODY, { body: [{ block: 'b9' }] }), /b9/);
  const folded = plan(BODY, { body: [{ block: 'b1' }, { block: 'b2' }, { block: 'b3' }, { block: 'b4' }, { block: 'b5' }],
    blocks: { b3: { category: 'log', disposition: 'fold' } } });
  refused(BODY, folded, /not inside <details>/);
  const inside = { ...folded, body: [{ block: 'b1' }, { text: '<details><summary>Log</summary>' }, { block: 'b2' }, { text: '</details>' }, { block: 'b3' }] };
  refused(BODY, inside, /keep but inside/);
});

// AC-4.6 — sizes

test('AC-4.6 an issue body over the limit is refused; a discussion body may not grow past it', () => {
  const big = `${'x'.repeat(LIMIT)}\n`;
  assert.equal(assemble({ body: big, plan: plan(big) }).action, 'no-change');
  refused(big, plan(big, { body: [{ block: 'b1' }, { text: 'more' }] }), /over its limit/);
  const discussion = { target: { kind: 'discussion', number: 7 } };
  assert.equal(assemble({ body: big, plan: plan(big, discussion) }).action, 'no-change');
  const grown = plan(big, { ...discussion, body: [{ block: 'b1' }, { text: 'more' }] });
  refused(big, grown, /over its limit/);
});

test('AC-4.6 a move larger than one part is split between blocks; one block over a part is refused', () => {
  const chunk = 'y'.repeat(30000);
  const body = `${chunk}\n\n${chunk}\n\n${chunk}\n\nlast\n`;
  const p = plan(body, { archives: [{ title: 'Log', items: [{ block: 'b1' }, { block: 'b2' }, { block: 'b3' }] }],
    body: [{ text: 'Moved: {{part:1}} {{part:2}}' }, { block: 'b4' }],
    blocks: Object.fromEntries(['b1', 'b2', 'b3'].map((id) => [id, { category: 'log', disposition: 'move', note: true }])) });
  const result = planned(body, p);
  assert.equal(result.parts.length, 2);
  assert.match(result.parts[1].text, /^<!-- dev-compact:archive kind=issue n=7 part=2\/2 -->\n\nLog \(continued\)/);
  const huge = `${'z'.repeat(LIMIT)}\n\nend\n`;
  refused(huge, plan(huge, { ...move('b1'), body: [{ block: 'b2' }], blocks: { b1: { category: 'log', disposition: 'move' } } }), /archive part 1/);
});

// AC-4.7 — handles

test('AC-4.7 handles are neutralized in parts; new body text and outgoing text may not carry one', () => {
  const body = 'Asked @agent-bot and @someone-1 in `@agent-bot`.\n\nKeep.\n';
  const result = planned(body, plan(body, { ...move('b1'), body: [{ text: 'See {{part:1}}' }, { block: 'b2' }],
    blocks: { b1: { category: 'log', disposition: 'move' } } }));
  assert.equal(hasHandle(result.parts[0].text), false);
  assert.ok(result.parts[0].text.includes('@⁠agent-bot and @⁠someone-1 in `@⁠agent-bot`'));
  refused(body, plan(body, { body: [{ block: 'b1' }, { text: 'thanks @agent-bot' }, { block: 'b2' }] }), /live @handle/);
  assert.equal(vetOutgoing('ping @owner').action, 'stop');
  assert.equal(vetOutgoing('ping @⁠owner, mail a@ or `x@`').action, 'proceed');
  assert.equal(vetOutgoing('x'.repeat(LIMIT + 1)).action, 'stop');
});

// The calls table

test('D6 a written body ends with the calls table, keeping earlier rows verbatim', () => {
  const p = plan(BODY, { ...move('b5'), level: 'medium', body: [1, 2, 3, 4].map((n) => ({ block: `b${n}` })).concat({ text: 'History: {{part:1}}' }),
    blocks: { b5: { category: 'history', disposition: 'move' } } });
  const first = render({ template: planned(BODY, p).template, parts: 1, links: [`https://github.com/${REPO}/issues/7#issuecomment-1`], repo: REPO });
  assert.match(first.body, /<!-- dev-compact:calls:begin -->[\s\S]*\| `dev-compact` \| 2026-10-15 11:30 UTC \| `medium` \| \d+ \| \d+ \|\n\n<!-- dev-compact:calls:end -->\n$/);
  assert.ok(first.body.includes(`| ${BODY.length} | ${first.body.length} |`));
  const again = plan(first.body, { time: '2026-10-16 09:00 UTC', ...move('b3'), body: [1, 2, 4, 5].map((n) => ({ block: `b${n}` })),
    blocks: { b3: { category: 'log', disposition: 'move' } } });
  const second = planned(first.body, again).template;
  assert.ok(second.includes('| `dev-compact` | 2026-10-15 11:30 UTC |'));
  assert.ok(second.includes('| `dev-compact` | 2026-10-16 09:00 UTC | `none` |'));
  assert.equal(assemble({ body: first.body, plan: plan(first.body) }).action, 'no-change');
  refused(first.body, plan(first.body, { blocks: { b7: { category: 'protected', disposition: 'keep' } } }), /b7/);
  assert.equal(assemble({ body: `${first.body}\nafter\n`, plan: plan(BODY) }).action, 'stop');
});

// AC-5.2 / AC-5.3 — render only with every link; byte-identical read-backs

test('AC-5.2 the body renders only once every archive part has a permalink', () => {
  const template = 'See {{part:1}} and {{part:2}}.\n';
  assert.equal(render({ template, parts: 2, links: [`https://github.com/${REPO}/issues/7#issuecomment-1`], repo: REPO }).reason, 'missing-link');
  assert.equal(render({ template, parts: 2, links: ['https://example.com/x', `https://github.com/${REPO}/discussions/3#discussioncomment-4`], repo: REPO }).reason, 'bad-link');
  const done = render({ template, parts: 2, links: [`https://github.com/${REPO}/pull/7#issuecomment-1`, `https://github.com/${REPO}/discussions/3#discussioncomment-4`], repo: REPO });
  assert.equal(done.body, `See https://github.com/${REPO}/pull/7#issuecomment-1 and https://github.com/${REPO}/discussions/3#discussioncomment-4.\n`);
});

test('AC-5.3 a read-back proceeds only when byte-identical', () => {
  assert.equal(verifyBytes('abc\n', 'abc\n').action, 'proceed');
  assert.match(verifyBytes('abc\n', 'abd\n').detail, /character 2/);
  assert.equal(verifyBytes('abc', 'abc\n').action, 'stop');
});

// AC-5.4 — placement

test('AC-5.4 an archive part is a reply only in a discussion', () => {
  const p = (kind) => plan(BODY, { target: { kind, number: 7 }, archives: [{ title: 'Log', items: [{ block: 'b3' }], replyTo: 'DC_kw1' }],
    body: [{ block: 'b1' }, { block: 'b2' }, { text: 'Log: {{part:1}}' }, { block: 'b4' }, { block: 'b5' }], blocks: { b3: { category: 'log', disposition: 'move' } } });
  assert.equal(planned(BODY, p('discussion')).parts[0].replyTo, 'DC_kw1');
  for (const kind of ['issue', 'pr']) refused(BODY, p(kind), /reply only in a discussion/);
});

// AC-5.5 — hides

test('AC-5.5 only a discussion comment by the running login, or one a note names, may be hidden', () => {
  const hide = (over) => ({ id: 'DC_1', author: 'me', classifier: 'RESOLVED', ...over });
  const discussion = { target: { kind: 'discussion', number: 7 } };
  assert.equal(assemble({ body: BODY, plan: plan(BODY, { ...discussion, hides: [hide()] }) }).action, 'no-change');
  refused(BODY, plan(BODY, { hides: [hide()] }), /only in a discussion/);
  refused(BODY, plan(BODY, { ...discussion, hides: [hide({ author: 'other' })] }), /only a note/);
  assert.equal(assemble({ body: BODY, plan: plan(BODY, { ...discussion, hides: [hide({ author: 'other', note: true })] }) }).action, 'no-change');
  refused(BODY, plan(BODY, { ...discussion, hides: [hide({ classifier: 'SPAM' })] }), /classifier/);
});

// AC-5.6 — writes to other artifacts reuse dev-explain's append and label rules

test('AC-5.6 an addition lands after the body and outside AUTO regions; protected workflow labels are refused', () => {
  assert.equal(planAppend({ before: 'a\n<!-- AUTO:BEGIN -->\nb\n', addition: 'c' }).action, 'stop');
  assert.equal(planAppend({ before: 'a\n', addition: 'Batch table' }).body, 'a\n\nBatch table');
  const labels = vetLabels({ live: ['ai:ready', 'area:skills'], current: [], add: ['ai:ready', 'area:skills'], remove: [] });
  assert.deepEqual(labels.apply.add, ['area:skills']);
  assert.equal(labels.refused[0].label, 'ai:ready');
  assert.equal(vetOutgoing('Batch table for @owner').action, 'stop');
});

// CLI boundary

test('CLI: plan writes the template, parts and manifest; a refusal exits 1 and a malformed input exits 2', () => {
  const body = file('body.md', BODY);
  const p = plan(BODY, { ...move('b3'), body: [{ block: 'b1' }, { block: 'b2' }, { text: 'Log: {{part:1}}' }, { block: 'b4' }, { block: 'b5' }],
    blocks: { b3: { category: 'log', disposition: 'move' } } });
  const out = join(scratch, 'out');
  const ok = cli('plan', '--body', body, '--plan', file('plan.json', JSON.stringify(p)), '--out', out);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).parts, 1);
  const links = file('links.json', JSON.stringify([`https://github.com/${REPO}/issues/7#issuecomment-9`]));
  assert.equal(cli('render', '--dir', out, '--links', links, '--out', join(scratch, 'new.md')).status, 0);
  assert.match(readFileSync(join(scratch, 'new.md'), 'utf8'), /Log: https:\/\/github\.com\/.*#issuecomment-9/);
  writeFileSync(join(out, 'notes.txt'), 'not the helper\'s');
  assert.equal(cli('plan', '--body', body, '--plan', file('bad.json', JSON.stringify({ ...p, level: 'max' })), '--out', out).status, 2);
  assert.deepEqual(readdirSync(out), ['notes.txt']);
  assert.equal(cli('plan', '--body', body, '--plan', file('extra.json', JSON.stringify({ ...p, extra: 1 })), '--out', out).status, 2);
  assert.equal(cli('plan', '--body', body, '--plan', file('bad-disp.json', JSON.stringify(plan(BODY, { blocks: { b1: { category: 'current', disposition: 'shred' } } }))), '--out', out).status, 1);
  assert.equal(cli('segment', '--body', file('open.md', '<!-- AUTO:BEGIN -->\n')).status, 1);
  assert.equal(cli('frobnicate').status, 2);
  assert.equal(cli('args', '--input', file('args.json', JSON.stringify({ repo: REPO, text: '#5 level=less notes' }))).status, 0);
  assert.equal(cli('outgoing', '--file', file('out.md', 'hi @someone')).status, 1);
  assert.equal(cli('neutralize', '--file', join(scratch, 'out.md'), '--out', join(scratch, 'safe.md')).status, 0);
  assert.equal(cli('outgoing', '--file', join(scratch, 'safe.md')).status, 0);
  assert.equal(cli('verify', '--expected', body, '--actual', body).status, 0);
});
