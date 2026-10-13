# Corpus storage

Where the /rules corpus lives, why it is not in this repository, and what the
off-disk copy is. What the corpus *is* and how it is built is in
`docs/rules-page.md`; this is the storage posture only.

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

| | |
|---|---|
| snapshot id | `5f703039-dc4f-4ae6-b7ed-9ede21a73eb8` |
| box it was taken from | `darling-molly-53895` (deleted) |
| snapshot size | 8,338,127 bytes, status ready |
| taken | 2026-10-14 |
| holds | `rules-corpus-20261014-0146.tar.gz`, 4,164,914 bytes |
| sha256 | `2ad929d4e1c699051fa31fe75e3cc247ed0df70e565a7d0d8e6393bb425dfeaa` |
| restore checked | yes - restored into a fresh box and the sha256 inside matched |

**The trap, written down because it bites:** `box snapshot list` needs a box
selected, so once the box is deleted the snapshot id is the ONLY handle on the
recovery point. If the id is not written here, the snapshot is unreachable in
practice even though it exists.

The corpus has changed since that first snapshot (the task-30 and task-37/38
restructures), so the next snapshot supersedes it; the cadence is tied to the
ingest, not to a calendar.

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

## What must not happen

- `git add -f` to get a corpus file past `.gitignore`, for any reason.
- A "temporary" corpus dump committed to move it between machines. Re-scrape.
- The corpus copied into a tracked file to make a test pass.
