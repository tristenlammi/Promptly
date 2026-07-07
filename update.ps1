# ============================================================
# Promptly - one-command update (Windows / PowerShell)
#
#   .\update.ps1
#
# Pulls the latest code, rebuilds images, recreates changed
# services, reloads nginx, and waits for health. Safe to re-run.
#
# See update.sh for the rationale (profiles are honoured so
# SearXNG/Ollama aren't orphaned; nginx.conf is reloaded because
# it's bind-mounted; nginx upstreams re-resolve dynamically so no
# nginx restart is needed when backend/frontend/collab recreate).
# ============================================================
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

function Write-Section($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Write-Ok($m)      { Write-Host "  OK  $m" -ForegroundColor Green }
function Write-Fail($m)    { Write-Host "  ERR $m" -ForegroundColor Red }

if (-not (Test-Path ".env")) {
    throw "No .env found - run .\install.ps1 first."
}

Write-Section "1/5  Pulling latest code"
git pull --ff-only
if ($LASTEXITCODE -ne 0) { throw "git pull failed" }

Write-Section "2/5  Building images"
docker compose build
if ($LASTEXITCODE -ne 0) { throw "docker compose build failed" }

Write-Section "3/5  Applying updates"
# --remove-orphans is safe: COMPOSE_PROFILES in .env keeps SearXNG/Ollama in
# the active set so they aren't treated as orphans.
docker compose up -d --remove-orphans
if ($LASTEXITCODE -ne 0) { throw "docker compose up failed" }

Write-Section "4/5  Reloading nginx config"
# nginx isn't rebuilt (stock image + bind-mounted config), so a config change
# only lands on reload. Fall back to a restart if the reload can't run.
docker compose exec -T nginx nginx -t 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
    docker compose exec -T nginx nginx -s reload 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { docker compose restart nginx }
} else {
    docker compose restart nginx
}

Write-Section "5/5  Waiting for the backend to become healthy"
$healthy = $false
for ($i = 0; $i -lt 90; $i++) {
    $status = (docker inspect -f '{{.State.Health.Status}}' Promptly-Backend 2>$null)
    if ($status -eq "healthy") { Write-Ok "backend healthy"; $healthy = $true; break }
    Write-Host "." -NoNewline
    Start-Sleep -Seconds 2
}
Write-Host ""

if (-not $healthy) {
    Write-Fail "backend didn't become healthy - recent logs:"
    docker compose logs --tail=40 backend
    exit 1
}

Write-Host ""
docker compose ps
Write-Host ""
Write-Host "Update complete." -ForegroundColor Green
