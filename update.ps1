# ============================================================
# Promptly - one-command update (Windows / PowerShell)
#
#   .\update.ps1                     update to the latest release (vX.Y.Z tag)
#   .\update.ps1 -Version v0.9.0     update (or move) to a specific release
#   .\update.ps1 -Channel main       follow the main branch instead of releases
#   .\update.ps1 -Rollback           undo the last update: restore the database
#                                    backed up before it and go back to that code
#
# Same steps as update.sh: refuse local edits to tracked files, show what's
# changing, back up the database first (stop if that fails), update, reload
# nginx, then check the backend is healthy and the worker and collab server
# aren't restarting. On failure it prints how to roll back.
# ============================================================
param(
    [ValidateSet("release", "main")][string]$Channel = "release",
    [string]$Version = "",
    [switch]$Rollback,
    [switch]$AllowDirty,
    [switch]$Yes
)
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

function Write-Section($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Write-Ok($m)      { Write-Host "  OK  $m" -ForegroundColor Green }
function Write-Warn($m)    { Write-Host "  !!  $m" -ForegroundColor Yellow }
function Write-Fail($m)    { Write-Host "  ERR $m" -ForegroundColor Red }

# Run a program with whatever it prints on stderr thrown away. Windows
# PowerShell 5.1 turns redirected stderr into a terminating error when
# $ErrorActionPreference is Stop (and `docker compose up` prints its progress
# there), so the preference is relaxed in here only.
function Invoke-Quiet([scriptblock]$Cmd) {
    $ErrorActionPreference = "Continue"
    & $Cmd 2>$null
}

if (-not (Test-Path ".env")) { throw "No .env found - run .\install.ps1 first." }

# git and Docker have to work here before anything is touched.
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git isn't installed, and the update needs it to fetch the new version (winget install --id Git.Git -e, then a new PowerShell window)."
}
$ErrorActionPreference = "Continue"
$gitSays = (git rev-parse --git-dir 2>&1 | ForEach-Object { "$_" }) -join "`n"
$gitRc = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($gitRc -ne 0) {
    Write-Fail "git can't work in this folder. It said:"
    $gitSays -split "`n" | ForEach-Object { Write-Host "      $_" }
    if ($gitSays -match "dubious ownership") {
        Write-Host "  The folder belongs to a different Windows user than the one running this."
        Write-Host "  Run the update as the user who installed Promptly, or tell git the folder is fine:"
        Write-Host "      git config --global --add safe.directory `"$($ScriptDir -replace '\\', '/')`""
    } elseif (-not (Test-Path ".git")) {
        Write-Host "  This folder isn't a git checkout (was it downloaded as a zip?), so there's nothing"
        Write-Host "  to update from. Install with the one-line installer from the README into a new"
        Write-Host "  folder, then copy your .env and data over."
    }
    exit 1
}
Invoke-Quiet { docker info } | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Docker isn't running. Start Docker Desktop, wait until it says it's running, and try again." }

New-Item -ItemType Directory -Force data\backups | Out-Null
$StateFile = "data\.last-update.json"

function Wait-Db {
    for ($i = 0; $i -lt 30; $i++) {
        Invoke-Quiet { docker compose exec -T postgres pg_isready -U promptly } | Out-Null
        if ($LASTEXITCODE -eq 0) { return $true }
        Start-Sleep 2
    }
    return $false
}

function Invoke-NginxReload {
    # Recreated, not reloaded: nginx.conf is a single-file bind mount, and
    # git replaces the file on update - a running container keeps the old
    # one, so a reload never saw the new config.
    Invoke-Quiet { docker compose up -d --force-recreate --no-deps nginx } | Out-Null
    Start-Sleep -Seconds 2
    Invoke-Quiet { docker compose exec -T nginx nginx -t } | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "nginx didn't accept its config. Recent logs:"
        docker compose logs --tail=20 nginx
    }
}

function Wait-Healthy {
    $healthy = $false
    for ($i = 0; $i -lt 150; $i++) {
        $s = Invoke-Quiet { docker inspect -f '{{.State.Health.Status}}' Promptly-Backend }
        if ($s -eq "healthy") { $healthy = $true; break }
        Write-Host "." -NoNewline; Start-Sleep 2
    }
    Write-Host ""
    if (-not $healthy) {
        Write-Fail "The backend didn't become healthy. Recent logs:"
        docker compose logs --tail=40 backend
        return $false
    }
    Write-Ok "backend healthy"
    $before = Invoke-Quiet { docker inspect -f '{{.RestartCount}}' Promptly-ArqWorker Promptly-MediaWorker Promptly-Collab }
    Start-Sleep 15
    $after = Invoke-Quiet { docker inspect -f '{{.RestartCount}}' Promptly-ArqWorker Promptly-MediaWorker Promptly-Collab }
    foreach ($c in "Promptly-ArqWorker", "Promptly-MediaWorker", "Promptly-Collab") {
        if ((Invoke-Quiet { docker inspect -f '{{.State.Status}}' $c }) -ne "running") {
            Write-Fail "$c isn't running. Recent logs:"; docker logs --tail=30 $c; return $false
        }
    }
    if (($before -join " ") -ne ($after -join " ")) {
        Write-Fail "A worker or the collab server is restarting repeatedly:"
        docker compose logs --tail=30 arq-worker media-worker collab
        return $false
    }
    Write-Ok "workers and collab running"
    return $true
}

function Restore-Dump($dump) {
    docker compose stop backend arq-worker media-worker tusd collab | Out-Null
    if (-not (Wait-Db)) { throw "Postgres isn't ready." }
    docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U promptly -d postgres `
        -c "DROP DATABASE IF EXISTS promptly WITH (FORCE)" -c "CREATE DATABASE promptly OWNER promptly" | Out-Null
    docker compose cp $dump postgres:/tmp/promptly-rollback.dump | Out-Null
    docker compose exec -T postgres pg_restore --no-owner --exit-on-error -U promptly -d promptly /tmp/promptly-rollback.dump
    $rc = $LASTEXITCODE
    docker compose exec -T postgres rm -f /tmp/promptly-rollback.dump | Out-Null
    if ($rc -ne 0) { throw "pg_restore failed." }
}

# ---------------------------------------------------------------- rollback
if ($Rollback) {
    if (-not (Test-Path $StateFile)) { throw "Nothing to roll back: no record of a previous update ($StateFile)." }
    $st = Get-Content $StateFile -Raw | ConvertFrom-Json
    if (-not (Test-Path $st.dump)) { throw "The pre-update backup $($st.dump) is missing - can't roll back." }
    Write-Section "Rolling back to $($st.prev_ref) ($($st.prev_sha)), restoring $($st.dump)"
    Write-Warn "This replaces the database with its state before the update. Anything done since is lost."
    if (-not $Yes -and (Read-Host "Type 'rollback' to continue") -ne "rollback") { exit 1 }
    Restore-Dump $st.dump
    git checkout --quiet $st.prev_sha
    docker compose build
    docker compose up -d --remove-orphans
    Invoke-NginxReload
    if (-not (Wait-Healthy)) { exit 1 }
    Remove-Item $StateFile
    Write-Host "Rolled back to $($st.prev_ref)." -ForegroundColor Green
    exit 0
}

# ------------------------------------------------------------------ update
# Steps 1-3 and the checkout happen once. If the update brought a newer
# update.ps1, this run (still the old script, already in memory) hands the
# rest over to it below, and the new script picks up here.
if (-not $env:PROMPTLY_UPDATE_RESUME) {
Write-Section "1/6  Checking for local changes"
Invoke-Quiet { git diff --quiet HEAD -- }
if (-not $AllowDirty -and $LASTEXITCODE -ne 0) {
    Write-Fail "These tracked files have local edits, which an update would overwrite or fail on:"
    Invoke-Quiet { git diff --name-only HEAD -- } | ForEach-Object { Write-Host "    $_" }
    Write-Fail "Move your settings into .env or docker-compose.override.yml (both are kept"
    Write-Fail "across updates), or undo the edits with: git checkout -- <file>"
    Write-Fail "To update anyway: .\update.ps1 -AllowDirty"
    exit 1
}

Write-Section "2/6  Finding the update"
git fetch --quiet --tags origin
if ($LASTEXITCODE -ne 0) { throw "Couldn't check for a new version (git's message is above). Check the internet connection and try again. Nothing was changed." }
$prevSha = (git rev-parse HEAD).Trim()
$prevRef = (Invoke-Quiet { git describe --tags --always })
if (-not $prevRef) { $prevRef = $prevSha }
if ($Version) { $target = $Version }
elseif ($Channel -eq "release") {
    $target = git tag --list 'v[0-9]*' --sort=-v:refname | Select-Object -First 1
    if (-not $target) { throw "No releases found - use -Channel main." }
} else { $target = "origin/main" }
$targetSha = (Invoke-Quiet { git rev-parse "$target^{commit}" })
if ($LASTEXITCODE -ne 0) { throw "Unknown version: $target" }
if ($targetSha -eq $prevSha) {
    Write-Ok "Already on $target - rebuilding and restarting anyway."
} else {
    Write-Host "  Updating $prevRef -> $target"
    $mig = git diff --name-only --diff-filter=A $prevSha $targetSha -- backend/alembic/versions
    if ($mig) {
        Write-Host "  Database changes in this update:"
        $mig | ForEach-Object { Write-Host "    $(Split-Path $_ -Leaf)" }
    }
    Write-Host "  What's new: CHANGELOG.md"
}

Write-Section "3/6  Backing up the database"
if (-not (Wait-Db)) { throw "Postgres isn't running - start the stack (docker compose up -d) and try again." }
$ts = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
$short = (git rev-parse --short $prevSha).Trim()
$dump = "data\backups\pre-update-$short-$ts.dump"
# Dump inside the container and copy out: PowerShell pipes would corrupt bytes.
docker compose exec -T postgres sh -c "pg_dump -Fc --no-owner -U promptly promptly > /tmp/promptly-pre-update.dump"
if ($LASTEXITCODE -ne 0) { throw "The backup failed, so nothing was changed. Fix the error above (often: disk full) and retry." }
docker compose cp postgres:/tmp/promptly-pre-update.dump $dump | Out-Null
docker compose exec -T postgres rm -f /tmp/promptly-pre-update.dump | Out-Null
if (-not (Test-Path $dump) -or (Get-Item $dump).Length -eq 0) { throw "The backup is empty, so nothing was changed." }
Copy-Item .env "$dump.env"
Get-ChildItem data\backups\pre-update-*.dump | Sort-Object LastWriteTime -Descending | Select-Object -Skip 5 |
    ForEach-Object { Remove-Item $_.FullName, "$($_.FullName).env" -ErrorAction SilentlyContinue }
@{ prev_sha = $prevSha; prev_ref = $prevRef; dump = $dump } | ConvertTo-Json | Set-Content -Encoding utf8 $StateFile
Write-Ok $dump

Write-Section "4/6  Applying the update"
if ($target -eq "origin/main") {
    git checkout --quiet main; git merge --ff-only --quiet origin/main
} else {
    git checkout --quiet $target
}
if ($LASTEXITCODE -ne 0) { throw "git checkout failed" }
# A newer update.ps1 can have one-time set-up steps this run doesn't know
# (the first update with Promptly Home ran the old script, so Home's
# containers were never added). Let the new script do the rest.
Invoke-Quiet { git diff --quiet $prevSha HEAD -- update.ps1 }
if ($LASTEXITCODE -ne 0) {
    $env:PROMPTLY_UPDATE_RESUME = "1"
    $env:PROMPTLY_UPDATE_PREV_REF = "$prevRef"
    $env:PROMPTLY_UPDATE_TARGET = "$target"
    & (Get-Process -Id $PID).Path -NoProfile -File (Join-Path $ScriptDir "update.ps1")
    exit $LASTEXITCODE
}
} else {
    $prevRef = if ($env:PROMPTLY_UPDATE_PREV_REF) { $env:PROMPTLY_UPDATE_PREV_REF } else { "the previous version" }
    $target = if ($env:PROMPTLY_UPDATE_TARGET) { $env:PROMPTLY_UPDATE_TARGET } else { "the new version" }
    Write-Section "4/6  Applying the update (continuing with the new update script)"
}
# Calls (voice channels, LiveKit): the first update that has them makes the
# key pair and turns the calls service on (Docker Desktop: the bridged
# variant, with this PC's LAN address). Later updates see the key and leave
# both alone, so taking the token out of COMPOSE_PROFILES sticks.
if ((Test-Path ".env") -and -not (Select-String -Path ".env" -Pattern "^LIVEKIT_API_KEY=" -Quiet)) {
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $hex = { param($n) $b = New-Object byte[] $n; $rng.GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') }) }
    $envText = [System.IO.File]::ReadAllText((Join-Path $PWD ".env"))
    if ($envText -and -not $envText.EndsWith("`n")) { $envText += "`n" }
    $envText += "LIVEKIT_API_KEY=API$(& $hex 8)`nLIVEKIT_API_SECRET=$(& $hex 32)`n"
    $rng.Dispose()
    if ($envText -notmatch "(?m)^LIVEKIT_NODE_IP=") {
        $callsIp = $null
        try {
            $callsIp = (Get-NetIPConfiguration -ErrorAction Stop |
                Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq "Up" } |
                Select-Object -First 1).IPv4Address.IPAddress
        } catch { }
        if ($callsIp) { $envText += "LIVEKIT_NODE_IP=$callsIp`n" }
    }
    if ($envText -match "(?m)^COMPOSE_PROFILES=(.*)$") {
        if ($Matches[1] -notmatch "calls") {
            $newCsv = (@($Matches[1].Trim().Split(",") | Where-Object { $_ }) + "calls-desktop") -join ","
            $envText = [regex]::Replace($envText, "(?m)^COMPOSE_PROFILES=.*$", "COMPOSE_PROFILES=$newCsv")
        }
    } else {
        $envText += "COMPOSE_PROFILES=calls-desktop`n"
    }
    $envText = $envText -replace "`r`n", "`n"
    [System.IO.File]::WriteAllText((Join-Path $PWD ".env"), $envText)
    Write-Ok "Calls: made a key pair and turned the calls service on (calls-desktop). Turn voice on in Admin -> Calls."
}
# Promptly Home (smart devices): the first update that has it makes the
# secret its bundled home box proves itself with, and turns the two
# containers on (Docker Desktop: the bridged variant, home-desktop). Later
# updates see the secret and leave both alone, so taking the token out of
# COMPOSE_PROFILES sticks.
if ((Test-Path ".env") -and -not (Select-String -Path ".env" -Pattern "^HOME_BOX_SECRET=." -Quiet)) {
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $b = New-Object byte[] 32; $rng.GetBytes($b); $rng.Dispose()
    $homeSecret = -join ($b | ForEach-Object { $_.ToString('x2') })
    $envText = [System.IO.File]::ReadAllText((Join-Path $PWD ".env")) -replace "`r`n", "`n"
    $envText = [regex]::Replace($envText, "(?m)^HOME_BOX_SECRET=\s*\n", "")
    if ($envText -and -not $envText.EndsWith("`n")) { $envText += "`n" }
    $envText += "HOME_BOX_SECRET=$homeSecret`n"
    if ($envText -match "(?m)^COMPOSE_PROFILES=(.*)$") {
        if ($Matches[1] -notmatch "(^|,)home(-desktop)?(,|$)") {
            $newCsv = (@($Matches[1].Trim().Split(",") | Where-Object { $_ }) + "home-desktop") -join ","
            $envText = [regex]::Replace($envText, "(?m)^COMPOSE_PROFILES=.*$", "COMPOSE_PROFILES=$newCsv")
        }
    } else {
        $envText += "COMPOSE_PROFILES=home-desktop`n"
    }
    [System.IO.File]::WriteAllText((Join-Path $PWD ".env"), $envText)
    Write-Ok "Home: smart devices are bundled in now (home-desktop; about 3.5 GB to download this once). Turn Promptly Home on in Admin -> Home."
}
# Shared secrets that later versions need and older .env files lack (or still
# hold the .env.example placeholder for): made once, before anything is
# rebuilt, so the backend's boot check never trips. Real values are kept.
#   TUS_HOOK_SECRET      backend <-> tusd upload hooks
# (An old CODE_SANDBOX_SECRET line in .env is no longer read: the code
# sandbox was removed. It's harmless to leave or delete.)
if (Test-Path ".env") {
    $envPath = Join-Path $PWD ".env"
    $envText = [System.IO.File]::ReadAllText($envPath)
    $changed = $false
    foreach ($key in @("TUS_HOOK_SECRET")) {
        if ($envText -match "(?m)^$key=(?!change-me).+") { continue }
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        $b = New-Object byte[] 32; $rng.GetBytes($b); $rng.Dispose()
        $value = -join ($b | ForEach-Object { $_.ToString('x2') })
        if ($envText -match "(?m)^$key=") {
            $envText = [regex]::Replace($envText, "(?m)^$key=.*$", "$key=$value")
        } else {
            if ($envText -and -not $envText.EndsWith("`n")) { $envText += "`n" }
            $envText += "$key=$value`n"
        }
        $changed = $true
        Write-Ok "$key generated in .env"
    }
    if ($changed) { [System.IO.File]::WriteAllText($envPath, ($envText -replace "`r`n", "`n")) }
}
Write-Host "  Downloading newer parts and rebuilding (a few minutes; longer when a new part is added)"
docker compose pull --ignore-buildable --quiet
if ($LASTEXITCODE -ne 0) { Write-Warn "Couldn't pull some images; continuing with what's here." }
# Building the web app takes about 3 GB of memory. When Docker has little
# (under 10 GB in all), the running app doesn't leave that much and the build
# gets killed part-way, so the three heaviest helpers (photo search, speech in,
# speech out) are stopped for the build; `up` below starts them again.
# $env:PROMPTLY_LOW_MEMORY = "1" forces this, "0" never does it.
$paused = @()
$dockerMem = 0
try { $dockerMem = [int64](Invoke-Quiet { docker info --format '{{.MemTotal}}' }) } catch { }
if ($env:PROMPTLY_LOW_MEMORY -eq "1" -or ($env:PROMPTLY_LOW_MEMORY -ne "0" -and $dockerMem -gt 0 -and $dockerMem -lt 10GB)) {
    $paused = @("photos-ml", "tts", "whisper")
    Write-Warn "Memory is tight: photo search and speech are paused while the new version builds."
    Invoke-Quiet { docker compose stop @paused } | Out-Null
}
docker compose build --pull
if ($LASTEXITCODE -ne 0) {
    # Nothing has been restarted yet: the old version is still what's running.
    # Put the folder back on it, so a retry (and a later -Rollback) start from
    # the truth.
    if ($paused) { Invoke-Quiet { docker compose start @paused } | Out-Null }
    Write-Host ""
    Write-Fail "The new version couldn't be built (the reason is in the lines above), so nothing"
    Write-Fail "was restarted: Promptly is still running $prevRef and your data is untouched."
    if (Test-Path $StateFile) {
        $st = Get-Content $StateFile -Raw | ConvertFrom-Json
        if ($st.prev_sha) {
            Invoke-Quiet { git checkout --quiet $st.prev_sha }
            if ($LASTEXITCODE -eq 0) { Write-Fail "The folder is back on $prevRef as well." }
        }
    }
    Write-Host "      * 'cannot allocate memory', 'Killed' or 'heap out of memory': Docker ran out of memory"
    Write-Host "        while building. Give Docker Desktop more memory (Settings -> Resources, or"
    Write-Host "        .wslconfig), close other programs, and try again:"
    Write-Host "            `$env:PROMPTLY_LOW_MEMORY = '1'; .\update.ps1"
    Write-Host "      * A download failed: check the internet connection, then .\update.ps1"
    Write-Host "      * 'no space left on device': free some disk (docker image prune -f), then .\update.ps1"
    exit 1
}
# --remove-orphans also clears containers of services that no longer exist
# (the old code sandbox, Promptly-Sandbox). Its empty network is left behind
# by compose, so tidy that too; harmless when it isn't there.
docker compose up -d --remove-orphans
if ($LASTEXITCODE -ne 0) { throw "docker compose up failed" }
Invoke-Quiet { docker network rm promptly-sandbox } | Out-Null

Write-Section "5/6  Reloading nginx config"
Invoke-NginxReload
# Your own server blocks need the media links too (WP-7.5).
foreach ($f in Get-ChildItem -Path "nginx/local" -Filter "*.conf" -ErrorAction SilentlyContinue) {
    $text = Get-Content -Raw $f.FullName
    if ($text -match "server\s*\{" -and $text -notmatch "promptly/media\.conf") {
        Write-Warn "$($f.Name) has a server block without:  include /etc/nginx/promptly/media.conf;"
        Write-Warn "Add it inside that server block, or photos, videos and downloads won't load there."
    }
}

Write-Section "6/6  Checking everything came back"
if (-not (Wait-Healthy)) {
    Write-Fail "The update didn't come up cleanly. To go back to $prevRef and the database as it"
    Write-Fail "was before the update:   .\update.ps1 -Rollback"
    exit 1
}
Invoke-Quiet { docker image prune -f } | Out-Null

Write-Host ""
docker compose ps
Write-Host ""
Write-Host "Updated to $target. (Undo with .\update.ps1 -Rollback)" -ForegroundColor Green
