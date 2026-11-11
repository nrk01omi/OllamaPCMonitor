param([ValidateSet('IQ2_XS', 'IQ3_XXS')][string]$Quant = 'IQ2_XS')
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Start-Strata-Managed.ps1') -Vision -Quant $Quant
if (-not $?) { exit 1 }
