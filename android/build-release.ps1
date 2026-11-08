# Build the signed Promptly Android app (home-screen launchers + photo backup)
# and put it where the Promptly server serves it:
#   frontend/public/downloads/Promptly.apk   (the download)
#   frontend/public/downloads/Promptly.json  (what the app checks for updates)
#
# Bump versionCode (+1) and versionName in app/build.gradle.kts first — phones
# only offer the update when versionCode goes up. Changed the app list or the
# icons? Re-run gen_suite.py first (needs Pillow — e.g. in the backend image).
# The key's SHA-256 is in frontend/public/.well-known/assetlinks.json; a new
# key means updating that file.
#
# The signing key lives OUTSIDE the repo, in %USERPROFILE%\.promptly\. It is made
# on the first run. BACK THAT FOLDER UP: Android only installs an update signed
# with the same key, so losing it means every phone has to uninstall and
# reinstall the app.
#
# -Play: the Google Play build instead (the "play" flavor: no self-updater, no
# REQUEST_INSTALL_PACKAGES), as an app bundle signed with the same key (Play's
# "upload key"), into android/dist/Promptly-play-<version>.aab (gitignored). Upload it
# to Play Console → Internal testing. Same versionCode numbering as the APK: Play
# refuses a versionCode it has seen. Nothing is copied to frontend/public.
# Play re-signs with its own app-signing key: its SHA-256 goes in
# frontend/public/.well-known/assetlinks.json (see docs/maps-offline-plan.md, WP-A2).

param([switch]$Play)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$keyDir = Join-Path $env:USERPROFILE ".promptly"
$props = Join-Path $keyDir "keystore.properties"
$store = Join-Path $keyDir "promptlysync.jks"

if (-not $env:JAVA_HOME) { $env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot" }
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA "Android\Sdk" }

if (-not (Test-Path $props)) {
    Write-Host "No signing key yet - making one in $keyDir"
    New-Item -ItemType Directory -Force $keyDir | Out-Null
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $pass = [Convert]::ToBase64String($bytes) -replace '[+/=]', ''
    & "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -keystore $store -storetype PKCS12 -alias promptlysync `
        -keyalg RSA -keysize 4096 -validity 36500 -storepass $pass -keypass $pass `
        -dname "CN=PromptlySync" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "keytool failed" }
    @(
        "storeFile=$($store -replace '\\', '/')",
        "storePassword=$pass",
        "keyAlias=promptlysync",
        "keyPassword=$pass"
    ) | Set-Content -Encoding ascii $props
    Write-Host "Made $store - BACK UP $keyDir (both files)." -ForegroundColor Yellow
}

$gradle = Get-Content (Join-Path $root "app\build.gradle.kts") -Raw
$code = [int]([regex]::Match($gradle, 'versionCode\s*=\s*(\d+)').Groups[1].Value)
$name = [regex]::Match($gradle, 'versionName\s*=\s*"([^"]+)"').Groups[1].Value

if ($Play) {
    Push-Location $root
    try {
        & .\gradlew.bat :app:bundlePlayRelease "-Psigning=$props" --console=plain
        if ($LASTEXITCODE -ne 0) { throw "Gradle build failed" }
    } finally {
        Pop-Location
    }
    $aab = Join-Path $root "app\build\outputs\bundle\playRelease\app-play-release.aab"
    if (-not (Test-Path $aab)) { throw "No signed bundle at $aab" }
    $dist = Join-Path $root "dist"
    New-Item -ItemType Directory -Force $dist | Out-Null
    $out = Join-Path $dist "Promptly-play-$name.aab"
    Copy-Item $aab $out -Force
    Write-Host "Promptly for Android $name ($code), Play build -> android/dist/Promptly-play-$name.aab ($([math]::Round((Get-Item $out).Length / 1MB, 1)) MB)" -ForegroundColor Green
    Write-Host "Upload it in Play Console -> Test and release -> Testing -> Internal testing -> Create new release."
    exit 0
}

Push-Location $root
try {
    & .\gradlew.bat :app:assembleServerRelease "-Psigning=$props" --console=plain
    if ($LASTEXITCODE -ne 0) { throw "Gradle build failed" }
} finally {
    Pop-Location
}

$apk = Join-Path $root "app\build\outputs\apk\server\release\app-server-release.apk"
if (-not (Test-Path $apk)) { throw "No signed APK at $apk" }

$out = Join-Path $root "..\frontend\public\downloads"
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item $apk (Join-Path $out "Promptly.apk") -Force
$file = Get-Item (Join-Path $out "Promptly.apk")
$sha = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
$json = [ordered]@{ version = $name; version_code = $code; size_bytes = $file.Length; sha256 = $sha } | ConvertTo-Json
# No byte-order mark (Windows PowerShell's utf8 adds one; the app's JSON parser chokes on it).
[System.IO.File]::WriteAllText((Join-Path $out "Promptly.json"), $json, (New-Object System.Text.UTF8Encoding $false))

Write-Host "Promptly for Android $name ($code) -> frontend/public/downloads ($([math]::Round($file.Length / 1MB, 1)) MB)" -ForegroundColor Green
