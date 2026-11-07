import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Deterministic decisions for dev-explain: resolving the invocation, vetting a label change and
// planning or verifying an append-only body. Each decision is a pure function; only the CLI reads
// and writes files. Exit 0 proceeds, 1 stops (or refuses part of a change), and 2 means the check
// did not run, which never counts as a pass.

export const TYPES = ['OD', 'SD', 'ALL'];
export const DEFAULTS = { type: 'OD', lang: 'en' };
const ENV = { type: 'DEV_EXPLAIN_TYPE', lang: 'DEV_EXPLAIN_LANG' };

// Protected workflow and decision labels are outside an explanation run’s write boundary.
const EXCLUDED_ADD = ['ai:ready', 'ai:implementing', 'decision:confirmed'];
const EXCLUDED_REMOVE = ['ai:blocked', 'decision:needed'];

const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// A bare number may name an issue, PR or discussion; a URL's path fixes the kind. A discussions URL's
// `#discussioncomment-ID` fragment names a comment of it; every other fragment is ignored.
const TARGET_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(issues|pull|discussions)\/([1-9]\d*)(#\S*)?$/;
// A leading token that looks like a reference must be a valid target; it never silently becomes notes.
const TARGET_LIKE = [/^#/, /^\d+$/, /^[a-z][a-z0-9+.-]*:\/\//i, /^[^\s/#]+\/[^\s/#]+#/, /github\.com\//i,
  /\/(?:issues|pull|discussions)\/\d/];
const OPTION = /^(type|lang)=(.*)$/;
const encodePathSegment = (value) => encodeURIComponent(value)
  .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

const stop = (reason, detail, extra = {}) => ({ action: 'stop', reason, detail, ...extra });

/** Parse one target token, or explain why it is not one. */
export function parseTarget(token, repo) {
  const url = TARGET_URL.exec(token);
  const digits = /^#?([1-9]\d*)$/.exec(token)?.[1] ?? url?.[3];
  if (!digits || !Number.isSafeInteger(Number(digits))) {
    return { error: `"${token}" is not #N, N or https://github.com/${repo}/issues/N, /pull/N or /discussions/N` };
  }
  if (!url) return { number: Number(digits), kind: 'any' };
  if (url[1].toLowerCase() !== repo.toLowerCase()) return { error: `"${token}" names ${url[1]}, not ${repo}` };
  const target = { number: Number(digits), kind: url[2] === 'discussions' ? 'discussion' : 'issue-or-pr' };
  if (target.kind === 'discussion' && url[4]?.startsWith('#discussioncomment-')) {
    const comment = /^#discussioncomment-([1-9]\d*)$/.exec(url[4])?.[1];
    if (!comment || !Number.isSafeInteger(Number(comment))) return { error: `"${token}" has no valid discussion comment ID` };
    return { ...target, comment: Number(comment) };
  }
  return url[4] ? { ...target, warning: `ignored the URL fragment "${url[4]}"` } : target;
}

export function canonicalType(value) {
  const upper = value.toUpperCase();
  return TYPES.includes(upper) ? upper : null;
}

// A well-formed BCP 47 tag whose language subtag Node knows by name. Region and script subtags are
// canonicalised but not validated.
export function canonicalLanguage(value) {
  let tag;
  try {
    [tag] = Intl.getCanonicalLocales(value);
  } catch {
    return null;
  }
  if (!tag) return null;
  const { language } = new Intl.Locale(tag);
  // `und` has no language subtag, which DisplayNames rejects with a RangeError.
  return language && new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' }).of(language) ? tag : null;
}

const CANONICAL = { type: canonicalType, lang: canonicalLanguage };

// Why a value was rejected, phrased to help the caller fix it.
const REJECTION = {
  type: () => 'is not OD, SD or ALL',
  lang: (value) => {
    try {
      if (Intl.getCanonicalLocales(value).length === 1) return 'names no known language';
    } catch {
      // Ill-formed; fall through.
    }
    const hint = value.includes('_') ? canonicalLanguage(value.replaceAll('_', '-')) : null;
    return `is not a well-formed BCP 47 tag${hint ? ` (did you mean "${hint}"?)` : ''}`;
  },
};

// The environment value when it is valid, otherwise the built-in default with a warning for a
// rejected value. An unset or empty variable is silent.
function fallback(key, envValue, warnings) {
  if (envValue !== '') {
    const value = CANONICAL[key](envValue);
    if (value) return { value, source: 'environment' };
    warnings.push(`${ENV[key]}="${envValue}" ${REJECTION[key](envValue)}; using ${DEFAULTS[key]} (default)`);
  }
  return { value: DEFAULTS[key], source: 'default' };
}

// A rejected argument falls back exactly as an absent one would, and its warning comes first.
function resolveOption(key, given, envValue, warnings) {
  if (given.length === 0) return fallback(key, envValue, warnings);
  const value = given.length === 1 ? CANONICAL[key](given[0]) : null;
  if (value) return { value, source: 'argument' };
  const envWarnings = [];
  const chosen = fallback(key, envValue, envWarnings);
  const rejected = given.length === 1
    ? `${key}="${given[0]}" ${REJECTION[key](given[0])}`
    : `${key}= was given ${given.length} times (${given.map((v) => `"${v}"`).join(', ')})`;
  const from = chosen.source === 'environment' ? `from ${ENV[key]}` : '(default)';
  warnings.push(`${rejected}; using ${chosen.value} ${from}`, ...envWarnings);
  return chosen;
}

/**
 * Resolve the invocation text. The target, type= and lang= tokens may come in any order; the first
 * other token starts the notes, which run verbatim to the end of the text.
 */
export function resolveArgs({ repo, text, typeEnv, langEnv, candidates }) {
  const targets = [];
  const options = { type: [], lang: [] };
  let notes = '';
  for (const match of text.matchAll(/\S+/g)) {
    const token = match[0];
    const option = OPTION.exec(token);
    if (option) {
      options[option[1]].push(option[2]);
    } else if (TARGET_LIKE.some((shape) => shape.test(token))) {
      const target = parseTarget(token, repo);
      if (target.error) return stop('bad-target', target.error);
      targets.push(target);
    } else {
      notes = text.slice(match.index).trimEnd();
      break;
    }
  }
  let target;
  if (targets.length > 1) {
    const numbers = targets.map(({ number }) => number);
    return stop('ambiguous-target', `more than one target was given: ${numbers.map((n) => `#${n}`).join(', ')}`,
      { candidates: numbers });
  }
  const warnings = [];
  if (targets.length === 1) {
    const { warning, ...given } = targets[0];
    if (warning) warnings.push(warning);
    target = { ...given, source: 'argument' };
  } else {
    const distinct = [...new Set(candidates)];
    if (distinct.length === 0) return stop('no-target', 'no issue, PR or discussion identified');
    if (distinct.length > 1) {
      return stop('ambiguous-target',
        `more than one issue, PR or discussion identified: ${distinct.map((n) => `#${n}`).join(', ')}`, { candidates: distinct });
    }
    target = { number: distinct[0], kind: 'any', source: 'context' };
  }
  const type = resolveOption('type', options.type, typeEnv, warnings);
  const lang = resolveOption('lang', options.lang, langEnv, warnings);
  return { action: 'proceed', target, type, lang, notes, warnings };
}

/** Split a planned label change into what may be applied and what is refused, with reasons. */
export function vetLabels({ live, current, add, remove }) {
  const byKey = new Map(live.map((name) => [name.toLowerCase(), name]));
  const has = new Set(current.map((name) => name.toLowerCase()));
  const apply = { add: [], remove: [] };
  const refused = [];
  const both = new Set(add.map((n) => n.toLowerCase()).filter((n) => remove.some((r) => r.toLowerCase() === n)));
  for (const [change, names, excluded] of [['add', add, EXCLUDED_ADD], ['remove', remove, EXCLUDED_REMOVE]]) {
    for (const name of names) {
      const key = name.toLowerCase();
      if (both.has(key)) refused.push({ label: name, change, reason: 'both added and removed' });
      else if (excluded.includes(key)) refused.push({ label: name, change, reason: `${change === 'add' ? 'adding' : 'removing'} it is a protected workflow or decision transition` });
      else if (!byKey.has(key)) refused.push({ label: name, change, reason: 'not in the repository label list' });
      else if ((change === 'add') !== has.has(key)) {
        const canonical = byKey.get(key);
        if (change === 'add' && !apply.add.includes(canonical)) apply.add.push(canonical);
        if (change === 'remove' && !apply.remove.some(({ name }) => name === canonical)) {
          apply.remove.push({ name: canonical, encodedPathSegment: encodePathSegment(canonical) });
        }
      }
    }
  }
  return { apply, refused };
}

/** Plan an append-only body: the current body stays a byte prefix, followed by a blank line. */
export function planAppend({ before, addition }) {
  if (addition.trim() === '') return stop('empty-addition', 'the appended text is empty');
  if (addition.includes('<!--')) return stop('html-comment', 'the appended text contains an HTML comment');
  if (before.lastIndexOf('<!-- AUTO:BEGIN') > before.lastIndexOf('<!-- AUTO:END')) {
    return stop('open-region', 'the body ends inside a generated AUTO region, so an append would land in it');
  }
  const gap = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  return { action: 'append', body: `${before}${gap}${addition}` };
}

/** After the write: the read-back must contain the complete plan, without losing the old prefix. */
export function verifyAppend({ before, planned, after }) {
  if (after.startsWith(planned)) return { action: 'proceed' };
  if (after.startsWith(before)) return stop('addition-missing', 'the body does not start with the complete append plan');
  return stop('prefix-changed', 'the body no longer starts with the version read before the write; check its edit history');
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────
class InputError extends Error {}
const fail = (message) => { throw new InputError(message); };

const isString = (v) => typeof v === 'string';
const isStrings = (v) => Array.isArray(v) && v.every(isString);
const SCHEMAS = {
  args: {
    repo: [(v) => isString(v) && REPO_NAME.test(v), 'an owner/name string'],
    text: [isString, 'a string'],
    typeEnv: [isString, 'a string ("" when unset)'],
    langEnv: [isString, 'a string ("" when unset)'],
    candidates: [(v) => Array.isArray(v) && v.every((n) => Number.isSafeInteger(n) && n > 0), 'an array of positive integers'],
  },
  labels: {
    live: [isStrings, 'an array of strings'],
    current: [isStrings, 'an array of strings'],
    add: [isStrings, 'an array of strings'],
    remove: [isStrings, 'an array of strings'],
  },
};
const COMMANDS = { args: ['input'], labels: ['input'], append: ['before', 'addition', 'out'], verify: ['before', 'planned', 'after'] };

// A body comes only from an API response object that has a `body` field (null when empty). An error
// response, an empty file or any other shape is unreadable, so a failed read never becomes "".
function bodyOf(text, flag) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(`--${flag} is not a JSON API response`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'body')
    || !(value.body === null || isString(value.body))) fail(`--${flag} has no string or null "body" field`);
  return value.body ?? '';
}

function exactObject(value, schema) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('--input must hold a JSON object');
  for (const key of Object.keys(value)) if (!Object.hasOwn(schema, key)) fail(`input has the unknown key "${key}"`);
  for (const [key, [valid, expected]] of Object.entries(schema)) {
    if (!Object.hasOwn(value, key) || !valid(value[key])) fail(`input.${key} must be ${expected}`);
  }
  return value;
}

/** Parse argv into a validated command input, or throw InputError. Nothing downstream re-checks. */
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
  const text = (path) => readFileSync(path, 'utf8');
  if (command === 'append') {
    // A plan an earlier call left at --out must not survive any outcome but a new plan.
    rmSync(given.out, { force: true });
    return { command, out: given.out, before: bodyOf(text(given.before), 'before'), addition: text(given.addition) };
  }
  if (command === 'verify') {
    const before = bodyOf(text(given.before), 'before');
    const planned = text(given.planned);
    if (planned === before || !planned.startsWith(before)) fail('--planned is not a complete append plan for --before');
    return { command, before, planned, after: bodyOf(text(given.after), 'after') };
  }
  let parsed;
  try {
    parsed = JSON.parse(text(given.input));
  } catch (error) {
    fail(`--input is not readable JSON: ${error.message}`);
  }
  return { command, ...exactObject(parsed, SCHEMAS[command]) };
}

const run = {
  args: (input) => {
    const result = resolveArgs(input);
    return [result.action === 'proceed', JSON.stringify(result)];
  },
  labels: (input) => {
    const result = vetLabels(input);
    return [result.refused.length === 0, JSON.stringify(result)];
  },
  append: ({ out, ...input }) => {
    const result = planAppend(input);
    if (result.action === 'stop') return [false, JSON.stringify(result)];
    writeFileSync(out, result.body);
    return [true, JSON.stringify({ action: 'append', out })];
  },
  verify: (input) => {
    const result = verifyAppend(input);
    return [result.action === 'proceed', JSON.stringify(result)];
  },
};

export function main(argv) {
  let proceed, output;
  try {
    const { command, ...input } = readInput(argv);
    [proceed, output] = run[command](input);
  } catch (error) {
    console.error(`check-explain: ${error.message}`);
    if (error instanceof InputError) {
      console.error(`Usage: node check-explain.mjs ${Object.entries(COMMANDS)
        .map(([name, flags]) => `${name} ${flags.map((f) => `--${f} VALUE`).join(' ')}`).join(' | ')}`);
    }
    return 2;
  }
  console.log(output);
  return proceed ? 0 : 1;
}

function isDirectInvocation(entryPath) {
  try { return Boolean(entryPath) && realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isDirectInvocation(process.argv[1])) process.exitCode = main(process.argv.slice(2));
