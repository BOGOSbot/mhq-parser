# Parser warnings

*The warnings the parser raises, what each means, and the weekly recompute.*
Which warnings the parser emits, how often, and which repeats are the parser's
fault. [src/warnings.mjs](../src/warnings.mjs) is the survey:

```powershell
node src/warnings.mjs --labelled archive=archive/events --labelled future=workspace/weekly/future-parses
node src/warnings.mjs --since <edition start>     # when a new edition lands
node src/warnings.mjs --json <file>               # every warning as one JSON record
node src/warnings.mjs --dir <dir>                 # any directory of parse outputs, repeatable
```

It walks parse outputs - `{ event, count, players }`, the shape `/parse`
returns - and recomputes every warning through the same `playerWarnings()` /
`getMeta()` pair the page renders. Nothing is read from a stored verdict, so a
parser fix changes every list's warnings at once, including the lists archived
before it: **the archived files store the text, not the warnings.**

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

## The survey of 2026-10-17

49 events, **1,194 lists**, **226 warnings** (18.9% of lists), after the five
fixes below.

| warning | lists | share | per 100 lists |
|---|---:|---:|---:|
| `mismatch` | 119 | 52.7% | 10.0 |
| `disposition` | 60 | 26.5% | 5.0 |
| `missing-total` | 20 | 8.8% | 1.7 |
| `detachment` | 19 | 8.4% | 1.6 |
| `unrecognized` | 8 | 3.5% | 0.7 |

| exporter | lists | warnings | per 100 lists |
|---|---:|---:|---:|
| `app` | 923 | 101 | 10.9 |
| `newrecruit` | 219 | 60 | 27.4 |
| `warorgan` | 19 | 17 | 89.5 |
| `armylistnetwork` | 16 | 19 | 118.8 |
| `unknown` | 15 | 23 | 153.3 |
| `ironbuilt` | 2 | 6 | 300.0 |

## What each warning means here

### mismatch - 119, the top warning, and not attributed

Half of every warning, so it is the one worth reading closely. What is known:

- **Most of it is small and has no repeated value**: -10 x10, -110 x9, -100 x8,
  -5 x6, -85 x4 - 26 of the 119 are under 30 points and 18 are 30-99. A
  systematic misread would show one delta over and over.
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

### disposition - 60, all genuinely undeclared

Zero of them name a disposition the parser failed to read. The lists that carry
the field are read: the ten that were not are fixed below. This is a real signal
at 5%.

### missing-total - 20

Down from 31 with the recognition fix below: an unrecognised list is also a list
whose total is never read. The remainder print no total and no size line.

### detachment - 19

Mostly app headers printing `+ DETACHMENT USED :` with nothing after the colon -
the source leaving the field empty, not the parser missing a value.

### unrecognized - 8, and none of them a dialect

The group is down from 24. What is left is not a format the parser cannot read,
it is a submission with nothing in it: 2 empty bodies, one body that is only a
URL, and 5 more that hold fewer than two units (2 Ironbuilt exports, one
markdown-flavoured newrecruit list, 2 freeform pastes). When this warning fires
now, it means the army is empty on the page too.

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
  --json workspace/weekly/warnings-<date>.json
```

An upcoming event is parsed fresh each week rather than archived - its lists are
still being submitted, which is why `/parse` declines the cache for one
(`notYetPlayed()`). `src/scan-open.mjs` checks every event dated today or later
and keeps a manifest of the verdicts; a failure is never recorded as a verdict,
so the next run retries it. 2026-10-17: of 133 not-closed events, 4 had lists out
(*LTC 12* and three *League Wars 2026-2027* fixtures); the other 120 had not
published, and 9 were another game. Their parses live in
`workspace/weekly/future-parses/`, untracked like the rest of `workspace/`.
