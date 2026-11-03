param([int]$Port = 11502)

$ErrorActionPreference = 'Stop'
$name = 'OPM model control 11502 (all sources)'
$existing = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
if ($existing) { Remove-NetFirewallRule -DisplayName $name }
New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Enabled True -Profile Any `
    -Protocol TCP -LocalPort $Port -RemoteAddress Any `
    -ErrorAction Stop | Out-Null
Write-Host "TCP $Port allowed from all remote addresses."
