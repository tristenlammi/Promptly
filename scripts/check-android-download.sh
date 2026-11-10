#!/usr/bin/env bash
# Is the Android app people download from this server (Install apps -> Android)
# the app in this source tree? A release that changes android/ without a new
# signed build leaves sideloaders on an old app and nothing tells them.
#
# Fails when:
#   * the version in android/app/build.gradle.kts isn't the one in
#     frontend/public/downloads/Promptly.json,
#   * Promptly.apk isn't the file Promptly.json describes, or
#   * the app's source changed after the APK was last built.
# Fix: bump versionCode/versionName, run android/build-release.ps1, commit the
# two files in frontend/public/downloads.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
gradle="android/app/build.gradle.kts"
apk="frontend/public/downloads/Promptly.apk"
json="frontend/public/downloads/Promptly.json"
fail() { echo "error: the Android download is out of date: $1" >&2; echo "  Bump the version in $gradle, run android/build-release.ps1, then try again." >&2; exit 1; }

code="$(grep -Eo 'versionCode *= *[0-9]+' "$gradle" | head -1 | grep -Eo '[0-9]+')"
name="$(grep -Eo 'versionName *= *"[^"]+"' "$gradle" | head -1 | sed -E 's/.*"([^"]+)"/\1/')"
jcode="$(grep -Eo '"version_code" *: *[0-9]+' "$json" | grep -Eo '[0-9]+$')"
jname="$(grep -Eo '"version" *: *"[^"]+"' "$json" | sed -E 's/.*"([^"]+)"$/\1/')"
[ "$code" = "$jcode" ] && [ "$name" = "$jname" ] || fail "the source is $name ($code), the download is $jname ($jcode)."

want="$(grep -Eo '"sha256" *: *"[0-9a-f]+"' "$json" | sed -E 's/.*"([0-9a-f]+)"$/\1/')"
have="$(sha256sum "$apk" | cut -d' ' -f1)"
[ "$want" = "$have" ] || fail "Promptly.apk isn't the file Promptly.json describes."

# A freshly built APK (not committed yet) is taken at its word.
if [ -z "$(git status --porcelain -- "$apk")" ]; then
  src=(android ':(exclude)android/app/src/test' ':(exclude)android/app/src/androidTest' ':(exclude)android/*.ps1' ':(exclude)android/*.md')
  built="$(git log -1 --format=%H -- "$apk")"
  since="$(git log --oneline "$built..HEAD" -- "${src[@]}")"
  dirty="$(git status --porcelain -- "${src[@]}")"
  if [ -n "$since$dirty" ]; then
    fail "the app's source changed after $name ($code) was built:
$(printf '%s\n%s' "$since" "$dirty" | sed '/^$/d; s/^/    /' | head -8)"
  fi
fi
echo "Android download: $name ($code), matches the source."
