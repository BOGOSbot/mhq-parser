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

Known weaknesses of the current chunker, both measured:

- **Inline numbered rules never become records.** 78 of the 285 core-rules
  records carry 180 numbered rules inside their bodies: `NORMAL SHOOTING 10.04`
  and `ASSAULT SHOOTING 10.05` sit inside the 1,938-character record `3. End of
  Shooting Phase` (10.03). Splitting a body at a line that is a title followed
  by a rule id is the fix, and it needs a core-rules re-scrape and re-ingest.
- **Derived-title buckets run across cards.** 38 core-rules and 31
  rules-appendix records take their heading from the first question in a body
  that then spans several unrelated cards.

The on-disk corpus, the CSV export and the index state live in
`workspace/rules-corpus/` (untracked):

```
node src/rules-corpus.mjs --check              # is our copy behind the sources?
node src/rules-corpus.mjs --scrape             # fetch the anchored pages
node src/rules-corpus.mjs --scrape --set factions --cached   # rebuild from the cached CSV
node src/rules-corpus.mjs --ingest             # embed + upsert what changed
node src/rules-corpus.mjs --stats              # what is on disk, and in the index
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
  ids. This is the number the corpus and the retriever are graded on.
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

- The stale-index orphans: `--stats` reports more vectors than sections, and a
  query returns ids that no longer exist in the corpus, so the vector leg spends
  top-20 slots on records that are then dropped. `--ingest` cannot see them (the
  ingest state matches the corpus); a prune or a namespace rebuild is needed.
- Chunking, above: inline numbered rules and derived-title buckets.
- The core-stratagem builder labels every faction-less `Stratagems.csv` row
  "core stratagem", including the `Movement Ability` and `Shooting Ability`
  entries (NORMAL SHOOTING among them); the label should follow the CSV type.
- The same rule can appear twice in one answer when the core rules and the rules
  appendix both carry it (two `Able To Embark` records, one per source).
