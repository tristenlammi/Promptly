# ============================================================
# Promptly - one-shot install (Windows / PowerShell)
#
# This is the *only* script you need to run. Everything else
# (admin account, public domain, model providers, push notifications)
# is configured through the first-run wizard in your browser after
# this completes.
#
# Usage from the repo root:
#   .\install.ps1               # cloud-first: bring your API keys (set in
#                               # the setup wizard). Auto-detects and uses a
#                               # native Ollama if one runs on the host.
#   .\install.ps1 -WithOllama   # also bundle an Ollama container for local
#                               # models (NVIDIA -> CUDA via WSL2, else CPU;
#                               # a native host Ollama is usually faster).
#   .\install.ps1 -NoSearch     # skip the bundled SearXNG container - web
#                               # search stays off until you add Brave/Tavily
#                               # keys in the admin panel.
#
# The choice persists in COMPOSE_PROFILES in .env, so a plain
# `docker compose up -d` keeps honouring it. Re-run with a flag to change it.
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
    [switch]$WithOllama,
    [switch]$NoSearch,
    # Back-compat: -NoOllama is now the default, -Minimal == -NoSearch.
    [switch]$NoOllama,
    [switch]$Minimal
)

if ($Minimal) { $NoSearch = $true }
$ProfileFlagsGiven = $WithOllama -or $NoSearch -or $NoOllama -or $Minimal

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

function Write-Section($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)      { Write-Host "  OK  $msg" -ForegroundColor Green }
function Write-Skip($msg)    { Write-Host "  SKIP $msg" -ForegroundColor Yellow }
function Write-Fail($msg)    { Write-Host "  ERR $msg" -ForegroundColor Red }

# ---------- 1. prerequisite checks ----------
Write-Section "Checking prerequisites"
# Native commands don't throw when they fail - check $LASTEXITCODE.
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker isn't installed. Install Docker Desktop from https://www.docker.com/products/docker-desktop/"
}
docker info *> $null
if ($LASTEXITCODE -ne 0) { throw "The Docker daemon isn't reachable. Start Docker Desktop and try again." }

$composeVer = (docker compose version --short 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $composeVer) { throw "docker compose v2 is not available. Update Docker Desktop." }
# The compose file needs >= 2.24 (optional env_file / depends_on entries).
$composeNum = ($composeVer -replace '^v', '') -replace '[^0-9.].*$', ''
if ([version]$composeNum -lt [version]"2.24.0") {
    throw "docker compose $composeVer is too old (need 2.24 or newer). Update Docker Desktop."
}

Write-Ok "Docker and docker compose v2 detected"

function New-HexSecret([int]$Bytes) {
    $buf = New-Object byte[] $Bytes
    # RandomNumberGenerator::Fill only exists on PowerShell 7 (.NET Core);
    # Create().GetBytes() works on the Windows PowerShell 5.1 that ships
    # with Windows too.
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buf) } finally { $rng.Dispose() }
    -join ($buf | ForEach-Object { $_.ToString('x2') })
}

# ---------- 2. .env bootstrap ----------
# A brand-new .env copies COMPOSE_PROFILES from the example, so "the line is
# missing" can't be how a first install is recognised.
$FreshEnv = -not (Test-Path ".env")
if ($FreshEnv) {
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
Set-IfPlaceholder ([ref]$envText) "SETUP_TOKEN"       (New-HexSecret 6)
Set-IfPlaceholder ([ref]$envText) "TUS_HOOK_SECRET"   (New-HexSecret 32)

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

# Ollama mode. Default: no bundled container — cloud-first, or wire to a
# native host Ollama if one's running (better GPU support than the
# container on every platform). -WithOllama bundles a container instead:
# NVIDIA accelerates via the WSL2 backend; AMD/Intel run CPU (Docker on
# Windows can't pass those GPUs into a Linux container).
#   cloud    no Ollama; connect providers in the wizard
#   host     native host Ollama detected -> wire OLLAMA_URL
#   bundled  -WithOllama: run a container (gpu or ollama[cpu])
$OllamaMode  = "cloud"
$OllamaLabel = "cloud providers only (connect your API keys in the wizard)"
$OllamaNote  = $null
$OllamaProfile = $null
function Test-HostOllama {
    if (Get-Command ollama -ErrorAction SilentlyContinue) { return $true }
    try {
        Invoke-WebRequest -Uri "http://127.0.0.1:11434/api/version" -TimeoutSec 2 -UseBasicParsing | Out-Null
        return $true
    } catch { return $false }
}
if ($WithOllama) {
    $OllamaMode = "bundled"
    $hasNvidia = $false
    if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
        try { nvidia-smi -L *> $null; $hasNvidia = ($LASTEXITCODE -eq 0) } catch {}
    }
    if ($hasNvidia) {
        $OllamaProfile = "gpu"
        $OllamaLabel   = "bundled container - NVIDIA GPU (CUDA via WSL2)"
    } else {
        $OllamaProfile = "ollama"
        $OllamaLabel   = "bundled container - CPU"
        $hasAmd = [bool](Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match "AMD|Radeon" })
        if ($hasAmd) {
            $OllamaNote = "AMD GPU can't be accelerated in Docker on Windows. For Radeon speed, install Ollama natively (ollama.com) and re-run WITHOUT -WithOllama."
        }
    }
} elseif (Test-HostOllama) {
    $OllamaMode  = "host"
    $OllamaLabel = "native host Ollama (detected on :11434)"
} else {
    $OllamaNote = "Want local models? Install Ollama natively (https://ollama.com) and re-run, or use -WithOllama to bundle it."
}

$profiles = @()
if ($OllamaMode -eq "bundled") { $profiles += $OllamaProfile }
if (-not $NoSearch) { $profiles += "search" }
$profilesCsv = $profiles -join ","

if ($ProfileFlagsGiven -or $FreshEnv -or ($envText -notmatch "(?m)^COMPOSE_PROFILES=")) {
    Write-Section "Configuring optional services"
    Set-EnvLine ([ref]$envText) "COMPOSE_PROFILES" $profilesCsv
    Set-EnvLine ([ref]$envText) "SEARXNG_ENABLED" $(if ($NoSearch) { "false" } else { "true" })
    Write-Ok "Ollama: $OllamaLabel"
    if ($OllamaNote) { Write-Skip $OllamaNote }
    if ($NoSearch) { Write-Skip "-NoSearch: bundled SearXNG disabled (add Brave/Tavily keys in the admin panel for web search)" }
    Write-Ok "COMPOSE_PROFILES=$(if ($profilesCsv) { $profilesCsv } else { '<none>' })"
} else {
    Write-Skip "COMPOSE_PROFILES already set, leaving untouched (re-run with -WithOllama/-NoSearch to change)"
}

# A host Ollama is wired whenever one is detected and nothing is set yet -
# not only when the profile block runs.
if ($OllamaMode -eq "host" -and $envText -notmatch "(?m)^OLLAMA_URL=") {
    Set-EnvLine ([ref]$envText) "OLLAMA_URL" "http://host.docker.internal:11434"
    Write-Ok "OLLAMA_URL -> the Ollama running on this machine"
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
$usePort  = if ($portLine) { $portLine.Substring(16).Trim() } else { "" }
if (-not $usePort) { $usePort = "8087" }
$setupLine = (Get-Content ".env" | Where-Object { $_ -match "^SETUP_TOKEN=" } | Select-Object -First 1)
$setupCode = if ($setupLine) { $setupLine.Substring(12).Trim() } else { "" }
$lanIp = $null
try {
    $lanIp = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
        Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" -and
                       $_.InterfaceAlias -notmatch "vEthernet|WSL|Loopback|Docker" } |
        Select-Object -First 1 -ExpandProperty IPAddress
} catch {}

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host " Promptly is up. " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Open in your browser:"
$suffix = if ($usePort -eq "80") { "" } else { ":$usePort" }
Write-Host "    http://localhost$suffix"
if ($lanIp) { Write-Host "    http://$lanIp$suffix   (from other devices on your network)" }
Write-Host ""
if ($setupCode -and -not $setupCode.StartsWith("change-me")) {
    Write-Host "  Setup code (asked for when you create the admin account): " -NoNewline
    Write-Host $setupCode -ForegroundColor Yellow
    Write-Host ""
}
Write-Host "  The setup wizard walks you through your admin account, a model"
Write-Host "  provider, the public URL, embeddings, email and two-step verification."
if ($OllamaMode -eq "cloud") {
    Write-Host ""
    Write-Skip "No local-model runtime. Connect a cloud provider (OpenAI, Anthropic, OpenRouter, ...) in the wizard. For local models, install Ollama natively and re-run, or use -WithOllama."
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
