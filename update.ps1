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

if (-not (Test-Path ".env")) { throw "No .env found - run .\install.ps1 first." }
New-Item -ItemType Directory -Force data\backups | Out-Null
$StateFile = "data\.last-update.json"

function Wait-Db {
    for ($i = 0; $i -lt 30; $i++) {
        docker compose exec -T postgres pg_isready -U promptly 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { return $true }
        Start-Sleep 2
    }
    return $false
}

function Invoke-NginxReload {
    docker compose exec -T nginx nginx -t 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        docker compose exec -T nginx nginx -s reload 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { docker compose restart nginx }
    } else {
        docker compose restart nginx
    }
}

function Wait-Healthy {
    $healthy = $false
    for ($i = 0; $i -lt 150; $i++) {
        $s = docker inspect -f '{{.State.Health.Status}}' Promptly-Backend 2>$null
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
    $before = docker inspect -f '{{.RestartCount}}' Promptly-ArqWorker Promptly-MediaWorker Promptly-Collab 2>$null
    Start-Sleep 15
    $after = docker inspect -f '{{.RestartCount}}' Promptly-ArqWorker Promptly-MediaWorker Promptly-Collab 2>$null
    foreach ($c in "Promptly-ArqWorker", "Promptly-MediaWorker", "Promptly-Collab") {
        if ((docker inspect -f '{{.State.Status}}' $c 2>$null) -ne "running") {
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
Write-Section "1/6  Checking for local changes"
git diff --quiet HEAD -- 2>$null
if (-not $AllowDirty -and $LASTEXITCODE -ne 0) {
    Write-Fail "These tracked files have local edits, which an update would overwrite or fail on:"
    git diff --name-only HEAD -- 2>$null | ForEach-Object { Write-Host "    $_" }
    Write-Fail "Move your settings into .env or docker-compose.override.yml (both are kept"
    Write-Fail "across updates), or undo the edits with: git checkout -- <file>"
    Write-Fail "To update anyway: .\update.ps1 -AllowDirty"
    exit 1
}

Write-Section "2/6  Finding the update"
git fetch --quiet --tags origin
$prevSha = (git rev-parse HEAD).Trim()
$prevRef = (git describe --tags --always 2>$null)
if (-not $prevRef) { $prevRef = $prevSha }
if ($Version) { $target = $Version }
elseif ($Channel -eq "release") {
    $target = git tag --list 'v[0-9]*' --sort=-v:refname | Select-Object -First 1
    if (-not $target) { throw "No releases found - use -Channel main." }
} else { $target = "origin/main" }
$targetSha = (git rev-parse "$target^{commit}" 2>$null)
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
docker compose pull --ignore-buildable --quiet
if ($LASTEXITCODE -ne 0) { Write-Warn "Couldn't pull some images; continuing with what's here." }
docker compose build --pull
if ($LASTEXITCODE -ne 0) { throw "docker compose build failed" }
docker compose up -d --remove-orphans
if ($LASTEXITCODE -ne 0) { throw "docker compose up failed" }

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
docker image prune -f 2>$null | Out-Null

Write-Host ""
docker compose ps
Write-Host ""
Write-Host "Updated to $target. (Undo with .\update.ps1 -Rollback)" -ForegroundColor Green
