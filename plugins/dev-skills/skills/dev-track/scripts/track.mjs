import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fromMarkdown } from 'mdast-util-from-markdown';

// Deterministic parts of dev-track: locate the tracker, list pending threads, rebuild a body, swap the
// title's status prefix, add or remove the tracker mark. Reads `gh api graphql --paginate --slurp` output and
// local files; never calls GitHub. Exit 0 proceeds, 1 refuses (reason in the JSON output), 2 means bad
// arguments or an unreadable file.

const parsed = new Map();

// `text`'s lines (ends kept), the indexes of lines inside code blocks, and each top-level ATX `##` heading's
// name by line index. A code block quotes an example: never a mark, never a section.
function parse(text) {
  if (parsed.has(text)) return parsed.get(text);
  const lines = text.match(/[^\r\n]*(?:\r\n?|\n)|[^\r\n]+$/g) ?? [];
  const tree = fromMarkdown(text);
  const code = new Set();
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (node.type === 'code') {
      for (let line = node.position.start.line; line <= node.position.end.line; line++) code.add(line - 1);
    }
    if (node.children) pending.push(...node.children);
  }
  const heads = new Map();
  for (const node of tree.children) {
    const i = node.position.start.line - 1;
    // A setext heading's first line never opens with `## `, so this keeps the ATX ones only.
    if (node.type === 'heading' && node.depth === 2 && /^ {0,3}##(?:[ \t\r\n]|$)/.test(lines[i])) {
      const first = node.children[0], last = node.children.at(-1);
      heads.set(i, first ? text.slice(first.position.start.offset, last.position.end.offset) : '');
    }
  }
  const result = { lines, code, heads };
  parsed.set(text, result);
  return result;
}

// `text` without its code blocks.
function prose(text) {
  const { lines, code } = parse(text ?? '');
  return lines.filter((_, i) => !code.has(i)).join('');
}

// A live mark is a whole line of its own; CRLF bodies from the web keep their `\r`. `^` and `$` are spelled
// out because JavaScript's multiline anchors also break at a lone `\r`.
const markRe = (...prefixes) =>
  new RegExp(`(?<![^\\n])(?:${prefixes.join('|')})[^\\n]*-->[^\\S\\n]*(?![^\\n])\\n?`);

// `text` without the live match of `pattern`; an example in a code block stays.
function dropMarks(pattern, text) {
  const { lines, code } = parse(text);
  return lines.map((line, i) => (code.has(i) ? line : line.replace(pattern, ''))).join('');
}

// cat is the English playbook key; category is the discussion category the tracker collects.
const TRACKER_RE = /(?<![^\n])<!-- dev-track:tracker cat=([a-z0-9-]+) category=([^\n]+?) -->[^\S\n]*(?![^\n])\n?/;
const LEGACY_TRACKER = markRe('<!-- dev-meeting-notes:tracker');
const LEGACY_SERIES = ['meetings', 'meeting-notes'];
const DONE_RE = markRe('<!-- dev-track:done', '<!-- dev-meeting-notes:done');
const STATUS_RE = /^(?:[⬜⏳✅⚠❌🔀🔄⛔]️?\s*)+/u;
const KEY_RE = /^[a-z0-9-]+$/;
const BODY_LIMIT = 65536; // GitHub refuses a discussion body longer than this

// Close to Python's casefold, which the original compared with: `ß` matches `ss`.
const norm = (text) => (text || '').trim().toUpperCase().toLowerCase();

// Python's repr() of a string, which the reasons quote values with.
function repr(text) {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  const named = { '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r', [quote]: `\\${quote}` };
  return quote + text.replace(/[\\'"\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/gu, (c) => {
    if (named[c]) return named[c];
    if (c === ' ' || c === "'" || c === '"') return c;
    const code = c.codePointAt(0), hex = code.toString(16);
    return code < 0x100 ? `\\x${hex.padStart(2, '0')}` : code < 0x10000 ? `\\u${hex.padStart(4, '0')}` : `\\U${hex.padStart(8, '0')}`;
  }) + quote;
}

// [cat, category] from the node's tracker mark, or null.
export function trackerOf(node) {
  const body = prose(node?.body);
  const match = body.match(TRACKER_RE);
  if (match) return [match[1], match[2].trim()];
  return LEGACY_TRACKER.test(body) ? [...LEGACY_SERIES] : null;
}

const inCat = (node, category) => {
  const own = node.category || {};
  return [norm(own.name), norm(own.slug)].includes(norm(category));
};

// The category name that `text` names, by name or slug.
function categoryNamed(cats, text) {
  const found = text ? cats.find((c) => [norm(c.name), norm(c.slug)].includes(norm(text))) : undefined;
  return found?.name ?? null;
}

// `--cat` finds a tracker by its English key or by its category's name or slug.
function matches(cats, tracker, query) {
  if (!tracker || !query) return false;
  const [key, category] = tracker;
  const named = categoryNamed(cats, query);
  return [key, norm(category)].includes(norm(query)) || (Boolean(named) && named === categoryNamed(cats, category));
}

export const isDone = (node) => DONE_RE.test(prose(node.body));

export const brief = (node) =>
  Object.fromEntries(['id', 'number', 'title', 'url', 'closed', 'createdAt'].map((key) => [key, node[key] ?? null]));

function listed(node) {
  const [key, category] = trackerOf(node);
  return { ...brief(node), cat: key, category };
}

// [cat, category] with the category resolved by name or slug, as one comparable string.
function seriesOf(cats, node) {
  const [key, category] = trackerOf(node);
  return JSON.stringify([key, norm(categoryNamed(cats, category) || category)]);
}

// Another tracker with the same cat and category.
export const hasDuplicate = (cats, trackers, one) =>
  trackers.some((n) => n !== one && seriesOf(cats, n) === seriesOf(cats, one));

const byAge = (nodes) => [...nodes].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

function flowF1(nodes, tracker, only, cats) {
  const [key, category] = trackerOf(tracker);
  const members = nodes.filter((n) => inCat(n, category) && !trackerOf(n));
  let pending;
  if (only != null) {
    const picked = members.find((n) => n.number === only);
    if (!picked) return { flow: 'error', reason: `#${only} is not in category ${repr(category)}, or is a tracker` };
    pending = [{ ...brief(picked), redo: isDone(picked) }];
  } else {
    pending = byAge(members).filter((n) => !isDone(n) && !n.closed).map(brief);
  }
  // Marked but still open: only the close is missing. --only touches no other thread.
  const toClose = only != null ? [] : byAge(members).filter((n) => isDone(n) && !n.closed).map(brief);
  const others = nodes.filter((n) => n !== tracker
    && (matches(cats, trackerOf(n), key) || matches(cats, trackerOf(n), category))).map(listed);
  return { flow: 'F1', cat: key, category, tracker: brief(tracker), others, pending, to_close: toClose };
}

// Pick the flow from N and/or --cat (the Locate table in SKILL.md); `cats` are the repository's categories.
export function locate(nodes, { number = null, cat = null, only = null, cats = [] } = {}) {
  if (number == null && !cat) return { flow: 'error', reason: 'give N, --cat, or both' };
  cats = [...cats, ...nodes.map((n) => n.category || {})];
  const target = nodes.find((n) => n.number === number) ?? null;
  const targetTracker = trackerOf(target);
  if (targetTracker && (!cat || matches(cats, targetTracker, cat))) return flowF1(nodes, target, only, cats);
  const same = nodes.filter((n) => matches(cats, trackerOf(n), cat));
  const markable = target && !targetTracker ? number : null;
  const category = categoryNamed(cats, cat);
  const reason = targetTracker ? `#${number} already tracks ${repr(targetTracker[1])}`
    : number != null && !target ? `#${number} does not exist`
      : number != null ? `#${number} is not a tracker` : null;
  if (!same.length) {
    return { flow: 'F2', cat: cat && !category && KEY_RE.test(cat) ? cat : null, category, mark: markable, number, reason };
  }
  if (number == null && same.length === 1) return flowF1(nodes, same[0], only, cats);
  if (number == null) return { flow: 'F3', cat, trackers: same.map(listed) };
  // Both given but #N is not this cat's tracker: offer the existing trackers and #N.
  const options = same.map((n, i) => ({ choice: `T${i + 1}`, number: n.number,
    then: hasDuplicate(cats, same, n) ? 'merge+F1' : 'F1' }));
  if (markable) {
    const joinable = new Map();
    for (const n of same) if (!joinable.has(seriesOf(cats, n))) joinable.set(seriesOf(cats, n), trackerOf(n));
    [...joinable.values()].forEach(([key, series], i) => options.push({ choice: `M${i + 1}`, number: markable,
      cat: key, category: categoryNamed(cats, series) || series, then: 'mark+merge+F1' }));
  }
  options.push({ choice: 'N', then: 'exit' });
  return { flow: 'ask', cat, number, trackers: same.map(listed), options, reason };
}

// Top-level `##` sections as [name, heading line, body]; the text before the first is the preamble.
function sections(text) {
  const { lines, heads } = parse(text);
  let preamble = '';
  const parts = [];
  lines.forEach((line, i) => {
    if (heads.has(i)) parts.push([heads.get(i), line, '']);
    else if (parts.length) parts.at(-1)[2] += line;
    else preamble += line;
  });
  return { preamble, parts };
}

// The line breaks still missing for one blank line between two pieces; neither piece is trimmed.
function gap(before, after) {
  const have = before.length - before.replace(/\n+$/, '').length + after.length - after.replace(/^\n+/, '').length;
  return '\n'.repeat(Math.max(0, 2 - have));
}

// Markdown links whose URL matches keep only their text; a line still holding a match is dropped
// (Fathom's `VIEW RECORDING … https://fathom.video/…` line).
function unlink(text, patterns) {
  for (const pattern of patterns) {
    let url;
    try {
      url = new RegExp(pattern, 'u');
    } catch (error) {
      throw new Error(`--unlink ${repr(pattern)}: ${error.message}`);
    }
    text = text.replace(/\[((?:[^\[\]]|\[[^\]]*\])*)\]\(([^)\s]*)\)/g, (link, label, href) => (url.test(href) ? label : link));
    text = text.split('\n').filter((line) => !url.test(line)).join('\n');
  }
  return text;
}

// `text` keeps every byte; only the blank lines markdown needs around it are added.
function fold(heading, text) {
  const head = `<details>\n<summary>${heading}</summary>\n`;
  return `${head}${gap(head, text)}${text}${gap(text, '</details>')}</details>`;
}

// New body = done mark + digest + the other sections (unlinked) + folded sections. The original keeps every
// byte; only blank lines between the pieces are added.
export function rebuild(source, tracker, date, { digest = '', folds = [], unlinks = [], drops = [], label = 'Original notes' } = {}) {
  source = source.replaceAll('\r\n', '\n'); // web posts are CRLF; GitHub stores LF after an API write
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { action: 'refuse', reason: `date ${repr(date)} is not YYYY-MM-DD` };
  if (DONE_RE.test(prose(source)) || trackerOf({ body: source })) {
    return { action: 'refuse', reason: 'the body already holds a done mark or is a tracker' };
  }
  let kept = '', folded = [];
  if (folds.includes('all')) {
    folded = [fold(label, source)];
  } else if (!folds.length && !drops.length) {
    kept = unlink(source, unlinks); // no split: the body stays byte for byte
  } else {
    const { preamble, parts } = sections(source);
    const names = new Set(parts.map(([name]) => name));
    const missing = [...folds, ...drops].filter((name) => !names.has(name));
    if (missing.length) return { action: 'refuse', reason: `no such section: ${missing.join(', ')}` };
    kept = unlink(preamble, unlinks) + parts.filter(([name]) => !folds.includes(name) && !drops.includes(name))
      .map(([, head, text]) => unlink(head + text, unlinks)).join('');
    folded = parts.filter(([name]) => folds.includes(name)).map(([name, , text]) => fold(name, text));
  }
  let body = `<!-- dev-track:done · #${tracker} · ${date} -->`;
  for (const piece of [digest, kept, ...folded]) if (piece) body += gap(body, piece) + piece;
  if (!body.endsWith('\n')) body += '\n';
  const characters = [...body].length; // code points, as the original counted
  if (characters > BODY_LIMIT) {
    return { action: 'refuse', reason: `the new body has ${characters} characters; GitHub allows ${BODY_LIMIT}` };
  }
  return { action: 'proceed', body, characters };
}

// Replace any leading status emoji with `status`; `base` replaces the rest of the title.
export const retitle = (title, status, base = null) => `${status} ${(base || title).trim().replace(STATUS_RE, '')}`;

// Remove any live tracker mark, new or legacy; with cat and category put a new one on the first line.
export function setTracker(body, cat = null, category = null) {
  for (const pattern of [TRACKER_RE, LEGACY_TRACKER]) body = dropMarks(pattern, body);
  return cat ? `<!-- dev-track:tracker cat=${cat} category=${category} -->\n${body}` : body;
}

// Strict UTF-8 with universal newlines, as the original's Path.read_text read every file.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const readText = (path) => decoder.decode(readFileSync(path)).replace(/\r\n?/g, '\n');

// `@path` reads the value from that file, so discussion text never reaches a shell command line.
// shortcut: a value that really starts with @ has to come from a file too; add an escape if one turns up.
const readArg = (value) => (value?.startsWith('@') ? readText(value.slice(1)).trim() : value);

const S = { type: 'string' }, MANY = { type: 'string', multiple: true };
const COMMANDS = {
  locate: { options: { pages: S, number: S, cat: S, only: S }, required: ['pages'] },
  body: {
    options: { source: S, tracker: S, date: S, digest: S, fold: MANY, label: S, unlink: MANY, drop: MANY, out: S },
    required: ['source', 'tracker', 'date', 'out'],
  },
  title: { options: { title: S, status: S, base: S }, required: ['title', 'status'] },
  tracker: { options: { source: S, cat: S, category: S, remove: { type: 'boolean' }, out: S }, required: ['source', 'out'] },
};

function readArgs([command, ...args]) {
  if (!Object.hasOwn(COMMANDS, command)) throw new Error(`the first argument is one of ${Object.keys(COMMANDS).join(', ')}`);
  const { values } = parseArgs({ args, options: COMMANDS[command].options });
  const missing = COMMANDS[command].required.filter((name) => values[name] === undefined);
  if (missing.length) throw new Error(`${command} needs ${missing.map((name) => `--${name}`).join(', ')}`);
  for (const name of ['number', 'only', 'tracker']) {
    if (values[name] === undefined) continue;
    // Discussion numbers start at 1.
    if (!/^\s*\+?\d+\s*$/.test(values[name]) || Number(values[name]) < 1) {
      throw new Error(`--${name} ${repr(values[name])} is not a positive discussion number`);
    }
    values[name] = Number(values[name]);
  }
  return { command, ...values };
}

export function main(argv) {
  let result, ok;
  try {
    const args = readArgs(argv);
    if (args.command === 'locate') {
      const pages = JSON.parse(readText(args.pages));
      const repos = (Array.isArray(pages) ? pages : [pages]).map((page) => page.data.repository);
      const nodes = repos.flatMap((repo) => repo.discussions.nodes);
      const cats = repos.flatMap((repo) => repo.discussionCategories?.nodes ?? []);
      result = locate(nodes, { number: args.number, cat: args.cat, only: args.only, cats });
      ok = result.flow !== 'error';
    } else if (args.command === 'body') {
      const digest = args.digest ? readText(args.digest) : '';
      result = rebuild(readText(args.source), args.tracker, args.date, { digest, folds: (args.fold ?? []).map(readArg),
        unlinks: args.unlink ?? [], drops: (args.drop ?? []).map(readArg), label: args.label });
      ok = result.action === 'proceed';
      if (ok) {
        const { body, ...rest } = result;
        writeFileSync(args.out, body);
        result = { ...rest, out: args.out };
      }
    } else if (args.command === 'title') {
      process.stdout.write(retitle(readArg(args.title), args.status, readArg(args.base)));
      return 0;
    } else {
      if (!(args.remove && !(args.cat || args.category) || !args.remove && args.cat && args.category)) {
        throw new Error('give --cat and --category, or --remove');
      }
      if (args.cat && (!KEY_RE.test(args.cat) || /--|>|\n/.test(args.category))) {
        process.stdout.write('{"action": "refuse", "reason": "cat must be [a-z0-9-]+; category must not hold --, > or a newline"}\n');
        return 1;
      }
      writeFileSync(args.out, setTracker(readText(args.source), args.cat, args.category));
      [result, ok] = [{ action: 'proceed', out: args.out }, true];
    }
  } catch (error) {
    process.stderr.write(`track: ${error.message}\n`);
    return 2;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return ok ? 0 : 1;
}

function isDirectInvocation(entryPath) {
  try { return Boolean(entryPath) && realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isDirectInvocation(process.argv[1])) process.exitCode = main(process.argv.slice(2));
