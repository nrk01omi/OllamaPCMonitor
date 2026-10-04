param(
    [int]$ContextSize = 0,     # 0 = keep the installed setting; otherwise reconfigure with Strata's setup first
    [int]$Port = 8082,
    [switch]$Open              # open Strata's browser UI when ready
)

# Strata (Qwen3.8-Flash-Next IQ2_XS, GPU + RAM + SSD). See docs/strata-bench-2026-10-04.md for measured memory and speed.
# It fills the RTX 5090's VRAM (~31 GB) and ~55 GB of RAM: stop SGLang / llama.cpp models first.
$ErrorActionPreference = 'Stop'
$root = 'C:\Apps\Strata'
$dataDir = 'D:\Strata-data'
$python = Join-Path $root '.venv\Scripts\python.exe'
$config = Join-Path $root 'strata-iq2_xs.json'

foreach ($path in @($python, $config, (Join-Path $root 'serve\server.py'))) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Strata is not installed ($path missing). Run: $root\START-HERE.bat --yes --family qwen --model IQ2_XS --context 131072 --vision no --port $Port --data-dir $dataDir --no-start" }
}

$usedMiB = [int](& nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | Select-Object -First 1)
if ($usedMiB -gt 2000) {
    throw "GPU already holds $usedMiB MiB. Stop SGLang / llama.cpp (OllamaPCMonitor dashboard) before starting Strata."
}
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $Port is already listening (Strata may already be running: http://127.0.0.1:$Port/health)"
}

if ($ContextSize -gt 0) {
    $args = (Get-Content -LiteralPath $config -Raw | ConvertFrom-Json).args
    $current = [int]$args[[array]::IndexOf($args, '--max-context') + 1]
    if ($current -ne $ContextSize) {
        Write-Host "Reconfiguring context $current -> $ContextSize ..."
        & cmd /c "`"$root\START-HERE.bat`" --setup --yes --family qwen --model IQ2_XS --context $ContextSize --vision no --port $Port --data-dir $dataDir --no-start"
        if ($LASTEXITCODE -ne 0) { throw "Strata setup failed (exit $LASTEXITCODE)" }
    }
}

# Foreground: Ctrl+C stops the model. The first start can make the PC sluggish for 1-3 minutes while ~55 GB is loaded.
# Windows Firewall permits inbound TCP 8082 only through the Tailscale interface.
$serverArgs = @('serve\server.py', '--engine', 'strata', '--config', $config, '--host', '0.0.0.0', '--port', $Port)
if ($Open) { $serverArgs += '--open' }
Write-Host "Strata API: http://<Tailscale-IP>:$Port/v1  (health: /health)"
Push-Location $root
try { & $python @serverArgs; exit $LASTEXITCODE } finally { Pop-Location }
