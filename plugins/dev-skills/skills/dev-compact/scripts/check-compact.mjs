import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromMarkdown } from 'mdast-util-from-markdown';

// Deterministic decisions for dev-compact: resolving the invocation, segmenting a body, checking a plan and
// assembling its body and archive parts, rendering the linked body, and vetting outgoing text. Categories,
// summaries and whether a comment is resolved stay with the procedure. Exit 0 proceeds, 1 stops or refuses,
// and 2 means the check did not run, which never counts as a pass.

export const LEVELS = ['none', 'less', 'medium', 'most'];
export const DEFAULTS = { level: 'none', threshold: 49152, wrap: 'soft' };
// GitHub refuses an issue or PR body, or any comment, longer than this.
export const LIMIT = 65536;
const K = 'keep', F = 'fold', M = 'move', S = 'summarize', C = 'condense', D = 'discard';
const LOSSLESS = [K, F, M];
export const ALLOWED = {
  none: { current: LOSSLESS, history: LOSSLESS, log: LOSSLESS },
  less: { current: LOSSLESS, history: [...LOSSLESS, S], log: [...LOSSLESS, S, C, D] },
  medium: { current: [...LOSSLESS, S], history: [...LOSSLESS, S, C, D], log: [...LOSSLESS, S, C, D] },
  most: { current: [...LOSSLESS, S], history: [M, D], log: [M, D] },
};
const CATEGORIES = ['protected', 'current', 'history', 'log'];
const PLACE = { [K]: 'body', [F]: 'body', [M]: 'archive', [S]: 'archive', [C]: null, [D]: null };
const CLASSIFIERS = ['RESOLVED', 'OUTDATED', 'DUPLICATE'];
// A rendered part link is never longer than this; the plan reserves it for every placeholder.
const LINK_ALLOWANCE = 160;
const PART = /\{\{part:(\d+)\}\}/g;
const SIZE = '{{size:after}}';
// render fills these wherever they stand, so they may appear only in text this run writes into the body.
const PLACEHOLDER = /\{\{(?:part:\d+|size:after)\}\}/;
// GitHub links `@` followed by a login character as a mention, and mention-triggered agent workflows match
// the raw text even in code. A word joiner after `@` renders identically and links nothing.
const HANDLE = /@(?=[A-Za-z0-9])/g;
// `<!-- NAME:begin … -->` and `<!-- NAME:end … -->` in any letter case enclose a section another tool
// maintains, such as an AUTO region or an `acs` block. Only the calls table is this skill's own.
const MARK = /^<!--\s*([A-Za-z][\w.:-]*?):(begin|end)\b.*-->$/i;
// A marker behind a quote or list-item prefix is still a marker, and one the helper cannot pair.
const CONTAINER = /^[ \t]*(?:(?:>|[-*+][ \t]|\d{1,9}[.)][ \t])[ \t]*)*/;
const CALLS = 'dev-compact:calls';
const TARGET_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull|discussions)\/([1-9]\d*)(#\S*)?$/;

const stop = (reason, detail, extra = {}) => ({ action: 'stop', reason, detail, ...extra });
export const hasHandle = (text) => /@[A-Za-z0-9]/.test(text);
export const neutralize = (text) => text.replace(HANDLE, '@\u2060');
const preview = (text) => text.replace(/\s+/g, ' ').slice(0, 80);

/** Parse the first token as the target, or explain why it is not one. */
export function parseTarget(token, repo) {
  const digits = /^#?([1-9]\d*)$/.exec(token)?.[1];
  if (digits && Number.isSafeInteger(Number(digits))) return { number: Number(digits), kind: 'any' };
  const url = TARGET_URL.exec(token);
  if (!url) return { error: `"${token}" is not N, #N or an issues, pull or discussions URL of ${repo}` };
  if (url[1].toLowerCase() !== repo.toLowerCase()) return { error: `"${token}" names ${url[1]}, not ${repo}` };
  const target = { number: Number(url[3]), kind: url[2] === 'discussions' ? 'discussion' : 'issue-or-pr' };
  return url[4] ? { ...target, warning: `ignored the URL fragment "${url[4]}"` } : target;
}

const CANONICAL = {
  level: (v) => (LEVELS.includes(v.toLowerCase()) ? v.toLowerCase() : null),
  threshold: (v) => (/^[1-9]\d*$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null),
  wrap: (v) => (['soft', 'keep'].includes(v.toLowerCase()) ? v.toLowerCase() : null),
};

/** The target comes first; options follow in any order; the first other token starts the notes. */
export function resolveArgs({ repo, text }) {
  const tokens = [...text.matchAll(/\S+/g)];
  if (tokens.length === 0) return stop('no-target', 'no target was given');
  const { warning, ...target } = parseTarget(tokens[0][0], repo);
  if (target.error) return stop('bad-target', target.error);
  const warnings = warning ? [warning] : [];
  const given = { level: [], threshold: [], wrap: [] };
  let [dryRun, notes] = [false, ''];
  for (const match of tokens.slice(1)) {
    const option = /^(level|threshold|wrap)=(.*)$/.exec(match[0]);
    if (option) given[option[1]].push(option[2]);
    else if (match[0] === 'dry-run') dryRun = true;
    else { notes = text.slice(match.index).trimEnd(); break; }
  }
  const near = dryRun ? null : /(?:^|[^\w-])(-*dry[-_ ]?run)\b/i.exec(notes);
  if (near) warnings.push(`the notes mention "${near[1]}", but only dry-run before the notes selects it, so this run applies`);
  const options = {};
  for (const [key, values] of Object.entries(given)) {
    const value = values.length === 1 ? CANONICAL[key](values[0]) : null;
    if (values.length > 1) warnings.push(`${key}= was given ${values.length} times; using ${DEFAULTS[key]}`);
    else if (values.length === 1 && value === null) warnings.push(`${key}="${values[0]}" is not valid; using ${DEFAULTS[key]}`);
    options[key] = value ?? DEFAULTS[key];
  }
  return { action: 'proceed', target, ...options, dryRun, notes, warnings };
}

// Soft wrap joins the line breaks inside a paragraph. A paragraph in a blockquote and one with a hard break
// keep their lines, and so does text this CommonMark parser reads as one paragraph but GitHub shows as rows:
// a table, with or without leading pipes, and lines numbered like a list that cannot interrupt a paragraph.
const ROWS = /^[ \t]*(?:\||\d{1,9}[.)][ \t])|^(?=.*\|)(?=.*-)[ \t|:-]+$/m;
const hasBreak = (n) => n.type === 'break' || (n.children ?? []).some(hasBreak);
function softText(node, body, start) {
  const edits = [];
  const walk = (n, quoted) => {
    if (n.type === 'paragraph' && !quoted && !hasBreak(n)) {
      const { start: { offset: from }, end: { offset: to } } = n.position;
      if (!ROWS.test(body.slice(from, to))) edits.push([from, to, body.slice(from, to).replace(/[ \t]*\r?\n[ \t]*/g, ' ')]);
    }
    for (const child of n.children ?? []) walk(child, quoted || n.type === 'blockquote');
  };
  walk(node, false);
  const raw = body.slice(start, node.position.end.offset);
  let text = raw;
  for (const [from, to, joined] of edits.reverse()) text = text.slice(0, from - start) + joined + text.slice(to - start);
  return text === raw ? null : text;
}

/** Pair the marker lines into outermost sections; a marker the parser does not read as its own line stops. */
function markedSections(body, tree) {
  const own = new Map(tree.children.filter((n) => n.type === 'html' && n.position.start.line === n.position.end.line)
    .map((n) => [n.position.start.line, n]));
  const problems = [];
  const sections = [];
  const open = [];
  body.split(/\r?\n/).forEach((line, index) => {
    const mark = MARK.exec(line.replace(CONTAINER, '').trim());
    if (!mark) return;
    const [name, edge, node, at] = [mark[1].toLowerCase(), mark[2].toLowerCase(), own.get(index + 1), `line ${index + 1}`];
    if (!node) return problems.push(`the ${name} marker on ${at} is not a top-level one-line HTML block`);
    if (edge === 'begin') {
      if (open.some((o) => o.name === name)) return problems.push(`a ${name} section opens inside another on ${at}`);
      return open.push({ name, at, start: node.position.start.offset });
    }
    if (open.at(-1)?.name !== name) return problems.push(`the ${name} end on ${at} does not close the innermost open section`);
    const { start } = open.pop();
    if (open.length === 0) sections.push({ name, start, end: node.position.end.offset });
  });
  for (const o of open) problems.push(`the ${o.name} section opened on ${o.at} is never closed`);
  if (sections.filter((s) => s.name === CALLS).length > 1) problems.push(`the body holds more than one ${CALLS} section`);
  return { sections, problems };
}

/** Split a body into blocks: top-level nodes, each top-level list item, and each marked section whole. */
export function segment(body) {
  const tree = fromMarkdown(body);
  const { sections, problems } = markedSections(body, tree);
  if (problems.length) return stop('unpaired-markers', problems.join('; '));
  const blocks = [];
  for (const node of tree.children.flatMap((n) => (n.type === 'list' ? n.children : [n]))) {
    const start = node.position.start.offset;
    const section = sections.find((s) => start >= s.start && start < s.end);
    if (section && blocks.at(-1)?.section === section) continue;
    const [from, end] = section ? [section.start, section.end] : [start, node.position.end.offset];
    const text = body.slice(from, end);
    const shape = section ? (section.name === CALLS ? 'calls' : 'marked') : text.includes('<!--') ? 'comment' : null;
    blocks.push({ section, start: from, end, text, shape, heading: node.type === 'heading', soft: shape ? null : softText(node, body, from) });
  }
  const lineOf = (offset) => body.slice(0, offset).split('\n').length;
  return { action: 'segment', head: body.slice(0, blocks[0]?.start ?? body.length),
    blocks: blocks.map(({ section, ...b }, i) => ({ id: `b${i + 1}`, lines: [lineOf(b.start), lineOf(b.end)],
      gap: i ? body.slice(blocks[i - 1].end, b.start) : '', ...b })),
    tail: body.slice(blocks.at(-1)?.end ?? body.length),
  };
}

/** Join items; consecutive original blocks keep their original separator. */
function joinItems(items, textOf, seg) {
  return items.map((item, i) => {
    const previous = items[i - 1];
    const adjacent = item.block && previous?.block && seg.index.get(item.block) === seg.index.get(previous.block) + 1;
    return (i === 0 ? '' : adjacent ? seg.byId.get(item.block).gap : '\n\n') + (item.block ? textOf(item.block) : item.text);
  }).join('');
}

/** The calls table: earlier rows verbatim, then this run's row with the final size filled at render. */
function callsSection(old, { time, level }, before) {
  const rows = (old?.text ?? '').split(/\r?\n/).filter((line) => line.startsWith('| `'));
  return [`<!-- ${CALLS}:begin -->`, '<sub>Body compactions by `dev-compact`, one row per run; earlier bodies are in the edit history.</sub>', '',
    '| Skill | Time | Level | Body before | Body after |', '|---|---|---|--:|--:|', ...rows,
    `| \`dev-compact\` | ${time} | \`${level}\` | ${before} | ${SIZE} |`, '', `<!-- ${CALLS}:end -->`].join('\n');
}

function blockRules(block, entry, places, plan, below) {
  const v = [];
  const { category, disposition } = entry;
  if (!CATEGORIES.includes(category) || !Object.hasOwn(PLACE, disposition)) return [`${block.id} has an unknown category "${category}" or disposition "${disposition}"`];
  if (block.shape && category !== 'protected') v.push(`${block.id} holds a ${block.shape} marker and must be protected`);
  const allowed = category === 'protected' ? disposition === K : ALLOWED[plan.level][category].includes(disposition);
  if (!allowed) v.push(`${block.id}: ${disposition} is not allowed for ${category} at level ${plan.level}`);
  if (block.heading && ['none', 'less'].includes(plan.level) && disposition !== K) v.push(`${block.id} is a heading and must be kept at level ${plan.level}`);
  if (below && disposition !== K && entry.note !== true) v.push(`${block.id}: the body is below the threshold, so only a note may change it`);
  if (PLACE[disposition] === 'body' && PLACEHOLDER.test(block.text)) v.push(`${block.id} quotes a {{part:N}} or ${SIZE} placeholder, which render would fill`);
  const wanted = PLACE[disposition];
  if (places.length !== (wanted ? 1 : 0) || (wanted && !places[0].startsWith(wanted))) {
    v.push(`${block.id} (${disposition}) must appear ${wanted ? `once in the ${wanted}` : 'nowhere'}, found ${places.join(', ') || 'nowhere'}`);
  }
  return v;
}

/** Check a plan against the body it was made from and assemble the body template and archive parts. */
export function assemble({ body, plan }) {
  const seg = segment(body);
  if (seg.action === 'stop') return seg;
  seg.index = new Map(seg.blocks.map((b, i) => [b.id, i]));
  seg.byId = new Map(seg.blocks.map((b) => [b.id, b]));
  const calls = seg.blocks.find((b) => b.shape === 'calls' && b.end === seg.blocks.at(-1).end);
  if (seg.blocks.some((b) => b.shape === 'calls' && b !== calls)) return stop('calls-not-last', `the ${CALLS} section is not the body's last block`);
  const v = calls && PLACEHOLDER.test(calls.text) ? [`the ${CALLS} section quotes a placeholder, which render would fill`] : [];
  const below = body.length < plan.threshold;
  const where = new Map(seg.blocks.map((b) => [b.id, []]));
  const place = (item, at) => item.block !== undefined && (item.block === calls?.id || !where.has(item.block)
    ? v.push(`an item names ${item.block}, which the plan may not place`) : where.get(item.block).push(at));
  plan.body.forEach((item, i) => place(item, `body:${i}`));
  plan.archives.forEach((group, g) => group.items.forEach((item) => place(item, `archive:${g}`)));
  for (const id of Object.keys(plan.blocks)) if (!where.has(id) || id === calls?.id) v.push(`${id} is not a block the plan may cover`);
  for (const block of seg.blocks.filter((b) => b !== calls)) {
    v.push(...(plan.blocks[block.id] ? blockRules(block, plan.blocks[block.id], where.get(block.id), plan, below) : [`${block.id} has no plan entry`]));
  }
  // fold sits inside <details>, keep outside; text the run writes into the body carries no comment or handle.
  let depth = 0;
  const order = [];
  for (const item of plan.body) {
    const entry = plan.blocks[item.block];
    if (item.text !== undefined) {
      const bad = [item.text.includes('<!--') && 'an HTML comment', hasHandle(item.text) && 'a live @handle', item.text.includes(SIZE) && SIZE];
      if (bad.some(Boolean)) v.push(`body text written by the run contains ${bad.filter(Boolean).join(', ')}`);
      depth += (item.text.match(/<details\b/g) ?? []).length - (item.text.match(/<\/details>/g) ?? []).length;
    } else if (entry?.disposition === F && depth <= 0) v.push(`${item.block} is fold but not inside <details>`);
    else if (entry?.disposition === K && depth > 0) v.push(`${item.block} is keep but inside <details>`);
    if (entry?.category === 'protected') order.push(seg.index.get(item.block));
  }
  const ascending = (list) => list.every((n, i) => !i || n > list[i - 1]);
  if (!ascending(order)) v.push('protected blocks are out of their original order');
  if (plan.archives.some((g) => PLACEHOLDER.test(g.title) || g.items.some((i) => PLACEHOLDER.test(i.text ?? '')))) v.push('archive text the run writes holds a placeholder, which nothing fills');
  // Below the threshold only a note may change the body: a block's disposition, its place, or added text.
  if (below && [...plan.body, ...plan.archives.flatMap((g) => g.items)].some((i) => i.text !== undefined && i.note !== true)) v.push('the body is below the threshold, so only a note may add text');
  if (below && !ascending(plan.body.filter((i) => i.block && plan.blocks[i.block]?.note !== true).map((i) => seg.index.get(i.block)))) v.push('the body is below the threshold, so only a note may reorder it');
  // Discussions nest one level, so only there may a part be a reply; elsewhere it is top-level and links instead.
  if (plan.target.kind !== 'discussion' && plan.archives.some((g) => g.replyTo)) v.push('an archive part is a reply only in a discussion');
  for (const hide of plan.hides) {
    if (plan.target.kind !== 'discussion') v.push(`comment ${hide.id}: comments are hidden only in a discussion`);
    else if (!CLASSIFIERS.includes(hide.classifier)) v.push(`comment ${hide.id}: classifier "${hide.classifier}" is not allowed`);
    else if (hide.author !== plan.login && hide.note !== true) v.push(`comment ${hide.id} is by ${hide.author}; only a note may hide it`);
  }
  // Protected blocks never change; others take their soft-wrapped form under wrap=soft, above the threshold.
  const soft = plan.wrap === 'soft' && !below;
  const textOf = (id) => (soft && plan.blocks[id]?.category !== 'protected' && seg.byId.get(id).soft) || seg.byId.get(id).text;
  const chunks = [];
  plan.archives.forEach((group, g) => {
    let current = null;
    for (const item of group.items) {
      const size = (item.block && where.has(item.block) ? textOf(item.block) : item.text ?? '').length + 2;
      // A part is split only between items; one item larger than a part is refused below.
      if (!current || (current.items.length && current.size + size > LIMIT - 400 - group.title.length)) {
        chunks.push(current = { group: g, items: [], size: 0, continued: Boolean(current) });
      }
      current.items.push(item);
      current.size += size;
    }
  });
  if (v.length) return stop('plan-refused', `${v.length} violation(s)`, { violations: v });
  const parts = chunks.map((chunk, i) => {
    const { title, replyTo = null } = plan.archives[chunk.group];
    const marker = `<!-- dev-compact:archive kind=${plan.target.kind} n=${plan.target.number} part=${i + 1}/${chunks.length} -->`;
    return { replyTo, text: neutralize(`${marker}\n\n${title}${chunk.continued ? ' (continued)' : ''}\n\n${joinItems(chunk.items, textOf, seg)}\n`) };
  });
  parts.forEach((part, i) => part.text.length > LIMIT && v.push(`archive part ${i + 1} is ${part.text.length} characters, over ${LIMIT}`));
  const first = plan.body[0]?.block === seg.blocks[0]?.id;
  const kept = joinItems(plan.body, textOf, seg);
  const last = plan.body.at(-1)?.block === seg.blocks.filter((b) => b !== calls).at(-1)?.id;
  // Unchanged means the same bytes apart from the calls table, which only a written body gains a row in.
  const unchanged = (first ? seg.head : '') + kept + (last && !calls ? seg.tail : '');
  if (parts.length === 0 && unchanged === (calls ? body.slice(0, calls.start - calls.gap.length) : body)) {
    return { action: 'no-change', belowThreshold: below, size: { before: body.length }, hides: plan.hides };
  }
  const template = `${(first ? seg.head : '') + kept}\n\n${callsSection(calls, plan, body.length)}\n`;
  const links = [...template.matchAll(PART)];
  for (const [, n] of links) if (Number(n) < 1 || Number(n) > parts.length) v.push(`{{part:${n}}} names no archive part`);
  const bound = template.length + links.reduce((sum, [match]) => sum + LINK_ALLOWANCE - match.length, 0);
  const limit = plan.target.kind === 'discussion' ? Math.max(LIMIT, body.length) : LIMIT;
  if (bound > limit) v.push(`the new body may reach ${bound} characters, over its limit of ${limit}`);
  if (v.length) return stop('plan-refused', `${v.length} violation(s)`, { violations: v });
  const changed = seg.blocks.filter((b) => [S, C, D].includes(plan.blocks[b.id]?.disposition))
    .map((b) => ({ id: b.id, disposition: plan.blocks[b.id].disposition, size: b.text.length, preview: preview(b.text) }));
  return { action: 'plan', belowThreshold: below, size: { before: body.length, afterAtMost: bound }, parts, template, changed, hides: plan.hides };
}

/** Fill the part links and the final size. Every part must already be posted, so a missing link stops. */
export function render({ template, parts, links, repo }) {
  const permalink = new RegExp(`^https://github\\.com/${repo.replace(/\./g, '\\.')}/(?:(?:issues|pull)/\\d+#issuecomment-|discussions/\\d+#discussioncomment-)\\d+$`, 'i');
  if (links.length !== parts) return stop('missing-link', `${parts} part(s) were planned but ${links.length} link(s) were given`);
  const bad = links.filter((link) => !permalink.test(link) || link.length > LINK_ALLOWANCE);
  if (bad.length) return stop('bad-link', `not a comment permalink of ${repo}: ${bad.join(', ')}`);
  const linked = template.replace(PART, (_, n) => links[Number(n) - 1]);
  // The row states the body's own final length, so pick the digit count that is self-consistent.
  const base = linked.length - SIZE.length;
  const size = [1, 2, 3, 4, 5, 6].map((d) => base + d).find((n) => String(n).length === n - base);
  return { action: 'render', body: linked.replace(SIZE, String(size)) };
}

/** A comment or appended text the run posts: within GitHub's limit and without a live handle. */
export function vetOutgoing(text) {
  const problems = [text.length > LIMIT && `${text.length} characters, over ${LIMIT}`, hasHandle(text) && 'a live @handle'].filter(Boolean);
  return problems.length ? stop('outgoing-refused', problems.join('; ')) : { action: 'proceed', size: text.length };
}

/** A read-back must equal the planned bytes exactly. */
export function verifyBytes(expected, actual) {
  let at = 0;
  while (at < expected.length && expected[at] === actual[at]) at += 1;
  return expected === actual ? { action: 'proceed' } : stop('mismatch', `the texts differ from character ${at}`);
}

class InputError extends Error {}
const fail = (message) => { throw new InputError(message); };
const COMMANDS = {
  args: ['input'], segment: ['body'], plan: ['body', 'plan', 'out'], render: ['dir', 'links', 'out'],
  neutralize: ['file', 'out'], outgoing: ['file'], verify: ['expected', 'actual'],
};
const isString = (x) => typeof x === 'string';
const isItems = (x) => Array.isArray(x) && x.every((i) => i && (Object.keys(i).join() === 'block' ? isString(i.block)
  : isString(i.text) && Object.keys(i).every((k) => k === 'text' || (k === 'note' && i.note === true))));
const json = (path, flag) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { return fail(`--${flag} is not readable JSON: ${e.message}`); } };
const object = (x, keys, label, open = false) => {
  if (!x || typeof x !== 'object' || Array.isArray(x)) fail(`${label} must be a JSON object`);
  const known = keys.map((k) => k.replace(/\?$/, ''));
  for (const key of Object.keys(x)) if (!open && !known.includes(key)) fail(`${label} has the unknown key "${key}"`);
  for (const key of keys.filter((k) => !k.endsWith('?'))) if (!Object.hasOwn(x, key)) fail(`${label} lacks "${key}"`);
  return x;
};
const REPO = /^[\w.-]+\/[\w.-]+$/;
// Before any input is read, remove only what an earlier plan wrote, so a stopped plan leaves no stale template.
const OWN = /^(?:part-\d+\.md|body\.template\.md|manifest\.json)$/;
const clearOut = (dir) => existsSync(dir) && readdirSync(dir).filter((f) => OWN.test(f)).forEach((f) => rmSync(join(dir, f)));

function readPlan(plan) {
  object(plan, ['repo', 'target', 'login', 'time', 'level', 'wrap', 'threshold', 'blocks', 'body', 'archives', 'hides'], 'plan');
  object(plan.target, ['kind', 'number'], 'plan.target');
  const ok = isString(plan.repo) && REPO.test(plan.repo) && ['issue', 'pr', 'discussion'].includes(plan.target.kind)
    && Number.isSafeInteger(plan.target.number) && plan.target.number > 0 && isString(plan.login)
    && isString(plan.time) && /^\d{4}-\d\d-\d\d \d\d:\d\d UTC$/.test(plan.time) && LEVELS.includes(plan.level)
    && ['soft', 'keep'].includes(plan.wrap) && Number.isSafeInteger(plan.threshold) && plan.threshold > 0
    && isItems(plan.body) && Array.isArray(plan.archives) && Array.isArray(plan.hides);
  if (!ok) fail('plan has a value of the wrong type; see references/plan.md');
  for (const [id, entry] of Object.entries(object(plan.blocks, [], 'plan.blocks', true))) object(entry, ['category', 'disposition', 'note?'], `plan.blocks.${id}`);
  for (const g of plan.archives) object(g, ['title', 'items', 'replyTo?'], 'an archive');
  const valid = (g) => isString(g.title) && isItems(g.items) && (g.replyTo === undefined || (isString(g.replyTo) && g.replyTo !== ''));
  if (!plan.archives.every(valid)) fail('an archive needs a string title, items and an optional replyTo node ID');
  for (const hide of plan.hides) object(hide, ['id', 'author', 'classifier', 'note?'], 'a hide');
  return plan;
}

/** Parse argv into a validated command input, or throw InputError. Nothing downstream re-checks shapes. */
export function readInput(argv) {
  const [command, ...args] = argv;
  const flags = Object.hasOwn(COMMANDS, command ?? '') ? COMMANDS[command] : fail('unknown or missing command');
  if (args.length !== flags.length * 2) fail(`${command} takes exactly ${flags.map((f) => `--${f} VALUE`).join(' ')}`);
  const given = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !flags.includes(flag) || Object.hasOwn(given, flag)) fail(`${command} does not accept ${args[i]} here`);
    given[flag] = args[i + 1];
  }
  const text = (flag) => readFileSync(given[flag], 'utf8');
  if (command === 'args') {
    const input = object(json(given.input, 'input'), ['repo', 'text'], 'input');
    if (!isString(input.repo) || !REPO.test(input.repo) || !isString(input.text)) fail('input needs string "repo" (owner/name) and "text"');
    return { command, input };
  }
  if (command === 'plan') {
    clearOut(given.out);
    return { command, input: { body: text('body'), plan: readPlan(json(given.plan, 'plan')) }, out: given.out };
  }
  if (command === 'render') {
    const manifest = object(json(join(given.dir, 'manifest.json'), 'dir'), ['repo', 'parts'], 'manifest');
    const links = json(given.links, 'links');
    if (!Array.isArray(links) || !links.every(isString)) fail('--links must hold a JSON array of strings');
    return { command, input: { template: readFileSync(join(given.dir, 'body.template.md'), 'utf8'), parts: manifest.parts, links, repo: manifest.repo }, out: given.out };
  }
  if (command === 'verify') return { command, input: [text('expected'), text('actual')] };
  if (command === 'neutralize') return { command, input: text('file'), out: given.out };
  return { command, input: text(command === 'segment' ? 'body' : 'file') };
}

const run = {
  args: resolveArgs,
  segment: (body) => {
    const result = segment(body);
    return result.action === 'stop' ? result : { action: 'segment', blocks: result.blocks.map(({ id, lines, shape, heading, soft, text }) => ({
      id, lines, shape, heading, soft: Boolean(soft), size: text.length, preview: preview(text) })) };
  },
  plan: ({ body, plan }, out) => {
    const result = assemble({ body, plan });
    if (result.action !== 'plan') return result;
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'body.template.md'), result.template);
    result.parts.forEach((part, i) => writeFileSync(join(out, `part-${i + 1}.md`), part.text));
    writeFileSync(join(out, 'manifest.json'), JSON.stringify({ repo: plan.repo, parts: result.parts.length }));
    const { template, parts, ...summary } = result;
    return { ...summary, out, parts: parts.map((p, i) => ({ file: join(out, `part-${i + 1}.md`), replyTo: p.replyTo, size: p.text.length })) };
  },
  render: (input, out) => {
    const result = render(input);
    if (result.action === 'render') writeFileSync(out, result.body);
    return result.action === 'render' ? { action: 'render', out, size: result.body.length } : result;
  },
  neutralize: (text, out) => { writeFileSync(out, neutralize(text)); return { action: 'neutralize', out }; },
  outgoing: vetOutgoing,
  verify: ([expected, actual]) => verifyBytes(expected, actual),
};

export function main(argv) {
  let result;
  try {
    const { command, input, out } = readInput(argv);
    result = run[command](input, out);
  } catch (error) {
    console.error(`check-compact: ${error.message}`);
    if (error instanceof InputError) {
      console.error(`Usage: node check-compact.mjs ${Object.entries(COMMANDS).map(([name, flags]) => `${name} ${flags.map((f) => `--${f} VALUE`).join(' ')}`).join(' | ')}`);
    }
    return 2;
  }
  console.log(JSON.stringify(result));
  return result.action === 'stop' ? 1 : 0;
}

function isDirectInvocation(entryPath) {
  try { return Boolean(entryPath) && realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isDirectInvocation(process.argv[1])) process.exitCode = main(process.argv.slice(2));
