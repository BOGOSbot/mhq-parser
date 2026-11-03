# The faction half now comes from the MFM

_The corpus reads Games Workshop's own Munitorum Field Manual export instead of the Wahapedia CSV. Core rules are still scraped; everything faction-shaped is not._

## The source

```
https://pub-6443f136c6fc4c60a15cc7935463d637.r2.dev/dump.json
```

It is the relational export the official app at https://mfm.warhammer-community.com/en renders from: 36.7 MB, 131 tables, eight locales, `metadata.data_version` as the stamp. The snapshot on disk is `workspace/rules-corpus/mfm-dump.json` (gitignored); `MFM_DUMP` points elsewhere.

Refresh: `node src/rules-corpus.mjs --update` does the first two steps when gdmissions.app lists a newer data version ([gdm-canon.md](gdm-canon.md)). By hand: download the dump to that path, then `node src/rules-corpus.mjs --scrape --set factions --cached`, `node src/wiki-payload.mjs`, then the prototype's `build-corpus.mjs` and `shape.mjs`.

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
| datasheet | 1,126 | statline with invulnerable save, base size, composition, every weapon profile the unit can field (default loadout first, then each optional weapon) with its abilities, one `Option:` line per printed wargear option, one points row per size tier, damaged bracket |
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
## Wargear options (2026-10-28)

A datasheet used to carry its default loadout only, so a balance change to an optional weapon could not reach the corpus: data version 995 changed the Death Company Captain's Power Fist (A 3 to 6, WS 3+ to 2+), and the Power Fist is an option. Now:

- **Weapons.** Every item the unit can field gets its `Wargear <name> (<Melee|Ranged>): ...` line, the same line the CSV corpus wrote. The default loadout (`base_miniature_loadout`) comes first, then the items the option groups (`wargear_option_group` / `wargear_option`) and the three choice tables (`loadout_choice_*`, `limited_wargear_choice_*`, `all_model_wargear_choice_*`) can add, in card order. A multi-profile weapon names each profile (`Heavy missile launcher - krak`).
- **Options.** One `Option: ...` line per printed option, from `wargear_rule` (the card's own text), bullets flattened. The 7 datasheets with option groups and no printed rule fall back to the groups' instruction text; a `Default Wargear` group is the loadout, never an option.

Measured on 995: 2,634 default and 2,343 optional profiles, 1,312 option lines. 68 kill-team-sized cards now overrun `MAX_CHARS` and split, as they did under the CSV: 4,979 corpus sections, 5,777 delivered, 137 faction index pages. Test: `tests/test-mfm-wargear-options.mjs`.
- Conditional keywords (345 rows) and FAQs (675) are untouched.
- The French locale is in the dump and unused. It answers `tasks/french-overlay.md` better than a translated overlay does.
- The vector index is now stale: `--ingest` and `--prune` are owed before the next deploy.

## Mission card reverses (2026-11-03)

Eleven primary cards print an action on their reverse ('committed sabotage ... (see reverse)'), and the scoring on the front means nothing without it. The dump holds them in `primary_mission_action` (and `secondary_mission_action` for Cleanse and Plunder), keyed by mission: name, starts, units, use limit, completes, effect, restrictions. `src/mfm-missions.mjs` now appends each one to its card's text:

```
Action: SABOTAGE
Starts: Your Shooting phase.
Units: One unit within range of one objective (excluding your home objective).
...
```

A restriction of `None` is not printed. Measured on 995: 13 of the 43 cards carry an action (11 primary, 2 secondary); the Combat Patrol pack's actions stay out with the rest of that pack.

The faces: gdmissions.app serves each of those eleven reverses beside its front as `<slug>-back.png`. They are in the private cache under `workspace/rules-corpus/assets/missions/primary/<deck>/`, listed in `sources.json` with `role: "back"` (73 entries). The search index still needs `--ingest` for the new text.
