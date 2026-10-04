$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Start-Strata-Managed.ps1') -Vision
if (-not $?) { exit 1 }
