# Make the French record route work on the Box

*The server-side French never works in production: the translation store is not in the deploy archive, so every lang=fr request answers English.*

- **State:** pending
- **Priority:** P2
- **Owner:** me

## Where it stands

`/rules/record?...&lang=fr` and `/rules/fr` read `workspace/i18n/fr-full.json`, and the archive carries BUILD, src, img, workspace/rules-corpus, workspace/wiki-data and the two zips - not `workspace/i18n`. So the route has always fallen back to English on the Box. What a French reader actually sees comes from the pre-baked `records-fr` in the bundle, which is built locally and is current. The payload data route also refuses `i18n/` paths by design (server.mjs:1008), so the baked French is not served as data either; only the Android shell reads it, off its own disk.

## Next action

Point the route at the payload's own `i18n/fr/<book>.json` (it is already in the archive and already filtered by the source hash), and drop the dependency on the 14 MB store.

## Notes for a fresh session

The filtering lives in `frFresh` (src/i18n-fr.mjs): a French body is served only while the hash of its English still holds. Today 2,908 of 6,171 records carry French and 3,263 are stale; re-translating them is metered and needs a yes.
