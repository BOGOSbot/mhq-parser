---
tags:
  - mhq
  - corpus
updated: 2026-10-14
---

*The training set the traces produce: one JSONL record per question, the bank as the eval split, and the counts it is honest about.*

# The dataset

`node tests/build-dataset.mjs` reads `workspace/rules-traces/*.ndjson` and writes
`workspace/dataset/dataset.jsonl`, with `manifest.json` beside it carrying the
counts. The record shape is the vault note `notes/mhq-dataset.md`'s; this page
says how the builder fills it and what it refuses to guess.

- **One record per trace**, and the bank through the same shape (`--bank`,
  default `tests/fixtures/rules-questions.json`) with `gold_how: manual` and
  `split: eval`. Traces are the `train` split. The bank is never trained on, and
  nothing harvested enters it without the review a promotion gets today.
- **Gold is groups**, the bank's `expect` shape: any member of a group answers,
  and every group must be satisfied - an alternative is not a hop. A caret, or the
  `answeredBy` pick, is one group (`gold_how: caret`); an up-vote takes the
  passages the answer rested on (`vote`); a judge citation with no reader label is
  marked `judge`, usable for training and never for eval.
- **Negatives are free**: the x marks first, then everything the run showed that
  is not gold.
- **Every id is resolved against the corpus at read time.** An id the corpus no
  longer holds is dropped from its group and reported; a group that loses every
  member is dropped and the record becomes query-only; the manifest counts the
  missing ids per source. task-30 moved 1,594 ids, so a trace from before it can
  name a record that no longer exists. Nothing is dropped silently.
- `--retrieval` runs the page's own retrieval (`retrieveDual`, the trace's own
  mode and the English it actually searched) over every record with gold, and
  reports hit@1/@5/@20 and MRR per lane. The judge lane is circular by
  construction - the judge cited passages the retriever had already shown it - so
  the lane that means anything is the reader's, and today that lane is one record.

## What it holds today (2026-10-14, 89 deployed traces)

| | |
|---|---|
| records | 128 (89 trace + 39 bank) |
| with gold / query-only | 102 / 26 |
| split | train 89, eval 39 |
| gold_how | judge 68, manual 33 (bank), caret 1, none 26 |
| negatives | 1,347 ids over 76 records |
| corpus resolution | 176 ids missing of 1,980, in 40 records (traces) |
| gold groups | 117 before and after - none lost |

And the page's own retrieval over those records (`--retrieval`, the trace's own
mode and the English it searched, the base plan):

| lane | n | hit@1 | hit@5 | hit@20 | MRR |
|---|---|---|---|---|---|
| reader gold (caret/vote) | 1 | 1 | 1 | 1 | 1.000 |
| judge gold - circular | 68 | 17 (25.0%) | 38 | 62 | 0.385 |
| all trace gold | 69 | 18 (26.1%) | 39 | 63 | 0.394 |
| bank eval, same call | 33 | 10 (30.3%) | 22 | 29 | 0.454 |

The judge lane is the whole of the trace figure today, so it cannot settle
anything: the judge cited passages the retriever had already shown it, and the
base plan understates it - four of the 68 cited passages sit past rank 20 and
were only reached by a later, widened pass. It is recorded as the shape of the
number, not as a verdict on the page.

The reader lane is thin for a page reason, not a dataset one: a mark is only
posted once the run ends, so a reader who carets a finding and leaves before the
answer lands leaves no label. The one `caret` record is the `answeredBy` pick;
the only caret/x labels that exist today are in an E2E scratch store, and running
the builder on it (`--dir`) produces the caret gold as it should.
