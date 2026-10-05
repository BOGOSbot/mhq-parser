# Source formats

Which tool wrote each army list, how to tell, and what that means for the
parser. The numbers below come from `node formats.mjs` over the archive: 909
events, **27,830 lists** (2021-10 to 2026-09).

The parser's `player.format` field answers a different question - *which
reader ran* ("bullets" or "newrecruit"). `player.exporter` answers *which tool
wrote the text*. They are not the same, and conflating them is why an app export
and a newrecruit export could both come out as "bullets".

## Headline

| exporter | lists | share | signed by the tool | recognised from shape |
|---|---:|---:|---:|---:|
| `app` | 19,296 | 69.3% | 3,212 | 16,084 |
| `newrecruit` | 4,715 | 16.9% | 89 | 4,626 |
| `legacy` | 2,939 | 10.6% | 0 | 2,939 |
| `unknown` | 598 | 2.1% | 0 | 598 |
| `armylistnetwork` | 236 | 0.8% | 143 | 93 |
| `warorgan` | 41 | 0.1% | 19 | 22 |
| `ironbuilt` | 3 | 0.0% | 2 | 1 |
| `battlebase` | 2 | 0.0% | 2 | 0 |

`newrecruit` and `app` really are the two that matter, but the third largest
group is a historical one. `legacy` is the 9th-edition era (2021-2023): 2,893
of its 2,939 lists are from events dated 2023 or earlier, and 46 are from 2024
onward. It has no dedicated reader - most of its lists parse to zero units - so it is
counted apart rather than dropped into `unknown`.

## The last line is a signature, not a summary

Every tool that signs its output puts the signature on the last line:

| lists | last line |
|---:|---|
| 2,762 | `Exported with App Version: v1.32.1 (78), Data Version: v599` |
| 218 | `Exporté avec la Version de l'Appli : v2.0.1 (122), Version de Données : v875` |
| 207 | `END OF ROSTER` |
| 86 | `Created with newrecruit.eu v35.66` |
| 19 | `Created with WarOrgan (https://warorgan.com)` |
| 2 | `Exported with BattleBase, Data Version: v20251223` |
| 2 | `https://ironbuilt.app/?s=BFV7Ki8g` |
| 143 | `url : https://40k.armylistnetwork.com/liste-…` |

But **only 3,384 of 27,830 lists (12.2%) carry a signature at all**, and 83 more
carry one above later text. MHQ shows the list body, and plenty of exports never
had a signature to begin with - the last line of most lists is a unit entry
(`Char3: 1x Callidus Assassin (100 pts): …`, `3x Nurglings (40 pts): …`).
So the last line is the *strongest* signal when it is there, and absent from
most of the corpus; detection cannot rely on it and does not.

`exporterVersion` records the version when the signature prints one (app
v1.4-v2.7, newrecruit v35.36-v36.31). It is null otherwise.

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
  `Char1: 1x Illuminor Szeras (165 pts): Eldritch lance`. 14,198 lists are
  recognised by this header alone.
- **category dialect** - the list name on a `(N points)` banner, the faction,
  the detachment, `Strike Force (2000 points)`, then `CHARACTERS` /
  `PERSONNAGES` headings over `Hive Tyrant (250 points)` and `• 1x …`
  bullets. 1,886 lists.
- **freeform** - same as the category dialect but with no category headings,
  just the banner and the `Strike Force` budget line. This is the variant the
  developer doc calls the MHQ app's freeform header.

French and English both occur and are recorded in `exporterLanguage`:
18,462 English app lists against 834 French; the banner, the category names and
the signature all flip together.

### newrecruit

[newrecruit.eu](https://www.newrecruit.eu). Bracketed points are the spine:
`Véhicules 1 : Réanimateur Canoptek [105pts]`, or `++ Total: [1,990pts] ++`.
French category codes (`Personnages 1 :`, `Ligne 1 :`, and the abbreviated
`FA 1 :` / `LOW 1 :` / `APO 2 :` set) usually accompany them. 1,408 lists
are English, 3,307 French.

newrecruit can also *re-export* a list that keeps another tool's body: one list
in the corpus carries an app-style `+ FACTION KEYWORD` header and a
`Created with newrecruit.eu` signature. The signature wins, because it names
the tool that produced the final text.

### The smaller ones

- **armylistnetwork** (236) - [40k.armylistnetwork.com](https://40k.armylistnetwork.com),
  French, markdown headings (`### Détachements :`), `QG 1 : … N pts`,
  `- gear`, and a `Total : N points - N figurines - N unités` line. The URL
  trailer is usually present; when it is missing, that total line identifies it.
- **warorgan** (41) - [warorgan.com](https://warorgan.com), all in 2025-2026:
  `Battle Size: Strike Force (2000 point limit)`, `Detachments:`,
  `Force Dispositions:`, `Unit (N points)`.
- **ironbuilt** (3) - [ironbuilt.app](https://ironbuilt.app), the two
  `Unrecognized format` lists the README already names, plus one that parses.
- **battlebase** (2) - `Exported with BattleBase, Data Version: …`. Its body
  shape is the app's category dialect, so only the signature separates them.

## What is left unrecognised

598 lists (2.1%). They are not a hidden app so much as the absence of one:

- 451 lists carry no unit price and no bullets anywhere - freeform notes,
  headers with nothing under them, empty submissions, placeholders, `A faire`,
  even lunch orders. 458 of the 598 parse to fewer than two units.
- 140 lists do parse to two units or more (up to 24) but their maker cannot be
  named: hand-typed rosters, `Player: X` / `Faction Used: Y` headers with a
  `Char1:Hiver Tyrant(260)` body, Kill Team notes.
- 24 of them are Kill Team lists, which are not army lists at all.

## Why the format is worth capturing

The strategy is currently chosen from the body (`hasNewRecruit`), which is a
guess: a newrecruit export with `•` bullets and `[Npts]` falls through to
the bullet reader, and 194 newrecruit lists do exactly that. The exporter turns
that guess into a fact:

- `app` header lists are the only ones with `Char1: 1x … (N pts):` lines.
- `app` category lists are the only ones with ALL-CAPS category headings over
  `Unit (N points)`.
- `newrecruit` lists are the only ones with `[Npts]` as the unit price.
- `legacy` is the one family with no reader, and now has a name to attach one
  to.

A reader can therefore be selected per exporter instead of per body sniff, and a
list whose exporter is known but whose parse fails becomes a bug report against
a named format rather than a generic "Unrecognized format".

The archived files on disk predate the field and are not rewritten - 160 MB of
one-line JSON would turn every harvest into a full-file diff. `archive.readEvent()`
detects the exporter from the stored body text when an event is opened, so the
site shows it for old and new events alike, and `formats.mjs` recomputes it for
the whole corpus.
