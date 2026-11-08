# Add Google Play's app-signing certificate to frontend/public/.well-known/assetlinks.json.
#
# Why: Play re-signs the app it installs with its own app-signing key. Chrome only opens
# the home-screen launchers (P Maps, P Photos...) full screen when the server's
# assetlinks.json lists the key the installed app is signed with. Without Play's key in
# the list, the Play-installed launchers show a URL bar. The server APK's own key stays.
#
# Where to find it: Play Console -> your app -> Test and release -> App integrity ->
# Play app signing -> "App signing key certificate" -> SHA-256 certificate fingerprint
# (32 pairs like AB:CD:..., not the "Upload key certificate" one). Play Console's
# "Digital Asset Links JSON" box on the same page shows the same value.
#
#   .\play-signing.ps1 -Sha256 "AB:CD:...:EF"
#
# It's a public fingerprint, not a secret, but this script never makes one up: it only
# adds what you give it, checks its shape, and does nothing if it's already listed.
# Rebuild and deploy the frontend afterwards so the server serves the new file.

param([Parameter(Mandatory = $true)][string]$Sha256)

$ErrorActionPreference = "Stop"
$file = Join-Path $PSScriptRoot "..\frontend\public\.well-known\assetlinks.json"

$fp = $Sha256.Trim().ToUpperInvariant()
if ($fp -notmatch '^([0-9A-F]{2}:){31}[0-9A-F]{2}$') {
    throw "That isn't a SHA-256 certificate fingerprint (32 hex pairs separated by colons)."
}

$links = Get-Content $file -Raw | ConvertFrom-Json
$app = @($links) | Where-Object { $_.target.package_name -eq "org.promptly.app" } | Select-Object -First 1
if (-not $app) { throw "assetlinks.json has no entry for org.promptly.app" }
$have = @($app.target.sha256_cert_fingerprints)
if ($have -contains $fp) {
    Write-Host "Already listed; nothing to do."
    exit 0
}
$app.target.sha256_cert_fingerprints = @($have + $fp)
$json = ConvertTo-Json @($links) -Depth 10
# No byte-order mark: Android's verifier reads plain UTF-8.
[System.IO.File]::WriteAllText((Resolve-Path $file), $json + "`n", (New-Object System.Text.UTF8Encoding $false))
Write-Host "Added Play's app-signing key: assetlinks.json now lists $($have.Count + 1) keys for org.promptly.app." -ForegroundColor Green
