# Parser warnings

Which warnings the parser emits, how often, and which repeats are the parser's
fault. [src/warnings.mjs](../src/warnings.mjs) is the survey:

```powershell
node src/warnings.mjs --since 2026-07-01 --labelled archive=archive/events --labelled future=workspace/weekly/future-parses
node src/warnings.mjs                                  # the whole archive, both editions
node src/warnings.mjs --dir <dir>                      # any directory of parse outputs, repeatable
node src/warnings.mjs --json <file>                    # every warning as one JSON record
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

## Measure the current edition, not the archive

The archive keeps **one year**, and a year spans **two editions**. The two do
not give the same warnings, because they do not carry the same fields: a
10th-edition list has no Force Disposition to declare, so warning about its
absence is a fact about the edition and not about the parser. Read whole-archive
numbers as archaeology.

The boundary is visible in the data and it is **2026-07-01**, not a year back:
the share of lists declaring a disposition goes 0% for every month from 2025-10
to 2026-05, 2% in 2026-06, then **98%** from 2026-07 on (the 2026-06 bucket is one
league whose fixtures all carry a 06-30 date; a handful of late-June events
already have the field). The app's own `+++` header changes with it - it prints
`SECONDARY` before and `FORCE DISPOSITION` after.

| month | armies | warned | declared |
|---|---:|---:|---:|
| 2025-10 .. 2026-05 | 3,213 | 3,213 | 0 |
| 2026-06 | 3,096 | 3,032 | 64 |
| 2026-07 | 214 | 41 | 173 |
| 2026-08 | 219 | 5 | 214 |
| 2026-09 | 368 | 7 | 361 |
| 2026-10 | 222 | 4 | 218 |
| 2027-06 | 92 | 3 | 89 |

## The survey of 2026-10-17

**Current edition** (`--since 2026-07-01`), 44 events and **1,115 lists**, and
the population every verdict below is written against:

| warning | lists | share | per 100 lists |
|---|---:|---:|---:|
| `mismatch` | 115 | 51.3% | 10.3 |
| `disposition` | 48 | 21.4% | 4.3 |
| `missing-total` | 23 | 10.3% | 2.1 |
| `unrecognized` | 21 | 9.4% | 1.9 |
| `detachment` | 17 | 7.6% | 1.5 |

| exporter | lists | warnings | per 100 lists |
|---|---:|---:|---:|
| `app` | 847 | 89 | 10.5 |
| `newrecruit` | 219 | 60 | 27.4 |
| `warorgan` | 19 | 17 | 89.5 |
| `unknown` | 15 | 25 | 166.7 |
| `armylistnetwork` | 13 | 27 | 207.7 |
| `ironbuilt` | 2 | 6 | 300.0 |

The whole archive, for contrast: 262 events, 7,424 lists, 7,176 warnings, of
which **6,290 are the same `disposition` warning on 10th-edition lists** -
87% of the archive's warnings, and 0.9% of the current edition's.

## What each warning means here

### unrecognized - 21 lists the parser cannot read

The worst failure the product has: the card renders an army with nothing in it.
In the current edition the group is small but total, per exporter:

| exporter | lists unread | of that exporter |
|---|---:|---:|
| `armylistnetwork` | 13 | **13 of 13** |
| `unknown` | 5 | 5 of 15 (freeform pastes: `- Name (215pts) (Warlord)`, `Name — 300 pts`) |
| `ironbuilt` | 2 | 2 of 2 |
| `newrecruit` | 1 | 1 of 219 |

**Every armylistnetwork list in the current edition is unreadable**, and the
archive holds 63 more. The parser recognises the tool from its signature and its
shape (`### Détachements :`, `Total : N points - N figurines`) but has no reader
for its unit lines: `Marines Rubricae (10) : 190 pts`, `- gear`, `--- Ligne ---`,
`| attached`. That reader is the single fix that clears this group.

### mismatch - 115, the top warning, and not yet attributed

Half of every current-edition warning, so worth reading carefully. Two things
are known.

- **It is not a wholesale parse failure.** Compare unit-shaped lines in the body
  to units read: `app` 12,838 lines to 12,390 units (96.5%), `newrecruit`
  3,316 to 3,195 (96.4%). Three lists out of 1,094 fall below 60%, and those are
  hard breaks - Pravdaël's Tyranids read 3 units of 14 (the reader stops at the
  first bare `Name [Npts]` line after prefixed ones, so everything under that
  point is lost), 0gier 4 of 17, Septarion 4 of 11.
- **The deltas are small and have no repeated value**: -10 x9, -110 x8, -100 x8,
  -5 x6, -85 x4, -20 x3 - 26 of the 115 are under 30 points and 18 are 30-99. A
  systematic misread would show one delta over and over; these look like
  enhancement points, attached units and the player's own arithmetic.

**Open**: attribute the tail. The three hard breaks are reproducible and fixable
in the newrecruit reader; the small deltas need a per-list diff before anything
is called a defect.

### disposition - 48, all genuinely undeclared (was 10 parser misses)

After the 2026-10-17 fixes (below), **0 of the 48** current-edition warnings have
a disposition in the text the parser failed to read: the lists that carry the
field (1,055 of 1,115) are all read, and the 48 that warn declare nothing. This
is a real signal at 4.3% now, and it was not before: in the whole archive the
same warning fires 6,290 times on lists from an edition that has no such field.

### missing-total - 23

Listed as 135 archive-wide before the label fix; the current-edition remainder is
lists that genuinely print no total and no budget line.

### detachment - 17

Down from 206 archive-wide. The archive residue is mostly app headers printing
`+ DETACHMENT USED :` with nothing after the colon, which is the source leaving
the field empty, not the parser missing a value.

## The 2026-10-17 fixes

Both were driven by this survey, and both are pinned by tests.

- **The total labels that hid 141 lists** (`9d26fdf`): `ARMY POINTS`,
  `POINTS D'ARMÉE TOTAL` and the bare `TOTAL`/`POINTS` were not labels, so an
  army that printed its total under one read as having none. 276 archive-wide
  warnings became 135, and 32 of the 141 surfaced as a real mismatch.
- **The dispositions the parser could not see** (`075d3ee`): four defects, all
  measured against real lists - a `- `-prefixed header key (newrecruit's dashed
  dialect, key landed as `-disposition`), a `+` header with no `+++` fence (or a
  fence too short for the 20-plus delimiter test), `DISPOSITION DE FORCE` missing
  from the alias table, and a disposition declared outside the preamble or under
  a marker the label regex did not allow. 15 lists recovered archive-wide, **all
  10 of the current-edition misses**, with no other number moving: unit counts,
  points and every other warning type are byte-identical before and after.

## The weekly pass

The one thing that cannot be re-fetched is a list whose event has passed and
whose page MHQ later drops, so the pass is: archive what closed, parse what is
open, then look at the warnings *for the current edition*.

```powershell
node src/archive.mjs --plan --months 12   # what a harvest would consider
node src/archive.mjs --months 12          # archive the newly closed events
node src/archive.mjs --verify             # every entry still resolves
node src/scan-open.mjs                    # parse the open events into workspace/weekly/future-parses
node src/warnings.mjs --since <edition start> \\
  --labelled archive=archive/events --labelled future=workspace/weekly/future-parses \\
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
