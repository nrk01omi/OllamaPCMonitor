param([int]$Port = 8082, [switch]$Open)

# Experimental 512K context: YaRN 2x and Q4 KV cache. Requires substantial free RAM.
$config = 'C:\Apps\Strata\strata-iq2_xs-vision-512k.json'
& (Join-Path $PSScriptRoot 'Start-Strata.ps1') -ContextSize 524288 -Port $Port -ConfigPath $config -Open:$Open
exit $LASTEXITCODE
