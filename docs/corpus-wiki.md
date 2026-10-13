# The corpus as a wiki (phase A)

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

**So: not adopted.** The rewrite is safe (0 ids moved), affordable (+291
records), and it closes a real hole - the Battle Focus class, 59 faction rules no
query can reach today - but that win is in the faction half, which this arm did
not embed (6,829 records, minutes and under a cent hosted, a separate decision).
On the rules half the dense leg's cut is 6.9 points worse, two questions fall out
at hit@10, and the mechanism the rewrite was bet on is negative on both legs. The
live rebuild is not taken; the numbers are with Mandal. Artifact:
`workspace/eval/retrieval-vector-wiki-arm.txt`.

## Open questions for the vector arm

*The hosted arm above answered the first bullet for the dense leg; the others
still need the local index (13-25 hours full, 2.5-4.5 hours for the two rules
halves) or a hosted faction-side arm (6,829 records, minutes).*

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
  2.5% of the faction half, and the bank test should say whether they earn it.
- **Do the 37 forced rule chunks help or hurt?** They only exist because the link
  block pushed a parent over the budget. Alternative: cap the block harder and
  keep the parent whole.

## Recommendation

**Do not rebuild the live index on this evidence.** The rewrite is additive and
correct (0 ids moved, a real hole closed), and the one arm that could show the
Battle Focus win - the faction half, 6,829 records through the same hosted route
- is minutes away rather than hours. But the rules-half dense leg loses 6.9
points at hit@10 while the link block's parent test stays negative on both legs,
so the retrieval premise is unproven where it was testable. Adopting the corpus
now would be accepting that cost for a hole this arm did not measure; the plan is
one module (`src/wiki-plan.mjs`), so rejecting it costs nothing written into the
live corpus.
