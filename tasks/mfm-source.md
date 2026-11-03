# Move the corpus onto the MFM

*The faction half and the mission decks read Games Workshop's Munitorum Field Manual dump; the Wahapedia CSV and the scraped mission decks are kept as rollbacks.*

- **State:** in progress
- **Priority:** P1
- **Owner:** me

## Where it stands

Landed on feat/mfm-factions, which feat/gdm-canon contains:

- src/mfm-factions.mjs builds datasheets, unit rules, stratagems, detachments, enhancements, army rules and the core stratagems from the dump; MHQ_FACTIONS_SOURCE=csv is the rollback.
- src/mfm-missions.mjs builds the 25 primary and 18 secondary cards of the Chapter Approved pack, Combat Patrol filtered out; MHQ_MISSIONS_SOURCE=page is the rollback.
- The heading parser in src/rules-corpus.mjs no longer derives a title from a table body, lifts list numbers out of headings, and never leaves a dropped label as a parent.
- Wargear options landed as a later slice on the same branch, commit 4d65327.
- **Combat Patrol is out** (Mandal, 2026-11-01), commit 8cc1c60. The dump marks the book, not the unit, so the filter is on the publication and covers everything it feeds: 26 booklets, 113 datasheets, 78 stratagems, 26 detachments, 52 enhancements. A name filter would have left the stratagems and detachment rules behind.

- **The corpus audit of 2026-11-02 is in** ([docs/corpus-audit-2026-11-02.md](../docs/corpus-audit-2026-11-02.md)): eleven defects found by a cheap reader model and verified against the corpus, nine fixed (49c3972, 2eb73e9, ffeb9f8, a503fcf, 740935e, aada0bf), two withdrawn after reading the page, and one corpus-wide class (prices) explained rather than guessed.
- **What the audit taught about method**: the reader's hit rate was about one in five and every class started as its hunch with a shape measured afterwards. Two of its loudest claims, which I repeated, were wrong: the numbered lines ending 43 bodies are the page's SEE ALSO widget (content, linked, kept on purpose) and the 33 `#n` ids are part suffixes of long sections. The '143 bare Wargear lines' was a regex of mine that matched upgrade lines. Measure the pattern before fixing it.

Measured, latest: core rules 386 sections, event companion 87 (43 cards), appendix 166; factions 4,653; payload 5,280 delivered of 5,407; index rules 781 / factions 4,767 / rulings 154 with 0 strays, and no record in the corpus or the payload mentions Combat Patrol.

Owed by the cut, and not done: the shaped prototype in the BOGOS folder and the Auspex APK are built from the old payload, so both carry the 383 records the payload no longer delivers. Rebuild them together, next time the prototype is touched.

## Next action

Two test files are red and need semantic rework, not new numbers: tests/test-find.mjs (11 assertions on the search fold's twin and chunk behaviour, written against numeric CSV ids) and tests/test-record-outline.mjs (5 assertions: the card census and the outline statistics the CSV corpus produced). Everything else the work touches is green.

One defect the audit surfaced and nobody owns yet: the core stratagems that follow the `Tank Shock Stratagem` errata card on the page nest under it (`Tank Shock Stratagem > RAPID INGRESS`, `> FIRE OVERWATCH`). It predates the errata-title fix (the snapshot shows the same nesting under the sentence heading), so it is the promoted errata heading's stack level leaking into its siblings.

## Test scenario

On a cold tree, run the factions build (--scrape --set factions --cached), then the missions build (--scrape --set missions), then the payload build, then the mission, corpus and payload tests. On the phone, open the shaped prototype at Missions and check that a primary card carries its VP lines and that no node is called Fragment. Then --ingest and --prune, and confirm 0 strays.

## Notes for a fresh session

docs/mfm-source.md carries the endpoint, the refresh recipe, the record shape and what the dump does not have. Still open there: conditional keywords and FAQs (345 and 675 rows), the French locale (the dump carries it, so the overlay task can be retired), and the wargear choice groups.

The branch is not pushed: git push origin feat/gdm-canon answers *Permission to BOGOSbot/mhq-parser.git denied to NewbornAI*. The repo's credential helper resolves to the personal account while the org needs the BOGOSbot token; that is the BOGOS session's call. A bundle of the branch sits on the backup volume at E:/archive/workspace/mhq-parser-feat-gdm-canon-20261028.bundle.
