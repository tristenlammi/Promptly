#!/usr/bin/env bash
# Refresh the vendored copy of Apple's password-manager-resources quirks (MIT).
# Pass the commit to pin. Run from the worktree root.
set -euo pipefail
sha="${1:-$(curl -s https://api.github.com/repos/apple/password-manager-resources/commits/main | grep -m1 '"sha"' | cut -d'"' -f4)}"
out=frontend/src/passwords/core/data
mkdir -p "$out"
base="https://raw.githubusercontent.com/apple/password-manager-resources/$sha"
for f in password-rules shared-credentials change-password-URLs; do
  curl -sSf -o "$out/$f.json" "$base/quirks/$f.json"
done
curl -sSf -o "$out/APPLE-LICENSE.txt" "$base/LICENSE.md"
echo "$sha" > "$out/APPLE-COMMIT.txt"
echo "pinned $sha"
