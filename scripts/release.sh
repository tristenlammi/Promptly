#!/usr/bin/env bash
# Cut a new Promptly release: bump the version everywhere and stamp the
# changelog. Does NOT build, commit, tag, or push — you test locally first,
# then commit the result as that version.
#
#   scripts/release.sh 0.1.1
#
# It updates:
#   * VERSION                  (repo-root canonical marker)
#   * frontend/package.json    (the value injected into the in-app version tag)
#   * CHANGELOG.md             (moves [Unreleased] into a dated [x.y.z] heading)
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $(basename "$0") <version>   e.g. $(basename "$0") 0.1.1" >&2
  exit 1
fi

version="${1#v}"  # tolerate a leading "v"
if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "error: '$version' is not valid semver (expected e.g. 0.1.1)" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$script_dir")"
version_file="$root/VERSION"
pkg_file="$root/frontend/package.json"
changelog_file="$root/CHANGELOG.md"

for f in "$version_file" "$pkg_file" "$changelog_file"; do
  [ -f "$f" ] || { echo "error: missing $f" >&2; exit 1; }
done

date_str="$(date +%F)"

if grep -qF "## [$version]" "$changelog_file"; then
  echo "error: CHANGELOG.md already has a section for $version" >&2
  exit 1
fi
# ``\r`` is tolerated so a CRLF working tree (a Windows checkout shared into
# WSL, or core.autocrlf=true) doesn't make this refuse to cut a release —
# the same bug the PowerShell sibling had.
if ! grep -qE '^## \[Unreleased\][ \t\r]*$' "$changelog_file"; then
  echo "error: CHANGELOG.md has no '## [Unreleased]' heading to cut from" >&2
  exit 1
fi

# 1. VERSION
printf '%s\n' "$version" > "$version_file"

# 2. frontend/package.json — replace the single top-level "version" key only.
#    perl gives a reliable first-match in-place edit across GNU/BSD/Git-Bash.
perl -0pi -e 's/("version"\s*:\s*")[^"]*(")/${1}'"$version"'${2}/' "$pkg_file"

# 3. CHANGELOG — insert a dated release heading directly under [Unreleased].
# ``(\r?)`` is captured and replayed so the inserted lines keep whatever
# ending the file already uses, rather than leaving it mixed.
perl -0pi -e 's/^## \[Unreleased\][ \t]*(\r?)$/## [Unreleased]$1\n$1\n## ['"$version"'] - '"$date_str"'/m' "$changelog_file"

echo "Cut version $version ($date_str)."
echo
echo "Next:"
echo "  1. Review / flesh out the [$version] notes in CHANGELOG.md."
echo "  2. Rebuild + final local test  (docker compose up -d --build)."
echo "  3. git add VERSION frontend/package.json CHANGELOG.md"
echo "  4. git commit -m \"release: v$version\"; git tag v$version; git push --follow-tags"
