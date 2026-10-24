# Rebuild and republish the Android APK

*The Android shell changed when Legends left and no APK has been built since, so the phone still runs the old shell.*

- **State:** pending
- **Priority:** P3
- **Owner:** me

## Where it stands

The old APK keeps working because a missing slugs file degrades to an empty map, but the shell change never reaches the phone until a new build ships. `C:\GitRepos\mhq-rules-android` is at the commit that removed the legends parameter and the slug load.

## Next action

Build the debug APK, publish it beside `app.apk` on the LAN serve root, and update the version name and code.

## Notes for a fresh session

The app is a WebView over a local mirror and downloads `/web-bundle.zip` from the Box on first run. The vault project card carries the version, the size and the sha256 of the last published build.
