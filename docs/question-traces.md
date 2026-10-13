# Question traces

What the /rules page keeps about a question, where it is written, and why the
writer is off until the reader has been told. The page is described in
`docs/rules-page.md`; the corpus it searches in `docs/corpus-storage.md`.

## What is kept, and what is not

A question is kept so the page is improved from real questions instead of guessed
at. What must never be in a trace:

- **No identifier.** No IP address, no user agent, no cookie, no account and no
  session id. `id` is 8 random bytes generated per question and ties to nothing:
  it exists so a trace can be cited, not so a reader can be followed. The ask path
  reads no request header at all - the only `req.headers` use in the server is
  the parser's login cookie on a different route - which is what makes this true
  rather than promised.
- **No corpus passage.** A finding is a pointer - `set`, `source`, `ruleId` and
  the record `id` - never its excerpt or its heading. A retained copy of
  third-party prose would be a second corpus, growing, inside the reader's store.
  The compiled answer is the one corpus-derived thing kept, and only because the
  eval bank cannot grade an answer it does not have.
- **No judge reasoning.** `why` quotes passages; only `answered` and
  `confidence` are kept.

## The shape

One JSON line per question (`src/rules-traces.mjs`):

| field | what it is |
|---|---|
| `id` | 8 random bytes, per question |
| `at` | when it was asked; the retention sweep reads it |
| `edition`, `corpusAt` | the edition, and the corpus build the answer came from - a trace against a stale corpus is worthless as an expectation, and afterwards there is no other way to tell. `/health` publishes the same stamp |
| `mode`, `lang` | the setting the reader chose, and the language detected |
| `question` | the reader's own words |
| `asked` | the English it was translated into, only when it was not English |
| `terms` | the search terms |
| `kind` | `unknown` - see *The taxonomy* |
| `signals` | `firstPerson`, `termMatch`, `sources`, `halves`, `rules` |
| `counts`, `findings` | how many per half, and the pointers |
| `judge` | `answered`, `confidence`, `reasoning` (the binding judge's setting), `cited` (the finding numbers the verdict rested on - pointers, no prose) |
| `judge2` | the second judge's `answered`, `confidence`, `reasoning` |
| `judgeDisagreement`, `judgeDowngrade`, `judgeDissentFrom` | whether the two disagreed, whether the dissent was allowed to downgrade the answer, and which judge it came from |
| `answer` | the cited prose the reader saw |
| `vote` | `up` or `down`, written after the fact by the thumb on the answer - absent until someone votes, and one vote per trace |
| `steps`, `elapsedMs` | per-stage timing |
| `unresolved`, `escalated`, `attempts` | how the search ended |

## The thumb

Every answer carries one thumb up and one thumb down. The vote is a boolean
written **into the trace record it is about**, by question id, through
`POST /rules/vote`; a second vote replaces the first. The trace is written
whether or not anyone votes - most readers never click - so the vote is a bonus
on top of the saved record, never the signal itself: a vote for a question whose
line has been swept is dropped (`{ saved: false }`) rather than starting a
second store. It adds no identifier: it is one value beside the question's random
id, and it is stored with the question, apart from the corpus.

## Where it is written

`workspace/rules-traces/YYYY-MM.ndjson`, appended, one line per question, under
`workspace/` - untracked, per-machine, never committed, the same posture as the
corpus. It is deliberately **not** inside `workspace/rules-corpus/`: the corpus
is third-party, the questions are the reader's, and neither belongs in the
other's store. `RULES_TRACES_DIR` points it elsewhere.

The writer is **off** unless `RULES_TRACES` is `1` / `on` / `true` / `yes`,
and the switch is not flipped until the page carries the retention line in both
languages. Keeping a question without telling the reader is the one thing that
line exists to prevent, so the order is: disclaimer live, then the switch. The
line is drafted in both languages and waiting on Mandal's wording; nothing is
written until it is on the page.

## Retention

Raw traces are kept **12 months**, and the sweep rides the monthly ingest so it
cannot be forgotten: `--ingest` prints a `traces` line (files, kept, past the
window) and `--ingest --dry-run` reports it without deleting anything. The sweep
reads each line's `at`, not the file's age, and a line it cannot date is kept
rather than deleted - deleting what cannot be dated is how a sweep loses data it
was never meant to touch.

The bank is a different store and is never swept. A question promoted into
`tests/fixtures/rules-questions.json` is tracked and kept forever, so the raw
trace that produced it can expire without losing the question; the sweep only
ever touches `workspace/rules-traces/`.

## Promoting a trace into the bank

The bank grows from real questions, and a trace is the raw material. Two commands
(`tests/promote-traces.mjs`):

```
node tests/promote-traces.mjs --harvest [--limit N] [--all]
node tests/promote-traces.mjs --list
node tests/promote-traces.mjs --promote --id <traceId> --expect <id>[,<id>] --kind <label> [--dry-run]
```

`--harvest` is the labelling pass: read-only, one block per trace in the harvest
order, with the question, the derived class, the thumb, the verdict and the top
findings with their ids and headings. `--list` is the one-line summary of the
same, and `--classify` counts the retained traces by class. A trace the reader
marked prints `answeredBy: <record id>` or `answeredNone: true` beside the thumb -
an assertion and not the rerank's kept set, a candidate for the expectation and
never the label, so `--promote` still takes its `--expect` and `--kind` from the
human.

`--list` shows every trace with its question, when it was asked, the language, the
setting, the writer's mode, how many findings it carries and the first few record
ids it retrieved - so a human has something to pick from. `--promote` appends one
entry to `tests/fixtures/rules-questions.json`.

- **The label is the human's, never derived.** The bank's kinds name the failure
  mode a question is put in the bank to catch; the derivation agreed with 63.6% of
  the hand labels and caught none of the cross-source or multi-hop ones, which is
  why a trace writes `kind: unknown`. Promotion is where the judgement is made.
- **The expectation is the human's too**, but the trace offers candidates: the
  records it really retrieved, in the order the page put them, which is already the
  anchoring order. `--expect` is validated against the corpus, so a typo is caught
  before it becomes a fixture.
- **A broken run cannot be promoted.** A trace whose `writer` is `empty` or
  `timeout` is refused, and a trace written before that field existed is judged on
  its answer instead - an empty answer is a writer failure whatever the field says.
  `writer` is the **prose** outcome and nothing else: the unit card is additive
  now, so a card that previewed a datasheet does not set this field, and which
  datasheet it was is in `card: { id, name }`.
- **A question already in the bank is not promoted twice**, matched on the question
  text, case- and space-insensitive.
- **Existing entries are never touched.** The new one is appended as text before
  the closing bracket, so the fixture's own formatting and every line above it
  survive byte for byte.
- **Promoting copies what the bank needs and nothing else** - the question, the
  expectation, the label. The raw trace still expires on its own clock (12 months,
  swept with the monthly ingest) and the trace id is not stored in the fixture: the
  bank is the durable record.

### Who writes an expectation, and what checks it

The question and the label come from the reader; **the expectation is ours**, and
it is never the trace's own top finding. A trace's findings are the retriever's
own output, so an expectation copied from the first of them is circular: the
expected record is in the findings by construction, and hit@K for that question
reads 100% whatever the retriever does. The expectation is the record that
actually answers the question - chosen by reading the question and the candidates
`--list` prints, not by trusting the order - and it may be none of them (an empty
`--expect` with `kind: out-of-corpus`).

What the tool checks: every `--expect` id is validated against the corpus, so a
typo fails before it becomes a fixture; `--kind` must be one of the bank's labels
(the derivation's 63.6% agreement is a sorting aid, never the label); a trace whose
writer failed is refused; a question already in the bank is refused; and the entry
is appended, so every existing byte of the fixture survives. What no tool can check
is whether the expectation is right. That is the human's, and it is the one part
of the bank a machine must not write.

### What the first harvest did not show

The first pass promoted five traces (2026-10-13) and one of them is worth its own
note for what it did NOT show. The English 'Can a unit shoot after it Fell Back?'
trace did not carry the FALL-BACK MOVE record among its 25 findings, while its
French twins retrieved it at rank 3-4 - and on the bank's fixed path (dual,
`--rerank off`, per-side 10, net 60) the same English question retrieves it at
#9. So the difference is **configuration** - the trace ran deep with the reranker
on - not the question's language. Read no language effect out of a comparison
whose two sides ran different settings; the bank entry is what pins the rank on a
fixed path.

### Where a promotion is graded

A promoted question grows the **retrieval** bank,
`tests/fixtures/rules-questions.json`, which
`node tests/eval-retrieval.mjs` grades. The accuracy harness
(`tests/eval-accuracy.mjs`) grades its own banks - reddit by default,
`fixtures/rules-questions-fr.json` for `--bank fr` - and does not read this
fixture, so a promotion does not move its n or its accuracy number.

### The harvest order

`--harvest` prints in the order a human should work: traces whose thumb is down
first (a reader said the answer was wrong), then the ones whose verdict cited a
passage (`judge.cited`, or the writer's `[n]` markers on a trace older than the
field), then the rest, newest first - and each line carries the derived class as a
sorting aid. Neither command writes anything; the expectation comes back through
`--promote` with a human's ids and label, one question at a time.

## The taxonomy

The eval bank labels a question `literal`, `paraphrase`, `player` or
`cross-source`. Read against the fixture, those name the **failure mode the
question was put in the bank to catch** - a curation decision, not a property of
the text. The best derivation available to the server, from the question and the
records it reached, agrees with the bank's own 29 hand labels **21/33 (63.6%)**,
and catches **0 of 4** `cross-source` and **0 of 2** `multi-hop`. So a trace
records the signals a label would be made from and writes `kind: unknown`; the
label is assigned when a trace is promoted into the bank, which is where the
judgement was made in the first place.

`node tests/test-traces.mjs` prints that measurement and fails if the derivation
ever becomes good enough to revisit the decision. It also checks the switch
defaults off, that no identifying key can appear anywhere in a trace, and that a
finding is stored as a pointer rather than a passage.
