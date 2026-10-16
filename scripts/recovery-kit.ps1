# ============================================================
# Promptly - recovery kit (Windows / PowerShell)
#
#   .\scripts\recovery-kit.ps1 [-OutFile <path>]   (default: .\promptly-recovery-kit.txt)
#
# Writes everything needed to get your data back on a new machine if this
# one is lost: where the off-site copies are, the password that decrypts
# them, the target's credentials, and SECRET_KEY. Keep it somewhere that
# ISN'T this machine (a password manager, or printed).
#
# Runs only on the host. Promptly never serves this over the web.
# ============================================================
param([string]$OutFile = "")
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root
if (-not $OutFile) { $OutFile = Join-Path $Root "promptly-recovery-kit.txt" }

$kit = docker compose exec -T backend python -m app.cli recovery-kit
if ($LASTEXITCODE -ne 0) { throw "Couldn't read the recovery kit - is Promptly running?" }
Set-Content -Path $OutFile -Value $kit -Encoding UTF8
# Readable by you only.
icacls $OutFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
Write-Host "Recovery kit written to $OutFile (readable by you only)."
Write-Host "Move it off this machine, then delete this copy."
