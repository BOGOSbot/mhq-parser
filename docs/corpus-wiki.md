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
pages - is still unmeasured and runs after the daily update budget resets. The
live rebuild is not taken; the numbers are with Mandal. Artifacts:
`workspace/eval/retrieval-wiki-shape-arms.txt`.

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
   for the life of the process. Do not set `RULES_TRACES=1` in that recipe: the
   retention line is not on the page yet (docs/question-traces.md).
7. **Read one answer by hand.** The FALL-BACK question and the Asurmen ability
   question are the two the rewrite is for; check the anchored record is in the
   findings before trusting the bank.
8. **Snapshot.** The off-disk Box snapshot is the recovery point taken after an
   ingest (docs/corpus-storage.md). It is a Box-side step, there is no script for
   it here, and it captures any key written to a file - keep keys out of the
   corpus directory (docs/key-hygiene.md).
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
  re-embeds 6,604 faction vectors - about $4.2 on pay-as-you-go, or most of one
  Free plan day, against the 700-vector rules arms. The card back-link is the
  nearly-meaningless line the open questions already flag ("- faction: Aeldari");
  dropping it from the embedded text is the one-line switch that would cut the
  re-embed to the 254 genuinely new records. Decide it with arm 3's numbers.

## Recommendation

**Build the rules half in the variant-D shape, after the faction arm and not
before it.** Links on the record, the block in the embedded text, and the
planner's budget at the live chunker's own ceiling: measured as the best
reader-facing shape (head +6.9 against live, hit@10 and hit@20 unchanged,
reachable hit@20 100%) with the dense leg's one-question hit@10 cost inside the
floor. The budget rule is fixed in the planner (the live chunker's body cap), so
the shape phase C would build is the shape measured here.
What is still missing is the benefit, the faction rules and the index pages, so
the faction arm decides. Nothing has been written into the live corpus.
