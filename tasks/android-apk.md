# Rebuild and republish the Android APK

*The Android shell changed when Legends left and no APK has been built since, so the phone still runs the old shell.*

- **State:** pending
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

## Next action

Patch `LocalServer.kt::recordBody()` for the task-109 store (above), build the debug APK,
publish it beside `app.apk` on the LAN serve root, and update the version name and code.

## Notes for a fresh session

The app is a WebView over a local mirror and downloads `/web-bundle.zip` from the Box on first run. The vault project card carries the version, the size and the sha256 of the last published build.
