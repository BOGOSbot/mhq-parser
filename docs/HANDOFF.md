# /rules — handoff (2026-10-12)

Everything below is on the `rules-page` branch, which carries the source layout
(sources in `src/`, docs in `docs/`, working data in `workspace/`). The server is
running detached on 127.0.0.1:8787 (started with `node src/server.mjs`, logs under
`workspace/logs/`). `GET /health` reports both inference routes.

## 1. What changed this session

**The page** (`rules.html`). The progress bar is the record now: it stays after the
answer and each segment carries its stage's time (`retrieve 1.6s | judge 2.9s |
answer 47.4s`), the widening gets its own segment, and the times are deltas of the
server's own `elapsedMs` on each event. The terminal `done in 39.6s - 16 findings`
line is gone (so is its i18n), the **Pipeline card is removed** (component, keys,
CSS, and the `steps` render), and the judge's `why` is rendered through the same
emphasis pass as the answer, so markdown from a small model no longer prints as
literal asterisks. A new question resets the bar; a finished one keeps it.

**Two inference routes** (`rules.mjs`). The writer writes the cited answer the
reader sees (`RULES_MODEL`, `RULES_MODEL_ENDPOINT`, `RULES_MODEL_KEY`; SenseNova by
default — free). The fast route is everything that only decides or rewrites — the
translated question, the search terms, the judge (`RULES_FAST_*`; with none of the
three set it IS the writer's route). Any OpenAI-compatible endpoint will do; a
custom endpoint is taken at its word about auth (no key unless `RULES_*_KEY`).
`/health` and the page badge report both, and the badge shows one name when the
two routes are the same.

**Reasoning** (`RULES_FAST_REASONING`, `RULES_MODEL_REASONING`). Sent as
`reasoning_effort`, only where chosen and never to a custom endpoint unless asked.
Default: fast route `medium`, writer untouched (the model's own). SenseNova:
`none` → 0 reasoning tokens; `medium` is the setting that behaves (~375 tokens on
both samples); `high` measured no deeper than medium.

**Timeouts**: 180 s per call (`RULES_MODEL_TIMEOUT_MS`, `RULES_FAST_TIMEOUT_MS`),
was 90 s. At 90 s the thinking judge cut off 7 of 25 real questions.

**Writer budget**: `compileFindings` asks 8000 tokens, was 3500 — on a widened
60k-character prompt the model spent all 3500 on reasoning and returned an empty
answer (25.8 s wasted, then the doubling retry); at 8000 it finished in 10.8 s.

**Jev** is back on the free OpenCode Zen gateway (12 ranker calls in bursts, 0
failures, ~0.5 s each); `RULES_JEV_GATEWAY=openrouter` is the paid fallback.

**The opencode.ai chat gateway** needs an `x-opencode-session` header (400
MissingSessionID without one); `rules-corpus.mjs` sends one per process for any
`opencode.ai` endpoint. Working fast route:
`RULES_FAST_ENDPOINT=https://opencode.ai/zen/go/v1/chat/completions`,
`RULES_FAST_MODEL=glm-5.3-flash`, `RULES_FAST_KEY=OPENCODE_GO_API_KEY`.
(`opencode.ai/zen/v1` without `/go` answers 402.)

**Reliability fixes the small model exposed** (`rules-corpus.mjs`): raw control
characters inside JSON strings are escaped before parsing (unparseable verdicts
6/16 → 3/16), an unparseable verdict is asked for once more as the object alone
(→ 1/16), and a declined writer's revised verdict is emitted after the answer it
belongs to so the writer's seconds are not credited to the judge.

**Retrieval recall** (`rules-corpus.mjs`, `server.mjs`). The Asurmen embark
question retrieved the wrong rule, and the judge was asked to rule on a corpus
that held the right one. Three causes, all measured, all fixed:

- **grep matched terms as substrings**, so the term `embark` read the word
  inside `disembark`. The translation offered both, and Disembarking (1960
  characters) outranked Embarking (718). Terms now match at a word start
  (`termCount` / `termPresent`): `embark` reaches `Embarking` and `embarked`,
  `move` still reaches `movement`, and `disembark` is a different word. The
  translation's terms are also deduped case-insensitively - `ASURMEN` and
  `Asurmen` were both being scored.
- **the reranker's net was cut at 50** and the Embarking rule sat at merged
  rank 54: Jev reorders what it is given, and it had never been given it. The
  net is now `max(jevMax, K + 70)` (80 at the default depth), and
  `jevRank`'s 40k-character state is spent evenly over the candidates
  (`RULES_JEV_STATE_CHARS`) instead of a flat 700 characters sliced at 40k, so
  a wider net no longer asks Jev about passages it cannot see.
- **the reranker is a preference, not a guarantee**: four measured calls put
  Embarking 10th-12th out of the same 80. `entityAnchors` now matches the
  words the question and its translation name against heading first words
  (word-start, hyphen parts kept), ranked question-words before the
  translation's extra terms, one-word headings before multi-word ones, then
  rarity - so `embark` anchors `Embarking` and not `NORMAL MOVE` (`normal` is
  in 57 sections, `embark` in 62). Anchored records reach the judge whatever
  Jev thinks.

**Depth and widening**: the first pass is 10 findings a side (was 5), and a
miss adds 20 more a round, cumulatively, until the judge answers -
`RULES_MAX_PASSES` (default 3) is the ceiling and the last pass is final. On
the question, end to end: Embarking is finding [9], Asurmen's Tactical Acumen
[18], Fire and Fade [14]; the judge answers high on the first pass. Unit tests
were updated with it (50 + 86 now).

**Chunking and the two settings** (`rules-corpus.mjs`, `rules.html`, `server.mjs`).
`splitInlineRules` cuts a body at a line that is a title and a rule id and
nothing else, so 10.04/10.05 and the rest become records the parent owns; the
parent keeps its id, its anchor and the lead-in text. core-rules 285 -> 339
records, rules-appendix 149 -> 168, the longest record 1,938 -> 2,000
characters. The measured result is in `docs/rules-page.md`: the exact-id
benchmark moves from hit@5 69% to 62.1% (the parents are now short and the
content sits in their children), but the rule is *reachable* 93.1% of the time
at hit@10 against 86.2%, 96.6% against 89.7% at hit@20, MRR 0.540 against
0.472 - and two questions that used to miss entirely now find their rule at #3
and #7 under the parent.

The page now offers **fast** (judge reasons not at all, 5 findings a side, two
passes, Jev net 60) and **deep** (judge reasons `medium`, 10 a side, three
passes, net 80). `ASK_MODES` is the only place they are written down; an
unknown `mode` is deep. Measured on the Asurmen question back to back: fast
judged in ~2 s, deep in ~49 s, both `high` on the first pass (fast: 15
findings, deep: 23).

## 2. Benchmark assets (new, all in the tree)

- `tests/fixtures/reddit-questions.json` — 68 real questions (2 weekly threads).
- `tests/fixtures/reddit-threads/*.json` — both threads harvested whole (id,
  parent, score, body), the auditable source of the answers.
- `tests/fixtures/reddit-answers.json` — the answer key: each question with every
  reply written under it, best-voted first. Rebuilt by
  `node tests/build-reddit-answers.mjs`.
- `tests/fixtures/rules-questions-fr.json` (v2) — the six French questions with
  **both** the verbatim post (`asked` / `answer`) and the benchmark phrasing
  (`q` / `expected`).
- `tests/eval-accuracy.mjs` — runs each question through the page's own path and
  has an independent model (DeepSeek, `RULES_GRADER_*`) grade the answer against
  the key: `correct` / `partial` (half credit) / `wrong`. A question the thread
  never settled makes a refusal correct. Options: `--bank reddit|fr`, `--limit`,
  `--ids`, `--out`, `--all`. Appends per question; a question already in the
  output file is not redone, so a run resumes.
- `tests/eval-reddit.mjs` now also reports judge latency (mean/median).

Run artifacts kept under `workspace/eval/`: `eval-accuracy-*.log` and
`eval-accuracy-*.ndjson` (one pair per arm below). The UI screenshots
(`rules-progress-times.png`, `rules-reasoning-off.png`) sit in the repository root
and are gitignored, like every `*.png`.

## 3. What was measured (writer = SenseNova unless stated)

Same 17 questions (the ones all three fast-route arms graded):

| fast route / judge | accuracy | judge mean / median | end-to-end mean | lost to timeout |
|---|---|---|---|---|
| SenseNova, thinking on | **79.4 %** | 33.0 s / 20.6 s | 55.5 s | 7 / 25 at 90 s |
| SenseNova, reasoning off | 61.8 % | 7.1 s / 6.0 s | 36.1 s | 0 / 25 |
| glm-5.3-flash (opencode-go) | 73.5 % | 18.0 s / 10.7 s | 42.8 s | 5 / 25 at 90 s |

Writer role: SenseNova 79.4 % (writer 22.6 s mean); ministral-8b as writer 22.3 %
over 65 questions (refused 54/65) and **0 %** on the six French questions;
ministral-14b declined 4/6 in a six-case spot check; mistral-small-latest was 429.

All-in-one: ministral-8b 22.3 % reddit / 0 % French; SenseNova 79.4 % / 50 % French.

The seven questions the 90 s timeout had cut, re-run with thinking + 180 s: 6
processed → 4 wrong, 2 still over 180 s; judge mean 99 s, question mean 208 s.

## 4. Open items for the next session

1. **The judge's prompt size is the real lever.** A widened search hands the judge
   ~30 passages / ~60k characters; that is where the minutes and the lost
   questions live (above). Try capping `JUDGE_TOTAL_CHARS` / the per-passage cap /
   the widened finding count, and measure before shipping — this should cut
   latency, timeouts and cost together. Note the widening now runs up to three
   passes (`RULES_MAX_PASSES`), so a hard question can put three large judge
   prompts on the clock; the ceiling was left at 3 rather than unbounded exactly
   for this.
2. **Writer tail**: mean 22.6 s but individual answers run past 100 s. Feeding the
   writer only the judge's cited passages first helped a little in a six-case
   probe (declines 6/6 → 4/6) and is not a fix on its own.
3. **French bank**: SenseNova 3/6 — read the three wrong ones
   (`eval-accuracy-fr-sensenova.ndjson`) before touching retrieval or prompts.
4. **Unmeasured**: writer with reasoning off; 14b / GLM as writer; `high` vs
   `medium` for the judge on a full set.
5. **Housekeeping**: everything is uncommitted and the run artifacts are untracked
   (see §2). `_jevprobe.tmp.mjs` predates this session. Optional one-liner: the
   `findingsTitle` i18n key exists but the findings card title is hardcoded
   English (`Findings - N`), so the FR page shows one English label.
6. ~~The vector index is stale.~~ **Done.** DELETE /delete/{ns} is the endpoint
   (`POST /delete-data/{ns}` is answered 404, and ingest had never needed a
   delete until the split created one); `--prune` enumerates a namespace with
   GET /range/{ns} and deletes what the corpus no longer has. 161 strays went,
   leaving the rules namespace at exactly its 636 records.
7. ~~Chunking: inline numbered rules never become records.~~ **Done.**
   `splitInlineRules` gives them their own records under the parent (core-rules
   285 -> 339, rules-appendix 149 -> 168), the parent keeps its id and anchor,
   and the core-stratagem label follows the CSV Type (22 ability rows stop
   claiming to be stratagems). What is left of the chunking problem is the
   derived-title buckets: the splitter empties the rules out of them, but the
   container's own heading is still whatever question its body started with.

## 5. Re-measuring

```
node tests/eval-accuracy.mjs --limit 25 --out run.ndjson          # current defaults
node tests/eval-accuracy.mjs --bank fr --out fr.ndjson            # six French questions
node tests/eval-accuracy.mjs --ids <thread>/<comment>,... --out hard.ndjson
node tests/eval-reddit.mjs --limit 16                             # judge coverage + latency
node tests/ask.mjs "can a unit shoot after it Fell Back?"         # one question end to end
node tests/ask-fr.mjs --id asurmen-embark-after-shooting
node tests/eval-retrieval.mjs --retriever dual --per-side 10 --net 60  # the page's path
node tests/test-rules.mjs && node tests/test-judge.mjs            # 50 + 86
```

`workspace/eval/retrieval-dual-before.txt` and `retrieval-dual-after.txt` are
the two runs the chunking was measured against.

Compare arms only on questions **all** arms graded — different arms lose different
questions to the timeout, and the raw percentages are not comparable otherwise.

## 6. Gotchas learned the hard way

- Reddit refuses this machine and the cloud browsers tried (403); the thread dumps
  came through a redlib mirror driven over CDP in a TinyFish cloud browser, which
  solved the mirror's Anubis challenge as a real browser.
- DSH session logs are concatenated zstd frames: `zstdDecompressSync` returns only
  the first frame (199 bytes) — split the buffer on `28 B5 2F FD` and decompress
  each frame. User turns are `type: "user/message"`, text in `data.content`.
- Upstash Box is a CPU container (2–8 vCPU, 4–16 GB, no GPU) and its "LLM budget"
  meters an agent harness you bring your own key to; it cannot host the judge.
- The TinyFish browser session bills per minute — close it when the harvest is done.
