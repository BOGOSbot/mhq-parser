# The /rules page

The page that answers a Warhammer 40,000 11th-edition rules question by citing
the rules, rather than by trusting what a model already believes. This is the
functionality document for that page; the army-list parser has its own in
`docs/developer-doc.md`.

## Routes

- `GET /rules` serves `src/rules.html` (read from disk on every request, so
  editing it needs no restart).
- `POST /rules/ask` takes `{ "question": "...", "answerLang": "fr|en",
  "english": true, "stream": true }` and answers with the findings, the judge's
  verdict and the compiled answer. `stream: true` sends one JSON object per line
  (`start`, `translation`, `terms`, `findings`, `escalate`, `judge`, `answer`,
  `done`) so the page can draw the findings before the prose exists.
- `GET /health` publishes `corpus` (sections per half, build date, edition) and
  both inference routes, which the page's badge shows.

## The corpus

The rules are read and embedded ahead of time, not fetched per question. Two
halves live in two namespaces of one Upstash vector index:

| half | holds | source |
|------|-------|--------|
| `rules` | core rules, rules appendix, event companion, core stratagems | Wahapedia 11th-edition pages, plus the CSV export for the core stratagems |
| `factions` | datasheet values and keyword/ability records, stratagems, detachments, enhancements | Wahapedia's official CSV export |

A record is `{ id, source, set, heading, ruleId, anchor, hasAnchor, url, text,
chars, hash }`. The id is built from the source and the anchor, so an ingest can
tell a changed section from a new one and re-embed only what moved.

Chunking is structural. An anchored page is cut at its headings (the ancestors
are written in front of the body, so a vector carries the context it belongs
to); a body longer than 2,000 characters is cut at paragraphs first, sentences
next, a space as a last resort. A datasheet is two records, not one - values on
one side, keywords and abilities on the other - because the two answer unrelated
kinds of question and each is half noise to the other.

**The rules a page writes inside a parent body get their own records.**
`3. End of Shooting Phase` (10.03) carried NORMAL SHOOTING 10.04, ASSAULT
SHOOTING 10.05 and four more as plain text - one 1,938-character record holding
six rules, so a question about normal shooting was answered from a record
labelled something else. 78 of the 285 core-rules records carried 180 rules that
way. `splitInlineRules` cuts a body at a line that is a title and a rule id and
nothing else (blank line before it, no prose in the title: 'The rule refers to
page 10.04' is not a heading) and hands each to a record the parent owns,
`3. End of Shooting Phase > NORMAL SHOOTING`. The parent keeps its id, its
anchor and the text before the first boundary, so citations that already exist
still resolve. core-rules went from 285 records to 339, rules-appendix from 149
to 168, and the longest record from 1,938 to 2,000 characters.

Known weaknesses of the current chunker, both measured:

- **Derived-title buckets run across cards.** 38 core-rules and 31
  rules-appendix records take their heading from the first question in a body
  that then spans several unrelated cards. The splitter now pulls the numbered
  rules out of them, but the container's own label is still the first question
  its body happened to start with.

The on-disk corpus, the CSV export and the index state live in
`workspace/rules-corpus/` (untracked):

```
node src/rules-corpus.mjs --check              # is our copy behind the sources?
node src/rules-corpus.mjs --scrape             # fetch the anchored pages
node src/rules-corpus.mjs --scrape --set factions --cached   # rebuild from the cached CSV
node src/rules-corpus.mjs --ingest             # embed + upsert what changed
node src/rules-corpus.mjs --stats              # what is on disk, and in the index
node src/rules-corpus.mjs --prune --set rules  # delete index vectors the corpus no longer has
```

`RULES_CORPUS_DIR` points the whole thing elsewhere; `RULES_VECTOR_BACKEND=local`
switches from Upstash to the local bge-m3 store.

## The four steps

1. **translate** - a French question is turned into English search terms first,
   because the corpus is English and a literal search cannot match a word that
   is not there. The FR/EN glossary (`src/glossary-fr-en.json`, built from the
   Munitorum Field Manual published in both languages) settles what it knows;
   the model carries the rest. Those terms are search input, never a translation
   shown as a fact.
2. **retrieve** - each half is searched separately. See below.
3. **judge** - a separate model says whether the findings state the rule that
   answers the question, with a confidence and, on a miss, which half to deepen.
   The verdict is binding: a retrieval the judge has called insufficient must
   not go on to produce a confident answer, and a writer that declines the
   findings turns the answer into a statement of absence.
4. **answer** - the writer compiles the cited prose from the surviving findings
   only. Every `[n]` marker resolves to a finding that was really retrieved; the
   server builds the citation link from the record, so a marker and a link
   cannot drift apart.

## Retrieval

Per half, `retrieveWide` does this:

- vector search, 20 hits;
- a lexical pass over the whole corpus with the question's terms plus the
  translation's terms, net `max(60, K * 4)`;
- reciprocal rank fusion of the two lists (their scores are not comparable, so
  only ranks are);
- **Jev** reranks the fused net of `max(jevMax, K + 70)` candidates;
- the top K are taken, then the records the question names by title are put in
  front of them, together with each retriever's own first hit, and a rule's own
  clarifications (`Heading > Child`) travel with it.

Three rules in that path exist because of one question - "Est-ce que Asurmen
peut réembarquer avec son normal move après avoir tiré ?" - which was answered
without the Embarking rule ever being shown to the judge:

- **Terms match at the start of a word.** `embark` used to read the word inside
  `disembark`, and the translation had offered both, so the Disembarking rule
  (1,960 characters, full of the longer word) outranked Embarking (718). `move`
  still reaches `movement` and `moves`.
- **The reranker's net is wider than the cut it fills.** Embarking sat at fused
  rank 54, and Jev reorders what it is given - a net of 50 never showed it the
  rule. At 80 the same passage came back 4th. `jevRank` also spends its
  40,000-character state evenly across however many candidates it is given,
  instead of a flat 700 characters sliced at 40k, which used to ask Jev about
  passages it could not see.
- **Anchoring does not depend on the reranker.** Four measured Jev calls ranked
  Embarking 10th-12th out of 80 - right on the cut - so `entityAnchors` matches
  the words the question and its translation name against heading first words
  (word-start, hyphenated parts kept) and puts those records in front of the
  judge whatever Jev thinks. Candidates rank question words before the
  translation's extra terms, one-word headings before multi-word ones
  (`Embarking` before `NORMAL MOVE`), then by rarity.

**Widening is a loop, not one step.** The first pass asks for 10 findings a
side. Each miss adds 20 findings to the half the judge names, cumulatively, and
the search keeps going while the judge says no. `RULES_MAX_PASSES` (3) is the
ceiling and the last pass is final, so a corpus that really does not hold the
rule still ends in "I do not know" rather than prose. `RULES_MAX_PASSES=1`
restores single-pass behaviour. The judge sees the whole candidate list, with a
per-passage cap from `JUDGE_PASSAGE_CHARS` (2,400) and `JUDGE_TOTAL_CHARS`
(60,000), so a deeply widened pass shows the judge less of each passage - the
ceiling is what keeps that from eating the evidence.

## The two settings

The page offers two, and the server fixes four things for each: the depth of the
first pass, how many times a miss deepens it, how wide the reranker's net is,
and whether the judge reasons.

| setting | first pass | widening | Jev net | judge |
|---|---|---|---|---|
| fast | 5 a side | 2 passes | 60 | no reasoning |
| deep | 10 a side | 3 passes | 80 | reasons (`medium`) |

`ASK_MODES` in `rules-corpus.mjs` is the only place they are written down;
`askMode()` maps an unknown or missing value to `deep`, so a client that does
not know about the setting gets the careful one. The setting is sent as
`mode` in the request body, echoed in a `mode` stream event and in the JSON
response, and remembered in `localStorage` by the page.

Why the split falls where it does, measured:

- The judge's wall-clock is its own reasoning, not the prompt. Holding the
  question and the route fixed, 10 findings and 23 findings came out at a 31.9s
  and a 33.0s mean over five questions - the paired difference was -5.8s, and
  the single slowest call (134.5s) had the smaller prompt. Across 96 single-pass
  benchmark rows, r(findings, retrieve+judge ms) was -0.11.
- Turning the judge's reasoning off takes the judge from a mean 33.0s / median
  20.6s to 7.1s / 6.0s, and costs accuracy: 79.4% to 61.8% on the same 17
  questions.
- Taking 5 a side instead of 10 costs recall: 27/29 questions retrieving an
  expected section against 28/29 (93.1% against 96.6%) on the retrieval bank.
  The anchoring is what keeps that cost small - the rule the question names
  reaches the judge at either depth.

End to end on the Asurmen question, same server, same moment: fast judged in
about 2 seconds where deep judged in about 49, both answering `high` on the
first pass, fast with 15 findings against deep's 23.

## Routes, keys and reasoning

Two inference routes, because the two halves fail differently. The **writer**
(`RULES_MODEL`, `RULES_MODEL_ENDPOINT`, `RULES_MODEL_KEY`; SenseNova by default)
writes the answer the reader sees. The **fast route** (`RULES_FAST_*`) is
everything that only decides or rewrites - the translation, the search terms,
the judge - and with none of the three set it is the writer's own route. Keys
come from the environment first, then from the DSH credential store at
`.dsh/.credentials.yaml`; `RULES_CREDENTIALS` points at another file.

The judge keeps its reasoning (`RULES_FAST_REASONING`, `medium` by default):
without it the same judge scored 61.8% where thinking it scored 79.4%. A call
may take three minutes (`RULES_MODEL_TIMEOUT_MS`, `RULES_FAST_TIMEOUT_MS`); at
90s the thinking judge cut off 7 of 25 real questions. Jev runs on the free
OpenCode Zen gateway (`RULES_JEV_GATEWAY=openrouter` for the paid fallback).
`RULES_EDITION` pins the corpus edition and is not a detail: 10th and 11th
answer the same question differently.

## Measuring it

- `node tests/eval-retrieval.mjs --topk 20 --verbose` - hit@1/5/10/20 and MRR
  against `tests/fixtures/rules-questions.json`, whose expectations are section
  ids. This is the number the corpus and the retriever are graded on. This
  harness predates the two-half split and reads the whole corpus as one index.
- `node tests/eval-retrieval.mjs --retriever dual --per-side 10 --net 60` - the
  page's own path. That is the arm the chunking was measured with: before, 29
  graded questions at hit@1 31% / hit@5 69% / hit@10 86.2% / hit@20 89.7%, MRR
  0.472; after, the same exact-id numbers 27.6% / 62.1% / 86.2% / 89.7%, MRR
  0.437, and 41.4% / 69% / 93.1% / 96.6%, MRR 0.540 when a record the split put
  under the expected one counts - which is what the reader actually gets. Two
  questions that used to miss entirely ("what does the Advance move do", "what
  happens when a transport blows up") now find the rule at #3 and #7 under its
  parent.
- `node tests/eval-reddit.mjs --limit 16` - judge coverage and latency on real
  questions, twice, to compare model routes.
- `node tests/eval-accuracy.mjs --limit 25` - the page's own path, graded by a
  different model against the reddit answer key; `--bank fr` for the six French
  questions. A question already in the output file is not redone, so a run
  resumes.
- `node tests/ask.mjs "<question>"` and `node tests/ask-fr.mjs --id <id>` - one
  question end to end, printed.
- `node tests/test-rules.mjs`, `node tests/test-judge.mjs`,
  `node tests/test-corpus-build.mjs` - edition and anchors, the judge and the
  escalation policy, the CSV builder.

## Known limits

- Derived-title buckets, above: the splitter empties the numbered rules out of
  them, but a bucket's own heading is still whatever question its body started
  with.
- The same rule can appear twice in one answer when the core rules and the rules
  appendix both carry it (two `Able To Embark` records, one per source), and a
  split rule can appear both under its real parent and under a bucket that also
  contained it.
- The rules namespace is in step with the corpus (`--prune` saw to that), but
  nothing prunes `factions` automatically: run `--prune` without `--set` after a
  big rebuild.
