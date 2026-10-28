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
## Update 2026-10-27, third pass: the mission decks

The missions come from the dump now, not from the scraped event-companion page. `src/mfm-missions.mjs` reads the Chapter Approved pack (25 primary, 18 secondary; Combat Patrol is a different game and is filtered out) and writes one record per card with its objectives, WHEN lines, victory points and caps. The page's deck chunks, stray card fragments and the card section labels that had surfaced as names are dropped; the dispositions section keeps its own page card, and the matrix stays reference material (`mission-matrix.mjs`), never written into the corpus. `MHQ_MISSIONS_SOURCE=page` is the rollback.

Measured: event-companion corpus 88 sections (43 cards + the page's own non-deck content), payload 5,702 delivered, index rules 781 / factions 4,767 / rulings 154, strays 0. Tests green: mission-split 10, mission-matrix 13, mission-assets, corpus-drift, index-delivered, editions, record-shapes, wiki-plan.

## Update 2026-10-28: gdmissions.app as the staleness canon

`--check` reads gdmissions.app's data changelog first and compares its latest data version with the dump the corpus was built from; `--update` pulls the dump and rebuilds when it is behind. Wahapedia markers are the fallback. Doc: `docs/gdm-canon.md`; tests: `tests/test-gdm-changelog.mjs` (23).

Verified on 995: current. The scraped core rules carry every Core Rules change through 981, but 9 of the 84 official Core Rules FAQ/errata are missing (Wahapedia lags) and 590 of 591 faction FAQs were never in the corpus. Both close if the FAQs and the core rules are built from the dump; listed under "Still open" in the doc.

`tests/test-corpus-build.mjs` is red (10 assertions) on this branch's base as well as here: it still expects the CSV's core-stratagem anchors and ability rows. Not caused by this change; add it to the re-baseline list.

Same day: the faction changelog (`/11th/rules/faction-changelog`) is read too. Both pickers merge into one row per version with Core Rules and faction counts; either page alone gives a verdict, and a BEHIND verdict names the factions the newest version touched. 995's 24 faction changes are in the corpus except the Death Company Captain's Power Fist, which is a wargear option (the open wargear-options slice). Tests: 36.

## Update 2026-10-28: wargear options

Datasheets now carry every weapon the unit can field and one `Option:` line per printed option (docs/mfm-source.md, "Wargear options"). 995's Death Company Captain Power Fist (A6 WS2+) is in. Corpus rebuilt and payload re-baked: 4,979 sections, 5,777 delivered, 137 filtered. Re-baselined `test-corpus-drift` (5,050 / 6,567,709), `test-index-delivered` (5,777 / 137) and `test-editions` (5,914); new `test-mfm-wargear-options` (11).

Next action: `--ingest` then `--prune` (the index holds the pre-option texts and the unsplit ids of 68 datasheets), then the web bundle and the Android APK as already owed.

Found while rebuilding, not caused by it - each reproduces by reshaping the 2026-10-28 01:08 snapshot with today's code:

- `test-ability-defs`: "find lethal hits" / "find devastating wounds" now return `rules-appendix#[ONE-SHOT]->-LETHAL-HITS` instead of the ability definition. The shape stage now gives that appendix record kind `rule` (it was `''`), and `rule` ranks ahead of `ability` in `rankCmp`. The on-disk corpus predated the current shaping code, so any rebuild flips this. Needs a decision on the order, not a number.
- `test-bodies` (2): the fixture pair is CSV ids (`datasheet#000000016~1`), and the store check asks for more than 6,000 delivered records, which the tournament-only MFM corpus has never had.
- Red before and after, unchanged: `test-hidden-abilities` (3), `test-unit-card` (CSV id lookup), `test-corpus-build` (10), `test-find` (11), `test-record-outline` (5), and the rest of the suite's existing reds; a before/after run over the 52 corpus-reading tests changed only the ones named here.
