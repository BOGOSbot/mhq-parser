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
## Known red after the swap

The corpus, the payload and the shaped tree are verified. Four test files still assert the CSV corpus and need re-baselining, each for a stated reason:

- `tests/test-corpus-drift.mjs` - the shape baseline is a stored count and byte size (6,483 / 9,648,445). The build now emits 4,972 / 6,100,122. Update the two numbers and the comment that explains them.
- `tests/test-index-delivered.mjs` - delivered 5,666 and filtered 134 replace 6,171 / 1,237, and the kept id `datasheet#000000958~1` no longer exists because ids are dump UUIDs now. Pick the ids from the corpus instead of hardcoding them.
- `tests/test-editions.mjs` - asserts the Aeldari Seer Council record and `faction-rule#000008445`. Under the dump the army rules are named per rule, not per CSV ability id.
- `tests/test-record-shapes.mjs` - classifies the 21 core ability records and counts 12 mid-line rows and 13 cards; the corpus census moved. Recount, then check the classifier still finds the families it names.

Until these are green the branch is not mergeable, and the ingest row reports `vanishedPlanned: 5263` - the index holds 5,263 ids the new corpus no longer has, which is why the re-ingest is P1 rather than housekeeping.
## Update 2026-10-26, second pass

Re-baselined and green: `test-corpus-drift`, `test-index-delivered`, `test-editions`, `test-record-shapes` (10 / 18 / 35 / 11 assertions). The Census-style assertions are now invariants where possible: a source swap may add records, losing or double-counting them is the failure.

Index re-ingested and pruned: 4,799 upserted, 5,300 stale ids deleted under `--allow-mass-delete` (the rail refused the 5,263-id delete first, as designed). Prune reads rules 745 / factions 4,767 / rulings 154, strays 0.

Cards: `buildUnitCard` is keyed on the CSV's numeric ids, so under dump UUIDs every card fell back to prose. `cardFor` now falls back to a name lookup that refuses ambiguity (the same rule `findDatasheet` already applies): 805 of 1,126 datasheets and 826 of 1,148 unitrules render a card, the rest keep the prose body. This is the app's card path; the shaped prototype renders prose by design.

Still red, and needing semantic work rather than new numbers: `test-find` (9 assertions on the search fold's twin/chunk behaviour with UUID ids) and `test-record-outline` (5 assertions: the card census and the outline statistics the CSV corpus defined). Both were previously anchored on numeric CSV ids and now crash or miscount instead of mis-asserting.
