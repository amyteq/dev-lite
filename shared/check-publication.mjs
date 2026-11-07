import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { offendingLines } from './check-separators.mjs';

const usage =
  'Usage: node check-publication.mjs BODY_FILE | --body-file BODY_FILE | --review-json REVIEW_JSON_FILE';

const transports = new Map([
  ['--body-file', 'body-file'],
  ['--review-json', 'review-json'],
]);

// Apply the shared separator policy to Markdown bodies and review JSON payloads.
export function publicationFindings(markdown) {
  return offendingLines(markdown).map((line) => ({
    line,
    message: 'thematic break not preceded by a blank line',
  }));
}

// A formal approval never reaches --body-file: it carries the signed report in the
// reviews-API `body` field, where JSON escaping collapses newlines and hides the
// defect from anything reading the payload.
export function bodyFromReviewJson(text) {
  const payload = JSON.parse(text);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload) ||
      typeof payload.body !== 'string') {
    throw new TypeError('review JSON must be an object with a string body');
  }
  return payload.body;
}

/**
 * A reviews-API payload handed to the body-file transport would be checked as one escaped
 * line, hiding the very defect --review-json exists to catch — and exit 0 there authorises
 * a formal APPROVE write. Refuse it instead of passing it.
 */
export function looksLikeReviewPayload(text) {
  try {
    return typeof JSON.parse(text)?.body === 'string';
  } catch {
    return false;
  }
}

export function parseArguments(args) {
  if (args.length === 1 && !transports.has(args[0])) return { transport: 'body-file', path: args[0] };
  if (args.length === 2 && transports.has(args[0])) return { transport: transports.get(args[0]), path: args[1] };
  return null;
}

function main(args) {
  const request = parseArguments(args);
  if (!request) {
    console.error(usage);
    return 2;
  }
  // Usage, read and parse failures must stay distinguishable from content violations:
  // a caller that cannot tell them apart cannot tell "clean body" from "never checked".
  let findings;
  try {
    const text = readFileSync(request.path, 'utf8');
    if (request.transport === 'body-file' && looksLikeReviewPayload(text)) {
      throw new TypeError('this looks like a reviews-API payload; check its Markdown with --review-json');
    }
    findings = publicationFindings(
      request.transport === 'review-json' ? bodyFromReviewJson(text) : text);
  } catch (error) {
    console.error(`Cannot check ${request.path}: ${error.message}`);
    return 2;
  }
  const label = request.transport === 'review-json' ? `${request.path}#body` : request.path;
  for (const finding of findings) {
    console.log(`${label}:${finding.line}: ${finding.message}`);
  }
  return findings.length ? 1 : 0;
}

function isDirectInvocation(entryPath) {
  if (!entryPath) return false;
  try {
    return realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
