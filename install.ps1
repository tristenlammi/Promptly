# ============================================================
# Promptly - one-shot install (Windows / PowerShell)
#
# This is the *only* script you need to run. Everything else
# (admin account, public domain, model providers, push notifications)
# is configured through the first-run wizard in your browser after
# this completes.
#
# Usage from the repo root:
#   .\install.ps1              # full stack (chat, web search, local Ollama)
#   .\install.ps1 -NoOllama    # skip the bundled Ollama container - for
#                              # hosts that already run Ollama (set
#                              # OLLAMA_URL in .env), or that don't want
#                              # local models at all.
#   .\install.ps1 -NoSearch    # skip the bundled SearXNG container -
#                              # web search stays off until you add
#                              # Brave/Tavily keys in the admin panel.
#   .\install.ps1 -Minimal     # both of the above.
#
# The choice persists: it's written to COMPOSE_PROFILES in .env, so a
# plain `docker compose up -d` keeps honouring it. Re-run with a flag
# to change your mind later.
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
    [switch]$Minimal,
    [switch]$NoOllama,
    [switch]$NoSearch
)

if ($Minimal) { $NoOllama = $true; $NoSearch = $true }
$ProfileFlagsGiven = $Minimal -or $NoOllama -or $NoSearch

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

# ---------- 3. optional services (compose profiles) ----------
# COMPOSE_PROFILES in .env is the persistent source of truth: docker
# compose reads it on every invocation, so a plain `docker compose up -d`
# keeps honouring the install-time choice. Managed tokens: ollama, search.
# An operator-added "gpu" token is always preserved.
function Set-EnvLine([ref]$Text, [string]$Key, [string]$Value) {
    $pattern = "(?m)^$Key=.*$"
    if ($Text.Value -match $pattern) {
        $Text.Value = [regex]::Replace($Text.Value, $pattern, "$Key=$Value")
    } else {
        if (-not $Text.Value.EndsWith("`n")) { $Text.Value += "`n" }
        $Text.Value += "$Key=$Value`n"
    }
}

# Ollama hardware auto-detection. On Windows/Docker Desktop:
#   NVIDIA — accelerated inside the container via the WSL2 backend.
#   AMD    — Docker can't pass Radeon GPUs into Linux containers, but
#            Ollama's native WINDOWS build supports them: if a host
#            Ollama is present we wire the stack to it; otherwise CPU
#            with a hint.
#   else   — CPU container.
# Overridable by editing COMPOSE_PROFILES in .env
# (tokens: ollama = CPU, gpu = NVIDIA).
$OllamaVariant = "ollama"
$OllamaLabel   = "CPU (universal fallback)"
$OllamaNote    = $null
function Test-HostOllama {
    if (Get-Command ollama -ErrorAction SilentlyContinue) { return $true }
    try {
        Invoke-WebRequest -Uri "http://127.0.0.1:11434/api/version" -TimeoutSec 2 -UseBasicParsing | Out-Null
        return $true
    } catch { return $false }
}
if (-not $NoOllama) {
    $hasNvidia = $false
    if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
        try { nvidia-smi -L *> $null; $hasNvidia = ($LASTEXITCODE -eq 0) } catch {}
    }
    if ($hasNvidia) {
        $OllamaVariant = "gpu"
        $OllamaLabel   = "NVIDIA GPU (CUDA via WSL2)"
    } else {
        $hasAmd = [bool](Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match "AMD|Radeon" })
        if ($hasAmd -and (Test-HostOllama)) {
            $OllamaVariant = "host"
            $OllamaLabel   = "native host Ollama (Radeon acceleration)"
        } elseif ($hasAmd) {
            $OllamaNote = "AMD GPU detected. Docker can't accelerate it, but Ollama's Windows build can: install it from ollama.com, then re-run .\install.ps1 to wire it up."
        }
    }
}

$profiles = @()
if (-not $NoOllama -and $OllamaVariant -ne "host") { $profiles += $OllamaVariant }
if (-not $NoSearch) { $profiles += "search" }
$profilesCsv = $profiles -join ","

if ($ProfileFlagsGiven -or ($envText -notmatch "(?m)^COMPOSE_PROFILES=")) {
    Write-Section "Configuring optional services"
    Set-EnvLine ([ref]$envText) "COMPOSE_PROFILES" $profilesCsv
    Set-EnvLine ([ref]$envText) "SEARXNG_ENABLED" $(if ($NoSearch) { "false" } else { "true" })
    if (-not $NoOllama) {
        Write-Ok "Ollama: $OllamaLabel"
        if ($OllamaNote) { Write-Skip $OllamaNote }
        if ($OllamaVariant -eq "host" -and $envText -notmatch "(?m)^OLLAMA_URL=") {
            Set-EnvLine ([ref]$envText) "OLLAMA_URL" "http://host.docker.internal:11434"
        }
    }
    if ($NoOllama) { Write-Skip "-NoOllama: bundled Ollama disabled (set OLLAMA_URL in .env to use a host install)" }
    if ($NoSearch) { Write-Skip "-NoSearch: bundled SearXNG disabled (add Brave/Tavily keys in the admin panel for web search)" }
    Write-Ok "COMPOSE_PROFILES=$profilesCsv"
} else {
    Write-Skip "COMPOSE_PROFILES already set, leaving untouched (re-run with -NoOllama/-NoSearch/-Minimal to change)"
}

# Persist .env in LF mode (the Linux containers parse it).
$envText = $envText -replace "`r`n", "`n"
[System.IO.File]::WriteAllText((Join-Path $ScriptDir ".env"), $envText)

# ---------- 4. build + start ----------
Write-Section "Building images (first run can take 3-5 minutes)"
docker compose build
if ($LASTEXITCODE -ne 0) { throw "docker compose build failed" }

Write-Section "Starting the stack"
docker compose up -d
if ($LASTEXITCODE -ne 0) { throw "docker compose up failed" }

# ---------- 5. wait for backend health ----------
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

# ---------- 6. final report ----------
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
Write-Host "    4. (Optional) Protect the admin account with two-step verification."
if ($NoOllama) {
    Write-Host ""
    Write-Skip "Bundled Ollama is disabled. For local models/embeddings, set OLLAMA_URL in .env (e.g. http://host.docker.internal:11434) or re-run without -NoOllama."
}
if ($NoSearch) {
    Write-Host ""
    Write-Skip "Bundled web search (SearXNG) is disabled. Add a Brave or Tavily API key under Admin -> Settings to enable web search."
}
Write-Host ""
Write-Host "  Useful commands:"
Write-Host "    docker compose logs -f backend     # tail backend logs"
Write-Host "    docker compose ps                  # container health"
Write-Host "    docker compose down                # stop everything"
Write-Host ""
