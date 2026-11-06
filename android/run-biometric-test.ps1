# The biometric test on the emulator: sets a throwaway PIN, enrols an emulated fingerprint
# through Settings, keeps touching the sensor while the test runs, then enrols a second finger
# and checks the Keystore killed the key. Clears the PIN at the end. Emulator only.
param([string]$Serial = "emulator-5554")

$ErrorActionPreference = "Continue"
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA "Android\Sdk" }
$adb = Join-Path $env:ANDROID_HOME "platform-tools\adb.exe"

function Screen {
    & $adb -s $Serial shell "uiautomator dump /sdcard/d.xml >/dev/null 2>&1; cat /sdcard/d.xml" | Out-String
}

function TapText($xml, [string[]]$labels) {
    foreach ($label in $labels) {
        $m = [regex]::Match($xml, "text=`"$label`"[^>]*bounds=`"\[(\d+),(\d+)\]\[(\d+),(\d+)\]`"", "IgnoreCase")
        if ($m.Success) {
            $x = ([int]$m.Groups[1].Value + [int]$m.Groups[3].Value) / 2
            $y = ([int]$m.Groups[2].Value + [int]$m.Groups[4].Value) / 2
            & $adb -s $Serial shell input tap $x $y
            return $label
        }
    }
    return $null
}

function Enrol([int]$finger) {
    & $adb -s $Serial shell am force-stop com.android.settings
    & $adb -s $Serial shell am start -a android.settings.FINGERPRINT_ENROLL | Out-Null
    Start-Sleep 3
    for ($i = 0; $i -lt 60; $i++) {
        $xml = Screen
        if ($xml -match 'password_entry') {
            & $adb -s $Serial shell input text 1234
            & $adb -s $Serial shell input keyevent KEYCODE_ENTER
            Start-Sleep 2
            continue
        }
        # Whatever intro or button the Settings of this image shows, in order of how far along.
        $hit = TapText $xml @("Done", "I agree", "Agree", "More", "Next", "Start", "Continue")
        if ($hit -eq "Done") { Write-Host "Enrolled finger $finger"; Start-Sleep 1; return $true }
        if ($xml -match 'added|Fingerprint added') { Write-Host "Added finger $finger" }
        & $adb -s $Serial emu finger touch $finger | Out-Null
        Start-Sleep 1
    }
    Write-Host "Enrolment didn't finish:"
    (Screen) -replace '<[^>]*text="([^"]*)"[^>]*>', '$1 | ' -replace '<[^>]*>', '' | Write-Host
    return $false
}

function Instrument([string]$test, [string[]]$extra = @()) {
    $job = Start-Job -ArgumentList $adb, $Serial -ScriptBlock {
        param($adb, $serial)
        while ($true) { & $adb -s $serial emu finger touch 1 | Out-Null; Start-Sleep -Milliseconds 800 }
    }
    try {
        $cmd = @("-s", $Serial, "shell", "am", "instrument", "-w") + $extra + @("-e", "class", "org.promptly.sync.passwords.BiometricE2ETest#$test", "org.promptly.app.test/androidx.test.runner.AndroidJUnitRunner")
        & $adb @cmd
    } finally {
        Stop-Job $job
        Remove-Job $job
    }
}

& $adb -s $Serial shell locksettings clear --old 1234
& $adb -s $Serial shell locksettings set-pin 1234
& $adb -s $Serial shell input keyevent KEYCODE_WAKEUP
& $adb -s $Serial shell wm dismiss-keyguard
if (-not (Enrol 1)) { exit 1 }
& $adb -s $Serial shell input keyevent KEYCODE_HOME
Instrument "enrolUnlockAndFillBehindAFingerprint"
if (-not (Enrol 2)) { exit 1 }
& $adb -s $Serial shell input keyevent KEYCODE_HOME
Instrument "aNewFingerprintKillsTheKey" @("-e", "pwAfterNewFinger", "1")
& $adb -s $Serial shell locksettings clear --old 1234
