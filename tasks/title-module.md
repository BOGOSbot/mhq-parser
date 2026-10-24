# One title module instead of six

*What a record is called has six implementations, three marker regexes and four names that disagree. One module should answer the three questions a caller actually has.*

- **State:** pending
- **Priority:** P1
- **Owner:** worker

## Where it stands

The raw heading passes through `wiki-toc.mjs:184-192` (leafTitle), a copy of it in `wiki-payload.mjs:76-118`, `wiki-surface.js:123-224` (rowName), `search-core.mjs:95-98` (cleanMarker), `wiki-plan.mjs:58` and `unit-card.mjs:143,172,491`. There are 37 splits on the heading path across 9 files. The `(1/2)` and keyword markers are stripped by three different regexes, and the resulting names disagree where nobody wrote it down. `tests/test-rules-page.mjs:363-418` covers it by pulling two functions out of the client source with `new Function`.

## Next action

A `src/title.mjs` that splits the heading path once, strips the markers once, and exposes three answers: page slug, row label, display label. Table-driven tests, no corpus, no `new Function` for the title path. Then delete the copies.

## Notes for a fresh session

The architecture review that ordered this is in the vault workspace under 2026-10-24-mhq-arch-review. Keep `wiki-surface.js` behaviour identical: this is a move, not a rename of the output.
