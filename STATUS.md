# Status

*Every task in flight or pending, in priority order. Links only: the artifact holds the task.*

## In progress


## Pending

- **P1** [Finish the rows contract](tasks/rows-contract-phase2.md) - part A landed: the client and the phone read the addressing table. Part B, the twelve lvl names and the tree shapes, is open.

- **P1** [Design the next wiki](tasks/wiki-redesign.md) - waiting on Mandal's shape.
- **P2** [Address bodies by content](tasks/bodies-by-content.md) - 57.7% of the baked HTML store repeats; about 0.6 MB of the phone download.
- **P2** [Give the client a tree model](tasks/client-model.md) - the reader is tested by regex on its own source, and it keeps the last copy of the row rule.
- **P2** [Re-ingest and prune the vector index](tasks/index-ingest.md) - owed since the corpus cuts.
- **P2** [Re-translate the stale French](tasks/french-overlay.md) - 3,263 records; metered, waiting on a yes.
- **P3** [Make tree placement testable](tasks/tree-placement-tests.md) - placement is asserted by census, not by rule.
- **P3** [Give rules-corpus a seam](tasks/corpus-seam.md) - 5,735 lines, 204 exports, the interface is the implementation.
- **P3** [Carry the French overlay without the 14 MB store](tasks/french-route.md) - the route works now; it reads the whole export to serve one record.
- **P3** [Rebuild and republish the Android APK](tasks/android-apk.md) - the shell change has not reached the phone.
- **P4** [Name the five stages of retrieveWide](tasks/retrieve-wide-stages.md) - 22 knobs; maintenance behind everything a table can see.

## Landed, for orientation

The corpus is tournament-only since 2026-10-24: Legends, the CSV lore column, the ability flavour sentence and the navigation stubs are out, which is 7,408 records and 6,171 delivered. The deployed build and its owed work are named in [docs/deploy.md](docs/deploy.md).

Naming has one home since 2026-10-24: `src/title.mjs` owns the heading path, the marker strip, the page address and the row label, and the bake, the tree and the cards read it (the client keeps a copy until [the client model](tasks/client-model.md) lands, because the WebView loads `wiki-surface.js` as a plain script). The architecture review behind the remaining tasks is in the vault workspace under 2026-10-24-mhq-arch-review.
