# Finish the rows contract

*Phase 1 gave every record an address. Phase 2 removes the shapes that are now redundant, and the Android map that still walks them.*

- **State:** pending
- **Priority:** P1
- **Owner:** me

## Where it stands

`index/rows.json` addresses all 6,171 delivered records and the server, the web bundle and the app bundle read it. What is left: the tree still carries `branch.pages` and the twelve `lvl` names, the client still reads `index/<branch>-rows.json` for display rows, and the Android offline find (`mhq-search.js:74-81`) still walks the branch payloads, so it still yields slugless rows for the 4,245 records phase 1 rescued.

## Next action

Point the Android find at `rules/data/index/rows.json`, then collapse the tree shapes onto the table and delete the per-branch rows file.

## Notes for a fresh session

Phase 1 is commit `0ac98a6`, its invariant test is `tests/test-rows-table.mjs`, and the architecture review that ordered the work is in the vault workspace under 2026-10-24-mhq-arch-review.
