# ============================================================
# Promptly - one-shot install (Windows / PowerShell)
#
# Mirrors scripts/setup.sh for Windows hosts running Docker
# Desktop. Use the .sh script on Linux servers.
#
# Usage from the repo root:
#   .\scripts\setup.ps1                    # local install
#   .\scripts\setup.ps1 chat.example.com   # production install
# ============================================================
param(
    [string]$Domain = ""
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Resolve-Path (Join-Path $ScriptDir "..")
Set-Location $RootDir

function Write-Section($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)      { Write-Host "  OK  $msg" -ForegroundColor Green }
function Write-Skip($msg)    { Write-Host "  SKIP $msg" -ForegroundColor Yellow }

# ---------- 1. prerequisite checks ----------
Write-Section "Checking prerequisites"
try { docker version --format '{{.Server.Version}}' | Out-Null }
catch { throw "Docker is not running or not installed. Install Docker Desktop from https://www.docker.com/products/docker-desktop/" }

try { docker compose version | Out-Null }
catch { throw "docker compose v2 is not available. Update Docker Desktop." }

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

# ---------- 3. domain ----------
if ($Domain -ne "") {
    Write-Section "Setting DOMAIN to $Domain"
    if ($envText -match "(?m)^DOMAIN=.*$") {
        $envText = [regex]::Replace($envText, "(?m)^DOMAIN=.*$", "DOMAIN=$Domain")
    } else {
        $envText = $envText.TrimEnd() + "`nDOMAIN=$Domain`n"
    }
}

# Persist .env in LF mode (the Linux containers parse it).
$envText = $envText -replace "`r`n", "`n"
[System.IO.File]::WriteAllText((Join-Path $RootDir ".env"), $envText)

# ---------- 4. build + start ----------
Write-Section "Building images (first run can take 3-5 minutes)"
docker compose build
if ($LASTEXITCODE -ne 0) { throw "docker compose build failed" }

Write-Section "Starting the stack"
docker compose up -d
if ($LASTEXITCODE -ne 0) { throw "docker compose up failed" }

# ---------- 5. wait for backend health ----------
Write-Section "Waiting for the backend to become healthy"
for ($i = 1; $i -le 60; $i++) {
    Start-Sleep -Seconds 2
    $json = docker compose ps --format json backend 2>$null
    if ($json -match '"Health":"healthy"') {
        Write-Ok "backend is healthy"
        break
    }
    Write-Host "." -NoNewline
}
Write-Host ""

# ---------- 6. final report ----------
$domainLine = (Get-Content ".env" | Where-Object { $_ -match "^DOMAIN=" } | Select-Object -First 1)
$portLine   = (Get-Content ".env" | Where-Object { $_ -match "^NGINX_HTTP_PORT=" } | Select-Object -First 1)
$useDomain  = if ($domainLine) { $domainLine.Substring(7) } else { "localhost" }
$usePort    = if ($portLine)   { $portLine.Substring(16) } else { "8087" }

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host " Promptly is up. " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Open in your browser:"
if ($useDomain -eq "localhost" -or $useDomain -eq "") {
    if ($usePort -eq "80") { Write-Host "    http://localhost" }
    else                   { Write-Host "    http://localhost:$usePort" }
} else {
    if ($usePort -eq "80") { Write-Host "    http://$useDomain" }
    else                   { Write-Host "    http://${useDomain}:$usePort" }
    Write-Host ""
    Write-Host "  (Front it with Cloudflare Tunnel, Caddy, or a TLS-terminating"
    Write-Host "   reverse proxy for HTTPS - see README.md > 'TLS termination'.)"
}
Write-Host ""
Write-Host "  The first visit will launch the setup wizard to create"
Write-Host "  the bootstrap admin account."
Write-Host ""
Write-Host "  Useful commands:"
Write-Host "    docker compose logs -f backend     # tail backend logs"
Write-Host "    docker compose ps                  # container health"
Write-Host "    docker compose down                # stop everything"
Write-Host ""
