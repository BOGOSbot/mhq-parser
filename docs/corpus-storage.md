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
