# Build a signed PromptlySync APK and put it where the Promptly server serves it:
#   frontend/public/downloads/PromptlySync.apk   (the download)
#   frontend/public/downloads/PromptlySync.json  (what the app checks for updates)
#
# Bump versionCode (+1) and versionName in app/build.gradle.kts first — phones
# only offer the update when versionCode goes up.
#
# The signing key lives OUTSIDE the repo, in %USERPROFILE%\.promptly\. It is made
# on the first run. BACK THAT FOLDER UP: Android only installs an update signed
# with the same key, so losing it means every phone has to uninstall and
# reinstall the app.

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

Push-Location $root
try {
    & .\gradlew.bat assembleRelease "-Psigning=$props" --console=plain
    if ($LASTEXITCODE -ne 0) { throw "Gradle build failed" }
} finally {
    Pop-Location
}

$apk = Join-Path $root "app\build\outputs\apk\release\app-release.apk"
if (-not (Test-Path $apk)) { throw "No signed APK at $apk" }

$gradle = Get-Content (Join-Path $root "app\build.gradle.kts") -Raw
$code = [int]([regex]::Match($gradle, 'versionCode\s*=\s*(\d+)').Groups[1].Value)
$name = [regex]::Match($gradle, 'versionName\s*=\s*"([^"]+)"').Groups[1].Value

$out = Join-Path $root "..\frontend\public\downloads"
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item $apk (Join-Path $out "PromptlySync.apk") -Force
$file = Get-Item (Join-Path $out "PromptlySync.apk")
$sha = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
$json = [ordered]@{ version = $name; version_code = $code; size_bytes = $file.Length; sha256 = $sha } | ConvertTo-Json
# No byte-order mark (Windows PowerShell's utf8 adds one; the app's JSON parser chokes on it).
[System.IO.File]::WriteAllText((Join-Path $out "PromptlySync.json"), $json, (New-Object System.Text.UTF8Encoding $false))

Write-Host "PromptlySync $name ($code) -> frontend/public/downloads ($([math]::Round($file.Length / 1MB, 1)) MB)" -ForegroundColor Green
