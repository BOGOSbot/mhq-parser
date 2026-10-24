# Status

*Every task in flight or pending, in priority order. Links only: the artifact holds the task.*

## In progress

- **P1** [Give every delivered record one address](tasks/rows-contract.md) - the rows contract, phase 1. Running.

## Pending

- **P1** [Design the next wiki](tasks/wiki-redesign.md) - waiting on Mandal's shape.
- **P2** [Re-ingest and prune the vector index](tasks/index-ingest.md) - owed since the corpus cuts.
- **P2** [Decide what to do with the stale French overlay](tasks/french-overlay.md) - Mandal picks the route.
- **P3** [Rebuild and republish the Android APK](tasks/android-apk.md) - the shell change has not reached the phone.

## Landed, for orientation

The corpus is tournament-only since 2026-10-24: Legends, the CSV lore column, the ability flavour sentence and the navigation stubs are out, which is 7,408 records and 6,171 delivered. The deployed build and its owed work are named in [docs/deploy.md](docs/deploy.md). The payload's next shapes are ordered in the architecture review (vault workspace, 2026-10-24): rows contract, then bodies by content, then the client model.
