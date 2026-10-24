# Give every delivered record one address

*One table from record id to slug, title, number and book, and every consumer reading it instead of walking the tree.*

- **State:** in progress
- **Priority:** P1
- **Owner:** me

## Where it stands

Phase 1 is running: the bake writes `workspace/wiki-data/index/rows.json` for all 6,171 delivered records, and `surfaceSlugMap`, `titlesFromIndex`, `pageFor` and the bundles stop deriving addresses by walking `recs`, `pages` and the per-branch row maps. The defect it closes: 1,926 records were addressable through one map, 2,086 through another, 75 through a third, and 2,159 had no address at all, so a search hit on one could not open. Phase 1 does not change the tree payload shape.

## Next action

Review the worker commit, run the suite, and check that the invariant test is one loop over the delivered set rather than a narrowed definition of delivered.

## Notes for a fresh session

Phase 2 collapses the tree shapes (`branch.pages`, the per-branch `-rows.json`, the twelve `lvl` names) onto the table. Phase 3 extracts the client tree model so it can be tested in Node. The review that named the order is `workspace/2026-10-24-mhq-arch-review/architecture-review.html` in the vault.
