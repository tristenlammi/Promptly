#!/usr/bin/env pwsh
# PowerShell front door for scripts/stack.sh (a separate copy of Promptly for
# a worktree, on its own port). Same arguments, e.g.
#
#   scripts/stack.ps1 up notes --with media
#   scripts/stack.ps1 ls
#   scripts/stack.ps1 e2e notes tests/chat.spec.ts
#   scripts/stack.ps1 down notes
#
# Runs it with Git Bash (not WSL's bash, which can't see Docker Desktop's
# Windows paths the same way).
$ErrorActionPreference = 'Stop'

$bash = $null
$candidates = @()
$git = Get-Command git -ErrorAction SilentlyContinue
if ($git) {
    $gitRoot = Split-Path (Split-Path $git.Source -Parent) -Parent
    $candidates += (Join-Path $gitRoot 'bin\bash.exe')
}
$candidates += (Join-Path $env:ProgramFiles 'Git\bin\bash.exe')
foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { $bash = $c; break }
}
if (-not $bash) { throw 'Git Bash not found (install Git for Windows).' }

# Forward slashes: bash's dirname doesn't split on backslashes.
$script = (Join-Path $PSScriptRoot 'stack.sh') -replace '\\', '/'
& $bash $script @args
exit $LASTEXITCODE
