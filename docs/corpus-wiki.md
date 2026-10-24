# The corpus as a wiki (phase A)

*The original design of the corpus as a wiki, with the phase A and B measurements behind it.*
*Design and dry run for a link-first corpus. Nothing here is built: no corpus
write, no index write, no model call. `node src/wiki-plan.mjs` reproduces every
number below from the corpus on disk.*

The corpus today is a flat bag of chunks. A rule's clarifications are separate
records that do not know their parent; a datasheet's abilities are one record and
its statline another; an army rule like Battle Focus has no record anywhere. The
page finds passages; it cannot *navigate* them, and neither can an agent reading
the traces.

The rewrite gives a record its own text plus **links to what sits under it**, so a
parent's vector carries the **names** of its children. A human can walk the tree;
an agent gets a graph; retrieval may get better, which is a hypothesis and not a
premise (see *The retrieval claim*).

## The record schema

```
{
  id, set, source, heading, ruleId, anchor, hasAnchor, url,   // as today
  text, chars, hash,                                          // own body only
  parent,        // id of the record this one sits under, '' for a root
  children,      // [ids], in the order a reader should walk them
  links: [ { to, title, kind } ],
  kind,          // rule | stratagem | card | faction-rule | index | ...
  idFrom,        // which key the id came from: source-key | csv-row-id | csv-ability-id | faction-id
  part, parts    // which chunk of a record too large to be one
}
```

- **A link is `{ to, title, kind }`.** `to` is the target record's id and must
  resolve **inside the same plan**; `title` is the target's own heading (its last
  crumb), which is what goes into the linking record's text; `kind` is
  `section | card | rule | faction | index`, used to group and to label.
- **Resolution is a set membership test, not a lookup at render time.** The plan
  builds the complete id set first and resolves every link against it, so a link
  is either live or absent. A link that does not resolve is **dropped and
  counted**, never emitted - a dead link is worse than no link, the same rule the
  unit card follows for an ability it cannot resolve.
- **What a target must be for the page to render it**: a record with an id, a
  heading and a text, in one of the two halves. A link may point across halves
  (a faction rule has no `url`; its page is the index). The page needs no new
  fetch: the links travel in the finding/card payload, as the passage popup
  already does.
- **A link's title is in the text, and the text is what the vector sees.** That is
  the whole retrieval bet: `- section: NORMAL SHOOTING` inside the Shooting
  record's own text means a query naming *NORMAL SHOOTING* can land on `Shooting`.
  Past `LINK_BLOCK_MAX` (40) names on one record the block stops being a signal
  and starts drowning the body; the rest stay on the record as links and out of
  the vector text, counted as `linksOmitted`.

## The overflow rule

Applied to every record, recursively:

1. **Try the whole section first.** A record whose body fits the budget (2,000
   characters, the chunker's own ceiling) keeps it.
2. **If it does not fit, export its subsections as their own chunks and link to
   them from the parent**, so the parent keeps the names and the reader keeps a
   way in. For the rules half the subsections already are their own records -
   the plan adds the link block; where the body *plus* its link block no longer
   fits, the links stay with the lead-in and the rest of the body becomes
   `<id>~2`, `<id>~3`.
3. **A child still too large is emitted as ANOTHER chunk, never cut between
   headings.** The splitter cuts at paragraph boundaries, then sentences, then a
   space - the discipline the corpus already uses.
4. **A fragment under `MIN_PART` (80 characters) is not a record.** The chunker
   can leave a 3-character tail; it is joined back onto the part before it, even
   though that part then runs a few characters over the budget. That is why the
   "after" table has a handful of records at 2,032-2,061 characters: the price of
   not putting debris in the index, and 3% over a soft ceiling.

An index uses the same rule: a faction's index is one page per
`floor((budget - 200) / 46) ≈ 39` entries, and the head page links to the later
pages. 185 index pages cover the 24 factions.

## One record in the reader's surfaces (task-29)

**The split stays; the display merges.** The chunker cuts a section whose body
passes `MAX_CHARS` (2,000, `src/rules-corpus.mjs:177`) at paragraph, then sentence,
then word boundaries, and labels the parts `heading (i/m)` with ids `<base>~i`. The
reader must not see the same rule twice: the ledger, the record view and the tree
merge the parts of one group back into one record.

Measured on the delivered corpus (2026-10-19): 1,739
labelled chunk records over 864 id-groups (756 distinct base headings - **108 groups
share a base heading with another group, so the merge keys on the id, never the
text alone**); 1,356 delivered over 667 groups, 24.5% of the 6,248 records.
**Every** labelled chunk carries `part 1 / parts 1` (0 exceptions), so the metadata
cannot find the siblings; the heading's own `(i/m)` and the `~i` id can.

**Is the split still needed? Yes, for the judge, not for the embedder.** BGE-M3's
published window is 8,192 tokens; the longest delivered record is 4,093 characters
(755 words, ~5.8 characters per word), so even at 2 tokens per word it is ~1,510
tokens - 18% of the window. The budget the split actually serves is the judge's
passage window, `JUDGE_PASSAGE_CHARS = 2,400` (`src/rules-corpus.mjs:2555`), which
`MAX_CHARS` sits deliberately under: 444 of the 667 delivered groups exceed 2,400
characters reassembled (58 exceed 4,000; the largest is 6,327). Merging at index
time would hand the judge a passage over its window and would gain nothing
measurable - the split loses no text, repeats no part text and overlaps nothing
(the only repetition is the heading echo, 45 characters per member, 1.2% of the
corpus). So: the corpus and the index keep the parts, and `mergeChunkParts`
(`src/wiki-plan.mjs`) plus `mergeChunks` (`src/wiki-surface.js`) reassemble them
for display only, at record-render and row-render time.

## The id-stability rule

**This is the acceptance criterion that matters, and the FAQ promotion is why.**

The rule the corpus follows, stated so a re-chunk can be judged against it:

| id shape | derived from | survives a re-chunk? |
|---|---|---|
| `unitrules#000000574`, `datasheet#…`, `stratagem#…`, `detachment#…`, `enhancement#…`, `core-stratagem#…` | a CSV row id | **yes** - the row is the key |
| `faction-rule#000009894` (new) | a CSV ability row id | **yes** |
| `faction-index#faction-ae`, `…#faction-ae::2` (new) | a faction id | **yes** |
| `core-rules#1.-Hit-Roll`, `core-rules#Embarking` | the page's heading (via `anchorFor`) | **only as long as the heading is unchanged** |
| `core-rules#Embarking->-Do-a-unit's-abilities…` | parent anchor + the child's heading text | **only as long as both headings are unchanged** |
| `…~2`, `…~3` | the position of a chunk inside its record | **no** - it moves when the record's length changes |
| an id derived from a *card title* (`#3`, `#4` suffixes on repeated FAQ headings) | the order two identical titles appear | **no** - it moves when either card is added, removed or reordered |

The FAQ promotion moved headings, so every id in rows 4-6 moved at once, and the
bank's expectations - which name ids - broke. **This plan renames nothing**: the
dry run reports 7,265 existing ids in, 7,265 kept, **0 moved**, 291 added. The
rewrite is additive on the current corpus; it does not re-cut anything that
already exists, and its new records are keyed by CSV row (rows 1-3), which is the
stable end of the table.

When a future phase *does* move a heading, the expectation path is, in order:

1. **exact id** - unchanged, and the common case;
2. **`<id>->-<TITLE>`** - the parent's clarification, which
   `tests/eval-retrieval.mjs` already resolves and already reports as
   *reachable* rather than as an exact hit;
3. **an alias table**, `<old id> -> <new id>`, written by the rebuild that
   renames (phase B's job) and applied by the harness exactly like (2);
4. **reported as unknown, never scored as a silent miss** - the harness already
   refuses to score an expectation the corpus does not name.

An alias is a one-line entry, but it must be written by the code that moves the
id, in the same commit, or the bank lies.

## The dry run

`node src/wiki-plan.mjs` over the corpus on disk (2026-10-13: rules 690,
factions 6,575). Read only.

| | before | after |
|---|---|---|
| rules records | 690 | 727 |
| factions records | 6,575 | 6,829 |
| rules size: min / median / p90 / max | 77 / 551 / 1,914 / 2,124 | 80 / 537 / 1,820 / 2,032 |
| factions size: min / median / p90 / max | 32 / 697 / 1,911 / 2,000 | 55 / 730 / 1,934 / 2,061 |
| records over 2,000 characters | 35 (rules) + 0 | 5 + 5 |
| **largest record** | **2,124** (rules) | **2,061** (`faction-index#faction-cd::2`) |

- **Records created: 291** - 37 rule chunks the budget forced out of their
  parent, 63 faction-rule records (59 rules + 4 chunks), 191 index pages.
- **Links created: 13,834**, of which **13,292 are inside a record's text**
  (i.e. a vector will carry them) and **0 dropped** - every target resolves.
- **Battle Focus** - a faction rule with a table and six sub-rules that has no
  record anywhere today - becomes `faction-rule#000009894` (758 characters),
  linked from `faction-index#faction-ae`. 58 other faction rules come with it.
- The corpus is *smaller at the top*: the 35 rules records over the budget today
  (max 2,124) become 5, and none is above 2,032.

## The retrieval claim

**It is a hypothesis, and this document does not assert it.** Two claims, each
testable on the free bank with no model spend and no write to the live index:

1. *A query naming a subsection reaches the parent.* The parent's vector now
   carries its children's names. If a question names "NORMAL SHOOTING", the
   parent "3. End of Shooting Phase" should rank for it in a way it cannot today.
2. *A rule with no record cannot be retrieved at all.* Battle Focus is the
   existence proof: no id, no text, no vector. The rewrite creates one.

How to test, in order:

- **Build the planned corpus into the LOCAL vector backend** (`RULES_VECTOR_BACKEND=local`,
  bge-m3 through Ollama): free, on this machine, and it touches no Upstash
  namespace. Measure the planned corpus there first; only a clear win justifies
  a rebuild of the live index.
- **`node tests/eval-retrieval.mjs --retriever dual --per-side 10 --net 60`** on
  the 29-question bank, before and after, reporting exact and reachable hit@1/5/10/20
  and MRR. Compare against the recorded numbers (`docs/rules-page.md`): exact
  27.6 / 65.5 / 86.2 / 93.1, MRR 0.449; reachable 41.4 / 69 / 93.1 / 100, MRR 0.550.
- **The bank cannot resolve 2-4 points** (its own recorded noise floor), so the
  claim is only worth acting on if hit@10/reachable or MRR moves beyond that, or
  if a *specific* question changes state (the Battle Focus question goes from
  impossible to retrieved; a subsection-naming question from miss to hit).
- **Two targeted questions are the real test**, not the aggregate: one naming a
  subsection whose parent now carries its name, one naming Battle Focus. If the
  parent's link block does not move the first, the mechanism is wrong and the
  aggregate will not save it.
- Cost: free Jev calls only, local embeddings, no writer/judge calls.


## Phase B: measured (2026-10-13)

Built by `src/wiki-build.mjs` into `workspace/rules-corpus-wiki/` - a directory of
its own, never the live corpus, and the local backend keeps its store inside it,
so nothing here can reach Upstash. 7,556 records across the five source files,
13,834 links, no remote call, no model call.

**The gate, like for like and free.** `tests/eval-retrieval.mjs --retriever grep`
on the 29 graded questions, live corpus against the planned one (the grep arm, not
the recorded dual path - those numbers are not comparable to it):

| grep arm, 29 questions | live | wiki |
|---|---|---|
| hit@1 | 27.6% | **31.0%** |
| hit@5 | 44.8% | **51.7%** |
| hit@10 | 62.1% | **65.5%** |
| hit@20 | 65.5% | **69.0%** |
| MRR | 0.358 | **0.398** |
| reachable hit@20 / MRR | 79.3% / 0.487 | 79.3% / 0.487 |

The movement is at the edge of the 2-4 point noise floor at hit@1/10/20 (+3.4) and
beyond it at hit@5 (+6.9) and MRR (+0.040). The bucket that moves most is the one
the mechanism predicts: **literal** questions, 50% -> 62.5% at hit@1 and
75% -> 87.5% at hit@5, MRR 0.609 -> 0.719. Reachable is unchanged, which is what a
corpus that adds records rather than moving them should look like.

**The two targeted questions, which decide it:**

- **Battle Focus: impossible -> rank 1.** No record anywhere in the live corpus;
  `faction-rule#000009894` comes back first for a Battle Focus question on the
  planned one. A rule with no record cannot be retrieved at all, and 58 other
  faction rules are in the same hole.
- **A subsection naming its parent: NOT demonstrated.** The parent record exists
  and does carry its children's names (`3. End of Shooting Phase` contains
  `- section: NORMAL SHOOTING`, `- ASSAULT SHOOTING`, ...), but a query naming
  NORMAL SHOOTING still returns the child at #2 in both corpora and never the
  parent. The link block is built; the retrieval benefit it was bet on is
  unproven for this pair, where the child is a strong hit in its own right.

**The vector arm ran, hosted (2026-10-13).** The local route was priced out
first: bge-m3 on this box runs at 98% CPU / 2% GPU and embeds a record in 6-12s
(measured: 25.65s for 4 live rules records, 169.7s and 188.0s for two 16-record
batches), so the two rules halves alone are 2.5-4.5 hours. Both sides were then
embedded by the **same hosted BGE_M3** on the existing Upstash index, the wiki
records in a scratch namespace, queried DENSE on the HYBRID index. The live
namespaces were never written to and the scratch namespace was deleted after; a
drift control preceded the arm (20 live rules records re-upserted into it rank #1
for their own text in both, 20/20, and their relative order is identical across
all 33 bank questions - 0 inversions in 173 comparable pairs - so the two sides
are one model revision).

| rules half, DENSE, topK 20 | exact hit@1 / 5 / 10 / 20 | exact MRR | reachable hit@1 / 5 / 10 / 20 | reachable MRR |
|---|---|---|---|---|
| live, 690 records | 58.6 / 72.4 / 89.7 / 93.1 | 0.666 | 58.6 / 79.3 / 96.6 / 96.6 | 0.682 |
| wiki, 727 records | **62.1** / 72.4 / **82.8** / 93.1 | **0.689** | **62.1** / 75.9 / **89.7** / 96.6 | **0.703** |

The head improves at the edge of the noise floor (hit@1 +3.4 - "How are command
points generated for an event?" #4 -> #1 - and MRR +0.023), and **the cut is
hurt** beyond it: hit@10 loses 6.9 on both readings, two questions falling from
#10 to #11 ("what happens to my models when a transport blows up") and #18 ("how
close do my models have to stay to each other"). hit@20 is unchanged. Paired per
question: 22 same rank, 1 better, 4 worse. The vector leg contributes 20
candidates in the page's path, so both questions still enter the fusion - the
6.9 is a loss at the bank's hit@10, not proof the page drops them; it is still
the wrong direction on the metric the corpus is graded on. The link-block parent
test is negative on the dense leg too ("What does NORMAL SHOOTING allow a unit to
do?" returns the same top five in both halves and never the parent), and one
wiki-added overflow chunk (`core-rules#Duplicated-Abilities#2~2`) takes #2 on a
close-quarters question, pushing the rule's own child to #3.

**The shape arms: the rules half can be neutral, and the block is not the cost.**
Three more hosted arms (all free, no Jev; every scratch namespace waited on until
`pendingVectorCount` was 0 before a single query - a query against pending
vectors reads them as misses and looks like drift - and every one deleted after,
/info back to 7,266):

- **The page's own path** (`--retriever dual --per-side 10 --net 60 --rerank
  off`, the rules half from the wiki corpus and a scratch namespace): hit@10
  86.2 and hit@20 93.1 unchanged from live, reachable hit@5 69 -> 75.9, hit@1
  27.6 -> 34.5, MRR 0.449 -> 0.496. Paired: 19 same rank, 5 better, 3 worse,
  none lost. **The reader's candidate set is not hurt** - the vector leg's -6.9
  at hit@10 does not survive the merge with grep and the anchoring.
- **The block out of the embedded text** (`blockInText: false`, every link still
  resolved and kept on the record) does NOT restore hit@10 on its own (82.8,
  the same as block-in). The planner budgets the whole record text, while the
  live chunker caps the BODY at 2,000 and then prepends the heading - so 35 live
  records sit over the planner's budget and it re-splits them into 30 extra
  `~2` chunks. The chunks, not the block, cost the two questions.
- **Block out and the live chunker's own ceiling** (690 rules records: 0 added,
  0 gone, 690/690 byte-identical to the live corpus, no link line in any text):
  the dense leg reproduces the live row on every column, exactly (58.6 / 72.4 /
  89.7 / 93.1, MRR 0.666; reachable 58.6 / 79.3 / 96.6 / 96.6, MRR 0.682).
- **Variant D: the block in the text, split by the live chunker's own rule.** The
  planner now measures what the live chunker measures - a cap on the BODY after
  the heading is removed (2,000) - instead of a fitted whole-text budget, and the
  record count it produces is 696: 6 block-forced chunks instead of 37, 95 records
  carrying a link line. `src/wiki-plan.mjs` carries that rule; the fitted 2,200
  constant is gone. The dense leg: exact 62.1 / 75.9 / 86.2 / 93.1, MRR 0.690;
  reachable 62.1 / 82.8 / 93.1 / 96.6, MRR 0.706.
  Against the block-out shape at the same budget (which is live, exactly): hit@1
  +3.4, hit@5 +3.4, MRR +0.025, hit@20 equal, hit@10 one question worse (-3.4,
  on the floor edge). **The head gain is the block's, not the chunks'** - +3.4 in
  both block-in shapes, 0 in both block-out ones. The page's own path on variant
  D: exact 34.5 / 69 / 86.2 / 93.1, MRR 0.492; reachable 41.4 / 72.4 / 93.1 /
  **100**, MRR 0.549 - the best reachable hit@20 of any shape, the same head gain
  as phase B, hit@10 and hit@20 unchanged from live. (An earlier row was built
  with a fitted 2,200 whole-text budget: 693 records and 3 chunks, the same
  measurements within a point. It is superseded, and it is the reason the rule
  moved into the planner: a fixed whole-text constant reproduces today's corpus
  only while headings average ~200 characters, and re-chunks silently the moment
  one does not.)

**So: the block earns its place, and the re-chunking is a blocker, not a detail.**
With the budget fixed, the block in the text buys the dense head (+3.4 at hit@1,
+3.4 at hit@5, +0.025 MRR) for one question at hit@10, and the page's own path on
that shape beats live at the head with hit@10/20 unchanged and reachable hit@20
at 100%. The prediction this variant tested - "block out restores hit@10" -
FAILED, and the cause is the planner: it budgets the whole record text while the
live chunker caps the BODY at 2,000 and then prepends the heading, so 35 live
records get re-split into 30 extra chunks. **A phase C that re-chunks 35 existing
records is not the additive rewrite phase A promised** - phase A moved 0 ids,
and a rebuild must not rewrite text nothing asked it to touch. The planner now
splits by the live chunker's own body cap, so the regression guard is measured in
both directions: block out gives 690 records, 0 added, 0 gone and 690/690
byte-identical text; block in gives 696 records and 6 block-forced chunks. The faction half - Battle
Focus and the 58 other faction rules no query can reach today, and the 191 index
pages - is measured in *Arm 3: the faction half* below. The
live rebuild is not taken; the numbers are with Mandal. Artifacts:
`workspace/eval/retrieval-wiki-shape-arms.txt`.

### What an arm on a scratch namespace can claim (2026-10-13)

Arm 3 produced a rank that did not transfer, and the lesson is bigger than the
record. `unitrules#000002541~2` answered **#2** for the Harlequin question in a
namespace built from 6,829 fresh upserts. The same 6,829 records, reached by
6,604 incremental upserts on top of the old 6,575, leave it **outside the top
100** - stable across repeated queries, while the record's own self-query is #1,
so the vector is there and the content is identical. Two namespaces, the same
vectors, a different approximate ranking.

**A scratch namespace is not a preview of the deployed index, and a rank claim
from one does not transfer.** That is not only arm 3's problem: every rules-half
shape arm was measured the same way, in a namespace built fresh, and their head
gains (+3.4 hit@1, +0.025 MRR) rest on that method. What the method can still do
is compare whole arms measured in the same conditions, and the drift control
(self-queries plus rank agreement over records the bank actually returns) is what
licenses that comparison; what it cannot do is certify a per-record rank or a
single flip - and a single flip is exactly what was claimed for the Starweaver
entry.

So: **an arm that decides a shape is measured on the deployed namespace, with the
rollback point as the way back.** That is what phase C did, and its reading is the
one this document records.

And the same lesson's second half, from task 30: **a measurement taken immediately
after an ingest is not the measurement.** Re-run it and compare before recording a
number, or the record carries an index state nobody can reproduce. The first
task-30 after-reading (MRR 0.463 / 0.514) was taken during settling and did not
reproduce; the settled reading is 0.458 / 0.508, identical across two runs minutes
apart. Phase C's before-reading was taken the same way, so it carries the same
caveat.

### Arm 3: the faction half, hosted (2026-10-13)

Built by the default CLI into `workspace/rules-corpus-wiki-c` (variant D - links
on the record, the block in the embedded text, budget at the live chunker's body
cap): **7,525 records**, rules 696, **factions 6,829** - 254 added (63 faction
rules and **191 index pages**), 0 gone, `linkBlockInText: true`, 13,834 links.
The faction half went into a scratch namespace on the hosted HYBRID index, DENSE,
and the namespace was deleted after: `/info` is back to 7,266 vectors with only
`""`, `rules` and `factions`, and the live namespaces were never written. **No
quota or 429 error anywhere**: the 6,829 upserts (~90s), the drift writes and the
delete all went through inside the UTC day the rules arms had already used.

**The drift control, and one correction to it.** The recorded drift set - the
first record of each faction source - is datasheets, which the rules-shaped bank
never returns, so the pair population was 0 and the check was vacuous. The drift
records were re-picked from the records the bank *does* return (unitrules,
enhancements, stratagems, detachments), re-upserted with their live text, and the
read-only pass then read **20/20 self-queries and 0 inversions in 171 comparable
pairs**. A first one-pass run read 16/20: the fresh vectors were queried before
the indexer had registered them - the same race the rules arm hit - and a re-query
put all four at #1. The two-step write-then-check is the method, not one process.

**The bank measures this half thinly; the question set the rules-half arms used
does not measure it at all.** That 33-question set has 49 expectations, every one
rules-side; today's bank has 55, of which **3 are faction-side**
(`unitrules#000000574`, `stratagem#000011205002`, `unitrules#000002541~2`) - all
three entered with the five hand promotions and the Starweaver entry, after the
rules arms ran. A DENSE arm against `factions` on the older set therefore reads
0/0 (run to confirm), while today's bank carries a thin faction signal - three
questions, one of them the flip below - so the aggregate is weak, not vacuous,
and a single flip is about a third of the faction signal. On the live namespace
all three are a **MISS** in the DENSE top 20. The page's own path can see the faction half, so the arm that
was run is the dual path with only the faction VECTOR leg swapped (live rules both
legs, live faction grep, wiki faction vectors), rerank off, per-side 10, net 60,
topk 20, on today's bank (39 questions, 33 graded, 0 fallbacks, 0 Jev calls):

| faction vector leg | exact hit@1 / 5 / 10 / 20 | exact MRR | reachable hit@1 / 5 / 10 / 20 | reachable MRR | candidates | multi-hop fully found |
|---|---|---|---|---|---|---|
| live, 6,575 records | 27.3 / 60.6 / 84.8 / 93.9 | 0.434 | 39.4 / 63.6 / 90.9 / 100 | 0.523 | 23.1 | 5/12 |
| wiki, 6,829 records | 27.3 / 60.6 / 84.8 / 93.9 | 0.434 | 39.4 / 63.6 / 90.9 / 100 | 0.523 | 23.1 | **6/12** |

Every aggregate column is **identical**: the 254 added records and the 191 index
pages cost the reader nothing on this bank, and the candidate count does not move,
so the index pages do not crowd anything out. One entry flipped to fully found in
the scratch arm - the Starweaver re-embark question, `unitrules#000002541~2` at
#2 - **and that flip does not reproduce on the deployed corpus**: after the
rebuild the same question leaves the record out of the DENSE top 100 and
multi-hop fully found stays 5/12. Both namespaces held the same 6,829 records, so
the scratch's #2 is a property of that namespace's index state at that moment
(freshly built in one pass, against a namespace the ingest had just churned), not
of the corpus. With three faction-side expectations the honest reading is **no
measurable change from the faction half**, and the deployed head gain belongs to
the rules half.

**Targeted: Battle Focus** (`faction-rule#000009894`, no record anywhere in the
live corpus; 786 characters in the wiki half). It is **#1** for "What does Battle
Focus do?" and "How does Battle Focus work?", **#2** for the bare name "Battle
Focus", and a miss for three conversational phrasings ("Does Battle Focus give the
Aeldari extra movement or tokens?", "How do the Aeldari use Battle Focus tokens?",
"What is the Aeldari army rule?"). The rule is reachable and uncrowded at its name
query; the phrasing decides, and phase B's rank-1 claim on the conversational
phrasing does not reproduce on this build.

One anomaly for task-30: the built faction half has 13 records over the 2,000
body cap (max 2,084), where the phase-A plan predicted 5 (max 2,061).

Artifacts: `retrieval-faction-arm.txt`, `retrieval-faction-dual-control.txt`,
`retrieval-faction-dual-wiki.txt`.

## Open questions for the vector arm

*The hosted arm above answered the first bullet for the dense leg; the others
still need the local index (13-25 hours full, 2.5-4.5 hours for the two rules
halves) or a hosted faction-side arm (6,829 records, minutes) - run, see *Arm 3*.*

- **Is the link block noise for retrieval? ANSWERED, for the two hosted legs.**
  A parent's vector now carries up to 40 names it does not discuss. On the dense
  leg the head gains 3.4 at hit@1 and loses 6.9 at hit@10 (two questions); on the
  lexical leg hit@5 gains 6.9. Neither leg makes the parent reachable to a query
  that names its child, which is the mechanism the block was for.
- **Which links are in the text and which are only on the record?** Today the
  plan puts every link in the text when it fits. A card's single back-link to its
  faction is cheap but nearly meaningless ("- faction: Aeldari" on 6,575 cards);
  dropping those from the text is a one-line change and a different measurement.
- **Index pages are synthetic records.** They contain no rules text - only names.
  They will rank for name-shaped queries. That is the intent, but 191 of them is
  2.5% of the faction half, and the bank test should say whether they earn it - Arm 3 says they cost
  nothing on the page's path (every aggregate column of the dual arm is identical
  and the candidate count does not move).
- **Do the 37 forced rule chunks help or hurt?** They only exist because the link
  block pushed a parent over the budget. Alternative: cap the block harder and
  keep the parent whole.

## A rebuild re-downloads the export (`--cached` is not a freeze)

`node src/rules-corpus.mjs --scrape --set factions --cached` fetches every CSV
again: `--cached` only keeps a file **when the fetch fails**, so a successful
rebuild always adopts the origin's current export. Measured 2026-10-19: a
one-record routing change rebuilt from the 2026-10-12 cache the live corpus was
built from, and the command pulled the 2026-10-19 export instead (46 extra
faction records, different split points, a different delivered count). The corpus
on disk is the only copy that proves what the baseline was, so when a delta must
be attributable, rebuild offline against the frozen inputs:

```
# the per-corpus box snapshot carries csv/ with the corpus it was taken with
tar -xzf workspace/box-snapshot/rules-corpus-<stamp>.tar.gz -C <scratch>
# build the flat corpus and the wiki shape there, then copy the five corpus
# files back over workspace/rules-corpus and run the ingest/prune/stats loop
RULES_CORPUS_DIR=<scratch>/rules-corpus node <the builder>
```

Refreshing the export is then its own change, with its own measurement.

## Phase C: the rebuild, step by step (dry-run verified 2026-10-13)

Preconditions: arm 3 has reported (the faction half's dense leg), Mandal has said
adopt, and the shape is variant D - links on the record, the block in the embedded
text, split by the live chunker's body cap. Nothing below has been run against a
live namespace; every number is from `--dry-run` and the read-only parity check.

1. **Build the corpus.**
   `node src/wiki-build.mjs workspace/rules-corpus-wiki-c`
   Expect the manifest 7,525 records: rules 696 (6 block-forced chunks), factions
   6,829 (254 new: 59 faction rules and 191 index pages), `linkBlockInText: true`.
2. **Seed the ingest state - the incremental path.** Copy the five
   `workspace/rules-corpus/*.index.json` files into the new directory. Without
   this `--ingest` treats all 7,525 sections as new; with it only what changed is
   embedded. This is the one manual step; the copy is exact and auditable.
3. **Dry-run the ingest.** `RULES_CORPUS_DIR=<dir> node src/rules-corpus.mjs
   --ingest --dry-run`. Expect **embed 6,705, delete 0**: core-rules 84,
   rules-appendix 12, event-companion 5, core-stratagems 0, factions-csv 6,604,
   leave 820. (A plan near 7,525 means the state copy in step 2 was missed.)
4. **Ingest.** `RULES_CORPUS_DIR=<dir> node src/rules-corpus.mjs --ingest`. No
   `--prune`: the rewrite is additive, every source's vanish count is 0 - the
   dry run proves it. This writes the live `rules` and `factions` namespaces and
   the new state and ledger beside the corpus.
5. **Prove it id for id.** `RULES_CORPUS_DIR=<dir> node workspace/index-vs-corpus.mjs`
   (read-only). Expect `rules 696 | corpus 696 | 0 | 0` and
   `factions 6,829 | corpus 6,829 | 0 | 0`. Counts alone are not proof; this
   enumerates both sides.
6. **Restart the server** per docs/HANDOFF.md §Restarting - it caches the corpus
   for the life of the process, and that recipe sets `RULES_TRACES=1`, which is
   correct: the page carries the retention line in both languages
   (docs/question-traces.md).
7. **Read one answer by hand.** The FALL-BACK question and the Asurmen ability
   question are the two the rewrite is for; check the anchored record is in the
   findings before trusting the bank.
8. **Snapshot.** The off-disk Box snapshot is the recovery point taken after an
   ingest (docs/corpus-storage.md). `node src/box-snapshot.mjs` tars the corpus and
   prints its sha256, then the box recipe; write the snapshot id, the size and the
   hash into docs/corpus-storage.md, because `box snapshot list` needs a box
   selected and the id is the only handle once the box is deleted. The snapshot
   captures any key written to a file - keep keys out of the corpus directory
   (docs/key-hygiene.md).
9. **Record it.** Flip this document from "not adopted" to adopted with the
   ledger's rebuild number and the parity line, and note the rules count the bank
   was measured against.

### Two tooling gaps found by the dry run

- **FIXED, and it would have corrupted phase C: the writer carried the source
  record's hash onto rewritten text.** `--ingest` decides what to embed by
  comparing each section's hash to the per-source ingest state, and the planner
  copied the live hash onto records whose text it had just changed. The first dry
  run therefore planned **6 rules upserts while 78 core-rules records had a new
  link block and the old hash** - phase C would have rebuilt the corpus, "run"
  and left those old vectors in the live index. `toSection` now recomputes
  `textHash(rec.text)` over the final text (the live convention), which is why
  the plan above is 6,705 and not 260. Guarded by tests in
  `tests/test-wiki-plan.mjs`.
- **OPEN, a cost decision: the faction cards carry a back-link line in their
  text.** That is 6,575 records whose text changes, so adopting the rewrite
  re-embeds 6,604 faction vectors. Priced at Upstash's update rate, $0.40 per
  100,000 update operations, that is 6,604 x $0.000004 = **about $0.03**, plus
  roughly 0.03 GB of storage (~$0.007/month at $0.25/GB); on the Free plan it is
  66% of one day's 10,000-update quota. Any token-based embedding charge is
  **unpriced** here: Upstash's upsert takes the raw text and embeds it
  server-side, and no separate line for it appears in the pricing read for this
  decision. (The $0.000634 per call quoted elsewhere in this repository is the
  Jev rerank model call on OpenRouter - a different service, it does not apply to
  upserts.) Against the ~700-vector rules arms. The card back-link is the
  nearly-meaningless line the open questions already flag ("- faction: Aeldari");
  dropping it from the embedded text is the one-line switch that would cut the
  re-embed to the 254 genuinely new records. Decide it with arm 3's numbers.

### Phase C: landed (2026-10-13)

Variant D is the live corpus. The runbook above ran as written except for two
steps it does not name, both caught by the parity and /health checks:

- **The ingest updates the index, not the corpus directory.** The server reads
  `workspace/rules-corpus`, so landing the rebuild means promoting the five
  `<source>.json` files (with their `.index.json` state and `.rebuilds.json`
  ledger) from the build directory into it. Before that the server served 690 /
  6,575 against an index of 696 / 6,829 - /health said
  `ahead: ["rules +6","factions +254"]`. A full copy of the old directory is kept
  at `workspace/rules-corpus-before-phasec/`; re-ingesting it puts the old corpus
  back.
- **The build dropped the corpus's provenance.** `writeWikiCorpus` wrote only
  `{ sections }`, while /health's `updated` and every trace's `corpusAt` come from
  the source payload's `scrapedAt` and `marker`. The first restart served
  `updated: null` - an undated corpus reads like a stale one. `carryStamps` now
  rides those stamps through the build (count and anchored recomputed, never
  carried; guarded in `tests/test-wiki-plan.mjs`).

The rebuild itself: build 7,525 records (rules 696, factions 6,829); dry run
**embed 6,705, delete 0** (core-rules 84, rules-appendix 12, event-companion 5,
core-stratagems 0, factions-csv 6,604; leave 820); ingest **6,705 upserted, 0
deleted**; parity `rules 696 | corpus 696 | 0 | 0` and `factions 6,829 | corpus
6,829 | 0 | 0`; ledger rebuild #1 per source at 2026-10-13T21:42-21:43Z; **no
quota, 429 or write-limit error**. The server was restarted only after parity and
now reports corpus 696 / 6,829, `ahead`/`behind` empty, `updated`
2026-10-13T00:55:31.597Z, `sourceDate` June 2026.

**The reader-facing effect, measured on the deployed corpus** (dual, rerank off,
per-side 10, net 60, topk 20, today's 39-question bank, 33 graded, 0 fallbacks, 0
Jev calls): exact hit@1 **27.3 -> 33.3**, hit@5 60.6 -> 63.6, hit@10 84.8
unchanged, hit@20 93.9 unchanged, MRR **0.434 -> 0.475**; reachable hit@5
63.6 -> 66.7 with hit@1/10/20 unchanged (39.4 / 90.9 / 100), MRR 0.523 -> 0.525;
candidates 23.1 -> 23.1; multi-hop fully found 5/12 unchanged. The direction and
size match the rules-half variant-D arm (+6.9 hit@1, +0.043 MRR on the
29-question set), and that is the half the gain belongs to.

Hand-reads on the deployed corpus: the Asurmen question carries its anchored
record (`Asurmen - keywords and abilities`, holding the Tactical Acumen passage)
at finding [20], and the judge cites it. The FALL-BACK question's 25 findings on
`tests/ask.mjs` do not include the FALL-BACK MOVE record, but that is the known
configuration effect in docs/question-traces.md, not a phase-C change: on the
bank's fixed path (dual, rerank off) the same question retrieves it at **#9**,
exactly as recorded before the rebuild.

**The Box snapshot.** This rebuild had a local rollback point only
(`workspace/rules-corpus-before-phasec/`). The off-disk one exists now: snapshot
`5f703039-dc4f-4ae6-b7ed-9ede21a73eb8` (2026-10-14), taken by hand from a temporary
box, restored into a fresh box and the sha256 compared - verified rather than
assumed. See docs/corpus-storage.md for what it holds and for the recipe script.

**Follow-up this leaves open:** the live corpus is now a wiki build, and
`--scrape` writes the flat corpus into the same directory - a later scrape would
silently revert the shape. The next session should make the build the scrape's
output or gate the scrape behind it.

### Task 30: the generic-ability restructure (ingested 2026-10-14)

A datasheet's ability record embedded the full text of every ability it has,
including the ones that are the same on hundreds of datasheets. The corpus paid
for them 598 times over (Deadly Demise alone) and the record's own ability was
buried behind them: `unitrules#000002541~2` held 845 chars of the Harlequin army
rule before Rapid Embarkation began.

The fix is a **labelled-segment extractor**, not a text heuristic: the scrape
already marks every ability `Ability (Core|Faction|Datasheet): <name> - <text>`. A
Datasheet segment is the unit's own and stays. A Core or Faction segment is a rule
defined elsewhere and is dropped whole, replaced by a link line naming its record -
**but only when its text is contained in the owner's canonical text or is a
rendition of it** (>=60% of its 100-char windows present in the canonical text). A
materially different variant STAYS in the datasheet: it is that record's own text,
and the link line is added anyway. Under that rule 3,198 segments are stripped and
37 (17,528c, in 36 records) stay - Super-heavy Walker keeps 3 distinct variants in
10 records, Combat Doctrines keeps three 107-char fragments, Synapse keeps none.

The extractor runs **detect -> strip -> chunk**: the parts are joined back to the
logical record first, so the chunker never sees a segment split across parts and
the orphan-tail class cannot exist. The merge of `~1`/`~2` is a consequence of the
shrink, not a step of its own. Verified against the pre-order run: same total
(6,731), same added (808) and removed (1,602), same 1,602 migration rows; `changed`
is 656 rather than 672, and the 16-record difference is exactly the owner
absorption this rule removed, not an effect of the order.

Dry run (`workspace/task30-dryrun/`, no writes to the corpus or the index):

| measure | value |
|---|---|
| records with a segment label and no text after it (the debris class) | **0** |
| shared segments stripped | 3,198 |
| segments kept as materially different renditions | 37 (17,528c) in 36 records |
| removed ids | **1,594**, every one mapped in `id-migration.tsv` |
| base ids created | 788 |
| new ability records | 16 |
| changed records | 664 |
| proposed total | **6,735** (was 7,525) |
| the case, merged | `unitrules#000002541`, 822c, Rapid Embarkation at **228** |
| the case, unmerged | `unitrules#000002541~2`, 1,054c, Rapid Embarkation at **590** |

**This is a deliberate one-time restructure, not scrape drift.** The id-stability
rule exists to stop accidental churn; this churn is the point, it is mapped id for
id, and nothing has to go dead: the 68 trace references and the bank's
`unitrules#000002541~2` become a deterministic translation through the migration
map. The bank move itself still waits on reachability, verified on the deployed
namespace.

The unmerged row is the design's invariant: the strip is correct only because the
extractor sees the whole segment. An extractor that worked per part would leave the
569-char orphan tail of Battle Focus in `~2` and Rapid Embarkation at 590 instead
of 228. The rollback point for the change is `workspace/rules-corpus-before-task30/`
(68 files, 25.5 MB), refreshed again immediately before the ingest.

The link line is `renderLinks(links)` and nothing else: a finding exposes
`links: [{to, title, kind, anchor, url}]`, the page renders from that array and
stops parsing `- ability: X` out of text. One format for the page slice and the
corpus slice.

**Landed.** Ingest **1,562 upserted, 1,619 deleted**, exit 0; parity id for id
`rules 714 | 714 | 0 | 0` and `factions 5,998 | 5,998 | 0 | 0`; /health
714 / 5,998 with `ahead`/`behind` empty; server restarted with `RULES_TRACES=1`
(pid 6296). Rollback point: `workspace/rules-corpus-before-task30/`.

The deployed reading, dual rerank-off per-side 10 net 60 topk 20, 39 questions /
33 graded, 0 fallbacks, 0 Jev calls. **After, settled** (two runs minutes apart,
identical): exact hit@1 **30.3**, hit@5 60.6, hit@10 84.8, hit@20 93.9, MRR
**0.458**; reachable hit@1 **36.4**, hit@5 63.6, hit@10 90.9, hit@20 100, MRR
**0.508**; multi-hop fully found **6/12**; candidates 23.1.

**Before, with the same caveat**: 33.3 / 63.6 / 84.8 / 93.9, MRR 0.475 exact and
39.4 / 66.7 / 90.9 / 100, MRR 0.525 reachable - but those numbers were read right
after phase C's ingest, so they were taken during settling too. Two things follow
and neither should be smoothed over:

- the first after-reading recorded here (0.463 / 0.514) was taken while the index
  was still settling, minutes after the ingest - it is not the state the reader
  gets, and it is kept only as the example of the mistake;
- the before/after is therefore less precise than it looks, and with the case
  corrected below the head movement is **one question**. It cannot be attributed to
  the strip. The honest label is: **a small head loss, inside the bank's 2-4 point
  floor, with a plausible cause** - and one measured gain, the multi-hop, which is
  the one the change was for.

The index was also rebuilt twice between the two readings (the first ingest
attempt re-upserted all 6,712 records before its delete failed), and insertion
history is exactly the thing that moved ranks in the scratch-namespace lesson
above. Both confounds are named here rather than argued away.

The case: `unitrules#000002541` is **reachable** for the Harlequin question at
rank **#16** of 25 on the deployed namespace, and the entry is **fully found** where
it used to be partial. The correction matters: before this change the harness line
read `expected 2 groups, found 1 (best rank #7)` and the missing group was the
ability - the #7 was the FAQ's rank and `unitrules#000002541~2` was not in the top
20 at all. So the movement is **missing -> #16**, a gain, corroborated by multi-hop
5/12 -> 6/12. There is no #7 -> #16 slide. It was verified reachable before the
bank expectation moved, and the fixture entry now says in as many words that the id
move was a re-addressing of a merged id, not a relaxation.

**What the strip actually traded.** The duplicated generic text was doing retrieval
work: it carried the words a question about a datasheet shares with its faction
(here, "Harlequin" and the army rule), so removing it costs a little head precision
and buys the multi-hop case. The link line preserves the NAME and nothing else, so
the dense leg loses bridging text the lexical leg keeps - the grep leg still sees
`- ability: Deadly Demise` and reaches the datasheet. That is the lever for the
next slice: a record could carry a short "what this links to" context line - the
target's name plus a phrase of its own text - without duplicating anyone's text.

Three deviations from the dry run, none rounded:
- the build lands **6,712** records, not the payloads' 6,735: 25 index pages are
  regenerated away (fewer cards after the merges) and 2 ability records are
  chunked;
- the first ingest failed on `delete failed: HTTP 400 {"error":"Exceeded max batch
  deletion limit: 1000"}` - a real endpoint limit, not a quota error. `deleteIds`
  now batches at `DELETE_BATCH = 500` (guarded in `tests/test-wiki-plan.mjs`), and
  the retried ingest completed 1,562 / 1,619;
- the index also carries 1 vector in the default namespace, which is outside both
  halves and predates this change.

## Recommendation

**Both halves take the variant-D shape, decided 2026-10-13.** Links on the record,
the block in the embedded text, the planner's budget at the live chunker's own
ceiling. The rules half is measured as the best reader-facing shape (head +6.9
against live, hit@10 and hit@20 unchanged, reachable hit@20 100%) with the dense
leg's one-question hit@10 cost inside the floor. The faction half is measured in
*Arm 3*: aggregates and candidate count unchanged (no crowding; the scratch arm's
Starweaver flip did not reproduce on the deployed corpus - see *Arm 3*), Battle
Focus becomes reachable at its name queries, +63 faction-rule records and 191
index pages, 0 records lost. **The caveat
recorded with the decision:** Battle Focus still misses on three conversational
phrasings, so the wiki structure alone does not close the buried-ability problem -
phrasing and reranking still carry part of it. The rebuild landed the same day -
see *Phase C: landed*.
