# Address bodies by content

*The duplicate bodies are in the web bundle's HTML store, not the app reader's display store. The bake half landed; the phone's reader patch is carded.*

- **State:** in progress (the bake half landed; the Kotlin reader patch is carded in tasks/android-apk.md)
- **Priority:** P2
- **Owner:** worker

## Where it stands

Measured 2026-10-24, both stores, distinct bodies over total bodies:

- **Web bundle, `records/<book>.json`** (the HTML body per record): 6,171 bodies, 4,265 distinct, 1,906 repeats (30.9% of bodies, 55.9% of the 22,212,455 bytes). This is the store the duplication is in.
- **App bundle, `display/<book>.json`** (the native reader's `{title, text, spans, kids, flags}`): 6,171 entries, 6,127 distinct, 44 repeats (0.7%). The spans are computed against the record's own `selfId` and the text carries the record's own heading, so the per-record variants genuinely differ. Deduping it would save about 42 KB uncompressed, nothing compressed: stopped there rather than landing a shape for its own sake.

Landed: `src/wiki-surface.mjs` owns the shape (`bodyHash`, `bodyFiles`, `bodyById`). `records/<book>.json` is the `hash -> HTML` bodies file, `records/<book>-ids.json` the `id -> hash` map, bodies in corpus order (deflate locality: sorting them by hash cost 61 KB of the archive) and ids sorted. The two files are separate so a reader that still expects the flat shape finds no id and answers no such record, not a hash to render as HTML. `src/web-bundle.mjs` writes them; `records-fr/` stays flat (deduping it costs 68 KB).

Measured: `workspace/web-bundle.zip` 4,644,115 -> 3,892,618 B (**-751,497**, -16.2%); `workspace/app-bundle.zip` unchanged at 3,100,373 B. Resolve-and-compare over all 6,171 delivered ids: 0 missing, **0 differing** byte for byte against the pre-change bundle's bodies, plus a fresh `recordBody` render of 309 sampled ids, 0 differing (`workspace/bodies-resolve-check.mjs`).

## What is left

The phone's record route: `LocalServer.kt::recordBody()` still scans `records/<book>.json` for the id. The patch is written out in tasks/android-apk.md and is two `value()` scans per book (`<book>-ids.json` -> hash, `<book>.json` -> body). Until it lands, an APK built from this bundle answers 404 on the English record view.

## Next action

Land the Kotlin patch with the next APK build (tasks/android-apk.md), then delete this artifact.

## Notes for a fresh session

The corpus separates identity from placement; the display store's near-uniqueness is why only the HTML store moved. The app reader's own bodies (`display/`) are unchanged. `workspace/bodies-before.json` is the pre-change snapshot (id -> sha256) the acceptance compared against.
