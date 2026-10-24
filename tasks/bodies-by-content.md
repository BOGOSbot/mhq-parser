# Address bodies by content

*57.7% of the baked HTML store repeats a body another record already carries. One body per distinct HTML, addressed by hash, collapses 20.6 MB to about 8.7 MB.*

- **State:** pending
- **Priority:** P2
- **Owner:** worker

## Where it stands

`src/wiki-payload.mjs` writes `display/<book>/<id>.html` for 5,246 ids holding 3,459 distinct bodies: a datasheet republished in five factions carries five copies, and a datasheet half resolves to its parent body byte for byte. The client then scans the whole book per tap.

Measured on the app bundle 2026-10-24: `display` is 8,724,101 B uncompressed, 1,025,722 B compressed inside a 3,100,373 B zip. Removing 57.7% of it saves about 0.6 MB compressed, roughly a fifth of the download, not half. The payload-store figure (20.6 to 8.7 MB) is the uncompressed number.

## Next action

Bake one body per distinct HTML into `display/bodies/<hash>.html`, write an id-to-hash map beside it, and make the client, the server and both bundles resolve through the map. Prove the id-to-body mapping is unchanged for all 5,246 ids before and after: that is the acceptance, byte for byte.

## Notes for a fresh session

The corpus already separates identity from placement in the tree (a half has its own id and points at a parent body). The bake never applied it. The text payload is already deduplicated, 6,149 distinct texts for 6,171 records, so this is HTML only.
