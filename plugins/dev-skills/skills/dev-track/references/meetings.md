# Playbook: meetings

For trackers marked `cat=meetings`, in English or Chinese. The digest covers the **whole meeting** and goes into the **meeting's own body**; no comment is added.

A processed meeting looks like this: its body opens with a digest readable at a glance, the original notes are folded below unchanged, its TODOs are merged into the tracker's TODO list without duplicates, the tracker's Meeting Ledger has a row for it, its title starts with `✅️`, and it is closed.

## 1. Read

- **The notes are not always in the body.** When the body holds only an upload placeholder, digest the notes from the comment that has them and link it on the source line.
- **Source of truth**: the transcript and human-written notes. Fathom's AI `## Summary` and decks generated after the meeting can be wrong (owners swapped, for one). Where they disagree, follow the transcript and say so in the digest, and say so too when the transcript covers only part of the recording; content found only in an attachment goes under the notes section, never among the decisions.
- **Date** from the title (`1104会议纪要`, `20261102`, `@ 20261109`), else `createdAt`, as `YYYY-MM-DD`; a title without a year takes the year of `createdAt`. Relative dates in the notes ("by Friday", "next week") resolve against the meeting date; mark an ambiguous one `待核` / `to check`. **Attendees** are the speakers in the transcript. **Language**: the one the transcript is mostly spoken in — Chinese transcripts get a Chinese digest, English ones an English digest.
- **Attachments** are `https://github.com/user-attachments/files/…` (an uploaded file) and `https://github.com/user-attachments/assets/…` (a pasted image, screenshot or video) links, in the body or a comment. Collect them with a tool and download each into its own new, empty directory; no URL reaches a command line:

```bash
grep -oE 'https://github\.com/user-attachments/(files/[0-9]+/[A-Za-z0-9._%-]*|assets/[A-Za-z0-9-]*)[A-Za-z0-9]' $S/NUMBER/source.json | sort -u > $S/NUMBER/attachments.txt
n=0; while IFS= read -r u; do n=$((n+1))
  if [ "$n" -gt 20 ]; then printf '%s\n' "$u" >> $S/NUMBER/skipped.txt; continue; fi
  mkdir -p $S/NUMBER/att$n
  curl -fsSL --max-filesize 52428800 -H "Authorization: token $(gh auth token)" -o $S/NUMBER/att$n/file --url "$u" ||
    { printf '%s\n' "$u" >> $S/NUMBER/failed.txt; rm -f $S/NUMBER/att$n/file; }
done < $S/NUMBER/attachments.txt
```

  The pattern stops at the end of a file name or asset id, so the prose around a bare URL stays out; a name with other characters is cut short and fails to download, so check `attachments.txt` against the discussion. At most 20 files come down (the rest go to `skipped.txt`); a failed download or one over 50 MB is deleted and its URL goes to `failed.txt`. Report both lists. An `/assets/` link has no file name: take its type from the bytes (`file $S/NUMBER/att$n/file`). Read a `.txt` directly; take only the text of a `.pptx`/`.docx`, running nothing from the file:

```bash
python3 -I - $S/NUMBER/att1/file <<'EOF'
import re, struct, sys, zipfile, xml.etree.ElementTree as ET
MEMBERS, EACH, TOTAL = 2000, 20 << 20, 200 << 20
DIRECTORY = MEMBERS << 8
with open(sys.argv[1], 'rb') as f:                 # the end record: 22 B + a comment of up to 64 KiB
    f.seek(0, 2); f.seek(max(0, f.tell() - (1 << 16) - 22)); tail = f.read()
e = tail.rfind(b'PK\x05\x06')
if e < 0 or len(tail) < e + 22:
    sys.exit('no zip end record: nothing read')
members, directory = struct.unpack('<HI', tail[e + 10:e + 16])
if members > MEMBERS or directory > DIRECTORY:     # checked before ZipFile parses the directory
    sys.exit(f'{members} members, {directory} byte directory declared: over the limit, nothing read')
z = zipfile.ZipFile(sys.argv[1])
info = z.infolist()
total = sum(i.file_size for i in info)
if len(info) > MEMBERS or total > TOTAL:
    sys.exit(f'{len(info)} members, {total} bytes uncompressed: over the limit, nothing read')
names = [i.filename for i in info if i.file_size <= EACH]
for i in info:
    if i.file_size > EACH: print('## skipped, too large:', i.filename, i.file_size)
if 'word/document.xml' in names:
    W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
    for p in ET.fromstring(z.read('word/document.xml')).iter(W + 'p'):
        t = ''.join(r.text or '' for r in p.iter(W + 't'))
        if t.strip(): print(t)
else:
    A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
    for n in sorted((n for n in names if re.fullmatch(r'ppt/slides/slide\d+\.xml', n)), key=lambda n: int(re.findall(r'\d+', n)[0])):
        print('##', n)
        for p in ET.fromstring(z.read(n)).iter(A + 'p'):
            t = ''.join(r.text or '' for r in p.iter(A + 't'))
            if t.strip(): print(t)
EOF
```

  A zip whose declared member count, directory size or uncompressed total is over the limits is refused before anything is read, and a member over 20 MB is skipped; name a skipped or refused file in the report like a failed download.

## 2. The shape of the original picks the `H body` options

| Original | `H body` options |
| --- | --- |
| Raw notes (an exported transcript, typed notes, attachments) | `--fold all --label "Original notes"` (label in the discussion's language): the whole body folds |
| Fathom paste: `## Summary` + `## Transcript` | `--fold Transcript --unlink 'fathom\.video'`: Summary loses its Fathom links (timestamp links keep their text, the `VIEW RECORDING` line goes), Transcript folds; the digest keeps one recording link |
| An earlier digest section that the new one replaces | add `--drop @drop.txt` (the heading extracted into a file, SKILL.md step 3.3) and say so in the report |

`H body` writes LF line breaks where a web post has CRLF; normalize both sides before comparing the folded original with the source.

## 3. Digest (`digest.md`)

Leave out private life, deliveries and chit-chat, and say in one clause on the source line what was left out. In an English meeting:

```markdown
## Meeting digest (YYYY-MM-DD)

Source: the original notes in this discussion (folded at the end), attachment [name](link). Not included: ….
YYYY-MM-DD · Attendees: A, B · [Recording (N min)](recording share link)   ← the recording part only when there is one

**In one line**: the state of things and what this meeting settled.

### Decisions
1. **Bold lead-in**: content.

### TODO
| Item | Owner | When | Tracker |
| --- | --- | --- | --- |

### Risks
- **Bold lead-in**: content.

### Suggestions
1. …

### Notes
- Where attachments or the AI summary disagree with the transcript, quoted prices, names to check.

<sub>Digested by TOOL from … (YYYY-MM-DD); TODOs are tracked in #T.</sub>
```

- A Chinese digest uses the same shape with Chinese headings: `## 会议摘要（YYYY-MM-DD）`, `来源：`, `参会：`, `**一句话**：`, `### 已拍板的决定`, `### 待办` (`事项 | 负责 | 时间 | 台账`), `### 风险`, `### 建议`, `### 说明`, and a Chinese footer. The footer is the digest's last line, so it sits above the fold.
- The attendee line is always there; it carries exactly one recording link when there is a recording, never a `timestamp=` link.
- Decisions are only what the meeting settled; what was discussed but not settled goes under risks or notes. When the meeting compared options item by item, group by topic (`### 1. Topic`) and compare in a table.
- Owners as the notes give them (a name, a team, `both`, `all`); write `TBD` (or `未定`) for a missing owner or date. The Tracker column says where the item went in the tracker: its ID, `new`, or `merged: <first words of the existing item>`.
- Mark quoted prices and unbuilt features as unverified or not built, and follow any other rule the repository's agent instructions set. Keep transcription-garbled names verbatim and mark them `to check` (`待核`).
- The fold is the original, already public in the discussion; never edit it. If it holds credentials or contact details, list them in the report so a person can edit the discussion.
- Suggestions are the editor's own, concrete and actionable, and checked against the repository's agent instructions; omit the section when there are none. Omit any section the meeting has nothing for, rather than writing "none".
- TOOL is the tool actually running this skill (`Claude Code` or `Codex`).

## 4. Tracker

Change only the **TODO list** and the **Meeting Ledger**; keep every other byte.

**TODO list.** Always a GitHub task list (checkboxes and drag-to-reorder), under the tracker's TODO heading and grouped in the `###` subsections it already has. One item per line, in the item format the list already uses, for example:

```markdown
- [ ] Item (Owner / When) —— evidence — [MM-DD](meeting link), [MM-DD](meeting link)
- [ ] 🔄 T5 Item (Owner) — [MM-DD](meeting link) · [MM-DD](meeting link) —— evidence
```

- If the list numbers its items (`T1 …`, which digests cite), keep the numbers and give new items the next one; never reuse a number. Otherwise add no numbers.
- `🔄` in progress and `⛔` blocked go right after the checkbox; ticked means done.
- The same work is one item: merge by meaning and append this meeting's link to the sources. Update owner or time in place when the meeting changed them; reword the item only when the meeting changed the work.
- Keep every existing item, its tick state and its position; append new items at the end of their subsection; **never untick, delete or move an item** — the one exception is the tracker pass folding a duplicate into its twin. People reorder by dragging.
- Tick an item only when completion is confirmed — this meeting says it is done, or a merged PR or recorded decision delivered it; mark it `🔄` when the meeting reports work under way ("fixed, deploying tonight" is `🔄` until the deploy is confirmed). Write the evidence after `——`.
- An item that fits no subsection goes into the closest one; suggest a new subsection in the report rather than adding it.

**Meeting Ledger.** A table, one row per meeting, with the columns and order the tracker already has; the new-tracker default is `Date | Meeting | Attendees | Status | TODO | Recording`, oldest first.

Status is the ledger's digested value (`✅` unless the ledger uses another); update an existing row for the same discussion instead of adding one. Two discussions of the same meeting share one row whose meeting cell links both; say so in the report. When the ledger names meetings in a fixed form (such as `#number YYYYMMDD Meeting notes`), the meeting cell follows it, and a TODO column counts the TODO rows in that meeting's digest. Older per-meeting TODO sections stay in their fold; add no new ones.

### New tracker

F2 creates the tracker with the mark, a TODO list and a Meeting Ledger, in the category's language (English shown; a Chinese tracker uses `## 待办事项` and `## 会议记录`). Start with one subsection and suggest further ones in the report as the meetings show areas:

```markdown
<!-- dev-track:tracker cat=meetings category=CATEGORY -->
## TODO

Maintained by `/dev-track --cat meetings`; drag to reorder, tick only what is confirmed done.

### General

## Meeting Ledger

| Date | Meeting | Attendees | Status | TODO | Recording |
| --- | --- | --- | --- | --- | --- |
```

## 5. Title

Status is always `✅️`. When the ledger names meetings in a fixed form such as `YYYYMMDD Meeting notes`, use it as the title body: `H title --title @title.src.txt --status ✅️ --base "YYYYMMDD Meeting notes"` (in the ledger's language), whatever the old title said. If another meeting already has that title, or the ledger uses no such form, keep the title and only add the prefix.

## 6. Tracker pass

Once per run, after the meetings: read the whole TODO list and merge items that are the same work, including across subsections and across older meetings. The surviving item is the one higher in the list, stays where it is and takes every source link and evidence of the other, reworded if needed so no detail of either is lost; it is ticked only if one of the merged items was ticked with evidence, and a conflict between a ticked and an unticked item goes in the report instead of being resolved silently. Then check that every ledger row links a discussion that exists, and report any that does not.

## 7. Report

TODO items added, merged (with what), ticked or marked `🔄` with evidence; where the AI summary disagreed with the transcript; suggested new subsections.
