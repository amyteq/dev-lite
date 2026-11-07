# Issue refinement region

Read the preservation and authority rules in [the skill](../SKILL.md) before preparing this body. This template is the generated refinement region, not a replacement for the full issue. Preserve the human-owned body and all approved ACs. Use the applicable local issue form's fields, stable existing IDs and current approved task contract. The region is a short summary that links the task comment; per-AC checks, ordered instructions and read-first detail belong in the task comment, not in both.

If an unambiguous region already belongs to this skill, update it within authorization. Otherwise append one region without changing the original prefix. Never nest AUTO regions or take over another generator's region. A generic refinement request does not authorize replacing approved text. `select` reads the `**Current task:**` pointer only from a visible line in this region's `## Execution` section, which runs from that heading to the next depth 1 or 2 heading, so write that heading once, keep it and the pointer on their own lines, and leave no stale copy in another section, in human-owned text, a code fence or an HTML comment.

Fill every slot before publication. Omit genuinely inapplicable sections with a short reason. The operative AC block between `<!-- acs:begin -->` and `<!-- acs:end -->` must be byte-identical here and in the task comment, because `acs` compares bytes, not Markdown. Keep each marker on its own line and write no other copy of either marker line. Proposed contract changes remain separately marked outside that block and cannot authorize implementation.

````markdown
<!-- AUTO:BEGIN -->
<!-- dev-refine-issue:body -->
## Issue refinement

### Goal and scope

<A few sentences: observable outcome, included deliverables and non-goals. Preserve the approved scope.>

### Contract and dependencies

<Approved task and decision links; base branch; owner/reviewer; dependency state and evidence; exact write boundary.>

### Acceptance criteria

<!-- acs:begin -->
<Preserve the current IDs and text. Add only authorized criteria with unused IDs, each a closed case list. Cite the same canonical AC list carried by the task comment.>
<!-- acs:end -->

### Plan, validation and evidence

<A short paragraph: the order of work, the repository’s documented checks and explicit offline/live limits. Each AC's check and evidence stay in the task comment.>

### Authority and open items

<Current human request and allowed actions. Owner requirements and confirmed decisions, each with its canonical reference. Engineering suggestions, labelled as suggestions and never as requirements. Assumptions and proposals, such as a proposed closed form or a split into separate issues, clearly separated. Required unresolved decisions or prerequisites.>

## Execution

**Current task:** [Task instructions, revision R](<returned-and-verified-permalink>).

<Keep exactly one truthful readiness sentence: ready for explicit human dispatch; blocked by the named material decision; or not ready because the named prerequisite/readiness gate is missing. Publishing this region and comment does not start implementation.>

**Goal prompt**, only where supported and after readiness:

```text
/goal Execute from <returned-and-verified-permalink>. <deliverable and destination>. Continue until <observable completion condition>, or a stated stop condition applies.
```

**Plain-language prompt**, the same task and authority:

```text
Execute from <returned-and-verified-permalink>. <the same deliverable, completion condition and stop conditions>.
```

<For a blocked/not-ready task, state that both prompts are prepared and must not be dispatched until the named gates are satisfied.>

The receiving session must retrieve the task and canonical sources and verify their current authority. A slash command supplies no authorization or readiness transition.
<!-- AUTO:END -->
````

Use soft-wrapped Markdown and leave a blank line before a thematic `---` separator; `check-publication.mjs --body-file` verifies that on the assembled full body before it is published. Do not alter human-owned text merely to reformat it. Keep unsupported sections visibly unresolved instead of inventing owner, priority, budget or approval.

## Plan, write and verify the body

Save each body with `jq -j '.body // ""'` from `gh api repos/<owner>/<repo>/issues/<n>` so no newline is added: `snapshot.md` when preparing, `live.md` immediately before writing and `published.md` after it. Examples use placeholders only; substitute verified values:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/check-refinement.mjs" plan --snapshot snapshot.md --live live.md --region region.md --out planned.md
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-publication.mjs" --body-file planned.md
gh issue edit <n> --repo <owner>/<repo> --body-file planned.md
node "${CLAUDE_SKILL_DIR}/scripts/check-refinement.mjs" preserve --before live.md --after published.md
```

`plan` exits `1` and deletes any stale `--out` file when the live body differs from the snapshot or holds a region it cannot own: two regions, an unpaired marker, another generator's region, or a marker hidden in a code block or a multi-line HTML comment. It never repairs one. If `planned.md` is byte-identical to `live.md`, there is nothing to write; skip the edit and the history check.

After the write, retrieve the body again and compare it with `planned.md`, then run `preserve` against `live.md`. If either comparison fails, stop and provide the issue link, whose body’s “edited” menu shows the history. Preserve snapshots and restore nothing automatically.

These are read-before-write and readback checks, not an atomic conditional write. An edit between the final read and the update can still be overwritten before readback; do not claim that every race is detected. If concurrent editing is known or suspected, stop before publishing and reconcile with the author. GitHub’s [`UserContentEdit.diff`](https://docs.github.com/en/graphql/reference/users#usercontentedit) is a change summary, not a guaranteed complete historical body: it can support an investigation but must not be compared byte-for-byte as though it were the prior snapshot.
