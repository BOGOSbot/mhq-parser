# Move the faction half onto the MFM

*The corpus reads Games Workshop's Munitorum Field Manual dump instead of the Wahapedia CSV, and the CSV is kept as the rollback.*

- **State:** in progress
- **Priority:** P1
- **Owner:** me

## Where it stands

Landed: `src/mfm-factions.mjs` builds datasheets, unit rules, stratagems, detachments, enhancements, army rules and the core stratagems from the dump; `buildFactionSections()` delegates to it and keeps the CSV path whole behind `MHQ_FACTIONS_SOURCE=csv`. The plan no longer mints faction rules from `Abilities.csv` when the dump supplies them. Measured on data_version 995: 4,778 corpus records, 5,646 wiki records, 5,666 delivered and 5,999 shaped nodes, with 52 army rules instead of 129, no duplicate titles, and zero Legends records.

## Next action

Run `--ingest` then `--prune`, then confirm /health reads behind: [] and ahead: []. The shaped corpus was rebuilt after the migration, the vector index was not.

## Notes for a fresh session

`docs/mfm-source.md` carries the endpoint, the refresh recipe, the record shape and what the dump does not have. The four slices it opened are listed there: missions from the dump instead of the scraped event companion, wargear options and choice groups, conditional keywords and FAQs, and the French locale.

The old corpus is one environment variable away, and the CSV download still runs because `wiki-plan` reads `Factions.csv` for display names. Do not drop the download until that read moves to the dump.
