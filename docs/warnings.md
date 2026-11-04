# Parser warnings

*The warnings the parser raises, what each means, and the weekly recompute.*
Which warnings the parser emits, how often, and which repeats are the parser's
fault. [src/warnings.mjs](../src/warnings.mjs) is the survey:

```powershell
node src/warnings.mjs --labelled archive=archive/events --labelled future=workspace/weekly/future-parses
node src/warnings.mjs --reparse                   # read every stored body again, current parser
node src/warnings.mjs --since <edition start>     # when a new edition lands
node src/warnings.mjs --json <file>               # every warning as one JSON record
node src/warnings.mjs --dir <dir>                 # any directory of parse outputs, repeatable
```

It walks parse outputs - `{ event, count, players }`, the shape `/parse`
returns - and recomputes every warning through the same `playerWarnings()` /
`getMeta()` pair the page renders. Nothing is read from a stored verdict, so a
parser fix changes every list's warnings at once, including the lists archived
before it: **the archived files store the text, not the warnings.**

The units are a different matter, and it used to make the claim above half
true: a stored parse carries the units the parser read when the event was
archived, so a fix changed nothing until the event was fetched again.
`--reparse` closes that gap - every army is rebuilt from its own body text by
the current parser before it is judged. Use it whenever the question is "what
does the parser say today"; leave it off when measuring what a harvest actually
wrote.

The report is built to separate a player's mistake from a parser's. A warning on
one list is the player; the same warning across events, or concentrated in one
exporter, is a shape the parser was never taught. Every repeated signature
prints its spread - how many events, how many exporters - and every exporter
prints its warning rate against the pool.

## The archive holds one edition

The archive used to keep **a year**, and a year spans **two editions**. They do
not give the same warnings, because they do not carry the same fields: a
10th-edition list has no Force Disposition to declare, so 6,290 warnings - 87% of
the archive's - were one fact about the old edition. Those events were dropped on
2026-10-17 (`node src/archive.mjs --drop-before 2026-07-01`), 213 of them, and
the harvest's ledger remembers each as a permanent refusal so it never fetches
one back.

**The cut is content, not a date.** The 2025-2026 league played its last fixture
on 2026-06-30 while a tournament on 2026-06-27 already plays the new edition, so
the dates overlap; a date alone would either keep the league or throw the
tournament away. What separates them is the field the new edition introduced, and
the rule is exactly that: an event dated before the cut is kept when one of its
lists declares a Force Disposition. Five events survived on that test, and the
30-day share of lists declaring a disposition - 0% for every month from 2025-10
to 2026-05, then 98% from 2026-07 - is the measurement the cut rests on.

When the next edition lands, `--since` measures across the seam; `--drop-before`
cuts it.

## The survey of 2026-11-04

64 events, **1,613 lists**, **240 warnings** (14.9% of lists), read by the
current parser with `--reparse`: the 52 archived events and the 12 open League
Wars fixtures.

| warning | lists | share | per 100 lists |
|---|---:|---:|---:|
| `mismatch` | 123 | 51.3% | 7.6 |
| `disposition` | 61 | 25.4% | 3.8 |
| `missing-total` | 24 | 10.0% | 1.5 |
| `detachment` | 21 | 8.8% | 1.3 |
| `unrecognized` | 11 | 4.6% | 0.7 |

| exporter | lists | warnings | per 100 lists |
|---|---:|---:|---:|
| `app` | 1,241 | 105 | 8.5 |
| `newrecruit` | 311 | 61 | 19.6 |
| `armylistnetwork` | 21 | 19 | 90.5 |
| `warorgan` | 20 | 19 | 95.0 |
| `unknown` | 16 | 26 | 162.5 |
| `ironbuilt` | 3 | 9 | 300.0 |
| `league` | 1 | 1 | 100.0 |

Without `--reparse` the same corpus reads 266 warnings, because the stored
units are older than the parser: 45 lists' units or totals differ from their
stored parse, and 11 of those changed with the fixes below. The archive's stored
units are not rewritten - see the last section.

### The league fixtures, on their own

`League Wars 2026-2027` is the fixture set this page is used for most, so it is
worth reading apart from the pool: 11 events, **344 lists, 22 warnings** (6.4 per
100 lists), 19 lists carrying one. Thirteen are `mismatch`, and ten of those are
a player's own arithmetic at -5 to -10 points; the four `disposition` warnings
are four different spellings of the field (a `Distruption` typo, a disposition
written after the detachment on one line, a dash separator instead of a colon,
and `Scénario :`), and the two `detachment` warnings are an Ironbuilt export no
reader handles and one freeform header whose detachment carries a rule name in
parentheses. Those four are player-side and left alone rather than guessed at.

## What each warning means here

### mismatch - 123, the top warning, and not attributed

Half of every warning, so it is the one worth reading closely. What is known:

- **Most of it is small and has no repeated value**: -10 x12, -5 x10, -110 x7,
  -100 x7, -20 x5 - and a long tail. A systematic misread would show one delta
  over and over.
- **Three systematic classes were found and fixed on 2026-11-04**: one
  over-count and two that lost units, all of them a header read as something it
  is not. The app's header export prints an `ATTACHED UNITS` section whose
  `Attached Unit N (N points)` line carries the group's combined total over
  members that carry their own points, and the league template prints the same
  thing as `Name + Name (290 pts)`; counting the header as a unit counted every
  group twice, which put five lists +550 to +900 over their own declared total,
  and each was exact once the header was skipped. A header block that ends
  without a closing fence consumed the line under it, which is a unit whenever
  the list opens with a `+++` fence - four lists. A single
  `+Engine speaker (15pts)` line under a unit read as a header start, which
  moved the body start above every unit: one list lost seven units and 810
  points. Pinned in `tests/test-attached-groups.mjs` and
  `tests/test-list-text.mjs`.
- **The battle size read as an army total was one class of false alarm** and is
  fixed: `Incursion (1000 points)` is the 1000-point game size the app prints on
  every list of that size, and the parser read it as a banner - an army called
  "Incursion" with a 1000-point total - so a 995-point army warned a 5-point
  mismatch. `Strike Force` and `Force de Frappe` were already known; the
  vocabulary now comes from the corpus (306 + 295 + 29 lines, and nothing else).
- **Unit-line recall is ~96%** on both main exporters, so it is not a wholesale
  parse failure. Three lists are hard breaks: Pravdaël's Tyranids read 3 units of
  14 - the newrecruit reader stops at the first bare `Name [Npts]` line that
  follows prefixed ones, so everything under the switch is lost; 0gier 4 of 17;
  Septarion 4 of 11.

Not attributed: a per-list diff of the remaining tail. That is the next job here,
not a fix that can be guessed at.

### disposition - 61, none of them a shape the parser was never taught

Every one of them is a list that prints no disposition in a form any reader
knows. What is left in the League fixtures after today's spelling fixes is four
players' own vocabulary: a `Distruption` typo, a disposition written after the
detachment on one line, a dash separator in place of the colon, and
`Scénario :`. They are left alone deliberately - guessing at a player's
private shorthand is how a field starts lying - so this stays a real signal at
3.8%.

### missing-total - 24

An unrecognised list is also a list whose total is never read. The remainder
print no total and no size line.

### detachment - 21

Mostly app headers printing `+ DETACHMENT USED :` with nothing after the colon -
the source leaving the field empty, not the parser missing a value. The league
submission's `Detachment(s):` label is read, and so is a bulleted
`• Detachments:` line whose points are misspelt `Detachement`.

### unrecognized - 11

Since the recognition rule became structural (fewer than two units), this fires
on a submission with almost nothing in it: a handful of empty bodies, lists of
one or two units, and the Ironbuilt exports no reader handles. When it fires
now, the army is empty on the page too.

## The fixes of 2026-10-17

Five, each measured before it was written and pinned by a test.

| what | lists | where |
|---|---:|---|
| The total labels that hid a declared total (`ARMY POINTS`, `POINTS D'ARMÉE TOTAL`, bare `TOTAL`/`POINTS`) | 141 | `9d26fdf` |
| The dispositions the parser could not see (dash key, unfenced `+ KEY:` header, `DISPOSITION DE FORCE`, declared outside the preamble) | 15 | `075d3ee` |
| Recognition: a list with two units is a list, whatever dialect it is in | 16 | this branch |
| `Total : 1995 points - 42 figurines` counted as a unit on 1000-point events | 1 | this branch |
| `Incursion (1000 points)` read as an army banner | 6 | this branch |

The recognition fix is the one to remember: the test required one of three
marker families (bracketed points, `Char1:`, a bullet) *and* two units, and the
first clause was a proxy for the second that lied about armylistnetwork - 15 of
its 16 lists hold 5 to 16 units each, all read correctly, and were rendered as
empty armies. It is structural now: fewer than two units is unrecognised, and
nothing else decides.

## The fixes of 2026-11-04

Five, found by the first harvest since the edition cut and measured over every
stored body before each was written.

| what | lists | where |
|---|---:|---|
| The attached-group header counted as a unit (`Attached Unit N (N points)`, and `Name + Name (290 pts)` in the league template) | 6 | `src/parse.mjs`, `ATTACHED_GROUP_RE` / `ATTACHED_PAIR_RE` |
| A header block that consumed the line under it (a `+++` fence too short for the delimiter test) | 4 | `src/parse.mjs`, `findPlusBlock` end index |
| A lone `+Engine speaker (15pts)` line read as a header start, which moved the body above every unit | 1 | `src/parse.mjs`, the key must carry a colon |
| The league submission's header spellings (`DISPOSITION FORCE`, `Detachment(s)`, a bulleted `Detachments:`, `Detachement Points` with one t), and a detachment value that kept its own label and the points it costs | 12 | `src/parse.mjs`, header aliases, `DISPOSITION_LABEL_RE`, `DET_PATTERNS`, `cleanDetachment` |
| The league submission itself, named instead of left as `unknown` | 1 | `src/parse.mjs`, `structureExporter` |

Twenty-three lists parse differently after them: eleven on units and totals, and
twelve on metadata. The five attached-group lists now match the export's
`NUMBER OF UNITS` and its total exactly, the five header-boundary lists
recovered a unit worth 100 to 900 points, and the metadata lists gained a
detachment or a disposition, or lost a label from one. The survey's warning
count falls from 256 to 240 on the same corpus.

`tests/test-attached-groups.mjs` is new; `tests/test-list-text.mjs` gained the
two header-boundary cases and the three header labels above;
`tests/test-formats.mjs` pins the league fingerprint. The 2026-10-17 fixes
account for the other 34 lists that move when the stored bodies are read again,
which is why the survey takes `--reparse` now.

## The weekly pass

The one thing that cannot be re-fetched is a list whose event has passed and
whose page MHQ later drops, so the pass is: archive what closed, parse what is
open, then read the warnings.

```powershell
node src/archive.mjs --plan --months 12   # what a harvest would consider
node src/archive.mjs --months 12          # archive the newly closed events
node src/archive.mjs --verify             # every entry still resolves
node src/scan-open.mjs                    # parse the open events into workspace/weekly/future-parses
node src/warnings.mjs --labelled archive=archive/events --labelled future=workspace/weekly/future-parses \\
  --reparse --json workspace/weekly/warnings-<date>.json
```

An upcoming event is parsed fresh each week rather than archived - its lists are
still being submitted, which is why `/parse` declines the cache for one
(`notYetPlayed()`). `src/scan-open.mjs` checks every event dated today or later
and keeps a manifest of the verdicts; a failure is never recorded as a verdict,
so the next run retries it. 2026-11-04: of 135 not-closed events, 11 had lists
out (nine *League Wars 2026-2027* fixtures, plus *B4* and three aller rounds);
118 had not published, and 6 were another game. The harvest that same day took
the 7 closed events since 2026-10-17, which leaves 52 events in the window and
40 checked against the sitemap's 1,221 closed ones.

Their parses live in `workspace/weekly/future-parses/`, untracked like the rest
of `workspace/`.

One consequence worth knowing before reading a list on the site: the stored
units are not rewritten, so an archived event keeps the parse its harvest made.
A reader fix reaches the site for events harvested after it, or for one re-taken
with `archive.mjs --refresh`.
