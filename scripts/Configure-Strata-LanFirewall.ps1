param(
    [string]$NasLanIp = '192.168.0.198',
    [int]$Port = 8082,
    [string]$Label = 'Strata API'
)

$ErrorActionPreference = 'Stop'
try { $parsed = [System.Net.IPAddress]::Parse($NasLanIp) }
catch { throw 'Invalid NAS LAN IP' }
if ($parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { throw 'Expected IPv4 address' }
$name = "$Label $Port (NAS LAN)"
$existing = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
if ($existing) { Remove-NetFirewallRule -DisplayName $name }
New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Enabled True -Profile Any `
    -Protocol TCP -LocalPort $Port -RemoteAddress $NasLanIp -ErrorAction Stop | Out-Null
Write-Host "TCP $Port allowed from NAS LAN address $NasLanIp."
