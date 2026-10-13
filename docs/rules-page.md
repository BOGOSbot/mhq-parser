# The /rules page

The page that answers a Warhammer 40,000 11th-edition rules question by citing
the rules, rather than by trusting what a model already believes. This is the
functionality document for that page; the army-list parser has its own in
`docs/developer-doc.md`. What the page keeps about a question is in
`docs/question-traces.md`.

## Routes

- `GET /rules` serves `src/rules.html` (read from disk on every request, so
  editing it needs no restart).
- `POST /rules/ask` takes `{ "question": "...", "answerLang": "fr|en",
  "english": true, "stream": true }` and answers with the findings, the judge's
  verdict and the compiled answer. `stream: true` sends one JSON object per line
  (`start`, `translation`, `terms`, `findings`, `escalate`, `judge`, `answer`,
  `done`), plus `card` for a datasheet question and `reconcile` when the two
  judges disagree - see *The unit card* and *Two judges, one answer*. The stream
  is what lets the page draw the findings before the prose exists. It also sends a
  `ping` every 15 seconds while a stage runs: the longest silence on it is the
  judge thinking - up to three minutes - and a response that sends nothing for a
  minute is one a browser or an intermediary may cut, which reaches the page as
  the browser's own *Error in input stream* after an answer that had already
  arrived. A cut stream keeps whatever arrived, leaves the bar's timings in place
  and says the connection dropped, instead of printing that string at the reader.
- `GET /health` publishes `corpus` (sections per half, build date, edition),
  the edition, and both inference routes. The page no longer prints the key
  state: which models a deployment uses is not the reader's business, and a
  missing key still says so in the status line rather than in the header.
- The footer is chrome, not prose: three icons (source code, issue tracker,
  Wahapedia) and the provenance line `Données de : 2026-10-13 (aujourd'hui) ·
  11e édition`. The build date comes from `corpus.updated`; the edition is
  localised by the page from the `wh40k11ed` slug, because the server's label is
  English and it was the one English string left on the French page.

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

**A card is a record, not a paragraph inside someone else's record.** The FAQ
and the errata are tables and divs, not headings - a `<td class="faq_Q">` cell
and a `<div class="errata_H">` title - and the extractor only cuts at headings,
so one card's question became the heading for every card after it. 96 FAQ cards
and 9 errata entries in the core rules alone sat inside a 2,000-character record
whose heading described a different rule, and the vector built from it described
none of them well. `promoteFaqCards` turns each card's own title into a heading
before the extractor runs, so the heading stack and the splitter see what a real
heading would have given them. Records holding two or more answers went from 26
to 0 in the rules half (15 of them over 700 characters), core-rules from 339 to
377 records, rules-appendix from 168 to 178, event-companion from 75 to 81, and
the spoiler toggles (`Show`, `Hide`) no longer appear as ancestors.

Moving records changes ids, so the benchmark grades two readings of every
question - see *Measuring it*.

The link-first rewrite of this corpus - a record's own text plus links to what
sits under it, the overflow rule, and the id-stability rule - is designed and dry
run in `docs/corpus-wiki.md` (phase A; nothing is built).

The on-disk corpus, the CSV export and the index state live in
`workspace/rules-corpus/` (untracked; the storage and copyright posture is in
`docs/corpus-storage.md`):

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

The index is kept in step with the corpus **by id**, not by count: `--ingest`
embeds what changed and deletes what the corpus no longer has, `--stats` prints
the two counts side by side, and `GET /health` publishes them with the difference
(`ahead` / `behind`), so drift is visible without a shell. To prove it id for id,
enumerate a namespace (`rangeIds`) and compare against the sections on disk. On
2026-10-13 that was rules 690 vectors against 690 sections and factions 6,575
against 6,575, nothing missing on either side, every rules vector from rebuild #3
at 00:56Z. What `--ingest` cannot see is a vector whose id an older build
dropped, because its own state agrees with the corpus; `--prune` is what catches
those.

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

## Two judges, one answer

The judge decides whether the findings answer the question, and its verdict is
binding. It is also the step accuracy leans on hardest: the same judge without
its reasoning scored 61.8% where thinking it scored 79.4%. So the page runs both.

- The **binding** judge is the one the setting names - fast mode asks it not to
  reason, deep lets it think (`medium`). It gates the widening and whether the
  writer writes at all.
- The **second** judge is the other setting, fired beside the writer. The prose
  never waits for it: `findings`, `judge`, `answer`, then the second `judge`. In
  fast mode the reader keeps the fast answer and the careful verdict arrives
  after it, as information rather than as a delay; in deep mode the careful
  verdict is already the binding one and the quick second opinion cannot upgrade
  anything.
- A second judge may **downgrade** the answer only when it is at least as
  reliable as the binding one, and reliability is the reasoning setting because
  the bank measured it: the same judge scores 61.8% with reasoning off and 79.4%
  with it on. So **in fast mode** (quick binding judge, careful second) a second
  `insufficient` still downgrades the answer; **in deep mode** (careful binding
  judge, quick second) it does not - the quick judge does not hold a veto over
  the careful one. The comparison is `judgeStrength`, an unknown setting ranks as
  the equal of anything so a custom endpoint is never silently ignored.
- A second judge saying `answered` never turns a refusal into prose, in either
  mode: when the binding judge refused, the answer already is the cautious one.
- Neither replaces the prose - the reader may already have read it - so a
  contradiction is an annotation on the answer (the stream's `reconcile` event):
  a **downgrade** marks the answer unconfirmed, a **weaker dissent** is shown as
  a dissent and the answer stands, because it is still information. Both name the
  verdicts and their settings. `reconcileVerdicts` and `judgeStrength` are that
  rule, on their own, and `tests/test-judge.mjs` holds it for both modes.
- Both verdicts are printed with their confidence and their reasoning setting
  (`second judge - with reasoning`).
- The verdict is a model call read by the reader, so **it follows the reader's
  language**; the passages stay exactly as the corpus writes them.
- A trace carries `judge2` and `judgeDisagreement`, so the disagreement rate is
  `count(judgeDisagreement) / count(traces with judge2)` - measurable from the
  traces without a separate benchmark run.

## Retrieval

Per half, `retrieveWide` does this:

- vector search, 20 hits, asked DENSE (`queryMode` in `queryIndex`). The
  index's own default is HYBRID - BM25 over the same text our grep leg already
  scans, fused with the dense result we want - and on the retrieval bank
  (pre-promotion corpus) dense-only put the expected section first 62.1% of the
  time, MRR 0.696, against HYBRID's 58.6% / 0.679, DBSF 51.7% and sparse-only
  41.4%. Through the page's merged path it still wins where it counts: on the
  promoted corpus, reachable hit@10 93.1% against HYBRID's 89.7%. On the vector
  leg *alone* HYBRID is now at least as good (reachable hit@1 65.5% against
  58.6%), which is worth knowing but is not the page's path. `queryMode`,
  `fusionAlgorithm` and `weightingStrategy` are all passed through when asked
  for; the merge weights and the vector head protection default to the measured
  values (1 and 1 - weighting 2 and 3, and protecting the top 3, all measured
  worse);
- a lexical pass over the whole corpus with the question's terms plus the
  translation's terms, net `max(60, K * 4)`;
- reciprocal rank fusion of the two lists (their scores are not comparable, so
  only ranks are);
- **Jev** reranks the fused net of `max(jevMax, K + 70)` candidates;
- the top K are taken, then the records the question names by title are put in
  front of them, together with each retriever's own first hit, and a rule's own
  clarifications (`Heading > Child`) travel with it.

**The reranker's measured effect on the retrieval bank is zero.** When the free
Jev gateway answered 429 on every call, the dual arm was re-measured on the
promoted corpus and reproduced the earlier Jev-on run to the digit: hit@1 27.6,
hit@5 65.5, hit@10 86.2, hit@20 93.1, MRR 0.449, and every per-kind MRR. On these
29 questions the rerank changed no aggregate. That is not the same as changing
nothing - a per-question reordering that cancels out at the aggregate would look
identical, and per-question effects are not measured here. What is measured is
the cost: a round trip per half per pass, on a free tier that throttles, for no
aggregate gain on this bank. `RULES_JEV_GATEWAY=openrouter` is the paid fallback.

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

## Showing the findings

The findings are the product, so the page draws them as findings: each carries
the leg that produced it, the rank that leg gave it, and - when the lexical leg
matched - the words it matched.

- `retrieveWide` records provenance as it searches: `vectorRank` beside the
  vector's similarity, `lexicalRank` beside the term score. Every finding comes
  back with a `leg` (`both`, `vector`, `lexical`, `anchored`, `child`) and its
  position in the half. Both return paths decorate: the ranker is optional, and
  a page whose findings have no leg cannot say where they came from.
- The display sorts each half by that rank - ranks are per-half positions, so
  interleaving two halves would invent an order - shows the top five overall
  whole above the prose, and puts the rest behind *more findings*.
- **The evidence behind a verdict is never collapsed.** The list shown whole is
  the union of the top five by rank and the passages the judge names in its
  verdict, in rank order, the cited ones badged (`cité par le juge`), with no
  duplicate when a cited passage is already in the top five. This is why: the
  ability that answered "Can dragons with fuegan arrive from reserves in melta
  range?" sat at rank 15, inside the collapse, while the writer cited it - a
  verdict's reason must not be hidden behind a summary. On a widening the
  citations are dropped until the new verdict reports its own, because a widened
  list renumbers the findings and a stale number points at the wrong passage.
- **A verdict links to its evidence.** The judge's `passages` are the same links
  the answer's `[n]` markers are: each one opens the passage popup from the
  payload. A reader who doubts a verdict can go and read what it was made from.
- A lexical finding outlines the terms it matched, in the list and in the
  passage. The vector leg's similarity is shown as a **rank score**: it orders
  passages, and it is not a confidence that one answers the question. The judge
  is that, and it is on the page above them.
- A widening re-emits `findings` with the whole wider list; the page replaces
  the list it was showing instead of stacking a second one under it, and the
  bar gives the widening its own segment.
- Citations are links with a popup. The payload already carries the whole record
  (`passage`, capped at the record's own 2,000 characters), so opening `[3]`
  costs no request: the popup shows the heading path as a breadcrumb, the body
  as paragraphs with the matched words outlined, and the Wahapedia link.
  `excerpt` stays the short line the list prints.

The labels are in both i18n tables, and `tests/test-rules-page.mjs` holds that:
the two tables must carry the same keys, every `t('...')` the script asks for
must exist in both, and a reader-facing label may not be written as a literal in
the code. Commit 864ad28 is why - one hardcoded `Findings - N` was the only
English left on an otherwise French page.

## The unit card

A datasheet question - "donne moi le profil de fuegan" - used to be answered with
prose a model wrote about the unit. The numbers are in the CSV export, so the page
renders them instead: `src/unit-card.mjs` builds the card from the export and
`rules.html` draws it. **No model writes any field on it.**

The decision is closed-set and taken before anything is searched: the question asks
for the unit's own data (profile, statline, toughness, save, weapons, wargear,
abilities, keywords, points) **and** it names a datasheet exactly. The name has to
appear as a whole phrase, so `captain` reaches the Captains, but a bare `rhino` does
not silently pick one of the five datasheets that share that name: a name several
factions share, with no faction named in the question, falls back to prose rather
than guess.

**The gate reads the question and its translation, never the search terms.** Those
terms are a retrieval artefact - what the *index* was asked for - and they are not
the question the reader asked. `wantsUnitCard(question, asked)` is the whole
contract. It used to read the terms too, and that produced the French-versus-
English asymmetry Mandal found: French "est-ce que fuegan peut arriver de reserves
a portee de melta ?" was translated with `Melta weapons` among its generated
terms, "weapons" matched the intent rule, and a **rules** question got a datasheet
with no judge and no answer behind it; the English wording of the same question
needed no translation, had no terms, and answered correctly.

**The card is additive, never instead of the search.** A question that literally
says "melta weapons" still matches the intent word, so the trigger can never be
made safe on its own: retrieval, the judge and the writer always run, and the card
renders beside their answer. It is mechanical and costs 0.0s, so the server emits
it the moment the question is translated - a preview at the top of the page while
the search works, and the prose follows underneath.

The card carries the statline (M/T/Sv/inv/W/Ld/OC and base size) from
`Datasheets_models`, the weapon profiles from `Datasheets_wargear` split ranged and
melee, the abilities from `Datasheets_abilities` - the Core and Faction ones
resolved through `Abilities.csv` - the keywords from `Datasheets_keywords` with the
faction keywords kept apart, the composition, the options, the points from
`Datasheets_models_cost`, and the link to the datasheet page. A Faction ability can
carry a table and six sub-rules (Battle Focus does), so ability text is cut at
`ABILITY_CHARS` (600) and the card says so; the full text is one click away. Every
value is cleaned of the export's HTML, and none is written by a model.

**An ability that is a rule elsewhere is a link, not a reprint.** A Core ability
(LEADER) and a Faction ability (Battle Focus) are rules the corpus holds in their
own right, so the card shows the title only, linked to that record, and opens it
in the same passage popup the findings use. The record is found mechanically: the
ability's own card cites a rule id (LEADER carries 24.22 in the export's
`h_number`), the heading's last segment must start with the ability's name
(word-start, so LEADER does not reach Leadership Rolls), and a heading carrying
the cited id wins over one that does not. A Datasheet ability (Burning Lance,
Unquenchable Resolve) is the unit's own and keeps its text, and **an ability whose
record cannot be found keeps its text too** - Battle Focus has no record in the
faction half today, and a dead link is worse than a long card. The card only links
when it is given the corpora, so a caller without them degrades to text.

When the unit cannot be resolved to a datasheet id, `unitCard()` returns null and
nothing is shown: the fallback is silent, and a half card is never shown.
`RULES_UNIT_CARD=0` turns the path off for a deployment. A trace carries
`card: { id, name }` alongside the findings, the judge and the answer it shared
the question with. The stream sends one `card` event before retrieval, and the
usual `findings`/`judge`/`answer` follow it; the bar is the pipeline's, unchanged.

The layout is one column at every width - the statline wraps into chips and the
weapons table is fixed-layout so its seven columns fit a 360px phone - because the
page is mostly read on a phone.

## The two settings

Each setting names its own judge, and each names the other's as the second
opinion (see *Two judges, one answer*). The page offers two, and the server fixes
four things for each: the depth of the first pass, how many times a miss deepens
it, how wide the reranker's net is, and whether the judge reasons.

| setting | first pass | widening | Jev net | judge |
|---|---|---|---|---|
| fast | 5 a side | 2 passes | 60 | no reasoning |
| deep | 10 a side | 3 passes | 80 | reasons (`medium`) |

Each setting also names the other's judge as its second opinion (`second` in
`ASK_MODES`: fast pairs its quick judge with the thinking one, deep the reverse).

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
`.dsh/.credentials.yaml`; `DSH_CREDENTIALS` points at another file.

The judge keeps its reasoning (`RULES_FAST_REASONING`, `medium` by default):
without it the same judge scored 61.8% where thinking it scored 79.4%. The
writer does not (`MODEL_REASONING` is `none`): on the 25-question bank the
writer with reasoning off scored 60.0% against 60.4% with it, both inside the
bank's noise floor, with no empty or timed-out response against one, and a mean
17.1s against 102.2s - the thinking bought six times the wall clock and the
failures, not the answer. `RULES_MODEL_REASONING=medium` restores it. A call
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
  Every expectation is checked against the corpus before grading: an id the
  corpus does not name is reported, and resolved through the corpus's own id
  function when the same heading still exists, instead of being scored as a
  silent miss.
- `node tests/eval-retrieval.mjs --retriever dual --per-side 10 --net 60` - the
  page's own path, and the arm every chunking decision is measured on. It grades
  the same 29 questions twice: **exact id** (the fixture as written) and **rule
  reachable** (the expected record, or a record the splitter put under it,
  `<id>->-<TITLE>`). Both are printed and neither stands in for the other,
  because a rule the chunker moved is a real hit for the reader and a real miss
  for the fixture.

  | corpus | exact hit@1 / 5 / 10 / 20 | exact MRR | reachable hit@1 / 5 / 10 / 20 | reachable MRR |
  |---|---|---|---|---|
  | before the card promotion (DENSE) | 44.8 / 79.3 / 89.7 / 89.7 | 0.586 | not measured | - |
  | after the card promotion (DENSE) | 27.6 / 65.5 / 86.2 / 93.1 | 0.449 | 41.4 / 69 / 93.1 / 100 | 0.550 |

  The promotion moves content into records of its own, so the exact-id head
  drops - a finer corpus puts the exact expected id first less often - while
  reachable recall at the judge's cutoff is unchanged or better (hit@10 93.1%,
  hit@20 100% against 96.6%). It was **kept for the correctness fix and the
  judge-cutoff recall, with the head cost recorded**. The before arm's reachable
  reading was never measured, so the two rows are not comparable on that column.
  Two questions that miss on the exact id ("what does the Advance move do", "what
  happens when a transport blows up") are reachable inside the top 20.
- **The top-K sweep was re-taken with the Jev rerank on (task-20).** The rows above and
  the "per-side 10 is the sweet spot" reading were measured while Jev was
  rate-limited, i.e. without the rerank - a path the page does not run. Re-run with
  the free gateway answering (66 rerank calls per run; a 429 throws in the harness,
  so no run fell back silently), same command:

  | per-side | exact hit@1 / 5 / 10 / 20 | exact MRR | reachable hit@1 / 5 / 10 / 20 | reachable MRR |
  |---|---|---|---|---|
  | 5, no rerank (recorded) | 24.1 / 65.5 / 72.4 / 72.4 | 0.403 | 41.4 / 69 / 75.9 / 75.9 | 0.515 |
  | 5, rerank on | **31.0 / 72.4 / 79.3 / 79.3** | **0.494** | **48.3 / 75.9 / 82.8 / 82.8** | **0.598** |
  | 10, no rerank (recorded) | 27.6 / 65.5 / 86.2 / 93.1 | 0.449 | 41.4 / 69 / 93.1 / 100 | 0.550 |
  | 10, rerank on | 27.6 / 65.5 / 86.2 / 93.1 | 0.449 | 41.4 / 69 / 93.1 / 100 | 0.550 |
  | 15, rerank on | 27.6 / 62.1 / 82.8 / 93.1 | 0.433 | 37.9 / 72.4 / 93.1 / 100 | 0.525 |
  | 20, rerank on | 27.6 / 62.1 / 82.8 / 93.1 | 0.445 | 37.9 / 72.4 / 93.1 / 96.6 | 0.534 |

  The rerank moves the small net and nothing else: per-side 5 gains 6.9 points at
  hit@1 and 0.091 exact MRR (beyond the 2-4 point floor), while per-side 10, 15 and
  20 reproduce the recorded no-rerank rows exactly, MRR included. "Per-side 10 is
  the sweet spot" is therefore depth-true and head-false: 10 still wins hit@10/20
  (86.2 / 93.1, reachable hit@20 100%) and 5 now wins hit@1 and MRR. **No default is
  moved** - the two configs win different columns and the head delta sits at the
  floor's edge. Three identical rows remain an open question (the rerank may simply
  not reorder expected records once the net is 20+ candidates, or parts of the
  recorded sweep were taken with it on); settling it needs a rerank-off control that
  skips instead of throwing, or the paid gateway. Artifacts:
  `workspace/eval/retrieval-topk-sweep-rerank-clean.txt` (raw, mixed-encoding:
  `retrieval-topk-sweep-rerank.txt`). The **gate arm was not re-measured**: the free
  gateway 429ed after 264 answered calls plus the probes (a long-window budget, not
  a per-minute one), and the notes price the remaining set at about **$0.40** on the
  paid route, which needs Mandal's yes per use. The recorded gate rows
  (`retrieval-gate.txt`, `retrieval-gate-lexical.txt`) are no-rerank and still
  stand as such.
- **Fix the writer before comparing two arms, not after.** Two arms whose writer
  fails at different rates are not comparable, and subtracting the failed rows does
  not repair it: dropping rows changes *which* questions are being compared, and the
  writer's failure rate is itself context-sensitive - the same bank failed on 4 of
  25 questions in one arm and 1 of 25 in another. The A2/B3 pair read as "curation
  is accuracy-neutral and twice as fast" with four failures against one; with the
  writer's reasoning off in both arms, zero failures each, the same pair read
  **-10.0 points**. Repair the failure mode first, then measure the variable. This
  cost the curation verdict two revisions.
- `node tests/eval-retrieval.mjs --retriever vector --namespace auto` is an
  **oracle arm**: `auto` picks the half from the question's expected section,
  which the page cannot do - it searches both halves and merges. Its numbers
  (58.6% exact hit@1 against the dual arm's 27.6%) bound what the vector leg
  could contribute; they are not a fair fight against the page's path. Use
  `--namespace rules|factions` to pin one half.
  Re-taken 2026-10-13 (no Jev on this leg, so it is free): **DENSE** (`--query-mode`
  unset, the page's default) 58.6 / 72.4 / 89.7 / 93.1 exact, MRR 0.666, and
  58.6 / 79.3 / 96.6 / 96.6 reachable, MRR 0.682; **HYBRID** (`--query-mode HYBRID`)
  58.6 / 79.3 / 82.8 / 93.1 exact, MRR 0.668, and **65.5 / 93.1** / 93.1 / 96.6
  reachable, MRR **0.731**. HYBRID wins the reader-facing head (reachable hit@1 +6.9,
  hit@5 +13.8, MRR +0.049) and loses exact hit@10 (-6.9). The page keeps DENSE
  because this is the **oracle arm** and not the page's path, and because the bank
  has not grown yet; a flip needs the fair-fight arm and a bigger bank.
  Artifact: `workspace/eval/retrieval-vector-dense-hybrid.txt`.
- `node tests/eval-retrieval.mjs --retriever gate --gate lexical` - the same path
  with one half chosen first. The gate is closed-set - one short item in, one
  label out: `--gate jev` is the Jev choice, `--gate lexical` scores the
  question's terms against each half's headings and takes the best single heading,
  which costs no call at all. It abstains, searching both, rather than guessing.
  On the promoted corpus the lexical gate routes 25/29 questions to the half their
  expectation lives in, abstains on 4 and is never wrong; it hands the reader 13.4
  passages instead of 23 and scores the same hit@k and MRR. `candidates` in the
  output is the cost side of every arm.
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
- `node tests/test-unit-card.mjs` - the datasheet resolution, every field of the
  Fuegan card against the CSV, the silent fallbacks (a rules question, an unknown
  unit, a name several factions share) and the trace's card shape.
- `node tests/test-findings.mjs` - the retriever leg, rank and matched words
  surviving fusion and anchoring, on both the ranked and the unranked return.
- `node tests/test-rules-page.mjs` - the page's i18n discipline: both tables carry
  the same keys, every `t('...')` key exists, and no label is hardcoded.

## Known limits

- **The accuracy bank cannot resolve 2 to 4 points.** Two arms run with the writer
  fixed and the same retrieval configuration still differ: on the 25-question bank,
  21 of 25 answers differ in text and 7 of 25 differ in grade between two runs of
  the same setup, while only 5 questions took a different path. Retrieval, writing
  and grading are all stochastic, so the bank resolves a 17.6-point gap and a
  10-point loss and it cannot resolve 2 to 4 points. Any future reading at that
  scale needs a bigger bank or repeated runs per arm - the question traces are how
  the bank grows.
- The server reads the corpus once per process - `corpora()` and
  `corpusState()` cache it for the life of the server - while `--scrape` and
  `--ingest` rewrite it under a running one. A rebuild therefore needs a
  restart, or the page keeps serving the previous corpus against the new index:
  on 2026-10-13 the server still held 636 rules records after the corpus had
  moved to 690. The index itself was in step throughout.
- The same rule can appear twice in one answer when the core rules and the rules
  appendix both carry it (two `Able To Embark` records, one per source), and a
  split rule can appear both under its real parent and under a bucket that also
  contained it.
- Both namespaces were in step with the corpus when this was measured (rules
  690/690, factions 6,575/6,575, no strays on either side), but a rebuild that
  drops sections still needs `--prune` afterwards: `--ingest` deletes what its
  own state knows about, and a vector an older build dropped is invisible to it.
