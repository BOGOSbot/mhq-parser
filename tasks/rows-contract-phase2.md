# Finish the rows contract

*Phase 1 gave every record an address. Part A moved the two remaining consumers onto the table; part B still collapses the tree's own shapes.*

- **State:** in progress (part A landed, part B open)
- **Priority:** P1
- **Owner:** me

## Where it stands

Part A landed on `ui/reader-navigation`, in the commit that carries this file. The client (`src/wiki-surface.js`: `loadRows`/`rowFromBranch`) and the Android offline find (`mhq-rules-android/app/src/main/assets/mhq-search.js`, `FILES.rows`) read `index/rows.json`, the one addressing table; the bake no longer writes the per-branch `index/<branch>-rows.json` files. The table carries the drawer row too (`snippet`), so the client's rows did not move: the before/after manifest over every branch and node is 4,012 entries, identical in every field, with 0 ids gaining a slug on that path. The phone's slug coverage goes from 1,926 to 6,171 (4,245 records gained a slug). tests/test-rows-reader.mjs drives the shipping reader in Node; tests/test-wiki-payload.mjs asserts a fresh bake writes no per-branch rows file.

What is left (part B): the tree's own shapes - the twelve `lvl` names and `branch.pages`. The client still matches a page through `pageFor`/`branch.pages`, and the tree still spells its levels. Collapsing those onto the table is not started.

## Next action

Part B: name the twelve `lvl` values once and drop the tree shapes the table already answers (`branch.pages`, the level strings the client switches on).

## Notes for a fresh session

Phase 1 is commit `0ac98a6`; its invariant is `tests/test-rows-table.mjs`. The architecture review that ordered the work is in the vault workspace under 2026-10-24-mhq-arch-review. `workspace/wiki-data` is the live payload and still carries the old `factions-rows.json` until the next deploy re-bakes it; `workspace/wiki-data-test` is the part-A bake and `tests/test-rows-reader.mjs` prefers it when present.
