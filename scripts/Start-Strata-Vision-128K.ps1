param([int]$Port = 8082, [switch]$Open)

# Separate vision-enabled config; the text-only Strata config remains intact.
$config = 'C:\Apps\Strata\strata-iq2_xs-vision-128k.json'
& (Join-Path $PSScriptRoot 'Start-Strata.ps1') -ContextSize 131072 -Port $Port -ConfigPath $config -Open:$Open
exit $LASTEXITCODE
