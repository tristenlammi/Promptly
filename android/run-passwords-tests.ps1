# Passwords tests on the emulator, against the isolated :8092 stack. Throwaway users only.
#   .\android\run-passwords-tests.ps1               all instrumented classes
#   .\android\run-passwords-tests.ps1 AutofillE2ETest
# JVM tests are separate: gradlew :app:testDebugUnitTest "-Dpw.stack=http://localhost:8092"
# Chrome on the emulator is never opened: its first-run terms stay unaccepted.
param([string]$Class = "", [string]$Serial = "emulator-5554", [switch]$NoBuild)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
if (-not $env:JAVA_HOME) { $env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot" }
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA "Android\Sdk" }
$adb = Join-Path $env:ANDROID_HOME "platform-tools\adb.exe"

Push-Location $root
try {
    if (-not $NoBuild) {
        & .\gradlew.bat :app:assembleDebug :app:assembleDebugAndroidTest :pwtestapp:assemblePlainDebug :pwtestapp:assembleBrowserDebug --console=plain -q
        if ($LASTEXITCODE -ne 0) { throw "Gradle build failed" }
        foreach ($apk in "app\build\outputs\apk\debug\app-debug.apk", "app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk", "pwtestapp\build\outputs\apk\plain\debug\pwtestapp-plain-debug.apk", "pwtestapp\build\outputs\apk\browser\debug\pwtestapp-browser-debug.apk") {
            & $adb -s $Serial install -r -t -g $apk | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Install failed: $apk" }
        }
    }

    # A throwaway user's bearer token for the one test that talks to the real stack.
    $seed = @'
import asyncio, secrets, uuid
import app.db_models
from app.auth.models import User
from app.auth.utils import create_access_token, hash_password
from app.auth.app_passwords import AppPassword, new_token, token_hash, hint
from app.database import SessionLocal
async def main():
    async with SessionLocal() as db:
        s = uuid.uuid4().hex[:10]
        u = User(email=f"pw-android-{s}@example.com", username=f"pwandroid{s}", password_hash=hash_password("An-" + secrets.token_urlsafe(16) + "!9"), role="user")
        db.add(u)
        await db.flush()
        app = new_token()
        db.add(AppPassword(user_id=u.id, name="phone", token_hash=token_hash(app), hint=hint(app), scopes=["upload", "dav:read", "maps", "assistant"]))
        print("PW_TOKEN " + create_access_token(u.id, token_version=u.token_version) + " " + u.username + " " + app)
        await db.commit()
asyncio.run(main())
'@
    $parts = (($seed | docker exec -i PromptlyPw-Backend python - | Select-String '^PW_TOKEN ').Line -split ' ')

    $cmd = @("-s", $Serial, "shell", "am", "instrument", "-w", "-e", "pwBearer", $parts[1], "-e", "pwAppUser", $parts[2], "-e", "pwAppPassword", $parts[3], "-e", "pwServer", "http://10.0.2.2:8092")
    if ($Class) { $cmd += @("-e", "class", "org.promptly.sync.passwords.$Class") }
    else { $cmd += @("-e", "package", "org.promptly.sync.passwords") }
    $cmd += "org.promptly.app.test/androidx.test.runner.AndroidJUnitRunner"
    & $adb @cmd
} finally {
    Pop-Location
}
