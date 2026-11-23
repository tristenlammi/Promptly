# ============================================================
# Promptly - one-shot install (Windows / PowerShell)
#
# This is the *only* script you need to run. Everything else
# (admin account, public domain, model providers, push notifications)
# is configured through the first-run wizard in your browser after
# this completes.
#
# Fresh machine, one line in PowerShell (needs Git and Docker Desktop;
# downloads the latest release into .\Promptly and installs it):
#   irm https://raw.githubusercontent.com/tristenlammi/Promptly/main/install.ps1 | iex
# The same, with options:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/tristenlammi/Promptly/main/install.ps1))) -NoMaps
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
#   .\install.ps1 -NoMaps       # skip P Maps. It's on by default, and builds
#                               # its map data in the background: about an hour
#                               # and 15 GB of disk (7 GB after).
#   .\install.ps1 -NoCalls      # skip the calls server (LiveKit) behind voice
#                               # channels in Rooms. On by default; voice stays
#                               # off for people until an admin turns it on.
#   .\install.ps1 -NoHome       # skip Promptly Home's bundled Home Assistant
#                               # (smart devices; about 3.5 GB of disk).
#   .\install.ps1 -NoStart      # set the folder up (.env, secrets, choices) but
#                               # don't build or start anything yet.
#
# One-line install only: $env:PROMPTLY_DIR (where to put it; default
# .\Promptly), $env:PROMPTLY_REF (a release tag or branch; default the latest
# release) and $env:PROMPTLY_REPO (where to download from).
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
    [switch]$NoMaps,
    [switch]$NoCalls,
    # Skip Promptly Home's bundled Home Assistant (smart devices; about 3.5 GB).
    [switch]$NoHome,
    # Set the folder up but don't build or start anything.
    [switch]$NoStart,
    # Back-compat: -NoOllama is now the default, -Minimal == -NoSearch.
    [switch]$NoOllama,
    [switch]$Minimal
)

if ($Minimal) { $NoSearch = $true }
$ProfileFlagsGiven = $WithOllama -or $NoSearch -or $NoMaps -or $NoCalls -or $NoHome -or $NoOllama -or $Minimal

function Write-Section($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)      { Write-Host "  OK  $msg" -ForegroundColor Green }
function Write-Skip($msg)    { Write-Host "  NOTE $msg" -ForegroundColor Yellow }
function Write-Fail($msg)    { Write-Host "  ERR $msg" -ForegroundColor Red }

# Run a program with whatever it prints on stderr thrown away. Windows
# PowerShell 5.1 turns redirected stderr into a terminating error when
# $ErrorActionPreference is Stop, so the preference is relaxed in here only.
function Invoke-Quiet([scriptblock]$Cmd) {
    $ErrorActionPreference = "Continue"
    & $Cmd 2>$null
}

# Promptly's containers have fixed names, so one Docker can run one install.
# Returns the folder of an install that already owns them, or $null.
function Get-OtherInstall([string]$Here) {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $null }
    # As JSON: Windows PowerShell 5.1 drops double quotes inside a program's
    # arguments, so a template that indexes the label by name can't be passed.
    $labels = Invoke-Quiet { docker inspect -f '{{json .Config.Labels}}' Promptly-Backend }
    if ($LASTEXITCODE -ne 0 -or -not $labels) { return $null }
    $dir = $null
    try { $dir = ("$labels" | ConvertFrom-Json).'com.docker.compose.project.working_dir' } catch { }
    if (-not $dir) { return $null }
    $dir = "$dir".Trim()
    if ($Here -and ($dir.TrimEnd('\', '/') -ieq $Here.TrimEnd('\', '/'))) { return $null }
    return $dir
}
function Write-OtherInstall([string]$Other) {
    Write-Fail "Promptly is already installed on this computer, in: $Other"
    Write-Host "      To move it to the newest version:  cd `"$Other`"; .\update.ps1"
    Write-Host "      One Docker can run one Promptly (its containers have fixed names), so a"
    Write-Host "      second install here would take over the first one's containers."
}

# ---------- 0. one-line install ----------
# Run from the web (irm ... | iex) or as a lone downloaded file: there is no
# Promptly folder around this script yet. Fetch the latest release into
# .\Promptly and run the install.ps1 in there. No `exit` and no Stop
# preference in this part: under iex both would hit the person's own window.
$ScriptDir = if ($PSCommandPath) { Split-Path -Parent $PSCommandPath } else { "" }
if (-not $ScriptDir -or -not (Test-Path (Join-Path $ScriptDir "docker-compose.yml"))) {
    $repo = if ($env:PROMPTLY_REPO) { $env:PROMPTLY_REPO } else { "https://github.com/tristenlammi/Promptly.git" }
    $ref  = $env:PROMPTLY_REF
    $dir  = if ($env:PROMPTLY_DIR) { $env:PROMPTLY_DIR } else { Join-Path (Get-Location).Path "Promptly" }
    Write-Host "Promptly installer" -ForegroundColor Cyan
    if ((Test-Path (Join-Path $dir "install.ps1")) -and (Test-Path (Join-Path $dir "docker-compose.yml"))) {
        Write-Skip "$dir is already there, so the install carries on in it."
    } else {
        if ((Test-Path $dir) -and (Get-ChildItem -Force $dir | Select-Object -First 1)) {
            Write-Fail "$dir already exists and isn't a Promptly folder."
            Write-Host "      Move it away, or choose another place first:  `$env:PROMPTLY_DIR = 'D:\somewhere\Promptly'"
            return
        }
        $missing = $false
        if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
            Write-Fail "Git isn't installed. It downloads Promptly now and updates it later. Get it with:"
            Write-Host "          winget install --id Git.Git -e"
            Write-Host "      (or https://git-scm.com/download/win), then open a NEW PowerShell window."
            $missing = $true
        }
        if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
            Write-Fail "Docker isn't installed. Promptly runs in Docker Desktop. Get it with:"
            Write-Host "          winget install --id Docker.DockerDesktop -e"
            Write-Host "      (or https://www.docker.com/products/docker-desktop/), start it, wait until it"
            Write-Host "      says it's running, then open a NEW PowerShell window."
            $missing = $true
        }
        if ($missing) { Write-Host "      Then run this installer again."; return }
        if (-not $NoStart) {
            $other = Get-OtherInstall ""
            if ($other) { Write-OtherInstall $other; return }
        }
        if (-not $ref) {
            # Newest vX.Y.Z tag. No tags (a fork, a mirror): the default branch.
            $ref = git ls-remote --tags --refs $repo "v[0-9]*" |
                ForEach-Object { ($_ -split "refs/tags/")[-1].Trim() } |
                Where-Object { $_ -match '^v\d+\.\d+\.\d+$' } |
                Sort-Object { [version]$_.Substring(1) } | Select-Object -Last 1
        }
        Write-Host "  Downloading Promptly $(if ($ref) { $ref } else { '(newest)' }) into $dir"
        if ($ref) { git -c advice.detachedHead=false clone --branch $ref $repo $dir }
        else      { git clone $repo $dir }
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $dir "install.ps1"))) {
            Write-Fail "The download didn't work (git's message is above). Check the internet connection"
            Write-Host "      and that this folder can be written to, then try again."
            return
        }
        Write-Ok "Downloaded"
    }
    $flags = @()
    foreach ($name in "WithOllama", "NoSearch", "NoMaps", "NoCalls", "NoHome", "NoStart", "NoOllama", "Minimal") {
        if ((Get-Variable -Name $name -ValueOnly -ErrorAction SilentlyContinue)) { $flags += "-$name" }
    }
    # A new process: scripts on disk are blocked by the default execution
    # policy, and the main script may `exit`.
    $psExe = (Get-Process -Id $PID).Path
    & $psExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir "install.ps1") @flags
    if ($LASTEXITCODE -eq 0) { Set-Location $dir }
    return
}

$ErrorActionPreference = "Stop"
Set-Location $ScriptDir

# ---------- 1. prerequisite checks ----------
Write-Section "Checking prerequisites"
# Native commands don't throw when they fail - check $LASTEXITCODE.
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker isn't installed. Install Docker Desktop (winget install --id Docker.DockerDesktop -e, or https://www.docker.com/products/docker-desktop/), start it, then open a new PowerShell window and run this again."
}
Invoke-Quiet { docker info } | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Docker is installed but isn't running. Start Docker Desktop, wait until it says it's running, and run this again." }

$composeVer = (Invoke-Quiet { docker compose version --short })
if ($LASTEXITCODE -ne 0 -or -not $composeVer) { throw "This Docker has no 'docker compose' (version 2). Update Docker Desktop." }
# The compose file needs >= 2.24 (optional env_file / depends_on entries).
$composeNum = ($composeVer -replace '^v', '') -replace '[^0-9.].*$', ''
if ([version]$composeNum -lt [version]"2.24.0") {
    throw "docker compose $composeVer is too old (need 2.24 or newer). Update Docker Desktop."
}

Write-Ok "Docker and docker compose are ready"

# Memory: what Docker Desktop has been given, not what the PC has. A warning
# the person can act on, not a stop.
$dockerMem = 0
try { $dockerMem = [int64](Invoke-Quiet { docker info --format '{{.MemTotal}}' }) } catch { }
if (-not $NoStart -and $dockerMem -gt 0 -and $dockerMem -lt 7.2GB) {
    Write-Skip "Docker has about $([math]::Round($dockerMem / 1GB)) GB of memory here. Promptly needs 8 GB (16 GB is comfortable); with less, the build or the app itself can run out and stop. Docker Desktop: Settings -> Resources (or memory= in .wslconfig)."
}

$FreshEnv = -not (Test-Path ".env")
if ($FreshEnv -and -not $NoStart) {
    $other = Get-OtherInstall $ScriptDir
    if ($other) { Write-OtherInstall $other; exit 1 }
}

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
# An .env from before this existed has no such line (or an empty one): add it.
foreach ($k in @("TUS_HOOK_SECRET")) {
    if ($envText -notmatch "(?m)^$k=.") {
        $envText = [regex]::Replace($envText, "(?m)^$k=\r?\n", "")
        if (-not $envText.EndsWith("`n")) { $envText += "`n" }
        $envText += "$k=change-me`n"
    }
}
Set-IfPlaceholder ([ref]$envText) "TUS_HOOK_SECRET"   (New-HexSecret 32)
# Promptly Home: what its bundled home box proves itself with. Made with
# -NoHome too: the update script turns Home on for an install that has no
# secret yet, and someone who said -NoHome shouldn't get it at the next
# update. (To add Home later: .\install.ps1 with the other flags you used.)
if ($envText -notmatch "(?m)^HOME_BOX_SECRET=.") {
    $envText = [regex]::Replace($envText, "(?m)^HOME_BOX_SECRET=\s*\r?\n", "")
    if ($envText -and -not $envText.EndsWith("`n")) { $envText += "`n" }
    $envText += "HOME_BOX_SECRET=change-me`n"
}
Set-IfPlaceholder ([ref]$envText) "HOME_BOX_SECRET" (New-HexSecret 32)
# Calls (LiveKit). An .env from before Calls has no such lines: add them.
foreach ($k in @("LIVEKIT_API_KEY", "LIVEKIT_API_SECRET")) {
    if ($envText -notmatch "(?m)^$k=") {
        if (-not $envText.EndsWith("`n")) { $envText += "`n" }
        $envText += "$k=change-me`n"
    }
}
Set-IfPlaceholder ([ref]$envText) "LIVEKIT_API_KEY"    ("API" + (New-HexSecret 8))
Set-IfPlaceholder ([ref]$envText) "LIVEKIT_API_SECRET" (New-HexSecret 32)

# ---------- 3. optional services (compose profiles) ----------
# COMPOSE_PROFILES in .env is the persistent source of truth: docker
# compose reads it on every invocation, so a plain `docker compose up -d`
# keeps honouring the install-time choice. Managed tokens: ollama, search, maps.
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

# Ollama mode. Default: no bundled container - cloud-first, or wire to a
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
        try { Invoke-Quiet { nvidia-smi -L } | Out-Null; $hasNvidia = ($LASTEXITCODE -eq 0) } catch {}
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
if (-not $NoMaps) { $profiles += "maps" }
# Calls: Docker Desktop has no host networking, so the bridged LiveKit
# variant runs (media ports published, this PC's LAN address advertised).
if (-not $NoCalls) { $profiles += "calls-desktop" }
# Promptly Home: the bridged variant (Docker Desktop can't share the host's
# network, so devices are added by brand with their address).
if (-not $NoHome) { $profiles += "home-desktop" }
$profilesCsv = $profiles -join ","

if ($ProfileFlagsGiven -or $FreshEnv -or ($envText -notmatch "(?m)^COMPOSE_PROFILES=")) {
    Write-Section "Configuring optional services"
    Set-EnvLine ([ref]$envText) "COMPOSE_PROFILES" $profilesCsv
    Set-EnvLine ([ref]$envText) "SEARXNG_ENABLED" $(if ($NoSearch) { "false" } else { "true" })
    Write-Ok "Ollama: $OllamaLabel"
    if ($OllamaNote) { Write-Skip $OllamaNote }
    if ($NoSearch) { Write-Skip "-NoSearch: bundled SearXNG disabled (add Brave/Tavily keys in the admin panel for web search)" }
    Write-Ok "COMPOSE_PROFILES=$(if ($profilesCsv) { $profilesCsv } else { '<none>' })"
    if (-not $NoCalls -and $envText -notmatch "(?m)^LIVEKIT_NODE_IP=") {
        $callsIp = $null
        try {
            $callsIp = (Get-NetIPConfiguration -ErrorAction Stop |
                Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq "Up" } |
                Select-Object -First 1).IPv4Address.IPAddress
        } catch { }
        if ($callsIp) {
            Set-EnvLine ([ref]$envText) "LIVEKIT_NODE_IP" $callsIp
            Write-Ok "Calls: advertising this computer's LAN address $callsIp"
        } else {
            Write-Skip "Calls: couldn't find this computer's LAN address; set LIVEKIT_NODE_IP in .env"
        }
    }
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
if ($NoStart) {
    Write-Host ""
    Write-Host "The folder is set up; nothing was built or started (-NoStart)." -ForegroundColor Green
    Write-Host "  Settings are in $(Join-Path $ScriptDir '.env') (the web port is NGINX_HTTP_PORT)."
    Write-Host "  When you're ready:  cd `"$ScriptDir`"; .\install.ps1"
    exit 0
}

$portLine = (Get-Content ".env" | Where-Object { $_ -match "^NGINX_HTTP_PORT=" } | Select-Object -First 1)
$usePort  = if ($portLine) { $portLine.Substring(16).Trim() } else { "" }
if (-not $usePort) { $usePort = "8087" }

Write-Section "Building Promptly (about 10 minutes the first time, longer on a slow connection)"
Write-Host "  A lot of text scrolls past, some of it marked WARNING. That is normal."
docker compose build
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Fail "The build stopped before it finished (the reason is in the lines above)."
    Write-Host "      * Internet dropped or a download timed out: run .\install.ps1 again in"
    Write-Host "        $ScriptDir - it carries on from where it stopped."
    Write-Host "      * 'no space left on device': free some disk, or give Docker Desktop a bigger"
    Write-Host "        disk (Settings -> Resources). A full install needs about 25 GB."
    exit 1
}

Write-Section "Starting Promptly (downloads a few more parts, then starts everything)"
docker compose up -d
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Fail "Promptly didn't start (the reason is in the lines above)."
    Write-Host "      * 'port is already allocated' / 'address already in use': another program has"
    Write-Host "        that port. For the web port, change NGINX_HTTP_PORT (now $usePort) in"
    Write-Host "        $(Join-Path $ScriptDir '.env') and run .\install.ps1 again."
    Write-Host "      * Anything else: run .\install.ps1 again; 'docker compose ps' shows what is unhealthy."
    exit 1
}

# A part switched off by a flag on a re-run: its container is still running
# (compose only starts things), so stop it.
if ($ProfileFlagsGiven -and -not $FreshEnv) {
    $active = @(Invoke-Quiet { docker compose config --services })
    foreach ($svc in @(Invoke-Quiet { docker compose --profile '*' ps --services })) {
        if ($svc -and ($active -notcontains $svc)) {
            Invoke-Quiet { docker compose --profile '*' rm -sf $svc } | Out-Null
            if ($LASTEXITCODE -eq 0) { Write-Skip "Stopped $svc (switched off)" }
        }
    }
}

# ---------- 5. wait for backend health ----------
Write-Section "Waiting for Promptly to answer"
$healthy = $false
for ($i = 1; $i -le 150; $i++) {
    Start-Sleep -Seconds 2
    $json = Invoke-Quiet { docker compose ps --format json backend }
    if ($json -match '"Health":"healthy"') {
        Write-Host ""
        Write-Ok "Promptly is answering"
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
    Write-Fail "backend never became healthy after 5 minutes."
    Write-Fail "Last 60 lines of backend logs:"
    docker compose logs --tail=60 backend
    Write-Host ""
    Write-Fail "Common fixes:"
    Write-Fail "    * 'docker compose ps' to see which container is unhealthy."
    Write-Fail "    * 'docker compose down -v; .\install.ps1' for a clean wipe."
    exit 1
}

# ---------- 6. final report ----------
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
if ((Get-Content .env -Raw) -match "(?m)^COMPOSE_PROFILES=.*maps") {
    Write-Host ""
    Write-Skip "P Maps is building Australia's map data in the background: about an hour and 15 GB of disk (7 GB after). Everything else works meanwhile. For another country, or to turn it off, see 'P Maps' in .env."
}
if ((Get-Content .env -Raw) -match "(?m)^COMPOSE_PROFILES=.*calls") {
    Write-Host ""
    Write-Skip "Voice channels: turn them on in Admin -> Calls. For voice from outside your home, forward UDP 7882 and TCP 7881 on your router to this computer, and allow them through Windows Firewall."
}
if ($NoSearch) {
    Write-Host ""
    Write-Skip "Bundled web search (SearXNG) is disabled. Add a Brave or Tavily API key under Admin -> Settings to enable web search."
}
Write-Host ""
Write-Host "  Promptly lives in $ScriptDir. From that folder:"
Write-Host "    .\update.ps1                       # move to the newest version (backs up first)"
Write-Host "    docker compose ps                  # is everything running?"
Write-Host "    docker compose logs -f backend     # watch what the app is doing"
Write-Host "    docker compose down                # stop everything (docker compose up -d starts it again)"
Write-Host "  It starts by itself whenever Docker Desktop is running."
Write-Host ""
