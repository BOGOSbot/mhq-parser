# The faction half now comes from the MFM

_The corpus reads Games Workshop's own Munitorum Field Manual export instead of the Wahapedia CSV. Core rules are still scraped; everything faction-shaped is not._

## The source

```
https://pub-6443f136c6fc4c60a15cc7935463d637.r2.dev/dump.json
```

It is the relational export the official app at https://mfm.warhammer-community.com/en renders from: 36.7 MB, 131 tables, eight locales, `metadata.data_version` as the stamp. The snapshot on disk is `workspace/rules-corpus/mfm-dump.json` (gitignored); `MFM_DUMP` points elsewhere.

Refresh: download the dump to that path, then `node src/rules-corpus.mjs --scrape --set factions --cached`, `node src/wiki-payload.mjs`, then the prototype's `build-corpus.mjs` and `shape.mjs`.

## Why

The CSV is a community mirror of the same data and every defect in it had to be patched by hand after the fact: the `legend` column carried lore prose on 1,121 rows instead of a Legends flag, 144 rows were copies of another faction's datasheet filed under an ally, and `Datasheets_models_cost` mixed header rows, unit prices and wargear option prices in one column. The dump has none of those problems by construction: `isLegends` is a boolean, a datasheet belongs to its faction by id, and a price is one row per size tier.

## The seam

`src/mfm-factions.mjs` turns the dump into the same section shape the CSV builder has always emitted, so the wiki build, the plan and every surface downstream of them are unchanged. `buildFactionSections()` in `src/rules-corpus.mjs` delegates to it.

Two switches, both for rollback:

- `MHQ_FACTIONS_SOURCE=csv` builds the old corpus from the CSV. A tree with no dump on disk falls back the same way.
- `MFM_DUMP` points at another snapshot.

The corpus file names still read `factions-csv.json` and `core-stratagems.json`: they are keys, not claims, and renaming them is a separate slice because `readCorpus` calls them by name in several modules.

## What it emits

| kind | sections | text |
|---|---:|---|
| datasheet | 1,126 | statline with invulnerable save, base size, composition, every weapon profile with its abilities, one points row per size tier, damaged bracket |
| unitrules | 1,126 | keywords, then every ability with its official rules text |
| stratagem | 1,281 | type, CP, turn and phase, WHEN / TARGET / EFFECT / RESTRICTIONS |
| detachment | 282 | detachment points, force disposition, the rule body with its sections |
| enhancement | 869 | cost, detachment, the restriction and the rule |
| faction-rule | 52 | army rules with their full body |
| core stratagem | 11 | the shared stratagems, filed in the rules namespace |

47 Legends datasheets are dropped at the source, which is the tournament rule enforced by a boolean instead of a column that lied.

## What it forced

- `noCsvFactionRules`: the plan used to mint a faction rule per row of `Abilities.csv`. With the dump carrying the army rules itself, that mint doubled every rule (5,717 records); switched off it is 52 rules and 5,646 records.
- `snippetOf` in `wiki-payload.mjs`: the row summary was a 100-character slice, so a card's lede read 'Codex: Adeptus Custodes (e'. It now drops the heading echo and the Source line and cuts on a word end.

## Still open

- Missions still come from the scraped event companion. The dump has 51 primary missions and 18 secondary with their scoring, which is better and is the next slice.
- Wargear options and choice groups are not emitted: only the base loadout is. `wargear_option`, `loadout_choice_set` and `limited_wargear_choice_set` hold the rest.
- Conditional keywords (345 rows) and FAQs (675) are untouched.
- The French locale is in the dump and unused. It answers `tasks/french-overlay.md` better than a translated overlay does.
- The vector index is now stale: `--ingest` and `--prune` are owed before the next deploy.
