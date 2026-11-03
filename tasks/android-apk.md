# Rebuild and republish the Android APK

*The Android shell changed when Legends left and no APK has been built since, so the phone still runs the old shell.*

- **State:** in progress: the patch landed, a test APK and the new bundle are on the LAN
- **Priority:** P1, and it gates the next deploy
- **Owner:** me

## Where it stands

The old APK keeps working because a missing slugs file degrades to an empty map, but the shell change never reaches the phone until a new build ships. `C:\GitRepos\mhq-rules-android` is at the commit that removed the legends parameter and the slug load.

## The record bodies changed shape (task-109)

The parser now bakes `records/<book>.json` as a hash -> HTML bodies file and
`records/<book>-ids.json` as the id -> hash map (one body per distinct HTML; the English
store only - `records-fr/` is still flat, because deduping it costs bytes). The bundle is
0.75 MB smaller. `LocalServer.kt::recordBody()` still scans `records/<book>.json` for the
record's id, so on a build without the patch below it finds no id in the bodies file and the
record route answers 404 (loud: the drawer says 'The record could not be loaded.'). The patch
is two scans instead of one, and the existing `value()` decoder does both:

```kotlin
// records/<book>-ids.json gives the hash, records/<book>.json the body.
val ids = file(dir + name + "-ids.json") ?: continue
val hash = value(ids, id) ?: continue
val html = value(body, hash) ?: continue
return html
```

The French half is unchanged: `value(body, id)` is still the body. No Kotlin change is needed
anywhere else. **An APK built from this parser commit before the patch is broken for the
English record view**, so land the two together.

## Where it stands, 2026-11-03

`recordBody()` is patched (android repo `462ae46`): the ids map first, the body by hash, the
French store unchanged. Version 0.7 (code 7).

The index was re-ingested against the rebuilt corpus and pruned: rules 671, factions 4,455,
rulings 154, **0 strays**. The web bundle was rebuilt from the payload (3,198,856 bytes,
5,280 English and 375 French records, corpus stamp `6eba356f`).

A **test APK, 0.7-lan**, is served from this machine: `http://192.168.0.125:8099/app.apk`
(825,261 bytes, sha256 `BC7CF78771C3DA4AFA968F4423661F76B4298EA9DAD834176795DE8DABB2C206`), with
the new `web-bundle.zip` beside it. It is built from a temporary variant of the tree:
`SERVER_BASE` pointed at the LAN and that host added to `network_security_config.xml` as
cleartext. Both are reverted in the committed tree, which is the launch shape.

## Next action

The launch build is one constant away: the tree points at the Box, so it needs a Box deploy
carrying the new payload, bundle and page (outward, Mandal's yes), then the APK built from
this tree and published. Until then the phone's bundle comes from the LAN.

## Notes for a fresh session

The app is a WebView over a local mirror and downloads `/web-bundle.zip` from the Box on first run. The vault project card carries the version, the size and the sha256 of the last published build.
