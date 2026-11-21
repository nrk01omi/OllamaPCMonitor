$ErrorActionPreference = 'Stop'

# Older monitor processes may still invoke this helper for every non-Strata
# model.  Project Maya is native on port 8080 and never needs these WSL proxies.
# Its selector records ownership before invoking the start script.
$serviceState = Join-Path $PSScriptRoot '..\data\sglang-services-state.json'
$sessionState = Join-Path $PSScriptRoot '..\data\model-sessions-state.json'
try {
    $service = Get-Content -LiteralPath $serviceState -Raw | ConvertFrom-Json
    if ($service.selected -eq 'glm53flash' -and $service.operation -in @('starting', 'running')) {
        Write-Host 'Skipping WSL2 portproxy refresh for native Project Maya (8080).'
        exit 0
    }
} catch { }
try {
    $session = Get-Content -LiteralPath $sessionState -Raw | ConvertFrom-Json
    if ($session.model -eq 'glm53flash' -and $session.state -eq 'starting') {
        Write-Host 'Skipping WSL2 portproxy refresh for native Project Maya (8080).'
        exit 0
    }
} catch { }

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
