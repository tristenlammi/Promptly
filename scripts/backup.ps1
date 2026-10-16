# ============================================================
# Promptly - full backup (Windows / PowerShell)
#
#   .\scripts\backup.ps1 [-OutDir <folder>]   (default: .\data\backups\full)
#
# Same archive as scripts/backup.sh: db.dump (pg_dump -Fc taken by the
# postgres container), files.tar (data/uploads + data/whiteboard), env (a
# copy of .env - its SECRET_KEY decrypts stored API keys) and MANIFEST.
# Copying .\data while Postgres runs is not a backup; this is.
# Restore with .\scripts\restore.ps1 <archive>.
#
# The archive contains your secrets. Keep a copy off this machine.
# ============================================================
param([string]$OutDir = "")
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root
if (-not $OutDir) { $OutDir = Join-Path $Root "data\backups\full" }

function Say($m)  { Write-Host $m -ForegroundColor Cyan }
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

if (-not (Test-Path ".env")) { Fail "No .env here - run this from your Promptly install." }
$running = docker compose ps --status running --services
if ($running -notcontains "postgres") { Fail "The postgres container isn't running - start the stack first (docker compose up -d)." }

$ts = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
$work = Join-Path ([System.IO.Path]::GetTempPath()) "promptly-backup-$ts"
New-Item -ItemType Directory -Force $work | Out-Null
try {
    # Binary-safe: write inside the container, then copy out (PowerShell
    # pipes re-encode bytes, which would corrupt a dump).
    Say "1/4  Dumping the database"
    docker compose exec -T postgres sh -c "pg_dump -Fc --no-owner -U promptly promptly > /tmp/promptly-db.dump"
    if ($LASTEXITCODE -ne 0) { Fail "pg_dump failed - nothing was written." }
    docker compose cp postgres:/tmp/promptly-db.dump (Join-Path $work "db.dump") | Out-Null
    docker compose exec -T postgres rm -f /tmp/promptly-db.dump | Out-Null
    if ((Get-Item (Join-Path $work "db.dump")).Length -eq 0) { Fail "The database dump is empty." }

    $uploads = Get-UploadsDir
    Say "2/4  Packing files ($uploads, data/whiteboard)"
    # Derived files, half-finished uploads and the scrubber's quarantine are
    # regenerable or not data — left out.
    $excludes = @("--exclude=uploads/.staging", "--exclude=uploads/derived", "--exclude=uploads/.quarantine", "--exclude=uploads/.tus", "--exclude=uploads/.imports")
    if ($running -contains "backend") {
        docker compose exec -T backend tar -C /app @excludes -cf /tmp/promptly-files.tar uploads whiteboard
        if ($LASTEXITCODE -ne 0) { Fail "Couldn't pack the files." }
        docker compose cp backend:/tmp/promptly-files.tar (Join-Path $work "files.tar") | Out-Null
        docker compose exec -T backend rm -f /tmp/promptly-files.tar | Out-Null
    } else {
        $full = (Resolve-Path $uploads).Path
        $parent = Split-Path $full -Parent
        $name = Split-Path $full -Leaf
        # bsdtar's -s renames the uploads folder to "uploads" inside the archive.
        tar @excludes -cf (Join-Path $work "files.tar") -C data whiteboard -C $parent -s "|^$name|uploads|" $name
        if ($LASTEXITCODE -ne 0) { Fail "Couldn't pack the files." }
    }

    Say "3/4  Copying .env and writing the manifest"
    Copy-Item .env (Join-Path $work "env")
    $rev = docker compose exec -T postgres psql -U promptly -d promptly -tAc "select version_num from alembic_version" 2>$null
    $ver = if (Test-Path VERSION) { (Get-Content VERSION -Raw).Trim() } else { "unknown" }
    $sha = git rev-parse --short HEAD 2>$null
    @("created_utc=$ts", "version=$ver", "git_commit=$sha", "schema_revision=$rev") |
        Set-Content -Encoding ascii (Join-Path $work "MANIFEST")

    Say "4/4  Writing the archive"
    New-Item -ItemType Directory -Force $OutDir | Out-Null
    $archive = Join-Path $OutDir "promptly-backup-$ts.tar"
    tar -C $work -cf $archive MANIFEST db.dump files.tar env
    if ($LASTEXITCODE -ne 0) { Fail "Couldn't write the archive." }
    # Readable by you only.
    icacls $archive /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null

    $mb = [math]::Round((Get-Item $archive).Length / 1MB, 1)
    Write-Host "Backup written: $archive ($mb MB)" -ForegroundColor Green
    Write-Host "It contains your .env secrets. Copy it off this machine, and keep it private."
} finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
