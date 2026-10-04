$ErrorActionPreference = 'Stop'
$name = 'Strata API 8082 (Tailscale only)'
$adapter = Get-NetAdapter -Name 'Tailscale' -ErrorAction Stop
if ($adapter.Status -ne 'Up') { throw 'Tailscale adapter is not up' }

$existing = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
if ($existing) { Remove-NetFirewallRule -DisplayName $name }
New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Enabled True -Profile Any -Protocol TCP -LocalPort 8082 -InterfaceAlias 'Tailscale' -RemoteAddress '100.64.0.0/10' -ErrorAction Stop | Out-Null
Write-Host 'TCP 8082 allowed only from Tailscale IPv4 peers on the Tailscale adapter.'
