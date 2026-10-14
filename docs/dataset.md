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
### What the bank actually does (the calibration)

The first constraint banned the rule's name, and the run-length statistic endorsed
it. Measuring the bank instead says the statistic was the wrong one: of its 33
graded questions, **8 (24.2%) carry the expected record's leaf name word for word**
and **21 (63.6%) carry it exactly or as a variant** - `How does Battle-shock work?`
against *Battle-shock Rolls*, `What is a Hazard Roll?` against *Hazard Rolls*. A
real question names the rule and does not recite it. Two populations can share a
median two-word run and mean completely different things by it: the bank's two
words are the rule's name, the first generator's two words were `can a unit`.

### The empty responses, and the fix

The 65 empty retries on the first 100 calls were not a lane problem. The fast
route's default is `reasoning_effort: medium`, and at `max_tokens: 1200` the model
spent **all 1,200 completion tokens on reasoning**: `finish_reason: length`,
content empty, 0 characters. The identical call with `reasoning: 'none'` answered
in **89-131 completion tokens** with a 368-500 character body, `finish_reason:
stop`. That is also where the time went: with reasoning off a call is 8-18 s
instead of 60-100 s.

A second, smaller cause remained: the free gateway drops a burst of replies under
load. The same records answer in ~100 completion tokens when re-sent, so it is
neither the record nor the prompt; a retry that re-sends immediately just rejoins
the burst. The run now ends with a **serial sweep** - the records that produced
nothing are asked again one at a time with a 5/20/60 s backoff. On the corrected
sample it recovered **35 of 35**, so a transient burst costs seconds instead of a
third of the sample.

### The corrected sample (2026-10-14, 100 records, name allowed)

The corrected constraint: the rule's name is allowed, including its plural and
partial forms; what stays banned is reciting the body - three or more consecutive
words from the **passage** (the heading is no longer part of that test, because the
heading is the name). One call per record, reasoning off, concurrency 3, the
serial sweep at the end.

| | before (name banned) | after (name allowed) |
|---|---|---|
| questions | 282 (94/94/94 shapes) | 300 (100/100/100) |
| name exact / exact-or-variant | **0%** / 16.7% | **64.7%** / **92%** |
| run against the passage: median, max, within 2 | 2, 4, 85.8% | 3, 8, **43%** |
| run against heading+passage: median, within 3 | 2, 97.9% | 3, 76% |
| self-retrieval exact: hit@1, hit@5, hit@20, MRR | 1.8%, 36, 105, 0.078 | **13.7%**, 123 (41%), 283 (94.3%), 0.284 |
| calls / records lost to empty replies | 100 / 6 unparsed | 135 / 35 swept, **0 lost** |
| cost per record | 24.0 s wall, 94.7 s of calls | 8.4 s wall, 16.5 s of calls |
| projection to 3,460 records | ~23 h wall, ~9,750 questions | ~8 h wall at concurrency 3, ~10,380 questions |

**The name fix worked and the body fix did not.** Naming the rule went from 0% to
64.7% exact (the 20-record variant, with the weaker wording, hit 77.2%), and
self-retrieval went from 1.8% to 13.7% at rank 1 and 94.3% at rank 20. But the run
against the passage is now **median 3 with only 43% inside two words**: the model,
allowed to name the rule, started reciting the passage - exactly the failure the
run-length check was meant to catch, and the prompt alone does not hold it. A
question that contains three or more words of the passage teaches a copy shortcut,
so the constraint has to be enforced mechanically (regenerate or drop a question
whose passage run is 3) before this lane is emitted. That fix landed in the third
sample below, and the naming mix landed in the fourth.

### The third sample: length, the naming mix, and the body gate (2026-10-14)

Three corrections went in together: the prompt asks for SHORT questions (one clause,
44 characters is the target), it allows the rule's name in at most one of the three
shapes and asks the other two to describe the situation, and a **mechanical body
gate** regenerates a record once when a question recites three or more words of its
passage, then rejects the question. The bank is the reference population.

| | bank (real) | v1 name banned | v2 name allowed | **v3 all three** |
|---|---|---|---|---|
| questions | 33 | 282 | 300 | **275** |
| median chars / words, p90 chars | 44 / 8, 67 | 97 / 17 | 111 / 20, 163 | **52 / 10, 70** |
| name exact, strict | 15.2% | 0% | 25.7% | **12%** |
| any leaf word, strict | 54.5% | 13.8% | 90.7% | **29.5%** |
| passage run within 2 words | - | 85.8% | 43% | **100%** (gated) |
| self-retrieval hit@1 | ~30% | 1.8% | 13.7% | 8% |
| calls / records lost | - | 100 / 6 | 135 / 0 (35 swept) | 183 / 0 (39 swept) |
| cost per record | - | 24.0 s wall | 8.4 s wall | 11.7 s wall, 17.2 s of calls |

Length is now in the right population (52 characters against 44, p90 70 against 67,
from 111), exact naming matches the bank (12% against 15.2%), and the passage run is
two words or fewer **by construction**: 44 records needed one regeneration and 79
candidate questions were rejected for reciting the passage. What is still under the
bank's distribution is the *any* reading - 29.5% against 54.5%: the prompt's "at most
one of the three may name the rule" is closer to a third than to half, and the next
nudge is to allow one or two. Self-retrieval fell from 13.7% to 8% at rank 1, and that
is the expected direction, not a regression: v2's high rank-20 number was partly the
copied passage words, and a correct pair the retriever cannot find is the training
signal - see the framing above.



The strategic half: this lane supplies the **easy mass** - a player who names the
rule they want. The hard cases, a player who describes a situation without knowing
the rule's name, can only come from real questions; that is another reason the
deploy matters, and it is the honest ceiling on what this lane can teach. Whether
even the easy mass is worth training on is still settled only by training on
generated questions and evaluating on the bank.

### What has to match reality (the framing)

**Do not chase the bank's self-retrieval rate.** For training, a pair has to be
CORRECT, not easy: a set the current retriever cannot find is the training signal,
not a defect - it is exactly what an embedder is for. What has to match reality is
the **distribution**: how long a real question is, how it is phrased, and how often
it names the rule. The bank is 44 characters and eight words at the median, 44
characters / eight words (p90: 67 characters), and it names the expected record
exactly in about one question in six and carries one of its words in about half.

### The fast-route audit (reasoning eating the budget)

**The rule, and it will bite the next caller: reasoning is billed to the same
`max_tokens` as the answer, and an empty body is read as "nothing to say" - a
silent failure.** `expandQuery` is the proof: it is one import away from silent
nothing, and nothing on a page would ever say so. A caller that leaves reasoning at
the route's default must either budget for the thinking or turn it off.

The generator's empty responses were a call-shaped bug, not a lane bug, and the
same shape was audited everywhere else the fast route is called:

| caller | budget | reasoning | result |
|---|---|---|---|
| `expandQuery` (search terms) | 900 | route default `medium` | **broken**: 0 characters, where reasoning off returns 156; fixed to `reasoning: 'none'` |
| `translateQuestion` | 3,000 (json) | route default `medium` | holds: all 45 foreign questions in the deployed traces carry a translation |
| `judgeCoverage` | 4,000 (json), 1,200 fallback | the mode's (none fast, medium deep) | holds: 0 of 76 judged traces returned an unparseable verdict |
| `compilePrompt` (writer) | 8,000 | `none` | by design |

At 1,200 tokens with reasoning `medium` the model spent all 1,200 on thinking and
returned 0 characters. `expandQuery` now turns reasoning off, because writing search
terms is a rewrite.

### Scaling, and how to resume it

The full run is the same command with the full sample:

```
node tests/generate-questions.mjs --limit 3460 --concurrency 3 \
  --checkpoint 25 --no-retrieval \
  --out workspace/dataset/generated-full.jsonl \
  --report workspace/dataset/generated-full-report.json
```

- **It resumes itself.** The output file is read at start and every record already
  present in it is skipped, so re-running the identical command after an interruption
  continues where it stopped. Questions are appended as they are made, so a killed
  process keeps everything it had.
- **It says where it got to.** One `CHECKPOINT <iso> <n>/<pending> records this run,
  <calls> calls, <s> wall, <s/record>, <questions> questions` line every
  `--checkpoint` records (25 above), in the run log.
- **`--no-retrieval` keeps it a generation job**; the self-retrieval reading is a
  separate pass over the finished file (`--retrieval-only`).
- A record that produced nothing (an empty burst the sweep could not recover) is
  simply not in the output, so the next run retries it.
- **The gateway serves an identical prompt from its cache**, so re-running a sample
  is nearly free and fast, and a resumed run's `calls` figure understates the work
  actually done. It is why the first checkpoint of the full run read 3.4 s/record
  against the sample's 11.9: the first hundred records ARE the sample's, with the
  same prompt. Read a rate only after the cached records are behind it.

**The operational fact, for whoever calls this gateway next:** the free route returns
**empty bodies** under load; an empty body is fast and silent, so a fast rate can mean
failure rather than throughput; and a retry that re-sends immediately just rejoins the
burst, so the backoff has to be serial. Measured: under the full run's own load, 8 of
19 records came back empty on their first call and the in-call retry could not save
them (3 stayed empty); with the run paused and the same calls made one at a time, 7 of
13 calls still returned empty, but the three-attempt retry recovered every one - 0 of
10 records lost, no sweep needed. The empty body is the CALL's property; what overlap
changes is whether a retry can still land. A serial run is therefore the predictable
shape (~8.5 s/record, no sweep), and the sweep is the safety net for the concurrent
one.

**The same route serves the page, so the counters are published.** `GET /health`
now carries `route` - `calls`, `empty`, `truncated`, `retries`, `recovered`,
`empty_rate`, and the split `byRoute.fast` / `byRoute.model` - so a deployment can
answer "am I retrying half my calls" on itself instead of on a trace. First live
reading, three questions on 8787 in fast mode (English and French): **10 calls, 0
empty, 0 retries, recovered 0** (fast 7, model 3) - the page has NOT been absorbing
the failure, and its real shape is 2-3 fast calls plus one model call per question.
Small sample, and the field traces agree with it (45/45 translations, 0/76
unparseable verdicts).

### The fourth sample: the naming mix lands (the population)

The last nudge: the prompt allows ONE OR TWO of the three shapes to name the rule.
Everything else is the third sample.

| | bank (real) | v2 name allowed | v3 one of three | **v4 one or two** |
|---|---|---|---|---|
| questions | 33 | 300 | 275 | **267** |
| median chars / words, p90 chars | 44 / 8, 67 | 111 / 20, 163 | 52 / 10, 70 | **49 / 9, 68** |
| name exact, strict | 15.2% | 25.7% | 8.7% | **18.7%** |
| any leaf word, strict | 54.5% | 90.7% | 29.1% | **36.7%** |
| passage run within 2 | - | 43% | 100% | **100%** (gated) |
| self-retrieval hit@1 | ~30% | 13.7% | 8% | 10.9% |
| regenerated / rejected | - | - | 44 / 79 | **48 / 104** |
| cost per record | - | 8.4 s wall | 11.7 s wall | 11.9 s wall, 15.2 s of calls |

Both readings now sit between the name-allowed sample and the one-in-three sample -
exact 18.7% against the bank's 15.2%, any 36.7% against 54.5% - and length is on the
bank's population. This is the distribution to scale.






