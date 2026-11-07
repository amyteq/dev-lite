// resolve-story-issue.mjs — the deterministic core of `/dev-refine-story`. It decides whether a
// Story's GitHub issue is reused, created, or neither, as a pure function: no network, no
// filesystem, no clock. SKILL.md collects the evidence and acts on the returned decision.
//
// A Story's issue is an open issue whose body's first line is this skill's origin marker for the
// Story and whose author holds write access, since anyone who can open an issue can copy a marker.
// A marker issue whose author lacks write access now may still be the original, so it blocks any
// automatic reuse or create until a maintainer names the original. Every absent or unreadable input stops instead of
// defaulting. See references/resolver-contract.md.
//
// CLI:  node resolve-story-issue.mjs <input.json>   (or `-` for stdin)
//       node resolve-story-issue.mjs authors <lookup.json> STY_<n>   (marker authors, one per line)
// Exit: 0 for reuse/create/authors, 3 for stop, 2 for malformed input.
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// ── Story keys, markers and states ─────────────────────────────────────────────
export const STORY_KEY_RE = /^STY_([1-9][0-9]*)$/;
const FEAT_KEY_RE = /^FT_[1-9][0-9]*$/;

export function parseStoryKey(raw) {
  const key = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  const m = STORY_KEY_RE.exec(key);
  if (m) return { ok: true, key, n: Number(m[1]) };
  return { ok: false, key, reasonCode: FEAT_KEY_RE.test(key) ? 'FEAT_KEY_NOT_STORY' : 'MALFORMED_KEY' };
}

// The key must be a whole token, so a key never matches a longer one that starts with it, while
// prose punctuation after the key still reads as the key. `\b` alone matches inside a longer key.
export function matchesStoryKey(text, key) {
  return typeof text === 'string' && text !== '' && new RegExp(`(?<![A-Za-z0-9_-])${key}(?![A-Za-z0-9_-])`, 'i').test(text);
}

// The exact string Step 4 writes as a created issue's first body line, with an in-range UTC
// timestamp that uses one separator throughout.
const MARKER_PREFIX = '<!-- dev-refine-story:origin';
const RUN_MARKER_RE = /^<!-- dev-refine-story:origin story=(STY_[1-9][0-9]*) run=([^\s>]+) -->$/;
const RUN_TOKEN_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3])([:-])[0-5]\d\4[0-5]\d(?:\.\d{1,3})?Z$/;

// Every field can be in range while the date itself does not exist, such as 31 February, so the
// day is round-tripped through UTC calendar arithmetic — fixed arguments, not a clock read.
function validRunToken(token) {
  const m = RUN_TOKEN_RE.exec(token);
  return Boolean(m) && new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDate() === Number(m[3]);
}

export function parseRunMarker(raw, key) {
  if (typeof raw !== 'string') return null;
  const m = RUN_MARKER_RE.exec(raw.trim());
  if (!m || m[1].toUpperCase() !== key || !validRunToken(m[2])) return null;
  return { marker: raw.trim(), key: m[1].toUpperCase(), run: m[2] };
}

// `marked` when the first line is this Story's marker; `unreadable` when it opens like a marker
// and names this Story but does not parse, which stops rather than risk a duplicate; else null.
export function markerOf(body, key) {
  const first = (typeof body === 'string' ? body : '').split('\n', 1)[0].replace(/\r$/, '');
  if (parseRunMarker(first, key)) return 'marked';
  return first.trim().startsWith(MARKER_PREFIX) && matchesStoryKey(first, key) ? 'unreadable' : null;
}

// GraphQL reports "OPEN" and REST "open"; any other value is unknown.
export function normalizeState(raw) {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : null;
  return s === 'open' || s === 'closed' ? s : null;
}

// The Story document's frontmatter `status`, compared in any casing.
const STORY_LIFECYCLE_STATES = new Set(['CURRENT', 'SUPERSEDED', 'RETIRED']);
const CREATE_PERMISSIONS = new Set(['admin', 'maintain', 'write']);

export function canonicalStoryDocPath(p, n) {
  if (typeof p !== 'string') return null;
  const m = new RegExp(`^docs/stories/STY_${n}_[a-z0-9_]+\\.md$`).exec(p.trim());
  return m ? m[0] : null;
}

// ── Issue IDs and URLs ─────────────────────────────────────────────────────────
// Past 2**53 a JavaScript number no longer names one issue, and 400 digits read as Infinity.
export function issueNumber(v) {
  return Number.isSafeInteger(v) && v > 0 ? v : null;
}

// `/dev-refine-issue` acts on the URL, so nothing but this issue's browser URL, compared
// case-insensitively, names it: an API or pull URL, another repository or number, `http://`, and
// anything appended after the number are all a row this run must not act on.
function urlNamesIssue(url, repoKey, number) {
  return typeof url === 'string' && url.trim().toLowerCase() === `https://github.com/${repoKey}/issues/${number}`;
}

// ── Decisions ──────────────────────────────────────────────────────────────────
const ids = (ns) => ns.map((n) => `#${n}`).join(', ');

const STOP = (reasonCode, reason, conflicts = []) => ({
  action: 'stop',
  reasonCode,
  reason,
  issue: null,
  selected: null,
  duplicates: [],
  conflicts: [...new Set(conflicts.filter((n) => issueNumber(n) !== null))],
  plannedWrites: { createIssue: 0, invokeRefineIssue: 0 },
});

export function resolveStoryIssue(input) {
  const repo = input?.repo;
  if (typeof repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    return STOP('MALFORMED_INPUT', 'No single `owner/repo` target was supplied.');
  }
  const parsed = parseStoryKey(input?.storyKey);
  if (parsed.reasonCode === 'FEAT_KEY_NOT_STORY') {
    return STOP('FEAT_KEY_NOT_STORY', `${parsed.key} is a feat, not a Story; its work lives on the feat's tracking issue, so name one of its STY_<n> Stories.`);
  }
  if (!parsed.ok) return STOP('MALFORMED_KEY', `\`${String(input?.storyKey)}\` is not a STY_<positive integer> Story key.`);
  const story = input?.story ?? null;
  const storyStop = storyGate(story, parsed);
  if (storyStop) return STOP(...storyStop);
  if (input?.lookup?.complete !== true) {
    return STOP('LOOKUP_INCOMPLETE', 'The issue lookup did not retrieve every page, so no selection or creation may rest on it.');
  }
  const rows = readRows(input?.candidates, repo.trim().toLowerCase(), parsed.key);
  if (rows.stop) return STOP(...rows.stop);
  return decide(input, parsed.key, rows.issues);
}

// Whether there is a Story, whether it is THIS Story, and whether it is live.
function storyGate(story, { key, n }) {
  if (!story) return ['STORY_NOT_FOUND', `No canonical Story document resolves to ${key} in the selected repository/ref.`];
  if (story.key === undefined || story.key === null) {
    return ['STORY_ENVELOPE_INCOMPLETE', `The Story envelope for ${key} carries no \`key\`; the resolved document's own key must be read back and passed.`];
  }
  if (typeof story.key !== 'string') return ['STORY_KEY_MISMATCH', `The resolved Story's key is ${JSON.stringify(story.key)}, which is not a Story key.`];
  if (story.key.toUpperCase() !== key) return ['STORY_KEY_MISMATCH', `The resolved Story is ${story.key}, not ${key}.`];
  const rawDocPaths = Array.isArray(story.docPaths) ? story.docPaths : [];
  const unusable = rawDocPaths.filter((p) => typeof p !== 'string' || !p.trim());
  if (unusable.length) {
    return ['STORY_ENVELOPE_INCOMPLETE', `The Story envelope for ${key} records a document path this resolver cannot use: ${unusable.map((p) => JSON.stringify(p)).join(', ')}.`];
  }
  const docPaths = rawDocPaths.map((p) => p.trim());
  if (docPaths.length === 0) return ['STORY_ENVELOPE_INCOMPLETE', `The Story envelope for ${key} names no document path.`];
  if (docPaths.length > 1) return ['STORY_AMBIGUOUS', `${key} resolves to ${docPaths.length} canonical documents: ${docPaths.join(', ')}.`];
  if (!canonicalStoryDocPath(docPaths[0], n)) {
    return [
      'STORY_ENVELOPE_INCOMPLETE',
      `The Story envelope for ${key} names ${JSON.stringify(docPaths[0])}, which is not ${key}'s Story document \`docs/stories/STY_${n}_<slug>.md\`.`,
    ];
  }
  // An absent or unrecognised lifecycle cannot be told apart from a terminal one.
  const lifecycle = typeof story.lifecycleStatus === 'string' ? story.lifecycleStatus.trim().toUpperCase() : null;
  if (!STORY_LIFECYCLE_STATES.has(lifecycle)) {
    return [
      'STORY_ENVELOPE_INCOMPLETE',
      `${key} carries \`lifecycleStatus\` ${JSON.stringify(story.lifecycleStatus ?? null)}; read \`status\` from the Story document's frontmatter and pass one of ${[...STORY_LIFECYCLE_STATES].join(', ')}.`,
    ];
  }
  if (lifecycle === 'SUPERSEDED' || lifecycle === 'RETIRED') {
    const successor = Array.isArray(story.supersededBy) ? story.supersededBy.join(', ') : story.supersededBy;
    return ['STORY_TERMINAL', `${key} is ${lifecycle}${successor ? ` (superseded by ${successor})` : ''}; a terminal Story is refused without redirect.`];
  }
  return null;
}

// Every row is checked before any is judged, so an unreadable row can never hide the Story's
// issue. Each gate names every row it catches.
function readRows(candidates, repoKey, key) {
  if (!Array.isArray(candidates)) {
    return { stop: ['MALFORMED_CANDIDATE_SET', `\`candidates\` is ${JSON.stringify(candidates ?? null)} rather than a list; pass [] to declare that a complete lookup found nothing.`] };
  }
  const shapeless = candidates.filter((c) => !c || typeof c !== 'object' || Array.isArray(c) || issueNumber(c.number) === null);
  if (shapeless.length) {
    return { stop: ['MALFORMED_CANDIDATE', `${shapeless.length} lookup row(s) carry no valid issue number: ${shapeless.map((c) => JSON.stringify(c?.number ?? c ?? null)).join(', ')}.`] };
  }
  const seen = new Set();
  const repeated = new Set(candidates.map((c) => c.number).filter((n) => seen.has(n) || !seen.add(n)));
  const gates = [
    ['MALFORMED_CANDIDATE', (c) => repeated.has(c.number), (ns) => `The lookup returned ${ids(ns)} more than once; re-run it rather than guess which row is current.`],
    ['MALFORMED_CANDIDATE', (c) => !urlNamesIssue(c.url, repoKey, c.number),
      (ns) => `${ids(ns)} carry a URL that is not the browser issue URL https://github.com/${repoKey}/issues/<number> for that number; a pull request, another repository or an API URL is not this repository's issue.`],
    ['CANDIDATE_IDENTITY_UNREADABLE', (c) => !(c.body === null || typeof c.body === 'string'), (ns) => `The body of ${ids(ns)} was not fetched, so the first line cannot be read; \`null\` states an empty body.`],
    ['CANDIDATE_STATE_UNKNOWN', (c) => normalizeState(c.state) === null, (ns) => `Cannot read the state of ${ids(ns)}; expected "open" or "closed" in any casing.`],
    ['CANDIDATE_LOCK_UNKNOWN', (c) => typeof c.locked !== 'boolean', (ns) => `Lock state is missing for ${ids(ns)}; fetch \`locked\` before deciding.`],
  ];
  for (const [reasonCode, applies, reason] of gates) {
    const hit = [...new Set(candidates.filter(applies).map((c) => c.number))];
    if (hit.length) return { stop: [reasonCode, reason(hit), hit] };
  }
  const issues = candidates.map((c) => ({ number: c.number, url: c.url.trim(), open: normalizeState(c.state) === 'open', locked: c.locked,
    marker: markerOf(c.body, key), author: c.authorPermission }));
  const unreadable = issues.filter((c) => c.open && c.marker === 'unreadable').map((c) => c.number);
  if (unreadable.length) {
    return {
      stop: [
        'MARKER_UNREADABLE',
        `${ids(unreadable)} opens with a dev-refine-story origin marker naming ${key} that does not parse; fix the marker line by hand rather than let a duplicate be created.`,
        unreadable,
      ],
    };
  }
  // Provenance is read only where it decides something: an open row carrying this Story's marker.
  const unproven = issues.filter((c) => c.open && c.marker === 'marked' && !(c.author === null || typeof c.author === 'string'));
  if (unproven.length) {
    return {
      stop: ['CANDIDATE_PROVENANCE_UNKNOWN', `The author permission of marker issue ${ids(unproven.map((c) => c.number))} was not fetched; pass \`authorPermission\` (\`null\` for a deleted author).`,
        unproven.map((c) => c.number)],
    };
  }
  return { issues };
}

const trusted = (c) => typeof c.author === 'string' && CREATE_PERMISSIONS.has(c.author.trim().toLowerCase());
const writer = (raw) => typeof raw === 'string' && CREATE_PERMISSIONS.has(raw.trim().toLowerCase());

// The logins whose permission Step 2 must fetch: authors of rows this parser reads as a marker for the
// key, so the listing and the decision cannot disagree about which rows carry one.
export function markerAuthors(lookup, key) {
  const rows = Array.isArray(lookup?.candidates) ? lookup.candidates : [];
  return [...new Set(rows.filter((c) => markerOf(c?.body, key) !== null).map((c) => c?.author?.login)
    .filter((login) => typeof login === 'string' && login))].sort();
}

// A maintainer's identification of the original issue, verified against this listing: it must name this
// Story and an open issue whose first line is its marker, and come from someone with write access.
function selectedByMaintainer(input, key, marked, selection) {
  const story = parseStoryKey(selection?.story);
  const number = issueNumber(selection?.issue);
  const open = marked.map((c) => c.number);
  if (!story.ok || story.key !== key || number === null) {
    return STOP('SELECTION_MISMATCH', `The maintainer selection ${JSON.stringify(selection)} does not name ${key} and one issue number.`, open);
  }
  if (!writer(input?.authority?.effectivePermission)) {
    return STOP('INSUFFICIENT_PERMISSION', `Naming ${key}'s original issue needs write access; pass the selecting maintainer's permission as \`authority.effectivePermission\`.`);
  }
  const hit = marked.find((c) => c.number === number);
  if (!hit) {
    return STOP('SELECTION_MISMATCH', `#${number} is not an open issue whose first line is ${key}'s origin marker${open.length ? `; those are ${ids(open)}` : ''}.`, open);
  }
  if (hit.locked) return STOP('ISSUE_LOCKED', `${key}'s selected issue #${number} is locked; no write is attempted and no replacement is created.`, [number]);
  const duplicates = open.filter((n) => n !== number);
  return {
    action: 'reuse',
    reasonCode: 'REUSE_SELECTED',
    reason: `Reusing #${number}, which a maintainer named as ${key}'s original issue and which still carries its origin marker${duplicates.length ? `; ${ids(duplicates)} also carry it and are reported for a human` : ''}.`,
    issue: { number, url: hit.url },
    selected: number,
    selection: { story: key, issue: number },
    duplicates,
    conflicts: [],
    plannedWrites: { createIssue: 0, invokeRefineIssue: 1 },
  };
}

// The Story's issue is its one open marker issue by an author with write access. Two or more
// eligible ones stop for a human, and so does any marker issue by another author.
function decide(input, key, issues) {
  const marked = issues.filter((c) => c.open && c.marker === 'marked').sort((a, b) => a.number - b.number);
  if (input?.selection !== undefined && input?.selection !== null) return selectedByMaintainer(input, key, marked, input.selection);
  const eligible = marked.filter(trusted);
  const uncertain = marked.filter((c) => !trusted(c)).map((c) => c.number);
  // The original's author may have lost write access or deleted their account, which no listing can tell
  // apart from a copy, and a current writer's issue may itself be the copy. So any marker issue of uncertain
  // provenance stops, beside an eligible one too, and never leads to a reuse or a create.
  if (uncertain.length) {
    const all = marked.map((c) => c.number);
    return STOP('MARKER_PROVENANCE_UNCERTAIN', `${ids(all)} carry ${key}'s origin marker, and the author of ${ids(uncertain)} has no write access now, so the original cannot be told from a copy. A maintainer must name the original: re-run with \`original=<number>\` for one of them.`, all);
  }
  if (eligible.length > 1) {
    return STOP('DUPLICATE_MARKERS', `${ids(eligible.map((c) => c.number))} all carry ${key}'s origin marker and were opened with write access; a human must decide which is the Story's issue.`,
      eligible.map((c) => c.number));
  }
  if (eligible.length) {
    const [hit] = eligible;
    if (hit.locked) return STOP('ISSUE_LOCKED', `${key}'s issue #${hit.number} is locked; no write is attempted and no replacement is created.`, [hit.number]);
    return {
      action: 'reuse',
      reasonCode: 'REUSE_MARKED',
      reason: `Reusing #${hit.number}, the only open issue whose first line is ${key}'s origin marker, and its author has write access.`,
      issue: { number: hit.number, url: hit.url },
      selected: hit.number,
      duplicates: [],
      conflicts: [],
      plannedWrites: { createIssue: 0, invokeRefineIssue: 1 },
    };
  }
  if (input?.authority?.createAuthorized !== true) {
    return STOP('CREATE_NOT_AUTHORIZED', `No open issue by an author with write access carries ${key}'s origin marker and this run holds no explicit creation authority.`);
  }
  const rawPermission = input?.authority?.effectivePermission;
  const permission = typeof rawPermission === 'string' ? rawPermission.trim().toLowerCase() || null : null;
  if (!permission || !CREATE_PERMISSIONS.has(permission)) {
    return STOP(
      'INSUFFICIENT_PERMISSION',
      `Creating ${key}'s issue needs write access, but \`authority.effectivePermission\` is ${permission ? `\`${permission}\`` : 'absent'}; run \`gh api repos/<owner>/<repo>/collaborators/<login>/permission\` and pass its answer.`,
    );
  }
  return {
    action: 'create',
    reasonCode: 'CREATE_AUTHORIZED',
    reason: `No open issue carries ${key}'s origin marker after a complete lookup, and creation is explicitly authorized; write the marker as the new issue's first body line.`,
    issue: null,
    selected: null,
    duplicates: [],
    conflicts: [],
    plannedWrites: { createIssue: 1, invokeRefineIssue: 1 },
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────────
// Resolve symlinks: through a linked skill directory a plain comparison imports this file and exits 0 unchecked.
const isEntry = (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (isEntry && process.argv[2] === 'authors') {
  try {
    const key = parseStoryKey(process.argv[4]);
    if (!key.ok) throw new Error(`${process.argv[4]} is not a Story key`);
    const authors = markerAuthors(JSON.parse(readFileSync(process.argv[3], 'utf8')), key.key);
    if (authors.length) console.log(authors.join('\n'));
    process.exit(0);
  } catch (e) {
    console.error(`resolve-story-issue: unreadable input (${String(e?.message || e)})`);
    process.exit(2);
  }
} else if (isEntry) {
  const arg = process.argv[2];
  const read = async () => {
    if (!arg || arg === '-') {
      const chunks = [];
      for await (const c of process.stdin) chunks.push(c);
      return Buffer.concat(chunks).toString('utf8');
    }
    return readFileSync(arg, 'utf8');
  };
  let decision;
  try {
    decision = resolveStoryIssue(JSON.parse(await read()));
  } catch (e) {
    console.error(`resolve-story-issue: unreadable input (${String(e?.message || e)})`);
    process.exit(2);
  }
  console.log(JSON.stringify(decision, null, 2));
  process.exit(decision.action === 'stop' ? 3 : 0);
}
