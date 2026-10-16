# ============================================================
# Promptly - restore a full backup (Windows / PowerShell)
#
#   .\scripts\restore.ps1 <promptly-backup-*.tar> [-Yes] [-WithEnv]
#   .\scripts\restore.ps1 -DbOnly <file.dump> [-Yes]
#
# See scripts/restore.sh. The database is dropped and recreated from the
# backup; current files are moved aside to data\uploads.before-restore-<time>.
# -WithEnv also restores the backup's .env (needed on a new machine: its
# SECRET_KEY decrypts stored API keys). -DbOnly restores just a dump, e.g.
# data\backups\pre-migrate-*.dump or nightly-*.dump.
# ============================================================
param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Source,
    [switch]$Yes,
    [switch]$WithEnv,
    [switch]$DbOnly
)
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Source = (Resolve-Path $Source).Path
Set-Location $Root

function Say($m)  { Write-Host $m -ForegroundColor Cyan }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }
function Fail($m) { Write-Host $m -ForegroundColor Red; exit 1 }
# Where uploads live on this host: PROMPTLY_UPLOADS_DIR in .env (WP-7.1),
# else .\data\uploads.
function Get-UploadsDir {
    $v = $env:PROMPTLY_UPLOADS_DIR
    if (-not $v -and (Test-Path ".env")) {
        $line = Get-Content .env | Where-Object { $_ -match '^PROMPTLY_UPLOADS_DIR=' } | Select-Object -Last 1
        if ($line) { $v = ($line -replace '^PROMPTLY_UPLOADS_DIR=', '').Trim('"') }
    }
    if (-not $v) { $v = "data\uploads" }
    return $v
}

$ts = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
$work = Join-Path ([System.IO.Path]::GetTempPath()) "promptly-restore-$ts"
New-Item -ItemType Directory -Force $work | Out-Null
try {
    if ($DbOnly) {
        Copy-Item $Source (Join-Path $work "db.dump")
    } else {
        tar -C $work -xf $Source
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $work "db.dump")) -or -not (Test-Path (Join-Path $work "files.tar"))) {
            Fail "$Source isn't a full Promptly backup (no db.dump/files.tar)."
        }
        Get-Content (Join-Path $work "MANIFEST") -ErrorAction SilentlyContinue
        if (-not $WithEnv -and (Test-Path .env) -and (Test-Path (Join-Path $work "env"))) {
            $theirs = Select-String -Path (Join-Path $work "env") -Pattern '^SECRET_KEY=' | ForEach-Object Line
            $ours = Select-String -Path .env -Pattern '^SECRET_KEY=' | ForEach-Object Line
            if ($theirs -ne $ours) {
                Warn "This backup was taken with a different SECRET_KEY: stored API keys won't decrypt."
                Warn "Re-run with -WithEnv to restore its .env too (yours is kept as .env.before-restore-*)."
            }
        }
    }

    if (-not $Yes) {
        $what = if ($DbOnly) { "database" } else { "database and files" }
        Warn "This REPLACES the current $what with the backup's."
        if ((Read-Host "Type 'restore' to continue") -ne "restore") { Fail "Cancelled." }
    }

    Say "1/5  Stopping the app (database stays up)"
    docker compose stop backend arq-worker media-worker tusd collab | Out-Null
    docker compose up -d postgres | Out-Null
    for ($i = 0; $i -lt 30; $i++) {
        docker compose exec -T postgres pg_isready -U promptly 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep 2
    }

    Say "2/5  Recreating the database"
    docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U promptly -d postgres `
        -c "DROP DATABASE IF EXISTS promptly WITH (FORCE)" -c "CREATE DATABASE promptly OWNER promptly" | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "Couldn't recreate the database." }

    Say "3/5  Restoring the database"
    docker compose cp (Join-Path $work "db.dump") postgres:/tmp/promptly-restore.dump | Out-Null
    docker compose exec -T postgres pg_restore --no-owner --exit-on-error -U promptly -d promptly /tmp/promptly-restore.dump
    $rc = $LASTEXITCODE
    docker compose exec -T postgres rm -f /tmp/promptly-restore.dump | Out-Null
    if ($rc -ne 0) { Fail "pg_restore failed - the database is incomplete. Fix the error and run this again." }

    if (-not $DbOnly) {
        Say "4/5  Restoring files"
        $uploads = Get-UploadsDir
        if (Test-Path $uploads) { Move-Item $uploads "$uploads.before-restore-$ts" }
        if (Test-Path "data\whiteboard") { Move-Item "data\whiteboard" "data\whiteboard.before-restore-$ts" }
        $unpacked = Join-Path $work "files"
        New-Item -ItemType Directory -Force data, $unpacked, (Split-Path $uploads -Parent) | Out-Null
        tar -C $unpacked -xf (Join-Path $work "files.tar")
        if ($LASTEXITCODE -ne 0) { Fail "Couldn't unpack the files." }
        Move-Item (Join-Path $unpacked "uploads") $uploads
        Move-Item (Join-Path $unpacked "whiteboard") "data\whiteboard"
        if ($WithEnv -and (Test-Path (Join-Path $work "env"))) {
            if (Test-Path .env) { Copy-Item .env ".env.before-restore-$ts" }
            Copy-Item (Join-Path $work "env") .env -Force
        }
    } else {
        Say "4/5  (database only - files left as they are)"
    }

    Say "5/5  Starting the app"
    docker compose up -d | Out-Null
    $healthy = $false
    for ($i = 0; $i -lt 90; $i++) {
        if ((docker inspect -f '{{.State.Health.Status}}' Promptly-Backend 2>$null) -eq "healthy") { $healthy = $true; break }
        Write-Host "." -NoNewline; Start-Sleep 2
    }
    Write-Host ""
    if ($healthy) { Write-Host "Restore complete." -ForegroundColor Green }
    else { Warn "The backend isn't healthy yet - check: docker compose logs --tail=60 backend" }
    if (-not $DbOnly) { Write-Host "Your previous files are in data\*.before-restore-$ts - delete them once you're happy." }
} finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
