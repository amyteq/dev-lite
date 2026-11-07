import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { bodyFromReviewJson, looksLikeReviewPayload, parseArguments, publicationFindings } from './check-publication.mjs';

const script = fileURLToPath(new URL('./check-publication.mjs', import.meta.url));
const run = (entry, ...args) => spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8' });
const scratch = (name) => mkdtempSync(join(tmpdir(), `${name}-`));

const defect = 'Scope proposals: none.\r\n---\r\n';
const clean = '- ```\n\tx\n  ---\n  ```\n';

test('findings carry the offending line and the publication rule violated', () => {
  assert.deepEqual(publicationFindings(defect),
    [{ line: 2, message: 'thematic break not preceded by a blank line' }]);
  assert.deepEqual(publicationFindings(clean), []);
});

test('both skills reach the same rule through one entry point', () => {
  // dev-review-pr assembles comment bodies, dev-refine-issue assembles an issue body and a
  // task comment. The transport differs; the checked payload is Markdown in every case.
  const payloads = [
    '## Fix dispositions — round 2 / 10\n\nPush: verified remote head\n---\n',
    '<!-- AUTO:BEGIN -->\n<!-- dev-refine-issue:body -->\n## Issue refinement\n\nPrepared.\n---\n',
    '<!-- dev-refine-issue:task repo=o/r issue=1 revision=1 -->\n## Task — x\n\nGoal.\n---\n',
  ];
  for (const payload of payloads) assert.deepEqual(publicationFindings(payload), [{
    line: payload.split('\n').indexOf('---') + 1,
    message: 'thematic break not preceded by a blank line',
  }]);
});

test('CLI checks exact body files and distinguishes findings from input errors', () => {
  const dir = scratch('publication-check');
  const linkedScript = join(dir, 'linked-check-publication.mjs');
  const body = join(dir, 'body with spaces.md');
  try {
    symlinkSync(script, linkedScript);
    writeFileSync(body, defect);
    const bad = run(script, body);
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, `${body}:2: thematic break not preceded by a blank line\n`);
    assert.equal(bad.stderr, '');
    // A rejected body is never rewritten: the checker is a gate, not a formatter.
    assert.equal(readFileSync(body, 'utf8'), defect);
    const linkedBad = run(linkedScript, body);
    assert.equal(linkedBad.status, bad.status);
    assert.equal(linkedBad.stdout, bad.stdout);
    assert.equal(linkedBad.stderr, bad.stderr);
    const named = run(script, '--body-file', body);
    assert.deepEqual([named.status, named.stdout, named.stderr], [bad.status, bad.stdout, bad.stderr]);
    writeFileSync(body, clean);
    for (const args of [[body], ['--body-file', body]]) {
      const good = run(script, ...args);
      assert.equal(good.status, 0);
      assert.equal(good.stdout + good.stderr, '');
    }
    const usageErrors = [
      [], [body, body], [join(dir, 'missing.md')], [dir],
      ['--body-file'], ['--review-json'], ['--unknown', body], ['--body-file', body, body],
    ];
    for (const args of usageErrors) {
      const error = run(script, ...args);
      assert.equal(error.status, 2, `expected usage/read error for ${JSON.stringify(args)}`);
      assert.equal(error.stdout, '');
      assert.notEqual(error.stderr, '');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a body carried in formal-review JSON is checked before it is serialised', () => {
  assert.equal(bodyFromReviewJson('{"commit_id":"abc","event":"APPROVE","body":"a\\n---\\n"}'), 'a\n---\n');
  for (const text of ['{', '[]', 'null', '"text"', '{"event":"APPROVE"}', '{"body":42}']) {
    assert.throws(() => bodyFromReviewJson(text));
  }

  const dir = scratch('review-json-check');
  const payload = join(dir, 'approval.json');
  try {
    // JSON escaping collapses every newline into \n, so the defect is invisible to anything
    // reading the payload; GitHub still renders the stored Markdown as a heading.
    writeFileSync(payload, JSON.stringify({ commit_id: 'abc', event: 'APPROVE', body: defect }));
    const bad = run(script, '--review-json', payload);
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, `${payload}#body:2: thematic break not preceded by a blank line\n`);
    assert.equal(bad.stderr, '');

    writeFileSync(payload, JSON.stringify({ commit_id: 'abc', event: 'APPROVE', body: clean }));
    const good = run(script, '--review-json', payload);
    assert.equal(good.status, 0);
    assert.equal(good.stdout + good.stderr, '');

    for (const text of ['{ not json', JSON.stringify({ event: 'APPROVE' }), JSON.stringify([defect])]) {
      writeFileSync(payload, text);
      const error = run(script, '--review-json', payload);
      assert.equal(error.status, 2);
      assert.equal(error.stdout, '');
      assert.notEqual(error.stderr, '');
    }
    // The same Markdown must not pass merely because it travelled as JSON.
    writeFileSync(payload, JSON.stringify({ body: defect }));
    assert.equal(run(script, '--review-json', payload).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed or unrun check performs no publication write', () => {
  const dir = scratch('publication-gate');
  const body = join(dir, 'body.md');
  const published = [];
  // Stands in for `gh issue comment` / `gh api .../reviews`: the gate is exit 0, so a
  // content violation (1) and a usage or read error (2) both leave the remote untouched.
  const publish = (...args) => {
    const check = run(script, ...args);
    if (check.status !== 0) return { published: false, status: check.status };
    published.push(args.at(-1));
    return { published: true, status: 0 };
  };
  try {
    writeFileSync(body, defect);
    assert.deepEqual(publish('--body-file', body), { published: false, status: 1 });
    assert.deepEqual(publish('--body-file', join(dir, 'missing.md')), { published: false, status: 2 });
    assert.deepEqual(publish('--body-file'), { published: false, status: 2 });
    assert.deepEqual(published, []);
    writeFileSync(body, clean);
    assert.deepEqual(publish('--body-file', body), { published: true, status: 0 });
    assert.deepEqual(published, [body]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a reviews-API payload handed to the body-file transport is refused, not passed', () => {
  assert.equal(looksLikeReviewPayload(JSON.stringify({ body: defect })), true);
  for (const text of [defect, '{ not json', '[]', '{"body":42}', '']) {
    assert.equal(looksLikeReviewPayload(text), false, text.slice(0, 20));
  }

  const dir = scratch('body-file-trap');
  const payload = join(dir, 'approval.json');
  try {
    // JSON escaping collapses the body to one line, so the body-file transport would see no
    // separator and exit 0 — and exit 0 on an approval payload authorises a formal APPROVE.
    writeFileSync(payload, JSON.stringify({ commit_id: 'abc', event: 'APPROVE', body: defect }));
    const bare = run(script, payload);
    assert.equal(bare.status, 2);
    assert.equal(bare.stdout, '');
    assert.match(bare.stderr, /--review-json/);
    assert.equal(run(script, '--body-file', payload).status, 2);
    assert.equal(run(script, '--review-json', payload).status, 1);

    // Ordinary Markdown is unaffected, including a body that merely mentions JSON.
    const body = join(dir, 'body.md');
    writeFileSync(body, '## Report\n\nThe payload carries {"body": "x"} inline.\n\n---\nSignature\n');
    assert.equal(run(script, body).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('argument parsing accepts the documented spellings only', () => {
  assert.deepEqual(parseArguments(['body.md']), { transport: 'body-file', path: 'body.md' });
  assert.deepEqual(parseArguments(['--body-file', 'body.md']), { transport: 'body-file', path: 'body.md' });
  assert.deepEqual(parseArguments(['--review-json', 'r.json']), { transport: 'review-json', path: 'r.json' });
  for (const args of [[], ['--body-file'], ['--review-json'], ['a', 'b'], ['--x', 'a'], ['--body-file', 'a', 'b']]) {
    assert.equal(parseArguments(args), null);
  }
});

test('module remains importable from Node eval and stdin entry points', () => {
  const href = new URL('./check-publication.mjs', import.meta.url).href;
  const source = `import { publicationFindings } from ${JSON.stringify(href)}; process.stdout.write(JSON.stringify(publicationFindings(${JSON.stringify('text\n---\n')})));`;
  const runs = [
    spawnSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8' }),
    spawnSync(process.execPath, ['--input-type=module'], { encoding: 'utf8', input: source }),
  ];
  for (const attempt of runs) {
    assert.equal(attempt.status, 0);
    assert.equal(attempt.stdout, '[{"line":2,"message":"thematic break not preceded by a blank line"}]');
    assert.equal(attempt.stderr, '');
  }
});
