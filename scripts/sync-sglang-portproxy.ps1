$ErrorActionPreference = 'Stop'

# WSL2 uses a dynamic NAT address. Refresh Windows' listeners every time a
# SGLang model is started so LAN and Tailscale callers keep reaching WSL2.
$distro = 'Ubuntu-22.04-RAG'
$ports = @(30000, 30001)
$rawIps = (& wsl.exe -d $distro -- hostname -I).Trim()
$wslIp = $rawIps -split '\s+' | Where-Object { $_ -match '^172\.' } | Select-Object -First 1
if (-not $wslIp) { throw "Could not determine the WSL2 IPv4 address for '$distro'." }

foreach ($port in $ports) {
    & netsh.exe interface portproxy delete v4tov4 "listenaddress=0.0.0.0" "listenport=$port" | Out-Null
    & netsh.exe interface portproxy add v4tov4 "listenaddress=0.0.0.0" "listenport=$port" "connectaddress=$wslIp" "connectport=$port"
    if ($LASTEXITCODE -ne 0) { throw "Failed to expose TCP port $port to WSL2 ($wslIp). Run the monitor task with administrator privileges." }
}

Write-Host "SGLang port forwarding updated: 0.0.0.0:30000,30001 -> $wslIp"
