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
  and every group must be satisfied - an alternative is not a hop. On the trace
  lanes each id is its **own** group of one: every record the reader caret, and every
  passage the judge rested the answer on, is REQUIRED - folding them into one group
  would read as "any one of six passages answers it", which is not what either
  meant. A caret, or the `answeredBy` pick, is `gold_how: caret`; an up-vote takes
  the cited passages (`vote`); a judge citation with no reader label is `judge`,
  usable for training and never for eval. Alternatives (one answer in two places)
  are the bank's shape alone.
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
| gold groups | 450, of which 41 dropped by resolution - 409 kept, no record lost every group |

And the page's own retrieval over those records (`--retrieval`, the trace's own
mode and the English it searched, the base plan):

Two readings, because the trace groups are strict. **Any** is the best rank of any
required record - the bank's `hit@k` convention. **Every** is the rank at which
every required group is satisfied, which is what a reader would call answered.

| lane | n | any @1 | any @5 | any @20 | MRR | every @1 | every @5 | every @20 |
|---|---|---|---|---|---|---|---|---|
| reader gold (caret) | 1 | 1 | 1 | 1 | 1.000 | 1 | 1 | 1 |
| judge gold - circular | 68 | 17 (25.0%) | 38 | 62 (91.2%) | 0.385 | 0 | 2 | 13 (19.1%) |
| all trace gold | 69 | 18 (26.1%) | 39 | 63 (91.3%) | 0.394 | 1 | 3 | 14 (20.3%) |
| bank eval, same call | 33 | 10 (30.3%) | 22 | 29 (87.9%) | 0.454 | 9 (27.3%) | 17 | 24 (72.7%) |

**The bank comparison does not survive the strict reading, and the reason is the
metric as much as the questions.** A trace now carries **5.23 groups** on average
(up to 14 - the judge cites every passage its answer rested on) against the
bank's **1.45**: "every group inside the cut" is mechanically harsher the more
groups a question has. On the one-group records, where the two are comparable:

| one group per record | n | @1 | @5 | @20 |
|---|---|---|---|---|
| bank eval | 21 | 9 (42.9%) | 14 | 19 (90.5%) |
| trace gold | 7 | 1 (14.3%) | 2 | 6 (85.7%) |

So on the `any` convention the two are close (91.3% against 87.9% at 20), on the
strict convention the traces collapse (20.3% against 72.7%) mostly because they
carry 3.6x the groups, and on the like-for-like subset the trace lane is n 7.
The judge lane is circular anyway - the judge cited passages the retriever had
already shown it, and the base plan understates it, since the page widens for a
passage past the first cut. Nothing here is a verdict on the page: it is what a
reader-gold lane of one cannot yet say.

The reader lane is thin because it was not being fed: a mark used to be posted only
when the run ended, so a reader who careted a finding and left before the answer
landed left nothing - the deployed store holds a trace whose answer exists and
whose labels do not, from exactly that. The page now posts each mark the moment it
is clicked and the server holds it against the question's id until the line lands
(`docs/question-traces.md`, "The caret and the x"), so the lane fills from the next
reader. The one `caret` record today is the `answeredBy` pick; the only caret/x
labels that exist are in an E2E scratch store, and running the builder on it
(`--dir`) produces the caret gold as it should.
## The generation lane

The trace and bank lanes need users; this one does not. `tests/generate-questions.mjs`
takes one corpus record, asks the FAST ROUTE for three questions a player would
type whose answer is exactly that record, and emits each through the dataset's
own schema: `gold: [[recordId]]` (one required group of one), `gold_how:
generated`, `source: generated`, `split: train`. It writes
`workspace/dataset/generated.jsonl`, and `build-dataset.mjs` folds that file in
when it is there (`--no-generated` builds the user lanes alone). The bank is never
touched.

The constraints are the calibrated ones, in the prompt as given: never the rule's
name, never three consecutive words from the heading or the text, ordinary player
register, and one shape each - a yes/no, a when/why, and a concrete tabletop
scenario. One call per record asks for all three.

**What is not a rule is excluded before generating**, and the run reports each
reason:

| excluded | n |
|---|---|
| datasheets (a stat block; its name is its only handle and the constraints forbid it) | 1,548 |
| unitrules (keyword lists) | 1,504 |
| index pages | 163 |
| fragments under 140 characters | 15 |
| bare container headings | 8 |
| keyword lists (more than 45% shouted keywords) | 4 |
| points fragments | 3 |

That leaves **3,460 records** a question can be written from. A question written
from a points line - `models 135 pts; 5 models 145 pts` - trains nothing, which is
why the filter runs first.

**The honest risk, and no number in this file settles it:** a question written FROM
a rule may still be easier than one written by a confused player. The only test
that settles it is training on generated questions and evaluating on the bank.
Until that runs, the sample below says the generator is calibrated to real
phrasing - not that it is as hard.
### The sample (2026-10-14, 100 records)

| | |
|---|---|
| questions | 282 (yes/no 94, when 94, scenario 94) |
| longest shared run with the target | median **2**, **97.9% within 3**, max 4 |
| questions that wrote the rule's name | **0 (0%)** |
| self-retrieval, the exact record | hit@1 **5 (1.8%)**, hit@5 36, hit@20 105, MRR 0.078 |
| self-retrieval, any record of the same rule | hit@1 10 (3.5%), hit@5 44, hit@20 115, MRR 0.105 |
| calls | 100 for 100 records (65 empty retries, 6 records unparsed) |
| cost | 2,402 s wall at concurrency 4 (24.0 s/record); 9,466 s of calls (94.7 s/record) |
| projection to 3,460 records | ~23 h wall at concurrency 4, ~9,750 questions |

The run-length calibration holds - median 2 and 97.9% within 3, against the real
bank's 85% within 3 - and no question writes the rule's name. **The self-retrieval
does not hold**: a question written from a record finds that record 1.8% of the
time at rank 1 and 37% at rank 20. The reason is the constraint working as
designed: a question that shares no name and no three-word run with its record
gives the retriever almost nothing to hold. A control says the retriever is not
the broken half - "What is Firing Deck?" ranks an ability copy at 1 while the three
headless questions about that rule rank 3, 11 and nothing - and corpus duplication
is not the explanation either, since scoring ANY record of the same rule only moves
hit@1 from 1.8% to 3.5%.

So the honest reading: the generator writes player-register questions that are not
identifiable by the page's own search. That is either a generator paraphrasing past
the point of searchability or a constraint that removes the retriever's only
handle, and this sample cannot tell the two apart. One shape with the name allowed,
or a four-word run, would. The train-on-generated / evaluate-on-the-bank test
remains the only one that settles whether these questions are worth training on.


