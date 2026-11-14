import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import { fromMarkdown } from 'mdast-util-from-markdown';

// Deterministic parts of dev-track: locate the tracker, list pending threads, rebuild a body, swap the
// title's status prefix, add or remove the tracker mark, read an attachment's text, download attachments. Reads
// `gh api graphql --paginate --slurp` output and local files; only `download` calls GitHub, keeping the token out of argv and logs. Exit 0 proceeds, 1 refuses (reason in the JSON output), 2 means bad
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

// An attachment is untrusted, and a few KB of zip inflate to hundreds of MB: the end record's declared member
// count and directory size refuse before the directory is parsed, the declared total before any member is read,
// and a member over EACH is skipped. A member inflates to at most its declared size, so a lying one fails.
const ZIP = { MEMBERS: 2000, EACH: 20 << 20, TOTAL: 200 << 20 };
const XML = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const unescapeXml = (text) => text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(\w+));/gi,
  (entity, hex, dec, name) => (hex || dec ? String.fromCodePoint(parseInt(hex || dec, hex ? 16 : 10)) : XML[name] ?? entity));
// One line per non-blank paragraph (`<w:p>` in Word, `<a:p>` in PowerPoint): its `<w:t>`/`<a:t>` runs joined.
// shortcut: matches by local name, not namespace; use an XML parser if another vocabulary's <t> turns up.
const paragraphs = (xml) => xml.split(/<\/(?:\w+:)?p>/)
  .map((p) => [...p.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([^<]*)<\/(?:\w+:)?t>/g)].map((m) => unescapeXml(m[1])).join(''))
  .filter((text) => text.trim());

// The text of a .docx or .pptx held in `zip`, running nothing from it. Zip64 and encrypted files fail.
export function officeText(zip) {
  const refuse = (reason) => ({ action: 'refuse', reason });
  const end = zip.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1')); // 22 bytes + a comment of up to 64 KiB
  if (end < 0 || end < zip.length - (1 << 16) - 22 || zip.length < end + 22) return refuse('no zip end record: nothing read');
  const [members, size, start] = [zip.readUInt16LE(end + 10), zip.readUInt32LE(end + 12), zip.readUInt32LE(end + 16)];
  if (members > ZIP.MEMBERS || size > ZIP.MEMBERS << 8) {
    return refuse(`${members} members, ${size} byte directory declared: over the limit, nothing read`);
  }
  if (start + size > end) return refuse('the central directory lies outside the file: nothing read');
  const entries = [];
  // A read past the end of the buffer throws, which main reports as an unreadable file.
  for (let at = start, i = 0; i < members; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) return refuse('a broken central directory: nothing read');
    const n = zip.readUInt16LE(at + 28);
    entries.push({ name: zip.toString('utf8', at + 46, at + 46 + n), method: zip.readUInt16LE(at + 10),
      packed: zip.readUInt32LE(at + 20), full: zip.readUInt32LE(at + 24), local: zip.readUInt32LE(at + 42) });
    at += 46 + n + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  const total = entries.reduce((sum, e) => sum + e.full, 0);
  if (total > ZIP.TOTAL) return refuse(`${members} members, ${total} bytes uncompressed: over the limit, nothing read`);
  const read = ({ name, method, packed, full, local }) => {
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`${name}: no local header`);
    const from = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(from, from + packed);
    if (method === 0 && packed === full) return data.toString('utf8');
    if (method === 8) return inflateRawSync(data, { maxOutputLength: Math.max(1, full) }).toString('utf8');
    throw new Error(`${name}: compression method ${method} with ${packed} of ${full} bytes is not read`);
  };
  const lines = entries.filter((e) => e.full > ZIP.EACH).map((e) => `## skipped, too large: ${e.name} ${e.full}`);
  const kept = entries.filter((e) => e.full <= ZIP.EACH);
  const document = kept.find((e) => e.name === 'word/document.xml');
  if (document) lines.push(...paragraphs(read(document)));
  else {
    const slides = kept.map((e) => [e, e.name.match(/^ppt\/slides\/slide(\d+)\.xml$/)?.[1]]).filter(([, n]) => n);
    for (const [slide] of slides.sort(([, a], [, b]) => a - b)) lines.push(`## ${slide.name}`, ...paragraphs(read(slide)));
  }
  return { action: 'proceed', text: lines.map((line) => `${line}\n`).join('') };
}

// Only GitHub's attachment URLs get the token; a redirect target (signed storage URL) is fetched without it.
const ATTACHMENT = /^https:\/\/github\.com\/user-attachments\/(?:files|assets)\//;
const DOWNLOAD = { FILES: 20, BYTES: 50 << 20 };

async function fetchCapped(url, init, fetchImpl, maxBytes) {
  let res = await fetchImpl(url, { ...init, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    res = await fetchImpl(new URL(res.headers.get('location'), url).href, { redirect: 'follow' });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (Number(res.headers.get('content-length')) > maxBytes) throw new Error('too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Download each attachment URL into DIR/att<n>/file; the token comes from `gh auth token` in-process, never argv. */
export async function download(urls, dir, { token = () => spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' }).stdout?.trim(),
  fetchImpl = fetch, limit = DOWNLOAD.FILES, maxBytes = DOWNLOAD.BYTES } = {}) {
  const result = { action: 'proceed', downloaded: [], failed: [], skipped: [] };
  let secret = null;
  for (const [index, url] of urls.entries()) {
    if (index >= limit) { result.skipped.push(url); continue; }
    const file = join(dir, `att${index + 1}`, 'file');
    try {
      if (!ATTACHMENT.test(url)) throw new Error('not a GitHub attachment URL');
      secret ??= token() || null;
      if (!secret) throw new Error('no gh auth token');
      const bytes = await fetchCapped(url, { headers: { Authorization: `token ${secret}` } }, fetchImpl, maxBytes);
      mkdirSync(join(dir, `att${index + 1}`), { recursive: true });
      writeFileSync(file, bytes);
      result.downloaded.push({ url, file });
    } catch (error) {
      rmSync(file, { force: true });
      result.failed.push({ url, reason: secret ? error.message.replaceAll(secret, '***') : error.message });
    }
  }
  for (const [name, list] of [['failed.txt', result.failed.map((item) => item.url)], ['skipped.txt', result.skipped]]) {
    if (list.length) appendFileSync(join(dir, name), list.map((url) => `${url}\n`).join(''));
  }
  return result;
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
  text: { options: { file: S }, required: ['file'] },
  download: { options: { list: S, dir: S }, required: ['list', 'dir'] },
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
    if (args.command === 'download') {
      const urls = [...new Set(readText(args.list).split('\n').map((line) => line.trim()).filter(Boolean))];
      return download(urls, args.dir).then((summary) => { process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`); return 0; },
        (error) => { process.stderr.write(`track: ${error.message}\n`); return 2; });
    }
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
    } else if (args.command === 'text') {
      result = officeText(readFileSync(args.file));
      if (result.action === 'proceed') {
        process.stdout.write(result.text);
        return 0;
      }
      ok = false;
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

if (isDirectInvocation(process.argv[1])) Promise.resolve(main(process.argv.slice(2))).then((code) => { process.exitCode = code; });
