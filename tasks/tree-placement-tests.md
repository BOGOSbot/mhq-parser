# Tree placement is testable without the live corpus

*`tocTree` is documented as pure so a test can build it from a mutated corpus, and no test does. Placement assertions are census counts.*

- **State:** pending
- **Priority:** P3
- **Owner:** worker

## Where it stands

`src/wiki-toc.mjs:382` `tocTree(records, pages, roster)` reads two module globals and disk: `appendixOutline` at `:356-378` and `outline` at `:424` both read files. `tests/test-updates-fold.mjs:24-38` calls `wikiTree` with 6,483 real records and asserts that 16 resolve and 5 do not, so any legitimate corpus change turns it red without saying which rule broke.

## Next action

Both outlines become arguments, and the two disk readers move into a loader the CLI calls. Then a test builds twelve records including one errata and asserts where each lands and why. Acceptance: the corpus-census assertions become rule assertions, and `tocTree` in the test no longer touches disk.

## Notes for a fresh session

`tocTree` is the hottest file in the bake. Do not change the placement rules in this slice, only the seam that lets a test reach them.
