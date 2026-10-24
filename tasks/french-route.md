# Carry the French overlay without the 14 MB store

*The record route reads the whole translation export to answer one record. The payload already carries the filtered French, per book.*

- **State:** pending
- **Priority:** P3
- **Owner:** me

## Where it stands

The route works now: the deploy archive carries `workspace/i18n/fr-full.json`, so `lang=fr` answers French for a current record and English for a stale one (verified 2026-10-24: `core-rules#Introduction` French, `ability-def#blast` English). What is left is the shape of it: `src/i18n-fr.mjs` loads a 14 MB export to serve one record's French, when the payload's own `i18n/fr/<book>.json` is already filtered by the source hash and is 2.87 MB in total. The export is needed at bake time to decide freshness; the server only needs the decision's result.

## Next action

Point `frText` at the payload's per-book files when they exist, fall back to the export when they do not, and drop the export from the archive once the payload is the source.

## Notes for a fresh session

The freshness rule is `frFresh` in `src/i18n-fr.mjs`: an entry is served only while the hash of its English still holds. 2,908 of 6,171 records carry French; 3,263 are stale and wait on a metered re-translation (tasks/french-overlay.md).
