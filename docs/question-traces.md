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
| `judge` | `answered`, `confidence` |
| `answer` | the cited prose the reader saw |
| `steps`, `elapsedMs` | per-stage timing |
| `unresolved`, `escalated`, `attempts` | how the search ended |

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
