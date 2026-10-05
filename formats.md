# Source formats

Which tool wrote each army list, how to tell, and what that means for the
parser. The numbers below come from `node formats.mjs` over the archive: the
**last year** of closed events, **252 events and 7,128 lists** (2025-10 to
2026-10). That is the window the archive keeps - a list from an older edition
characterises nothing the parser has to be right about - and `--months 0`
widens it back to all time.

The parser's `player.format` field answers a different question - *which
reader ran* ("bullets" or "newrecruit"). `player.exporter` answers *which tool
wrote the text*. They are not the same, and conflating them is why an app export
and a newrecruit export could both come out as "bullets".

## Headline

| exporter | lists | share | signed by the tool | recognised from shape |
|---|---:|---:|---:|---:|
| `app` | 6,396 | 89.7% | 1,154 | 5,242 |
| `newrecruit` | 534 | 7.5% | 89 | 445 |
| `unknown` | 86 | 1.2% | 0 | 86 |
| `armylistnetwork` | 64 | 0.9% | 39 | 25 |
| `warorgan` | 37 | 0.5% | 17 | 20 |
| `legacy` | 8 | 0.1% | 0 | 8 |
| `ironbuilt` | 2 | 0.0% | 2 | 0 |
| `battlebase` | 1 | 0.0% | 1 | 0 |

`newrecruit` and `app` really are the two that matter, and `app` alone is nine
lists in ten. `legacy` - the 9th-edition era - is now eight stray lists rather
than the third-largest group it used to be: the one-year window drops the
2021-2023 exports, and nothing the site serves any more is written that way.

## The last line is a signature, not a summary

Every tool that signs its output puts the signature on the last line:

| lists | last line |
|---:|---|
| 895 | `Exported with App Version: v1.51.1 (117), Data Version: v767` |
| 218 | `Exporté avec la Version de l'Appli : v2.0.1 (122), Version de Données : v875` |
| 86 | `Created with newrecruit.eu v35.66` |
| 32 | `END OF ROSTER` |
| 17 | `Created with WarOrgan (https://warorgan.com)` |
| 1 | `Exported with BattleBase, Data Version: v20251223` |
| 2 | `https://ironbuilt.app/?s=…` |
| 39 | `url : https://40k.armylistnetwork.com/liste-…` |

But **only 1,302 of 7,128 lists (18.3%) carry a signature at all**, and 24 more
carry one above later text. MHQ shows the list body, and plenty of exports never
had a signature to begin with - the last line of most lists is a unit entry
(`Char3: 1x Callidus Assassin (100 pts): …`, `3x Nurglings (40 pts): …`). So
the last line is the *strongest* signal when it is there, and absent from most
of the corpus; detection cannot rely on it and does not.

`exporterVersion` records the version when the signature prints one (app
v1.22-v2.7.1, newrecruit v35.36-v36.4). It is null otherwise.

## Recognising each format

`detectExporter()` in [parse.mjs](./parse.mjs) checks signatures first, newest
tool first, then falls back to the shape only one dialect produces. The
`basis` says which fired: `trailer`, `signature`, or the structural rule's
name.

| exporter | signature | shape |
|---|---|---|
| `app` | `Exported with App Version:`, `Exporté avec la Version de l'Appli :`, `END OF ROSTER` | `+ FACTION KEYWORD:` / `+ TOTAL ARMY POINTS:` header, or `Char1: 1x … (N pts):` unit lines, or ALL-CAPS category headings over `Unit (N points)`, or the freeform `Strike Force (2000 points)` budget line |
| `newrecruit` | `Created with newrecruit.eu`, `Exported with New Recruit`, a `newrecruit.eu/app/list` URL | bracketed points - `[Npts]` - which is newrecruit's spine |
| `legacy` | none | `== DETACHEMENT … ==`, `QG 1 :`, `[8PP, 175pts]`, `++ Patrol Detachment 0CP …` |
| `armylistnetwork` | `url : https://40k.armylistnetwork.com/…` | `### Détachements :`, a `Total : N points - N figurines - N unités` line |
| `warorgan` | `Created with WarOrgan` | `Battle Size:`, `Detachments:` + `Force Dispositions:` |
| `battlebase` | `Exported with BattleBase` | (shares the app's category shape; signature only) |
| `ironbuilt` | `https://ironbuilt.app/?s=…` | `+====` rules, `── CATEGORY ──`, `Weapons:` |

### app

The official Warhammer 40,000 app (Battle Forge), in three shapes:

- **header dialect** - a `+++` block carrying `FACTION KEYWORD`,
  `DETACHMENT`, `TOTAL ARMY POINTS`, then units as
  `Char1: 1x Illuminor Szeras (165 pts): Eldritch lance`. 4,800 lists are
  recognised by this header alone.
- **category dialect** - the list name on a `(N points)` banner, the faction,
  the detachment, `Strike Force (2000 points)`, then `CHARACTERS` /
  `PERSONNAGES` headings over `Hive Tyrant (250 points)` and `• 1x …`
  bullets. 442 lists.
- **freeform** - same as the category dialect but with no category headings,
  just the banner, the faction and the `Strike Force` budget line.

French and English both occur and are recorded in `exporterLanguage`: 5,963
English app lists against 433 French; the banner, the category names and the
signature all flip together.

### newrecruit

[newrecruit.eu](https://www.newrecruit.eu). Bracketed points are the spine:
`Véhicules 1 : Réanimateur Canoptek [105pts]`, or `++ Total: [1,990pts] ++`.
French category codes (`Personnages 1 :`, `Ligne 1 :`, and the abbreviated
`FA 1 :` / `LOW 1 :` / `APO 2 :` set) usually accompany them. 430 lists are
French, 104 English.

newrecruit can also *re-export* a list that keeps another tool's body: one list
in the corpus carries an app-style `+ FACTION KEYWORD` header and a
`Created with newrecruit.eu` signature. The signature wins, because it names
the tool that produced the final text.

### The smaller ones

- **armylistnetwork** (64) - [40k.armylistnetwork.com](https://40k.armylistnetwork.com),
  French, markdown headings (`### Détachements :`), `QG 1 : … N pts`,
  `- gear`, and a `Total : N points - N figurines - N unités` line. The URL
  trailer is usually present; when it is missing, that total line identifies it.
- **warorgan** (37) - [warorgan.com](https://warorgan.com), all in 2025-2026:
  `Battle Size: Strike Force (2000 point limit)`, `Detachments:`,
  `Force Dispositions:`, `Unit (N points)`.
- **legacy** (8) - 9th-edition-era exports; four in 2025, four in 2026. No
  reader, and not worth one.
- **ironbuilt** (2) - [ironbuilt.app](https://ironbuilt.app), the
  `Unrecognized format` lists the README names.
- **battlebase** (1) - `Exported with BattleBase, Data Version: …`. Its body
  shape is the app's category dialect, so only the signature separates them.

## What is left unrecognised

86 lists (1.2%). They are not a hidden app so much as the absence of one:
freeform notes, placeholders, empty submissions, and a handful of lists whose
maker cannot be named. Six carry no body at all.

## What the parser reads out of each format

Beyond the units, each format declares metadata in its own way, and the parser
used to miss most of it. The detachment and the force disposition are now read
from every shape the corpus uses:

| | before | after |
|---|---:|---:|
| detachment missing | 1,036 (14.5%) | 196 (2.8%) |
| force disposition missing | 6,513 (91.4%) | 6,288 (88.3%) |

The disposition barely moves because most lists simply do not declare one - the
app's category export never prints it. Of the lists that do, all but a handful
are now read. Detachments come from:

- `== DETACHEMENT Bataillon : Tyranids [2000pts] ==` (the newrecruit and
  legacy lists name their detachment this way),
- `Détachement : X`, `DÉTACHEMENT USED : X`, `Detachement Rule: X`,
  `Règle de détachement : X`, `+ ARMY DETACHMENT : X`,
- `### Détachements :` with the values on the lines under it
  (armylistnetwork),
- the freeform app header, where the detachment is the bare line next to
  `Strike Force (2000 points)` - on either side of it, with the faction line
  and the category headers as the exclusions,
- and, when a player writes the metadata *under* the units, a whole-text scan.

Dispositions come from `Dispositions des Forces : Éliminez l'Adversaire`,
`Force Dispositions: Purge the Foe`, `=> Disposition : Prendre et tenir`, and
the bare names the freeform header prints on their own line.

## Why the format is worth capturing

The strategy is chosen from the body (`hasNewRecruit`), which is a guess: a
newrecruit export with `•` bullets and `[Npts]` falls through to the bullet
reader, and 194 newrecruit lists do exactly that. The exporter turns that guess
into a fact:

- `app` header lists are the only ones with `Char1: 1x … (N pts):` lines.
- `app` category lists are the only ones with ALL-CAPS category headings over
  `Unit (N points)`.
- `newrecruit` lists are the only ones with `[Npts]` as the unit price.
- The metadata each one declares - detachment, disposition - is written
  differently in each, which is what the table above is about.

A reader can therefore be selected per exporter instead of per body sniff, and a
list whose exporter is known but whose parse fails becomes a bug report against
a named format rather than a generic "Unrecognized format".

The archived files on disk are not rewritten - every harvest would become a
full-file diff. `archive.readEvent()` detects the exporter from the stored body
text when an event is opened, so the site shows it for old and new events alike,
and `formats.mjs` recomputes it for the whole corpus.
