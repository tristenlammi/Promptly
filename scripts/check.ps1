#!/usr/bin/env pwsh
# Promptly's pre-release check (see scripts/check.mjs for the options).
#   scripts\check.ps1                      everything (about an hour)
#   scripts\check.ps1 -Quick               everything but the browser suite (about 11 minutes)
#   scripts\check.ps1 -Only backend        one step
#   scripts\check.ps1 -Only e2e            the browser suite alone (it adds up with an earlier -Quick on the same code)
param(
    [string]$Only = "",
    [string]$Skip = "",
    [string]$With = "",
    [int]$Workers = 0,
    [string]$Tests = "",
    [switch]$Quick,
    [switch]$List,
    [switch]$Gate
)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "node isn't installed (the frontend needs it too)." -ForegroundColor Red
    exit 2
}
$a = @((Join-Path $PSScriptRoot 'check.mjs'))
if ($Only) { $a += @('--only', $Only) }
if ($Skip) { $a += @('--skip', $Skip) }
if ($With) { $a += @('--with', $With) }
if ($Workers -gt 0) { $a += @('--workers', "$Workers") }
if ($Tests) { $a += @('--tests', $Tests) }
if ($Quick) { $a += '--quick' }
if ($List) { $a += '--list' }
if ($Gate) { $a += '--gate' }
& node @a
exit $LASTEXITCODE
