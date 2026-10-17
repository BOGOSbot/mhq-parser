# Parser warnings

Which warnings the parser emits, how often, and which repeats are the parser's
fault. [src/warnings.mjs](../src/warnings.mjs) is the survey:

```powershell
node src/warnings.mjs                      # the archive: archive/events
node src/warnings.mjs --dir <dir>          # any directory of parse outputs, repeatable
node src/warnings.mjs --labelled future=workspace/weekly/future-parses
node src/warnings.mjs --json <file>        # every warning as one JSON record
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

## The survey of 2026-10-17

258 archived events and 7,297 lists, plus the four upcoming events whose lists
are already out (see *The weekly pass* below).

| warning | lists | share | per 100 lists |
|---|---:|---:|---:|
| `disposition` | 6,301 | 86.4% | 86.4 |
| `mismatch` | 412 | 5.7% | 5.6 |
| `detachment` | 206 | 2.9% | 2.8 |
| `missing-total` | 135 | 1.9% | 1.9 |
| `unrecognized` | 129 | 1.8% | 1.8 |

| exporter | lists | warnings | per 100 lists |
|---|---:|---:|---:|
| `app` | 6,520 | 6,232 | 95.6 |
| `newrecruit` | 571 | 505 | 88.4 |
| `unknown` | 89 | 202 | 227.0 |
| `armylistnetwork` | 65 | 151 | 232.3 |
| `warorgan` | 41 | 61 | 148.8 |
| `legacy` | 8 | 24 | 300.0 |

## What each warning means here

### disposition - the format does not carry the field

6,301 lists warn `force disposition not found`, and **99.8% of them declare no
disposition at all**: a scan of every one finds only 11 whose text names a
disposition the parser failed to read. The MHQ page itself confirms it - the
army-lists page of *Open PACA Édition 2* (109 lists, all archived) contains the
string "disposition" zero times, in the accordion headers and in every list
body. The app's own `+++` header carries `FACTION KEYWORD`, `DETACHMENT`,
`TOTAL ARMY POINTS`, `WARLORD`, `ENHANCEMENT`, `NUMBER OF UNITS` and
`SECONDARY` - and no disposition field.

So the warning is accurate about the absence and wrong about it being a defect.
At 86% of all warnings it is also the thing that makes the other warnings hard to
see: a list with one real problem shows two warnings. **Open decision**: warn
only when the source can carry the field, or reword it as a neutral "not
declared". Nothing is changed yet because it is a product call, not a parser
one.

### unrecognized - 129 lists the parser cannot read

The worst failure the product has: the card renders an army with nothing in it.

| exporter | lists | shape |
|---|---:|---|
| `armylistnetwork` | 63 of 65 | signature recognised, unit text not: `Marines Rubricae (10) : 190 pts`, `| Attached`, `--- Catégorie ---` |
| `unknown` | 37 of 89 | freeform pastes with no marker family: `- Name (215pts) (Warlord)` |
| `app` | 17 of 6,520 | two dialects the app does not print today: `Character 1 : Blade Champion (120), Vaultswords [120]` and `Unit 1 - [WARLORD] Knight Castellan [420pts] - weapons` |
| `legacy` | 6 of 8 | 9th-edition exports, out of the window by design |
| `newrecruit` | 4 of 571 | - |
| `ironbuilt` | 2 of 2 | - |

`armylistnetwork` is the largest single gap and the only one where the exporter
identifies itself: the parser knows the tool and not the list. A reader for its
unit shape is the one fix that would clear most of this group.

### missing-total - 141 of 276 were false (fixed)

`+ ARMY POINTS: 2000 pts`, `POINTS D'ARMÉE TOTAL : 1995pts` and
armylistnetwork's footer `Total : 2000 points - 53 figurines` named a total
under a label the parser did not list, so the army read as having none. The
labels are in `TOTAL_LABELS` and `HEADER_ALIAS` now: 276 warnings became 135,
and 32 of the 141 reappeared as a real `mismatch` - the declaration was there
all along, and the parser could not see it. Pinned by `tests/test-list-text.mjs`.

### mismatch - 412 lists whose declared total disagrees with the sum

Four in five are small (≤100 points) and the rest are real disagreements. Two
shapes are worth keeping apart:

- **The parser's own gap, not the player's**: a list that did not parse
  (`unrecognized`) counts 0 points against a declared total, which reads as a
  2,000-point mismatch. 21 of the 412 are this. Fixing `unrecognized` fixes
  them; they are not a separate defect.
- **Points that a unit line does not carry**: enhancement costs, attached
  units, and the `(N)` suffix newrecruit prints after a category header. These
  are the player's or the format's arithmetic, and the delta distribution has no
  repeated value that would betray a systematic misread.

### detachment - 206, mostly the field left empty

116 are app lists whose own header prints `+ DETACHMENT USED :` with nothing
after the colon, or carries no detachment line at all: the source has no value to
find. Only 10 of the 206 name a detachment the parser failed to read, and 9 of
those are the `unrecognized` lists above.

## The weekly pass

The one thing that cannot be re-fetched is a list whose event has passed and
whose page MHQ later drops, so the pass is: archive what closed, parse what is
open, then look at the warnings.

```powershell
node src/archive.mjs --plan --months 12   # what a harvest would consider
node src/archive.mjs --months 12          # archive the newly closed events
node src/archive.mjs --verify             # every entry still resolves
node src/warnings.mjs --json workspace/weekly/warnings-<date>.json
```

An upcoming event is parsed fresh each week rather than archived - its lists are
still being submitted, which is why `/parse` declines the cache for one
(`notYetPlayed()`). 2026-10-17: of 133 not-closed events, 4 had lists out
(*LTC 12* and three *League Wars 2026-2027* fixtures); the other 120 had not
published, and 9 were another game. Their parses live in
`workspace/weekly/future-parses/`, untracked like the rest of `workspace/`.
