# Re-ingest and prune the vector index

*The index is 17 faction ids ahead of the corpus and still holds the pre-cut body of every record whose text changed.*

- **State:** pending
- **Priority:** P2
- **Owner:** me

## Where it stands

Owed since the tournament cut and the flavour cut. `/health` reports `ahead: [factions +17]` and `behind: []`. Only the ask path reads the index; the drawer, the record route and the lexical find read the payload and are current. Ask is parked, so nothing is wrong for a reader today.

## Next action

Run `--ingest` then `--prune`, then confirm `/health` reads `behind: []` and `ahead: []`.

## Notes for a fresh session

The ingest re-embeds every record whose text hash moved, which after three cuts is a few thousand. It costs CPU on the Box and no money when the vector namespace is the free tier. `docs/corpus-storage.md` says what a rebuild re-downloads.
