# ============================================================
# Promptly - one-shot install (Windows / PowerShell)
#
# This is the *only* script you need to run. Everything else
# (admin account, public domain, model providers, push notifications)
# is configured through the first-run wizard in your browser after
# this completes.
#
# Usage from the repo root:
#   .\install.ps1              # full stack
#   .\install.ps1 -Minimal     # core only - skips SearXNG and the
#                              # bundled Ollama container
#
# If PowerShell refuses to run the script with an
# "execution policy" error, do this once in the same window:
#
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#
# That only unblocks scripts in the *current* PowerShell session,
# so you don't need to permanently weaken your machine policy.
# ============================================================
[CmdletBinding()]
param(
    [switch]$Minimal
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

function Write-Section($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)      { Write-Host "  OK  $msg" -ForegroundColor Green }
function Write-Skip($msg)    { Write-Host "  SKIP $msg" -ForegroundColor Yellow }
function Write-Fail($msg)    { Write-Host "  ERR $msg" -ForegroundColor Red }

# ---------- 1. prerequisite checks ----------
Write-Section "Checking prerequisites"
try { docker version --format '{{.Server.Version}}' | Out-Null }
catch { throw "Docker is not running or not installed. Install Docker Desktop from https://www.docker.com/products/docker-desktop/" }

try { docker compose version | Out-Null }
catch { throw "docker compose v2 is not available. Update Docker Desktop." }

try { docker info 2>$null | Out-Null }
catch { throw "The Docker daemon isn't reachable. Start Docker Desktop and try again." }

Write-Ok "Docker and docker compose v2 detected"

function New-HexSecret([int]$Bytes) {
    $buf = New-Object byte[] $Bytes
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($buf)
    -join ($buf | ForEach-Object { $_.ToString('x2') })
}

# ---------- 2. .env bootstrap ----------
if (-not (Test-Path ".env")) {
    Write-Section "Creating .env from .env.example"
    Copy-Item ".env.example" ".env"
}

Write-Section "Seeding secrets"
$envText = Get-Content ".env" -Raw

function Set-IfPlaceholder([ref]$Text, [string]$Key, [string]$Value) {
    $pattern = "(?m)^$Key=change-me.*$"
    if ($Text.Value -match $pattern) {
        $Text.Value = [regex]::Replace($Text.Value, $pattern, "$Key=$Value")
        Write-Ok "$Key generated"
    } else {
        Write-Skip "$Key already set, leaving untouched"
    }
}

Set-IfPlaceholder ([ref]$envText) "SECRET_KEY"        (New-HexSecret 32)
Set-IfPlaceholder ([ref]$envText) "SEARXNG_SECRET"    (New-HexSecret 32)
Set-IfPlaceholder ([ref]$envText) "POSTGRES_PASSWORD" (New-HexSecret 24)

# Persist .env in LF mode (the Linux containers parse it).
$envText = $envText -replace "`r`n", "`n"
[System.IO.File]::WriteAllText((Join-Path $ScriptDir ".env"), $envText)

# ---------- 3. build + start ----------
Write-Section "Building images (first run can take 3-5 minutes)"
docker compose build
if ($LASTEXITCODE -ne 0) { throw "docker compose build failed" }

Write-Section "Starting the stack"
if ($Minimal) {
    Write-Skip "--minimal: skipping searxng and ollama"
    docker compose up -d nginx frontend backend collab postgres redis
} else {
    docker compose up -d
}
if ($LASTEXITCODE -ne 0) { throw "docker compose up failed" }

# ---------- 4. wait for backend health ----------
Write-Section "Waiting for the backend to become healthy"
$healthy = $false
for ($i = 1; $i -le 90; $i++) {
    Start-Sleep -Seconds 2
    $json = docker compose ps --format json backend 2>$null
    if ($json -match '"Health":"healthy"') {
        Write-Host ""
        Write-Ok "backend is healthy"
        $healthy = $true
        break
    }
    if ($json -match '"Health":"unhealthy"') {
        Write-Host ""
        Write-Fail "backend reports unhealthy. Last 40 lines of logs:"
        docker compose logs --tail=40 backend
        exit 1
    }
    Write-Host "." -NoNewline
}

if (-not $healthy) {
    Write-Host ""
    Write-Fail "backend never became healthy after 3 minutes."
    Write-Fail "Last 60 lines of backend logs:"
    docker compose logs --tail=60 backend
    Write-Host ""
    Write-Fail "Common fixes:"
    Write-Fail "    * 'docker compose ps' to see which container is unhealthy."
    Write-Fail "    * 'docker compose down -v; .\install.ps1' for a clean wipe."
    exit 1
}

# ---------- 5. final report ----------
$portLine = (Get-Content ".env" | Where-Object { $_ -match "^NGINX_HTTP_PORT=" } | Select-Object -First 1)
$usePort  = if ($portLine) { $portLine.Substring(16) } else { "8087" }

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host " Promptly is up. " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Open in your browser:"
if ($usePort -eq "80") { Write-Host "    http://localhost" }
else                   { Write-Host "    http://localhost:$usePort" }
Write-Host ""
Write-Host "  The first visit will launch the setup wizard:"
Write-Host "    1. Create the bootstrap admin account."
Write-Host "    2. (Optional) Set the public URL people will reach Promptly on."
Write-Host "    3. (Optional) Pick how knowledge libraries get embedded."
Write-Host ""
Write-Host "  Useful commands:"
Write-Host "    docker compose logs -f backend     # tail backend logs"
Write-Host "    docker compose ps                  # container health"
Write-Host "    docker compose down                # stop everything"
Write-Host ""
