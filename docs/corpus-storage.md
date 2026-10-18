# Corpus storage

Where the /rules corpus lives, why it is not in this repository, and what the
off-disk copy is. What the corpus *is* and how it is built is in
`docs/rules-page.md`; this is the storage posture only.

## The frame: the source is refetchable, the parser is the artifact

The corpus is a **cache**, not a document. Wahapedia's pages and its CSV export are
refetchable on demand, so nothing here is irreplaceable: losing a file costs a scrape,
not data.

What is *not* replaceable is the **parser**, because it runs again on every Wahapedia
update - a balance pass, a new edition, an FAQ. A loss it has is therefore not a one-off:
it fires on the next update, silently, with nobody watching the diff. The parser's
contract is that it reproduces the corpus it produced, and the drift guard below is what
holds it to that.

So read **"a file is wrong" as "the parser is wrong"** until proven otherwise - never as
"restore the file and move on". The reverse also holds: before blaming the parser,
compare like with like. The pipeline has two stages and the stored file is the output of
the **second** one.
## What is in workspace/rules-corpus/

68 files, 21.8 MB, on one machine (measured 2026-10-13): the scraped Wahapedia
pages (`core-rules.html`, the source HTML the extractor reads), the built corpus
per source (`core-rules.json`, `rules-appendix.json`, `event-companion.json`,
`factions-csv.json`, `core-stratagems.json`), the CSV export under `csv/`, and
the ingest state (`*.index.json`, `*.rebuilds.json`). The index itself is not
here - it lives in Upstash - but the state that says what was pushed to it is.

## The snapshots

The off-disk recovery point is a Box snapshot, taken after each monthly ingest and
after any corpus restructure. `node src/box-snapshot.mjs` tars the corpus, prints
the sha256 and the box recipe; the box side is a few commands and about two
minutes.

| snapshot id | taken | holds | sha256 | restore checked |
|---|---|---|---|---|
| **`f566615f-1667-4524-b475-daf07c97a983`** | 2026-10-18 | `rules-corpus-20261018.tar.gz`, 3,209,181 B | `ff92ff4b91e2992f7c2a6b101225c57a88c346344b55f9875b0c825549ffe13c` | yes (restored into `more-caribou-03676`, hash matched, both boxes deleted) |
| `9418c840-18db-444b-9e77-6e176165db65` (superseded) | 2026-10-17 | `rules-corpus-20261017.tar.gz`, 3,205,616 B | `de3961ab6318a9bd3d4840e19d77d80eb6e5129209ac3674d384cb6c6fb7bbc3` | yes (restored into `top-ostrich-13225`, hash matched, both boxes deleted) |
| `0cbbbc59-5043-4dc0-8617-629f2c2f5b24` (superseded) | 2026-10-16 | `rules-corpus-20261016.tar.gz`, 3,191,557 B | `2e04a0e7b176495640da905f3ccfc14dabbfd44e7746cc10f180bbf44d87206e` | yes (restored into `many-bird-81711`, hash matched, both boxes deleted) |
| `322e7b93-21ee-4aab-b6cd-0a4a8782642a` (superseded) | 2026-10-15 | `rules-corpus-20261015.tar.gz`, 4,399,943 B | `84bff8775b97b8b4b9fa9849e2dd4aa8d41fe15d558112d692e7c25ff3d6ff6b` | yes |
| `5087ed6c-efa1-4bac-8aca-ad02ef6a6c88` (superseded) | 2026-10-15 | `rules-corpus-20261015.tar.gz`, 4,384,405 B | `e6e89de214b6f04037af189ed8c700de5f9d6a4cf4aaeb1e88e01a5ff182b978` | yes |
| `5f703039-dc4f-4ae6-b7ed-9ede21a73eb8` | 2026-10-14 | `rules-corpus-20261014-0146.tar.gz`, 4,164,914 B | `2ad929d4e1c699051fa31fe75e3cc247ed0df70e565a7d0d8e6393bb425dfeaa` | yes |

Both boxes are deleted and `box list` is empty. The snapshot's own reported `size_bytes` (10,219 every time) is metadata, **not the payload** - it is no use as a completeness check, and the restored file's sha256 is the only one that counts.

**The trap, written down because it bites:** `box snapshot list` needs a box
selected, so once the box is deleted the snapshot id is the ONLY handle on the
recovery point. If the id is not written here, the snapshot is unreachable in
practice even though it exists.

After the 2026-10-18 task-94 rebuild the corpus holds **7,364 records / 6,326 delivered** (rules 814): 19 numbered sections the 80-character floor had been dropping came back (11 of them the appendix's one-line definitions, `01.07.02 Battle-shock Test` among them). Before that, 7,345 / 6,307
- the rulings branch (154, WTC + FEQ), the 19 universal ability definitions, the 43 mission
cards, and 62 faction-ability records (57 distinct names from `Abilities.csv` plus 5 split
parts; 14 names the core rules already carry are excluded). Before task-85 it was
7,311 / 6,271: the drop was the re-chunking that fix exposed, not lost text. Take the next
snapshot after the next ingest - the cadence is tied to the ingest, not a calendar.

**The archive excludes `assets/`.** The 43 mission card faces are ~9 MB of gdm's images
and the Box CLI refuses the full archive ('file exceeds maximum size of 100 MB' on an
11 MB file, measured 2026-10-17 on both a small and a medium box). They are refetchable
and `assets/missions/sources.json` carries each url and sha256, so a restore re-downloads
them; the JSON corpus and the raw sources - the part with no other copy - are all in.

## Why it is not ours to publish

It is third-party material: Games Workshop's rules text as served by Wahapedia,
and Wahapedia's own CSV export. That is copyrighted whether or not this
repository is public, so it is not committed, and it is not a close call. The
benchmark fixtures under `tests/fixtures/` are a different thing and are tracked:
they are Reddit posts, they are small, and they are the answer key the harness
grades against.

## The posture

- **Untracked.** `workspace/` is in `.gitignore`, and no path under it has ever
  been added to a commit on any branch. `git ls-files` lists 311 files and none
  of them is a corpus file; searching the tracked tree for distinctive rule
  sentences finds nothing.
- **Per-machine and regenerable.** The corpus is a cache of what the sources
  said, not a source of truth. `--scrape` rebuilds it from the pages,
  `--scrape --set factions --cached` rebuilds the faction half from the CSV, and
  `--ingest` re-embeds only what changed. A machine that loses `workspace/`
  loses the scrape time, not the data.
- **Never in git history, ever.** Not in a branch, not in a tag, not in a stash.
  A blob that reaches the history is in every clone of it, and `git rm` does not
  take it back out. The only fix is not adding it.
- **The off-disk copy is a Box snapshot, taken after each monthly ingest.** That
  snapshot is the recovery point if a machine dies and the only copy outside the
  machine, so its cadence is tied to the ingest rather than to a calendar.
- **Encryption only if the sources themselves ever need archiving.** The sources
  are public web pages, so a snapshot of them exposes nothing that is not already
  published - encrypting it is defence in depth, not a requirement, and no
  encryption tooling is installed for it. If a snapshot ever holds something the
  sources do not (a private corpus, a paid export), encrypt the archive before it
  leaves the machine.

## Checking it

```
git ls-files -- workspace/                # must print nothing
git check-ignore -v workspace/rules-corpus/core-rules.json
git log --all --diff-filter=A --name-only --pretty=format: | grep '^workspace/'   # nothing
git grep -l -F '<a sentence only the corpus holds>'                               # nothing
```

## The local snapshot, before any write

`--scrape` (every `--set`) and `--ingest` call `snapshotCorpus()` in `src/rules-corpus.mjs`
before touching the corpus. It writes a plain `ustar` + gzip of the whole directory to
`workspace/box-snapshot/rules-corpus-YYYYMMDDHHmm.tar.gz` and keeps the last **three**,
deleting older ones. `--no-snapshot` skips it; a dry run writes nothing and therefore
does not snapshot. A failed snapshot prints `snapshot    failed: ...` and does not abort
the command - if that line appears, stop and fix the snapshot before going on.

The snapshot is deliberately not the Box copy: the Box one is the off-disk recovery
point taken after an ingest, this one is the local rollback point taken before the
write that could go wrong. Both exist; neither replaces the other.

## Restore one file

The 2026-10-16 incident: a local rebuild script overwrote `core-rules.json` **and its
own backup** (the backup was the re-parse it had just written, not the original), and
the file came back only because the preceding box snapshot happened to hold the
directory. Restore is therefore **extract to a temp dir and copy the one file** - never
extract over the live directory, which would put back files that are newer on disk:

```powershell
cd C:\GitRepos\mhq-parser
# 1. see what the snapshot holds
tar -tzf workspace/box-snapshot/rules-corpus-202610151200.tar.gz | Select-Object -First 20

# 2. extract to a temp dir OUTSIDE the live corpus
New-Item -ItemType Directory -Force -Path workspace\restore-tmp | Out-Null
tar -xzf workspace/box-snapshot/rules-corpus-202610151200.tar.gz -C workspace\restore-tmp

# 3. copy only the file that was lost
Copy-Item workspace\restore-tmp\rules-corpus\core-rules.json workspace\rules-corpus\core-rules.json -Force

# 4. check it, then clean up
node src/rules-corpus.mjs --stats
Remove-Item -Recurse -Force workspace\restore-tmp
```

On Linux or macOS: `tar -xzf ... -C /tmp/restore`, then `cp /tmp/restore/rules-corpus/core-rules.json workspace/rules-corpus/core-rules.json`.
`--stats` is the check that matters: per-source section counts, corpus records, delivered
records, and whether the index still matches the delivered set. Restoring one file
should leave all of them as they were - and it changes nothing in the index, so there is
nothing to re-ingest.

## The drift guard

`tests/test-corpus-drift.mjs` runs the pipeline from **source only** - the scraped HTML
and the CSV export on disk, nothing stored - in a temp directory passed explicitly into
the build, and checks three things:

- the **scrape stage** (382 sections / 289,486 characters of `core-rules`);
- the **shape stage** (382 sections / 289,486 characters of `core-rules`;
  `factions-csv.json` at 6,396 sections / 10,013,445 bytes; `abilities.json` at 62);
- **no rule text is lost**: every stored section the rebuild does not reproduce
  verbatim still has its text in the rebuild, allowing for re-chunking, and the
  comparison is content-based: it strips the whitespace task-85 removed and the
  `- <kind>:` link lines, so it cannot read an intended fix as loss.

A parser change that drops a sentence, a section or the CSV output fails the test. The
baselines move only when the change is intended, in the same commit, with the reason in
the test's docstring; the CSV check is a **content** identity, not a file identity - the
rebuilt file differs from the stored one by its own `scrapedAt` stamp.

### The two traps this test exists to avoid

**The stage trap.** The stored `core-rules.json` is the SHAPE stage - the output of
`writeWikiCorpus` in `src/wiki-build.mjs` - not the scrape stage. Comparing a fresh
`extractSections` output (375 sections) with it (401) and calling the difference loss
was a real mistake here: the 26 extra sections are the shape stage's own work. The
stored file is not reproduced section for section even by the full pipeline: the shape
stage re-chunks long rules (the `~2` parts), skips the 18 core-ability records because
the ability-defs builder owns them (see the note in `writeWikiCorpus`), and the step-5
fix stops the `See-Also` widget becoming a section at all - its list rides on the
enclosing rule instead. Those are structure and duplicates, not lost rules; the
stored-only sections' text is present in the rebuild.

**The env trap, fixed.** The corpus directory is resolved per call, and `readPlanInput` /
`writeWikiCorpus` take it explicitly: a build with no data and no explicit directory
**throws** rather than falling back to the live corpus, and the drift guard proves the fix
by using static imports. Before that fix (2026-10-16) the fallback made a temp-dir build
read the LIVE corpus and write it back - a perfect reproduction of itself, which read as
'zero drift' and produced a figure that measured nothing.

## What must not happen

- `git add -f` to get a corpus file past `.gitignore`, for any reason.
- Extract a snapshot over `workspace/rules-corpus/` in place: it would restore files that are newer on disk.
- A "temporary" corpus dump committed to move it between machines. Re-scrape.
- The corpus copied into a tracked file to make a test pass.
