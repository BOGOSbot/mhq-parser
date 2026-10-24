# retrieveWide is 22 knobs over five unnamed stages

*The ordering of five imperative blocks is the product decision, and it lives in comments rather than in named stages.*

- **State:** pending
- **Priority:** P4
- **Owner:** worker

## Where it stands

`src/rules-corpus.mjs:4610-4818`: 22 option keys on one guarded array, with the cut at `:4732`, retriever heads at `:4745`, the scope leg at `:4774`, anchors at `:4793` and children at `:4800`. Proving that an anchor never displaces a retriever hit means building 22 keys.

## Next action

Three stages that each return a list and a report, composed by a fourth function, with the options grouped into one plan and defaults in one place. Acceptance: one assertion per guarantee, and the composer reads like the paragraphs it replaces.

## Notes for a fresh session

The ask path is parked, so this is maintenance, not a feature. It waits behind everything that changes behaviour a table can see.
