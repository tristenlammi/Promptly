#!/usr/bin/env pwsh
# Is the Android app people download from this server (Install apps -> Android)
# the app in this source tree? See check-android-download.sh: same checks.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    $gradle = 'android/app/build.gradle.kts'
    $apk = 'frontend/public/downloads/Promptly.apk'
    $json = 'frontend/public/downloads/Promptly.json'
    function Fail($why) {
        Write-Host "The Android download is out of date: $why" -ForegroundColor Red
        Write-Host "  Bump the version in $gradle, run android/build-release.ps1, then try again."
        exit 1
    }
    $g = Get-Content $gradle -Raw
    $code = [int]([regex]'versionCode\s*=\s*(\d+)').Match($g).Groups[1].Value
    $name = ([regex]'versionName\s*=\s*"([^"]+)"').Match($g).Groups[1].Value
    $j = Get-Content $json -Raw | ConvertFrom-Json
    if ($code -ne $j.version_code -or $name -ne $j.version) {
        Fail "the source is $name ($code), the download is $($j.version) ($($j.version_code))."
    }
    $have = (Get-FileHash $apk -Algorithm SHA256).Hash.ToLower()
    if ($have -ne $j.sha256) { Fail "Promptly.apk isn't the file Promptly.json describes." }

    # A freshly built APK (not committed yet) is taken at its word.
    if (-not (git status --porcelain -- $apk)) {
        $src = @('android', ':(exclude)android/app/src/test', ':(exclude)android/app/src/androidTest', ':(exclude)android/*.ps1', ':(exclude)android/*.md')
        $built = git log -1 --format=%H -- $apk
        $changed = @(git log --oneline "$built..HEAD" -- @src) + @(git status --porcelain -- @src) | Where-Object { $_ }
        if ($changed) {
            Fail ("the app's source changed after $name ($code) was built:`n" + (($changed | Select-Object -First 8 | ForEach-Object { "    $_" }) -join "`n"))
        }
    }
    Write-Host "Android download: $name ($code), matches the source." -ForegroundColor Green
} finally { Pop-Location }
