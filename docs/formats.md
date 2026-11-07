# Source formats

*The source formats the parser accepts, and the JSON it writes.*
Which tool wrote each army list, how to tell, and what that means for the
parser. The numbers below come from `node src/formats.mjs` over the archive:
**52 events and 1,234 lists**, 2026-06-21 to 2026-10-31. The archive keeps a
year, but the edition cut of 2026-10-17 dropped every event that plays the older
edition, so what is left is one edition about four months wide. A list from an
older edition characterises nothing the parser has to be right about, and
`--months 0` widens the harvest back to all time.

The parser's `player.format` field answers a different question - *which
reader ran* ("bullets" or "newrecruit"). `player.exporter` answers *which tool
wrote the text*. They are not the same, and conflating them is why an app export
and a newrecruit export could both come out as "bullets".

## Headline

| exporter | lists | share | signed by the tool | recognised from shape |
|---|---:|---:|---:|---:|
| `app` | 931 | 75.4% | 565 | 366 |
| `newrecruit` | 246 | 19.9% | 149 | 97 |
| `armylistnetwork` | 21 | 1.7% | 14 | 7 |
| `warorgan` | 19 | 1.5% | 8 | 11 |
| `unknown` | 15 | 1.2% | 0 | 15 |
| `ironbuilt` | 2 | 0.2% | 2 | 0 |

`newrecruit` and `app` really are the two that matter, and `app` alone is three
lists in four. `legacy` - the 9th-edition era - and `battlebase` are not in the
window at all now: the edition cut removed the exports written for the older
rules, and nothing the site serves is written that way any more.

## The last line is a signature, not a summary

Every tool that signs its output puts the signature on the last line:

| lists | last line | versions seen |
|---:|---|---|
| 253 | `Exported with App Version: v2.0.2 (125), Data Version: v879` | v1.53.0-v2.8.1 |
| 309 | `Exporté avec la Version de l'Appli : v2.0.1 (122), Version de Données : v875` | v2.0.0-v2.8.1 |
| 125 | `Created with newrecruit.eu v36.36` | v35.36-v37.5 |
| 23 | `Exported with New Recruit v36.38, Data Version: v5` | v36.30-v37.6 |
| 14 | `url : https://40k.armylistnetwork.com/liste-…` | |
| 8 | `Created with WarOrgan (https://warorgan.com)` | |
| 2 | `https://ironbuilt.app/?s=…` | |
| 1 | `End of roster` | |

The version column is a range because every list prints its own: the table groups
the *shape* of the signature, not the literal line. `formats.mjs` prints the
same range, and reports one row per shape for that reason.

**738 of 1,234 lists (59.8%) carry a signature at all**, and 5 more carry one
above later text. The other 496 print none - MHQ shows the list body, and plenty
of exports never had a trailer to begin with. So the last line is the
*strongest* signal when it is there, and absent from 40% of the corpus;
detection cannot rely on it and does not.

MHQ sometimes garbles the tail of the trailer as it serves the page:
`Version de Données : v931Données : v925`, `Data Version: v931u`. Two lists
carry that today. Detection matches the labelled prefix, so a garbled tail costs
the version's last digit and nothing else.

`exporterVersion` records the version when the signature prints one (app
v1.53.0-v2.8.1, newrecruit v35.36-v37.6). It is null otherwise.

## Recognising each format

`detectExporter()` in [parse.mjs](./parse.mjs) checks signatures first, newest
tool first, then falls back to the shape only one dialect produces. The
`basis` says which fired: `trailer`, `signature`, or the structural rule's
name.

| exporter | signature | shape |
|---|---|---|
| `app` | `Exported with App Version:`, `Exporté avec la Version de l'Appli :`, `END OF ROSTER` | `+ FACTION KEYWORD:` / `+ TOTAL ARMY POINTS:` header, or `Char1: 1x … (N pts):` unit lines, or ALL-CAPS category headings over `Unit (N points)`, or the freeform `Strike Force (2000 points)` budget line; the header dialect also prints an `ATTACHED UNITS` section whose `Attached Unit N (N points)` lines are group totals |
| `newrecruit` | `Created with newrecruit.eu`, `Exported with New Recruit`, a `newrecruit.eu/app/list` URL | bracketed points - `[Npts]` - which is newrecruit's spine |
| `legacy` | none | `== DETACHEMENT … ==`, `QG 1 :`, `[8PP, 175pts]`, `++ Patrol Detachment 0CP …` |
| `armylistnetwork` | `url : https://40k.armylistnetwork.com/…` | `### Détachements :`, a `Total : N points - N figurines - N unités` line |
| `warorgan` | `Created with WarOrgan` | `Battle Size:`, `Detachments:` + `Force Dispositions:` |
| `battlebase` | `Exported with BattleBase` | (shares the app's category shape; signature only) |
| `ironbuilt` | `https://ironbuilt.app/?s=…` | `+====` rules, `── CATEGORY ──`, `Weapons:` |
| `mhq` | `Liste générée par MiniHeadQuarters` | none known yet (signature only) |
| `league` | none, and no tool to name | three or more of `List Name:`, `Factions Used:`, `Army Points:`, `Army Enhancements`, `Detachment(s):`, `Disposition:` at a line start |

### app

The official Warhammer 40,000 app (Battle Forge), in three shapes:

- **header dialect** - a `+++` block carrying `FACTION KEYWORD`,
  `DETACHMENT`, `TOTAL ARMY POINTS`, then units as
  `Char1: 1x Illuminor Szeras (165 pts): Eldritch lance`. 191 lists are
  recognised by this header alone.
- **category dialect** - the list name on a `(N points)` banner, the faction,
  the detachment, `Strike Force (2000 points)`, then `CHARACTERS` /
  `PERSONNAGES` headings over `Hive Tyrant (250 points)` and `• 1x …`
  bullets. 175 lists.
- **freeform** - same as the category dialect but with no category headings,
  just the banner, the faction and the `Strike Force` budget line.

The header dialect also groups attached units, and prints the group's total on
its own line:

```
ATTACHED UNITS
Attached Unit 1 (200 points)
Warboss (115 points)
* Attached as: Leader
• 1x Power Klaw
Boyz (85 points)
* Attached as: Bodyguard (Battleline)
```

`Attached Unit 1 (200 points)` is the group, and 115 + 85 is what it holds.
Read as a unit it counts the group twice, which is a 200-to-900 point
over-count on every list carrying one. The older category dialect prints the
same label with no points - `Attached unit 1` - and that was never a unit.
[parse.mjs](./parse.mjs) skips the header and keeps the members; the measurement
is in [warnings.md](./warnings.md).

French and English both occur and are recorded in `exporterLanguage`: 533
English app lists against 398 French; the banner, the category names and the
signature all flip together.

### newrecruit

[newrecruit.eu](https://www.newrecruit.eu). Bracketed points are the spine:
`Véhicules 1 : Réanimateur Canoptek [105pts]`, or `++ Total: [1,990pts] ++`.
French category codes (`Personnages 1 :`, `Ligne 1 :`, and the abbreviated
`FA 1 :` / `LOW 1 :` / `APO 2 :` set) usually accompany them. 94 lists are
French, 152 English.

newrecruit can also *re-export* a list that keeps another tool's body: one list
in the corpus carries an app-style `+ FACTION KEYWORD` header and a
`Created with newrecruit.eu` signature. The signature wins, because it names
the tool that produced the final text.

### The smaller ones

- **armylistnetwork** (21) - [40k.armylistnetwork.com](https://40k.armylistnetwork.com),
  French, markdown headings (`### Détachements :`), `QG 1 : … N pts`,
  `- gear`, and a `Total : N points - N figurines - N unités` line. The URL
  trailer is usually present; when it is missing, that total line identifies it.
- **warorgan** (19) - [warorgan.com](https://warorgan.com), all in 2026:
  `Battle Size: Strike Force (2000 point limit)`, `Detachments:`,
  `Force Dispositions:`, `Unit (N points)`.
- **legacy** (0 in the window) - 9th-edition-era exports. The edition cut took
  them out; the rule still exists so an old list is named rather than guessed at.
- **ironbuilt** (2) - [ironbuilt.app](https://ironbuilt.app), the
  `Unrecognized format` lists the README names.
- **battlebase** (0 in the window) - `Exported with BattleBase, Data Version: …`.
  Its body shape is the app's category dialect, so only the signature separates
  them; the one list that carried it is outside the window.
- **league** (1 list, in the open fixtures and none in the archive yet) - not a
  tool. It is the registration header a team league asks its players to paste
  above whatever their builder exports, and `League Wars 2026-2027` is the
  league using it: `List Name`, `Factions Used`, `Army Points`,
  `Army Enhancements (list on which model)`, `Disposition`, `Detachment(s)`.
  It is recognised on three of those fields together, before the body's shape,
  because the wrapper is what names the submission. A signed export under it
  keeps its own name - a signature is proof where the wrapper is only a form.

## What is left unrecognised

15 lists (1.2%). Two are empty submissions, one holds a single unit and one
holds two. The other eleven are ordinary armies of 4 to 19 units that no tool
signs and no shape names: freeform submissions, hand-typed exports and one
markdown-flavoured paste. They parse; what is missing is the maker, not the
list.

The one shape here that did have a name to find is the league submission, and
it is now named (below). It shows up in the open fixtures rather than the
archive, so the count above has not moved: one list in `League Wars
2026-2027` carries it today.

## What the parser reads out of each format

Beyond the units, each format declares metadata in its own way, and the parser
used to miss most of it. In the current window the detachment is missing from
**19 lists (1.5%)** and the force disposition from **57 (4.6%)** - 1,177 lists,
95.4%, declare one, because the archive now holds one edition and that edition
has the field. Of the lists that declare a detachment or a disposition, all but
a handful are read. Detachments come from:

- `== DETACHEMENT Bataillon : Tyranids [2000pts] ==` (the newrecruit and
  legacy lists name their detachment this way),
- `Détachement : X`, `DÉTACHEMENT USED : X`, `Detachement Rule: X`,
  `Règle de détachement : X`, `+ ARMY DETACHMENT : X`, and the league
  template's `Detachment(s): X`,
- `### Détachements :` with the values on the lines under it
  (armylistnetwork),
- the freeform app header, where the detachment is the bare line next to
  `Strike Force (2000 points)` - on either side of it, with the faction line
  and the category headers as the exclusions,
- and, when a player writes the metadata *under* the units, a whole-text scan.

Dispositions come from `Dispositions des Forces : Éliminez l'Adversaire`,
`Force Dispositions: Purge the Foe`, `=> Disposition : Prendre et tenir`,
`DISPOSITION FORCE : PURGE THE FOE`, and the bare names the freeform header
prints on their own line.

Labels are not values either. A detachment that arrives as
`• Detachments: Lions of the Emperor (3 Detachement Points)` - a bullet, the
label, the points it costs, and "Detachement" with the second t missing - is
read as `Lions of the Emperor`: the label and the points are stripped, in
either bracket, with or without the typo.

## Why the format is worth capturing

The strategy is chosen from the body (`hasNewRecruit`), which is a guess: a
newrecruit export with `•` bullets and `[Npts]` falls through to the bullet
reader, and 154 of the 246 newrecruit lists are read that way today. The
exporter turns that guess into a fact:

- `app` header lists are the only ones with `Char1: 1x … (N pts):` lines.
- `app` category lists are the only ones with ALL-CAPS category headings over
  `Unit (N points)`.
- `newrecruit` lists are the only ones with `[Npts]` as the unit price.
- The metadata each one declares - detachment, disposition - is written
  differently in each, which is what "What the parser reads out of each
  format" above is about.

A reader can therefore be selected per exporter instead of per body sniff, and a
list whose exporter is known but whose parse fails becomes a bug report against
a named format rather than a generic "Unrecognized format".

The archived files on disk are not rewritten - every harvest would become a
full-file diff. `archive.readEvent()` detects the exporter from the stored body
text when an event is opened, so the site shows it for old and new events alike,
and `formats.mjs` recomputes it for the whole corpus.
