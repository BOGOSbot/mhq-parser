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

**The vector arm is not run.** Ollama and bge-m3 are on the machine, and the
measured local embedding rate is 1.61s per record batched, so the full 7,556-record
local index is **~3.4 hours** (the rules half alone is ~20 minutes) - free, but
longer than a session. That is the price of the vector-arm numbers and of phase C's
rebuild; it is measured, not estimated.

**So: a conditional go.** The rewrite is safe (0 ids moved), affordable (+291
records), and it fixes a class of rule that cannot be retrieved today - the Battle
Focus class - which the lexical arm already proves. The aggregate is positive
beyond the noise at hit@5 and at the edge of it elsewhere. What is NOT shown is the
link-block mechanism (its parent test is negative) and the vector arm (~3.4h), and
the four open questions below (back-links in or out of the text, name-only index
pages, the 37 forced chunks) are all vector-arm arms. Phase C should therefore be
scheduled with the local build first, and the live rebuild asked for only once the
local numbers exist.

## Open questions for the vector arm

*The four arms below all need the local vector index (measured: ~3.4 hours of
embedding), which is why the lexical gate above is the only one that has run.*

- **Is the link block noise for retrieval?** A parent's vector now carries up to
  40 names it does not discuss. The bank test above answers it; if hit@1 drops
  while hit@10 rises, the block belongs on the record but not in the vector text.
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

**Proceed to phase B, on the local backend, with the bank as the gate** - phase B
has now run, and its measured result is above. In short: build it, and the local
vector arm before the live rebuild. The
dry run says the rewrite is additive (0 ids moved), affordable (291 records,
+0.5% on rules, +3.9% on factions), and it fixes a real hole (59 faction rules,
Battle Focus among them, that no query can reach today). But the retrieval gain
is unproven, and the honest order is: build it locally, run the bank, and only
then decide whether the live index is rebuilt. The plan is one module
(`src/wiki-plan.mjs`), so rejecting it costs nothing that has been written into
the corpus.
