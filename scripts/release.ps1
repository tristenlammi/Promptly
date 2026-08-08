#!/usr/bin/env pwsh
# Cut a new Promptly release: bump the version everywhere and stamp the
# changelog. Does NOT build, commit, tag, or push — you test locally first,
# then commit the result as that version.
#
#   scripts/release.ps1 0.1.1
#
# It updates:
#   * VERSION                  (repo-root canonical marker)
#   * frontend/package.json    (the value injected into the in-app version tag)
#   * CHANGELOG.md             (moves [Unreleased] into a dated [x.y.z] heading)
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Version
)

$ErrorActionPreference = 'Stop'

if ($Version -match '^v') { $Version = $Version.Substring(1) }
if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$') {
    Write-Error "Version '$Version' is not valid semver (expected e.g. 0.1.1)."
}

$root = Split-Path $PSScriptRoot -Parent
$versionFile = Join-Path $root 'VERSION'
$pkgFile = Join-Path $root 'frontend/package.json'
$changelogFile = Join-Path $root 'CHANGELOG.md'

foreach ($f in @($versionFile, $pkgFile, $changelogFile)) {
    if (-not (Test-Path $f)) { Write-Error "Missing $f" }
}

$date = (Get-Date).ToString('yyyy-MM-dd')

$changelog = Get-Content $changelogFile -Raw
if ($changelog -match [regex]::Escape("## [$Version]")) {
    Write-Error "CHANGELOG.md already has a section for $Version."
}
# ``\r`` is in the character class deliberately: with ``core.autocrlf=true``
# (the Windows default, and this is the Windows-primary script) the working
# copy is CRLF, so ``[ \t]*$`` never matched the heading and the script
# refused to cut any release at all.
if ($changelog -notmatch '(?m)^## \[Unreleased\][ \t\r]*$') {
    Write-Error "CHANGELOG.md has no '## [Unreleased]' heading to cut from."
}

# Match whatever the file already uses so we don't leave it with mixed
# endings (which would show up as a whole-file diff on the next commit).
$nl = if ($changelog -match "`r`n") { "`r`n" } else { "`n" }

# 1. VERSION (LF, single trailing newline)
Set-Content -Path $versionFile -Value "$Version`n" -NoNewline

# 2. frontend/package.json — replace the single top-level "version" key only.
$pkg = Get-Content $pkgFile -Raw
$pkg = ([regex]'("version"\s*:\s*")[^"]*(")').Replace($pkg, '${1}' + $Version + '${2}', 1)
Set-Content -Path $pkgFile -Value $pkg -NoNewline

# 3. CHANGELOG — insert a dated release heading directly under [Unreleased];
#    everything you accumulated under Unreleased now falls under the new version.
$changelog = ([regex]'(?m)^## \[Unreleased\][ \t\r]*$').Replace(
    $changelog, "## [Unreleased]$nl$nl## [$Version] - $date", 1)
Set-Content -Path $changelogFile -Value $changelog -NoNewline

Write-Host "Cut version $Version ($date)." -ForegroundColor Green
Write-Host ""
Write-Host "Next:"
Write-Host "  1. Review / flesh out the [$Version] notes in CHANGELOG.md."
Write-Host "  2. Rebuild + final local test  (docker compose up -d --build)."
Write-Host "  3. git add VERSION frontend/package.json CHANGELOG.md"
Write-Host "  4. git commit -m `"release: v$Version`"; git tag v$Version; git push --follow-tags"
